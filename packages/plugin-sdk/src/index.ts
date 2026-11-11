/**
 * The backend half of a pi plugin.
 *
 * A plugin backend is a Node process the host forks. Without this SDK, every
 * plugin re-implements the same plumbing — the ready handshake, the capability
 * request/response map, the message pump, timeouts, panel routing — and the
 * copies drift. Before this existed, five first-party plugins had five
 * hand-rolled copies of that plumbing whose only difference was a timeout
 * (browser used 60s, everyone else 30s).
 *
 * With it, a plugin declares WHAT it does:
 *
 *   import { plugin } from '@pi/plugin-sdk';
 *
 *   plugin({
 *     async onRequest(panelId, method, params) { ... },
 *     async onTool(name, args) { ... },
 *   });
 *
 * Called at module top level — the host forks the plugin's entry file, so
 * running on import is what starts the plugin. That is the same shape the
 * hand-written backends used (they posted `ready` at module load).
 *
 * EVERY FAILURE IS LOUD. A handler that throws replies with `ok:false` and the
 * message; an unknown method replies with the list of known ones; a message
 * with no panel id is logged with the plugin's name. Silent failure — a button
 * that does nothing and reports nothing — is the specific thing this SDK is
 * here to make impossible.
 */

// ── Wire types ───────────────────────────────────────────────────────────

/** `process.parentPort` — Electron's control plane to the main process. */
interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports?: unknown[] }) => void): void;
}

/** A MessagePort to the plugin's panel windows (the data plane). */
interface PanelPort {
  postMessage(message: unknown): void;
  on(event: string, listener: (event: { data?: unknown }) => void): void;
  start?(): void;
}

interface IncomingMessage {
  type?: string;
  id?: string;
  name?: string;
  method?: string;
  params?: Record<string, unknown>;
  args?: string;
  event?: string;
  data?: unknown;
  sessionId?: string;
  /** The calling conversation's workspace id (protocol 7). */
  workspaceId?: string;
  /** The host tab this panel message came from (multi-instance panels). */
  tabId?: string;
  actionId?: string;
  text?: string;
  providerId?: string;
  message?: string;
  result?: unknown;
  error?: string;
  pluginId?: string;
  dataDir?: string;
  /** card-event (protocol 4). */
  toolName?: string;
  eventId?: string;
  kind?: string;
  payload?: unknown;
  /** message-action (protocol 9): the plugin's own message id. */
  messageId?: string;
}

// ── Public API ───────────────────────────────────────────────────────────

/** What a tool handler hands back to the agent. */
export interface ToolResult {
  /** Text (and optionally images) shown in the conversation. */
  content?: Array<Record<string, unknown>>;
  /** Structured payload for renderers and the transcript. */
  details?: unknown;
  /** Declarative card shown alongside the result. */
  card?: unknown;
}

/** Per-panel-instance context handed to panel callbacks. */
export interface PanelMeta {
  /** The host tab (multi-instance panels append an instance suffix). */
  tabId?: string;
  sessionId?: string;
  workspaceId?: string;
}

