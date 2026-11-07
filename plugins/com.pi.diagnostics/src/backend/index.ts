/**
 * Diagnostics backend.
 *
 * The panel asks for `trace.report`; this process reads the CURRENT session's
 * journal through the host's `filesystem.read` capability and hands it to the
 * shared analyzer. All measurement lives in the journal — this backend adds
 * no instrumentation of its own, so it stays a pure reader.
 *
 * The session id the host passes for a session-scoped panel is the JSONL file
 * path, not an opaque key. That is the only path read; the request cannot
 * point it somewhere else.
 */
import { plugin, type PluginContext, type PanelMeta } from '@pi/plugin-sdk';
// @ts-expect-error — plain ESM shared with scripts/diagnostics/session-report.mjs
import { analyzeSessionText } from '../../../../scripts/diagnostics/analyze.mjs';

const READ_TIMEOUT_MS = 20_000;
/** filesystem.read refuses anything above this; keep the failure explainable. */
const READ_LIMIT_MB = 2;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildReport(ctx: PluginContext, sessionId: string | undefined) {
  if (!sessionId) {
    return { ok: false, code: 'NO_SESSION', message: '当前没有活动会话' };
  }
  let text: string;
  try {
    // filesystem.read answers { path, content, size } — not a bare string.
    const read = await ctx.call<{ content?: string } | string>(
      'filesystem.read',
      { path: sessionId },
      { timeoutMs: READ_TIMEOUT_MS },
    );
    text = typeof read === 'string' ? read : (read?.content ?? '');
  } catch (error) {
    const detail = messageOf(error);
    return {
      ok: false,
      code: 'READ_FAILED',
      message: detail.includes('too large')
        ? `会话文件超过 ${READ_LIMIT_MB}MB，当前版本无法读取：${detail}`
        : `读取会话文件失败：${detail}`,
    };
  }
  try {
    return { ok: true, report: analyzeSessionText(text, { file: sessionId }) };
  } catch (error) {
    return { ok: false, code: 'ANALYZE_FAILED', message: `解析会话失败：${messageOf(error)}` };
  }
}

/**
 * The session this backend serves. `meta.sessionId` on a panel request is the
 * primary source; the host-event snapshot is the fallback. They normally
 * agree, but a panel can be opened before its `panel.mounted` report lands
 * (first mount, backend restart), and `session.changed` is what the host
 * replays to a backend that started late.
 */
let hostSessionId: string | undefined;

plugin({
  async onRequest(panelId, method, _params, ctx, meta: PanelMeta | undefined) {
    if (method !== 'trace.report') {
      throw new Error(`unknown method: ${method} (this panel only serves trace.report)`);
    }
    return buildReport(ctx, meta?.sessionId ?? hostSessionId);
  },

  onHostEvent(event, data) {
    if (event !== 'session.changed') return;
    const id = (data as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof id === 'string' && id) hostSessionId = id;
  },

  // Lifecycle callbacks are host-driven. Implementing them (even empty) keeps
  // the SDK from warning that a mounted panel has no handler, without adding
  // behaviour: the page asks for its data with `trace.report` on its own.
  onPanelMounted() {},
  onEvent() {},
});
