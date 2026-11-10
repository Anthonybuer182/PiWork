/**
 * Repeated edits of one file in a single run keep only the first and last
 * plugin cards. The middle batches collapse to their plain tool row — the row
 * itself stays so a failed batch is still visible where it happened.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suppressedToolCards } from '../../../packages/ui/src/lib/tool-card-collapse.ts';

let seq = 0;

const call = (id, path) => ({
  id: `c-${id}`,
  type: 'tool_call',
  content: '',
  toolCallId: id,
  toolName: 'office_edit',
  args: { path, ops: [{}] },
});

const result = (id, { card = true } = {}) => ({
  id: `r-${id}`,
  type: 'tool_result',
  content: 'ok',
  result: 'ok',
  toolCallId: id,
  ...(card ? { card: { component: 'Card', props: { title: '文档已更新' } } } : {}),
});

const assistant = (...blocks) => ({
  id: `m-${++seq}`,
  sessionId: 's',
  role: 'assistant',
  status: 'complete',
  content: '',
  blocks,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const user = () => ({
  id: `m-${++seq}`,
  sessionId: 's',
  role: 'user',
  status: 'complete',
  content: '继续',
  blocks: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('the first and last edit of a file keep their card, the middle ones fold', () => {
  const suppressed = suppressedToolCards([
    assistant(
      call('a', '/tmp/slide.pptx'),
      result('a'),
      call('b', '/tmp/slide.pptx'),
      result('b'),
      call('c', '/tmp/slide.pptx'),
      result('c'),
      call('d', '/tmp/slide.pptx'),
      result('d'),
    ),
  ]);
  assert.deepEqual([...suppressed].sort(), ['b', 'c']);
});

test('two edits are both meaningful — nothing folds', () => {
  const suppressed = suppressedToolCards([
    assistant(call('a', '/tmp/slide.pptx'), result('a'), call('b', '/tmp/slide.pptx'), result('b')),
  ]);
  assert.equal(suppressed.size, 0);
});

test('a new user message starts a fresh first/last pair', () => {
  const suppressed = suppressedToolCards([
    assistant(call('a', '/tmp/slide.pptx'), result('a'), call('b', '/tmp/slide.pptx'), result('b')),
    user(),
    assistant(call('c', '/tmp/slide.pptx'), result('c'), call('d', '/tmp/slide.pptx'), result('d')),
  ]);
  assert.equal(suppressed.size, 0);
});

test('a failed batch carries no card and never joins the group', () => {
  const suppressed = suppressedToolCards([
    assistant(
      call('a', '/tmp/slide.pptx'),
      result('a'),
      call('b', '/tmp/slide.pptx'),
      result('b', { card: false }),
      call('c', '/tmp/slide.pptx'),
      result('c'),
    ),
  ]);
  assert.equal(suppressed.size, 0, 'the two successful edits are now first and last');
});

test('different files never fold each other', () => {
  const suppressed = suppressedToolCards([
    assistant(
      call('a', '/tmp/slide.pptx'),
      result('a'),
      call('b', '/tmp/report.docx'),
      result('b'),
      call('c', '/tmp/slide.pptx'),
      result('c'),
    ),
  ]);
  assert.equal(suppressed.size, 0);
});
