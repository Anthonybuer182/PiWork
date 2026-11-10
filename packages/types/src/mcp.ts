/**
 * MCP server configuration, as the desktop shell exposes it to the settings UI.
 *
 * The on-disk format is pi's own `mcp.json` (`mcpServers` keyed by server
 * name); these types are the normalized view on top of it. Fields PiWork does
 * not understand are preserved verbatim in `extra`, so a file written by the
 * pi CLI survives a save in PiWork unchanged.
 */

export type McpScope = 'global' | 'project';

export type McpTransportKind = 'stdio' | 'http';

/** PiWork only offers two of pi's five exposures: discover on demand, or hide. */
export type McpExposureSetting = 'deferred' | 'hidden';

export interface McpServerInput {
  name: string;
  type: McpTransportKind;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  exposure: McpExposureSetting;
  description?: string;
  /** Per-request timeout in seconds. */
  timeout?: number;
  /** pi fields PiWork does not surface (oauth, auth, toolExposure, …). */
  extra?: Record<string, unknown>;
}

export interface McpServerRecord extends McpServerInput {
  scope: McpScope;
  /** Project-scoped override of a global server of the same name. */
  override?: boolean;
}

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  /** Result of the last connection test in this app run. */
  state: 'unknown' | 'ok' | 'error';
  message?: string;
  toolCount?: number;
  checkedAt?: string;
}

export interface McpListResult {
  global: McpServerRecord[];
  project: McpServerRecord[];
  /** A workspace is selected, so the project file can be read. */
  hasWorkspace: boolean;
  /** Whether this workspace's `.pi/mcp.json` is allowed to run. */
  workspaceTrusted: boolean;
  diagnostics: string[];
  statuses: McpServerStatus[];
}

export interface McpSaveRequest {
  scope: McpScope;
  workspacePath?: string;
  /** Previous name when editing; null/undefined when adding. */
  originalName?: string | null;
  server: McpServerInput;
}

export interface McpDeleteRequest {
  scope: McpScope;
  workspacePath?: string;
  name: string;
}

export interface McpSetEnabledRequest {
  scope: McpScope;
  workspacePath?: string;
  name: string;
  enabled: boolean;
}

export interface McpSetTrustRequest {
  workspacePath: string;
  trusted: boolean;
}

export interface McpProbeRequest {
  /** Probe the saved record when true (name), or the unsaved form payload. */
  name?: string;
  scope?: McpScope;
  workspacePath?: string;
  server?: McpServerInput;
}

export type McpProbeErrorCode = 'invalid' | 'spawn' | 'network' | 'auth' | 'protocol' | 'timeout';

export type McpProbeResult =
  | {
      ok: true;
      protocolVersion: string;
      serverInfo?: { name?: string; version?: string };
      tools: { name: string; description?: string }[];
    }
  | { ok: false; code: McpProbeErrorCode; message: string };
