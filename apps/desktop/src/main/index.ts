import { app } from 'electron';
import { APP_NAME } from '@main/branding';
import { registerIpcHandlers } from '@main/ipc/index';
import { registerNativeIpcHandlers } from '@main/ipc/native';
import { registerWindowIpcHandlers } from '@main/ipc/windows';
import { SettingsManager, ModelRegistry, AuthStorage } from '@earendil-works/pi-coding-agent';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { ENGINE_UA, VlmAnalyzer } from '@main/browser';
import { persistBrowserSessionCookies } from '@main/browser/browser-session';
import { PluginSystem, registerPluginSchemePrivileges } from '@main/plugins';
import { registerPluginIpcHandlers } from '@main/ipc/plugins';
import { registerLiveSlotIpcHandlers } from '@main/plugins/slots';
import { createHostAgentTools, type AgentCustomTool } from '@main/agent-tools';
import { PermissionService, installPermissionGate, registerPermissionIpc } from '@main/permissions';
import { AskService, registerAskIpc } from '@main/asks';
import { TodoService, registerTodoIpc } from '@main/todos';
import { ToolSettingsService, registerToolSettingsIpc } from '@main/preferences/tools';
import { StorageService, registerStorageIpc, applyStorageSettings } from '@main/storage';
import { VoiceSettingsService } from '@main/voice/settings';
import { resolveVoiceProvider } from '@main/voice/registry';
import { registerVoiceIpc, warmLocalTts } from '@main/voice/ipc';
import { installMicrophonePermissionHandler } from '@main/voice/permissions';
import { VoiceModelManager } from '@main/voice/builtin/model-manager';
import { voiceInference } from '@main/voice/builtin/inference-client';
import { buildToolCatalog } from '@main/tools/catalog';
import { installToolContractGate } from '@main/tools/contracts';
import { windows } from '@main/windows';
import { WindowStateStore } from '@main/window-state';
import { installApplicationMenu } from '@main/menu';
import type { ToolCatalogEntry } from '@pi/types';

/**
 * Product name — one source of truth for what the OS calls this app.
 *
 * Must run before anything touches `app.getPath('userData')`, which is derived
 * from the name. Without it a development run is literally "Electron" (that is
 * the bundle being executed): Dock tooltip, app menu, userData folder.
 */
app.setName(APP_NAME);

/**
 * Electron derives userData from the app name, so renaming the product would
 * silently move it — every setting, the window layout and the permission
 * audit would look reset. Adopt the old directory once, before anything
 * reads the new one.
 *
 * Runs only while the new directory is still absent, so it can never overwrite
 * a live profile. Only the small config files come along: Chromium's caches
 * rebuild themselves, and copying them would stall startup for no gain.
 */
const LEGACY_USER_DATA_DIRS = ['Pi Coding Agent', '@pi/desktop'];
function adoptLegacySettings(): void {
  const appData = app.getPath('appData');
  const target = join(appData, APP_NAME);
  if (existsSync(target)) return;
  for (const legacy of LEGACY_USER_DATA_DIRS) {
    const source = join(appData, legacy);
    if (!existsSync(source)) continue;
    mkdirSync(target, { recursive: true });
    let adopted = 0;
    for (const name of readdirSync(source)) {
      if (!/\.(json|jsonl)$/.test(name)) continue;
      copyFileSync(join(source, name), join(target, name));
      adopted += 1;
    }
    console.log(`[userData] adopted ${adopted} file(s) from ${source}`);
    return;
  }
}
adoptLegacySettings();

// Settings → 存储 may have moved the agent's data directory. The SDK reads
// `PI_CODING_AGENT_DIR` on every `getAgentDir()` call, but the plugin registry
// captures the path when it is constructed — so the choice must be in the
// environment before startup reaches any of that.
applyStorageSettings();

// Enable Chrome DevTools Protocol so external tooling (Playwright, DevTools)
// can connect to the app's own webContents (including the embedded browser
// view) via CDP. Sibling forks of this project bind the same default port —
// PI_CDP_PORT lets a dev run step aside instead of silently losing the race.
// `||` not `??`: an empty-string env var (a common shell-script accident)
// must fall back to 19222, not hand Chromium an unbindable empty port.
app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_CDP_PORT || '19222');

