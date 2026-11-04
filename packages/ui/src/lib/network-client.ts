/**
 * Typed access to the desktop network bridge (`pi:proxy:*`).
 *
 * The web build runs in whatever browser opened it; it has no network stack
 * of its own to configure, so the 通用 page hides the row instead of offering
 * a switch that cannot work.
 */

import type { ProxySettings, ProxyState } from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';
import { hasDesktopWindowApi } from '@/lib/window-identity';

export function hasProxyApi(): boolean {
  return hasDesktopWindowApi();
}

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const api = electronApi();
  if (!api)
    return Promise.reject(new Error('Network settings are only available in the desktop app.'));
  return invokeWhenReady(api, channel, arg);
}

export const proxyApi = {
  get: (): Promise<ProxyState> => invoke('pi:proxy:get') as Promise<ProxyState>,

  /**
   * Save and apply. Bad input comes back as `state.error` rather than a
   * rejection, so the page can show it inline instead of an IPC failure.
   */
  set: (patch: Partial<ProxySettings>): Promise<ProxyState> =>
    invoke('pi:proxy:set', patch) as Promise<ProxyState>,
};
