/**
 * Proxy rules and their little settings file.
 *
 * The translation from "what someone typed" to "what Chromium's setProxy and
 * undici's dispatcher each want" is the part that can silently be wrong, so
 * it is tested away from Electron and the network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromiumProxyConfig,
  effectiveProxy,
  normalizeProxyUrl,
  parseResolvedProxy,
  sanitizeProxySettings,
} from '../src/main/network/rules.ts';
import { readProxySettings, writeProxySettings } from '../src/main/network/settings.ts';

const SYSTEM = { mode: 'system', url: '' };

test('normalizeProxyUrl reads addresses the way people type them', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('  http://127.0.0.1:7897  '), 'http://127.0.0.1:7897');
  assert.equal(
    normalizeProxyUrl('https://proxy.example.com:8443'),
    'https://proxy.example.com:8443',
  );
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');

  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl('not a proxy'), null);
  // No prompt exists for proxy auth, so an address that needs it is refused
  // rather than accepted and answered with 407.
  assert.equal(normalizeProxyUrl('http://user:pass@127.0.0.1:7897'), null);
  assert.equal(normalizeProxyUrl('ftp://127.0.0.1:21'), null);
  // A host with no port is a legal proxy (port 80); it is left alone.
  assert.equal(normalizeProxyUrl('proxy.corp.internal'), 'http://proxy.corp.internal');
});

test('a manual choice needs a usable address', () => {
  assert.deepEqual(sanitizeProxySettings({ mode: 'manual', url: '127.0.0.1:7897' }, SYSTEM), {
    mode: 'manual',
    url: 'http://127.0.0.1:7897',
  });
  assert.throws(() => sanitizeProxySettings({ mode: 'manual' }, SYSTEM), /请填一个代理地址/);
  assert.throws(
    () => sanitizeProxySettings({ mode: 'manual', url: 'not a proxy' }, SYSTEM),
    /看不懂/,
  );
  assert.throws(() => sanitizeProxySettings({ mode: 'turbo' }, SYSTEM), /不认识的连接方式/);
});

test('leaving manual keeps the address for next time', () => {
  const manual = { mode: 'manual', url: 'http://127.0.0.1:7897' };
  assert.deepEqual(sanitizeProxySettings({ mode: 'direct' }, manual), {
    mode: 'direct',
    url: 'http://127.0.0.1:7897',
  });
  // A patch without fields changes nothing.
  assert.deepEqual(sanitizeProxySettings({}, manual), manual);
});

test('chromiumProxyConfig maps each mode to setProxy', () => {
  assert.deepEqual(chromiumProxyConfig({ mode: 'direct', url: '' }), { mode: 'direct' });
  assert.deepEqual(chromiumProxyConfig(SYSTEM), { mode: 'system' });
  assert.deepEqual(chromiumProxyConfig({ mode: 'manual', url: 'http://127.0.0.1:7897' }), {
    mode: 'fixed_servers',
    proxyRules: '127.0.0.1:7897',
  });
  // SOCKS has to name its version.
  assert.deepEqual(chromiumProxyConfig({ mode: 'manual', url: 'socks5://127.0.0.1:1080' }), {
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:1080',
  });
  // A hand-edited file must not leave Chromium without a route.
  assert.deepEqual(chromiumProxyConfig({ mode: 'manual', url: 'not a proxy' }), {
    mode: 'system',
  });
});

test('parseResolvedProxy reads the first entry, which is the one used', () => {
  assert.equal(parseResolvedProxy('DIRECT'), null);
  assert.equal(parseResolvedProxy('PROXY 127.0.0.1:7897; DIRECT'), 'http://127.0.0.1:7897');
  assert.equal(parseResolvedProxy('DIRECT; PROXY 127.0.0.1:7897'), null);
  assert.equal(parseResolvedProxy('SOCKS5 127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(parseResolvedProxy(''), null);
});

test('effectiveProxy follows the mode, not the stale system answer', () => {
  const system = { mode: 'system', url: '' };
  const manual = { mode: 'manual', url: '127.0.0.1:7897' };
  assert.equal(effectiveProxy(system, 'http://10.0.0.1:3128'), 'http://10.0.0.1:3128');
  assert.equal(effectiveProxy(system, null), null);
  assert.equal(
    effectiveProxy({ mode: 'direct', url: '127.0.0.1:7897' }, 'http://10.0.0.1:3128'),
    null,
  );
  assert.equal(effectiveProxy(manual, 'http://10.0.0.1:3128'), 'http://127.0.0.1:7897');
});

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-network-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'network.json');
}

test('settings round-trip through network.json', (t) => {
  const file = tempFile(t);
  assert.deepEqual(readProxySettings(file), SYSTEM);

  writeProxySettings(file, { mode: 'manual', url: 'http://127.0.0.1:7897' });
  assert.deepEqual(readProxySettings(file), { mode: 'manual', url: 'http://127.0.0.1:7897' });
});

test('an unreadable file falls back to the system proxy', (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{not json');
  assert.deepEqual(readProxySettings(file), SYSTEM);

  writeFileSync(file, JSON.stringify({ version: 99, mode: 'manual', url: '127.0.0.1:7897' }));
  assert.deepEqual(readProxySettings(file), SYSTEM);

  // A saved manual mode whose address no longer parses is not a route.
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'manual', url: 'not a proxy' }));
  assert.deepEqual(readProxySettings(file), SYSTEM);
});
