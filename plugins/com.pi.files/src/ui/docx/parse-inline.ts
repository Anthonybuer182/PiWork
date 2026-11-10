/**
 * Stand-in for GenOffice's `renderer/parse-off-thread`.
 *
 * The real module parses a .docx in a module Worker so a large document does
 * not freeze the UI thread. The Worker is created from
 * `new URL('./parse-worker.ts', import.meta.url)`, which esbuild cannot turn
 * into a second bundle — the URL 404s under the plugin origin, the parse
 * never returns, and the docs tab falls back to a blank document.
 *
 * This build therefore parses inline, which is precisely the fallback the
 * upstream module takes when `Worker` is unavailable. `owned` is accepted and
 * ignored: it only controls whether the caller's ArrayBuffer is transferred to
 * the worker.
 */
import { parseDocx } from '@genoffice/docx-engine';

export interface ParseOffThreadOptions {
  owned?: boolean;
}

export async function parseDocxOffThread(
  bytes: Uint8Array,
  _options: ParseOffThreadOptions = {},
) {
  return parseDocx(bytes);
}
