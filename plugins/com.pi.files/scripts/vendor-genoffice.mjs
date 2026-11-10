#!/usr/bin/env node
/**
 * Vendor GenOffice (Apache-2.0) into plugins/com.pi.files/vendor/genoffice/.
 *
 * WHY A SCRIPT: the previous vendor/ was copied by hand and immediately drifted
 * — it is a snapshot missing 9 upstream files including `zip-splice.ts` (the
 * raw-zip-splice path) and `style-upsert.ts`. Hand-copying a 145k-LOC dependency
 * cannot stay honest, and Apache-2.0 attribution has to track what was actually
 * taken. So the file list, the provenance record and the third-party notices all
 * come from here, and `--check` fails on drift.
 *
 * WHY THE TREE MIRRORS UPSTREAM: vendored code imports across package
 * boundaries by relative path — e.g. `apps/docs/src/renderer/editor/shape-svg.ts`
 * does `import '.../../../../../../packages/pptx-render/src/preset-geometry'`.
 * Five levels up from `vendor/genoffice/apps/docs/src/renderer/editor/` lands on
 * `vendor/genoffice/`, so mirroring the upstream layout makes every one of those
 * specifiers resolve unchanged. Any other layout forces a rewrite pass.
 *
 * Usage:
 *   GENOFFICE_SRC=/path/to/genoffice-main node scripts/vendor-genoffice.mjs
 *   GENOFFICE_SRC=... node scripts/vendor-genoffice.mjs --check
 *
 * Default source is /tmp/gorepo/genoffice-main (the extracted release tarball).
 * The pinned commit is read from `$GENOFFICE_SRC/.genoffice-commit`, which is
 * written from the tarball's pax header — GitHub records the commit there.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(process.env.GENOFFICE_SRC ?? '/tmp/gorepo/genoffice-main');
const DEST = join(PLUGIN_ROOT, 'vendor', 'genoffice');
const UPSTREAM_JSON = join(PLUGIN_ROOT, 'vendor', 'UPSTREAM.json');
const BROWSER_SAFE_JSON = join(PLUGIN_ROOT, 'vendor', 'BROWSER_SAFE.json');
const CHECK = process.argv.includes('--check');
const VERIFY = process.argv.includes('--verify');

// ── What we take ────────────────────────────────────────────────────────
// Engine packages are pure TypeScript with no Electron and no DOM (verified:
// the only genuine DOM use is docx-engine/src/tiff.ts, which is structurally
// typed and no-ops without a canvas).
const PACKAGES = [
  'docx-engine',
  'pptx-engine',
  'pptx-ops',
  'pptx-render',
  'xlsx-gateway',
  'pdf2docx',
  'font-metrics',
  'file-parse',
  // Raw-zip splicing shared by pptx-engine; browser-safe, unlike its sibling
  // archive helpers (which are built on node:crypto / node:zlib).
  'zip-gate',
  'i18n',
  'ui',
];

/**
 * Files outside the packages above that the renderer still imports.
 *
 * `agent-core` is GenOffice's own agent — replaced by the host — but three of
 * its modules are pure helpers the document engines and UI use for redaction
 * range mapping, redaction labels, and mind-map parsing. Take those files and
 * their relative closure instead of the package.
 *
 * `font-metrics/word-faces.json` is exported from the package root (the
 * package's `exports` map points there), so the `src/` walk misses it.
 */
const EXTRA_FILES = [
  'packages/agent-core/src/redact-core.ts',
  'packages/agent-core/src/redact-range.ts',
  'packages/agent-core/src/mind-map.ts',
  'packages/agent-core/src/types.ts',
  'packages/font-metrics/word-faces.json',
  // The pdf backend's save path writes through this Node-only helper.
  'packages/electron-utils/src/atomic-write.ts',
];

/**
 * Apps vendored wholesale, each with the entry points whose RELATIVE-import
 * closure is followed.
 *
 * Hand-listing files was how the previous vendor drifted: a file's own
 * dependencies are not visible in a directory listing, so a new import inside
 * an already-listed file silently pulls in something that was never copied.
 * Following the closure makes the set computable instead of remembered.
 *
 * `entries` is deliberately the app root (main.tsx / App.tsx) rather than a
 * hand-picked surface: deciding file-by-file which chrome to keep is the
 * judgement call that produced a viewer rendering three <p> tags.
 */
