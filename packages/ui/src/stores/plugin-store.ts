import { create } from 'zustand';
import type { InstallPhase, MarketEntry, PluginEvent, PluginInfo, PluginPanelStatus } from '@pi/types';
import { t } from '@/i18n';

/** Minimal typed view of the preload bridge (no-op on the web build). */
export interface PluginMarketBridge {
  catalog: (force?: boolean) => Promise<{ ok: boolean; plugins: MarketEntry[]; error?: string; registryUrl?: string }>;
  install: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
  uninstall: (pluginId: string, keepData?: boolean) => Promise<{ ok: boolean; error?: string }>;
  /** Put an upgraded plugin's previous version back. */
  rollback: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
}

interface PluginBridge {
  list: () => Promise<PluginInfo[]>;
  listAll: () => Promise<PluginInfo[]>;
  ensurePort: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
  executeCommand: (pluginId: string, name: string, args?: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  market: PluginMarketBridge;
  collectContext: (message: string) => Promise<{ ok: boolean; sections: string[] }>;
  getSettings: (pluginId: string) => Promise<Record<string, unknown>>;
  setSetting: (pluginId: string, key: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
  send: (pluginId: string, payload: unknown) => void;
  onMessage: (callback: (pluginId: string, payload: unknown) => void) => void;
  onEvent: (callback: (event: PluginEvent) => void) => void;
  /** Per-plugin "show plugin messages in conversations" (host-owned). */
  messages: {
    muted: () => Promise<string[]>;
    setMuted: (pluginId: string, muted: boolean) => Promise<{ ok: boolean; muted?: string[]; error?: string }>;
  };
  /** Hand the shell's theme tokens to main, which fans them out to plugin views. */
  setTheme?: (tokens: Record<string, string>) => void;
}

export function getPluginBridge(): PluginBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { pluginBridge?: PluginBridge }).pluginBridge ?? null;
}

export interface PluginStoreState {
  plugins: PluginInfo[];
  /** ALL installed plugins incl. disabled/incompatible (plugin center view). */
  installed: PluginInfo[];
  loaded: boolean;
  /** Latest panel status per plugin (agent activity linkage). */
  panelStatuses: Record<string, PluginPanelStatus>;
  /** Plugins whose messages are hidden from conversation timelines. */
  mutedPlugins: string[];

  // ── Marketplace ──
  catalog: MarketEntry[];
  catalogLoading: boolean;
  catalogError?: string;
  registryUrl?: string;
  /** Per-plugin install phase; undefined = idle. */
  installPhases: Record<string, InstallPhase>;
  marketErrors: Record<string, string | undefined>;

