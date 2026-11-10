/**
 * Reopening a conversation must restore plugin tool cards.
 *
 * The card tree and the tool name are persisted with the tool result
 * (`details.card`). The transcript rebuilt from disk has to carry both, or
 * every office/mail card collapses to a bare header row after a reload and
 * its buttons can no longer be routed to the plugin.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentMessageToBlocks } from '../../../packages/sdk-wrapper/src/adapters/session.ts';

const card = {
  component: 'Card',
  props: { title: '文档已更新' },
  children: [
    {
      component: 'Button',
      props: { label: '在查看器中打开', path: '/tmp/slide.pptx' },
      events: { onClick: 'open_viewer' },
    },
  ],
};

test('a toolResult from disk keeps its tool name and card tree', () => {
  const blocks = agentMessageToBlocks({
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'office_edit',
    content: [{ type: 'text', text: 'applied 3 op(s)' }],
    details: { applied: true, card },
    isError: false,
  });

  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.toolName, 'office_edit');
  assert.deepEqual(block.card, card);
  assert.equal(block.result, 'applied 3 op(s)');
});

test('a plain tool result stays card-free', () => {
  const blocks = agentMessageToBlocks({
    role: 'toolResult',
    toolCallId: 'call-2',
    toolName: 'bash',
    content: [{ type: 'text', text: 'ok' }],
    details: {},
    isError: false,
  });

  assert.equal(blocks[0].toolName, 'bash');
  assert.equal('card' in blocks[0], false);
});
