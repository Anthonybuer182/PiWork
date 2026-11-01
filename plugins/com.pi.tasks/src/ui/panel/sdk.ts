/**
 * The host's panel SDK, typed.
 *
 * `window.piSDK` is injected into every plugin panel at serve time by the host
 * (`plugin-sdk-js.ts`). It is the documented surface, and it already smooths
 * over the panel being an iframe on some hosts and a native `WebContentsView`
 * on the desktop — so this file deals only in `request`/`emit`/`onMessage` and
 * never touches `window.parent`.
 */

export interface PiSDK {
  pluginId: string;
  /** Round-trip to the backend. Rejects when the backend throws. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Fire-and-forget to the backend. */
  emit(event: string, data?: unknown): void;
  /** Backend → UI events. */
  onMessage(cb: (payload: PluginMessage) => void): void;
  /**
   * The workspace this panel is showing — `Workspace.id`, an absolute path —
   * or null when the shell is not in one.
   *
   * Delivered by the host straight to the page (protocol 7), not relayed
   * through the backend: the backend is one process shared by every window, so
   * it cannot say which project *this* panel is serving.
   */
  workspace?: string | null;
  /** Subscribe to workspace changes. Replays the current value immediately. */
  onWorkspace?(cb: (workspaceId: string | null) => void): void;
}

export interface PluginMessage {
  kind?: 'event' | 'response';
  event?: string;
  data?: unknown;
  panelId?: string;
}

declare global {
  interface Window {
    piSDK?: PiSDK;
  }
}

/**
 * Resolve the SDK, waiting briefly if the injected script has not run yet.
 *
 * The script tag is inserted as the first thing in `<head>`, so it is normally
 * present before a module script executes — but a panel opened during a reload
 * can get here first, and failing then would look like a broken plugin rather
 * than a race.
 */
export function getSDK(): Promise<PiSDK> {
  const existing = window.piSDK;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.piSDK) {
        clearInterval(timer);
        resolve(window.piSDK);
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error('piSDK 没有注入：这个面板需要由宿主打开'));
      }
    }, 20);
  });
}

export const PANEL_ID = 'items';
