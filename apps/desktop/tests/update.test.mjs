/**
 * 设置 → 关于 → 检查更新.
 *
 * The decisions that can silently be wrong are tested away from Electron: how
 * versions order, which release asset belongs on this machine, and whether a
 * streamed download lands intact (progress, sha256, cancel).
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  normalizeVersion,
  parseDigest,
  pickAsset,
} from '../src/main/updater/release.ts';
import { UpdateService } from '../src/main/updater/service.ts';

test('normalizeVersion strips a leading tag prefix', () => {
  assert.equal(normalizeVersion('v0.2.0'), '0.2.0');
  assert.equal(normalizeVersion('V1.2.3'), '1.2.3');
  assert.equal(normalizeVersion(' 0.2.0 '), '0.2.0');
});

test('compareVersions orders releases like semver', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.1', '0.3.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  // A pre-release sorts below its final release.
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  // An unreadable tag must never be reported as an update.
  assert.equal(compareVersions('latest', '0.2.0'), 0);
});

/** The assets published alongside v0.2.0, verbatim. */
const RELEASE_ASSETS = [
  {
    name: 'pi-coding-agent-0.2.0-amd64.deb',
    browser_download_url: 'https://example.test/a.deb',
    size: 1,
  },
  {
    name: 'pi-coding-agent-0.2.0-x86_64.AppImage',
    browser_download_url: 'https://example.test/b.AppImage',
    size: 1,
  },
  {
    name: 'Pi.Coding.Agent-0.2.0-arm64-mac.zip',
    browser_download_url: 'https://example.test/c.zip',
    size: 1,
  },
  {
    name: 'Pi.Coding.Agent-0.2.0-arm64.dmg',
    browser_download_url: 'https://example.test/d.dmg',
    size: 1,
  },
  {
    name: 'Pi.Coding.Agent-0.2.0-mac.zip',
    browser_download_url: 'https://example.test/e.zip',
    size: 1,
  },
  {
    name: 'Pi.Coding.Agent-0.2.0.dmg',
    browser_download_url: 'https://example.test/f.dmg',
    size: 1,
  },
  {
    name: 'Pi.Coding.Agent.Setup.0.2.0.exe',
    browser_download_url: 'https://example.test/g.exe',
    size: 1,
  },
];

test('pickAsset chooses the installer for this platform and arch', () => {
  // Apple Silicon takes the arm64 dmg, not the x64 dmg and not the zip.
  assert.equal(
    pickAsset(RELEASE_ASSETS, 'darwin', 'arm64')?.name,
    'Pi.Coding.Agent-0.2.0-arm64.dmg',
  );
  // Intel Macs get the arch-less dmg, never the arm64 one.
  assert.equal(pickAsset(RELEASE_ASSETS, 'darwin', 'x64')?.name, 'Pi.Coding.Agent-0.2.0.dmg');
  assert.equal(pickAsset(RELEASE_ASSETS, 'win32', 'x64')?.name, 'Pi.Coding.Agent.Setup.0.2.0.exe');
  // AppImage outranks deb, and x86_64 is not mistaken for the wrong arch.
  assert.equal(
    pickAsset(RELEASE_ASSETS, 'linux', 'x64')?.name,
    'pi-coding-agent-0.2.0-x86_64.AppImage',
  );
});

test('pickAsset falls back to the arch-less build and reports unsupported formats', () => {
  // Without the X64 dmg, the arch-less zip is still a usable macOS build.
  const withoutX64Dmg = RELEASE_ASSETS.filter((a) => a.name !== 'Pi.Coding.Agent-0.2.0.dmg');
  assert.equal(pickAsset(withoutX64Dmg, 'darwin', 'x64')?.name, 'Pi.Coding.Agent-0.2.0-mac.zip');
  assert.equal(pickAsset([], 'darwin', 'arm64'), null);
});

test('parseDigest accepts sha256 digests only', () => {
  const hex = 'a'.repeat(64);
  assert.equal(parseDigest(`sha256:${hex}`), hex);
  assert.equal(parseDigest('md5:whatever'), null);
  assert.equal(parseDigest(null), null);
  assert.equal(parseDigest('sha256:not-hex'), null);
});

// ── check / download against a local release server ──

let server;
let base;
let release = null;
let releaseStatus = 200;
const payload = Buffer.alloc(256 * 1024);
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

