/**
 * Stand-in for `@genoffice/electron-utils/headless-export`.
 *
 * The renderer imports four helpers from it, and — worth stating plainly
 * because it is easy to assume otherwise — **none of the four touch Electron**:
 * they are a sleep, a poll, a `document.fonts.ready` race, and a two-callback
 * wrapper. They are portable as written, so they are implemented faithfully
 * here rather than stubbed.
 *
 * What is NOT portable is the rest of that module (`headlessModuleFor`,
 * `parseHeadlessExportArgv`, …), which spawns GenOffice's own binary in
 * `--headless-export` mode to lay a document out in a hidden window. A plugin
 * cannot create a BrowserWindow and has no GenOffice binary to spawn, so those
 * are absent — and the renderer never imports them.
 */

export type HeadlessExportTarget = string;

export interface HeadlessWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface HeadlessExportReport {
  ok: boolean;
  error?: string;
}

export const headlessSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntilReady(
  ready: () => boolean,
  stallMessage: string | (() => string),
  { timeoutMs = 180_000, pollMs = 250 }: HeadlessWaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(typeof stallMessage === 'function' ? stallMessage() : stallMessage);
    }
    await headlessSleep(pollMs);
  }
}

export function documentFontsSettled(timeoutMs = 30_000): Promise<unknown> {
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve();
  return Promise.race([document.fonts.ready, headlessSleep(timeoutMs)]);
}

export interface SafeExternalUrlOptions {
  /** Protocol allowlist (with trailing colon). Defaults to http/https only. */
  allowedProtocols?: readonly string[];
}

const SAFE_URL_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * Stand-in for `@genoffice/electron-utils/safe-external-url` — the single gate
 * every `shell.openExternal` call in GenOffice goes through (the slides PDF
 * export uses it to emit link annotations, docs uses it for sanitized
 * markdown). Pure by construction, so it is implemented faithfully rather than
 * stubbed; a permissive stub would let `file:`/`javascript:` URLs through.
 */
export function safeExternalUrl(
  url: unknown,
  options?: SafeExternalUrlOptions,
): string | null {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const allowed = options?.allowedProtocols ?? SAFE_URL_PROTOCOLS;
  return allowed.includes(parsed.protocol) ? text : null;
}

export async function runHeadlessRendererExport(
  outPath: string,
  waitUntilReady: () => Promise<void>,
  exportFile: (outPath: string) => Promise<boolean>,
): Promise<HeadlessExportReport> {
  try {
    await waitUntilReady();
    const ok = await exportFile(outPath);
    return ok ? { ok: true } : { ok: false, error: 'export did not produce a file' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
