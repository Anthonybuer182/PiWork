import { ipcMain } from 'electron';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  ASK_TOOL_NAME,
  isPermissionDecision,
  permissionRuleKey,
  TODO_TOOL_NAME,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest as PermissionRequestPayload,
} from '@pi/types';
import { appendAuditRecord } from './audit';
import { recordToolSession } from '../plugins/session-context';

// The mode/decision/request types and the always-allow scope rule are shared
// with the renderer through @pi/types — re-exported here so the gate's own
// surface stays where it has always been.
export type { PermissionMode, PermissionDecision, PermissionRequestPayload };

/**
 * Permission modes.
 *
 * - 'default': high-risk tool calls (everything beyond read-only tools) wait
 *   for an inline approval card in the renderer before executing.
 * - 'full': nothing is intercepted, but every call that default mode WOULD
 *   have intercepted is written to the audit log first.
 *
 * The last mode picked during this app run seeds every session with no
 * explicit choice, so new conversations inherit it. Nothing reaches disk:
 * a restart resets to 'default', keeping 完全访问 a per-run decision that is
 * re-confirmed each launch. While a run lasts, the red shield in the composer
 * and the audit trail are the standing visibility.
 *
 * Remembered 总是允许 approvals are scoped to one conversation and reset the
 * same way.
 */

