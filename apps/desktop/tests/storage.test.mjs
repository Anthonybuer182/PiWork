/**
 * Storage measurement and relocation, against temp directories.
 *
 * `PI_CODING_AGENT_DIR` is what the SDK reads in `getAgentDir()`, so point it
 * at a fixture instead of the real `~/.pi/agent`; both the service's default
 * location and the config file are injected for the same reason.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from '../src/main/storage/service.ts';
import { readConfigFile, writeConfigFile } from '../src/main/storage/settings.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-storage-'));
  const agent = join(root, 'agent');
  const appData = join(root, 'appdata');
  const configFile = join(appData, 'storage.json');
  const builtin = join(root, 'builtin-agent');

  mkdirSync(join(agent, 'sessions', 'ws1'), { recursive: true });
  mkdirSync(join(agent, 'plugins'), { recursive: true });
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(agent, 'sessions', 'ws1', 's1.jsonl'), 'x'.repeat(100));
  writeFileSync(join(agent, 'plugins', 'p.json'), 'yyyy');
  writeFileSync(join(agent, 'settings.json'), '{}');

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;

  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  return {
    root,
    agent,
    appData,
    configFile,
    builtin,
    service: new StorageService(appData, configFile, builtin),
  };
}

test('info measures each area and leaves the rest as "other"', async (t) => {
  const { service } = fixture(t);
  const info = await service.info();

  assert.equal(info.agentDir, process.env.PI_CODING_AGENT_DIR);
  assert.equal(info.custom, false);
  assert.equal(info.restartRequired, false);
  assert.equal(info.pendingAgentDir, null);

  const byId = Object.fromEntries(info.entries.map((e) => [e.id, e]));
  assert.equal(byId.sessions.bytes, 100);
  assert.equal(byId.sessions.files, 1);
  assert.equal(byId.plugins.bytes, 4);
  // settings.json sits outside every measured area.
  assert.equal(byId.other.bytes, 2);
  assert.equal(info.totalBytes >= 106, true);
});

test('changing to an empty folder copies the current data', async (t) => {
  const { service, agent, configFile, root } = fixture(t);
  const target = join(root, 'new-home');

  const result = await service.change(target, true);

  assert.equal(result.usedExisting, false);
  assert.equal(result.copiedFiles, 3);
  assert.equal(readFileSync(join(target, 'sessions', 'ws1', 's1.jsonl'), 'utf8').length, 100);
  assert.equal(existsSync(join(target, 'settings.json')), true);
  // The source is left alone.
  assert.equal(existsSync(join(agent, 'settings.json')), true);

  assert.equal(readConfigFile(configFile), target);
  assert.equal(result.info.custom, true);
  assert.equal(result.info.restartRequired, true);
  assert.equal(result.info.pendingAgentDir, target);
});

test('an existing target is used as-is, never overwritten', async (t) => {
  const { service, root } = fixture(t);
  const target = join(root, 'existing');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'keep.txt'), 'mine');

  const result = await service.change(target, true);

  assert.equal(result.usedExisting, true);
  assert.equal(result.copiedFiles, 0);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(existsSync(join(target, 'settings.json')), false);
});

test('declining migration leaves the new folder empty', async (t) => {
  const { service, root } = fixture(t);
  const target = join(root, 'fresh');

  const result = await service.change(target, false);

  assert.equal(result.copiedFiles, 0);
  assert.equal(existsSync(join(target, 'sessions')), false);
});

test('the current folder and its children are rejected', async (t) => {
  const { service, agent } = fixture(t);

  await assert.rejects(() => service.change(agent, true), /已经是当前的数据位置/);
  await assert.rejects(
    () => service.change(join(agent, 'nested'), true),
    /不能放在当前的数据目录里面/,
  );
});

test('reset clears the override and copies data into an empty default', async (t) => {
  const { service, agent, builtin, configFile, root } = fixture(t);
  const target = join(root, 'new-home');
  await service.change(target, true);
  assert.equal(readConfigFile(configFile), target);

  // Change still reports from the LIVE directory (the old one) until restart.
  const result = await service.reset();

  assert.equal(readConfigFile(configFile), null);
  assert.equal(result.info.custom, false);
  // Data was copied back from the live directory into the empty default.
  assert.equal(existsSync(join(builtin, 'settings.json')), true);
  assert.equal(existsSync(join(agent, 'settings.json')), true);
});

test('a corrupt config file falls back to the default', async (t) => {
  const { service, configFile } = fixture(t);
  writeFileSync(configFile, '{not json');

  assert.equal(readConfigFile(configFile), null);
  const info = await service.info();
  assert.equal(info.custom, false);
});

test('writeConfigFile can clear the override', async (t) => {
  const { configFile } = fixture(t);
  writeConfigFile(configFile, '/some/where');
  assert.equal(readConfigFile(configFile), '/some/where');
  writeConfigFile(configFile, null);
  assert.equal(readConfigFile(configFile), null);
});
