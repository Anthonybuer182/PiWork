/**
 * Plugin-originated messages in a reloaded conversation.
 *
 * A plugin posts a message through the host; it is persisted as a pi `custom`
 * entry in the SAME session journal as agent messages, but must never enter
 * the model context. These pin the reader half:
 *
 *   - a `custom` entry with the plugin type becomes a `role: "plugin"` message
 *   - append-only updates fold to the highest revision
 *   - a tombstone removes the message
 *   - unrelated custom entries stay invisible
 *   - the message is interleaved by its own createdAt, not by journal position
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealSessionService } from '../../../packages/sdk-wrapper/src/adapters/session.ts';
import { createRealChatService } from '../../../packages/sdk-wrapper/src/adapters/chat.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const BASE = 1_790_000_000_000;
const CUSTOM_TYPE = 'piwork.plugin-message';

function messageEntry(id, parentId, ts, message) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message,
  };
}

function pluginEntry(id, parentId, ts, data) {
  return {
    type: 'custom',
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: CUSTOM_TYPE,
    data,
  };
}

function fixture(t, extraEntries = []) {
  const root = mkdtempSync(join(tmpdir(), 'pi-plugin-messages-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const file = join(root, 'plugin-messages.jsonl');
  const header = {
    type: 'session',
    version: 3,
    id: 'plugin-messages-test',
    timestamp: new Date(BASE).toISOString(),
    cwd: root,
  };
  const entries = [
    messageEntry('u1', null, BASE, {
      role: 'user',
      content: [{ type: 'text', text: 'send it' }],
      timestamp: BASE,
    }),
    messageEntry('a1', 'u1', BASE + 1000, {
      role: 'assistant',
      content: [{ type: 'text', text: 'sending' }],
      provider: 'test',
      model: 'test-model',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: 'stop',
      timestamp: BASE + 1000,
    }),
    ...extraEntries,
  ];
  writeFileSync(file, [header, ...entries].map((item) => JSON.stringify(item)).join('\n') + '\n');
  return file;
}

test('a plugin custom entry becomes a plugin message in the timeline', async (t) => {
  const file = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, {
      id: 'mail-1',
      pluginId: 'com.pi.mail',
      sessionId: 'plugin-messages-test',
      revision: 1,
      text: '邮件已发送',
      status: 'success',
      card: {
        component: 'Card',
        props: { title: '邮件已发送' },
        children: [{ component: 'Text', props: { text: '收件人：张三' } }],
      },
      createdAt: BASE + 2000,
    }),
  ]);

  const session = await createRealSessionService().get(file);
  const plugin = session.messages.filter((message) => message.role === 'plugin');
  assert.equal(plugin.length, 1);
  assert.equal(plugin[0].pluginId, 'com.pi.mail');
  assert.equal(plugin[0].pluginMessageId, 'mail-1');
  assert.equal(plugin[0].content, '邮件已发送');
  assert.equal(plugin[0].pluginStatus, 'success');
  assert.equal(plugin[0].card?.component, 'Card');
  assert.equal(session.messages.at(-1)?.role, 'plugin', 'newest createdAt sorts last');
});

test('append-only updates fold to the highest revision', async (t) => {
  const data = (revision, text, removed = false) => ({
    id: 'mail-1',
    pluginId: 'com.pi.mail',
    sessionId: 'plugin-messages-test',
    revision,
    text,
    ...(removed ? { removed: true } : {}),
    createdAt: BASE + 2000,
  });
  const file = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, data(1, 'sending', false)),
    pluginEntry('c2', 'c1', BASE + 3000, data(2, 'sent', false)),
    pluginEntry('c3', 'c2', BASE + 4000, data(3, 'sent', true)),
  ]);

  const session = await createRealSessionService().get(file);
  assert.equal(
    session.messages.filter((message) => message.role === 'plugin').length,
    0,
    'the tombstone removes the message',
  );

  // Without the tombstone, the highest revision wins.
  const file2 = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, data(1, 'sending', false)),
    pluginEntry('c2', 'c1', BASE + 3000, data(2, 'sent', false)),
  ]);
  const session2 = await createRealSessionService().get(file2);
  const plugin = session2.messages.filter((message) => message.role === 'plugin');
  assert.equal(plugin.length, 1);
  assert.equal(plugin[0].content, 'sent');
  assert.equal(plugin[0].revision, 2);
});

test('unrelated custom entries stay out of the timeline', async (t) => {
  const file = fixture(t, [
    {
      type: 'custom',
      id: 'other',
      parentId: 'a1',
      timestamp: new Date(BASE + 1500).toISOString(),
      customType: 'some.other.extension',
      data: { anything: true },
    },
  ]);
  const session = await createRealSessionService().get(file);
  assert.equal(session.messages.filter((message) => message.role === 'plugin').length, 0);
});

test('plugin message files become host file blocks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-plugin-message-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const report = join(dir, 'report.pdf');
  writeFileSync(report, 'pdf bytes');

  const file = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, {
      id: 'report-1',
      pluginId: 'com.pi.files',
      sessionId: 'plugin-messages-test',
      revision: 1,
      files: [{ path: report, label: 'Q3 report' }],
      createdAt: BASE + 2000,
    }),
  ]);
  const session = await createRealSessionService().get(file);
  const plugin = session.messages.find((message) => message.role === 'plugin');
  const block = plugin?.blocks.find((b) => b.type === 'file');
  assert.equal(block?.workspacePath, report);
  assert.equal(block?.fileName, 'report.pdf');
  assert.equal(block?.fileSize, 9);
});

test('updatePluginMessage appends a revision, enforces ownership, and can clear fields', async (t) => {
  const file = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, {
      id: 'mail-1',
      pluginId: 'com.pi.mail',
      sessionId: 'plugin-messages-test',
      revision: 1,
      text: 'sending',
      status: 'loading',
      card: { component: 'Card', props: { title: 'Sending' } },
      createdAt: BASE + 2000,
    }),
  ]);
  const chat = createRealChatService(tmpdir());

  const updated = await chat.updatePluginMessage(file, 'mail-1', 'com.pi.mail', {
    text: 'sent',
    status: 'success',
  });
  assert.equal(updated.revision, 2);

  let session = await createRealSessionService().get(file);
  let plugin = session.messages.filter((message) => message.role === 'plugin');
  assert.equal(plugin.length, 1);
  assert.equal(plugin[0].content, 'sent');
  assert.equal(plugin[0].pluginStatus, 'success');
  assert.equal(plugin[0].revision, 2);
  assert.equal(plugin[0].card?.props?.title, 'Sending', 'omitted fields keep their value');

  await assert.rejects(
    chat.updatePluginMessage(file, 'mail-1', 'com.other', { text: 'hijack' }),
    /another plugin/,
  );

  await chat.updatePluginMessage(file, 'mail-1', 'com.pi.mail', { card: null, text: '' });
  session = await createRealSessionService().get(file);
  plugin = session.messages.filter((message) => message.role === 'plugin');
  assert.equal(plugin[0].content, '');
  assert.equal(plugin[0].card, undefined, 'card: null clears the card');
});

test('agentVisible appends a custom_message entry; updates are opt-in too', async (t) => {
  const file = fixture(t);
  const chat = createRealChatService(tmpdir());

  // Default: display-only custom entry, never model context.
  await chat.appendPluginMessage(file, {
    id: 'hidden-1',
    pluginId: 'com.pi.mail',
    sessionId: file,
    revision: 1,
    text: 'hidden from model',
    createdAt: BASE + 2000,
  });
  let entries = SessionManager.open(file).getEntries();
  const hidden = entries.find(
    (e) => e.type === 'custom' && e.customType === 'piwork.plugin-message',
  );
  assert.ok(hidden, 'default post is a custom entry');
  assert.equal(
    entries.some((e) => e.type === 'custom_message' && e.data?.id === 'hidden-1'),
    false,
  );

  // Explicit opt-in: custom_message participates in context.
  await chat.appendPluginMessage(file, {
    id: 'ai-1',
    pluginId: 'com.pi.mail',
    sessionId: file,
    revision: 1,
    text: 'mail arrived',
    agentVisible: true,
    createdAt: BASE + 2001,
  });
  entries = SessionManager.open(file).getEntries();
  const visible = entries.find(
    (e) =>
      e.type === 'custom_message' &&
      e.customType === 'piwork.plugin-message' &&
      e.details?.id === 'ai-1',
  );
  assert.ok(visible, 'agentVisible post is a custom_message entry');
  assert.match(String(visible.content), /mail arrived/);
  assert.equal(visible.details?.id, 'ai-1');

  // Update without agentVisible stays UI-only even on a visible message.
  await chat.updatePluginMessage(file, 'ai-1', 'com.pi.mail', { text: 'updated quietly' });
  entries = SessionManager.open(file).getEntries();
  const quietUpdate = entries.at(-1);
  assert.equal(quietUpdate.type, 'custom');
  assert.equal(quietUpdate.data?.agentVisible, true, 'the message remains marked as shared');

  // Explicit agentVisible update enters context again.
  await chat.updatePluginMessage(file, 'ai-1', 'com.pi.mail', {
    text: 'updated loudly',
    agentVisible: true,
  });
  entries = SessionManager.open(file).getEntries();
  const loud = entries.at(-1);
  assert.equal(loud.type, 'custom_message');
  assert.match(String(loud.content), /updated loudly/);

  const session = await createRealSessionService().get(file);
  const plugin = session.messages.find(
    (m) => m.role === 'plugin' && m.pluginMessageId === 'ai-1',
  );
  assert.equal(plugin?.agentVisible, true);
  assert.equal(plugin?.content, 'updated loudly');
});

test('removePluginMessage appends a tombstone and later updates are refused', async (t) => {
  const file = fixture(t, [
    pluginEntry('c1', 'a1', BASE + 2000, {
      id: 'mail-1',
      pluginId: 'com.pi.mail',
      sessionId: 'plugin-messages-test',
      revision: 1,
      text: 'sent',
      createdAt: BASE + 2000,
    }),
  ]);
  const chat = createRealChatService(tmpdir());

  const removed = await chat.removePluginMessage(file, 'mail-1', 'com.pi.mail');
  assert.equal(removed.revision, 2);
  const session = await createRealSessionService().get(file);
  assert.equal(session.messages.filter((message) => message.role === 'plugin').length, 0);

  await assert.rejects(
    chat.updatePluginMessage(file, 'mail-1', 'com.pi.mail', { text: 'again' }),
    /removed/,
  );
  await assert.rejects(
    chat.removePluginMessage(file, 'missing', 'com.pi.mail'),
    /no message/,
  );
});