/**
 * Tools that only ever read — auto-allowed in both modes. Everything else
 * (bash, edit, write, plugin tools, future built-ins) counts as high-risk.
 * The two-tier rule is deliberately coarse: parsing shell commands to rank
 * risk is a game the attacker always wins (`rm -rf` has a thousand spellings),
 * so the line is drawn at "does it touch the world at all".
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'ls', 'find', 'grep', TODO_TOOL_NAME, ASK_TOOL_NAME,
  // Discovery only: it lists tool metadata and enables nothing. MCP tools
  // themselves stay high-risk — they are third-party code and can do anything.
  'tool_search',
]);

export class PermissionService {
  /** session key → mode. Missing key = the last mode picked this run. */
  private modes = new Map<string, PermissionMode>();
  /** Seeds sessions with no explicit choice; stays 'default' until someone picks. */
  private fallbackMode: PermissionMode = 'default';
  /** session key → rule keys approved with 总是允许 (this session only). */
  private remembered = new Map<string, Set<string>>();
  /** request id → payload + resolver, for every call currently waiting. */
  private pending = new Map<
    string,
    { payload: PermissionRequestPayload; resolve: (decision: PermissionDecision) => void }
  >();
  private requestCounter = 0;

  constructor(
    /** Delivers an approval request to the renderer that owns the session. */
    private sendRequest: (payload: PermissionRequestPayload) => void,
    /** Notifies the renderer that a pending request died without a verdict (abort). */
    private sendCancelled: (payload: { requestId: string; sessionId?: string }) => void = () => {},
  ) {}

  getMode(sessionKey: string): PermissionMode {
    return this.modes.get(sessionKey) ?? this.fallbackMode;
  }

  setMode(sessionKey: string, mode: PermissionMode): void {
    this.modes.set(sessionKey, mode);
    // Sessions created afterwards (and the keyless 'default' bucket) follow
    // the last pick — in-memory only, so a restart resets the seed too.
    this.fallbackMode = mode;
  }

  /**
   * The tool gate handed to `installPermissionGate`. Returns a blocking
   * verdict to stop the call, or undefined to let it run.
   */
  async check(input: {
    sessionKey: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<{ block: true; reason: string } | undefined> {
    const { sessionKey, toolCallId, toolName, args, signal } = input;

    if (READ_ONLY_TOOLS.has(toolName)) return undefined;

    const argsRecord = (args && typeof args === 'object' ? args : undefined) as
      | Record<string, unknown>
      | undefined;
    const summary = summarizeCall(argsRecord);

    // 总是允许 from earlier this session — allow without asking again.
    if (this.remembered.get(sessionKey)?.has(permissionRuleKey(toolName, argsRecord))) {
      return undefined;
    }

    if (this.getMode(sessionKey) === 'full') {
      // The call WOULD have been intercepted in default mode — leave a trace,
      // then let it through. Best-effort by design; never throws.
      appendAuditRecord({
        sessionId: sessionKey,
        toolName,
        summary,
        mode: 'full',
        reason: '完全访问模式自动放行（default 档会拦截审批）',
      });
      return undefined;
    }

    // ── default mode: ask the renderer, wait for the verdict ──
    const decision = await this.ask({
      sessionKey,
      toolCallId,
      toolName,
      args: argsRecord,
      summary,
      signal,
    });

    // The verdict came over IPC and types do not survive that crossing. This
    // is the enforcement point, so anything unrecognized fails CLOSED: a
    // typo'd 'Allow' from a future caller must not read as permission.
    if (!isPermissionDecision(decision)) {
      return { block: true, reason: `无法识别的审批结果（${String(decision)}）— 已按拒绝处理` };
    }
    if (decision === 'deny') {
      return { block: true, reason: `用户拒绝了本次 ${toolName} 调用` };
    }
    if (decision === 'always') {
      let set = this.remembered.get(sessionKey);
      if (!set) {
        set = new Set();
        this.remembered.set(sessionKey, set);
      }
      set.add(permissionRuleKey(toolName, argsRecord));
    }
    return undefined;
  }

  /** User clicked one of the three buttons on the approval card. */
  resolve(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve(decision);
  }

  /** The session a pending request belongs to (undefined when already settled). */
  sessionOfRequest(requestId: string): string | undefined {
    return this.pending.get(requestId)?.payload.sessionId;
  }

  /** Full state for one session — lets a reloaded renderer rebuild its UI. */
  sync(sessionKey: string): {
    mode: PermissionMode;
    pending: PermissionRequestPayload[];
  } {
    // Only THIS session's pending requests. With several windows a reload in
    // one must not resurrect cards that belong to another conversation.
    return {
      mode: this.getMode(sessionKey),
      pending: [...this.pending.values()]
        .map((e) => e.payload)
        .filter((p) => p.sessionId === sessionKey),
    };
  }

  /**
   * Settle every pending request of one session with a denial. Used when the
   * window that owns it closes: nothing would ever answer those cards, and a
   * blocked run must not outlive its UI.
   */
  cancelSession(sessionKey: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.payload.sessionId !== sessionKey) continue;
      this.pending.delete(requestId);
      this.sendCancelled({ requestId, sessionId: sessionKey });
      entry.resolve('deny');
    }
  }

  private ask(input: {
    sessionKey: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown> | undefined;
    summary: string;
    signal?: AbortSignal;
  }): Promise<PermissionDecision> {
    // The run can abort in the window between the agent loop's own abort check
    // and this gate call. An addEventListener on an already-aborted signal
    // never fires, so registering would orphan the pending entry and hang the
    // run even after the user hits 停止 — settle immediately instead.
    if (input.signal?.aborted) return Promise.resolve('deny');

    return new Promise((resolve) => {
      const requestId = `perm-${Date.now()}-${++this.requestCounter}`;
      const payload: PermissionRequestPayload = {
        requestId,
        sessionId: input.sessionKey,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
        summary: input.summary,
      };
      this.pending.set(requestId, { payload, resolve });

      // The user may never answer: stopping the session aborts the agent, and
      // the gate must unblock on that signal (a deny is harmless — the run is
      // over anyway). The renderer is told as well, so its card doesn't linger.
      if (input.signal) {
        input.signal.addEventListener(
          'abort',
          () => {
            if (this.pending.delete(requestId)) {
              this.sendCancelled({ requestId, sessionId: payload.sessionId });
              resolve('deny');
            }
          },
          { once: true },
        );
      }

      this.sendRequest(payload);
    });
  }
}

