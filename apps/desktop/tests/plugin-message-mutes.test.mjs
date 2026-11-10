/**
 * Per-plugin plugin-message mute preference: host-owned, persisted in
 * userData, and readable by a fresh service instance (the app restart case).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginMessageSettingsService } from '../src/main/preferences/plugin-messages.ts';

test('mute list is persisted and round-trips through a new instance', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-plugin-mutes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'plugin-messages.json');

  const service = new PluginMessageSettingsService(file);
  assert.deepEqual(service.listMuted(), []);

  assert.deepEqual(service.setMuted('com.pi.mail', true), ['com.pi.mail']);
  assert.deepEqual(service.setMuted('com.pi.news', true), ['com.pi.mail', 'com.pi.news']);
  assert.deepEqual(service.setMuted('com.pi.mail', false), ['com.pi.news']);

  const reloaded = new PluginMessageSettingsService(file);
  assert.deepEqual(reloaded.listMuted(), ['com.pi.news']);

  assert.throws(() => service.setMuted('', true), /pluginId is required/);
});
