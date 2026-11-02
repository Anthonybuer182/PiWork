#!/usr/bin/env node
/**
 * Build the first-party plugins and pack them into a market index.
 *
 * `plugins/` is not a pnpm workspace member, so `pnpm install` never touches
 * it and `plugins/*\/ui-dist` (the panel bundles) are gitignored build output.
 * A clean checkout therefore cannot run `build-market.mjs` until each plugin's
 * own dependencies are installed and its panel is built — which is what this
 * does, in the order that works:
 *
 *   1. each plugin's `npm ci`
 *   2. each plugin's `npm run build` (skipped for UI-only plugins with no
 *      package.json, like com.pi.devdocs)
 *   3. `scripts/build-market.mjs`
 *
 * Used by the release workflow from two places: the shared `market` job, and
 * the Windows packaging job, which builds its own copy instead of downloading
 * the artifact (large files extracted from an artifact get locked by the
 * runner's real-time protection, which makes electron-builder fail with EBUSY
 * while copying them into resources/market/).
 *
 * Usage: node scripts/ci-build-market.mjs <out-dir>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = join(REPO, 'plugins');

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/ci-build-market.mjs <out-dir>');
  process.exit(2);
}

/** Every directory under plugins/ that carries a package.json. */
function packages() {
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PLUGINS, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
}

function hasBuildScript(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGINS, dir, 'package.json'), 'utf-8'));
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}

function run(cmd, args, cwd, label) {
  console.log(`::group::${label}`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  console.log('::endgroup::');
  if (res.status !== 0) {
    console.error(`${label} failed with exit code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

const dirs = packages();
if (dirs.length === 0) {
  console.error('no plugins with a package.json found');
  process.exit(1);
}
console.log(`plugins: ${dirs.join(', ')}`);

for (const dir of dirs) run('npm', ['ci', '--no-audit', '--no-fund'], join(PLUGINS, dir), `npm ci plugins/${dir}`);

for (const dir of dirs) {
  if (hasBuildScript(dir)) run('npm', ['run', 'build'], join(PLUGINS, dir), `npm run build plugins/${dir}`);
}

run('node', ['scripts/build-market.mjs', '--skip-state', '--out', out], REPO, 'build-market');