/** One-line human summary of the call — card header and audit log share it. */
function summarizeCall(args: Record<string, unknown> | undefined): string {
  if (args) {
    if (typeof args.command === 'string') return trunc(args.command);
    if (typeof args.path === 'string') return trunc(args.path);
    if (typeof args.file_path === 'string') return trunc(args.file_path);
    if (typeof args.url === 'string') return trunc(args.url);
  }
  try {
    return args ? trunc(JSON.stringify(args)) : '';
  } catch {
    return '';
  }
}

function trunc(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Wrap the session's existing `beforeToolCall` — never replace it. The SDK
 * assigns the same property itself for its extension system, so overwriting
 * would silently break plugin tool_call handlers; wrapping keeps both, with
 * the permission gate running first (a user denial should not spend the
 * extension's budget on a call that will not happen).
 */
export function installPermissionGate(
  session: AgentSession,
  sessionKey: string,
  service: PermissionService,
): void {
  const prev = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (ctx, signal) => {
    // Correlate the call with its session for plugin execution: the gate is
    // the only place that sees both, and plugin tool handlers are
    // session-scoped (concurrent conversations must not share "the current
    // document/page"). Best-effort — the plugin path tolerates a miss.
    recordToolSession(ctx.toolCall.id, sessionKey);
    const verdict = await service.check({
      sessionKey,
      toolCallId: ctx.toolCall.id,
      toolName: ctx.toolCall.name,
      args: ctx.args,
      signal,
    });
    if (verdict) return verdict;
    return prev?.(ctx, signal);
  };
}

/** The slice of the window registry this file needs (keeps the import a type). */
interface PermissionWindowHost {
  byWebContents(wc: Electron.WebContents): { windowId: number } | undefined;
  activeOwnerOf(sessionId: string): { windowId: number } | undefined;
}

/**
 * IPC surface consumed by the renderer's permission store.
 *
 * Cards are addressed to one window. `resolve` from another window is ignored
 * (a stale card in a window that copied the session, or a hostile renderer),
 * and `sync` never returns another window's pending requests.
 */
export function registerPermissionIpc(service: PermissionService, windows?: PermissionWindowHost): void {
  ipcMain.handle(
    'pi:permission:set-mode',
    (_event, payload: { sessionId?: string; mode: PermissionMode }) => {
      const key = payload.sessionId ?? 'default';
      service.setMode(key, payload.mode);
      return service.getMode(key);
    },
  );

  ipcMain.handle(
    'pi:permission:resolve',
    (event, payload: { requestId: string; decision: PermissionDecision }) => {
      // TS types end at the channel boundary. An unrecognized decision must
      // not be forwarded as if it were consent — deny and say why in the log.
      if (!isPermissionDecision(payload?.decision)) {
        console.warn(
          `[permissions] resolve(${payload?.requestId}) got unrecognized decision ${JSON.stringify(payload?.decision)} — treating as deny`,
        );
        service.resolve(payload?.requestId ?? '', 'deny');
        return;
      }
      const sessionId = service.sessionOfRequest(payload.requestId);
      if (sessionId && windows) {
        const owner = windows.activeOwnerOf(sessionId);
        const caller = windows.byWebContents(event.sender);
        if (owner && caller && owner.windowId !== caller.windowId) {
          console.warn(
            `[permissions] resolve(${payload.requestId}) from window ${caller.windowId} ignored — session owned by window ${owner.windowId}`,
          );
          return;
        }
      }
      service.resolve(payload.requestId, payload.decision);
    },
  );

  ipcMain.handle('pi:permission:sync', (event, sessionId?: string) => {
    const key = sessionId ?? 'default';
    if (windows) {
      const owner = windows.activeOwnerOf(key);
      const caller = windows.byWebContents(event.sender);
      if (owner && caller && owner.windowId !== caller.windowId) {
        return { mode: service.getMode(key), pending: [] };
      }
    }
    return service.sync(key);
  });
}
