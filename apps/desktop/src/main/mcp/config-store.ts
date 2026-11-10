/**
 * MCP server configuration, owned by the desktop shell.
 *
 * Two files, same shape as pi's own loader:
 *   - global:  `<agentDir>/mcp.json`
 *   - project: `<workspace>/.pi/mcp.json` (only read for a trusted workspace)
 *
 * The extension reads through `loadForSession()`, so both paths agree on
 * normalization and on scope merging. This module is deliberately free of
 * `electron` imports: the tests exercise it directly.
 *
 * What it guarantees:
 *   - a broken file never throws; problems land in `diagnostics`
 *   - unknown fields (from the pi CLI, or from a newer version) survive a save
 *   - writes are atomic (temp file + rename), so a crash cannot truncate config
 *   - `exposure` is normalized: pi defaults to `codemode`, which never reaches
 *     `tool_search`; PiWork maps everything except `hidden` to `deferred`
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from '@earendil-works/pi-coding-agent';
import type {
  McpListResult,
  McpScope,
  McpServerInput,
  McpServerRecord,
  McpTransportKind,
} from '@pi/types';

/** Bumped when PiWork starts writing a field pi does not know about. */
const CONFIG_VERSION = 1;

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const MCP_LIMITS = {
  maxServers: 128,
  maxArgs: 64,
  maxEnv: 64,
  maxHeaders: 32,
  maxValueBytes: 4096,
  maxDescriptionChars: 1000,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 600,
} as const;

/** Keys PiWork writes itself; everything else on a record is preserved as `extra`.
 *  `name`/`scope`/`override` are PiWork's own fields — they must never leak into
 *  the file, where pi's schema does not know them. */
const KNOWN_KEYS = new Set([
  'type', 'command', 'args', 'env', 'cwd', 'url', 'headers',
  'enabled', 'exposure', 'description', 'timeout',
  'name', 'scope', 'override',
]);

type RawServer = Record<string, unknown>;
interface RawFile {
  version?: unknown;
  mcpServers?: unknown;
  [key: string]: unknown;
}

