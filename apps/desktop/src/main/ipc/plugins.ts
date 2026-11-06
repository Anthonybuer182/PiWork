import { ipcMain } from 'electron';
import type { InstallPhase } from '@pi/types';
import type { PluginSystem } from '@main/plugins';
import type { WindowRegistry } from '@main/windows';
import { hostWindowOf } from './guard';

/**
 * IPC surface for the renderer (see preload `pluginBridge`):
 *
 *   pi:plugin:list            → PluginInfo[] (enabled plugins)
 *   pi:plugin:list-all        → PluginInfo[] (incl. disabled/incompatible)
 *   pi:plugin:ensure-port     → { ok } + 'pi:plugin:port' port transfer
 *   pi:plugin:execute-command → { ok, result? }
 *   pi:plugin:market:catalog  → MarketEntry[] | { error }
 *   pi:plugin:market:install  → InstallResult (phases pushed as events)
 *   pi:plugin:uninstall       → InstallResult
 *   pi:plugin:set-enabled     → InstallResult
 *   pi:plugin:event           ← push channel (status/state/plugins-changed/install-phase)
 */
export function registerPluginIpcHandlers(system: PluginSystem, windows?: WindowRegistry): void {
  // The renderer owns "which conversation is on screen" — a view fact, not a
  // session one. Each window reports its own; the backend-visible value is the
  // FOCUSED window's conversation, and only the focused window's report is
  // broadcast (a background window switching sessions must not re-target the
  // plugin backends of the window the user is looking at).
  ipcMain.handle('pi:agent:set-active-session', (event, session: { id?: string } | null) => {
    const sessionId = session?.id ?? null;

    if (windows) {
      const ctx = hostWindowOf(event);
      if (!ctx) return { ok: false, error: 'untrusted sender' };
      const claim = windows.claimActiveSession(ctx.windowId, sessionId);
      // The claim hook (focused window only) already pushed session.changed;
      // a refused claim focuses the owner and must not overwrite its state.
      return claim;
    }

    system.setActiveSession(sessionId);
    system.pushHostEvent('session.changed', undefined, { sessionId });
  });

  // `list`/`list-all`/`ensure-port` gate on kernel boot — in packaged builds the
  // file:// renderer fires its first plugin IPC within milliseconds, possibly
  // before `PluginSystem.init()` (spawn backends, protocol) has finished.
  ipcMain.handle('pi:plugin:list', async () => {
    await system.whenReady();
    return system.listInfos();
  });

  ipcMain.handle('pi:plugin:list-all', async () => {
    await system.whenReady();
    return system.listAllInfos();
  });

  ipcMain.handle('pi:plugin:ensure-port', async (event, payload: { pluginId?: string }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId) return { ok: false, error: 'missing pluginId' };
    await system.whenReady();
    return system.ensureUiPort(pluginId, event.sender);
  });

  ipcMain.handle('pi:plugin:execute-command', async (_event, payload: { pluginId?: string; name?: string; args?: string }) => {
    const { pluginId, name, args } = payload ?? {};
    if (!pluginId || !name) return { ok: false, error: 'missing pluginId or name' };
    try {
      const result = await system.executeCommand(pluginId, name, args);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Declarative card interactions from the chat timeline (see ToolCallDisplay
  // and DeclarativeRenderer). Fire-and-forget: {ok:false} here just means the
  // plugin has no backend to receive it.
  ipcMain.handle(
    'pi:plugin:card-event',
    (_event, payload: { pluginId?: string; toolName?: string; eventId?: string; kind?: string; payload?: unknown }) => {
      const { pluginId, toolName, eventId, kind } = payload ?? {};
      if (!pluginId || !toolName || !eventId) return { ok: false, error: 'missing pluginId, toolName or eventId' };
      const ok = system.sendCardEvent(pluginId, toolName, eventId, kind === 'submit' ? 'submit' : 'click', payload?.payload);
      return ok ? { ok: true } : { ok: false, error: `plugin "${pluginId}" has no backend` };
    },
  );

  // ── Marketplace ──
  ipcMain.handle('pi:plugin:market:catalog', async (_event, payload?: { force?: boolean }) => {
    try {
      const plugins = await system.catalog(payload?.force === true);
      return { ok: true, plugins, registryUrl: system.marketplace.registryUrl };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), plugins: [] };
    }
  });

  ipcMain.handle('pi:plugin:market:install', async (event, payload: { pluginId?: string }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId) return { ok: false, error: 'missing pluginId' };
    // Install progress is kernel-wide: every window may show it, and each
    // window's plugin store applies it independently.
    const pushPhase = (phase: InstallPhase) => {
      windows?.broadcast('pi:plugin:event', { type: 'install-phase', pluginId, phase });
    };
    return system.installFromMarket(pluginId, pushPhase);
  });

  ipcMain.handle('pi:plugin:uninstall', async (_event, payload: { pluginId?: string; keepData?: boolean }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId) return { ok: false, error: 'missing pluginId' };
    return system.uninstall(pluginId, { keepData: payload.keepData !== false });
  });

  ipcMain.handle('pi:plugin:rollback', async (_event, payload: { pluginId?: string }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId) return { ok: false, error: 'missing pluginId' };
    return system.rollback(pluginId);
  });

  ipcMain.handle('pi:plugin:set-enabled', async (_event, payload: { pluginId?: string; enabled?: boolean }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId || typeof payload.enabled !== 'boolean') {
      return { ok: false, error: 'missing pluginId or enabled' };
    }
    return system.setEnabled(pluginId, payload.enabled);
  });

  // ── Extensions (tools / preview routing) ──
  // ── Context providers (pre-send hook) ──
  ipcMain.handle('pi:plugin:collect-context', async (_event, payload: { message?: string }) => {
    const message = String(payload?.message ?? '');
    const providers = system.listAutoContextProviders();
    const sections: string[] = [];
    await Promise.all(
      providers.map(async ({ pluginId, providerId }) => {
        try {
          const text = await system.executeContextProvider(pluginId, providerId, message);
          if (text && text.trim()) sections.push(`【${pluginId}】${text.trim()}`);
        } catch { /* provider failure never blocks the send */ }
      }),
    );
    return { ok: true, sections: sections.filter(Boolean) };
  });

  // ── Plugin settings ──
  ipcMain.handle('pi:plugin:get-settings', (_event, payload: { pluginId?: string }) => {
    const pluginId = payload?.pluginId;
    if (!pluginId) return { ok: false, error: 'missing pluginId' };
    return { ok: true, settings: system.getPluginSettings(pluginId) };
  });

  ipcMain.handle('pi:plugin:set-setting', (_event, payload: { pluginId?: string; key?: string; value?: unknown }) => {
    const { pluginId, key, value } = payload ?? {};
    if (!pluginId || !key) return { ok: false, error: 'missing pluginId or key' };
    return system.setPluginSetting(pluginId, key, value);
  });

  ipcMain.handle('pi:plugin:find-preview', (_event, payload: { path?: string }) => {
    const path = payload?.path;
    if (!path) return { panelId: null };
    return { panelId: system.findPreviewHandler(path) };
  });

  // OS files dropped on a plugin PANEL BODY (a native view): the shell renderer
  // never sees that event, so the view's preload resolves the paths and sends
  // them here. Route them to the owning window's host renderer, which owns the
  // right-column tab store. Paths never pass through the plugin page.
  ipcMain.on('pi:plugin:os-drop', (event, paths: unknown) => {
    if (!windows || !Array.isArray(paths)) return;
    const ctx = windows.byWebContents(event.sender);
    if (!ctx || !ctx.pluginWebViews?.ownsWebContents(event.sender)) return;
    const cleaned = paths
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .slice(0, 50);
    if (cleaned.length === 0) return;
    windows.send(ctx.win, 'pi:os:dropped-files', { paths: cleaned });
  });

  ipcMain.handle('pi:plugin:list-tools', () => {
    return system.aggregateTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  });

  ipcMain.handle('pi:plugin:execute-tool', async (_event, payload: { pluginId?: string; name?: string; params?: Record<string, unknown>; sessionId?: string; workspaceId?: string }) => {
    const { pluginId, name, params, sessionId, workspaceId } = payload ?? {};
    if (!pluginId || !name) return { ok: false, error: 'missing pluginId or name' };
    try {
      // The agent path always supplies the calling conversation; this IPC is
      // also used by tests and devtools, which need to name it explicitly or
      // session-scoped tools fall back to whatever panel mounted last.
      const result = await system.executeTool(pluginId, name, params ?? {}, sessionId, workspaceId);
      return { ok: true, content: result.content ?? [], details: result.details ?? null, card: result.card ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