// Contract-level plugin isolation: force every site (each pi-plugin:// origin)
// into its own renderer process. Site isolation is Chromium's default, but
// this pins it as a launch guarantee — plugin UI can never share a renderer
// with the host shell regardless of future policy drift.
// app.commandLine.appendSwitch('site-per-process'); // TEMP: 因果实验

// Prevent Chromium from culling the embedded browser view's compositor surface.
// Without these switches, Chromium's window-occlusion detector and
// background-throttler incorrectly mark the view as occluded
// after certain page navigations (notably zhipin.com's anti-bot
// triggered sub-frame loads). The GPU process then fails to produce
// compositor overlays ("Invalid mailbox" / "non-existent mailbox"
// errors in skia_output_device_buffer_queue.cc and
// shared_image_manager.cc), leaving the view permanently white
// while the underlying webContents still renders correctly.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

// Every process needs the browser's UA, not just the tab: cross-site iframes
// take theirs from this app-wide fallback, so without it Cloudflare's challenge
// widget saw "@pi/desktop/0.1.0 … Electron/38.8.6" while the top page claimed
// Chrome — a mismatch that marks the client as automation and leaves the
// "verify you are human" box spinning forever. Set before any window exists.
app.userAgentFallback = ENGINE_UA;

const gotLock = app.requestSingleInstanceLock();

