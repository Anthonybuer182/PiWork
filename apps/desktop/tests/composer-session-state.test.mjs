/**
 * The composer's live-run state is per conversation.
 *
 * A window can have several runs in flight; the flat fields on the store are a
 * view of the active conversation only. These assertions cover the switch and
 * background-chunk behavior that used to leak one conversation's stream into
 * another.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useComposerStore } from '../../../packages/ui/src/stores/composer-store.ts';

test('live run state, drafts, and pending flags are per conversation', () => {
  const store = useComposerStore;
  store.getState().reset();

  store.getState().enterSession('A');
  store.getState().beginSessionStream('A');
  store.getState().updateSessionStream('A', {
    blocks: [{ id: 'b1', type: 'text', content: 'hello' }],
  });
  assert.equal(store.getState().isStreaming, true);
  assert.equal(store.getState().streamingBlocks.length, 1);

  // Switch to an idle conversation: its first frame is idle.
  store.getState().enterSession('B');
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().streamingBlocks.length, 0);

  // A background chunk of A must not appear in B.
  store.getState().updateSessionStream('A', {
    blocks: [{ id: 'b1', type: 'text', content: 'hello2' }],
  });
  assert.equal(store.getState().streamingBlocks.length, 0);

  // Switching back restores A's live tail.
  store.getState().enterSession('A');
  assert.equal(store.getState().isStreaming, true);
  assert.equal(store.getState().streamingBlocks[0].content, 'hello2');

  // Drafts follow the conversation too.
  store.getState().setValue('draft A');
  store.getState().enterSession('B');
  store.getState().setValue('draft B');
  store.getState().enterSession('A');
  assert.equal(store.getState().value, 'draft A');
  store.getState().enterSession('B');
  assert.equal(store.getState().value, 'draft B');

  // Sending in B is not blocked by A's pending send.
  store.getState().setSessionPending('A', true);
  assert.equal(store.getState().sessionPending.A, true);
  assert.equal(store.getState().sessionPending.B, undefined);

  store.getState().endSessionStream('A', { clear: true });
  store.getState().enterSession('A');
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().streamingBlocks.length, 0);
});

test('a run keeps one identity from the live reply to the stored message', () => {
  const store = useComposerStore;
  store.getState().reset();
  store.getState().enterSession('A');

  store.getState().beginSessionStream('A');
  const firstRun = store.getState().streamingRunId;
  assert.match(firstRun, /^run-/);

  store.getState().updateSessionStream('A', {
    blocks: [{ id: 't1', type: 'text', content: 'answer' }],
  });

  // Ending a run must not drop the blocks or change the id: the reader shows
  // this copy until the promoted transcript message (written under the same
  // id) is visible. Dropping either first made the answer disappear for a
  // paint at the end of every run.
  store.getState().endSessionStream('A', { clear: false });
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().streamingBlocks.length, 1);
  assert.equal(store.getState().streamingRunId, firstRun);

  // A background conversation keeps its own identity and blocks.
  store.getState().enterSession('B');
  store.getState().beginSessionStream('B');
  const otherRun = store.getState().streamingRunId;
  assert.notEqual(otherRun, firstRun);
  assert.equal(store.getState().streamingBlocks.length, 0);
  store.getState().enterSession('A');
  assert.equal(store.getState().streamingRunId, firstRun);
  assert.equal(store.getState().streamingBlocks.length, 1);

  // The next run is a different reply: new id, empty blocks.
  store.getState().beginSessionStream('A');
  assert.notEqual(store.getState().streamingRunId, firstRun);

  store.getState().reset();
});

test('permission mode is one global setting', async () => {
  const { usePermissionStore } = await import(
    '../../../packages/ui/src/stores/permission-store.ts'
  );
  usePermissionStore.getState().setMode('full');
  assert.equal(usePermissionStore.getState().mode, 'full');
  usePermissionStore.getState().setMode('default');
  assert.equal(usePermissionStore.getState().mode, 'default');
});