const APPS = [
  {
    name: 'docs',
    dirs: ['apps/docs/src/renderer', 'apps/docs/src/shared', 'apps/docs/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      [
        'apps/docs/src/renderer/ai/AiPanel.tsx',
        'genoffice AI panel — replaced by our own, backed by the host agent.',
      ],
      [
        'apps/docs/src/renderer/ai/transport.ts',
        'genoffice agent IPC transport — only AiPanel used it.',
      ],
    ],
  },
  {
    name: 'pdf',
    dirs: ['apps/pdf/src/renderer', 'apps/pdf/src/shared', 'apps/pdf/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      ['apps/pdf/src/renderer/ai/AiPanel.tsx', 'replaced by our AI panel (host agent).'],
      ['apps/pdf/src/renderer/ai/transport.ts', 'genoffice agent transport — only AiPanel used it.'],
    ],
  },
  {
    name: 'slides',
    dirs: ['apps/slides/src/renderer', 'apps/slides/src/shared', 'apps/slides/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      ['apps/slides/src/renderer/ai/AiPanel.tsx', 'replaced by our AI panel (host agent).'],
      ['apps/slides/src/renderer/ai/transport.ts', 'genoffice agent transport — only AiPanel used it.'],
    ],
  },
  {
    name: 'sheets',
    dirs: ['apps/sheets/src/renderer', 'apps/sheets/src/shared', 'apps/sheets/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      ['apps/sheets/src/renderer/ai/AiPanel.tsx', 'replaced by our AI panel (host agent).'],
      ['apps/sheets/src/renderer/ai/transport.ts', 'genoffice agent transport — only AiPanel used it.'],
    ],
  },
  // The text formats. These two were simply never listed: the manifest has
  // always routed txt/md/html to this plugin, and the panel has always rendered
  // them — but through `@genoffice/ui`'s Markdown component, which is the
  // chat-bubble one (no images, links or blockquotes). These are the real
  // viewers. Same layout and the same two AI files as the other four.
  {
    name: 'markdown',
    dirs: ['apps/markdown/src/renderer', 'apps/markdown/src/shared', 'apps/markdown/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      ['apps/markdown/src/renderer/ai/AiPanel.tsx', 'replaced by our AI panel (host agent).'],
      ['apps/markdown/src/renderer/ai/transport.ts', 'genoffice agent transport — only AiPanel used it.'],
    ],
  },
  {
    name: 'html',
    dirs: ['apps/html/src/renderer', 'apps/html/src/shared', 'apps/html/src/main'],
    entries: ['main.tsx', 'App.tsx'],
    exclude: [
      ['apps/html/src/renderer/ai/AiPanel.tsx', 'replaced by our AI panel (host agent).'],
      ['apps/html/src/renderer/ai/transport.ts', 'genoffice agent transport — only AiPanel used it.'],
    ],
  },
];

/** Shared across apps: pagination/measurement live outside any single app. */
const SUPPORT_ENTRIES = [
  'line-metrics.ts',
  'pagination.ts',
  'pagination-types.ts',
  'pagination-slices.ts',
  'pagination-sections.ts',
  'pagination-measure.ts',
  'pagination-lines.ts',
  'pagination-hf.ts',
  'doc-style-css.ts',
  'phased-content.ts',
  'doc-state.ts',
  'doc-dirty.ts',
  'doc-cache.ts',
  'embedded-fonts.ts',
  'font-check.ts',
  'font-list.ts',
  'note-format.ts',
  'dom-range.ts',
  'spellcheck-pref.ts',
  'i18n/locale.tsx',
  // The imperative editing API. Misnamed: these live under ai/ but depend only
  // on @tiptap/* and @genoffice/docx-engine — no agent-core, no window.desktop.
  'ai/protocol.ts',
  'ai/ops.ts',
  'ai/page-setup.ts',
  'ai/revision-ops.ts',
  'ai/floating-ops.ts',
  'ai/note-ops.ts',
  'ai/table-ops.ts',
];

// ── Walk ────────────────────────────────────────────────────────────────
/** Recursively list files under `dir`, returned as paths relative to SRC. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(relative(SRC, abs));
  }
  return out;
}

/**
 * Every file reachable from `roots` through RELATIVE imports, as paths relative
 * to SRC.
 *
 * Bare specifiers are deliberately not followed: those are npm packages and
 * copying them into vendor/ would fork them from the installed versions.
 * Only relative imports are the renderer's own body.
 *
 * Dynamic `import()` counts too — genoffice loads the Tiptap editor modules
 * that way in its headless path.
 */
