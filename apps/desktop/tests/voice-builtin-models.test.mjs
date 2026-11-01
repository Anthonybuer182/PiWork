/**
 * Built-in model catalog and the streaming downloader (mocked fetch).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_MODELS,
  isBuiltinModelId,
  isInstalledAt,
  modelTotalBytes,
  modelUrls,
} from '../src/main/voice/builtin/models.ts';
import { downloadToFile } from '../src/main/voice/builtin/downloader.ts';
import { VoiceModelManager } from '../src/main/voice/builtin/model-manager.ts';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-voice-model-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('catalog sizes and mirror-first URLs', () => {
  assert.equal(modelTotalBytes(BUILTIN_MODELS.sensevoice), 239_233_841 + 315_894);
  assert.equal(modelTotalBytes(BUILTIN_MODELS['melo-int8']), 72_188_679);
  const file = BUILTIN_MODELS.sensevoice.files[0];
  const urls = modelUrls(BUILTIN_MODELS.sensevoice, file);
  assert.match(urls[0], /^https:\/\/hf-mirror\.com\/csukuangfj\//);
  assert.match(urls[1], /^https:\/\/huggingface\.co\/csukuangfj\//);
  assert.match(urls[0], /model\.int8\.onnx\?download=true$/);
  assert.ok(isBuiltinModelId('sensevoice'));
  assert.ok(!isBuiltinModelId('nope'));
});

test('every model file carries a SHA-256 checksum', () => {
  for (const spec of Object.values(BUILTIN_MODELS)) {
    for (const file of spec.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${spec.id}/${file.name}`);
    }
  }
});

test('installed requires every file at the exact size', (t) => {
  const dir = tempDir(t);
  const spec = BUILTIN_MODELS.sensevoice;
  const sizes = new Map(spec.files.map((f) => [join(dir, f.name), { size: f.size }]));
  const stat = (path) => {
    const hit = sizes.get(path);
    if (!hit) throw new Error('ENOENT');
    return hit;
  };
  assert.equal(isInstalledAt(dir, spec, stat), true);
  sizes.set(join(dir, spec.files[0].name), { size: spec.files[0].size - 1 });
  assert.equal(isInstalledAt(dir, spec, stat), false);
});

test('downloads, verifies size and hash, and leaves no .part file', async (t) => {
  const dir = tempDir(t);
  const dest = join(dir, 'model.bin');
  const payload = Buffer.from('hello-voice-model');
  const progress = [];

  const size = await downloadToFile({
    urls: ['https://example.test/model.bin'],
    destPath: dest,
    expectedBytes: payload.length,
    expectedSha256: createHash('sha256').update(payload).digest('hex'),
    signal: new AbortController().signal,
    fetchImpl: async () => new Response(payload, { status: 200 }),
    onProgress: (received) => progress.push(received),
  });

  assert.equal(size, payload.length);
  assert.equal(statSync(dest).size, payload.length);
  assert.ok(!existsSync(`${dest}.part`));
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1), payload.length);
});

test('a size mismatch rejects and removes the part file', async (t) => {
  const dir = tempDir(t);
  const dest = join(dir, 'model.bin');
  await assert.rejects(
    downloadToFile({
      urls: ['https://example.test/model.bin'],
      destPath: dest,
      expectedBytes: 100,
      expectedSha256: '0'.repeat(64),
      signal: new AbortController().signal,
      fetchImpl: async () => new Response(Buffer.from('short'), { status: 200 }),
    }),
    /大小不符/,
  );
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});

test('the next host is tried when the first fails', async (t) => {
  const dir = tempDir(t);
  const dest = join(dir, 'model.bin');
  const calls = [];
  const payload = Buffer.from('fallback-content');
  const size = await downloadToFile({
    urls: ['https://mirror.test/x', 'https://upstream.test/x'],
    destPath: dest,
    expectedBytes: payload.length,
    expectedSha256: createHash('sha256').update(payload).digest('hex'),
    signal: new AbortController().signal,
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes('mirror')) return new Response('nope', { status: 503 });
      return new Response(payload, { status: 200 });
    },
  });
  assert.equal(size, payload.length);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /mirror/);
});

test('a hash mismatch rejects and tries the next host', async (t) => {
  const dir = tempDir(t);
  const dest = join(dir, 'model.bin');
  const payload = Buffer.from('tampered');
  const good = Buffer.from('tampered');
  const calls = [];
  await assert.rejects(
    downloadToFile({
      urls: ['https://a.test/x', 'https://b.test/x'],
      destPath: dest,
      expectedBytes: good.length,
      expectedSha256: createHash('sha256').update('original').digest('hex'),
      signal: new AbortController().signal,
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(payload, { status: 200 });
      },
    }),
    /SHA-256/,
  );
  assert.equal(calls.length, 2);
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});

test('deleting a model evicts the worker before removing files', async (t) => {
  const root = tempDir(t);
  const dir = join(root, 'melo-int8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.int8.onnx'), 'x');
  const order = [];
  const manager = new VoiceModelManager(root, {
    onDeleted: async (id) => {
      order.push(`evict:${id}:exists=${existsSync(dir)}`);
    },
  });
  await manager.delete('melo-int8');
  assert.deepEqual(order, ['evict:melo-int8:exists=true']);
  assert.ok(!existsSync(dir));
});

test('the production http(s) path follows redirects and reports HTTP errors', async (t) => {
  const dir = tempDir(t);
  const payload = Buffer.from('real-http-download');
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    if (req.url === '/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const dest = join(dir, 'model.bin');
  const size = await downloadToFile({
    urls: [`${base}/redirect`],
    destPath: dest,
    expectedBytes: payload.length,
    expectedSha256: createHash('sha256').update(payload).digest('hex'),
    signal: new AbortController().signal,
  });
  assert.equal(size, payload.length);
  assert.equal(statSync(dest).size, payload.length);

  await assert.rejects(
    downloadToFile({
      urls: [`${base}/missing`],
      destPath: join(dir, 'missing.bin'),
      expectedBytes: 1,
      expectedSha256: '0'.repeat(64),
      signal: new AbortController().signal,
    }),
    /HTTP 404/,
  );
});

test('abort stops the download and leaves no files', async (t) => {
  const dir = tempDir(t);
  const dest = join(dir, 'model.bin');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadToFile({
      urls: ['https://example.test/model.bin'],
      destPath: dest,
      expectedBytes: 10,
      expectedSha256: '0'.repeat(64),
      signal: controller.signal,
      fetchImpl: async () => new Response(Buffer.alloc(10), { status: 200 }),
    }),
  );
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});
