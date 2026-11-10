import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BuiltinModelId,
  ImportFilesResult,
  SaveAttachmentInput,
  SavedAttachment,
  VoiceBuiltinModel,
  VoiceCapability,
  VoiceModelProgress,
  VoicePreferencesPatch,
  VoiceProviderEntry,
  VoiceSettings,
  VoiceSynthesizeRequest,
  VoiceSynthesizeResult,
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
} from '@pi/types';

/** `--pi-window-id=<n>` is injected per BrowserWindow via additionalArguments. */
function readWindowId(): number | null {
  const hit = process.argv.find((arg) => arg.startsWith('--pi-window-id='));
  if (!hit) return null;
  const id = Number(hit.slice('--pi-window-id='.length));
  return Number.isFinite(id) ? id : null;
}

export interface ElectronAPI {
  /**
   * This window's registry id (null outside the desktop shell). Two windows
   * of the same app are separate renderers with separate state; this is the
   * only fact that tells them apart.
   */
  windowId: number | null;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;

  // ── Window Management ──
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    /** Open a new window on this window's workspace, with a fresh session. */
    newWindow: () => Promise<{ ok: boolean; windowId?: number }>;
    /** Open a workspace: focuses the window already showing it unless `forceNew`. */
    openWorkspace: (
      workspaceId: string,
      options?: { forceNew?: boolean },
    ) => Promise<{ ok: boolean; windowId?: number; focusedExisting?: boolean }>;
    /** True when another window already shows this workspace (and was focused). */
    focusWorkspaceElsewhere: (workspaceId: string) => Promise<{ focused: boolean }>;
    openSession: (
      sessionId: string,
      workspaceId: string,
    ) => Promise<{ ok: boolean; windowId?: number; ownerWindowId?: number; error?: string }>;
    /**
     * Claim a conversation for this window. `{ok:false, ownerWindowId}` means
     * another window already shows it and has been focused — do not switch.
     */
    activateSession: (
      sessionId: string | null,
    ) => Promise<{ ok: boolean; ownerWindowId?: number; error?: string }>;
    /** This window's view state, as main remembers it. */
    context: () => Promise<{ windowId: number; workspaceId: string | null; sessionId: string | null } | null>;
  };

  /**
   * Window-chrome facts the renderer's title bar needs. Exposed explicitly so
   * the shared UI never has to sniff the user agent.
   */
  chrome: {
    platform: 'darwin' | 'win32' | 'linux';
    /** px reserved on the left for native controls (macOS traffic lights). */
    insetLeft: number;
    /** px reserved on the right for native controls (Windows caption buttons). */
    insetRight: number;
    /** Host draws its own minimize/maximize/close (Linux frameless). */
    customControls: boolean;
  };

  // ── Dialogs ──
  dialog: {
    openFile: (options?: Record<string, unknown>) => Promise<Electron.OpenDialogReturnValue>;
    openDirectory: (options?: Record<string, unknown>) => Promise<Electron.OpenDialogReturnValue>;
    saveFile: (options?: Record<string, unknown>) => Promise<Electron.SaveDialogReturnValue>;
  };

  // ── File System ──
  fs: {
    readFile: (path: string) => Promise<{ content: string; path: string }>;
    writeFile: (path: string, content: string) => Promise<{ success: boolean; path: string }>;
    readFileBuffer: (path: string) => Promise<{ buffer: ArrayBuffer; path: string }>;
    writeFileBuffer: (path: string, buffer: ArrayBuffer) => Promise<{ success: boolean; path: string }>;
    stat: (path: string) => Promise<FileStat>;
    exists: (path: string) => Promise<boolean>;
    mkdir: (path: string) => Promise<{ success: boolean; path: string }>;
    listDir: (path: string) => Promise<DirEntry[]>;
    delete: (path: string) => Promise<{ success: boolean }>;
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; path: string }>;
    /**
     * Absolute path of a `File` from an OS drop. Electron 32 removed
     * `File.path`; this is the supported replacement and must run in the
     * preload. JavaScript-constructed files yield '' — callers filter those.
     */
    pathForFile: (file: File) => string;
    /** Copy OS-dropped paths into this window's workspace root. */
    importFiles: (sources: string[]) => Promise<ImportFilesResult>;
    /**
     * Copy a composer attachment into the workspace
     * (`.piwork/attachments/`), returning the path the chat and the model use.
     */
    saveAttachment: (input: SaveAttachmentInput) => Promise<SavedAttachment>;
  };

  // ── Shell ──
  shell: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
  };

  // ── Clipboard ──
  clipboard: {
    write: (text: string) => Promise<void>;
    read: () => Promise<string>;
    writeImage: (path: string) => Promise<void>;
    clear: () => Promise<void>;
  };

  // ── App ──
  app: {
    getPath: (name: string) => Promise<string>;
    getVersion: () => Promise<string>;
  };

  // ── Voice ──
  // Provider config stays in main (userData/voice.json) and outbound requests
  // are made there; the renderer only records audio and plays the result.
  voice: {
    get: () => Promise<VoiceSettings>;
    saveProvider: (
      capability: VoiceCapability,
      originalName: string | null,
      name: string,
      provider: VoiceProviderEntry,
    ) => Promise<VoiceSettings>;
    deleteProvider: (capability: VoiceCapability, name: string) => Promise<VoiceSettings>;
    setPreferences: (
      capability: VoiceCapability,
      patch: VoicePreferencesPatch,
    ) => Promise<VoiceSettings>;
    transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscribeResult>;
    synthesize: (request: VoiceSynthesizeRequest) => Promise<VoiceSynthesizeResult>;
    cancelSynthesis: (generation?: number) => Promise<void>;
    notifyPlayback: (key: string, playing: boolean) => Promise<void>;
    getModels: () => Promise<VoiceBuiltinModel[]>;
    downloadModel: (modelId: BuiltinModelId) => Promise<VoiceBuiltinModel[]>;
    cancelModelDownload: (modelId: BuiltinModelId) => Promise<void>;
    deleteModel: (modelId: BuiltinModelId) => Promise<VoiceBuiltinModel[]>;
    onModelProgress: (callback: (progress: VoiceModelProgress) => void) => () => void;
  };

  // ── Plugin System ──
  // (exposed as a separate `window.pluginBridge` global — see bottom of file)
}

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ctime: string;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

