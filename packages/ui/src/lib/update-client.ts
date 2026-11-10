/**
 * Typed access to the desktop update bridge (`pi:update:*`).
 *
 * The web build has no installed app to update, so 设置 → 关于 is hidden there
 * — every caller checks `hasUpdateApi()` rather than rendering buttons that
 * cannot work.
 */

import type {
  UpdateAsset,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateDownloadState,
  UpdateInstallResult,
} from '@pi/types';
import { electronApi, invokeWhenReady, type ElectronBridge } from '@/lib/electron-ipc';
import { hasDesktopWindowApi } from '@/lib/window-identity';

export function hasUpdateApi(): boolean {
  return hasDesktopWindowApi();
}

/**
 * The host platform, for copy that differs per OS: on macOS/Windows install
 * means quitting the app first, on Linux the file is simply opened.
 */
export function updatePlatform(): 'darwin' | 'win32' | 'linux' | null {
  const bridge = (window as unknown as { electronAPI?: { chrome?: { platform?: string } } })
    .electronAPI;
  const platform = bridge?.chrome?.platform;
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : null;
}

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const api = electronApi();
  if (!api) return Promise.reject(new Error('Updates are only available in the desktop app.'));
  return invokeWhenReady(api, channel, arg);
}

export const updateApi = {
  /** The running app's version — shown before any check has been made. */
  version: (): Promise<string> => invoke('pi:app:getVersion') as Promise<string>,

  check: (): Promise<UpdateCheckResult> => invoke('pi:update:check') as Promise<UpdateCheckResult>,

  /** A download started from an earlier dialog may still be running. */
  state: (): Promise<UpdateDownloadState> =>
    invoke('pi:update:state') as Promise<UpdateDownloadState>,

  download: (asset: UpdateAsset): Promise<UpdateDownloadResult> =>
    invoke('pi:update:download', asset) as Promise<UpdateDownloadResult>,

  cancel: (): Promise<void> => invoke('pi:update:cancel') as Promise<void>,

  /**
   * Hand the installer to the OS. On macOS/Windows the app quits right after
   * the answer arrives, so the installer can replace it.
   */
  install: (filePath: string): Promise<UpdateInstallResult> =>
    invoke('pi:update:install', filePath) as Promise<UpdateInstallResult>,

  reveal: (filePath: string): Promise<{ ok: boolean; error: string | null }> =>
    invoke('pi:update:reveal', filePath) as Promise<{ ok: boolean; error: string | null }>,

  /** Subscribe to download progress; returns the unsubscribe function. */
  onProgress: (callback: (state: UpdateDownloadState) => void): (() => void) => {
    const api = electronApi() as
      | (ElectronBridge & {
          removeListener?: (channel: string, cb: (...args: unknown[]) => void) => void;
        })
      | undefined;
    if (!api) return () => {};
    const handler = (...args: unknown[]) => {
      const state = args[0];
      if (state && typeof state === 'object') callback(state as UpdateDownloadState);
    };
    api.on('pi:update:progress', handler);
    return () => api.removeListener?.('pi:update:progress', handler);
  },
};
