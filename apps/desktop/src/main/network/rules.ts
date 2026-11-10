/**
 * The proxy rules themselves, kept free of Electron and undici so they can be
 * unit-tested directly.
 *
 * Two stacks consume the same choice and each wants it in its own dialect:
 * Chromium takes `proxyRules` / `mode` for `session.setProxy`, undici takes a
 * dispatcher built from a proxy URL. Everything that translates between the
 * user's typed value and those dialects lives here.
 */

import type { ProxySettings } from '@pi/types';

/** Follow the OS until told otherwise — the least surprising default. */
export const DEFAULT_PROXY_SETTINGS: ProxySettings = { mode: 'system', url: '' };

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

/**
 * Loopback never goes through the proxy. Chromium already bypasses localhost
 * implicitly; undici does not, and a proxy in front of a local dev server or
 * an in-app call would fail for no reason. (`::1` is left out: undici's
 * noProxy parser reads `::1` as `host:port` and would never match it.)
 */
export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1';

/**
 * A proxy address as someone would actually type it.
 *
 * `127.0.0.1:7897` is accepted and read as HTTP; an explicit scheme may be
 * http, https or socks5. Proxy credentials are rejected rather than silently
 * dropped: Chromium would answer 407 and nobody would see the prompt.
 */
export function normalizeProxyUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!PROXY_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/** Validate a renderer patch and fold it into the current settings. */
export function sanitizeProxySettings(raw: unknown, current: ProxySettings): ProxySettings {
  const patch = (raw ?? {}) as { mode?: unknown; url?: unknown };

  const mode = patch.mode === undefined ? current.mode : patch.mode;
  if (mode !== 'system' && mode !== 'direct' && mode !== 'manual') {
    throw new Error('不认识的连接方式。');
  }

  let url = current.url;
  if (patch.url !== undefined) {
    if (typeof patch.url !== 'string') throw new Error('代理地址必须是一段文字。');
    url = patch.url.trim();
  }

  if (mode === 'manual') {
    if (!url) throw new Error('请填一个代理地址，例如 http://127.0.0.1:7897。');
    const normalized = normalizeProxyUrl(url);
    if (!normalized) {
      throw new Error(
        '这个代理地址看不懂，请用 http://主机:端口 的写法（支持 http、https、socks5）。',
      );
    }
    return { mode, url: normalized };
  }

  return { mode, url };
}

export interface ChromiumProxyConfig {
  mode: 'direct' | 'system' | 'fixed_servers';
  proxyRules?: string;
}

/** The shape `session.setProxy()` expects. */
export function chromiumProxyConfig(settings: ProxySettings): ChromiumProxyConfig {
  if (settings.mode === 'direct') return { mode: 'direct' };
  if (settings.mode === 'system') return { mode: 'system' };

  const proxy = normalizeProxyUrl(settings.url);
  // Unreachable through the settings IPC (sanitize rejects it first), but a
  // hand-edited settings file must not put Chromium in an invalid state.
  if (!proxy) return { mode: 'system' };

  const url = new URL(proxy);
  // A bare host:port is Chromium's "use this for every scheme". SOCKS is the
  // exception: it has to name its version.
  const rules = url.protocol === 'socks5:' ? `socks5://${url.host}` : url.host;
  return { mode: 'fixed_servers', proxyRules: rules };
}

/**
 * Chromium answers `resolveProxy()` with a ranked list, e.g.
 * `PROXY 127.0.0.1:7897; DIRECT` or `DIRECT`. The first entry is the one that
 * would be used, so it decides.
 */
export function parseResolvedProxy(resolved: string): string | null {
  for (const part of resolved.split(';')) {
    const [kind, host] = part.trim().split(/\s+/);
    if (!kind) continue;
    switch (kind.toUpperCase()) {
      case 'DIRECT':
        return null;
      case 'PROXY':
        return host ? `http://${host}` : null;
      case 'HTTPS':
        return host ? `https://${host}` : null;
      case 'SOCKS':
      case 'SOCKS5':
        return host ? `socks5://${host}` : null;
    }
  }
  return null;
}

/** The proxy URL requests actually travel through, or null for a direct route. */
export function effectiveProxy(settings: ProxySettings, systemProxy: string | null): string | null {
  if (settings.mode === 'direct') return null;
  if (settings.mode === 'system') return systemProxy;
  return normalizeProxyUrl(settings.url);
}
