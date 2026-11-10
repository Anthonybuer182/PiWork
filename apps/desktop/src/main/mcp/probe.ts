/**
 * "Test connection" for the settings page.
 *
 * A one-shot MCP handshake using the same client library the runtime uses
 * (`@earendil-works/pi-mcp`), so a successful probe means the saved record is
 * actually usable. It never registers anything: the transport is created,
 * initialized, asked for its tool list, and closed.
 *
 * Timeouts are enforced here rather than relied on from the client, because a
 * server that accepts the socket but never answers `initialize` still needs to
 * end the UI's spinner.
 */

import {
  McpClient,
  McpAuthRequiredError,
  McpConnectionClosedError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
} from '@earendil-works/pi-mcp';
import type { McpProbeErrorCode, McpProbeResult, McpServerRecord } from '@pi/types';

const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function classify(error: unknown): { code: McpProbeErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof McpTimeoutError) return { code: 'timeout', message };
  if (error instanceof McpAuthRequiredError || error instanceof McpSessionExpiredError) {
    return { code: 'auth', message };
  }
  if (error instanceof McpHttpError) {
    return { code: error.status === 401 || error.status === 403 ? 'auth' : 'network', message };
  }
  if (error instanceof McpConnectionClosedError) return { code: 'protocol', message };
  // Spawn failures surface as plain Node errors (ENOENT, EACCES, …).
  if (/\bENOENT\b|\bEACCES\b|not found|spawn/i.test(message)) {
    return { code: 'spawn', message };
  }
  if (/timeout|timed out|abort|超时/i.test(message)) return { code: 'timeout', message };
  return { code: 'protocol', message };
}

export async function probeServer(record: McpServerRecord, cwd: string): Promise<McpProbeResult> {
  if (record.type === 'http' && !record.url) {
    return { ok: false, code: 'invalid', message: '缺少 url。' };
  }
  if (record.type === 'stdio' && !record.command) {
    return { ok: false, code: 'invalid', message: '缺少 command。' };
  }

  let transport;
  try {
    transport = record.type === 'http'
      ? new StreamableHttpTransport({
          url: record.url!,
          ...(record.headers ? { headers: record.headers } : {}),
        })
      : new StdioTransport({
          command: record.command!,
          ...(record.args ? { args: record.args } : {}),
          ...(record.env ? { env: record.env } : {}),
          cwd: record.cwd ?? cwd,
          stderr: 'pipe',
          maxStderrBytes: 2_000,
          closeTimeoutMs: 1_500,
        });
  } catch (error) {
    const { code, message } = classify(error);
    return { ok: false, code: code === 'protocol' ? 'invalid' : code, message };
  }

  const client = new McpClient({
    name: 'piwork',
    version: '0.2.0',
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });

  try {
    const init = await withTimeout(
      client.connect(transport),
      PROBE_TIMEOUT_MS,
      `连接超时（${PROBE_TIMEOUT_MS / 1000} 秒内没有完成握手）`,
    );
    const tools = await withTimeout(
      client.listTools({ timeoutMs: PROBE_TIMEOUT_MS }),
      PROBE_TIMEOUT_MS,
      `获取工具列表超时（${PROBE_TIMEOUT_MS / 1000} 秒）`,
    );
    return {
      ok: true,
      protocolVersion: init.protocolVersion ?? client.protocolVersion ?? 'unknown',
      ...(init.serverInfo
        ? { serverInfo: { name: init.serverInfo.name, version: init.serverInfo.version } }
        : {}),
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      })),
    };
  } catch (error) {
    const { code, message } = classify(error);
    return { ok: false, code, message };
  } finally {
    try {
      await client.close();
    } catch { /* best-effort */ }
  }
}
