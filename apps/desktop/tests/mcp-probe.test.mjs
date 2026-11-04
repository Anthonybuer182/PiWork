/**
 * Connection test against real servers: a spawned stdio child and a real
 * loopback HTTP server. No mocks — the probe must work end to end for the
 * settings page's button to mean anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeServer } from '../src/main/mcp/probe.ts';
import { startFixtureServer } from './fixtures/mcp-http-server.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const STDIO_SERVER = join(FIXTURES, 'mcp-stdio-server.mjs');

function record(overrides) {
  return {
    name: 'fixture',
    type: 'stdio',
    enabled: true,
    exposure: 'deferred',
    scope: 'global',
    ...overrides,
  };
}

test('stdio: a real child process completes the handshake and lists tools', async () => {
  const result = await probeServer(record({
    command: process.execPath,
    args: [STDIO_SERVER],
  }), process.cwd());

  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(typeof result.protocolVersion, 'string');
  assert.ok(result.tools.some((tool) => tool.name === 'echo_text'));
});

test('http: a real Streamable HTTP server completes the handshake', async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.close());

  const result = await probeServer(record({ type: 'http', url: server.url }), process.cwd());

  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.ok(result.tools.some((tool) => tool.name === 'http_echo'));
  assert.ok(server.calls.includes('initialize'));
});

test('a command that does not exist fails as a structured result, not a throw', async () => {
  const result = await probeServer(record({
    command: join(FIXTURES, 'definitely-not-a-real-binary-xyz'),
  }), process.cwd());

  assert.equal(result.ok, false);
  assert.ok(['spawn', 'network', 'protocol'].includes(result.code), `unexpected code ${result.code}`);
  assert.ok(result.message.length > 0);
});

test('an unreachable http endpoint fails as a structured result', async () => {
  const result = await probeServer(record({
    type: 'http',
    url: 'http://127.0.0.1:9/mcp',
  }), process.cwd());

  assert.equal(result.ok, false);
  assert.ok(['network', 'timeout', 'protocol'].includes(result.code), `unexpected code ${result.code}`);
});
