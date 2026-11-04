/**
 * Typed access to the desktop MCP bridge (`pi:mcp:*`).
 *
 * MCP configuration can contain command lines, environment values and HTTP
 * headers, so the main process only answers the host window's own renderer.
 * The web build has no agent directory — `hasMcpApi()` hides the section there.
 */

import type {
  McpDeleteRequest,
  McpListResult,
  McpProbeRequest,
  McpProbeResult,
  McpSaveRequest,
  McpSetEnabledRequest,
  McpSetTrustRequest,
} from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';
import { hasDesktopWindowApi } from '@/lib/window-identity';

export function hasMcpApi(): boolean {
  return hasDesktopWindowApi();
}

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const api = electronApi();
  if (!api) return Promise.reject(new Error('MCP is only available in the desktop app.'));
  return invokeWhenReady(api, channel, arg);
}

export const MCP_SERVERS_QUERY_KEY = 'mcpServers';

export const mcpApi = {
  list: (workspacePath?: string | null): Promise<McpListResult> =>
    invoke('pi:mcp:list', workspacePath ? { workspacePath } : {}) as Promise<McpListResult>,

  save: (request: McpSaveRequest): Promise<McpListResult> =>
    invoke('pi:mcp:save', request) as Promise<McpListResult>,

  remove: (request: McpDeleteRequest): Promise<McpListResult> =>
    invoke('pi:mcp:delete', request) as Promise<McpListResult>,

  setEnabled: (request: McpSetEnabledRequest): Promise<McpListResult> =>
    invoke('pi:mcp:set-enabled', request) as Promise<McpListResult>,

  setTrust: (request: McpSetTrustRequest): Promise<McpListResult> =>
    invoke('pi:mcp:set-trust', request) as Promise<McpListResult>,

  probe: (request: McpProbeRequest): Promise<McpProbeResult> =>
    invoke('pi:mcp:probe', request) as Promise<McpProbeResult>,
};
