/**
 * Minimal MCP server over stdio, for integration tests.
 *
 * Newline-delimited JSON-RPC: initialize, tools/list, tools/call. It records
 * lifecycle events in `MCP_FIXTURE_STATE` when set, so a test can prove the
 * child was started (and stopped) rather than trusting a mock.
 */

import { appendFileSync } from 'node:fs';

const stateFile = process.env.MCP_FIXTURE_STATE;
function record(event) {
  if (!stateFile) return;
  try {
    appendFileSync(stateFile, `${event} ${process.pid}\n`);
  } catch { /* diagnostics only */ }
}

record('start');

const TOOLS = [
  {
    name: 'echo_text',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'env_keys',
    description: 'List the names of the environment variables the server runs with.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});

process.stdin.on('end', () => {
  record('stdin-end');
  process.exit(0);
});
process.on('SIGTERM', () => {
  record('sigterm');
  process.exit(0);
});

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'piwork-stdio-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') {
    record('initialized');
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    record(`call ${message.params?.name}`);
    const name = message.params?.name;
    if (name === 'env_keys') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
}
