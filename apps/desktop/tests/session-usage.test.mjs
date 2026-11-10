/**
 * Regression: a reloaded conversation must account for every model call.
 *
 * The SDK persists one assistant entry per model call inside a tool loop. The
 * session reader merges those entries into one UI message, and before this
 * test it kept only the first entry's usage — a long tool loop reloaded as a
 * fraction of its real token count. The `totalTokens` fallback also omitted
 * cache tokens, which is most of a warm prompt.
 *
 * The reader lives in @pi/sdk-wrapper; these tests import its source directly
 * because the desktop suite is the repo's running test harness (the wrapper
 * package has no test runner of its own).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealSessionService } from '../../../packages/sdk-wrapper/src/adapters/session.ts';

function entry(id, parentId, ts, message) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message,
  };
}

function assistant(ts, usage, content) {
  return {
    role: 'assistant',
    content,
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: ts,
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const file = join(root, 'usage.jsonl');
  const base = 1_790_000_000_000;
  const header = {
    type: 'session',
    version: 3,
    id: 'usage-test',
    timestamp: new Date(base).toISOString(),
    cwd: root,
  };
  const entries = [
    entry('u1', null, base, {
      role: 'user',
      content: [{ type: 'text', text: 'first question' }],
      timestamp: base,
    }),
    // No totalTokens: the fallback must include cache read/write (135, not 15).
    entry(
      'a1',
      'u1',
      base + 1,
      assistant(
        base + 1,
        { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
        [
          { type: 'text', text: 'calling bash' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } },
        ],
      ),
    ),
    entry('t1', 'a1', base + 2, {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: base + 2,
    }),
    entry(
      'a2',
      't1',
      base + 3,
      assistant(base + 3, { input: 20, output: 7, cacheRead: 200, cacheWrite: 30, totalTokens: 257 }, [
        { type: 'text', text: 'done' },
      ]),
    ),
    entry('u2', 'a2', base + 4, {
      role: 'user',
      content: [{ type: 'text', text: 'second question' }],
      timestamp: base + 4,
    }),
    entry(
      'a3',
      'u2',
      base + 5,
      assistant(base + 5, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, [
        { type: 'text', text: 'second answer' },
      ]),
    ),
  ];
  writeFileSync(file, [header, ...entries].map((item) => JSON.stringify(item)).join('\n') + '\n');
  return file;
}

test('merged assistant entries sum usage instead of keeping the first call', async (t) => {
  const file = fixture(t);
  const session = await createRealSessionService().get(file);
  const assistants = session.messages.filter((message) => message.role === 'assistant');

  assert.equal(assistants.length, 2, 'two runs → two assistant messages');
  assert.deepEqual(assistants[0].usage, {
    inputTokens: 30,
    outputTokens: 12,
    totalTokens: 392, // 135 (fallback incl. cache) + 257 (explicit)
    cacheReadTokens: 300,
    cacheWriteTokens: 50,
    cost: 0,
  });
  assert.equal(assistants[1].usage?.totalTokens, 2, 'a later run stays separate');
});
