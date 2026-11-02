#!/usr/bin/env node
/**
 * One command from a fresh clone to a runnable dev tree.
 *
 * Why this exists: `plugins/` is not a pnpm workspace member (see
 * pnpm-workspace.yaml — it lists only `packages/*` and `apps/*`), so neither
 * `pnpm install` nor `turbo run build` touches it. Each plugin is its own npm
 * project with its own package-lock.json, and two of them have a panel entry
 * (`./ui-dist/panel/index.html`) that is a build output, gitignored by the
 * plugin's own .gitignore. A clone that skips those steps gets five plugins
 * that silently do not appear — the panel entry resolves to a missing file.
 *
 * Usage:  node scripts/setup.mjs [--market] [--force]
 *   --market  also build the local plugin market (scripts/build-market.mjs)
 *             and point ~/.pi/agent/plugins/_state.json at it. The market is
 *             built with stamped dev versions, so the plugin center shows
 *             them as updates with a rollback copy. This step *installs
 *             nothing* — install/update through the plugin center (the
 *             customer path, `pnpm dev:desktop`) or `pnpm plugins:publish
 *             --install`.
 *   --force   rebuild every plugin even if its outputs are already present
 *
 * Run modes afterwards:
 *   pnpm dev:desktop          customer path — loads ~/.pi/agent/plugins
 *   pnpm dev:desktop:plugins  plugin authoring — loads this checkout's plugins/
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(REPO, 'plugins');
const isWin = process.platform === 'win32';
const PNPM = isWin ? 'pnpm.cmd' : 'pnpm';
const NPM = isWin ? 'npm.cmd' : 'npm';
const NODE = process.execPath;

const WANT_MARKET = process.argv.includes('--market');
const FORCE = process.argv.includes('--force');

const failures = [];

function step(label) {
  console.log(`\n━━━ ${label}`);
}

function note(msg) {
  console.log(`[setup] ${msg}`);
}

/** Run a command to completion, inheriting stdio so the user sees real output. */
function run(cmd, args, cwd) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd, env: process.env });
    child.on('error', (err) => {
      console.error(`[setup] failed to spawn ${cmd}: ${err.message}`);
      done(1);
    });
    child.on('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

/** Record a failed step and keep going where that is safe. */
function record(label, code) {
  if (code !== 0) {
    console.error(`[setup] ✗ ${label} (exit ${code})`);
    failures.push(label);
  }
  return code;
}

function hasBuildScript(pluginDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf-8'));
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}

/** A plugin is any dir directly under plugins/ carrying a manifest.json. */
function discoverPlugins() {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ id: e.name, dir: join(PLUGINS_DIR, e.name) }))
    .filter((p) => existsSync(join(p.dir, 'manifest.json')))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The panel-body build is the slow one and the one a clone is missing. */
function needsBuild(plugin) {
  if (FORCE) return true;
  const manifest = JSON.parse(readFileSync(join(plugin.dir, 'manifest.json'), 'utf-8'));
  const panels = manifest.contributes?.panels ?? [];
  return panels.some((p) => typeof p.entry === 'string' && !existsSync(join(plugin.dir, p.entry)));
}

// ── Preflight ───────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 20) {
  console.error(`[setup] Node >= 20 required, found ${process.versions.node}`);
  process.exit(2);
}
if (!existsSync(join(REPO, 'pnpm-workspace.yaml')) || !existsSync(join(REPO, 'apps', 'desktop'))) {
  console.error(`[setup] does not look like the repo root: ${REPO}`);
  process.exit(2);
}

console.log('[setup] PiWork — dev setup');
note(`repo     : ${REPO}`);
note(`node     : ${process.versions.node}`);

const plugins = discoverPlugins();
note(`plugins  : ${plugins.map((p) => p.id).join(', ') || '(none)'}`);
// com.pi.files pulls ~790 MB of node_modules; say so before, not after.
note('first run installs roughly 1 GB of plugin dependencies and takes a few minutes');

const toBuild = plugins.filter(needsBuild);
if (toBuild.length) note(`panels needing a build: ${toBuild.map((p) => p.id).join(', ')}`);

// ── Vendor integrity, before anything expensive ─────────────────────────
// The vendored genoffice tree is not rebuildable (its source is a /tmp path
// that does not survive a reboot), so a missing file there can only come from
// git. Catch it now with a clear message rather than as an esbuild
// "Could not resolve" thirty seconds into a panel build.
const vendorScript = join(PLUGINS_DIR, 'com.pi.files', 'scripts', 'vendor-genoffice.mjs');
if (existsSync(vendorScript)) {
  step('vendor assets');
  record('vendor --verify', await run(NODE, [vendorScript, '--verify'], REPO));
  if (failures.length) {
    console.error('[setup] stopping: the vendored tree is incomplete, and every panel build depends on it.');
    process.exit(1);
  }
}

// ── Root install + build ────────────────────────────────────────────────
step('root install');
if (record('pnpm install', await run(PNPM, ['install'], REPO))) {
  console.error('[setup] stopping: nothing downstream can work without root dependencies.');
  process.exit(1);
}

// Must precede the plugin builds: plugins depend on @pi/plugin-sdk via
// `file:../../packages/plugin-sdk`, whose entry is ./dist/index.js.
step('root build');
if (record('pnpm build', await run(PNPM, ['build'], REPO))) {
  console.error('[setup] stopping: plugins link against packages/*/dist, which this step produces.');
  process.exit(1);
}

// ── Plugins ─────────────────────────────────────────────────────────────
for (const plugin of plugins) {
  step(`plugin ${plugin.id}`);
  if (record(`${plugin.id}: npm install`, await run(NPM, ['install'], plugin.dir))) continue;
  if (!hasBuildScript(plugin.dir)) {
    note('no build script — nothing to compile');
    continue;
  }
  if (!needsBuild(plugin)) {
    note('outputs already present — skipping build (use --force to rebuild)');
    continue;
  }
  record(`${plugin.id}: npm run build`, await run(NPM, ['run', 'build'], plugin.dir));
}

// ── Optional: local plugin market ───────────────────────────────────────
if (WANT_MARKET) {
  step('local plugin market');
  // build-market.mjs zips dist/ + ui-dist/, so it has to come after the builds,
  // and it refreshes _state.json#registry itself. Stamp dev versions so the
  // plugin center sees 更新 (and keeps .previous) rather than same-version 重装.
  record('build-market', await run(NODE, [join(REPO, 'scripts', 'build-market.mjs'), '--stamp'], REPO));
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n━━━ summary');
if (failures.length) {
  console.error(`✗ ${failures.length} step(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('✓ setup complete');
note('customer path (user plugins + local market):  pnpm dev:desktop');
note('install/update the customer plugins:  pnpm plugins:publish --install');
note('plugin authoring (repo plugins, live edits):  pnpm dev:desktop:plugins');
if (!WANT_MARKET) {
  note('to also build the local market now:  pnpm setup:market');
}
