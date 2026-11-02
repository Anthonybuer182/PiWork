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

const result = spawnSync(bin, ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  // .cmd shims on Windows are not executables; everything else runs directly.
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
