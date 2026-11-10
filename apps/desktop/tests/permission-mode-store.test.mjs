/**
 * The global permission mode lives in pi's settings.json. pi's own saves
 * read-modify-write the file, so an app-specific key must survive them; our
 * write must likewise keep the keys pi owns.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPermissionMode, writePermissionMode } from '../src/main/permissions/mode-store.ts';

test('permission mode persists in settings.json without losing other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'permission-mode-'));
  const file = join(dir, 'settings.json');
  writeFileSync(
    file,
    JSON.stringify({ defaultProvider: 'Test', defaultModel: 'deepseek/x', theme: 'dark' }, null, 2),
  );

  assert.equal(readPermissionMode(file), 'default');
  writePermissionMode(file, 'full');

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.permissionMode, 'full');
  assert.equal(raw.defaultModel, 'deepseek/x');
  assert.equal(raw.theme, 'dark');
  assert.equal(readPermissionMode(file), 'full');

  writePermissionMode(file, 'default');
  assert.equal(readPermissionMode(file), 'default');

  rmSync(dir, { recursive: true, force: true });
});
