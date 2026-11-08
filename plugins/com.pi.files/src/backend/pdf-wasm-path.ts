/**
 * Build-time replacement for GenOffice's `apps/pdf/src/main/wasm-path.ts`.
 *
 * GenOffice finds its wasm in node_modules (dev) or in Electron's
 * Resources/wasm (packaged app). A plugin ships neither: every runtime asset
 * it needs lives beside dist/main.mjs. `build-backend.mjs` copies
 * pdfium.wasm and hb-subset.wasm there and swaps this module in for the
 * vendor one (see the `pdf-wasm-shim` esbuild plugin), so GenOffice's PDF
 * text-insert and page-render layers load their wasm from the plugin itself.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const pdfiumWasmPath = (): string => join(HERE, 'pdfium.wasm');
export const hbSubsetWasmPath = (): string => join(HERE, 'hb-subset.wasm');
