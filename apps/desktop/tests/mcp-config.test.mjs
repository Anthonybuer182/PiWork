/**
 * MCP config store: pi-compatible files, scope merging, limits, and the
 * guarantee that a broken file never takes the app down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpConfigStore, parseServerRecord } from '../src/main/mcp/config-store.ts';

function setup(t) {
  const agent = mkdtempSync(join(tmpdir(), 'pi-mcp-config-'));
  t.after(() => rmSync(agent, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const workspace = join(agent, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new McpConfigStore({ agentDir: agent, trustPath: join(agent, 'trust.json') });
  return { agent, workspace, store, config: join(agent, 'mcp.json') };
}

function writeConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

test('a legacy pi config loads and exposure is normalized for tool_search', (t) => {
  const { store, config } = setup(t);
  writeConfig(config, { mcpServers: { legacy: { command: 'node' } } });

  const list = store.list();
  assert.equal(list.global.length, 1);
  assert.equal(list.global[0].name, 'legacy');
  // pi defaults to `codemode`, which tool_search never sees.
  assert.equal(list.global[0].exposure, 'deferred');
  assert.deepEqual(list.diagnostics, []);
});

test('hidden exposure survives normalization', (t) => {
  const { store, config } = setup(t);
  writeConfig(config, { mcpServers: { quiet: { command: 'node', exposure: 'hidden' } } });
  assert.equal(store.list().global[0].exposure, 'hidden');
});

test('saving preserves unknown top-level and per-record fields', (t) => {
  const { store, config } = setup(t);
  writeConfig(config, {
    mcpServers: {
      existing: { command: 'node', oauth: { clientId: 'abc' } },
    },
    autoEnableCodemode: true,
  });

  store.save({
    scope: 'global',
    server: { name: 'added', type: 'stdio', command: 'npx', enabled: true, exposure: 'deferred' },
  });

  const written = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(written.version, 1);
  // PiWork's own fields must not leak into the pi-compatible file.
  assert.equal(written.mcpServers.added.name, undefined);
  assert.equal(written.mcpServers.added.scope, undefined);
  assert.equal(written.mcpServers.added.override, undefined);
  assert.equal(written.autoEnableCodemode, true, 'unknown top-level key must survive');
  assert.deepEqual(written.mcpServers.existing.oauth, { clientId: 'abc' });
  assert.equal(written.mcpServers.added.command, 'npx');
});

test('an override-only project record patches enabled without a transport', (t) => {
  const { store, workspace, config } = setup(t);
  writeConfig(config, { mcpServers: { globalOne: { command: 'node' } } });
  writeConfig(join(workspace, '.pi', 'mcp.json'), { mcpServers: { globalOne: { enabled: false } } });

  store.setWorkspaceTrusted(workspace, true);
  const loaded = store.loadForSession(workspace);
  assert.equal(loaded.servers.length, 1);
  assert.equal(loaded.servers[0].config.enabled, false);
  assert.equal(loaded.servers[0].config.command, 'node', 'the global command is inherited');
});

test('project servers only load for a trusted workspace', (t) => {
  const { store, workspace, config } = setup(t);
  writeConfig(config, { mcpServers: { a: { command: 'node' }, b: { command: 'node' } } });
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  writeConfig(join(workspace, '.pi', 'mcp.json'), { mcpServers: { c: { command: 'node' } } });

  const untrusted = store.loadForSession(workspace);
  assert.deepEqual(untrusted.servers.map((server) => server.name).sort(), ['a', 'b']);

  store.setWorkspaceTrusted(workspace, true);
  const trusted = store.loadForSession(workspace);
  assert.deepEqual(trusted.servers.map((server) => server.name).sort(), ['a', 'b', 'c']);
  assert.equal(store.hasEnabledServers(workspace), true);
});

test('limits reject oversized records', () => {
  const tooManyArgs = parseServerRecord('s', {
    command: 'node',
    args: Array.from({ length: 65 }, (_, index) => `--flag-${index}`),
  }, 'global');
  assert.ok(tooManyArgs.error?.includes('args'));

  const tooManyHeaders = parseServerRecord('s', {
    url: 'https://example.com/mcp',
    headers: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-${index}`, 'v'])),
  }, 'global');
  assert.ok(tooManyHeaders.error?.includes('headers'));

  const oversizedValue = parseServerRecord('s', {
    command: 'node',
    env: { BIG: 'x'.repeat(4097) },
  }, 'global');
  assert.ok(oversizedValue.error);

  const badName = parseServerRecord('bad name!', { command: 'node' }, 'global');
  assert.ok(badName.error?.includes('服务器名'));

  const bothTransports = parseServerRecord('s', { command: 'node', url: 'https://x/y' }, 'global');
  assert.ok(bothTransports.error?.includes('command'));
});

test('names that collide after sanitizing are rejected on save', (t) => {
  const { store } = setup(t);
  store.save({
    scope: 'global',
    server: { name: 'my-server', type: 'stdio', command: 'node', enabled: true, exposure: 'deferred' },
  });
  assert.throws(
    () => store.save({
      scope: 'global',
      server: { name: 'my_server', type: 'stdio', command: 'node', enabled: true, exposure: 'deferred' },
    }),
    /命名空间/,
  );
});

test('a broken file reports diagnostics instead of throwing', (t) => {
  const { store, config } = setup(t);
  writeConfig(config, '{"mcpServers": {broken');
  const list = store.list();
  assert.deepEqual(list.global, []);
  assert.equal(list.diagnostics.length, 1);
});

test('remove and setEnabled rewrite only the target entry', (t) => {
  const { store, config } = setup(t);
  writeConfig(config, { mcpServers: { keep: { command: 'node' }, drop: { command: 'node' } } });

  store.setEnabled({ scope: 'global', name: 'keep', enabled: false });
  let written = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(written.mcpServers.keep.enabled, false);

  store.remove({ scope: 'global', name: 'drop' });
  written = JSON.parse(readFileSync(config, 'utf8'));
  assert.deepEqual(Object.keys(written.mcpServers), ['keep']);
});
