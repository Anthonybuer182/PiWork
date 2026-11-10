import { ipcMain } from 'electron';
import type { ProxyState } from '@pi/types';
import type { ProxyService } from './proxy';

export function registerProxyIpc(service: ProxyService): void {
  ipcMain.handle('pi:proxy:get', (): ProxyState => service.state());
  ipcMain.handle('pi:proxy:set', (_event, patch: unknown): Promise<ProxyState> =>
    service.update(patch),
  );
}
