/**
 * Plugin runtime state and renderer-facing info.
 */

import type { PanelAnchor, PanelRegion } from './manifest.js';

/** Where a plugin was discovered from. Higher priority overrides lower. */
export type PluginSource = 'dev' | 'user';

export type PluginRuntimeState =
  | 'registered'   // manifest validated, not yet activated
  | 'activating'   // backend UtilityProcess starting
  | 'active'       // backend ready (or no backend)
  | 'disabled'     // turned off by user via plugins.json
  | 'incompatible' // engines range or apiVersion check failed
  | 'error'        // failed to activate (crashed beyond restart budget)
  | 'crashed';     // backend exited, restart pending

export interface PluginPanelInfo {
  id: string;
  title: string;
  /** Path to the panel's HTML page, relative to the plugin root. */
  entry: string;
  icon?: string;
  /** Plugin-provided icon, absolute pi-plugin:// URL (vocabulary fallback). */
  iconUrl?: string;
  /** Not shown on the rail; still openable via panel.open. */
  hidden?: boolean;
  keepAlive?: 'always' | 'lru' | 'never';
  /** Whether the panel's tabs follow the session. Defaults to 'global'. */
  scope?: import('./manifest.js').PanelScope;
  /** Several host tabs of this panel may be open at once. */
  multiInstance?: boolean;
  /** Sidebar column. Defaults to 'right'. */
  region?: PanelRegion;
  /** Position within the region's rail. Defaults to 'top'. */
  anchor?: PanelAnchor;
  /** Sort order among panels sharing a region and anchor. Defaults to 0. */
  order?: number;
  /**
   * This panel's split companion (VS Code's 向右拆分): another panel id of the
   * same plugin that opens BESIDE this one — the multi-tab counterpart of the
   * "split editor" gesture. Declared on the MAIN panel; the companion itself
   * is usually `hidden` (reachable only through the split).
   */
  companion?: string;
}

export interface PluginCommandInfo {
  /** Slash command name as declared, e.g. "/mail". */
  name: string;
  title?: string;
  description?: string;
}

export interface PluginToolInfo {
  name: string;
  description?: string;
}

/** Message renderer contribution: renders tool results as chat cards. */
export interface PluginMessageRendererInfo {
  /** Tool name whose result this renderer decorates (e.g. "mail_create_draft"). */
  type: string;
  /** Render a live card from streaming tool args while the tool runs. */
  streaming?: boolean;
}

/** Context provider contribution: injects context before message sends. */
export interface PluginContextProviderInfo {
  id: string;
  /** Whether the provider runs automatically before every send. */
  auto?: boolean;
  description?: string;
}

/** Settings contribution: auto-rendered form fields in the plugin center. */
export interface PluginSettingInfo {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  label?: string;
  description?: string;
  default?: unknown;
  options?: string[];
}

/**
 * A copy of a plugin that discovery found but did not load, because another
 * root already supplied that id at a higher priority.
 *
 * The scan has always dropped these silently (`dev > user`, first root wins).
 * That is correct for loading, but it left the UI unable to answer the one
 * question a developer actually has — "is my installed copy behind the one
 * running right now?". Dev copies shadow the user's installed copy by design,
 * so this is the normal state of `pnpm dev:desktop:plugins`, not an error.
 */
export interface PluginShadowedCopy {
  source: PluginSource;
  version: string;
  rootPath: string;
}

/** Serializable plugin descriptor sent to the renderer via IPC. */
export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version: string;
  source: PluginSource;
  state: PluginRuntimeState;
  permissions: string[];
  /**
   * The version a rollback would restore, when one is kept. Present only after
   * an upgrade — it is what makes "回到上一版" offerable in the plugin center.
   */
  previousVersion?: string;
  /**
   * Copies discovery found but did not load (same id, lower-priority root).
   * Empty in the normal installed-only setup; populated when a dev root
   * shadows the user's installed copy.
   */
  shadowed?: PluginShadowedCopy[];
  /** Plugin brand icon, absolute pi-plugin:// URL (optional). */
  iconUrl?: string;
  panels: PluginPanelInfo[];
  commands: PluginCommandInfo[];
  tools: PluginToolInfo[];
  messageRenderers: PluginMessageRendererInfo[];
  contextProviders: PluginContextProviderInfo[];
  settings: PluginSettingInfo[];
  error?: string;
}

/** Panel status pushed from plugin backends (agent activity linkage). */
export interface PluginPanelStatus {
  pluginId: string;
  panelId?: string;
  /** Multi-instance panels: which host tab this status describes. */
  tabId?: string;
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  detail?: string;
}

/** Events pushed from main to the renderer on the `pi:plugin:event` channel. */
export type PluginEvent =
  | { type: 'status'; status: PluginPanelStatus }
  | { type: 'state-changed'; pluginId: string; state: PluginRuntimeState; error?: string }
  | { type: 'plugins-changed' }
  /** Backend requested a panel open. focus=false → badge only, no steal.
   *  `params` ride the open (e.g. `{ file }` for the viewer pane).
   *  `instanceId` is present when the host should mount a NEW instance of a
   *  multi-instance panel (the host tab key is derived from it). */
  | {
      type: 'panel-open';
      pluginId: string;
      panelId?: string;
      focus: boolean;
      params?: Record<string, unknown>;
      instanceId?: string;
    }
  /** A plugin asked to close one of its own panels (e.g. unsplit a pane). */
  | { type: 'panel-close'; pluginId: string; panelId?: string; tabId?: string }
  /** The backend changed a tab's params/title (a file opened inside the
   *  viewer's own file tree, a browser page title). */
  | {
      type: 'tab-update';
      pluginId: string;
      tabId: string;
      title?: string;
      params?: Record<string, unknown>;
    }
  /** Surface an already-open host tab (no new tab, no params matching). */
  | { type: 'tab-focus'; pluginId: string; tabId: string; focus: boolean }
  /** Marketplace install progress phases. */
  | { type: 'install-phase'; pluginId: string; phase: import('./market.js').InstallPhase };
