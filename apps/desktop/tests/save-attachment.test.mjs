/**
 * Composer attachments are copied into `<workspace>/.piwork/attachments/`
 * before the message is sent: the card can preview them, a reload finds them,
 * and the model gets a workspace path instead of a bare file name.
 *
 * The host owns the destination — the renderer only supplies a source path
 * and a name — so these tests also pin down name sanitizing and collision
 * handling.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAttachmentIntoWorkspace } from '../src/main/files/save-attachment.ts';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function workspace(t) {
  return tempDir(t, 'pi-attach-ws-');
}

function sourceFile(t, name, content) {
  const dir = tempDir(t, 'pi-attach-src-');
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test('copies a picked file into the workspace attachment folder', async (t) => {
  const root = workspace(t);
  const source = sourceFile(t, 'SEP052023_01D17214.pdf', 'pdf-bytes');

  const saved = await saveAttachmentIntoWorkspace(root, {
    sourcePath: source,
    name: 'SEP052023_01D17214.pdf',
  });

  assert.equal(saved.name, 'SEP052023_01D17214.pdf');
  assert.equal(saved.relativePath, '.piwork/attachments/SEP052023_01D17214.pdf');
  assert.equal(saved.path, join(root, '.piwork', 'attachments', 'SEP052023_01D17214.pdf'));
  assert.equal(readFileSync(saved.path, 'utf8'), 'pdf-bytes');
});

test('a repeated name is never overwritten', async (t) => {
  const root = workspace(t);
  const first = sourceFile(t, 'notes.txt', 'first');
  const second = sourceFile(t, 'notes.txt', 'second');

  const a = await saveAttachmentIntoWorkspace(root, { sourcePath: first, name: 'notes.txt' });
  const b = await saveAttachmentIntoWorkspace(root, { sourcePath: second, name: 'notes.txt' });

  assert.equal(a.name, 'notes.txt');
  assert.equal(b.name, 'notes (1).txt');
  assert.equal(b.relativePath, '.piwork/attachments/notes (1).txt');
  assert.equal(readFileSync(a.path, 'utf8'), 'first');
  assert.equal(readFileSync(b.path, 'utf8'), 'second');
});

test('falls back to base64 when there is no OS path (web/generated files)', async (t) => {
  const root = workspace(t);
  const saved = await saveAttachmentIntoWorkspace(root, {
    name: 'hello.txt',
    dataBase64: Buffer.from('hello from base64').toString('base64'),
  });
  assert.equal(readFileSync(saved.path, 'utf8'), 'hello from base64');
});

test('sanitizes traversal names and keeps the file inside the attachment folder', async (t) => {
  const root = workspace(t);
  const source = sourceFile(t, 'evil.pdf', 'x');
  const saved = await saveAttachmentIntoWorkspace(root, {
    sourcePath: source,
    name: '../../evil.pdf',
  });
  assert.equal(saved.name, 'evil.pdf');
  assert.equal(saved.path, join(root, '.piwork', 'attachments', 'evil.pdf'));
});

test('rejects relative and missing sources', async (t) => {
  const root = workspace(t);
  await assert.rejects(
    saveAttachmentIntoWorkspace(root, { name: 'a.pdf', sourcePath: 'relative/a.pdf' }),
    /absolute path/,
  );
  await assert.rejects(
    saveAttachmentIntoWorkspace(root, { name: 'a.pdf', sourcePath: join(root, 'missing.pdf') }),
    /not a file/,
  );
  await assert.rejects(
    saveAttachmentIntoWorkspace(root, { name: 'a.pdf' }),
    /no file source/,
  );
});

test('reusing a file already in the attachment folder does not duplicate it', async (t) => {
  const root = workspace(t);
  const dir = join(root, '.piwork', 'attachments');
  mkdirSync(dir, { recursive: true });
  const existing = join(dir, 'report.pdf');
  writeFileSync(existing, 'already here');

  const saved = await saveAttachmentIntoWorkspace(root, {
    sourcePath: existing,
    name: 'report.pdf',
  });
  assert.equal(saved.path, existing);
  assert.equal(saved.relativePath, '.piwork/attachments/report.pdf');
  assert.equal(existsSync(join(dir, 'report (1).pdf')), false);
});

test('a file already in the workspace is referenced in place', async (t) => {
  const root = workspace(t);
  const nested = join(root, 'docs');
  mkdirSync(nested, { recursive: true });
  const existing = join(nested, 'spec.md');
  writeFileSync(existing, '# spec');

  const saved = await saveAttachmentIntoWorkspace(root, {
    sourcePath: existing,
    name: 'spec.md',
  });
  assert.equal(saved.path, existing);
  assert.equal(saved.relativePath, 'docs/spec.md');
  assert.equal(existsSync(join(root, '.piwork', 'attachments')), false);
});
