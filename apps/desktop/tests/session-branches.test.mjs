/**
 * A conversation is a tree; the timeline is one path through it.
 *
 * Editing a question and retrying an answer both append a sibling turn instead
 * of rewriting history, so the reader must show the active path only — and it
 * must know, for every turn on that path, which other versions exist. Before
 * this the reader listed every entry in the file, so a reloaded branched
 * conversation showed both versions of the turn at once.
 *
 * The switch itself is persisted as a marker entry (pi restores the leaf from
 * the file's last entry), which these tests exercise without an AgentSession.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SESSION_LEAF_CUSTOM_TYPE } from '@pi/types';
import { createRealSessionService } from '../../../packages/sdk-wrapper/src/adapters/session.ts';
import { branchTipOf } from '../../../packages/sdk-wrapper/src/adapters/chat.ts';

const BASE = 1_790_000_000_000;

function message(id, parentId, ts, role, text) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role, content: [{ type: 'text', text }], timestamp: ts },
  };
}

function pluginEntry(id, parentId, ts, data) {
  return {
    type: 'custom',
    customType: 'piwork.plugin-message',
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    data,
  };
}

function writeSession(root, name, entries) {
  const file = join(root, name);
  const header = {
    type: 'session',
    version: 3,
    id: name.replace(/\.jsonl$/, ''),
    timestamp: new Date(BASE).toISOString(),
    cwd: root,
  };
  writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function tempDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-branches-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  return root;
}

/**
 *   u1 ─ a1 ─ u2 ─ a2          (version 1, abandoned)
 *   u1' ─ a1'                  (version 2, active — written last)
 *
 * Both versions hang off the same parent (null), exactly as pi's editing flow
 * creates them: navigateTree(u1) moves the leaf to u1's parent.
 */
function branchedFixture(root) {
  return writeSession(root, 'branched.jsonl', [
    message('u1', null, BASE, 'user', 'first question'),
    message('a1', 'u1', BASE + 1, 'assistant', 'first answer'),
    pluginEntry('p1', 'a1', BASE + 2, {
      id: 'card-1', pluginId: 'test.plugin', revision: 1, text: 'card on the old branch', createdAt: BASE + 2,
    }),
    message('u2', 'p1', BASE + 3, 'user', 'follow-up on the old branch'),
    message('a2', 'u2', BASE + 4, 'assistant', 'answer to the follow-up'),
    message('u1b', null, BASE + 5, 'user', 'edited question'),
    message('a1b', 'u1b', BASE + 6, 'assistant', 'answer to the edited question'),
  ]);
}

test('the reader shows only the active branch', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const session = await createRealSessionService().get(file);

  assert.deepEqual(
    session.messages.map((m) => m.content),
    ['edited question', 'answer to the edited question'],
  );
});

test('a user message reports its versions and how to reach them', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const session = await createRealSessionService().get(file);

  const [question] = session.messages;
  assert.equal(question.role, 'user');
  assert.deepEqual(question.branch, {
    index: 1,
    count: 2,
    targets: ['u1', 'u1b'],
  });
});

test('plugin messages on an abandoned branch do not leak into the transcript', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const session = await createRealSessionService().get(file);

  assert.equal(
    session.messages.some((m) => m.role === 'plugin'),
    false,
  );
});

test('the leaf marker makes a version switch survive a reload', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);

  // What chat.switchBranch does: move to the chosen version's tip, then leave
  // a marker as its child so the file's last entry belongs to that branch.
  const manager = SessionManager.open(file);
  manager.branch('a2');
  manager.appendCustomEntry(SESSION_LEAF_CUSTOM_TYPE, { targetId: 'a2' });

  const session = await createRealSessionService().get(file);
  assert.deepEqual(
    session.messages.map((m) => m.content),
    [
      'first question',
      'first answer',
      'card on the old branch',
      'follow-up on the old branch',
      'answer to the follow-up',
    ],
  );
  // The version control follows the active path: the first question is now
  // version 1 of 2, and switching back is one click away.
  assert.deepEqual(session.messages[0].branch, { index: 0, count: 2, targets: ['u1', 'u1b'] });
});

test('the branch tip is the end of a version, not its first entry', (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const manager = SessionManager.open(file);

  assert.equal(branchTipOf(manager, 'u1'), 'a2');
  assert.equal(branchTipOf(manager, 'u1b'), 'a1b');
  assert.equal(branchTipOf(manager, 'nope'), undefined);
});

test('a merged reply reports the entry it ends with', async (t) => {
  const root = tempDir(t);
  // One turn with a tool call: the SDK stores an assistant entry per model
  // call plus a tool-result entry, and the timeline shows one message. A
  // branch "from this reply" must cut after the last of them, not the first.
  const file = writeSession(root, 'tool-loop.jsonl', [
    message('u1', null, BASE, 'user', 'read the file'),
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: new Date(BASE + 1).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'x.txt' } },
        ],
        timestamp: BASE + 1,
      },
    },
    {
      type: 'message',
      id: 'tr1',
      parentId: 'a1',
      timestamp: new Date(BASE + 2).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        timestamp: BASE + 2,
      },
    },
    message('a2', 'tr1', BASE + 3, 'assistant', 'the file says hello'),
  ]);

  const session = await createRealSessionService().get(file);
  const reply = session.messages[1];

  assert.equal(reply.role, 'assistant');
  assert.equal(reply.entryId, 'a1');
  assert.equal(reply.lastEntryId, 'a2');
});

test('creating a branch copies the path through the reply, not the abandoned versions', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const before = await createRealSessionService().get(file);

  const forked = await createRealSessionService().fork(file, 'a1', '测试（分支）');

  assert.deepEqual(
    forked.messages.map((m) => m.content),
    ['first question', 'first answer'],
  );
  assert.equal(forked.title, '测试（分支）');
  assert.notEqual(forked.id, file);

  // The source is untouched: still the same active path, same file.
  const after = await createRealSessionService().get(file);
  assert.deepEqual(
    after.messages.map((m) => m.content),
    before.messages.map((m) => m.content),
  );
});

test('a branch cut through an unknown entry creates nothing', async (t) => {
  const root = tempDir(t);
  const file = branchedFixture(root);
  const before = readdirSync(root);

  await assert.rejects(
    () => createRealSessionService().fork(file, 'no-such-entry'),
    /找不到这条回复/,
  );
  assert.deepEqual(readdirSync(root), before);
});