function closureOf(roots, srcRoot) {
  const seen = new Set();
  const queue = roots.map((p) => resolve(p));
  while (queue.length) {
    const p = queue.pop();
    // isFile, not exists: the extension loop below tries the bare path too, and
    // a relative import of a directory (`./ai`) would otherwise be queued and
    // then fail readFileSync with EISDIR.
    if (seen.has(p) || !existsSync(p) || !statSync(p).isFile()) continue;
    seen.add(p);
    let src;
    try {
      src = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    const specs = [
      ...src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
      ...src.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ];
    for (const m of specs) {
      const base = resolve(dirname(p), m[1]);
      for (const ext of ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx']) {
        if (existsSync(base + ext)) {
          queue.push(base + ext);
          break;
        }
      }
    }
  }
  return [...seen].map((p) => relative(srcRoot, p)).filter((p) => p && !p.startsWith('..'));
}

function collect() {
  const files = [];

  for (const pkg of PACKAGES) {
    const dir = join(SRC, 'packages', pkg, 'src');
    if (!existsSync(dir)) {
      console.warn(`[vendor] WARNING: packages/${pkg}/src missing — skipped`);
      continue;
    }
    files.push(...walk(dir));
  }

  // Files the package walk cannot reach, plus their relative closure.
  for (const file of EXTRA_FILES) {
    if (!existsSync(join(SRC, file))) {
      console.warn(`[vendor] WARNING: ${file} missing — skipped`);
      continue;
    }
    files.push(file);
  }
  const extraRoots = EXTRA_FILES.filter((f) => existsSync(join(SRC, f))).map((f) => join(SRC, f));
  const beforeExtras = new Set(files);
  for (const f of closureOf(extraRoots, SRC)) {
    if (!beforeExtras.has(f)) files.push(f);
  }

  // Each app: its whole tree, plus the closure of its entries.
  const excluded = [];
  for (const app of APPS) {
    for (const d of app.dirs) {
      const dir = join(SRC, d);
      if (!existsSync(dir)) {
        console.warn(`[vendor] WARNING: ${d} missing — skipped`);
        continue;
      }
      files.push(...walk(dir));
    }
    const renderer = join(SRC, app.dirs[0]);
    const roots = [
      ...app.entries.map((f) => join(renderer, f)),
      // Docs-only support modules (pagination, the editing API). They live at
      // the docs renderer root, so they are only meaningful for that app.
      ...(app.name === 'docs' ? SUPPORT_ENTRIES.map((f) => join(renderer, f)) : []),
    ].filter((f) => existsSync(f));
    const before = new Set(files);
    for (const f of closureOf(roots, SRC)) if (!before.has(f)) files.push(f);

    for (const [file, reason] of app.exclude) excluded.push({ file, reason });
  }

  // Licenses — Apache-2.0 §4 requires the NOTICE to travel with the code.
  for (const f of ['LICENSE', 'NOTICE', 'LICENSE-UNICODE.txt']) {
    if (existsSync(join(SRC, f))) files.push(f);
  }
  const ofl = 'apps/docs/src/renderer/fonts/LICENSE-OFL.txt';
  if (existsSync(join(SRC, ofl))) files.push(ofl);

  const skip = new Map(excluded.map((e) => [e.file, e.reason]));
  const seenFiles = new Set();
  const kept = files.filter((f) => {
    // A file can be reached twice (directory walk + closure walk); dedupe so
    // the copy list and the exclusion report each mention it once.
    if (seenFiles.has(f)) return false;
    seenFiles.add(f);
    return !skip.has(f);
  });

  kept.sort();
  return { files: kept, excluded: excluded.filter((e) => seenFiles.has(e.file)) };
}

const sha256 = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

// ── Where we stop being able to run in a browser ────────────────────────
// Scans the vendored set for `node:` imports and records which shim each needs.
// A specifier with no mapping becomes a build error in the browser target — see
// decision 4 in the plan. Silence here is what let the old build ship a zlib
// stub that returned empty buffers.
function buildBrowserSafe(files) {
  const SHIMS = {
    'node:zlib': 'src/shims/zlib.ts (fflate)',
    'node:crypto': 'src/shims/crypto.ts (@noble/hashes + WebCrypto)',
    'node:buffer': 'buffer (npm) via src/shims/buffer-shim.ts',
  };
  // Modules that are Node-only by construction. The browser build must FAIL on
  // these rather than stub them — a silent stub is exactly the bug class being
  // removed (the old build shipped a deflate that returned empty buffers).
  const BACKEND_ONLY = new Set([
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:os',
    'node:child_process',
    'node:module',
  ]);

  const found = new Map();
  for (const rel of files) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const src = readFileSync(join(SRC, rel), 'utf-8');
    for (const m of src.matchAll(/from\s+['"](node:[^'"]+)['"]/g)) {
      const spec = m[1];
      if (!found.has(spec)) found.set(spec, new Set());
      found.get(spec).add(rel);
    }
  }

  const safe = {};
  const backendOnly = {};
  for (const [spec, importers] of [...found].sort()) {
    const list = [...importers].sort();
    if (SHIMS[spec]) safe[spec] = { shim: SHIMS[spec], importers: list };
    else if (BACKEND_ONLY.has(spec)) backendOnly[spec] = { importers: list };
    else safe[spec] = { shim: null, importers: list, unmapped: true };
  }
  return { safe, backendOnly };
}

