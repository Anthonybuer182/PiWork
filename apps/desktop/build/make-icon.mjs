#!/usr/bin/env node
/**
 * Draw the app icon: a tapered "W" monogram on a macOS-style squircle.
 *
 * The mark is generated rather than hand-drawn in a vector editor so the
 * geometry stays reproducible: change a vertex or a width below and re-run.
 *
 *   1. build the SVG (squircle + variable-width W outline)
 *   2. rasterise it with headless Chrome at 1024x1024 on a transparent canvas
 *   3. hand the PNG to generate-icons.sh, which writes icon.icns + icon.png
 *
 * Usage: node build/make-icon.mjs
 *
 * Requires Google Chrome (for the SVG rasteriser) and macOS iconutil/sips.
 * This is an authoring step, not part of the build — electron-builder only
 * ever reads the committed icon.png / icon.icns.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const round = (n) => Math.round(n * 100) / 100;
const pt = ([x, y]) => `${round(x)} ${round(y)}`;
const lerp = (a, b, t) => a + (b - a) * t;

// ── Squircle ────────────────────────────────────────────────────────────────
//
// A superellipse |x|^n + |y|^n = 1, which is the shape macOS uses for app
// tiles. n = 5 is the usual approximation of Apple's continuous corner —
// a plain rounded rect reads as visibly "off" next to native icons.
function squirclePath(cx, cy, r, n = 5, steps = 360) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      cx + r * Math.sign(c) * Math.abs(c) ** (2 / n),
      cy + r * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  return `M${pts.map(pt).join('L')}Z`;
}

// ── The W ───────────────────────────────────────────────────────────────────
//
// A polyline with a half-width at every vertex, expanded into a closed
// outline. Wider at the feet than at the tips, so the letter gets a
// calligraphic taper instead of reading as a stroked font glyph.
const VERTICES = [
  { x: 256, y: 322, w: 44 },
  { x: 396, y: 702, w: 82 },
  { x: 512, y: 420, w: 74 },
  { x: 628, y: 702, w: 82 },
  { x: 768, y: 322, w: 44 },
];

/** Samples per segment; 24 is plenty — the outline is all straight edges. */
const SAMPLES = 24;

/**
 * Expand the polyline into one closed path.
 *
 * Each side (left = +normal, right = -normal) is a list of tokens; joins get a
 * round arc on the *outer* side only, and the two ends get a round cap. The
 * path is emitted as: start cap → right side → end cap → left side reversed.
 */
function wPath(vertices) {
  const left = [];
  const right = [];
  let prevU = null;

  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const u = [dx / len, dy / len];
    const n = [-u[1], u[0]];

    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const p = [a.x + dx * t, a.y + dy * t];
      const h = lerp(a.w, b.w, t) / 2;
      const l = [p[0] + n[0] * h, p[1] + n[1] * h];
      const r = [p[0] - n[0] * h, p[1] - n[1] * h];

      // Join at the start of every segment but the first. The two sides of
      // the bend sit h apart around a shared vertex; fill the wedge on the
      // outside of the turn.
      if (i > 0 && k === 0) {
        const cross = prevU[0] * u[1] - prevU[1] * u[0];
        // cross > 0 turns clockwise on screen, which leaves the gap on the
        // right side; negative leaves it on the left. Sweeping the short way
        // round means a right-side join runs with the traversal (1) and a
        // left-side join runs against it (0).
        if (cross > 0) right.push({ arc: true, r: h, from: right[right.length - 1].to, to: r, sweep: 1 });
        else if (cross < 0) left.push({ arc: true, r: h, from: left[left.length - 1].to, to: l, sweep: 0 });
      }

      left.push({ to: l });
      right.push({ to: r });
    }
    prevU = u;
  }

  const h0 = vertices[0].w / 2;
  const hN = vertices[vertices.length - 1].w / 2;

  /**
   * Emit tokens as path commands. When `reversed`, walk the list backwards:
   * a line still lands on the same point, but an arc must run from its `to`
   * back to its `from`, which also mirrors its sweep flag.
   */
  const emit = (tokens, reversed) => {
    const out = [];
    for (let idx = 0; idx < tokens.length; idx++) {
      const tok = reversed ? tokens[tokens.length - 1 - idx] : tokens[idx];
      if (tok.arc) {
        const sweep = reversed ? 1 - tok.sweep : tok.sweep;
        const target = reversed ? tok.from : tok.to;
        out.push(`A${round(tok.r)} ${round(tok.r)} 0 0 ${sweep} ${pt(target)}`);
      } else {
        out.push(`L${pt(tok.to)}`);
      }
    }
    return out.join('');
  };

  return [
    `M${pt(left[0].to)}`,
    // start cap: left → right, around the back of the first vertex
    `A${round(h0)} ${round(h0)} 0 0 1 ${pt(right[0].to)}`,
    emit(right.slice(1), false),
    // end cap: right → left, around the far side of the last vertex
    `A${round(hN)} ${round(hN)} 0 0 1 ${pt(left[left.length - 1].to)}`,
    emit(left.slice(1), true),
    'Z',
  ].join('');
}

function buildSvg() {
  const tile = squirclePath(SIZE / 2, SIZE / 2, 412);
  const w = wPath(VERTICES);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="tile" x1="0.12" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#43308F"/>
      <stop offset="0.5" stop-color="#291A63"/>
      <stop offset="1" stop-color="#130C31"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.34" cy="0.06" r="0.8">
      <stop offset="0" stop-color="#9F7AFF" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#9F7AFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ember" cx="0.92" cy="0.98" r="0.62">
      <stop offset="0" stop-color="#EC4899" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#EC4899" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mark" x1="0.05" y1="0" x2="0.95" y2="1">
      <stop offset="0" stop-color="#99F6E4"/>
      <stop offset="0.3" stop-color="#7DD3FC"/>
      <stop offset="0.62" stop-color="#B39BFF"/>
      <stop offset="0.86" stop-color="#F0ABFC"/>
      <stop offset="1" stop-color="#FBCFE8"/>
    </linearGradient>
    <filter id="bloom" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
  </defs>

  <path d="${tile}" fill="url(#tile)"/>
  <path d="${tile}" fill="url(#sheen)"/>
  <path d="${tile}" fill="url(#ember)"/>

  <path d="${w}" fill="url(#mark)" filter="url(#bloom)" opacity="0.38"/>
  <path d="${w}" fill="url(#mark)"/>
</svg>
`;
}

// ── Rasterise ───────────────────────────────────────────────────────────────

const svgPath = join(BUILD, 'icon-source.svg');
const pngPath = join(BUILD, 'icon-source.png');

writeFileSync(svgPath, buildSvg());
console.log(`→ ${svgPath}`);

const work = mkdtempSync(join(tmpdir(), 'pi-icon-'));
try {
  // Chrome screenshots a page, not an SVG, so wrap it and kill the margins.
  const html = join(work, 'icon.html');
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      svg{display:block}
    </style>${buildSvg()}`,
  );

  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`,
      `--screenshot=${pngPath}`,
      `file://${html}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`→ ${pngPath}`);
execFileSync(join(BUILD, 'generate-icons.sh'), [pngPath], { stdio: 'inherit' });
