#!/usr/bin/env node
/**
 * Build the file-viewer panel.
 *
 * One page, dispatching by extension: `.docx` loads GenOffice's own renderer,
 * everything else still loads the previous previewers until each is ported.
 *
 * ESM with code splitting, not a single IIFE: GenOffice's renderer plus 30 font
 * files is ~6 MB, and 95% of panel opens are not a docx. A single bundle would
 * make every open pay for the parser to read it.
 *
 * Three things make this more than a bundling job:
 *
 *  1. **`./ai/AiPanel` is aliased to ours.** GenOffice's panel drives its own
 *     agent; ours sends to the host agent. Every other file of the 277 is
 *     compiled as vendored, unmodified.
 *
 *  2. **CSS is injected, not emitted.** GenOffice's entry does
 *     `import '@genoffice/ui/tokens.css'` and expects the bundler to make it
 *     real. esbuild would emit a sibling .css that nothing links, so a plugin
 *     turns each stylesheet into a module that appends a <style> on first
 *     evaluation.
 *
 *  3. **Font URLs are rewritten to root-absolute.** Inlined CSS resolves
 *     `url(...)` against the DOCUMENT, not the stylesheet's original location,
 *     so `url('./Caladea-Bold.ttf')` would 404. Rewriting to `/fonts/...` makes
 *     it independent of where the CSS ends up — `/` is the plugin origin root
 *     under pi-plugin://.
 *
 * Run from the plugin root:  node scripts/build-panel.mjs
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'genoffice');
const DOCS = join(VENDOR, 'apps', 'docs', 'src', 'renderer');
const OUT = join(ROOT, 'ui-dist', 'panel');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * GenOffice imports that this plugin deliberately answers with its own code.
 *
 * Checked BEFORE the vendored-package resolver, so these win. Two reasons a
 * name lands here rather than in vendor/: the barrel would drag in a second
 * React copy and GenOffice's AI composer (ui), or the module is GenOffice's own
 * agent/provider, which the host replaces.
 */
const shimSwap = {
  name: 'shim-swap',
  setup(b) {
    const SHIMS = new Map([
      ['@genoffice/ai-provider', 'ai-provider.ts'],
      ['@genoffice/ai-provider/browser', 'ai-provider.ts'],
      ['@genoffice/electron-utils/headless-export', 'electron-utils.ts'],
      ['@genoffice/electron-utils/safe-external-url', 'electron-utils.ts'],
      // Type-only everywhere it appears (the two `ai/*-skill.ts` files).
      ['@genoffice/agent-core', 'agent-core.ts'],
    ]);
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      const shim = SHIMS.get(args.path);
      if (!shim) return null;
      return { path: join(ROOT, 'src', 'ui', 'docx', 'shims', shim) };
    });
  },
};

/** Resolve @genoffice/<pkg>[/<sub>] against the vendored mirror. */
const genofficeResolver = {
  name: 'genoffice',
  setup(b) {
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      // [a-z0-9-] not [a-z-]: the i18n package has a digit in its name, and a
      // digits-free pattern silently fails to resolve it.
      const m = /^@genoffice\/([a-z0-9-]+)(?:\/(.*))?$/.exec(args.path);
      if (!m) return null;
      const [, pkg, sub] = m;
      const base = join(VENDOR, 'packages', pkg, 'src');
      // Assets exported from the package root (e.g. font-metrics'
      // `word-faces.json`) are not mirrored under src/.
      const rootFile = join(VENDOR, 'packages', pkg, sub ?? '');
      if (!sub) return { path: join(base, 'index.ts') };
      // The subpath may already carry its extension (`@genoffice/ui/tokens.css`),
      // in which case appending another one produces `tokens.css.ts`.
      if (/\.[a-z0-9]+$/i.test(sub)) {
        if (existsSync(join(base, sub))) return { path: join(base, sub) };
        if (existsSync(rootFile)) return { path: rootFile };
        return { path: join(base, sub) };
      }
      for (const ext of ['.tsx', '.ts', '.css', '.json']) {
        const p = join(base, `${sub}${ext}`);
        if (existsSync(p)) return { path: p };
      }
      if (existsSync(rootFile)) return { path: rootFile };
      return { path: join(base, `${sub}.ts`) };
    });
  },
};