// ── Run ─────────────────────────────────────────────────────────────────
// `--verify` checks the committed tree against UPSTREAM.json, so it needs no
// upstream checkout — which is the point: the source this tree came from is a
// /tmp path that does not survive a reboot, so a clean clone has no way to
// re-derive the files. Handled before the SRC bailout below, which would
// otherwise exit(2) before we ever got here.
if (VERIFY) {
  if (!existsSync(UPSTREAM_JSON)) {
    console.error('[vendor] --verify: vendor/UPSTREAM.json missing');
    process.exit(1);
  }
  const prev = JSON.parse(readFileSync(UPSTREAM_JSON, 'utf-8'));
  const problems = [];
  for (const f of prev.files) {
    const abs = join(DEST, f.dest);
    if (!existsSync(abs)) {
      problems.push(`- ${f.dest}`);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.length !== f.bytes) problems.push(`~ ${f.dest} (size ${buf.length} ≠ ${f.bytes})`);
    else if (sha256(abs) !== f.sha256) problems.push(`~ ${f.dest} (sha256)`);
  }
  if (problems.length) {
    console.error(`[vendor] LOCAL DRIFT — ${problems.length} file(s) missing/modified:`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) console.error(`  … ${problems.length - 40} more`);
    console.error('  The vendored tree is not rebuildable — restore these from git and commit them.');
    process.exit(1);
  }
  console.log(`[vendor] local tree OK (${prev.files.length} files, commit ${prev.commit})`);
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.error(`[vendor] source not found: ${SRC}\n  set GENOFFICE_SRC to a genoffice checkout/tarball`);
  process.exit(2);
}

const commitFile = join(SRC, '.genoffice-commit');
const commit = existsSync(commitFile) ? readFileSync(commitFile, 'utf-8').trim() : 'unknown';
if (commit === 'unknown') {
  console.warn('[vendor] WARNING: no .genoffice-commit marker — provenance will be incomplete');
}

const { files, excluded } = collect();
const manifest = {
  repo: 'https://github.com/genspark-ai/genoffice',
  license: 'Apache-2.0',
  commit,
  vendoredAt: new Date().toISOString().slice(0, 10),
  fileCount: files.length,
  excluded,
  files: files.map((f) => {
    const abs = join(SRC, f);
    return { src: f, dest: f, bytes: statSync(abs).size, sha256: sha256(abs) };
  }),
};
const browser = buildBrowserSafe(files);

const totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
const unmapped = Object.entries(browser.safe).filter(([, v]) => v.unmapped);

if (CHECK) {
  if (!existsSync(UPSTREAM_JSON)) {
    console.error('[vendor] --check: vendor/UPSTREAM.json missing — run without --check first');
    process.exit(1);
  }
  const prev = JSON.parse(readFileSync(UPSTREAM_JSON, 'utf-8'));
  const drift = [];
  if (prev.commit !== commit) drift.push(`commit ${prev.commit} → ${commit}`);
  const prevBy = new Map(prev.files.map((f) => [f.src, f.sha256]));
  for (const f of manifest.files) {
    const old = prevBy.get(f.src);
    if (old === undefined) drift.push(`+ ${f.src}`);
    else if (old !== f.sha256) drift.push(`~ ${f.src}`);
    prevBy.delete(f.src);
  }
  for (const gone of prevBy.keys()) drift.push(`- ${gone}`);

  if (drift.length) {
    console.error(`[vendor] DRIFT — ${drift.length} change(s):`);
    for (const d of drift.slice(0, 40)) console.error(`  ${d}`);
    if (drift.length > 40) console.error(`  … ${drift.length - 40} more`);
    process.exit(1);
  }
  console.log(`[vendor] no drift (${manifest.files.length} files, commit ${commit})`);
  process.exit(0);
}

// Copy
rmSync(DEST, { recursive: true, force: true });
for (const f of manifest.files) {
  const to = join(DEST, f.dest);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(SRC, f.src), to);
}

mkdirSync(dirname(UPSTREAM_JSON), { recursive: true });
writeFileSync(UPSTREAM_JSON, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(BROWSER_SAFE_JSON, JSON.stringify({ generatedFrom: commit, ...browser }, null, 2) + '\n');

// ── Report ──────────────────────────────────────────────────────────────
console.log(`[vendor] commit      ${commit}`);
console.log(`[vendor] files       ${manifest.files.length}  (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`[vendor] excluded    ${excluded.length}`);
for (const e of excluded) console.log(`           - ${e.file}`);
console.log(`[vendor] node: shims ${Object.keys(browser.safe).length} mapped, ${Object.keys(browser.backendOnly).length} backend-only`);
if (unmapped.length) {
  console.warn(`[vendor] UNMAPPED node: specifiers (the browser build will fail on these):`);
  for (const [spec, v] of unmapped) console.warn(`           ${spec}  ← ${v.importers.length} importer(s)`);
}
console.log(`[vendor] → ${relative(PLUGIN_ROOT, DEST)}/`);