/** Everything a handler needs from the host. */
export interface PluginContext {
  readonly pluginId: string;
  /** This plugin's private directory. Created before the backend starts. */
  readonly dataDir: string;
  /**
   * Call a host capability (storage / notify / network / panel / …).
   * Permission-gated in main.
   *
   * `timeoutMs` overrides the 30s default for one call — a capability that
   * waits on the outside world (loading a slow page) needs longer, and raising
   * the default for everyone would just make every OTHER failure slower to
   * report.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * Push an event to one of this plugin's panels. Fire-and-forget.
   *
   * Returns false when nothing was listening — no panel has connected yet, or
   * the port has closed. That is a normal state, not an error: a backend
   * renders its first state from `onInit`, long before anyone opens the panel,
   * and pushes on timers while it is closed. Callers that need delivery (a
   * notification the user must see) should ask `panelAlive` first and record
   * what did not get through.
   */
  send(panelId: string, event: string, data?: unknown, tabId?: string): boolean;
  /**
   * Ask whether a panel is there to receive a message. Best-effort, and the
   * only signal that exists: the host never reports a panel closing, and a
   * postMessage into a dead peer succeeds silently. So this pings and waits.
   *
   * Returns false when no panel is connected, the port has closed, or nothing
   * answered in time. A `true` is not a guarantee the user is looking at it —
   * the window can be hidden or the app occluded — only that something is
   * alive on the other end.
   */
  panelAlive(panelId: string, timeoutMs?: number): Promise<boolean>;
  /** Open one of this plugin's panels. focus=false → badge only, no steal. */
  openPanel(panelId: string, options?: { focus?: boolean }): Promise<unknown>;
  /** Set (or clear, with null) the badge on a panel's rail button. */
  setBadge(panelId: string, badge: number | string | null): Promise<void>;
  /**
   * Post a message into a conversation timeline.
   *
   * The message is persisted with the session (as a pi `custom` entry) and
   * replays with it, but it is NOT sent to the model. Use this for results,
   * notifications and plugin-owned lists; a message the model must see should
   * go through `chat.send` instead.
   *
   * `sessionId` is required: a plugin backend is process-global, so "the
   * current conversation" is ambiguous unless the plugin names one. Learn it
   * from `PanelMeta.sessionId` (panel hooks) or `call.sessionId` (tools).
   */
  messages: {
    post(params: {
      sessionId: string;
      /** Declarative card tree rendered in the timeline. */
      card?: unknown;
      /** Plain text when a card is unnecessary. */
      text?: string;
      status?: 'info' | 'success' | 'warning' | 'error' | 'loading';
      /** Absolute file paths rendered as host file-attachment cards. */
      files?: Array<{ path: string; label?: string }>;
      /**
       * Default false: the message stays in the transcript and never reaches
       * the model. True appends a pi `custom_message` entry too, so the model
       * sees the text (cards/files are not sent, only text or a short summary).
       */
      agentVisible?: boolean;
    }): Promise<{ messageId: string; entryId?: string }>;
    /**
     * Update a message this plugin posted. Omitted fields keep their current
     * value; `card: null` / `text: ''` / `files: null` clear them. The update is
     * appended as a new revision; readers fold to the latest.
     */
    update(params: {
      sessionId: string;
      messageId: string;
      card?: unknown;
      text?: string;
      status?: 'info' | 'success' | 'warning' | 'error' | 'loading';
      files?: Array<{ path: string; label?: string }> | null;
      /** This revision also enters model context (transcript stays the source of truth). */
      agentVisible?: boolean;
    }): Promise<{ messageId: string; entryId?: string; revision?: number }>;
    /** Withdraw a message this plugin posted (append-only tombstone). */
    remove(params: { sessionId: string; messageId: string }): Promise<{
      messageId: string;
      entryId?: string;
      revision?: number;
    }>;
  };
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * Payload of the host's `agent.turnEnd` event.
 *
 * Pushed once per agent run, AFTER the SDK has settled it: a normal finish, a
 * user abort (stop button / Esc) and a failed run all settle. Use it to fold
 * the many tool calls of one run into one result (a completion card via
 * `ctx.messages.post`, a summary notification, …) instead of reacting to every
 * call. The event is ungated — every running backend receives it, and a backend
 * ignores runs in which it took no part.
 */
export interface AgentTurnEndEvent {
  /** The conversation the run belongs to. */
  sessionId: string;
  /** Identity of this run, minted by the host (unique per run). */
  runId: string;
  /** True when the run ended because the user stopped it. */
  aborted: boolean;
  /** Why the run ended; `error` means it threw before settling normally. */
  outcome: 'completed' | 'aborted' | 'error';
}

export interface PluginHandlers {
  /** Runs once, when the host sends `init`. */
  onInit?(ctx: PluginContext): void | Promise<void>;