interface ParseOutcome {
  record?: McpServerRecord;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** pi's exposures that are not `hidden` all mean "let tool_search find it". */
export function normalizeExposure(value: unknown): 'deferred' | 'hidden' {
  return value === 'hidden' ? 'hidden' : 'deferred';
}

/**
 * Sanitized namespace pi derives from a server name. Sanitizing collapses
 * `-` and `_`, so two names that differ only by those would address the same
 * tool namespace; the caller must reject the second one.
 */
function namespaceOf(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringMap(
  value: unknown,
  label: string,
  maxEntries: number,
  keyPattern: RegExp,
  errors: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${label}必须是对象`);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > maxEntries) {
    errors.push(`${label}最多 ${maxEntries} 项`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!keyPattern.test(key)) {
      errors.push(`${label}的键 "${short(key)}" 不合法`);
      return undefined;
    }
    if (typeof entry !== 'string' || byteLength(entry) > MCP_LIMITS.maxValueBytes) {
      errors.push(`${label} "${key}" 的值必须是字符串且不超过 ${MCP_LIMITS.maxValueBytes} 字节`);
      return undefined;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Validate one record from disk or from the settings form. Never throws: the
 * caller decides whether a bad record is a diagnostic (read) or an error (save).
 */
export function parseServerRecord(
  name: string,
  raw: unknown,
  scope: McpScope,
): ParseOutcome {
  if (!NAME_PATTERN.test(name)) {
    return { error: `服务器名 "${short(name)}" 只能用字母、数字、- 和 _，且不超过 64 个字符` };
  }
  if (!isRecord(raw)) return { error: `服务器 "${name}" 的配置必须是对象` };

  const errors: string[] = [];
  const hasCommand = raw.command !== undefined;
  const hasUrl = raw.url !== undefined;

  // A project entry may be a pure override (`{ "enabled": false }`): no
  // transport of its own, it patches the global server of the same name.
  const isOverride = scope === 'project' && !hasCommand && !hasUrl && raw.type === undefined;
  if (!isOverride && hasCommand === hasUrl) {
    errors.push(`服务器 "${name}" 必须且只能提供 command（stdio）或 url（http）之一`);
  }

  const type: McpTransportKind | undefined = isOverride
    ? undefined
    : hasUrl ? 'http' : 'stdio';

  let command: string | undefined;
  let args: string[] | undefined;
  let env: Record<string, string> | undefined;
  let cwd: string | undefined;
  let url: string | undefined;
  let headers: Record<string, string> | undefined;

  if (type === 'stdio') {
    command = readString(raw.command);
    if (!command || command === '' || byteLength(command) > MCP_LIMITS.maxValueBytes || command.includes('\0')) {
      errors.push(`服务器 "${name}" 的 command 不合法`);
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.length > MCP_LIMITS.maxArgs) {
        errors.push(`服务器 "${name}" 的 args 必须是最多 ${MCP_LIMITS.maxArgs} 项的数组`);
      } else if (raw.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || byteLength(arg) > MCP_LIMITS.maxValueBytes)) {
        errors.push(`服务器 "${name}" 的 args 每项必须是不超过 ${MCP_LIMITS.maxValueBytes} 字节的字符串`);
      } else {
        args = raw.args as string[];
      }
    }
    env = readStringMap(raw.env, `服务器 "${name}" 的 env`, MCP_LIMITS.maxEnv, ENV_KEY_PATTERN, errors);
    cwd = readString(raw.cwd);
    if (cwd !== undefined && (byteLength(cwd) > MCP_LIMITS.maxValueBytes || cwd.includes('\0'))) {
      errors.push(`服务器 "${name}" 的 cwd 不合法`);
    }
  }

  if (type === 'http') {
    url = readString(raw.url);
    if (!url || byteLength(url) > MCP_LIMITS.maxValueBytes) {
      errors.push(`服务器 "${name}" 的 url 不合法`);
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(`服务器 "${name}" 的 url 只支持 http 或 https`);
        }
      } catch {
        errors.push(`服务器 "${name}" 的 url 无法解析`);
      }
    }
    headers = readStringMap(raw.headers, `服务器 "${name}" 的 headers`, MCP_LIMITS.maxHeaders, HEADER_NAME_PATTERN, errors);
  }

  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== 'boolean') errors.push(`服务器 "${name}" 的 enabled 必须是布尔值`);

  const description = readString(raw.description);
  if (description !== undefined && description.length > MCP_LIMITS.maxDescriptionChars) {
    errors.push(`服务器 "${name}" 的描述最多 ${MCP_LIMITS.maxDescriptionChars} 个字符`);
  }

  let timeout: number | undefined;
  if (raw.timeout !== undefined) {
    if (
      typeof raw.timeout !== 'number'
      || !Number.isFinite(raw.timeout)
      || raw.timeout < MCP_LIMITS.minTimeoutSeconds
      || raw.timeout > MCP_LIMITS.maxTimeoutSeconds
    ) {
      errors.push(`服务器 "${name}" 的 timeout 必须是 ${MCP_LIMITS.minTimeoutSeconds}–${MCP_LIMITS.maxTimeoutSeconds} 秒`);
    } else {
      timeout = raw.timeout;
    }
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  if (errors.length > 0) return { error: errors.join('；') };

  return {
    record: {
      name,
      // Overrides carry no transport; `type` is filled in after merging.
      type: type ?? 'stdio',
      command,
      args,
      env,
      cwd,
      url,
      headers,
      enabled: enabled as boolean,
      exposure: normalizeExposure(raw.exposure),
      description,
      timeout,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
      scope,
      override: isOverride || undefined,
    },
  };
}

/** pi's config object for one record, with unknown fields re-attached. */
function toExtensionConfig(record: McpServerRecord): McpServerConfig {
  const shared = {
    enabled: record.enabled,
    exposure: record.exposure,
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.timeout !== undefined ? { timeout: record.timeout } : {}),
  };
  const base = { ...(record.extra ?? {}), ...shared };
  if (record.type === 'http') {
    return {
      ...base,
      url: record.url ?? '',
      ...(record.headers ? { headers: record.headers } : {}),
    } as McpServerConfig;
  }
  return {
    ...base,
    command: record.command ?? '',
    ...(record.args ? { args: record.args } : {}),
    ...(record.env ? { env: record.env } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
  } as McpServerConfig;
}

export interface McpConfigStoreOptions {
  /** Defaults to `getAgentDir()` (honours PI_CODING_AGENT_DIR). */
  agentDir?: string;
  /** Where the per-workspace trust list lives. Defaults beside the global file. */
  trustPath?: string;
}

interface TrustFile {
  version: number;
  trusted: string[];
}

export class McpConfigStore {
  private readonly agentDirOption?: string;
  private readonly trustPathOption?: string;

  constructor(options: McpConfigStoreOptions = {}) {
    this.agentDirOption = options.agentDir;
    this.trustPathOption = options.trustPath;
  }

  private get agentDir(): string {
    return this.agentDirOption ?? getAgentDir();
  }

  globalPath(): string {
    return join(this.agentDir, 'mcp.json');
  }

  projectPath(workspacePath: string): string {
    return join(workspacePath, '.pi', 'mcp.json');
  }

  private get trustPath(): string {
    return this.trustPathOption ?? join(this.agentDir, 'piwork-mcp-trust.json');
  }

  // ── Trust ──

  isWorkspaceTrusted(workspacePath: string): boolean {
    return this.readTrust().trusted.some((entry) => entry === workspacePath);
  }

  setWorkspaceTrusted(workspacePath: string, trusted: boolean): void {
    const file = this.readTrust();
    const next = new Set(file.trusted);
    if (trusted) next.add(workspacePath);
    else next.delete(workspacePath);
    this.writeJson(this.trustPath, { version: CONFIG_VERSION, trusted: [...next] });
  }

  private readTrust(): TrustFile {
    if (!existsSync(this.trustPath)) return { version: CONFIG_VERSION, trusted: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.trustPath, 'utf8')) as Partial<TrustFile>;
      return {
        version: CONFIG_VERSION,
        trusted: Array.isArray(parsed.trusted)
          ? parsed.trusted.filter((entry): entry is string => typeof entry === 'string')
          : [],
      };
    } catch {
      return { version: CONFIG_VERSION, trusted: [] };
    }
  }

  // ── Reading ──

  private readFile(path: string): { raw: RawFile; diagnostics: string[] } {
    const diagnostics: string[] = [];
    if (!existsSync(path)) return { raw: {}, diagnostics };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      diagnostics.push(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      return { raw: {}, diagnostics };
    }
    if (!isRecord(parsed)) {
      diagnostics.push(`${path} 的顶层必须是对象`);
      return { raw: {}, diagnostics };
    }
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
      diagnostics.push(`${path} 的 mcpServers 必须是对象`);
      return { raw: { ...parsed, mcpServers: {} }, diagnostics };
    }
    return { raw: parsed as RawFile, diagnostics };
  }

  private parseFile(path: string, scope: McpScope): { servers: McpServerRecord[]; diagnostics: string[] } {
    const { raw, diagnostics } = this.readFile(path);
    const servers: McpServerRecord[] = [];
    const rawServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    const entries = Object.entries(rawServers);
    if (entries.length > MCP_LIMITS.maxServers) {
      diagnostics.push(`${path} 里有 ${entries.length} 个服务器，超过 ${MCP_LIMITS.maxServers} 个，多出的会被忽略`);
    }
    for (const [name, value] of entries.slice(0, MCP_LIMITS.maxServers)) {
      const outcome = parseServerRecord(name, value, scope);
      if (outcome.record) servers.push(outcome.record);
      else if (outcome.error) diagnostics.push(outcome.error);
    }
    return { servers, diagnostics };
  }

  list(workspacePath?: string): Omit<McpListResult, 'statuses'> {
    const global = this.parseFile(this.globalPath(), 'global');
    const hasWorkspace = typeof workspacePath === 'string' && workspacePath.length > 0;
    const project = hasWorkspace
      ? this.parseFile(this.projectPath(workspacePath), 'project')
      : { servers: [], diagnostics: [] };

    return {
      global: global.servers,
      project: project.servers,
      hasWorkspace,
      workspaceTrusted: hasWorkspace ? this.isWorkspaceTrusted(workspacePath) : false,
      diagnostics: [...global.diagnostics, ...project.diagnostics],
    };
  }

  /** The saved record for a name, for the "test connection" path. */
  findServer(name: string, scope: McpScope, workspacePath?: string): McpServerRecord | undefined {
    const file = scope === 'project'
      ? (workspacePath ? this.parseFile(this.projectPath(workspacePath), 'project') : { servers: [] })
      : this.parseFile(this.globalPath(), 'global');
    return file.servers.find((server) => server.name === name);
  }

  // ── Session view ──

  /**
   * pi's view of the config for one session: global servers, plus project
   * servers when the workspace is trusted. A project entry with no transport
   * is an override and patches `enabled`/`exposure` of the global server of
   * the same name; a project entry with its own transport replaces it.
   */
  loadForSession(cwd: string, trustOverride?: boolean): LoadedMcpConfig {
    const workspacePath = cwd;
    const global = this.parseFile(this.globalPath(), 'global');
    const trusted = trustOverride ?? this.isWorkspaceTrusted(workspacePath);
    const project = trusted
      ? this.parseFile(this.projectPath(workspacePath), 'project')
      : { servers: [] as McpServerRecord[], diagnostics: [] as string[] };

    const byName = new Map<string, McpServerRecord>();
    for (const server of global.servers) byName.set(server.name, server);
    for (const server of project.servers) {
      const existing = byName.get(server.name);
      if (server.override && existing) {
        byName.set(server.name, {
          ...existing,
          enabled: server.enabled,
          exposure: server.exposure,
          override: true,
        });
      } else {
        byName.set(server.name, server);
      }
    }

    const servers: McpServerEntry[] = [];
    for (const record of byName.values()) {
      if (record.override && !record.url && !record.command) continue;
      servers.push({
        name: record.name,
        config: toExtensionConfig(record),
        source: record.scope === 'project' ? this.projectPath(workspacePath) : this.globalPath(),
        scope: record.scope,
      });
    }

    return {
      servers,
      // PiWork never enables codemode; MCP tools are reached through tool_search.
      autoEnableCodemode: false,
      errors: [...global.diagnostics, ...project.diagnostics],
      ...(trusted ? { projectConfig: this.projectPath(workspacePath) } : {}),
    };
  }

  hasEnabledServers(cwd: string): boolean {
    const loaded = this.loadForSession(cwd);
    return loaded.servers.some((entry) => entry.config.enabled !== false);
  }

  // ── Writing ──

  private writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  private mutateFile(path: string, mutate: (raw: RawFile) => string | undefined): void {
    const { raw } = this.readFile(path);
    const failure = mutate(raw);
    if (failure) throw new Error(failure);
    this.writeJson(path, raw);
  }

  private fileFor(scope: McpScope, workspacePath?: string): string {
    if (scope === 'project') {
      if (!workspacePath) throw new Error('项目级 MCP 配置需要先选择工作区。');
      return this.projectPath(workspacePath);
    }
    return this.globalPath();
  }

  private rawServers(raw: RawFile): Record<string, unknown> {
    raw.mcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    return raw.mcpServers as Record<string, unknown>;
  }

  save(request: {
    scope: McpScope;
    workspacePath?: string;
    originalName?: string | null;
    server: McpServerInput;
  }): void {
    const { scope, workspacePath, originalName, server } = request;
    const path = this.fileFor(scope, workspacePath);
    const outcome = parseServerRecord(server.name, server, scope);
    if (!outcome.record || outcome.error) throw new Error(outcome.error ?? '服务器配置不合法。');
    const record = outcome.record;

    this.mutateFile(path, (raw) => {
      const servers = this.rawServers(raw);
      const previous = originalName?.trim() || null;
      if (previous && previous !== record.name && servers[previous] === undefined) {
        return `服务器 "${previous}" 不存在。`;
      }
      if (!previous && servers[record.name] !== undefined) {
        return `服务器 "${record.name}" 已存在。`;
      }
      if (previous && previous !== record.name) delete servers[previous];

      // pi addresses tools by a sanitized namespace; two names that differ
      // only by `-`/`_` would collide, so refuse the second one up front.
      const namespace = namespaceOf(record.name);
      for (const other of Object.keys(servers)) {
        if (other !== record.name && namespaceOf(other) === namespace) {
          return `服务器 "${record.name}" 与 "${other}" 的命名空间相同（- 和 _ 会被视为一样），请换一个名字。`;
        }
      }

      servers[record.name] = toRawServer(record);
      raw.version = CONFIG_VERSION;
      return undefined;
    });
  }

  remove(request: { scope: McpScope; workspacePath?: string; name: string }): void {
    const path = this.fileFor(request.scope, request.workspacePath);
    this.mutateFile(path, (raw) => {
      const servers = this.rawServers(raw);
      if (servers[request.name] === undefined) return `服务器 "${request.name}" 不存在。`;
      delete servers[request.name];
      raw.version = CONFIG_VERSION;
      return undefined;
    });
  }

  setEnabled(request: { scope: McpScope; workspacePath?: string; name: string; enabled: boolean }): void {
    const path = this.fileFor(request.scope, request.workspacePath);
    this.mutateFile(path, (raw) => {
      const servers = this.rawServers(raw);
      const existing = servers[request.name];
      if (!isRecord(existing)) return `服务器 "${request.name}" 不存在。`;
      servers[request.name] = { ...existing, enabled: request.enabled };
      raw.version = CONFIG_VERSION;
      return undefined;
    });
  }
}

/** Record back to the on-disk shape: known fields + preserved unknown ones. */
function toRawServer(record: McpServerRecord): RawServer {
  const raw: RawServer = { ...(record.extra ?? {}) };
  if (record.type === 'http') {
    raw.url = record.url;
    if (record.headers) raw.headers = record.headers;
  } else {
    raw.command = record.command;
    if (record.args) raw.args = record.args;
    if (record.env) raw.env = record.env;
    if (record.cwd) raw.cwd = record.cwd;
  }
  raw.enabled = record.enabled;
  raw.exposure = record.exposure;
  if (record.description !== undefined) raw.description = record.description;
  if (record.timeout !== undefined) raw.timeout = record.timeout;
  return raw;
}