before(async () => {
  server = createServer((req, res) => {
    if (req.url.endsWith('/releases/latest')) {
      res.statusCode = releaseStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(release ?? {}));
      return;
    }
    if (req.url === '/download/installer.dmg') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(payload.length));
      res.end(payload);
      return;
    }
    if (req.url === '/download/slow.dmg') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(payload.length));
      let offset = 0;
      const timer = setInterval(() => {
        const chunk = payload.subarray(offset, offset + 16 * 1024);
        offset += chunk.length;
        res.write(chunk);
        if (offset >= payload.length) {
          clearInterval(timer);
          res.end();
        }
      }, 10);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

function serviceFor(options = {}) {
  return new UpdateService({
    apiBase: base,
    repo: 'owner/repo',
    currentVersion: '0.2.0',
    platform: 'darwin',
    arch: 'arm64',
    ...options,
  });
}

test('check reports the newest release and the matching asset', async () => {
  releaseStatus = 200;
  release = {
    tag_name: 'v0.3.0',
    name: 'v0.3.0',
    html_url: 'https://example.test/release',
    body: '## What is new',
    published_at: '2026-01-02T03:04:05Z',
    assets: RELEASE_ASSETS,
  };

  const result = await serviceFor().check();
  assert.equal(result.error, null);
  assert.equal(result.currentVersion, '0.2.0');
  assert.equal(result.latestVersion, '0.3.0');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.asset?.name, 'Pi.Coding.Agent-0.2.0-arm64.dmg');
  assert.equal(result.notes, '## What is new');
});

test('check treats the current version as up to date', async () => {
  release = { ...release, tag_name: 'v0.2.0' };
  const result = await serviceFor().check();
  assert.equal(result.hasUpdate, false);
  assert.equal(result.asset, null);
  assert.equal(result.error, null);
});

test('check surfaces an API failure instead of throwing', async () => {
  releaseStatus = 500;
  const result = await serviceFor().check();
  assert.equal(result.hasUpdate, false);
  assert.match(result.error, /500/);

  releaseStatus = 404;
  const missing = await serviceFor().check();
  assert.match(missing.error, /没有找到发布版本/);
});

test('download writes the installer and verifies its digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piwork-update-'));
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const states = [];

  const result = await serviceFor({ downloadsDir: dir }).download(
    {
      name: 'PiWork-test.dmg',
      url: `${base}/download/installer.dmg`,
      size: payload.length,
      sha256,
    },
    (state) => states.push(state),
  );

  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(dir, 'PiWork-test.dmg')).length, payload.length);
  assert.ok(states.some((s) => s.phase === 'downloading' && s.received > 0));
  assert.equal(states.at(-1)?.phase, 'downloaded');
  assert.equal(states.at(-1)?.filePath, join(dir, 'PiWork-test.dmg'));
  rmSync(dir, { recursive: true, force: true });
});

test('download rejects a file whose digest does not match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piwork-update-'));
  const wrong = 'b'.repeat(64);

  const result = await serviceFor({ downloadsDir: dir }).download(
    {
      name: 'PiWork-test.dmg',
      url: `${base}/download/installer.dmg`,
      size: payload.length,
      sha256: wrong,
    },
    () => undefined,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /校验/);
  assert.equal(existsSync(join(dir, 'PiWork-test.dmg')), false);
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('cancel stops the download and leaves no part file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piwork-update-'));
  const service = serviceFor({ downloadsDir: dir });

  const running = service.download(
    {
      name: 'PiWork-slow.dmg',
      url: `${base}/download/slow.dmg`,
      size: payload.length,
      sha256: null,
    },
    () => undefined,
  );
  setTimeout(() => service.cancel(), 30);
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.error, null);
  assert.equal(service.snapshot().phase, 'idle');
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('install only accepts files inside the download directory', async () => {
  const result = await serviceFor({ downloadsDir: '/tmp/piwork-update-nope' }).openInstaller(
    '/etc/passwd',
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /文件不存在/);
  assert.equal(result.willQuit, false);
});

test('install hands the file to the OS and quits first on macOS/Windows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piwork-update-'));
  const file = join(dir, 'PiWork-9.9.9.dmg');
  writeFileSync(file, 'installer');

  // The running app must be gone before the installer replaces it.
  const mac = await serviceFor({ downloadsDir: dir }).openInstaller(file);
  assert.equal(mac.ok, true);
  assert.equal(mac.willQuit, true);

  // Linux opens the file but never quits the running app.
  const linux = await serviceFor({ downloadsDir: dir, platform: 'linux' }).openInstaller(file);
  assert.equal(linux.ok, true);
  assert.equal(linux.willQuit, false);

  rmSync(dir, { recursive: true, force: true });
});
