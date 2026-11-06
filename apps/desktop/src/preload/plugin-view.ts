import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Preload for plugin WebContentsViews.
 *
 * Why this exists: plugin panels used to be iframes inside the shell renderer,
 * so the shell could reach them with `contentWindow.postMessage` and relay
 * their messages back over `pluginBridge`. A WebContentsView is a top-level
 * frame — `window.parent` is the page itself and the shell has no handle on it
 * at all. So the same two directions have to be re-established here:
 *
 *   page → host   window.__piViewBridge.send(payload)  → MessagePort → backend
 *   host → page   backend → MessagePort → onMessage(cb) → page's SDK
 *
 * The MessagePort is requested BY THIS PRELOAD (`pi:plugin:ensure-port`), so
 * the main process sees this view's webContents as the sender and transfers the
 * port here rather than to the shell. `PluginSystem.ensureUiPort` keys its
 * idempotence map on `${pluginId}:${sender.id}`, so a view and the shell get
 * distinct pairs with no change on the main side.
 *
 * The plugin id arrives via `additionalArguments` (the view is created per
 * panel, so the preload cannot know it statically).
 */

const PLUGIN_ID =
  process.argv.find((a) => a.startsWith('--pi-plugin-id='))?.slice('--pi-plugin-id='.length) ?? '';
/**
 * The host tab this view belongs to. Singleton panels' tab key is their panel
 * entry id; multi-instance panels append an instance suffix. It rides on every
 * panel → backend message so a backend shared by several tabs can tell them
 * apart (see `PluginHandlers.onRequest`'s meta).
 */
const TAB_KEY =
  process.argv.find((a) => a.startsWith('--pi-tab-key='))?.slice('--pi-tab-key='.length) ?? '';

