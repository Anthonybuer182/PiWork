/**
 * Typed access to the desktop storage bridge (`pi:storage:*`).
 *
 * The web build has no agent directory of its own — it runs against whatever
 * server it was started from — so every caller checks `hasStorageApi()` and
 * hides the section instead of showing controls that cannot work.
 */

import type { ChangeAgentDirResult, StorageInfo } from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';
import { hasDesktopWindowApi } from '@/lib/window-identity';

export function hasStorageApi(): boolean {
  return hasDesktopWindowApi();
}

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const api = electronApi();
  if (!api) return Promise.reject(new Error('Storage is only available in the desktop app.'));
  return invokeWhenReady(api, channel, arg);
}

export const storageApi = {
  info: (): Promise<StorageInfo> => invoke('pi:storage:info') as Promise<StorageInfo>,

  setLocation: (dir: string, migrate: boolean): Promise<ChangeAgentDirResult> =>
    invoke('pi:storage:set-location', { dir, migrate }) as Promise<ChangeAgentDirResult>,

  resetLocation: (): Promise<ChangeAgentDirResult> =>
    invoke('pi:storage:reset-location') as Promise<ChangeAgentDirResult>,

  restart: (): Promise<void> => invoke('pi:storage:restart') as Promise<void>,

  /** Native folder picker; null when the user cancels. */
  chooseDirectory: async (title: string, buttonLabel: string): Promise<string | null> => {
    const result = (await invoke('pi:dialog:openDirectory', {
      title,
      buttonLabel,
      properties: ['openDirectory', 'createDirectory'],
    })) as { canceled?: boolean; filePaths?: string[] } | undefined;
    if (!result || result.canceled) return null;
    return result.filePaths?.[0] ?? null;
  },
};
