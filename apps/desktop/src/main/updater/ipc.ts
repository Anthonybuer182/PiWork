import { app, ipcMain } from 'electron';
import type { UpdateAsset } from '@pi/types';
import type { UpdateService } from './service';

function sanitizeAsset(raw: unknown): UpdateAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, url, size, sha256 } = raw as Record<string, unknown>;
  if (typeof url !== 'string') return null;
  return {
    name: typeof name === 'string' ? name : '',
    url,
    size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
    sha256: typeof sha256 === 'string' ? sha256 : null,
  };
}

/**
 * 设置 → 关于. Only the window that asked for the download receives its
 * progress — with two windows open, the other one's dialog must not start
 * moving a progress bar it never requested.
 */
export function registerUpdateIpc(service: UpdateService): void {
  ipcMain.handle('pi:update:check', () => service.check());

  ipcMain.handle('pi:update:state', () => service.snapshot());

  ipcMain.handle('pi:update:download', (event, payload: unknown) => {
    const asset = sanitizeAsset(payload);
    if (!asset) return { ok: false, filePath: null, error: '下载地址无效。' };
    return service.download(asset, (state) => {
      if (!event.sender.isDestroyed()) event.sender.send('pi:update:progress', state);
    });
  });

  ipcMain.handle('pi:update:cancel', () => {
    service.cancel();
  });

  ipcMain.handle('pi:update:install', async (_event, filePath: unknown) => {
    const result = await service.openInstaller(filePath);
    if (result.ok && result.willQuit) {
      // The answer reaches the renderer first, then the app goes away so the
      // installer can replace it — a short delay, not `will-quit` hooks, so
      // the renderer can paint 正在退出并安装… instead of vanishing mid-state.
      const timer = setTimeout(() => app.quit(), 600);
      timer.unref?.();
    }
    return result;
  });

  ipcMain.handle('pi:update:reveal', (_event, filePath: unknown) => service.reveal(filePath));
}