interface PortLike {
  on(event: 'message', listener: (ev: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

let port: PortLike | null = null;
let messageCallback: ((payload: unknown) => void) | null = null;
let eventCallback: ((event: unknown) => void) | null = null;
/** Messages sent before the port lands are buffered and flushed on arrival. */
const outbox: unknown[] = [];
/**
 * Backend traffic held until the page can receive it.
 *
 * Two things have to be true before a payload is worth delivering: the page's
 * SDK must have registered (it runs as the first script in <head>), and the
 * plugin's own code must have run. Plugin UIs listen on `window` for backend
 * frames — they register that listener from their bundle, which executes later
 * than the SDK. A `ui.render` that lands in between is simply lost, and the
 * panel stays stuck on its empty state. So hold everything until `load`.
 */
const inbox: unknown[] = [];
let pageLoaded = document.readyState === 'complete';

/** Transport counters — see bridge.stats(). */
let sentCount = 0;
let receivedCount = 0;

/** Hand a backend payload to the page, or hold it until the page is ready. */
function deliver(payload: unknown): void {
  if (pageLoaded && messageCallback) {
    messageCallback(payload);
    return;
  }
  inbox.push(payload);
}

function flushInbox(): void {
  if (!pageLoaded || !messageCallback) return;
  while (inbox.length) {
    try {
      messageCallback(inbox.shift());
    } catch {
      break;
    }
  }
}

window.addEventListener('load', () => {
  pageLoaded = true;
  flushInbox();
}, { once: true });

// ── Native popup menu (pi:menu:popup) ──
// The click/dismiss round-trip comes back over ipcRenderer on this view; the
// nonce pairs them with the popup call. A page-settable override lets
// automated tests resolve the choice without the OS menu (contextBridge
// function properties are read-only from the page, so tests cannot
// monkey-patch showPopupMenu directly).
let menuNonceSeq = 0;
const menuWaiters = new Map<number, (id: string | null) => void>();
let menuListenersInstalled = false;
let popupMenuOverride: ((items: unknown[], x: number, y: number) => string | null) | null = null;
function installMenuListeners(): void {
  if (menuListenersInstalled) return;
  menuListenersInstalled = true;
  ipcRenderer.on('pi:menu:click', (_e, payload: { nonce?: number; id?: string }) => {
    const nonce = payload?.nonce;
    if (nonce == null) return;
    const resolve = menuWaiters.get(nonce);
    if (!resolve) return;
    menuWaiters.delete(nonce);
    resolve(payload?.id ?? null);
  });
  ipcRenderer.on('pi:menu:dismiss', (_e, payload: { nonce?: number }) => {
    const nonce = payload?.nonce;
    if (nonce == null) return;
    const resolve = menuWaiters.get(nonce);
    if (!resolve) return;
    menuWaiters.delete(nonce);
    resolve(null);
  });
}

ipcRenderer.on('pi:plugin:port', (event, meta: { pluginId?: string }) => {
  const incoming = (event.ports as unknown as PortLike[] | undefined)?.[0];
  if (!incoming) return;

  port?.close();
  port = incoming;

  const onPortMessage = (ev: { data: unknown }) => {
    receivedCount++;
    deliver(ev.data);
  };
  if (typeof incoming.on === 'function') {
    // Electron's MessagePortMain is EventEmitter-style and needs start().
    incoming.on('message', onPortMessage);
    incoming.start();
  } else {
    // DOM-style MessagePort: assigning onmessage starts it.
    (incoming as unknown as { onmessage: typeof onPortMessage }).onmessage = onPortMessage;
  }

  while (outbox.length) {
    try {
      incoming.postMessage(outbox.shift());
    } catch {
      break;
    }
  }
  void meta;
});

ipcRenderer.on('pi:plugin:event', (_event, evt) => eventCallback?.(evt));

/** Post to the backend, queueing while the port is still in flight. */
function toBackend(payload: unknown): void {
  sentCount++;
  let message = payload;
  // Every message carries the originating tab. The backend SDK groups ports by
  // panel id and uses this to route `ctx.send(panelId, …, tabId)` and to hand
  // `tabId` to onRequest/onEvent. Older backends ignore the extra field.
  if (TAB_KEY && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.tabId === undefined) message = { ...record, tabId: TAB_KEY };
  }
  if (port) {
    try {
      port.postMessage(message);
      return;
    } catch {
      /* port closed mid-flight — fall through to the outbox */
    }
  }
  outbox.push(message);
}

/**
 * `panel.mounted` is raised by the shell (it owns the panel's open params), but
 * the port it has to travel on lives here. So the shell asks main to route the
 * event to this view, and the preload puts it on the wire — queued if the port
 * has not landed yet. Without this the backend never renders and the panel
 * stays empty.
 */
ipcRenderer.on(
  'pi:plugin:panel-mounted',
  (
    _event,
    msg: {
      panelId?: string;
      tabId?: string;
      params?: unknown;
      sessionId?: string;
      workspaceId?: string;
    },
  ) => {
    toBackend({
      kind: 'event',
      event: 'panel.mounted',
      panelId: msg?.panelId,
      tabId: msg?.tabId ?? TAB_KEY,
      // sessionId rides in `data` (NOT in params): it identifies the
      // conversation the panel now serves, it is not an open param. Same for
      // workspaceId — it is the project the panel is serving.
      data: {
        panelId: msg?.panelId,
        tabId: msg?.tabId ?? TAB_KEY,
        params: msg?.params,
        sessionId: msg?.sessionId,
        workspaceId: msg?.workspaceId,
      },
    });
    notifyWorkspace(msg?.workspaceId);
  },
);

// The user switched to this tab. The backend keeps "current document / current
// page" per conversation; this tells it which tab's state is current.
ipcRenderer.on(
  'pi:plugin:panel-activated',
  (
    _event,
    msg: {
      panelId?: string;
      tabId?: string;
      params?: unknown;
      sessionId?: string;
      workspaceId?: string;
    },
  ) => {
    toBackend({
      kind: 'event',
      event: 'panel.activated',
      panelId: msg?.panelId,
      tabId: msg?.tabId ?? TAB_KEY,
      data: {
        panelId: msg?.panelId,
        tabId: msg?.tabId ?? TAB_KEY,
        params: msg?.params,
        sessionId: msg?.sessionId,
        workspaceId: msg?.workspaceId,
      },
    });
  },
);

// The host tab was closed and this view is about to be destroyed. Multi-tab
// backends use it to drop the per-tab state (open file, engine tab mapping).
ipcRenderer.on(
  'pi:plugin:panel-closed',
  (_event, msg: { panelId?: string; tabId?: string }) => {
    toBackend({
      kind: 'event',
      event: 'panel.closed',
      panelId: msg?.panelId,
      tabId: msg?.tabId ?? TAB_KEY,
      data: { ...msg, tabId: msg?.tabId ?? TAB_KEY },
    });
  },
);

// Theme tokens are collected in the shell (it owns the CSS variables) and
// fanned out here by main. Delivered through the bridge rather than a window
// message because the page's own `window` listeners live in a different world.
let themeCallback: ((tokens: Record<string, string>) => void) | null = null;
let lastThemeTokens: Record<string, string> | null = null;
ipcRenderer.on('pi:plugin:theme', (_event, tokens: Record<string, string>) => {
  lastThemeTokens = tokens;
  themeCallback?.(tokens);
});

/**
 * The workspace this panel serves. The BACKEND also receives it in
 * `panel.mounted`, but a backend is one process shared by every window, so it
 * cannot hold "the panel's workspace" without the last window to mount
 * winning. The page can: each view has its own. So the value is pushed here
 * and read through `piSDK.workspace` / `piSDK.onWorkspace`, not round-tripped
 * through the backend.
 */
let workspaceCallback: ((workspaceId: string | null) => void) | null = null;
let lastWorkspaceId: string | null = null;
function notifyWorkspace(workspaceId: string | undefined): void {
  lastWorkspaceId = typeof workspaceId === 'string' && workspaceId ? workspaceId : null;
  workspaceCallback?.(lastWorkspaceId);
}

const bridge = {
  pluginId: PLUGIN_ID,
  /** This view's host tab key (singleton: the panel entry id). */
  tabId: TAB_KEY,

  /** Ask main for a MessagePort pair; the other end goes to the backend. */
  ensurePort: (pluginId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:plugin:ensure-port', { pluginId: pluginId ?? PLUGIN_ID }),

  /**
   * Fire-and-forget event to the plugin backend. Mirrors the shell's
   * `pluginBridge.send`, including the pre-port buffer, so a panel that sends
   * on first paint does not lose that message.
   */
  send: (payload: unknown, pluginId?: string): void => {
    void pluginId;
    toBackend(payload);
  },

  onMessage: (cb: (payload: unknown) => void): void => {
    messageCallback = cb;
    // Drain anything the backend sent while the page was still parsing.
    flushInbox();
  },

  onEvent: (cb: (event: unknown) => void): void => {
    eventCallback = cb;
  },

  /** Shell theme tokens (the shell owns the CSS variables). */
  onTheme: (cb: (tokens: Record<string, string>) => void): void => {
    themeCallback = cb;
    // Replay if the tokens landed before the page subscribed.
    if (lastThemeTokens) cb(lastThemeTokens);
  },

  /**
   * The workspace this panel is showing — `Workspace.id` (an absolute path),
   * or null while the shell is not in any workspace.
   *
   * Replays on subscribe like `onTheme`, so a page that boots after the mount
   * report still learns it. Fires again when the window switches workspace.
   */
  onWorkspace: (cb: (workspaceId: string | null) => void): void => {
    workspaceCallback = cb;
    cb(lastWorkspaceId);
  },

  /**
   * Native popup menu with custom items — resolves the clicked item id, or
   * null on dismissal. The menu is OS-level, so it floats above engine views
   * (any DOM popup inside this page would be covered by them). The nonce
   * pairs the popup with its click/dismiss round-trip.
   *
   * `__setPopupMenuOverride` is the automated-test seam: the contextBridge
   * object's function properties are read-only from the page, so tests swap
   * the handler through this entry point instead of monkey-patching.
   */
  showPopupMenu: (
    items: { id: string; label: string }[],
    x: number,
    y: number,
  ): Promise<string | null> => {
    if (popupMenuOverride) return Promise.resolve(popupMenuOverride(items, x, y));
    installMenuListeners();
    const nonce = ++menuNonceSeq;
    return new Promise<string | null>((resolve) => {
      menuWaiters.set(nonce, resolve);
      setTimeout(() => {
        if (menuWaiters.has(nonce)) {
          menuWaiters.delete(nonce);
          resolve(null);
        }
      }, 120_000);
      ipcRenderer
        .invoke('pi:menu:popup', { nonce, x: Math.round(x), y: Math.round(y), items })
        .catch(() => {
          if (menuWaiters.has(nonce)) {
            menuWaiters.delete(nonce);
            resolve(null);
          }
        });
    });
  },

  __setPopupMenuOverride: (fn: ((items: unknown[], x: number, y: number) => string | null) | null): void => {
    popupMenuOverride = fn as never;
  },

  /**
   * Live-slot binding (piSDK.liveSlot): let a host engine view be positioned
   * inside the page's layout. The slot id is composed HERE, on the plugin-id
   * prefix — the page can only name slots inside its own plugin's namespace,
   * never another plugin's or the host's.
   */
  liveAttach: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:attach', { slotId: `${PLUGIN_ID}:${String(name)}` }),
  liveBounds: (
    name: string,
    b: { x: number; y: number; width: number; height: number },
    tag?: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:set-bounds', {
      slotId: `${PLUGIN_ID}:${String(name)}`,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      // WHICH engine view the slot wants (the browser's active tab id). The
      // rect and its target travel together: the host never applies one
      // without the other.
      tag: tag ?? '',
    }),
  liveDetach: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:detach', { slotId: `${PLUGIN_ID}:${String(name)}` }),

  /**
   * Transport counters, for diagnosing a panel that stays blank. Cheap enough
   * to leave in: three integers, and they turn "nothing happened" into a
   * specific broken link (no port / not sent / sent but no reply).
   */
  stats: (): Record<string, unknown> => ({
    pluginId: PLUGIN_ID,
    tabId: TAB_KEY,
    portArrived: port !== null,
    portStyle: port ? (typeof (port as unknown as { on?: unknown }).on === 'function' ? 'emitter' : 'dom') : 'none',
    sent: sentCount,
    received: receivedCount,
    outboxDepth: outbox.length,
    inboxDepth: inbox.length,
  }),
};

contextBridge.exposeInMainWorld('__piViewBridge', bridge);

// ── OS file drops on the panel body ──
// A panel body is a native WebContentsView, so the shell renderer never sees
// these events. Resolve the paths here (the page never learns them) and hand
// them to main, which routes them back to the owning window's host renderer to
// open in the right column. Bubble phase + `defaultPrevented`: a plugin page
// that handles the drop itself keeps it.
function installOsFileDropForwarding(): void {
  const isFileDrag = (dataTransfer: DataTransfer | null): boolean =>
    !!dataTransfer &&
    Array.from(dataTransfer.types ?? []).some((type) => type.toLowerCase() === 'files');

  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event.dataTransfer) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event.dataTransfer) || event.defaultPrevented) return;
    event.preventDefault();
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      try {
        const path = webUtils.getPathForFile(file);
        if (path) paths.push(path);
      } catch {
        // Not an OS-backed file — ignore it.
      }
    }
    if (paths.length > 0) ipcRenderer.send('pi:plugin:os-drop', [...new Set(paths)]);
  });
}

installOsFileDropForwarding();

// Ask for the UI MessagePort immediately. Main sees THIS view's webContents as
// the sender, so the port is transferred here rather than to the shell — which
// is what makes the panel the owner of its own backend channel.
void bridge.ensurePort();

export type PluginViewBridge = typeof bridge;