/**
 * Vite's `?url` imports: the module is replaced by a URL to the asset.
 *
 * Used for the pdf.js worker (`pdfjs-dist/.../pdf.worker.min.mjs?url`) and for
 * the Carlito TTFs sheets falls back to for cell text. esbuild's `file` loader
 * does exactly this — emits the asset next to the bundle and yields its path.
 */
const urlAsset = {
  name: 'url-asset',
  setup(b) {
    // Resolve the specifier WITHOUT the suffix through esbuild's own resolver
    // first: `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` is an npm package,
    // and joining it against the importer's directory produces a path that does
    // not exist.
    b.onResolve({ filter: /\?url$/ }, async (args) => {
      const r = await b.resolve(args.path.replace(/\?url$/, ''), {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      if (r.errors.length) return { errors: r.errors };
      return { path: r.path, namespace: 'url-asset' };
    });
    b.onLoad({ filter: /.*/, namespace: 'url-asset' }, (args) => ({
      contents: readFileSync(args.path),
      loader: 'file',
    }));
  },
};

/** Vite-style `?raw` imports (used by the op catalogs). */
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

/**
 * GenOffice's AI surface, replaced by nothing.
 *
 * The host already has an agent, so a second chat inside a document panel is
 * both redundant and 360px of every panel. The panel markup that remains is
 * hidden by `src/ui/ai/strip-genoffice-ai.css`; these aliases are what stop the
 * components from running at all.
 *
 * `ai/AiChatPanel` is the one that matters most: sheets renders its sidebar from
 * `ExcelShell.tsx`, not from an `AiPanel` import, so aliasing only `ai/AiPanel`
 * silently left GenOffice's own branded chat in place there.
 */
const aiPanelSwap = {
  name: 'ai-panel-swap',
  setup(b) {
    b.onResolve({ filter: /(^|\/)ai\/AiPanel$/ }, () => ({
      path: join(ROOT, 'src', 'ui', 'ai', 'no-ai-surface.tsx'),
    }));
    b.onResolve({ filter: /(^|\/)ai\/AiChatPanel$/ }, () => ({
      path: join(ROOT, 'src', 'ui', 'ai', 'no-ai-surface.tsx'),
    }));
    // Every app's ai/transport builds the channel to GenOffice's own agent, and
    // the vendor script excludes the real module from all four apps — so this
    // alias is load-bearing, not cosmetic: without it the import does not
    // resolve and the build fails. sheets still constructs an AgentLoop from
    // App.tsx, which the inert transport is what keeps harmless.
    b.onResolve({ filter: /(^|\/)ai\/transport$/ }, () => ({
      path: join(ROOT, 'src', 'ui', 'docx', 'shims', 'ai-transport.ts'),
    }));
  },
};

/**
 * Node builtins in a browser bundle.
 *
 * Two of them have real browser equivalents and are shimmed with ACTUAL
 * implementations — a no-op `deflateSync` or a constant `createHash` is silent
 * data corruption, which is what this replaced. Everything else is backend-only
 * and throws on use, so a genuine mistake is loud at the call site rather than
 * yielding an empty buffer somewhere downstream.
 */
const nodeBuiltins = {
  name: 'node-builtins',
  setup(b) {
    b.onResolve({ filter: /^node:(zlib|crypto)$/ }, (args) => ({ path: args.path, namespace: 'node-shim' }));
    b.onLoad({ filter: /^node:zlib$/, namespace: 'node-shim' }, () => ({
      resolveDir: ROOT,
      loader: 'js',
      contents:
        "import { deflateSync, inflateSync, gzipSync, gunzipSync } from 'fflate';" +
        'export { deflateSync, inflateSync, gzipSync, gunzipSync };' +
        'export const deflateRawSync = deflateSync;' +
        'export const inflateRawSync = inflateSync;' +
        'export const constants = {};',
    }));
    b.onLoad({ filter: /^node:crypto$/, namespace: 'node-shim' }, () => ({
      resolveDir: ROOT,
      loader: 'js',
      contents:
        "import { sha256 as _sha256 } from '@noble/hashes/sha2.js';" +
        "import { sha1 as _sha1 } from '@noble/hashes/legacy.js';" +
        "const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');" +
        'export function createHash(alg) {' +
        "  const h = String(alg).toLowerCase() === 'sha1' ? _sha1 : _sha256;" +
        '  let acc = new Uint8Array(0);' +
        '  return { update(d) { const b = typeof d === \'string\' ? new TextEncoder().encode(d) : new Uint8Array(d);' +
        '           const n = new Uint8Array(acc.length + b.length); n.set(acc); n.set(b, acc.length); acc = n; return this; },' +
        "           digest() { return toHex(h(acc)); } };" +
        '}' +
        'export const randomUUID = () => crypto.randomUUID();' +
        'export const getRandomValues = (a) => crypto.getRandomValues(a);',
    }));
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-backend' }));
    b.onLoad({ filter: /.*/, namespace: 'node-backend' }, (args) => {
      const spec = JSON.stringify(args.path);
      const names = [
        'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'existsSync', 'mkdirSync',
        'statSync', 'createWriteStream', 'createReadStream', 'promises', 'readdirSync',
        'join', 'resolve', 'dirname', 'basename', 'extname', 'relative', 'sep', 'posix',
        'homedir', 'tmpdir', 'platform', 'spawn', 'exec', 'execSync', 'createRequire',
        'require', 'cwd', 'env',
      ];
      return {
        resolveDir: ROOT,
        loader: 'js',
        contents:
          `const spec = ${spec};` +
          'function boom(name) {' +
          "  const f = function () { throw new Error('node builtin ' + spec + ' (' + name + ') is not available in the browser bundle — move this code to the plugin backend'); };" +
          "  return new Proxy(f, { get: (t, k) => (typeof k === 'symbol' || k === 'then' ? undefined : boom(name + '.' + String(k))) });" +
          '}' +
          names.map((n) => `export const ${n} = boom(${JSON.stringify(n)});`).join('\n') +
          "\nexport default boom('default');",
      };
    });
  },
};

/**
 * Turn stylesheet imports into self-injecting modules, rewriting relative font
 * URLs to root-absolute ones (see the header note).
 */
const cssInject = {
  name: 'css-inject',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, (args) => {
      let css = readFileSync(args.path, 'utf-8');
      // Two shapes appear in the vendored CSS: relative (`./Caladea-Bold.ttf`,
      // resolved against the stylesheet) and the Vite alias
      // (`@genoffice/ui/fonts/Carlito-Regular.ttf`, resolved by Vite). Both
      // become root-absolute, which is correct from wherever the CSS lands.
      css = css
        .replace(/url\(\s*(['"]?)\.\/([^'")]+)\1\s*\)/g, (_m, _q, f) => `url('/fonts/${f}')`)
        .replace(/url\(\s*(['"]?)@genoffice\/ui\/fonts\/([^'")]+)\1\s*\)/g, (_m, _q, f) => `url('/fonts/${f}')`);
      return {
        loader: 'js',
        resolveDir: dirname(args.path),
        contents:
          `const css = ${JSON.stringify(css)};\n` +
          `if (!document.querySelector('style[data-pi-css="' + ${JSON.stringify(args.path)} + '"]')) {\n` +
          `  const el = document.createElement('style');\n` +
          `  el.setAttribute('data-pi-css', ${JSON.stringify(args.path)});\n` +
          `  el.textContent = css;\n` +
          `  document.head.appendChild(el);\n` +
          `}\n` +
          `export default css;\n`,
      };
    });
  },
};

/**
 * Answers GenOffice's off-thread docx parser with an inline one.
 *
 * The docs renderer creates a module Worker with
 * `new Worker(new URL('./parse-worker.ts', import.meta.url))`. esbuild does not
 * turn that into a second bundle, so the URL points at a `.ts` path the plugin
 * origin does not serve: the worker 404s, the open falls back to a blank
 * document, and the status bar explains nothing. Inline parsing is what
 * `parseDocxOffThread` itself does when Worker is unavailable — and a plugin
 * panel is not the app's main UI, so the main thread is acceptable here.
 */
const parseOffThreadInline = {
  name: 'parse-off-thread-inline',
  setup(b) {
    b.onResolve({ filter: /(^|\/)parse-off-thread(\.ts)?$/ }, () => ({
      path: join(ROOT, 'src', 'ui', 'docx', 'parse-inline.ts'),
    }));
  },
};

const result = await build({
  entryPoints: [join(ROOT, 'src', 'ui', 'panel', 'main.ts')],
  outdir: OUT,
  bundle: true,
  splitting: true,
  format: 'esm',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  metafile: true,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
    // Vite's env object. The renderers use it for dev-only branches
    // (`import.meta.env.DEV`) and one Univer call path reads it unguarded, so
    // leaving it undefined is a runtime crash rather than a dead branch.
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.MODE': '"production"',
    global: 'globalThis',
  },
  inject: [join(ROOT, 'src', 'buffer-shim.ts')],
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.mjs': 'js',
    '.ttf': 'file',
    '.woff2': 'file',
    '.woff': 'file',
    '.otf': 'file',
    // Ribbon icons are imported as URLs. Emitted next to main.js, which is the
    // same directory the panel is served from, so the relative URL resolves.
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
    '.svg': 'file',
    '.webp': 'file',
  },
  assetNames: 'assets/[name]-[hash]',
  // `?url` assets must be addressed from the DOCUMENT, not from the chunk that
  // mentions them. esbuild's default is a path relative to the referencing
  // output file, so the pdf.js worker — imported by a chunk under `chunks/` but
  // placed in `assets/` — came out as `../assets/pdf.worker.min-<hash>.mjs`.
  // That resolves correctly from `chunks/` and WRONG from the panel: pdf.js
  // resolves `GlobalWorkerOptions.workerSrc` against `window.location`, which is
  // `ui-dist/panel/index.html`, so `../assets/` climbed to `ui-dist/assets/` —
  // a 404 served as text/plain, which is how it surfaced: "Failed to load
  // module script: ... MIME type of text/plain", the worker silently fell back
  // to the fake one, and pdf pages stopped painting.
  //
  // Absolute prefix instead. It has to match where the manifest's panel entry
  // is served from (`contributes.panels[].entry`).
  publicPath: '/ui-dist/panel/',
  resolveExtensions: ['.tsx', '.ts', '.js'],
  plugins: [aiPanelSwap, shimSwap, urlAsset, genofficeResolver, rawText, cssInject, nodeBuiltins, parseOffThreadInline],
});

// Fonts: the layout-fidelity payload. Served at /fonts/* so the rewritten
// url()s resolve.
const fontSources = [join(DOCS, 'fonts'), join(VENDOR, 'packages', 'ui', 'src', 'fonts')];
const fontsDst = join(OUT, 'fonts');
mkdirSync(fontsDst, { recursive: true });
let n = 0;
for (const dir of fontSources) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (['.ttf', '.woff2', '.otf', '.woff'].includes(extname(f).toLowerCase())) {
      copyFileSync(join(dir, f), join(fontsDst, f));
      n++;
    }
  }
}
console.log(`[panel] copied ${n} font file(s) → ui-dist/panel/fonts/`);

// pdf.js worker: the legacy previewer loads it same-origin at runtime. It used
// to be a hand-committed 1.4 MB file, which meant `ui-dist/` was not
// reproducible from a clean checkout. Copy it from the installed package.
const pdfWorker = join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
if (existsSync(pdfWorker)) {
  copyFileSync(pdfWorker, join(OUT, 'pdf.worker.min.mjs'));
  console.log('[panel] copied pdf.worker.min.mjs');
}

// The panel HTML lives in src/, not ui-dist/: this script wipes ui-dist/panel
// on every build, and a hand-written file in there lasts exactly one build.
copyFileSync(join(ROOT, 'src', 'ui', 'panel', 'index.html'), join(OUT, 'index.html'));

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[panel] bundled → ui-dist/panel/ (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
