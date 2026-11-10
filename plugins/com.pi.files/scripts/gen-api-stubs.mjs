#!/usr/bin/env node
/**
 * Generate shape-correct stubs for one of GenOffice's preload interfaces.
 *
 * The renderers call a scattered handful of their API's members during
 * bootstrap, and none of them are guessable from the outside — the first slides
 * run died on `clipboardProbe`, which is not a method anyone would predict.
 * Discovering them one crash at a time is 55 (pdf) to 180 (slides) round trips.
 *
 * So every declared member gets a stub, and the shims override the ones that
 * are actually implemented. The stub must return the right SHAPE: a stub
 * returning `undefined` where the caller expects a list fails somewhere further
 * from the cause than a missing method would.
 *
 * The output is CHECKED IN, not built — it is read far more often than written,
 * and a generated-at-build-time file would make the shims' overrides invisible
 * to anyone reading them.
 *
 * Usage:
 *   node scripts/gen-api-stubs.mjs pdf
 *   node scripts/gen-api-stubs.mjs slides
 *   node scripts/gen-api-stubs.mjs sheets
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where each app declares its preload interface, and what it is called. */
const APPS = {
  docs: { file: 'apps/docs/src/shared/ipc.ts', iface: 'DesktopApi', global: 'desktop' },
  pdf: { file: 'apps/pdf/src/shared/ipc.ts', iface: 'PdfApi', global: 'pdfApi' },
  slides: { file: 'apps/slides/src/shared/ipc.ts', iface: 'SlidesApi', global: 'slidesApi' },
  sheets: { file: 'apps/sheets/src/shared/desktop-api.ts', iface: 'DesktopApi', global: 'desktopApi' },
  markdown: { file: 'apps/markdown/src/shared/ipc.ts', iface: 'MarkdownApi', global: 'markdownApi' },
  html: { file: 'apps/html/src/shared/ipc.ts', iface: 'HtmlApi', global: 'htmlApi' },
};

const app = process.argv[2];
const spec = APPS[app];
if (!spec) {
  console.error(`usage: node scripts/gen-api-stubs.mjs <${Object.keys(APPS).join('|')}>`);
  process.exit(2);
}

const path = join(ROOT, 'vendor', 'genoffice', spec.file);
let src = readFileSync(path, 'utf-8');

