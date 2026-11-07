#!/usr/bin/env node
/**
 * Bundle the diagnostics backend for Electron's UtilityProcess.
 *
 * The shared analyzer lives in the repo's `scripts/diagnostics/analyze.mjs`
 * so the CLI report and this panel can never disagree about what a run means.
 * esbuild inlines it, so the packaged plugin is self-contained.
 *
 * `minify: false` / `keepNames: true`: backend stderr goes to the app log and
 * a minified stack from a failed read is worthless.
 */
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [join(ROOT, 'src/backend/index.ts')],
  outfile: join(ROOT, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: ROOT,
  minify: false,
  keepNames: true,
  metafile: true,
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ dist/main.mjs — ${(bytes / 1024).toFixed(0)} KB`);
