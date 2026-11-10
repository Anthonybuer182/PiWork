#!/usr/bin/env node
/**
 * `pnpm dev` / `npm run dev` — electron-vite dev, run from a branded Electron
 * bundle on macOS so the Dock says the product name instead of "Electron".
 *
 * See scripts/brand-dev-app.cjs for why the bundle, not app.setName(), is the
 * thing that decides that. Any arguments are forwarded to electron-vite.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const { brand } = require('./brand-dev-app.cjs');

const env = { ...process.env };
const execPath = brand();
if (execPath) env.ELECTRON_EXEC_PATH = execPath;

const bin = join(
  APP_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
);
if (!existsSync(bin)) {
  console.error(`[dev] electron-vite not installed at ${bin} — run pnpm install first`);
  process.exit(1);
}

// Electron 42+ stopped downloading its binary in `postinstall` (supply-chain
// hardening) and fetches it on the first run of the `electron` bin instead.
// electron-vite reads the binary path directly and dies with a bare
// "Electron uninstall", so fetch it here: `pnpm install && pnpm dev:desktop`
// stays one command on a fresh clone.
const electronDir = join(APP_ROOT, 'node_modules', 'electron');
if (existsSync(electronDir) && !existsSync(join(electronDir, 'path.txt'))) {
  console.log('[dev] downloading the Electron binary (first run after install)…');
  // Same mirror as electron-builder.yml: github.com releases are unreachable
  // from some networks, the npmmirror build is byte-identical. An explicit
  // ELECTRON_MIRROR still wins.
  const installEnv = {
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ...env,
  };
  const install = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
    cwd: electronDir,
    env: installEnv,
  });
  if (install.status !== 0) {
    console.error(
      '[dev] could not download the Electron binary — set ELECTRON_MIRROR (e.g. ' +
        'https://npmmirror.com/mirrors/electron/) if the GitHub release is unreachable',
    );
    process.exit(1);
  }
}

const result = spawnSync(bin, ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  // .cmd shims on Windows are not executables; everything else runs directly.
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
