/**
 * The `messages.post` host capability: permission gate, session targeting,
 * card validation, and the persisted shape (pi custom entry payload).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityHub } from '../src/main/plugins/capability-hub.ts';

const plugin = 'com.test.plugin';

function makeHub(permissions = ['messages'], { withStore = true } = {}) {
  const appended = [];
  const updated = [];
  const removed = [];
  const signals = [];
  const registry = {
    get(id) {
      return id === plugin
        ? {
            manifest: { id, name: 'Test', version: '0.0.1', apiVersion: 9, permissions },
          }
        : undefined;
    },
    getDataDir() {
      return '/tmp/pi-plugin-test';
    },
  };
  const hub = new CapabilityHub({
    registry,
    emitEvent: () => undefined,
    ...(withStore
      ? {
          appendPluginMessage: async (sessionId, data) => {
            appended.push({ sessionId, data });
            return { entryId: 'entry-1' };
          },
          updatePluginMessage: async (sessionId, messageId, pluginId, patch) => {
            updated.push({ sessionId, messageId, pluginId, patch });
            return { entryId: 'entry-2', revision: 2 };
          },
          removePluginMessage: async (sessionId, messageId, pluginId) => {
            removed.push({ sessionId, messageId, pluginId });
            return { entryId: 'entry-3', revision: 3 };
          },
          sendToSession: (sessionId, channel, payload) => signals.push({ sessionId, channel, payload }),
        }
      : {}),
  });
  return { hub, appended, updated, removed, signals };
}

const card = {
  component: 'Card',
  props: { title: '邮件已发送' },
  children: [{ component: 'Text', props: { text: '收件人：张三' } }],
};

test('messages.post is denied without the messages permission', async () => {
  const { hub } = makeHub(['notify']);
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: 'hi' }),
    /permission denied/,
  );
});

test('messages.post requires a sessionId and content', async () => {
  const { hub } = makeHub();
  await assert.rejects(hub.dispatch(plugin, 'messages.post', { text: 'hi' }), /sessionId is required/);
  await assert.rejects(hub.dispatch(plugin, 'messages.post', { sessionId: 's1' }), /text, card or files/);
});

test('messages.post persists a plugin message and signals the session', async () => {
  const { hub, appended, signals } = makeHub();
  const result = await hub.dispatch(plugin, 'messages.post', {
    sessionId: 's1',
    card,
    text: '邮件已发送',
    status: 'success',
  });

  assert.equal(typeof result.messageId, 'string');
  assert.equal(result.entryId, 'entry-1');

  assert.equal(appended.length, 1);
  assert.equal(appended[0].sessionId, 's1');
  const data = appended[0].data;
  assert.equal(data.pluginId, plugin);
  assert.equal(data.sessionId, 's1');
  assert.equal(data.revision, 1);
  assert.equal(data.text, '邮件已发送');
  assert.equal(data.status, 'success');
  assert.deepEqual(data.card, card);
  assert.equal(typeof data.createdAt, 'number');

  assert.deepEqual(signals, [{ sessionId: 's1', channel: 'pi:plugin:message', payload: { sessionId: 's1' } }]);
});

test('messages.post validates the card tree and status', async () => {
  const { hub, appended } = makeHub();
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', card: { component: 'Script' } }),
    /unknown card component/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', {
      sessionId: 's1',
      card: { component: 'Text', props: { text: 'x'.repeat(70_000) } },
    }),
    /too large/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: 'hi', status: 'done' }),
    /status must be/,
  );
  assert.equal(appended.length, 0, 'invalid payloads never reach the transcript');
});

test('messages.post fails cleanly when the host has no conversation store', async () => {
  const { hub } = makeHub(['messages'], { withStore: false });
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: 'hi' }),
    /no conversation store/,
  );
});

test('messages.update passes a patch and signals the session', async () => {
  const { hub, updated, signals } = makeHub();
  const result = await hub.dispatch(plugin, 'messages.update', {
    sessionId: 's1',
    messageId: 'm1',
    text: 'sent',
    status: 'success',
    card: { component: 'Card', props: { title: 'Sent' } },
  });

  assert.equal(result.messageId, 'm1');
  assert.equal(result.entryId, 'entry-2');
  assert.equal(result.revision, 2);
  assert.deepEqual(updated, [
    {
      sessionId: 's1',
      messageId: 'm1',
      pluginId: plugin,
      patch: {
        card: { component: 'Card', props: { title: 'Sent' } },
        text: 'sent',
        status: 'success',
      },
    },
  ]);
  assert.deepEqual(signals.at(-1), {
    sessionId: 's1',
    channel: 'pi:plugin:message',
    payload: { sessionId: 's1' },
  });
});

test('messages.update supports clearing fields and validates its input', async () => {
  const { hub, updated } = makeHub();
  await hub.dispatch(plugin, 'messages.update', {
    sessionId: 's1',
    messageId: 'm1',
    card: null,
    text: '',
  });
  assert.deepEqual(updated[0].patch, { card: null, text: '' });

  await assert.rejects(
    hub.dispatch(plugin, 'messages.update', { sessionId: 's1', messageId: 'm1' }),
    /nothing to update/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.update', { sessionId: '', messageId: 'm1', text: 'x' }),
    /sessionId is required/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.update', { sessionId: 's1', messageId: '', text: 'x' }),
    /messageId is required/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.update', {
      sessionId: 's1',
      messageId: 'm1',
      card: { component: 'Script' },
    }),
    /unknown card component/,
  );
});

test('messages.remove tombstones a message and needs the messages permission', async () => {
  const { hub, removed, signals } = makeHub();
  const result = await hub.dispatch(plugin, 'messages.remove', { sessionId: 's1', messageId: 'm1' });
  assert.equal(result.messageId, 'm1');
  assert.equal(result.revision, 3);
  assert.deepEqual(removed, [{ sessionId: 's1', messageId: 'm1', pluginId: plugin }]);
  assert.equal(signals.length, 1);

  const denied = makeHub([]).hub;
  await assert.rejects(
    denied.dispatch(plugin, 'messages.remove', { sessionId: 's1', messageId: 'm1' }),
    /permission denied/,
  );
});

test('messages accept an explicit agentVisible opt-in', async () => {
  const { hub, appended, updated } = makeHub();
  await hub.dispatch(plugin, 'messages.post', {
    sessionId: 's1',
    text: 'mail arrived',
    agentVisible: true,
  });
  assert.equal(appended[0].data.agentVisible, true);

  await hub.dispatch(plugin, 'messages.update', {
    sessionId: 's1',
    messageId: 'm1',
    text: 'updated loudly',
    agentVisible: true,
  });
  assert.equal(updated[0].patch.agentVisible, true);

  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: 'x', agentVisible: 'yes' }),
    /agentVisible must be a boolean/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.update', {
      sessionId: 's1',
      messageId: 'm1',
      agentVisible: 'yes',
    }),
    /agentVisible must be a boolean/,
  );
});

test('messages.post is rate-limited per plugin and conversation', async () => {
  const { hub, appended } = makeHub();
  for (let i = 0; i < 60; i++) {
    await hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: `message ${i}` });
  }
  assert.equal(appended.length, 60);
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', { sessionId: 's1', text: 'one too many' }),
    /rate limit/,
  );
  // Another conversation gets its own window.
  await hub.dispatch(plugin, 'messages.post', { sessionId: 's2', text: 'ok' });
  assert.equal(appended.length, 61);
});

test('messages accept existing absolute files as attachment cards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-plugin-message-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.pdf');
  writeFileSync(file, 'pdf');

  const { hub, appended, updated } = makeHub();
  await hub.dispatch(plugin, 'messages.post', {
    sessionId: 's1',
    text: 'report ready',
    files: [{ path: file, label: 'Q3 report' }],
  });
  assert.deepEqual(appended[0].data.files, [{ path: file, label: 'Q3 report' }]);

  await hub.dispatch(plugin, 'messages.update', {
    sessionId: 's1',
    messageId: 'm1',
    files: null,
  });
  assert.deepEqual(updated[0].patch, { files: null });

  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', {
      sessionId: 's1',
      text: 'bad',
      files: [{ path: 'relative.pdf' }],
    }),
    /must be absolute/,
  );
  await assert.rejects(
    hub.dispatch(plugin, 'messages.post', {
      sessionId: 's1',
      text: 'bad',
      files: [{ path: join(dir, 'missing.pdf') }],
    }),
    /not an existing file/,
  );
});
