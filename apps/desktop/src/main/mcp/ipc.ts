/**
 * `pi:mcp:*` — the MCP settings surface.
 *
 * Only the host window's own renderer may call these: the config can carry
 * command lines, environment values and HTTP headers, so panel WebContentsViews
 * (which render third-party plugin code) must not be able to read it. That is
 * what `assertHostWindow` is for.
 *
 * Writes invalidate cached sessions: MCP config is read when a session is
 * assembled, so the next prompt has to rebuild to pick up a change.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ipcMain } from 'electron';
import type {
  McpDeleteRequest,
  McpListResult,
  McpProbeRequest,
  McpProbeResult,
  McpSaveRequest,
  McpScope,
  McpServerStatus,
  McpSetEnabledRequest,
  McpSetTrustRequest,
} from '@pi/types';
import { assertHostWindow } from '@main/ipc/guard';
import type { McpConfigStore } from './config-store';
import { probeServer } from './probe';

export interface McpIpcHooks {
  /** Rebuild cached agent sessions so the new config takes effect. */
  invalidateSessions: () => void;
}

/** Last connection test per server, for the settings page's status column. */
type StatusMap = Map<string, McpServerStatus>;

function statusKey(scope: McpScope, name: string): string {
  return `${scope}:${name}`;
}

function validateWorkspacePath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('工作区路径不合法。');
  if (!isAbsolute(value)) throw new Error('工作区路径必须是绝对路径。');
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error(`工作区目录不存在：${value}`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('请求格式不正确。');
  return value as Record<string, unknown>;
}

function asScope(value: unknown): McpScope {
  if (value === 'global' || value === 'project') return value;
  throw new Error('scope 必须是 global 或 project。');
}

export function registerMcpIpc(store: McpConfigStore, hooks: McpIpcHooks): void {
  const statuses: StatusMap = new Map();
  let lastWorkspace: string | undefined;

  const list = (workspacePath: string | undefined): McpListResult => {
    if (workspacePath) lastWorkspace = workspacePath;
    const result = store.list(workspacePath);
    return { ...result, statuses: [...statuses.values()] };
  };

  const changed = (workspacePath: string | undefined): McpListResult => {
    // Config changes only take effect on the next session assembly.
    hooks.invalidateSessions();
    return list(workspacePath);
  };

  ipcMain.handle('pi:mcp:list', (event, request: unknown) => {
    assertHostWindow(event);
    const payload = request === undefined || request === null ? {} : asObject(request);
    return list(validateWorkspacePath(payload.workspacePath));
  });

  ipcMain.handle('pi:mcp:save', (event, request: unknown) => {
    assertHostWindow(event);
    const payload = asObject(request) as unknown as McpSaveRequest;
    const workspacePath = validateWorkspacePath(payload.workspacePath);
    const scope = asScope(payload.scope);
    if (scope === 'project' && !workspacePath) throw new Error('项目级配置需要先选择工作区。');
    store.save({ ...payload, scope, workspacePath });
    // A renamed or re-pointed server invalidates its last test result.
    statuses.clear();
    return changed(workspacePath);
  });

  ipcMain.handle('pi:mcp:delete', (event, request: unknown) => {
    assertHostWindow(event);
    const payload = asObject(request) as unknown as McpDeleteRequest;
    const workspacePath = validateWorkspacePath(payload.workspacePath);
    const scope = asScope(payload.scope);
    if (typeof payload.name !== 'string' || !payload.name) throw new Error('缺少服务器名。');
    store.remove({ scope, workspacePath, name: payload.name });
    statuses.delete(statusKey(scope, payload.name));
    return changed(workspacePath);
  });

  ipcMain.handle('pi:mcp:set-enabled', (event, request: unknown) => {
    assertHostWindow(event);
    const payload = asObject(request) as unknown as McpSetEnabledRequest;
    const workspacePath = validateWorkspacePath(payload.workspacePath);
    const scope = asScope(payload.scope);
    if (typeof payload.name !== 'string' || !payload.name) throw new Error('缺少服务器名。');
    if (typeof payload.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。');
    store.setEnabled({ scope, workspacePath, name: payload.name, enabled: payload.enabled });
    return changed(workspacePath);
  });

  ipcMain.handle('pi:mcp:set-trust', (event, request: unknown) => {
    assertHostWindow(event);
    const payload = asObject(request) as unknown as McpSetTrustRequest;
    const workspacePath = validateWorkspacePath(payload.workspacePath);
    if (!workspacePath) throw new Error('缺少工作区路径。');
    if (typeof payload.trusted !== 'boolean') throw new Error('trusted 必须是布尔值。');
    store.setWorkspaceTrusted(workspacePath, payload.trusted);
    return changed(workspacePath);
  });

  ipcMain.handle('pi:mcp:probe', async (event, request: unknown): Promise<McpProbeResult> => {
    assertHostWindow(event);
    const payload = asObject(request) as unknown as McpProbeRequest;
    const workspacePath = validateWorkspacePath(payload.workspacePath);

    // Either an unsaved form payload (the add/edit dialog) or a saved record.
    let record;
    if (payload.server) {
      record = {
        ...payload.server,
        scope: asScope(payload.scope ?? 'global'),
      };
    } else {
      if (typeof payload.name !== 'string' || !payload.name) throw new Error('缺少服务器名。');
      const scope = asScope(payload.scope ?? 'global');
      record = store.findServer(payload.name, scope, workspacePath);
      if (!record) throw new Error(`服务器 "${payload.name}" 不存在。`);
    }

    const result = await probeServer(record, workspacePath ?? process.cwd());
    const key = statusKey(record.scope, record.name);
    statuses.set(key, {
      name: record.name,
      scope: record.scope,
      state: result.ok ? 'ok' : 'error',
      ...(result.ok
        ? { toolCount: result.tools.length }
        : { message: result.message }),
      checkedAt: new Date().toISOString(),
    });
    return result;
  });
}