// Strip comments first: a `/** ... */` between two members otherwise ends up
// glued to the previous member's return type and every heuristic below misfires.
src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const body = new RegExp(`export interface ${spec.iface} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
if (!body) {
  console.error(`could not find "export interface ${spec.iface}" in ${spec.file}`);
  process.exit(2);
}

// Two declaration styles appear across the apps, and both have to be handled:
//   property  —  `getTheme: () => Promise<UiTheme>`              (slides, docs)
//   method    —  `readFile(path: string): Promise<ArrayBuffer>`   (pdf)
//
// Parsed LINE BY LINE rather than with one big regex. A parameter list can
// contain `)`, at which point a `[^)]*` capture stops early:
//
//   onCloseSaveRequest(handler: () => void): () => void
//                     ^^^^^^^^^^^^^^^^^^^^^ the paren inside the callback type
//
// That silently dropped the member, so the stub file type-checked and then
// crashed at the first call. Continuation lines (a signature spanning several
// lines) are appended until the next member starts.
const rawLines = body.split('\n');
const members = [];
for (let i = 0; i < rawLines.length; i++) {
  const m = /^ {2}(\w+)\??\s*([:(])(.*)$/.exec(rawLines[i]);
  if (!m) continue;
  const name = m[1];
  let rest = m[3];
  // Keep absorbing while the next line is an indented continuation.
  while (i + 1 < rawLines.length && /^\s{4,}\S/.test(rawLines[i + 1]) && !/^\s{2}\w+\??\s*[:(]/.test(rawLines[i + 1])) {
    rest += ' ' + rawLines[++i].trim();
  }
  rest = rest.replace(/\s+/g, ' ').trim();

  // `readFile(path: string): Promise<ArrayBuffer>` → return type after the
  // closing paren of the parameter list; `getTheme: () => Promise<X>` → after
  // the `=>`; `foo: Promise<X>` → the whole thing.
  let ret = rest;
  if (m[2] === '(') {
    const close = rest.lastIndexOf('):');
    ret = close >= 0 ? rest.slice(close + 2) : '';
  } else if (rest.startsWith('(')) {
    const arrow = rest.indexOf('=>');
    ret = arrow >= 0 ? rest.slice(arrow + 2) : '';
  }
  members.push([name, ret.replace(/\s+/g, ' ').trim(), m[2] === '(']);
}

/** A value the caller can safely iterate / await / call. */
function emptyFor(sig) {
  if (/(\)|>)\s*=>\s*Promise<\s*[^>]*\[\]/.test(sig)) return 'Promise.resolve([])';
  if (/Promise<\s*[^>]*\[\]/.test(sig)) return 'Promise.resolve([])';
  if (/Promise<[^>]*(\||\bnull\b)/.test(sig)) return 'Promise.resolve(null)';
  if (/Promise<\s*(void|undefined)/.test(sig)) return 'Promise.resolve()';
  if (/Promise<[^>]*boolean/.test(sig)) return 'Promise.resolve(false)';
  if (/Promise<[^>]*number/.test(sig)) return 'Promise.resolve(0)';
  if (/Promise<[^>]*string/.test(sig)) return "Promise.resolve('')";
  // Anything object-shaped: an `ok:false` envelope reads as "feature
  // unavailable" to most callers, which is exactly the truth here.
  if (/Promise<\{/.test(sig) || /ok\s*:/.test(sig)) {
    return "Promise.resolve({ ok: false, error: '尚未接入宿主' })";
  }
  if (/Promise</.test(sig)) return 'Promise.resolve(null)';
  return 'undefined';
}

const lines = [];
for (const [name, ret, isMethod] of members) {
  // Event subscriptions return an unsubscribe function; several call sites
  // store it and call it on unmount. Detect by the RETURN type, not the name —
  // `onCloseSaveRequest(handler): () => void` is a subscription while
  // `onFileRenamed(handler): () => void` is too, but a method merely named
  // `on...` is not.
  const returnsUnsubscribe = /^\s*\(\s*\)\s*=>\s*void\s*$/.test(ret) || /\)\s*=>\s*\(\)\s*=>\s*void/.test(ret);
  void isMethod;
  lines.push(returnsUnsubscribe ? `  ${name}: () => () => undefined,` : `  ${name}: () => ${emptyFor(ret)},`);
}

const out = `/**
 * Stubs for GenOffice's \`${spec.iface}\` (window.${spec.global}).
 *
 * ${members.length} members, of which the renderer calls a scattered handful during bootstrap —
 * none of them guessable from the outside (the first slides run died on
 * \`clipboardProbe\`). Each returns the SHAPE its declaration promises, so a
 * stubbed call degrades to "feature unavailable" rather than blowing up
 * somewhere far from the cause.
 *
 * Every real implementation lives in the shim next to this file, spread over
 * the top of this object.
 *
 * Generated from ${spec.file} by scripts/gen-api-stubs.mjs. Regenerate rather
 * than edit — but do check it in: it is read far more often than written.
 */
export const ${app}ApiStubs: Record<string, unknown> = {
${lines.join('\n')}
};
`;

// docs' shim lives under docx/ (historical name); its stubs sit beside the
// shims it is spread into rather than in a `docs/` directory.
const dest =
  app === 'docs'
    ? join(ROOT, 'src', 'ui', 'docx', 'shims', 'stubs.ts')
    : join(ROOT, 'src', 'ui', app, 'stubs.ts');
writeFileSync(dest, out);
console.log(
  `[stubs] ${spec.iface}: ${members.length} member(s) → ${relative(ROOT, dest)}`,
);
