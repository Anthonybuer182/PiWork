/**
 * Dropping OS files onto the file tree copies them into the workspace root.
 *
 * The helper is the trust boundary for that copy: the destination is derived
 * from the workspace root only, an existing name is never overwritten, and a
 * directory that contains the workspace is refused instead of recopied into
 * itself. These run against temp directories — no Electron, no React.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFilesIntoWorkspace } from '../src/main/files/import-files.ts';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sourceFile(t, name, content) {
  const dir = tempDir(t, 'pi-import-src-');
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test('copies a regular file into the workspace root', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const source = sourceFile(t, 'a.txt', 'alpha');

  const result = await importFilesIntoWorkspace(root, [source]);

  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.imported[0].path, join(root, 'a.txt'));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha');
  // Copy, not move.
  assert.equal(existsSync(source), true);
});

test('copies a directory recursively', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const parent = tempDir(t, 'pi-import-src-');
  mkdirSync(join(parent, 'dir', 'nested'), { recursive: true });
  writeFileSync(join(parent, 'dir', 'nested', 'c.txt'), 'c');

  const result = await importFilesIntoWorkspace(root, [join(parent, 'dir')]);

  assert.equal(result.imported.length, 1);
  assert.equal(readFileSync(join(root, 'dir', 'nested', 'c.txt'), 'utf8'), 'c');
});

test('never overwrites: colliding files become name (n).ext', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  writeFileSync(join(root, 'a.txt'), 'original');
  const source = sourceFile(t, 'a.txt', 'dropped');

  await importFilesIntoWorkspace(root, [source]);
  await importFilesIntoWorkspace(root, [source]);

  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(root, 'a (1).txt'), 'utf8'), 'dropped');
  assert.equal(readFileSync(join(root, 'a (2).txt'), 'utf8'), 'dropped');
});

test('colliding directories do not get an extension split', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  mkdirSync(join(root, 'dir.v1'));
  const parent = tempDir(t, 'pi-import-src-');
  mkdirSync(join(parent, 'dir.v1'));
  writeFileSync(join(parent, 'dir.v1', 'x.txt'), 'x');

  await importFilesIntoWorkspace(root, [join(parent, 'dir.v1')]);

  assert.equal(existsSync(join(root, 'dir.v1 (1)')), true);
  assert.equal(readFileSync(join(root, 'dir.v1 (1)', 'x.txt'), 'utf8'), 'x');
});

test('hidden files keep their name when renamed', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  writeFileSync(join(root, '.env'), 'A=1');
  const source = sourceFile(t, '.env', 'B=2');

  await importFilesIntoWorkspace(root, [source]);

  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'A=1');
  assert.equal(readFileSync(join(root, '.env (1)'), 'utf8'), 'B=2');
});

test('reports a missing source and creates nothing', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const missing = join(tempDir(t, 'pi-import-src-'), 'gone.txt');

  const result = await importFilesIntoWorkspace(root, [missing]);

  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'missing');
  assert.deepEqual(readdirSync(root), []);
});

test('rejects a non-absolute source', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');

  const result = await importFilesIntoWorkspace(root, ['relative/path.txt']);

  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'invalid-source');
});

test('an entry already at the workspace root is skipped, not duplicated', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const file = join(root, 'here.txt');
  writeFileSync(file, 'here');

  const result = await importFilesIntoWorkspace(root, [file]);

  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'already-in-workspace');
  assert.equal(existsSync(join(root, 'here (1).txt')), false);
});

test('refuses a directory that contains the workspace', async (t) => {
  const parent = tempDir(t, 'pi-import-src-');
  const root = join(parent, 'workspace');
  mkdirSync(root);
  writeFileSync(join(root, 'keep.txt'), 'keep');

  const result = await importFilesIntoWorkspace(root, [parent]);

  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'destination-inside-source');
  assert.deepEqual(readdirSync(root), ['keep.txt']);
});

test('the same path twice in one drop is imported once', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const source = sourceFile(t, 'a.txt', 'alpha');

  const result = await importFilesIntoWorkspace(root, [source, source]);

  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'duplicate');
});

test('copies symlinks as links, not their targets', async (t) => {
  const root = tempDir(t, 'pi-import-ws-');
  const parent = tempDir(t, 'pi-import-src-');
  const target = join(parent, 'target.txt');
  writeFileSync(target, 'target');
  mkdirSync(join(parent, 'dir'));
  try {
    symlinkSync(target, join(parent, 'dir', 'link.txt'));
  } catch {
    t.skip('filesystem does not allow symlinks here');
    return;
  }

  const result = await importFilesIntoWorkspace(root, [join(parent, 'dir')]);

  assert.equal(result.imported.length, 1);
  assert.equal(lstatSync(join(root, 'dir', 'link.txt')).isSymbolicLink(), true);
});