const electronAPI: ElectronAPI = {
  windowId: readWindowId(),
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void): void => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  removeListener: (channel: string, callback: (...args: unknown[]) => void): void => {
    ipcRenderer.removeListener(channel, callback);
  },
  window: {
    minimize: () => ipcRenderer.invoke('pi:window:minimize'),
    maximize: () => ipcRenderer.invoke('pi:window:maximize'),
    close: () => ipcRenderer.invoke('pi:window:close'),
    isMaximized: () => ipcRenderer.invoke('pi:window:isMaximized'),
    newWindow: () => ipcRenderer.invoke('pi:window:new'),
    openWorkspace: (workspaceId: string, options?: { forceNew?: boolean }) =>
      ipcRenderer.invoke('pi:window:open-workspace', {
        workspaceId,
        forceNew: options?.forceNew === true,
      }),
    focusWorkspaceElsewhere: (workspaceId: string) =>
      ipcRenderer.invoke('pi:window:focus-workspace', { workspaceId }),
    openSession: (sessionId: string, workspaceId: string) =>
      ipcRenderer.invoke('pi:window:open-session', { sessionId, workspaceId }),
    activateSession: (sessionId: string | null) =>
      ipcRenderer.invoke('pi:window:activate-session', { sessionId }),
    context: () => ipcRenderer.invoke('pi:window:context'),
  },

  chrome: {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    // macOS traffic lights float over the top-left of a hiddenInset window.
    insetLeft: process.platform === 'darwin' ? 78 : 0,
    // Windows caption buttons are drawn by titleBarOverlay on the right.
    insetRight: process.platform === 'win32' ? 138 : 0,
    customControls: process.platform === 'linux',
  },

  dialog: {
    openFile: (options) => ipcRenderer.invoke('pi:dialog:openFile', options),
    openDirectory: (options) => ipcRenderer.invoke('pi:dialog:openDirectory', options),
    saveFile: (options) => ipcRenderer.invoke('pi:dialog:saveFile', options),
  },

  fs: {
    readFile: (p) => ipcRenderer.invoke('pi:fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('pi:fs:writeFile', p, content),
    readFileBuffer: (p) => ipcRenderer.invoke('pi:fs:readFileBuffer', p),
    writeFileBuffer: (p, buf) => ipcRenderer.invoke('pi:fs:writeFileBuffer', p, buf),
    stat: (p) => ipcRenderer.invoke('pi:fs:stat', p),
    exists: (p) => ipcRenderer.invoke('pi:fs:exists', p),
    mkdir: (p) => ipcRenderer.invoke('pi:fs:mkdir', p),
    listDir: (p) => ipcRenderer.invoke('pi:fs:listDir', p),
    delete: (p) => ipcRenderer.invoke('pi:fs:delete', p),
    rename: (oldPath, newPath) => ipcRenderer.invoke('pi:fs:rename', oldPath, newPath),
    pathForFile: (file) => webUtils.getPathForFile(file),
    importFiles: (sources) => ipcRenderer.invoke('pi:fs:importFiles', sources),
    saveAttachment: (input) => ipcRenderer.invoke('pi:fs:saveAttachment', input),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('pi:shell:openExternal', url),
    openPath: (p) => ipcRenderer.invoke('pi:shell:openPath', p),
    showItemInFolder: (p) => ipcRenderer.invoke('pi:shell:showItemInFolder', p),
  },

  clipboard: {
    write: (text) => ipcRenderer.invoke('pi:clipboard:write', text),
    read: () => ipcRenderer.invoke('pi:clipboard:read'),
    writeImage: (p) => ipcRenderer.invoke('pi:clipboard:writeImage', p),
    clear: () => ipcRenderer.invoke('pi:clipboard:clear'),
  },

  app: {
    getPath: (name) => ipcRenderer.invoke('pi:app:getPath', name),
    getVersion: () => ipcRenderer.invoke('pi:app:getVersion'),
  },

  voice: {
    get: () => ipcRenderer.invoke('pi:voice:get'),
    saveProvider: (capability, originalName, name, provider) =>
      ipcRenderer.invoke('pi:voice:save-provider', { capability, originalName, name, provider }),
    deleteProvider: (capability, name) =>
      ipcRenderer.invoke('pi:voice:delete-provider', { capability, name }),
    setPreferences: (capability, patch) =>
      ipcRenderer.invoke('pi:voice:set-preferences', { capability, patch }),
    transcribe: (request) => ipcRenderer.invoke('pi:voice:transcribe', request),
    synthesize: (request) => ipcRenderer.invoke('pi:voice:synthesize', request),
    cancelSynthesis: (generation) =>
      ipcRenderer.invoke('pi:voice:cancel-synthesis', { generation }),
    notifyPlayback: (key, playing) =>
      ipcRenderer.invoke('pi:voice:plugin-playback', { key, playing }),
    getModels: () => ipcRenderer.invoke('pi:voice:get-models'),
    downloadModel: (modelId) => ipcRenderer.invoke('pi:voice:download-model', { modelId }),
    cancelModelDownload: (modelId) =>
      ipcRenderer.invoke('pi:voice:cancel-model-download', { modelId }),
    deleteModel: (modelId) => ipcRenderer.invoke('pi:voice:delete-model', { modelId }),
    onModelProgress: (callback) => {
      const listener = (_event: unknown, progress: VoiceModelProgress) => callback(progress);
      ipcRenderer.on('pi:voice:model-progress', listener);
      return () => ipcRenderer.removeListener('pi:voice:model-progress', listener);
    },
  },

};

