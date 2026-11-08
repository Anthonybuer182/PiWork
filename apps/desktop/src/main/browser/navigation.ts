/**
 * Explaining a failed navigation.
 *
 * The embedded browser rides on whatever proxy the app's network settings
 * select, so most of the failures this file describes are proxy failures: a
 * proxy that is not running, one that answers HTTP but refuses HTTPS tunnels,
 * one that accepts the connection and then never replies. Chromium names each
 * of them precisely. Without this layer the only thing the tool ever said was
 * "Page load timed out" — thirty seconds after the real answer was known.
 *
 * The messages are mechanical on purpose (name, code, url, proxy) so the
 * browser plugin can translate them by net-error name; see `zhError` there.
 */

export interface NavigationFailure {
  /** Chromium's net error, e.g. -130 for ERR_PROXY_CONNECTION_FAILED. */
  code: number | null;
  /** Chromium's name for it, as `did-fail-load` reports it. */
  netError?: string | null;
  /** Where the navigation was headed. */
  url?: string | null;
  /** What Chromium resolves for that URL, e.g. "PROXY 127.0.0.1:3213; DIRECT". */
  proxyRule?: string | null;
}

/** What the page currently is, read in one CDP evaluation. */
export interface PageSnapshot {
  readyState: string;
  href: string;
  title: string;
  nodes: number;
}

/** -3 ERR_ABORTED: every redirect aborts the load it replaces. Not a failure. */
export function isAbortedNavigation(code: number | null | undefined): boolean {
  return code === -3;
}

/**
 * "PROXY 127.0.0.1:3213; DIRECT" -> "127.0.0.1:3213". DIRECT -> null.
 * Chromium ranks the list; the first usable entry is the one it would use.
 */
export function proxyOf(rule: string | null | undefined): string | null {
  if (!rule) return null;
  for (const part of rule.split(';')) {
    const [kind, host] = part.trim().split(/\s+/);
    if (!kind) continue;
    // Ranked list: the first entry that names a route is the one Chromium
    // would take, so a leading DIRECT means the proxy after it is not used.
    if (/^DIRECT$/i.test(kind)) return null;
    if (!host) continue;
    if (/^PROXY$/i.test(kind)) return host;
    if (/^SOCKS5?$/i.test(kind)) return `socks5://${host}`;
    if (/^HTTPS$/i.test(kind)) return `https://${host}`;
  }
  return null;
}

export function navigationFailureMessage(failure: NavigationFailure): string {
  const name = (failure.netError ?? '').trim() || 'ERR_FAILED';
  const code = failure.code == null ? '' : ` (${failure.code})`;
  const parts = [`Navigation failed: ${name}${code}`];
  if (failure.url) parts.push(`loading '${failure.url}'`);
  const proxy = proxyOf(failure.proxyRule);
  if (proxy) parts.push(`via proxy ${proxy}`);
  return parts.join(' ');
}

export function navigationTimeoutMessage(input: {
  url: string;
  proxyRule?: string | null;
  elapsedMs: number;
}): string {
  const parts = [`Navigation timed out after ${Math.round(input.elapsedMs / 1000)}s`];
  if (input.url) parts.push(`loading '${input.url}'`);
  const proxy = proxyOf(input.proxyRule);
  if (proxy) parts.push(`via proxy ${proxy}`);
  return parts.join(' ');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Is this page worth handing to the caller even though no did-finish-load
 * arrived? A page on the target host that has rendered its title and content
 * is usable — a slow network is not a failure, and the caller can act on it.
 * A blank/error document, or a leftover page from a previous navigation, is
 * not, and the navigation is reported as failed.
 */
export function isDocumentUsable(doc: PageSnapshot | null, targetUrl: string): boolean {
  if (!doc) return false;
  const target = hostOf(targetUrl);
  if (!target || hostOf(doc.href) !== target) return false;
  if (doc.readyState === 'complete' || doc.readyState === 'interactive') return true;
  return doc.title.trim() !== '' && doc.nodes > 0;
}

/**
 * Pull Chromium's net error out of an Electron `loadURL()` rejection, which
 * carries `errno`/`code` and a message like "ERR_FAILED (-2) loading '…'".
 */
export function netErrorOf(error: unknown): { code: number | null; name: string | null } {
  const e = error as { errno?: unknown; code?: unknown; message?: unknown } | null;
  const code =
    typeof e?.errno === 'number' ? e.errno : typeof e?.code === 'number' ? e.code : null;
  let name: string | null = typeof e?.code === 'string' ? e.code : null;
  if (!name && typeof e?.message === 'string') {
    const hit = /^(ERR_[A-Z0-9_]+)/.exec(e.message);
    if (hit) name = hit[1];
  }
  return { code, name };
}
