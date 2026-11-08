#!/usr/bin/env node
/**
 * Bundle the plugin backend for Electron's UtilityProcess.
 *
 * The backend used to be a hand-written `dist/main.mjs` with no build step,
 * which meant it could not import the vendored engines at all — they are
 * TypeScript. Now it is bundled like the UI, but against real Node builtins:
 * `node:fs`, `node:zlib` and `node:crypto` are the genuine articles here, which
 * is exactly why the engine's Node-only paths (zip-splice, lazy media, the
 * hashing used for media dedupe) behave correctly on this side.
 *
 * Run from the plugin root:  node scripts/build-backend.mjs
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'genoffice');


/**
 * `electron`, for the parts of GenOffice's main-process code we run here.
 *
 * Most of that code is pure and imports nothing from Electron. A few helpers do
 * — and they are reached from files that are otherwise pure, via a DYNAMIC
 * import, so the dependency is invisible until it blows up at load:
 *
 *   save-pdf.ts  →  import('./image-edit')  →  nativeImage
 *
 * `nativeImage` is a main-process module; a UtilityProcess does not have it, and
 * an unshimmed import kills the whole backend at startup ("does not provide an
 * export named 'nativeImage'"). So it is shimmed to throw at the CALL, which
 * keeps every other path working and makes the one unsupported feature (raster
 * image edits inside a PDF) fail where a caller can see it.
 */
const electronShim = {
  name: 'electron-shim',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }));
    b.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      loader: 'js',
      contents:
        "const boom = (what) => () => { throw new Error('electron.' + what + ' is not available in a plugin UtilityProcess'); };\n" +
        "const names = ['createFromBuffer', 'createFromBitmap', 'createFromPath', 'createFromDataURL', 'createEmpty'];\n" +
        "export const nativeImage = Object.fromEntries(names.map((n) => [n, boom('nativeImage.' + n)]));\n" +
        "export const app = new Proxy({}, { get: (_t, k) => boom('app.' + String(k)) });\n" +
        "export const ipcMain = new Proxy({}, { get: (_t, k) => boom('ipcMain.' + String(k)) });\n" +
        "export const dialog = new Proxy({}, { get: (_t, k) => boom('dialog.' + String(k)) });\n" +
        "export const shell = new Proxy({}, { get: (_t, k) => boom('shell.' + String(k)) });\n" +
        "export default {};",
    }));
  },
};

/** Resolve @genoffice/<pkg>[/<sub>] against the vendored mirror. */
/**
 * Point GenOffice's PDF wasm lookup at this plugin's dist folder.
 *
 * `apps/pdf/src/main/wasm-path.ts` resolves node_modules in dev and Electron's
 * Resources/wasm in the packaged app. A plugin has neither: its wasm sits
 * beside dist/main.mjs. Swapping the module for `src/backend/pdf-wasm-path.ts`
 * keeps vendor code unmodified and makes the plugin self-contained.
 */
const pdfWasmShim = {
  name: 'pdf-wasm-shim',
  setup(b) {
    b.onResolve({ filter: /^\.\/wasm-path$/ }, (args) => {
      const dir = args.resolveDir.replace(/\\/g, '/');
      if (!dir.endsWith('/apps/pdf/src/main')) return null;
      return { path: join(ROOT, 'src/backend/pdf-wasm-path.ts') };
    });
  },
};

const genofficeResolver = {
  name: 'genoffice',
  setup(b) {
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      const m = /^@genoffice\/([a-z0-9-]+)(?:\/(.*))?$/.exec(args.path);
      if (!m) return null;
      const [, pkg, sub] = m;
      return { path: join(VENDOR, 'packages', pkg, 'src', sub ? `${sub}.ts` : 'index.ts') };
    });
  },
};

/**
 * Vite-style `?raw` imports, which genoffice uses to inline its op-reference
 * markdown into the op catalog (pptx-ops/src/op-docs.ts). Without this the
 * backend fails to bundle at all.
 */
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: readFileSync(args.path, 'utf-8'),
      loader: 'text',
    }));
  },
};

const result = await build({
  entryPoints: [join(ROOT, 'src/backend/index.ts')],
  outfile: join(ROOT, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: ROOT,
  // Not minified on purpose: the host pipes the backend's stderr into the app
  // log, and a minified stack trace there is worthless.
  minify: false,
  keepNames: true,
  metafile: true,
  // Left external so esbuild never tries to resolve jsdom's optional native
  // requires. They are absent, not loaded at runtime by this entry.
  //
  // `codepage` is the same deal at a much bigger scale: ppt-to-text requires it
  // behind `require('code'+'page')` (folded to a literal at build time), and the
  // package's cptable.js alone is ~5 MB of lookup tables. vendor/genoffice's
  // ppt.ts installs its own `globalThis.cptable` before loading the parser, so
  // that require never executes — externalising it costs nothing at runtime.
  external: ['canvas', 'bufferutil', 'utf-8-validate', 'codepage'],
  // CJS dependencies that call `require('buffer')` / `require('fs')` from
  // inside functions (word-extractor does) cannot be statically rewritten in an
  // ESM bundle; esbuild's fallback throws "Dynamic require … is not supported".
  // A real `require` in scope turns those into ordinary Node requires.
  banner: {
    js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
  },
  plugins: [pdfWasmShim, electronShim, genofficeResolver, rawText],
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundled → dist/main.mjs (${(bytes / 1024).toFixed(0)} KB)`);

// ── pdfium / harfbuzz wasm (PDF text, render, conversion) ──────────────
//
// GenOffice's pdf2docx rebuild and its PDF text-insert layer are pure, but
// they need pdfium to rasterize/extract and harfbuzz to subset the font they
// embed. The app normally finds them in node_modules or in its packaged
// resources directory; a plugin ships neither, so the backend loads them from
// beside dist/main.mjs. Copying them here makes a plugin install
// self-contained (and the market zip picks up dist/ wholesale).
const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const wasmAssets = [
  { from: join(ROOT, 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'), to: 'pdfium.wasm' },
  {
    from: join(ROOT, 'node_modules', 'harfbuzzjs', 'dist', 'harfbuzz-subset.wasm'),
    to: 'hb-subset.wasm',
  },
];
for (const asset of wasmAssets) {
  if (existsSync(asset.from)) {
    copyFileSync(asset.from, join(distDir, asset.to));
    console.log(`copied → dist/${asset.to}`);
  } else {
    console.warn(`warning: ${asset.from} not found — the matching PDF feature will fail at runtime`);
  }
}

