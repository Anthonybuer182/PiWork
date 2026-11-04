/**
 * Applying the proxy choice to both network stacks.
 *
 * Chromium gets it through `session.setProxy` — that covers renderer fetches,
 * plugin views and the embedded browser. Node's `fetch` in main (model
 * providers, voice vendors, the plugin market, the VLM analyzer) has no
 * system-proxy integration at all, so the answer Chromium resolves for the OS
 * is handed to undici instead, and global fetch is pointed at undici so it
 * uses that dispatcher.
 *
 * Both directions take effect on the next request, which is why the settings
 * page can say 改完立即生效 instead of asking for a restart.
 */
import { app, session, type Session } from 'electron';
import * as undici from 'undici';
import type { ProxySettings, ProxyState } from '@pi/types';
import {
  chromiumProxyConfig,
  effectiveProxy,
  LOOPBACK_NO_PROXY,
  parseResolvedProxy,
  sanitizeProxySettings,
} from './rules';
import { readProxySettings, writeProxySettings } from './settings';

/**
 * A host that is never local, so the system's answer is the one used for the
 * open internet rather than a loopback exemption.
 */
const PROBE_URL = 'https://example.com/';
/** In-memory session, so asking the OS does not create a profile on disk. */
const PROBE_PARTITION = 'pi-network-probe';

/**
 * The same idle ceiling the coding agent's own dispatcher uses: long model
 * streams may pause, but a dead connection must not hang a turn forever.
 */
const HTTP_TIMEOUT_MS = 300_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ProxyService {
  private settings: ProxySettings;
  private systemProxy: string | null = null;
  private error: string | null = null;
  /** Sessions that should carry the app's proxy; new ones join in `install`. */
  private readonly managed = new Set<Session>();
  /** Global fetch is bound to undici's implementation once, on first apply. */
  private installed = false;
  private probe: Session | null = null;
  private dispatcher: undici.Dispatcher | null = null;
  /** Applies run one at a time, so a fast pair of changes cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.settings = readProxySettings(filePath);
  }

  state(): ProxyState {
    return { settings: { ...this.settings }, systemProxy: this.systemProxy, error: this.error };
  }

  /**
   * Take over the sessions and apply the saved choice. Call once, after
   * `app.whenReady()` and before the first window loads.
   */
  async install(): Promise<ProxyState> {
    // Created before the listener so it never gets the app's proxy: it must
    // keep asking the OS what *it* would do.
    this.probe = session.fromPartition(PROBE_PARTITION, { cache: false });
    this.managed.add(session.defaultSession);
    app.on('session-created', (ses) => {
      if (ses === this.probe || this.managed.has(ses)) return;
      this.managed.add(ses);
      void this.applyToSession(ses);
    });
    return this.apply();
  }

  /** Validate, persist and apply a new choice. Never throws: bad input comes back as `error`. */
  update(raw: unknown): Promise<ProxyState> {
    let next: ProxySettings;
    try {
      next = sanitizeProxySettings(raw, this.settings);
    } catch (err) {
      return Promise.resolve({ ...this.state(), error: message(err) });
    }

    writeProxySettings(this.filePath, next);
    this.settings = next;
    return this.apply();
  }

  apply(): Promise<ProxyState> {
    return this.enqueue(() => this.applyNow());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Both handlers: a failed apply must not swallow the next change.
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async applyNow(): Promise<ProxyState> {
    this.error = null;
    this.systemProxy = await this.readSystemProxy().catch(() => null);

    for (const ses of this.managed) await this.applyToSession(ses);

    try {
      this.applyToFetch();
    } catch (err) {
      this.error = message(err);
    }
    return this.state();
  }

  private async applyToSession(ses: Session): Promise<void> {
    try {
      await ses.setProxy(chromiumProxyConfig(this.settings));
    } catch (err) {
      this.error = message(err);
    }
  }

  /**
   * What the OS would use for the open internet, in the form the app stores
   * proxies in. A separate session keeps this answer independent of whatever
   * the app itself is set to.
   */
  private async readSystemProxy(): Promise<string | null> {
    const probe = this.probe;
    if (!probe) return null;
    await probe.setProxy({ mode: 'system' });
    return parseResolvedProxy(await probe.resolveProxy(PROBE_URL));
  }

  private applyToFetch(): void {
    const proxy = effectiveProxy(this.settings, this.systemProxy);
    const options = {
      allowH2: false,
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
    };

    let dispatcher: undici.Dispatcher;
    if (!proxy) {
      dispatcher = new undici.Agent(options);
    } else if (proxy.startsWith('socks5:')) {
      dispatcher = new undici.Socks5ProxyAgent(proxy, options);
    } else {
      dispatcher = new undici.EnvHttpProxyAgent({
        ...options,
        httpProxy: proxy,
        httpsProxy: proxy,
        noProxy: LOOPBACK_NO_PROXY,
      });
    }

    const previous = this.dispatcher;
    this.dispatcher = dispatcher;
    undici.setGlobalDispatcher(dispatcher);
    if (!this.installed) {
      // Point global fetch at undici's implementation, the one this
      // dispatcher belongs to; Node's built-in fetch would ignore it.
      undici.install?.();
      this.installed = true;
    }
    // Let in-flight requests finish, then drop the old sockets. A failure to
    // close is not worth surfacing — the new dispatcher is already in place.
    if (previous) void previous.close().catch(() => undefined);
  }
}