// ── Plugin System bridge ──────────────────────────────────────────────
// Exposed as its own `window.pluginBridge` global. UI data-plane
// MessagePorts live in this (isolated) world — the main world only sees
// plain-JSON relays through contextBridge.
interface PortLike {
  on(event: 'message', listener: (ev: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

const pluginBridge = (() => {
  const pluginPorts = new Map<string, PortLike>();
  // Messages sent before a port arrives are buffered and flushed on arrival.
  const outbox = new Map<string, unknown[]>();
  let messageCallback: ((pluginId: string, payload: unknown) => void) | null = null;
  let eventCallback: ((event: unknown) => void) | null = null;

  ipcRenderer.on('pi:plugin:port', (event, meta: { pluginId: string }) => {
    const port = (event.ports as unknown as PortLike[] | undefined)?.[0];
    if (!port) return;
    // Replace any previous port for this plugin (fresh pair per ensurePort).
    const old = pluginPorts.get(meta.pluginId);
    if (old) old.close();

    const onPortMessage = (ev: { data: unknown }) => {
      messageCallback?.(meta.pluginId, ev.data);
    };
    if (typeof port.on === 'function') {
      // Electron (EventEmitter-style) MessagePort
      port.on('message', onPortMessage);
      port.start();
    } else {
      // DOM-style MessagePort (isolated world): onmessage auto-starts
      (port as unknown as { onmessage: typeof onPortMessage }).onmessage = onPortMessage;
    }
    pluginPorts.set(meta.pluginId, port);

    // Flush messages queued while the port was in flight (e.g. a panel's
    // initial "mounted" event sent right after ensurePort).
    const queued = outbox.get(meta.pluginId);
    outbox.delete(meta.pluginId);
    for (const payload of queued ?? []) {
      try { port.postMessage(payload); } catch (e) { console.log('[preload] flush FAILED:', String(e).slice(0, 80)); }
    }
  });

  ipcRenderer.on('pi:plugin:event', (_event, evt) => eventCallback?.(evt));

  return {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list'),
    listAll: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list-all'),
    ensurePort: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:ensure-port', { pluginId }),
    executeCommand: (pluginId: string, name: string, args?: string): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:execute-command', { pluginId, name, args }),
    market: {
      catalog: (force?: boolean): Promise<{ ok: boolean; plugins: unknown[]; error?: string; registryUrl?: string }> =>
        ipcRenderer.invoke('pi:plugin:market:catalog', { force }),
      install: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:market:install', { pluginId }),
      uninstall: (pluginId: string, keepData?: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:uninstall', { pluginId, keepData }),
      rollback: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:rollback', { pluginId }),
      setEnabled: (pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:set-enabled', { pluginId, enabled }),
    },
    findPreview: (path: string): Promise<{ panelId: string | null }> =>
      ipcRenderer.invoke('pi:plugin:find-preview', { path }),
    collectContext: (message: string): Promise<{ ok: boolean; sections: string[] }> =>
      ipcRenderer.invoke('pi:plugin:collect-context', { message }),
    getSettings: (pluginId: string): Promise<{ ok: boolean; settings?: Record<string, unknown>; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:get-settings', { pluginId }),
    setSetting: (pluginId: string, key: string, value: unknown): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:set-setting', { pluginId, key, value }),
    listTools: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list-tools'),
    messages: {
      muted: (): Promise<string[]> => ipcRenderer.invoke('pi:plugin:messages:muted'),
      setMuted: (
        pluginId: string,
        muted: boolean,
      ): Promise<{ ok: boolean; muted?: string[]; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:messages:set-muted', { pluginId, muted }),
    },
    executeTool: (pluginId: string, name: string, params?: Record<string, unknown>): Promise<{ ok: boolean; content?: unknown[]; details?: unknown; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:execute-tool', { pluginId, name, params }),
    send: (pluginId: string, payload: unknown): void => {
      const port = pluginPorts.get(pluginId);
      if (port) {
        port.postMessage(payload);
      } else {
        // No port yet (ensurePort in flight) — buffer until it arrives.
        const queue = outbox.get(pluginId) ?? [];
        queue.push(payload);
        outbox.set(pluginId, queue);
      }
    },
    onMessage: (callback: (pluginId: string, payload: unknown) => void): void => {
      messageCallback = callback;
    },
    onEvent: (callback: (event: unknown) => void): void => {
      eventCallback = callback;
    },
    /** Hand the shell's theme tokens to main, which fans them out to plugin views. */
    setTheme: (tokens: Record<string, string>): void => {
      ipcRenderer.send('pi:plugin:set-theme', tokens);
    },
  };
})();

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('pluginBridge', pluginBridge);
