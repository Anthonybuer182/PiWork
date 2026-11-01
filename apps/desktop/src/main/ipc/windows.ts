import { ipcMain } from 'electron';
import type { WindowRegistry } from '@main/windows';
import { hostWindowOf } from './guard';

/**
 * Window-scoped IPC: creation, the session claim protocol, and the two
 * plugin-view channels that used to be registered per PluginWebViews
 * instance. They are registered ONCE here and resolve the sender window
 * first — the same channel now has several possible owners.
 */
export function registerWindowIpcHandlers(windows: WindowRegistry): void {
  ipcMain.handle('pi:window:new', (event) => {
    const caller = hostWindowOf(event);
    if (!caller) return { ok: false, error: 'untrusted sender' };
    const ctx = windows.newFromFocused();
    return { ok: true, windowId: ctx.windowId };
  });

  ipcMain.handle(
    'pi:window:open-workspace',
    (event, payload: { workspaceId?: string; forceNew?: boolean }) => {
      if (!hostWindowOf(event)) return { ok: false, error: 'untrusted sender' };
      const workspaceId = payload?.workspaceId;
      if (!workspaceId) return { ok: false, error: 'missing workspaceId' };
      return windows.openWorkspace(workspaceId, { forceNew: payload?.forceNew === true });
    },
  );

  /**
   * "Is this workspace already open in another window?" — the renderer asks
   * before switching, mirroring VS Code's open-folder-matches-existing-window
   * behaviour. Returns false when this window (or no window) has it, in which
   * case the renderer switches locally.
   */
  ipcMain.handle('pi:window:focus-workspace', (event, payload: { workspaceId?: string }) => {
    const ctx = hostWindowOf(event);
    if (!ctx) return { focused: false };
    const workspaceId = payload?.workspaceId;
    if (!workspaceId) return { focused: false };
    return { focused: windows.focusWorkspaceElsewhere(workspaceId, ctx.windowId) };
  });

  ipcMain.handle(
    'pi:window:open-session',
    (event, payload: { sessionId?: string; workspaceId?: string }) => {
      if (!hostWindowOf(event)) return { ok: false, error: 'untrusted sender' };
      const sessionId = payload?.sessionId;
      const workspaceId = payload?.workspaceId;
      if (!sessionId || !workspaceId) return { ok: false, error: 'missing sessionId or workspaceId' };
      return windows.openSessionInNewWindow(sessionId, workspaceId);
    },
  );

  /**
   * Claim a conversation for the calling window. The renderer calls this
   * BEFORE changing its own active session; a refusal means another window
   * already shows it and has just been focused.
   */
  ipcMain.handle('pi:window:activate-session', (event, payload: { sessionId?: string | null }) => {
    const ctx = hostWindowOf(event);
    if (!ctx) return { ok: false, error: 'untrusted sender' };
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
    return windows.claimActiveSession(ctx.windowId, sessionId);
  });

  /** The window's own view state — lets a reloaded renderer re-sync without localStorage. */
  ipcMain.handle('pi:window:context', (event) => {
    const ctx = hostWindowOf(event);
    if (!ctx) return null;
    return {
      windowId: ctx.windowId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.activeSessionId,
    };
  });

  // ── Plugin panel views ────────────────────────────────────────────────
  // Theme tokens are collected by whichever shell renderer owns the CSS
  // variables; the registry fans them out to every window's panel views.
  ipcMain.on('pi:plugin:set-theme', (_event, tokens: Record<string, string>) => {
    windows.setTheme(tokens);
  });

  // The shell raises `panel.mounted` with the panel's open params; the event
  // must travel on the port of THAT window's view for that panel.
  ipcMain.handle(
    'pi:plugin:panel-mounted',
    (
      event,
      msg: {
        pluginId?: string;
        panelId?: string;
        params?: unknown;
        sessionId?: string;
        workspaceId?: string;
      },
    ) => {
      const ctx = windows.byWebContents(event.sender);
      if (!ctx?.pluginWebViews) return { ok: false, error: 'unknown window' };
      return ctx.pluginWebViews.handlePanelMounted(msg);
    },
  );
}