  loadPlugins: () => Promise<void>;
  /** Load the host's plugin-message mute list. */
  loadMutedPlugins: () => Promise<void>;
  /** Hide/show one plugin's messages in conversation timelines. */
  setPluginMuted: (pluginId: string, muted: boolean) => Promise<boolean>;
  loadCatalog: (force?: boolean) => Promise<void>;
  installPlugin: (pluginId: string) => Promise<boolean>;
  uninstallPlugin: (pluginId: string, keepData?: boolean) => Promise<boolean>;
  /**
   * Put an upgraded plugin's previous version back. Reusing `installPlugin` on
   * a broken update would only fetch the same broken version again.
   */
  rollbackPlugin: (pluginId: string) => Promise<boolean>;
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<boolean>;
  setInstallPhase: (pluginId: string, phase: InstallPhase | undefined) => void;
  collectPluginContext: (message: string) => Promise<string[]>;
  loadPluginSettings: (pluginId: string) => Promise<Record<string, unknown>>;
  setPluginSetting: (pluginId: string, key: string, value: unknown) => Promise<boolean>;
  executePluginCommand: (pluginId: string, name: string, args?: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  setPanelStatus: (status: PluginPanelStatus) => void;
}

async function refreshInstalled(set: (partial: Partial<PluginStoreState>) => void): Promise<void> {
  const bridge = getPluginBridge();
  if (!bridge) return;
  try {
    const [enabled, all] = await Promise.all([bridge.list(), bridge.listAll()]);
    set({ plugins: enabled ?? [], installed: all ?? [], loaded: true });
  } catch (err) {
    console.error('[plugin-store] refresh failed:', err);
  }
}

export const usePluginStore = create<PluginStoreState>()((set, get) => ({
  plugins: [],
  installed: [],
  loaded: false,
  panelStatuses: {},
  mutedPlugins: [],

  catalog: [],
  catalogLoading: false,
  installPhases: {},
  marketErrors: {},

  loadPlugins: async () => {
    const bridge = getPluginBridge();
    if (!bridge) {
      set({ loaded: true });
      return;
    }
    // The file:// renderer can boot faster than the main-process plugin
    // kernel registers its IPC handlers — retry briefly instead of caching
    // a failure (which would leave the panel rail without plugin panels).
    let plugins: PluginInfo[] | null = null;
    for (let attempt = 0; attempt < 5 && plugins === null; attempt++) {
      try {
        plugins = await bridge.list();
      } catch (err) {
        if (attempt === 4) console.error('[plugin-store] list failed:', err);
        else await new Promise((r) => setTimeout(r, 400));
      }
    }
    set({ plugins: plugins ?? [], loaded: true });
    await refreshInstalled(set);
    await get().loadMutedPlugins();
  },

  loadMutedPlugins: async () => {
    const bridge = getPluginBridge();
    if (!bridge) return;
    try {
      set({ mutedPlugins: (await bridge.messages.muted()) ?? [] });
    } catch (err) {
      console.error('[plugin-store] mute list failed:', err);
    }
  },

  setPluginMuted: async (pluginId, muted) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    try {
      const res = await bridge.messages.setMuted(pluginId, muted);
      if (res.ok) {
        set({ mutedPlugins: res.muted ?? [] });
        return true;
      }
      console.error('[plugin-store] set mute failed:', res.error);
      return false;
    } catch (err) {
      console.error('[plugin-store] set mute failed:', err);
      return false;
    }
  },

  loadCatalog: async (force = false) => {
    const bridge = getPluginBridge();
    if (!bridge) {
      set({ catalogError: t('当前环境不支持插件市场') });
      return;
    }
    set({ catalogLoading: true, catalogError: undefined });
    try {
      const res = await bridge.market.catalog(force);
      if (res.ok) {
        set({ catalog: res.plugins ?? [], registryUrl: res.registryUrl, catalogLoading: false });
      } else {
        set({ catalogError: res.error ?? t('加载失败'), catalogLoading: false });
      }
    } catch (err) {
      set({ catalogError: err instanceof Error ? err.message : String(err), catalogLoading: false });
    }
  },

  installPlugin: async (pluginId) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    set((s) => ({
      installPhases: { ...s.installPhases, [pluginId]: 'downloading' },
      marketErrors: { ...s.marketErrors, [pluginId]: undefined },
    }));
    const res = await bridge.market.install(pluginId);
    set((s) => {
      const phases = { ...s.installPhases };
      delete phases[pluginId];
      return {
        installPhases: phases,
        marketErrors: res.ok ? s.marketErrors : { ...s.marketErrors, [pluginId]: res.error },
      };
    });
    if (res.ok) {
      await get().loadPlugins();
      await get().loadCatalog(true);
    }
    return res.ok;
  },

  uninstallPlugin: async (pluginId, keepData = true) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    const res = await bridge.market.uninstall(pluginId, keepData);
    if (!res.ok && res.error) {
      set((s) => ({ marketErrors: { ...s.marketErrors, [pluginId]: res.error } }));
    }
    await get().loadPlugins();
    await get().loadCatalog(true);
    return res.ok;
  },

  rollbackPlugin: async (pluginId) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    const res = await bridge.market.rollback(pluginId);
    if (!res.ok && res.error) {
      set((s) => ({ marketErrors: { ...s.marketErrors, [pluginId]: res.error } }));
    }
    await get().loadPlugins();
    return res.ok;
  },

  setPluginEnabled: async (pluginId, enabled) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    const res = await bridge.market.setEnabled(pluginId, enabled);
    if (!res.ok && res.error) {
      set((s) => ({ marketErrors: { ...s.marketErrors, [pluginId]: res.error } }));
    }
    await get().loadPlugins();
    return res.ok;
  },

  setInstallPhase: (pluginId, phase) =>
    set((s) => {
      const phases = { ...s.installPhases };
      if (phase === undefined) delete phases[pluginId];
      else phases[pluginId] = phase;
      return { installPhases: phases };
    }),

  collectPluginContext: async (message) => {
    const bridge = getPluginBridge();
    if (!bridge) return [];
    try {
      const res = await bridge.collectContext(message);
      return res?.sections ?? [];
    } catch {
      return [];
    }
  },

  loadPluginSettings: async (pluginId) => {
    const bridge = getPluginBridge();
    if (!bridge) return {};
    const res = await bridge.getSettings(pluginId);
    return (res?.settings ?? {}) as Record<string, unknown>;
  },

  setPluginSetting: async (pluginId, key, value) => {
    const bridge = getPluginBridge();
    if (!bridge) return false;
    const res = await bridge.setSetting(pluginId, key, value);
    return res?.ok === true;
  },

  executePluginCommand: async (pluginId, name, args) => {
    const bridge = getPluginBridge();
    if (!bridge) return { ok: false, error: 'no plugin bridge' };
    return bridge.executeCommand(pluginId, name, args);
  },

  setPanelStatus: (status) =>
    set((s) => ({
      panelStatuses: { ...s.panelStatuses, [status.pluginId]: status },
    })),
}));