// Register the plugin scheme BEFORE app ready — every plugin panel is served
// from a unique `pi-plugin://<pluginId>/` origin (process isolation via site
// isolation; see src/main/plugins/protocol.ts).
registerPluginSchemePrivileges();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    windows.handleLaunchArgs(argv, { secondInstance: true });
  });

  app.whenReady().then(async () => {
    // A dev run has no app bundle, so the Dock shows Electron's own icon.
    // Packaged builds get theirs from the bundle — nothing to do there.
    if (!app.isPackaged) {
      const icon = join(app.getAppPath(), 'build/icon.png');
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }

    const settingsManager = SettingsManager.create(app.getPath('home'));

    // Shared ModelRegistry — used by the chat service and the browser walk
    // planner's VLM analyzer.
    const sharedModelRegistry = ModelRegistry.create(AuthStorage.inMemory());
    // VLM analyzer for goal-directed browser navigation (gracefully handles
    // missing VLM config).
    const vlmAnalyzer = new VlmAnalyzer(sharedModelRegistry, { timeoutMs: 15000 });

    injectBundledShell(settingsManager);

    // Handlers the renderer calls during its first paint must exist before
    // any window loads: a packaged build loads file:// in milliseconds and
    // would otherwise hit "No handler registered" on its first invoke.
    registerNativeIpcHandlers(windows);
    registerWindowIpcHandlers(windows);
    registerLiveSlotIpcHandlers({
      forSender: (wc) => windows.byWebContents(wc)?.liveSlots,
    });

    /**
     * Renderer push routed to the window that owns the conversation.
     *
     * A session can be shown in one window while its run was started in that
     * same window (the claim protocol), or — after a session switch — the run
     * belongs to the window that started it (`lastRunOwners`). Either way the
     * card must not land in an unrelated window, and must definitely not be
     * dropped just because the "main" window was closed.
     */
    const sendToSession = (sessionId: string | null | undefined, channel: string, payload: unknown) =>
      windows.sendToSession(sessionId, channel, payload);

    // Permission modes (默认 / 完全访问). Per-session choices live in main,
    // keyed by session; the last picked mode seeds every session with no
    // explicit choice, and a restart resets everything to 'default' — 完全访问
    // stays a per-run decision. High-risk calls in default mode block the
    // agent until the renderer's inline approval card answers; 完全访问 lets
    // everything through but leaves an audit line behind.
    const permissionService = new PermissionService(
      (payload) => sendToSession(payload.sessionId, 'pi:permission:request', payload),
      (payload) => sendToSession(payload.sessionId, 'pi:permission:cancelled', payload),
    );
    registerPermissionIpc(permissionService, windows);
    const permissionModeFor = (sessionId: string) => permissionService.getMode(sessionId);

    // ── Agent interaction tools (todotool / asktool) ──
    // Both hold state that outlives a single tool call: the checklist survives
    // a renderer reload, and an unanswered question holds the agent turn open
    // until the user answers or the turn aborts. Neither can live in a plugin
    // process (fixed RPC timeout, no cancellation, no abort forwarding).
    const todoService = new TodoService(
      join(app.getPath('userData'), 'agent-todos.json'),
      (snapshot) => sendToSession(snapshot.sessionId, 'pi:todo:changed', snapshot),
    );
    registerTodoIpc(todoService);

    const askService = new AskService({
      sendRequest: (payload) => sendToSession(payload.sessionId, 'pi:ask:request', payload),
      sendCancelled: (payload) => sendToSession(payload.sessionId, 'pi:ask:cancelled', payload),
    });
    registerAskIpc(askService, windows);

    // Tool availability (Settings → 工具). Main-authoritative and read when a
    // session is created, so a switched-off tool is filtered before the model
    // ever sees it. Sessions rebuild lazily on the next send (the adapter
    // compares the list) rather than being cleared here — clearing the cache
    // mid-stream would let a steer build a second writer on the same
    // transcript.
    let toolCatalog: ToolCatalogEntry[] = [];
    const toolSettings = new ToolSettingsService(
      join(app.getPath('userData'), 'tool-settings.json'),
      join(app.getPath('userData'), 'interaction-settings.json'),
    );
    registerToolSettingsIpc(toolSettings, () => toolCatalog);

    // Storage (设置 → 存储): sizes and the agent data directory. The location
    // itself was already applied at the top of this file, before startup.
    registerStorageIpc(new StorageService(app.getPath('userData')));

    // Voice (设置 → 语音): provider list + preferences in userData/voice.json.
    // Vendor calls happen in main and local inference in a utility process;
    // the renderer only records, encodes WAV and plays back audio, so vendor
    // keys never enter the renderer and `connect-src` stays 'self'.
    const voiceSettings = new VoiceSettingsService(join(app.getPath('userData'), 'voice.json'));
    const voiceModels = new VoiceModelManager(
      join(app.getPath('userData'), 'voice-models'),
      { onDeleted: (id) => voiceInference.evict(id) },
    );
    void voiceModels.cleanupParts();
    // Filled in once the plugin kernel exists; voice playback state is routed
    // back to plugin backends as the `voice.playback` host event.
    let pluginPlaybackHook: (key: string, playing: boolean) => void = () => undefined;
    registerVoiceIpc(voiceSettings, voiceModels, {
      onPluginPlayback: (key, playing) => pluginPlaybackHook(key, playing),
    });
    installMicrophonePermissionHandler(windows);
    // Warm the local TTS session after the window is up, so the first click on
    // 朗读 does not pay the model-load cost.
    setTimeout(() => warmLocalTts(voiceSettings, voiceModels), 3000);

    // Now that every handler the renderer's boot sequence touches exists,
    // reopen the windows from the previous run (VS Code's `restoreWindows:
    // all` behaviour). Each window's geometry is validated against the
    // displays that exist now. With no saved state, one default window.
    windows.attachStateStore(new WindowStateStore());
    if (windows.restoreWindows() === 0) {
      windows.create({ ...(windows.lastState ?? {}) });
    }

    // Plugin kernel: scan ~/.pi/agent/plugins (plus the dev root when set),
    // spawn backend UtilityProcesses, serve pi-plugin:// and expose IPC.
    // Created BEFORE the SDK IPC handlers so plugin tools can be injected
    // into the agent session (customTools).
    //
    // Backends stay process-global (one per plugin); what became per-window
    // is the browser engine and the panel views. `browserRouter` picks the
    // window a `browser.*` call runs against, and `eventSink` decides which
    // window a plugin event is shown in.
    // Session → workspace, recorded when the session is built: its cwd IS the
    // workspace id (`Workspace.id` is the absolute path). Plugin backends use
    // it to attribute writes to a project. NOT `windows.forSession()`: that
    // answers "which window shows this now", and a window may switch workspace
    // while a run is in flight — the run would land in the new project.
    const sessionWorkspaces = new Map<string, string>();
    const homeCwd = app.getPath('home');
    const rememberSessionWorkspace = (sessionKey: string, cwd: string | undefined): void => {
      if (!sessionKey || sessionKey === 'default') return;
      // The chat adapter falls back to the home directory when a send carries
      // no workspaceCwd. Home is not a workspace; recording it would attribute
      // those writes to a project that does not exist, so they stay "global".
      if (!cwd || cwd === homeCwd) {
        sessionWorkspaces.delete(sessionKey);
        return;
      }
      sessionWorkspaces.set(sessionKey, cwd);
    };
    const resolveSessionWorkspace = (sessionId?: string): string | null =>
      sessionId && sessionId !== 'default' ? (sessionWorkspaces.get(sessionId) ?? null) : null;

    const pluginSystem = new PluginSystem({
      browserRouter: windows,
      vlmAnalyzer,
      resolveSessionWorkspace,
      // chat.send: relay a plugin's message to the renderer, which owns the
      // composer. A payload naming a workspace goes to the window showing that
      // workspace — a scheduled reminder must not inject into whichever window
      // happens to be focused, or the agent writes its follow-up into the
      // wrong project.
      sendToRenderer: (channel, payload) => {
        const workspaceId =
          payload && typeof payload === 'object'
            ? (payload as { workspaceId?: unknown }).workspaceId
            : undefined;
        if (typeof workspaceId === 'string' && workspaceId) {
          windows.sendToWorkspace(workspaceId, channel, payload);
          return;
        }
        windows.sendToFocused(channel, payload);
      },
      getPermissionMode: (sessionId) => permissionModeFor(sessionId),
      // Plugins may ask the shell to read text aloud (manifest permission:
      // voice). Refuse early with the resolver's own Chinese error when no
      // provider/model is configured.
      voiceReady: () => {
        try {
          resolveVoiceProvider(voiceSettings.get(), 'tts', undefined, {
            isModelInstalled: (id) => voiceModels.isInstalled(id),
            modelRoot: voiceModels.root,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      eventSink: {
        broadcast: (channel, payload) => windows.broadcast(channel, payload),
        sendToSession: (sessionId, channel, payload) => windows.sendToSession(sessionId, channel, payload),
        sendToFocused: (channel, payload) => windows.sendToFocused(channel, payload),
      },
    });
    pluginPlaybackHook = (key, playing) =>
      pluginSystem.pushHostEvent('voice.playback', 'voice', { key, playing });
    // Register IPC handlers BEFORE init completes — the file:// renderer loads
    // in milliseconds in packaged builds, and its first `pi:plugin:list` must
    // queue behind kernel boot (whenReady) instead of rejecting outright.
    registerPluginIpcHandlers(pluginSystem, windows);

    // Host-contributed tools are built after the chat service exists, but the
    // provider is only *called* when a session is created — so the array is
    // filled in below and read through this closure.
    let hostTools: AgentCustomTool[] = [];

    const { chatService } = registerIpcHandlers(settingsManager, sharedModelRegistry, {
      // The full set; the per-session allow/deny decision is applied by the
      // adapter through `excludedToolNames`, which covers built-ins too.
      customToolsProvider: () => [...hostTools, ...pluginSystem.aggregateTools()],
      getGlobalDisabledTools: () => toolSettings.getDisabled(),
      pluginDocsProvider: () => pluginSystem.listPluginDocs(),
      onSessionCreated: (session, info) => {
        rememberSessionWorkspace(info.sessionKey, info.cwd);
        installPermissionGate(session, info.sessionKey, permissionService);
        // Tool contracts (output bounds, image filtering, error prefix) are a
        // separate afterToolCall wrapper; it must run under the same session
        // key as the permission gate.
        installToolContractGate(session, info.sessionKey);
      },
      // Deleting a conversation must also settle anything it is blocked on;
      // otherwise the run, the pending promise and the card outlive the file.
      onSessionDeleted: (sessionId) => {
        sessionWorkspaces.delete(sessionId);
        askService.cancelSession(sessionId);
        todoService.remove(sessionId);
        windows.releaseActiveSession(sessionId);
      },
    });
    // A plugin write/delete may have changed a .pi prompt file or an AGENTS.md
    // the agent already loaded. Rebuild the affected live sessions so the save
    // applies to the next turn instead of waiting for a new session.
    pluginSystem.onContextFileWrite = (filePath) => {
      void chatService.reloadAgentContextForFile(filePath).catch((err) => {
        console.error('[agent-context] reload after file write failed:', err);
      });
    };

    hostTools = createHostAgentTools({
      readContextConfig: chatService.getAgentContextConfig.bind(chatService),
      todoService,
      askService,
      resolveWorkspace: (sessionId) => {
        const ctx = windows.forSession(sessionId) ?? windows.focused();
        if (!ctx?.workspacePath) return null;
        return { id: ctx.workspaceId ?? ctx.workspacePath, path: ctx.workspacePath };
      },
    });

    // Plugin kernel boot. The SDK IPC handlers above are already live, so a
    // fast file:// renderer never sees a missing handler while backends spawn.
    await pluginSystem.init();

    // Every window gets its own panel views now; windows created later get
    // theirs inside WindowRegistry.create().
    windows.bindPlugins(pluginSystem);

    // A reused panel view never re-requests its backend port (its page did not
    // reload), so each window pushes a fresh pair whenever a backend
    // (re)starts — disable→enable, install, rollback, crash restart.
    pluginSystem.onBackendStarted = (pluginId) => {
      for (const ctx of windows.all()) {
        ctx.pluginWebViews?.rewirePluginPorts(pluginId, (wc) => {
          pluginSystem.ensureUiPort(pluginId, wc);
        });
      }
    };

    // ── Window focus / close policy ──
    // Plugin backends see one "current conversation": the focused window's.
    // Closing a window must not leave agents blocked on cards nobody will see;
    // it aborts/cancels only sessions no other window still holds.
    windows.setHooks({
      onFocus: (ctx) => {
        const sessionId = ctx?.activeSessionId ?? null;
        pluginSystem.setActiveSession(sessionId);
        pluginSystem.pushHostEvent('session.changed', undefined, { sessionId });
      },
      onClosed: (ctx, sessions) => {
        for (const sessionId of sessions) {
          if (windows.hasOtherOwner(sessionId, ctx.windowId)) continue;
          permissionService.cancelSession(sessionId);
          askService.cancelSession(sessionId);
          void chatService.stopGeneration(sessionId).catch(() => {});
        }
      },
    });
    // The hooks were registered after the first window focused; seed the
    // backend session now so a freshly spawned backend learns it.
    const focusedCtx = windows.focused();
    pluginSystem.setActiveSession(focusedCtx?.activeSessionId ?? null);

    const refreshToolCatalog = () => {
      toolCatalog = buildToolCatalog(
        hostTools,
        pluginSystem.aggregateTools(),
        (pluginId) =>
          pluginId ? pluginSystem.registry.get(pluginId)?.manifest.name : undefined,
      );
    };
    refreshToolCatalog();
    // The renderer may have fetched the catalog before plugin boot finished
    // (the IPC handler is registered early to avoid a "no handler" race), so
    // announce the now-complete list and let every window re-sync.
    windows.broadcast('pi:tools:changed', {});

    // Plugin tool/doc set changed at runtime → rebuild agent sessions and the
    // tool catalog, and pick up panels of plugins that were just installed.
    // Every window syncs: each one hosts its own panel views.
    pluginSystem.onExtensionsChanged = () => {
      for (const ctx of windows.all()) ctx.pluginWebViews?.sync();
      refreshToolCatalog();
      windows.broadcast('pi:tools:changed', {});
      chatService.invalidateSessions?.();
    };

    installApplicationMenu(windows);

    // Window geometry must be written before the windows start closing:
    // destroying the last one would leave the state file empty and the next
    // launch would open a single blank window.
    //
    // The browser's auth cookies are session cookies, which Chromium keeps in
    // memory only. Give the cookie flush one more chance on quit, but never
    // let a hung cookie store block the app from exiting.
    let quitCookiesFlushed = false;
    app.on('before-quit', (event) => {
      windows.prepareToQuit();
      if (quitCookiesFlushed) return;
      quitCookiesFlushed = true;
      event.preventDefault();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      void Promise.race([
        persistBrowserSessionCookies().then(() => undefined),
        timeout,
      ])
        .catch((err) => {
          console.warn('[browser-session] quit persist failed:', err instanceof Error ? err.message : err);
        })
        .finally(() => app.quit());
    });

    app.on('will-quit', () => {
      // The todo write is debounced; without this, quitting right after the
      // last todotool call (or a switch flip) loses that update.
      todoService.flushSync();
      toolSettings.flushSync();
      voiceSettings.flushSync();
      voiceInference.dispose();
      pluginSystem.dispose();
    });

    app.on('activate', () => {
      if (windows.all().length === 0) {
        if (windows.restoreWindows() === 0) windows.create({ ...(windows.lastState ?? {}) });
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * On Windows, detect the bundled MinGit environment (shipped as
 * extraResources) and configure SettingsManager to use it.
 *
 * Standard MinGit provides:
 *   - bash.exe (GNU Bash 4.x)             → set as shellPath (preferred)
 *   - ash.exe (BusyBox POSIX shell)       → fallback if bash.exe is missing
 *   - git.exe                            → added to PATH
 *   - GNU coreutils (ls, cat…)           → added to PATH
 *
 * This is a no-op on macOS and Linux, where the OS ships a shell natively.
 */
function injectBundledShell(settingsManager: SettingsManager): void {
  if (process.platform !== 'win32') return;

  // process.resourcesPath → app's resources directory.
  // The bundled shell is at resources/bash-bundle/ (from extraResources).
  const bundleRoot = join(process.resourcesPath, 'bash-bundle');

  // BusyBox MinGit ships ash.exe (POSIX sh, limited but functional) next to
  // busybox.exe. MinGit ≤2.55 lays this out under mingw64/bin/; 2.56+ moved
  // to ucrt64/bin/ — search both, plus the generic locations.
  const shellNames = ['bash.exe', 'ash.exe'];
  const binDirs = ['mingw64/bin', 'ucrt64/bin', 'bin', 'usr/bin'].map((d) => join(bundleRoot, d));

  let shellPath: string | null = null;
  for (const dir of binDirs) {
    for (const name of shellNames) {
      const p = join(dir, name);
      if (existsSync(p)) { shellPath = p; break; }
    }
    if (shellPath) break;
  }

  if (!shellPath) {
    console.warn('[bash-bundle] No bundled shell found. Falling back to system Git Bash search.');
    // Bundled shell not found. SDK will fall back to searching for Git
    // Bash on the system, then show a clear error if nothing is found.
    return;
  }

  // Integrity check: warn (but proceed) if git.exe is missing — the agent
  // can still run bash commands, but git operations will fail.
  const gitCandidates = ['mingw64/bin', 'ucrt64/bin', 'cmd'].map((d) => join(bundleRoot, d, 'git.exe'));
  const gitExe = gitCandidates.find((p) => existsSync(p));
  if (!gitExe) {
    console.warn(`[bash-bundle] git.exe not found (searched ${gitCandidates.join(', ')}). Git operations may fail.`);
  }

  console.log(`[bash-bundle] Using shell: ${shellPath}`);
  settingsManager.setShellPath(shellPath);

  // Add bundled bin dirs to PATH so git, coreutils, and msys-2.0.dll
  // can be found. On MSYS2, Windows paths are mapped as:
  //   C:\foo\bar → /c/foo/bar
  const pathDirs = [
    join(bundleRoot, 'mingw64', 'bin'),
    join(bundleRoot, 'ucrt64', 'bin'),
    join(bundleRoot, 'usr', 'bin'),
    join(bundleRoot, 'cmd'),
    join(bundleRoot, 'bin'),
  ].filter((p) => existsSync(p));

  if (pathDirs.length > 0) {
    const unixPaths = pathDirs.map((p) =>
      '/' + p.replace(/^([A-Z]):/i, (_, d) => d.toLowerCase()).replace(/\\/g, '/'),
    );
    settingsManager.setShellCommandPrefix(
      `export PATH="${unixPaths.join(':')}:$PATH"`,
    );
  }
}
