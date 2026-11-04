import { app, ipcMain } from 'electron';
import type { StorageService } from './service';

/**
 * Settings → 存储.
 *
 * The folder picker itself is the renderer's existing `dialog.openDirectory`
 * bridge; this module only owns the state changes. Restarting lives here
 * because `app.relaunch()` needs the main process, and quitting normally
 * matters — window geometry is saved on quit, not on exit.
 */
export function registerStorageIpc(service: StorageService): void {
  ipcMain.handle('pi:storage:info', () => service.info());

  ipcMain.handle('pi:storage:set-location', (_event, payload: unknown) => {
    const { dir, migrate } = (payload ?? {}) as { dir?: unknown; migrate?: unknown };
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('缺少目标文件夹。');
    return service.change(dir, migrate !== false);
  });

  ipcMain.handle('pi:storage:reset-location', () => service.reset());

  ipcMain.handle('pi:storage:restart', () => {
    app.relaunch();
    app.quit();
  });
}