  /**
   * A panel asked for something and is waiting for the answer.
   * Return the value; throw to reject. An unknown `method` answers with an
   * error naming the methods that DO exist, rather than hanging.
   */
  onRequest?(
    panelId: string,
    method: string,
    params: Record<string, unknown>,
    ctx: PluginContext,
    meta?: PanelMeta,
  ): unknown | Promise<unknown>;

  /** A panel reported something. Fire-and-forget — there is no reply. */
  onEvent?(
    panelId: string,
    event: string,
    data: unknown,
    ctx: PluginContext,
    meta?: PanelMeta,
  ): void | Promise<void>;

  /**
   * A panel finished loading and is ready to be drawn into.
   *
   * This is where a panel's first paint belongs. `onInit` runs when the BACKEND
   * starts — long before anyone opens the panel — so anything pushed there is
   * sent with nothing listening. `params` carries whatever the host opened the
   * panel with (e.g. `{ file }`). `meta.sessionId` is the conversation the
   * panel serves right now — a session-scoped panel re-mounts (same event)
   * when the user switches conversations, so re-resolve per-conversation state
   * from it rather than caching one global "current" value.
   *
   * `meta.workspaceId` is the workspace the window showing this panel is in.
   *
   * It is per-request context, NOT panel state: the backend is one process
   * shared by every window, so stashing this on a module variable makes "the
   * last window to mount" win for all of them. Readers that need the panel's
   * own scope should let the page filter what `ui.render` carries (the page
   * gets the same value directly through `piSDK.workspace`).
   *
   * Handled before `onEvent`: `panel.mounted` is a lifecycle step, not a
   * plugin-defined event, so the author never sees it in `onEvent`.
   */
  onPanelMounted?(
    panelId: string,
    params: unknown,
    ctx: PluginContext,
    meta?: PanelMeta,
  ): void | Promise<void>;

  /**
   * The user switched to this tab. Multi-instance panels share one backend
   * process; this is how it learns which tab's file/page is "current" for the
   * conversation. Fires after mount and on every activation.
   */
  onPanelActivated?(
    panelId: string,
    params: unknown,
    ctx: PluginContext,
    meta?: PanelMeta,
  ): void | Promise<void>;

  /**
   * The agent called one of this plugin's tools.
   *
   * `call.sessionId` is the calling conversation's session key, when the call
   * came through an agent session. Session-scoped handlers (current document,
   * current page) resolve their target per conversation with it — concurrent
   * sessions must not share one. Direct invocations (tests) omit it.
   *
   * `call.workspaceId` is that conversation's workspace. It is absent when the
   * host could not resolve one — treat that as "no workspace", not as "use
   * whatever window is focused", or a write lands in the wrong project.
   */
  onTool?(
    name: string,
    args: Record<string, unknown>,
    ctx: PluginContext,
    call: { sessionId?: string; workspaceId?: string },
  ): ToolResult | string | void | Promise<ToolResult | string | void>;

  /** A contributed slash command ran. */
  onCommand?(name: string, args: string | undefined, ctx: PluginContext): unknown | Promise<unknown>;

  /** The host wants context to inject before a message send. Return the text. */
  onContextRequest?(providerId: string, message: string, ctx: PluginContext): string | Promise<string>;

