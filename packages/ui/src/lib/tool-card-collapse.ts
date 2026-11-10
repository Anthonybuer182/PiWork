import type { ContentBlock, Message, ToolCallBlock, ToolResultBlock } from '@pi/types';

/**
 * Which tool calls should NOT draw their plugin card body.
 *
 * A file edited in many batches produces one near-identical card per batch
 * ("文档已更新 · 迎国庆.pptx · 已应用 N 个操作"), so a 6-batch task stacks 6
 * cards. Keep the card on the FIRST and LAST call that touched a path inside
 * one run and drop it from the middle ones; a run is bounded by user messages,
 * so tomorrow's edit of the same file starts a fresh first/last pair.
 *
 * Only the card body is suppressed — the tool-call row stays in place, so a
 * failed batch is still visible where it happened (failures carry no card and
 * never join a group).
 */
export function suppressedToolCards(messages: readonly Message[]): ReadonlySet<string> {
  // Only calls that actually produced a card can be suppressed.
  const cardCallIds = new Set<string>();
  for (const message of messages) {
    for (const block of (message.blocks ?? []) as ContentBlock[]) {
      if (block.type !== 'tool_result') continue;
      const result = block as ToolResultBlock;
      if (result.card) cardCallIds.add(result.toolCallId);
    }
  }
  if (cardCallIds.size === 0) return new Set();

  const suppressed = new Set<string>();
  let byPath = new Map<string, string[]>();
  const closeRun = () => {
    for (const ids of byPath.values()) {
      for (const id of ids.slice(1, -1)) suppressed.add(id);
    }
    byPath = new Map();
  };

  for (const message of messages) {
    if (message.role === 'user') closeRun();
    for (const block of (message.blocks ?? []) as ContentBlock[]) {
      if (block.type !== 'tool_call') continue;
      const call = block as ToolCallBlock;
      if (!cardCallIds.has(call.toolCallId)) continue;
      const path = call.args?.path;
      if (typeof path !== 'string' || path === '') continue;
      const ids = byPath.get(path);
      if (ids) ids.push(call.toolCallId);
      else byPath.set(path, [call.toolCallId]);
    }
  }
  closeRun();
  return suppressed;
}
