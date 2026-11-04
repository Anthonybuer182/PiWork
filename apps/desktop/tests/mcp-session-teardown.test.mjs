/**
 * Session retirement: extensions (notably MCP) close their child processes on
 * `session_shutdown`, so every place that drops a cached session must emit it
 * before disposing. Regression guard for the leak that made MCP spawn one
 * orphan per session rebuild.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireSession } from '../../../packages/sdk-wrapper/src/adapters/chat.ts';

function fakeSession(events, { throwOnEmit = false } = {}) {
  return {
    extensionRunner: {
      async emit(event) {
        events.push({ kind: 'emit', event });
        if (throwOnEmit) throw new Error('extension exploded');
      },
    },
    dispose() {
      events.push({ kind: 'dispose' });
    },
  };
}

test('retireSession emits session_shutdown before disposing', async () => {
  const events = [];
  await retireSession(fakeSession(events));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: 'emit', event: { type: 'session_shutdown', reason: 'new' } });
  assert.deepEqual(events[1], { kind: 'dispose' });
});

test('retireSession passes the quit reason through', async () => {
  const events = [];
  await retireSession(fakeSession(events), 'quit');
  assert.equal(events[0].event.reason, 'quit');
});

test('a failing extension still lets the session be disposed', async () => {
  const events = [];
  await retireSession(fakeSession(events, { throwOnEmit: true }));
  assert.deepEqual(events.at(-1), { kind: 'dispose' });
});