  /**
   * The host pushed an event.
   *
   * - `session.changed` — `{ sessionId }`, every backend, on the conversation
   *   the user now has on screen.
   * - `agent.turnEnd` — `AgentTurnEndEvent`, every backend, once per settled
   *   agent run (success, abort or error).
   * - `browser.urlChanged` / `browser.tabOpened` — browser permission only.
   * - `voice.playback` — `{ key, playing }`, voice permission only.
   */
  onHostEvent?(event: string, data: unknown, ctx: PluginContext): void;
  /**
   * The user interacted with a declarative card this plugin's tool returned
   * into the chat timeline — a Button was clicked (`kind: 'click'`, payload
   * is the node's props) or an Input was submitted with Enter
   * (`kind: 'submit'`, payload is the entered value). `eventId` is the id the
   * card node declared. Fire-and-forget: nothing the handler returns reaches
   * the card; make the card reflect follow-up state through a NEW tool result.
   * Requires the manifest to declare a messageRenderer for `toolName`.
   */
  onCardEvent?(toolName: string, eventId: string, kind: 'click' | 'submit', payload: unknown, ctx: PluginContext): void;
  /**
   * The user interacted with a card inside a message this plugin posted via
   * `ctx.messages.post` (button click or input submit). Answer by updating or
   * removing the same message through `ctx.messages.update/remove`.
   */
  onMessageAction?(
    messageId: string,
    eventId: string,
    kind: 'click' | 'submit',
    payload: unknown,
    ctx: PluginContext,
    meta?: { sessionId?: string },
  ): void | Promise<void>;
}

/** How long a capability call waits before giving up. */
const CALL_TIMEOUT_MS = 30_000;

/** How long a panel liveness probe waits for its pong. */
const PROBE_TIMEOUT_MS = 1500;

// ── Runtime ──────────────────────────────────────────────────────────────

/**
 * `process.parentPort`, reached through globalThis so this package needs no
 * `@types/node` — it is the only Node API it touches, and pulling in the whole
 * type surface for one property would be a silly dependency for a plugin author
 * to inherit.
 */
function hostPort(): HostPort | null {
  const globals = globalThis as unknown as { process?: { parentPort?: HostPort } };
  return globals.process?.parentPort ?? null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register a plugin with the host.
 *
 * Call once at module top level. Throws immediately if there is no host port —
 * a plugin backend only ever runs forked by the host, so a missing port means
 * it was started by hand, and every message would go nowhere.
 */
export function plugin(handlers: PluginHandlers): void {
  const host = hostPort();
  if (!host) {
    throw new Error(
      'pi plugin SDK: no host port. A plugin backend must be started by the host ' +
        '(it is forked as a child process); running it directly cannot work.',
    );
  }

  let panelPort: PanelPort | null = null;
  /**
   * All live panel ports by panel id. One panel id can have SEVERAL ports:
   * the viewer's split pane is a second native view of the same page, and —
   * with multiple app windows — EVERY window that shows the panel mounts its
   * own view and transfers its own port. Backend → panel traffic is fanned
   * out to all of them, so a background window's panel still receives
   * `ctx.send()` / status events. Ports carry no panel id at transfer time;
   * each port's panel is learned from its first inbound tagged message.
   * `panelPort` (the most recent transfer) is the fallback for traffic with
   * no routing information.
   */
  const panelPorts = new Map<string, Set<PanelPort>>();
  const portPanel = new Map<PanelPort, string>();
  /** Which host tab each port last spoke for (multi-instance routing). */
  const portTab = new Map<PanelPort, string | undefined>();
  /** Session/workspace of each tab, learned from panel.mounted/activated. */
  const tabMeta = new Map<string, { sessionId?: string; workspaceId?: string }>();
  let pluginId = '';
  let dataDir = '';
  /** False until the host's `init` arrives; handlers must not run before it. */
  let booted = false;
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Panels already warned about having no onPanelMounted handler — warn once each. */
  const mountWarned = new Set<string>();
  /** Set when the panel port closes — the closest thing to "the window is gone". */
  let portClosed = false;
  let probeSeq = 0;
  const pendingProbes = new Map<string, () => void>();

  /** Every port a panel's traffic should reach (one per mounted view).
   *  With `tabId`, only the ports known to belong to that tab are targeted;
   *  falling back to the panel-wide set keeps a backend that sends before the
   *  tab has spoken once working. */
  function routeFor(panelId?: string, tabId?: string): PanelPort[] {
    if (panelId) {
      const ports = panelPorts.get(panelId);
      if (ports && ports.size > 0) {
        if (tabId) {
          const matched = [...ports].filter((port) => portTab.get(port) === tabId);
          if (matched.length > 0) return matched;
        }
        return [...ports];
      }
    }
    return panelPort ? [panelPort] : [];
  }

  const post = (message: unknown): void => host.postMessage(message);
  const log = (level: string, message: string): void => post({ type: 'log', level, message });

  const ctx: PluginContext = {
    get pluginId() {
      return pluginId;
    },
    get dataDir() {
      return dataDir;
    },
    call<T>(
      method: string,
      params: Record<string, unknown> = {},
      options?: { timeoutMs?: number },
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = 'c' + ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        post({ type: 'call', id, method, params });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
        }, options?.timeoutMs ?? CALL_TIMEOUT_MS);
      });
    },
    send(panelId: string, event: string, data?: unknown, tabId?: string): boolean {
      // No port, or every port has closed: the message goes nowhere.
      // Deliberately not logged — see the interface comment. Returning false
      // is how a caller finds out.
      const ports = routeFor(panelId, tabId);
      if (ports.length === 0) return false;
      let delivered = false;
      for (const port of ports) {
        try {
          port.postMessage({ kind: 'event', event, panelId, tabId, data });
          delivered = true;
        } catch {
          /* this view went away between the lookup and the send */
        }
      }
      return delivered;
    },
    panelAlive(panelId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
      // No port, or every port has closed: nothing to ask, and asking would be
      // a postMessage into a dead peer, which succeeds silently.
      const ports = routeFor(panelId);
      if (ports.length === 0) return Promise.resolve(false);
      const id = 'probe-' + ++probeSeq;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingProbes.delete(id);
          resolve(false);
        }, timeoutMs);
        pendingProbes.set(id, () => {
          clearTimeout(timer);
          resolve(true);
        });
        // Any one mounted view answering is enough: the panel is alive.
        for (const port of ports) {
          try {
            port.postMessage({ kind: 'event', event: 'pi.probe', panelId, data: { id } });
          } catch {
            /* dead port */
          }
        }
      });
    },
    async openPanel(panelId: string, options?: { focus?: boolean }): Promise<unknown> {
      return ctx.call('panel.open', { panelId, focus: options?.focus !== false });
    },
    async setBadge(panelId: string, badge: number | string | null): Promise<void> {
      await ctx.call('panel.setStatus', { panelId, badge: badge ?? '' }).catch(() => {});
    },
    messages: {
      post: (params) =>
        ctx.call('messages.post', params as unknown as Record<string, unknown>) as Promise<{
          messageId: string;
          entryId?: string;
        }>,
      update: (params) =>
        ctx.call('messages.update', params as unknown as Record<string, unknown>) as Promise<{
          messageId: string;
          entryId?: string;
          revision?: number;
        }>,
      remove: (params) =>
        ctx.call('messages.remove', params as unknown as Record<string, unknown>) as Promise<{
          messageId: string;
          entryId?: string;
          revision?: number;
        }>,
    },
    log: {
      info: (m: string) => log('info', m),
      warn: (m: string) => log('warn', m),
      error: (m: string) => log('error', m),
    },
  };

  // ── Tool calls ──
  async function runTool(msg: IncomingMessage): Promise<void> {
    const id = msg.id ?? '';
    const name = msg.name ?? '';
    // Handlers receive the context as an argument, and before `init` there is
    // no plugin id or data dir to put in it. A tool call cannot legitimately
    // arrive first — the host sends `init` before anything else — so this is
    // either a test driving the backend without one or a host bug. Say which,
    // rather than letting the handler fail on an empty context.
    if (!booted) {
      post({
        type: 'tool-result',
        id,
        error:
          `tool "${name}" arrived before the host sent init — no plugin id or data dir yet. ` +
          `If you are testing the backend directly, send { type: 'init', pluginId, dataDir } first.`,
      });
      return;
    }
    if (!handlers.onTool) {
      post({ type: 'tool-result', id, error: `this plugin contributes no tools (asked for "${name}")` });
      return;
    }
    try {
      const result = await handlers.onTool(name, msg.params ?? {}, ctx, {
        sessionId: msg.sessionId,
        workspaceId: msg.workspaceId,
      });
      // A handler that returns nothing is almost always a forgotten `return`,
      // and the agent would see an empty tool result with no explanation.
      if (result === undefined || result === null) {
        post({
          type: 'tool-result',
          id,
          error: `tool "${name}" returned nothing. Return a string, or an object with content/details/card.`,
        });
        return;
      }
      if (typeof result === 'string') {
        post({ type: 'tool-result', id, content: [{ type: 'text', text: result }] });
        return;
      }
      post({ type: 'tool-result', id, ...result });
    } catch (err) {
      post({ type: 'tool-result', id, error: describe(err) });
    }
  }

  // ── Panel traffic ──
  async function onPanelMessage(raw: unknown, sourcePort?: PanelPort): Promise<void> {
    const msg = raw as {
      kind?: string;
      id?: string;
      panelId?: string;
      tabId?: string;
      method?: string;
      params?: Record<string, unknown>;
      event?: string;
      data?: unknown;
    } | null;
    if (!msg || typeof msg !== 'object') return;

    // Learn which tab this port speaks for. Replies go back on the same port,
    // so targeted `ctx.send(panelId, …, tabId)` can find it later.
    if (sourcePort && msg.tabId !== undefined) portTab.set(sourcePort, msg.tabId);

    if (msg.kind === 'request') {
      const id = String(msg.id ?? '');
      const method = String(msg.method ?? '');
      const panelId = msg.panelId ?? '';
      const tabId = msg.tabId;
      // Replies go back on the port the request CAME from — with several
      // panels (or windows) alive there is no single "the panel port".
      const replyPort = sourcePort ?? routeFor(panelId)[0];
      const reply = (ok: boolean, error?: string, result?: unknown): void => {
        replyPort?.postMessage({ kind: 'response', id, ok, panelId, error, result });
      };
      if (!panelId) {
        log('warn', `panel request "${method}" arrived with no panel id — cannot attribute it.`);
      }
      if (!handlers.onRequest) {
        reply(false, `this plugin handles no panel requests (asked for "${method}")`);
        return;
      }
      if (!booted) {
        reply(false, `request "${method}" arrived before the host sent init — no plugin id or data dir yet.`);
        return;
      }
      try {
        const known = tabId ? tabMeta.get(tabId) : undefined;
        const result = await handlers.onRequest(panelId, method, msg.params ?? {}, ctx, {
          tabId,
          sessionId: known?.sessionId,
          workspaceId: known?.workspaceId,
        });
        // A request must ANSWER. Returning nothing is either a forgotten
        // `return` or an unhandled method name, and both used to look like
        // success on the panel side — it would resolve with undefined and the
        // real bug would surface somewhere far away.
        if (result === undefined) {
          reply(
            false,
            `onRequest handled "${method}" without returning anything. ` +
              `Return the answer (a value, or true), or rethrow for a method you do not handle.`,
          );
          return;
        }
        reply(true, undefined, result);
      } catch (err) {
        reply(false, describe(err));
      }
      return;
    }

    if (msg.kind === 'event') {
      const event = String(msg.event ?? '');
      const panelId = msg.panelId ?? '';
      const tabId = msg.tabId;

      // The pong for ctx.panelAlive — SDK-level, like panel.mounted. An author
      // asking "is the panel there" should not have to also write the reply.
      if (event === 'pi.probe.reply') {
        const probeId = String((msg.data as { id?: string })?.id ?? '');
        const resolve = pendingProbes.get(probeId);
        if (resolve) {
          pendingProbes.delete(probeId);
          resolve();
        }
        return;
      }

      if (!panelId) log('warn', `panel event "${event}" arrived with no panel id.`);

      // `panel.mounted` is the host's lifecycle signal, not a plugin event —
      // intercept it so an author cannot accidentally swallow it in onEvent and
      // leave a permanently blank panel.
      if (event === 'panel.mounted') {
        const data = (msg.data ?? {}) as {
          tabId?: string;
          params?: unknown;
          sessionId?: string;
          workspaceId?: string;
        };
        if (data.tabId) {
          tabMeta.set(data.tabId, {
            sessionId: data.sessionId,
            workspaceId: data.workspaceId,
          });
        }
        if (!handlers.onPanelMounted) {
          if (!mountWarned.has(panelId)) {
            mountWarned.add(panelId);
            log(
              'warn',
              `panel "${panelId}" mounted but nothing was drawn: this plugin has no ` +
                `onPanelMounted handler. Add one and push the panel's first state from there.`,
            );
          }
          return;
        }
        try {
          await handlers.onPanelMounted(panelId, data.params, ctx, {
            tabId: data.tabId ?? tabId,
            sessionId: data.sessionId,
            workspaceId: data.workspaceId,
          });
        } catch (err) {
          log('error', `onPanelMounted for "${panelId}" threw: ${describe(err)}`);
        }
        return;
      }

      // Activation is a lifecycle signal too: it is what keeps a multi-tab
      // backend's "current document/page" on the tab the user is looking at.
      if (event === 'panel.activated' && handlers.onPanelActivated) {
        const data = (msg.data ?? {}) as {
          tabId?: string;
          params?: unknown;
          sessionId?: string;
          workspaceId?: string;
        };
        if (data.tabId) {
          tabMeta.set(data.tabId, {
            sessionId: data.sessionId,
            workspaceId: data.workspaceId,
          });
        }
        try {
          await handlers.onPanelActivated(panelId, data.params, ctx, {
            tabId: data.tabId ?? tabId,
            sessionId: data.sessionId,
            workspaceId: data.workspaceId,
          });
        } catch (err) {
          log('error', `onPanelActivated for "${panelId}" threw: ${describe(err)}`);
        }
        return;
      }

      if (!handlers.onEvent) {
        log('warn', `panel event "${event}" ignored: this plugin handles no events.`);
        return;
      }
      try {
        const known = tabId ? tabMeta.get(tabId) : undefined;
        await handlers.onEvent(panelId, event, msg.data, ctx, {
          tabId,
          sessionId: known?.sessionId,
          workspaceId: known?.workspaceId,
        });
      } catch (err) {
        log('error', `panel event "${event}" handler threw: ${describe(err)}`);
      }
      return;
    }

    log('warn', `unrecognised panel message (kind=${String((msg as { kind?: string }).kind)}) — ignored`);
  }

  // ── Host messages ──
  host.on('message', (event) => {
    const msg = (event.data ?? {}) as IncomingMessage;
    switch (msg.type) {
      case 'init':
        pluginId = msg.pluginId ?? '';
        dataDir = msg.dataDir ?? '';
        booted = true;
        Promise.resolve(handlers.onInit?.(ctx)).catch((err) =>
          log('error', `onInit threw: ${describe(err)}`),
        );
        break;

      case 'call-result': {
        const entry = pending.get(msg.id ?? '');
        if (entry) {
          pending.delete(msg.id ?? '');
          if (msg.error) entry.reject(new Error(msg.error));
          else entry.resolve(msg.result);
        }
        break;
      }

      case 'tool-call':
        void runTool(msg);
        break;

      case 'command':
        if (!handlers.onCommand) {
          post({ type: 'command-result', id: msg.id, error: `this plugin contributes no commands` });
          break;
        }
        Promise.resolve(handlers.onCommand(msg.name ?? '', msg.args, ctx))
          .then((result) => post({ type: 'command-result', id: msg.id, result }))
          .catch((err) => post({ type: 'command-result', id: msg.id, error: describe(err) }));
        break;

      case 'context-request':
        if (!handlers.onContextRequest) {
          post({ type: 'context-result', id: msg.id, error: `this plugin contributes no context providers` });
          break;
        }
        Promise.resolve(handlers.onContextRequest(msg.providerId ?? '', msg.message ?? '', ctx))
          .then((text) => post({ type: 'context-result', id: msg.id, text: text ?? '' }))
          .catch((err) => post({ type: 'context-result', id: msg.id, error: describe(err) }));
        break;

      case 'host-event':
        try {
          handlers.onHostEvent?.(msg.event ?? '', msg.data, ctx);
        } catch (err) {
          log('error', `host event "${String(msg.event)}" handler threw: ${describe(err)}`);
        }
        break;

      case 'card-event': {
        if (!handlers.onCardEvent) {
          // The card was rendered because the manifest declares a
          // messageRenderer, but this backend never wired the handler — a
          // dead button is exactly the silent failure the SDK exists to
          // prevent, so it gets a log line with the event id to look for.
          log('warn', `card event "${String(msg.eventId)}" on ${String(msg.toolName)} ignored — implement onCardEvent`);
          break;
        }
        try {
          handlers.onCardEvent(
            msg.toolName ?? '',
            msg.eventId ?? '',
            msg.kind === 'submit' ? 'submit' : 'click',
            msg.payload,
            ctx,
          );
        } catch (err) {
          log('error', `card event "${String(msg.eventId)}" handler threw: ${describe(err)}`);
        }
        break;
      }

      case 'message-action': {
        if (!handlers.onMessageAction) {
          log(
            'warn',
            `message action "${String(msg.eventId)}" on ${String(msg.messageId)} ignored — implement onMessageAction`,
          );
          break;
        }
        Promise.resolve()
          .then(() =>
            handlers.onMessageAction!(
              msg.messageId ?? '',
              msg.eventId ?? '',
              msg.kind === 'submit' ? 'submit' : 'click',
              msg.payload,
              ctx,
              { sessionId: msg.sessionId },
            ),
          )
          .catch((err) => {
            log('error', `message action "${String(msg.eventId)}" handler threw: ${describe(err)}`);
          });
        break;
      }

      case 'ui-port': {
        const port = event.ports?.[0] as PanelPort | undefined;
        if (!port) break;
        // Several panels of this plugin may be alive AT ONCE (the viewer's
        // split pane is a second native view of the same page), so this ADDS a
        // port rather than replacing the previous one. `panelPort` — the most
        // recent transfer — remains the fallback for traffic that cannot be
        // attributed. A renderer reload transfers a fresh port for the SAME
        // panel; the old port's close event retires exactly that binding.
        panelPort = port;
        portClosed = false;
        port.on('message', (e) => {
          // Learn the port's panel from its first tagged message — the
          // ui-port transfer carries no panel id.
          const pid = (e.data as { panelId?: string } | null)?.panelId;
          if (pid) {
            portPanel.set(port, pid);
            const ports = panelPorts.get(pid) ?? new Set<PanelPort>();
            ports.add(port);
            panelPorts.set(pid, ports);
          }
          void onPanelMessage(e.data, port);
        });
        // The host closes a replaced port when a fresh webContents takes over.
        // That is the only close signal that exists — see panelAlive.
        try {
          port.on('close', () => {
            const pid = portPanel.get(port);
            if (pid) {
              const ports = panelPorts.get(pid);
              ports?.delete(port);
              if (ports && ports.size === 0) panelPorts.delete(pid);
            }
            portPanel.delete(port);
            if (panelPort === port) {
              const last = [...panelPorts.values()].at(-1);
              panelPort = last ? [...last].at(-1) ?? null : null;
              if (!panelPort) portClosed = true;
            }
          });
        } catch {
          /* older Electron: no close event; the probe timeout still covers it */
        }
        port.start?.();
        break;
      }

      default:
        break;
    }
  });

  post({ type: 'ready' });
}
