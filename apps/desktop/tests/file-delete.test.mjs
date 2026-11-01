/**
 * The file service is the trust boundary for deletion: the renderer hands it a
 * workspace root and an absolute target. Everything outside the workspace, the
 * root itself, and paths that escape through a symlinked ancestor must be
 * refused; a target that is already gone is a success.
 *
 * These run against the real adapter with temp directories — no Electron, no
 * React. The renderer-side behavior (dialog, cache refresh) is covered by the
 * manual check in the plan.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { createRealFileService } from '../../../packages/sdk-wrapper/src/adapters/file.ts';

const service = createRealFileService();

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-file-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function trySymlink(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    t.skip('filesystem does not allow symlinks here');
    return false;
  }
}

test('deletes a regular file', async (t) => {
  const root = workspace(t);
  const file = join(root, 'a.txt');
  writeFileSync(file, 'alpha');

  await service.delete(root, file);

  assert.equal(existsSync(file), false);
  assert.equal(existsSync(root), true);
});

test('deletes a directory recursively', async (t) => {
  const root = workspace(t);
  const dir = join(root, 'dir');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'c.txt'), 'c');

  await service.delete(root, dir);

  assert.equal(existsSync(dir), false);
});
test('refuses to delete the workspace root itself', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'keep.txt'), 'keep');

  await assert.rejects(() => service.delete(root, root));
  await assert.rejects(() => service.delete(root, root + sep));

  assert.equal(existsSync(join(root, 'keep.txt')), true);
});

test('refuses a target outside the workspace', async (t) => {
  const root = workspace(t);
  const outside = mkdtempSync(join(tmpdir(), 'pi-file-delete-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'outside');

  await assert.rejects(() => service.delete(root, victim));
  // Same target reached with a `..` segment.
  await assert.rejects(() =>
    service.delete(root, join(root, '..', basename(outside), 'victim.txt')),
  );

  assert.equal(existsSync(victim), true);
});

test('refuses a sibling directory that only shares a name prefix', async (t) => {
  const root = workspace(t);
  const sibling = `${root}-evil`;
  mkdirSync(sibling);
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  const victim = join(sibling, 'victim.txt');
  writeFileSync(victim, 'outside');

  await assert.rejects(() => service.delete(root, victim));

  assert.equal(existsSync(victim), true);
});

test('a missing target is an idempotent success', async (t) => {
  const root = workspace(t);

  await service.delete(root, join(root, 'nope.txt'));
  await service.delete(root, join(root, 'no-such-dir', 'nested.txt'));

  assert.equal(existsSync(root), true);
});

test('deleting a symlink removes the link, not its target', async (t) => {
  const root = workspace(t);
  const outside = mkdtempSync(join(tmpdir(), 'pi-file-link-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const target = join(outside, 'real.txt');
  writeFileSync(target, 'real');
  const link = join(root, 'link.txt');
  if (!trySymlink(t, target, link, 'file')) return;

  await service.delete(root, link);

  assert.equal(existsSync(link), false);
  assert.equal(existsSync(target), true);
});

test('refuses to delete through a symlinked ancestor outside the workspace', async (t) => {
  const root = workspace(t);
  const outside = mkdtempSync(join(tmpdir(), 'pi-file-escape-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'outside');
  const escape = join(root, 'escape');
  if (!trySymlink(t, outside, escape, 'dir')) return;

  await assert.rejects(() => service.delete(root, join(escape, 'victim.txt')));

  assert.equal(existsSync(victim), true);
});
