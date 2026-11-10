/**
 * How the app reaches the network.
 *
 * Two independent stacks issue requests: Chromium (renderer fetches, plugin
 * views, the embedded browser) and Node's `fetch` in the main process (model
 * providers, voice vendors, the plugin market). A proxy choice has to reach
 * both, and the second one has no system integration of its own — main
 * resolves the OS setting through Chromium and hands the answer to undici.
 *
 * Unlike the data location, this applies as soon as it is saved: both stacks
 * read the setting per request.
 */

export type ProxyMode = 'system' | 'direct' | 'manual';

export interface ProxySettings {
  mode: ProxyMode;
  /**
   * Manual proxy address, e.g. `http://127.0.0.1:7897` or
   * `socks5://127.0.0.1:1080`. Kept while another mode is selected so
   * switching back does not lose it; only used when mode is `manual`.
   */
  url: string;
}

export interface ProxyState {
  settings: ProxySettings;
  /**
   * What the OS proxy resolves to right now, e.g. `http://127.0.0.1:7897`.
   * Null when the system says direct. Shown under 跟随系统 so the choice is
   * not a black box.
   */
  systemProxy: string | null;
  /**
   * The last change could not be applied. The previous route stays in place;
   * the settings page shows this instead of pretending it worked.
   */
  error: string | null;
}
