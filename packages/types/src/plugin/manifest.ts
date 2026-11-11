/**
 * Plugin manifest contract — the single source of truth for a plugin's
 * identity, permissions and contributions.
 *
 * A manifest.json lives at the root of a plugin directory:
 *
 *   <root>/manifest.json
 *   <root>/dist/main.js        (backend entry, UtilityProcess)
 *   <root>/ui/                 (panel assets)
 */

/** Keep-alive policy for a panel when it is switched away from. */
export type PanelKeepAlive = 'always' | 'lru' | 'never';

/** Which sidebar column a panel belongs to. */
export type PanelRegion = 'left' | 'right';

/** Where within its region's rail the panel sits. */
export type PanelAnchor = 'top' | 'bottom';

/**
 * Whether the panel's tabs belong to a conversation or to the workbench.
 *
 * 'session' — the panel shows artifacts of the CURRENT conversation (browser
 * pages the agent opened, the document under discussion). Its tabs are kept
 * per session: switching sessions swaps them out and back, so concurrent
 * sessions never fight over one "current document/page". 'global' (default) —
 * a cross-session workbench panel (tasks, mail); its tabs stay put.
 */
export type PanelScope = 'session' | 'global';

export interface PanelContribution {
  /** Unique within the plugin; also the `panelId` in the panel↔backend protocol. */
  id: string;
  title?: string;
  /**
   * Panel icon. Two forms, told apart by the leading `./` or `/`:
   *   "./assets/main.svg"  → a file in the plugin, served from its own origin
   *   "calendar"           → a name from the host's built-in icon vocabulary
   * A file wins over the plugin's own brand icon; a vocabulary name falls back
   * to it.
   */
  icon?: string;
  /**
   * Omit the panel from the rail — it stays openable via panel.open
   * (events/tools). Use for auxiliary panels that belong to a primary one.
   */
  hidden?: boolean;
  /**
   * Path to the panel's HTML page, relative to the plugin root.
   *
   * Required. This is what a panel IS: a web page. There is no `kind` field —
   * the host decides how to host the page (a native view on desktop), and a
   * plugin never needs to know or care.
   */
  entry: string;
  keepAlive?: PanelKeepAlive;
  /**
   * Whether the panel's tabs follow the session. Defaults to the panel's
   * region: the left column is the workspace as a whole ('global'), the right
   * column is the conversation being worked on ('session'). A right-side panel
   * that must stay open across conversations declares 'global' explicitly.
   */
  scope?: PanelScope;
  /**
   * Allow several host tabs of this panel at once.
   *
   * A panel is one page; the host mounts one native view per tab. Multi-instance
   * is for panels whose subject is a single document/page (the file viewer, the
   * browser) — each tab carries its own open `params`, title and backend
   * `tabId`. Singleton panels (plugin center, task list) leave this unset: a
   * second open focuses the existing tab instead of creating another.
   */
  multiInstance?: boolean;
  /**
   * Whether the host may surface this panel as the visible effect of a tool
   * call. Defaults to true: after any of the plugin's tools runs, the panel
   * earns a place in the layout, because the panel is where that plugin's
   * work happens (the browser you are driving).
   *
   * Set false when the panel is a VIEWPORT for content rather than a
   * workspace — the file viewer. An agent reading an attached file must not
   * open the viewer on the user's screen; when a tool really has something to
   * show, it calls `panel.open` itself, which is unaffected by this flag.
   */
  surfaceOnActivity?: boolean;
  /**
   * Which sidebar column the panel lives in. Defaults to 'right'.
   *
   * The left column is the global-view column (all files, all sessions), so a
   * panel belongs there when its subject is the workspace as a whole rather
   * than the thing currently being worked on.
   */
  region?: PanelRegion;
  /** Position within its region's rail. Defaults to 'top'. */
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

/**
 * Optional capability contract for one agent tool.
 *
 * Most of what a model needs to choose a tool is prose (description /
 * promptSnippet / promptGuidelines). This object adds the parts prose cannot
 * express reliably: a domain, hard output bounds, operations the tool does
 * NOT support, and whether the tool is only useful with a particular model
 * capability. The host enforces `limits` after every call and renders
 * `summary` / `guidelines` / `unsupported` into the system prompt.
 *
 * It is deliberately optional: a manifest without a contract keeps loading,
 * and the host derives a one-line summary from `description`.
 */
export interface ToolContract {
  /**
   * Coarse capability domain, e.g. `office`, `browser`, `filesystem`.
   * Used for grouping in prompts and for metrics; not interpreted by the model.
   */
  domain?: string;
  /**
   * One-line summary for the system prompt's "Available tools" section.
   * Falls back to the first line/sentence of `description`.
   */
  summary?: string;
  /** Short bullets appended to the system prompt's Guidelines section. */
  guidelines?: string[];
  /** Hard bounds the host enforces on the model-facing result content. */
  limits?: {
    /** Default 50_000 characters. */
    maxOutputChars?: number;
    /** Default 2_000 lines. */
    maxOutputLines?: number;
    /**
     * Parameter the model can pass to request more output. Included in the
     * truncation notice, e.g. "pass `offset` to continue".
     */
    cursorParam?: string;
  };
  /**
   * Operations this tool deliberately does not implement. The host turns each
   * entry into a guideline, so the model knows the boundary up front instead
   * of falling back to a generic (and often unsafe) shell route.
   */
  unsupported?: Array<{
    operation: string;
    /** Preferred alternative, when one exists. */
    alternativeTool?: string;
    /** What to do instead / what to tell the user. */
    hint?: string;
  }>;
  /**
   * Model capability the tool's result depends on. P0 surfaces this as prompt
   * guidance only; it does not block calls.
   */
  requiresModel?: { input?: 'image' };
}

/**
 * Agent tool definition. The schema follows the MCP tool format
 * (JSON Schema based `inputSchema`), so external MCP servers can be
 * mounted as headless plugins in the future.
 */
export interface ToolContribution {
  name: string;
  description?: string;
  /** JSON Schema for the tool parameters. */
  inputSchema?: Record<string, unknown>;
  /**
   * True when the tool only observes state — it never writes files, sends
   * messages, or mutates anything the user would care about. The host may use
   * this to skip confirmation or badge the tool; declare honestly, because a
   * wrong `true` teaches the host to trust a writer. Mirrors MCP's
   * `readOnlyHint` annotation.
   */
  readOnly?: boolean;
  /**
   * Capability boundaries and output bounds. Optional; omitted means the host
   * derives a summary from `description` and applies default output limits.
   */
  contract?: ToolContract;
}

export interface CommandContribution {
  /** Slash command including the leading slash, e.g. "/mail". */
  name: string;
  title?: string;
  description?: string;
}

export interface MessageRendererContribution {
  /** Keyed by message/tool block type, e.g. "mail:draft". */
  type: string;
  /** Render a live card from streaming tool args while the tool runs. */
  streaming?: boolean;
}

export interface ContextProviderContribution {
  id: string;
  /** Whether the provider runs automatically before every message send. */
  auto?: boolean;
  description?: string;
}

export interface FilePreviewContribution {
  /** File extensions to handle, e.g. ["docx", "xlsx"]. */
  match: string[];
}

export interface SkillContribution {
  /** Path relative to the plugin root pointing at a SKILL.md folder or file. */
  path: string;
}

export interface SettingsContribution {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  label?: string;
  description?: string;
  default?: unknown;
  options?: string[];
}

export interface PluginContributions {
  panels?: PanelContribution[];
  tools?: ToolContribution[];
  commands?: CommandContribution[];
  messageRenderers?: MessageRendererContribution[];
  contextProviders?: ContextProviderContribution[];
  filePreview?: FilePreviewContribution[];
  skills?: SkillContribution[];
  settings?: SettingsContribution[];
}

/**
 * Capability permission grant. Examples:
 *   "storage"            — plugin-private key/value storage
 *   "secrets:mail"       — read the "mail" namespace from the secrets vault
 *   "network:imap.*"     — outbound network to hosts matching the pattern
 *   "notify"             — desktop notifications
 *   "clipboard"          — clipboard access
 *   "browser"            — drive the host browser automation capability
 */
export type PluginPermission = string;

/**
 * The protocol version this build of the host speaks — the UPPER bound of the
 * supported range. Compatibility is a range, not an exact match:
 *
 *   plugin loads   ⇔  MIN_SUPPORTED_API_VERSION ≤ manifest.apiVersion ≤ PLUGIN_PROTOCOL_VERSION
 *
 * - Additive protocol changes (new manifest fields, new capabilities, new
 *   lifecycle events) bump ONLY PLUGIN_PROTOCOL_VERSION — every plugin in the
 *   range keeps loading untouched.
 * - Breaking changes (a field changes meaning, a feature is removed — as v3
 *   did to `selectionActions`) bump BOTH: the old current becomes the new
 *   floor. Plugins below the floor are `incompatible` with a clear
 *   "too old, update the plugin" reason instead of failing somewhere deep in
 *   a panel.
 * - A plugin declaring a version ABOVE the current is `incompatible` too —
 *   "the plugin is newer than your app, update the app".
 *
 * The exact-match policy this replaces meant every protocol bump bricked all
 * installed third-party plugins at once — untenable the moment the protocol
 * is opened to outside authors.
 *
 * History:
 *
 * 10 — added the `agent.turnEnd` host event: every backend is told when an
 *     agent run has settled (completed, aborted or error), with
 *     `{ sessionId, runId, aborted, outcome }`. Plugins use it to fold the
 *     many tool calls of one run into one result (e.g. a single completion
 *     card via `messages.post`). Purely additive; floor stays 3.
 *
 * 9 — added the `message-action` host→plugin message and the
 *     `messages.update` / `messages.remove` capabilities: cards inside a
 *     plugin-originated message are interactive, and the plugin can revise or
 *     withdraw the message by id. Purely additive; floor stays 3.
 *
 * 8 — added the `messages.post` host capability and the `messages`
 *     permission: a plugin can post a persistent plugin message (declarative
 *     card/text) into a conversation timeline as a pi `custom` entry. It is
 *     kept with the transcript but is NOT sent to the model. Purely additive;
 *     plugins that never call it behave exactly as before, floor stays 3.
 *
 * 7 — added optional workspace attribution: `PluginToolCallMessage.workspaceId`
 *     (the calling conversation's workspace), `panel.mounted`'s
 *     `data.workspaceId`, and an injected `piSDK.workspace` /
 *     `piSDK.onWorkspace(cb)` channel that tells a panel page which workspace
 *     it is showing. Purely additive — every existing plugin ignores fields it
 *     does not read, so the floor stays 3.
 *
 * 6 — added optional `contributes.tools[].contract` (domain, summary,
 *     guidelines, output limits, unsupported operations, model requirement).
 *     Purely additive; the host enforces limits and renders the guidance into
 *     the system prompt, and a manifest without a contract behaves exactly as
 *     before. Floor stays 3.
 *
 * 5 — tool-name namespace tightened and `chat.send` attributed. Tool names
 *     are now unique across all plugins: a duplicate WITHIN one manifest
 *     rejects the manifest at scan; a collision ACROSS plugins keeps the
 *     first contributor (dev > user, matching plugin-id shadowing) and names
 *     the loser in the log instead of silently dropping it. `chat.send`
 *     messages now carry an attribution line — a plugin can reach the
 *     conversation but can no longer speak AS the user. Also added
 *     `readOnly` on tool contributions (mirrors MCP's `readOnlyHint`). All
 *     additive — protocol 3/4 plugins load unchanged, floor stays 3.
 *
 * 4 — added the `card-event` host→plugin message and the SDK's `onCardEvent`
 *     callback: declarative cards returned by tools (messageRenderers) can
 *     now carry interactive Buttons/Inputs, and the interaction flows back to
 *     the plugin backend. Purely additive — protocol 3 plugins load unchanged
 *     (their SDK ignores the new message), so the floor stays at 3.
 *
 * 3 — dropped `selectionActions` and the `selection` permission. The host's
 *     selection menu (滑词菜单) is gone: text selection is the panel's own
 *     business, and the one panel that had a selection UI of its own (the file
 *     viewer, driven by GenOffice) was drawing two floating menus at once.
 *     A manifest still declaring `selectionActions` is now rejected rather than
 *     silently ignored — see the `apiVersion` note on PluginManifest.
 */
export const PLUGIN_PROTOCOL_VERSION = 10;

/**
 * The OLDEST protocol version this build still loads — the lower bound of the
 * supported range. See PLUGIN_PROTOCOL_VERSION for the bump rules.
 *
 * A manifest that OMITS `apiVersion` predates versioning itself and loads
 * unchanged (the field was optional from day one) — but the plugin dev guide
 * and the marketplace listing both require it, so third-party plugins always
 * declare it and always get negotiated.
 */
export const MIN_SUPPORTED_API_VERSION = 3;

export interface PluginManifest {
  /** Reverse-DNS style id, lowercase. Also the directory name. */
  id: string;
  name: string;
  description?: string;
  version: string;
  /**
   * The plugin protocol version this plugin was written against. Loaded iff
   * it falls inside the host's supported range
   * (MIN_SUPPORTED_API_VERSION … PLUGIN_PROTOCOL_VERSION); outside the range
   * puts the plugin in the `incompatible` state with a reason saying which
   * side has to move. See PLUGIN_PROTOCOL_VERSION.
   */
  apiVersion?: number;
  /** Host version compatibility, semver range. e.g. { "pi-desktop": "^1.0.0" } */
  engines?: Record<string, string>;
  /** Backend entry relative to the plugin root. Omit for UI-only plugins. */
  backend?: string;
  /**
   * Plugin icon file, path relative to the plugin root — the plugin's brand
   * mark, shown in the plugin center's installed list (and marketplace).
   */
  icon?: string;
  permissions?: PluginPermission[];
  contributes?: PluginContributions;
}
