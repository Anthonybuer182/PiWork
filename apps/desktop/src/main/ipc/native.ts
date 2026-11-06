import { ipcMain, dialog, shell, clipboard, app, BrowserWindow, nativeImage, Menu, ClipboardItem } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'fs';
import path from 'path';
import { TITLE_BAR_HEIGHT } from '../window-manager.js';
import { setApplicationLanguage } from '../menu.js';
import type { WindowRegistry } from '../windows.js';

/**
 * The window a call came from. `fromWebContents` covers shell renderers and
 * engine views; the registry fallback covers plugin panel views, which are
 * WebContentsViews and therefore not "the window" themselves. Focused-window
 * lookups are wrong here: with two windows open, a title-bar click in the
 * background window would otherwise act on the front one.
 */
function senderWindow(windows: WindowRegistry, event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender) ?? windows.byWebContents(event.sender)?.win ?? null;
  if (!win) return null;
  // Only the top frame of a known renderer may act: a subframe must never be
  // able to minimise/close someone else's window.
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return null;
  return win;
}

export function registerNativeIpcHandlers(windows: WindowRegistry): void {
  // ── Window Management ──

  ipcMain.handle('pi:window:minimize', (event) => {
    senderWindow(windows, event)?.minimize();
  });

  // ── Native context menus ──
  // The renderer's popup menus must float ABOVE the plugin panels' native
  // WebContentsViews — those views sit over all window DOM, so a DOM dropdown
  // anchored in the header band gets covered the moment it reaches the panel
  // body. An OS-level Menu composites above everything: the renderer
  // describes the entries, main shows the menu, and clicks round-trip with
  // the nonce identifying the open call.

  ipcMain.handle(
    'pi:menu:popup',
    (
      event,
      payload: {
        nonce?: number;
        x?: number;
        y?: number;
        items?: { id?: string; label: string; enabled?: boolean; separatorBefore?: boolean }[];
      },
    ) => {
      const win = senderWindow(windows, event);
      if (!win) return { ok: false };
      const template: Electron.MenuItemConstructorOptions[] = [];
      for (const item of payload.items ?? []) {
        if (item.separatorBefore) template.push({ type: 'separator' });
        template.push({
          label: item.label,
          enabled: item.enabled !== false,
          click: item.id
            ? () => {
                // Reply to the SENDER view — plugin pages pop this menu too,
                // and their choices must route back to their own preload.
                if (!event.sender.isDestroyed()) {
                  event.sender.send('pi:menu:click', { nonce: payload.nonce, id: item.id });
                }
              }
            : undefined,
        });
      }
      const menu = Menu.buildFromTemplate(template);
      // The caller's coordinates are PAGE-local. For a plugin page hosted in
      // a WebContentsView, the view sits at an offset inside the window —
      // translate so the menu pops at the caller's cursor, not the window's
      // top-left corner (where a small one-item menu is easy to miss
      // entirely). The host's own view sits at 0,0, so its popups are
      // unaffected.
      let offsetX = 0;
      let offsetY = 0;
      for (const child of win.contentView.children ?? []) {
        const view = child as Electron.WebContentsView;
        if (view.webContents === event.sender) {
          const b = view.getBounds();
          offsetX = b.x;
          offsetY = b.y;
          break;
        }
      }
      menu.popup({
        window: win,
        ...(payload.x != null && payload.y != null
          ? { x: offsetX + Math.round(payload.x), y: offsetY + Math.round(payload.y) }
          : {}),
        // Fires when the menu closes WITHOUT a click (dismissed via Esc /
        // outside click) — the renderer resolves the waiting call with null.
        callback: () => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('pi:menu:dismiss', { nonce: payload.nonce });
          }
        },
      });
      return { ok: true };
    },
  );


  ipcMain.handle('pi:window:maximize', (event) => {
    const win = senderWindow(windows, event);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle('pi:window:close', (event) => {
    senderWindow(windows, event)?.close();
  });

  ipcMain.handle('pi:window:isMaximized', (event) => {
    return senderWindow(windows, event)?.isMaximized() ?? false;
  });

  // Keep the Windows titleBarOverlay in step with the app theme. Throws (and is
  // swallowed) on macOS/Linux, which have no overlay to update.
  ipcMain.handle(
    'pi:window:setTitleBarOverlay',
    (event, options: { color: string; symbolColor: string }) => {
      const win = senderWindow(windows, event);
      if (!win) return;
      try {
        win.setTitleBarOverlay({
          color: options.color,
          symbolColor: options.symbolColor,
          height: TITLE_BAR_HEIGHT,
        });
      } catch {
        // Not supported on this platform.
      }
    },
  );

  // ── File Dialogs ──

  ipcMain.handle('pi:dialog:openFile', async (event, options?: Electron.OpenDialogOptions) => {
    const win = senderWindow(windows, event);
    if (!win) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(win, {
      properties: ['openFile'],
      ...options,
    });
  });

  ipcMain.handle('pi:dialog:openDirectory', async (event, options?: Electron.OpenDialogOptions) => {
    const win = senderWindow(windows, event);
    if (!win) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      ...options,
    });
  });

  ipcMain.handle('pi:dialog:saveFile', async (event, options?: Electron.SaveDialogOptions) => {
    const win = senderWindow(windows, event);
    if (!win) return { canceled: true, filePath: undefined };
    return dialog.showSaveDialog(win, options ?? {});
  });

  // ── File System ──

  ipcMain.handle('pi:fs:readFile', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const content = fs.readFileSync(resolved, 'utf-8');
      return { content, path: resolved };
    } catch (err) {
      throw new Error(`Failed to read file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:writeFile', async (_event, filePath: string, content: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to write file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:readFileBuffer', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const buffer = fs.readFileSync(resolved);
      return { buffer, path: resolved };
    } catch (err) {
      throw new Error(`Failed to read file buffer: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:writeFileBuffer', async (_event, filePath: string, buffer: ArrayBuffer) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, Buffer.from(buffer));
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to write file buffer: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:stat', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const stat = fs.statSync(resolved);
      return {
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ctime: stat.ctime.toISOString(),
      };
    } catch {
      return { exists: false };
    }
  });

  ipcMain.handle('pi:fs:exists', async (_event, filePath: string) => {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    return fs.existsSync(resolved);
  });

  ipcMain.handle('pi:fs:mkdir', async (_event, dirPath: string) => {
    try {
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);
      fs.mkdirSync(resolved, { recursive: true });
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to create directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:listDir', async (_event, dirPath: string) => {
    try {
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        path: path.join(resolved, entry.name),
      }));
    } catch (err) {
      throw new Error(`Failed to list directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:delete', async (_event, targetPath: string) => {
    try {
      const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
      if (fs.statSync(resolved).isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      return { success: true };
    } catch (err) {
      throw new Error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:rename', async (_event, oldPath: string, newPath: string) => {
    try {
      const resolvedOld = path.isAbsolute(oldPath) ? oldPath : path.resolve(oldPath);
      const resolvedNew = path.isAbsolute(newPath) ? newPath : path.resolve(newPath);
      fs.renameSync(resolvedOld, resolvedNew);
      return { success: true, path: resolvedNew };
    } catch (err) {
      throw new Error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  // ── Shell ──

  ipcMain.handle('pi:shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('pi:shell:openPath', async (_event, targetPath: string) => {
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
    await shell.openPath(resolved);
  });

  ipcMain.handle('pi:shell:showItemInFolder', (_event, targetPath: string) => {
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
    shell.showItemInFolder(resolved);
  });

  // ── Clipboard ──

  ipcMain.handle('pi:clipboard:write', async (_event, text: string) => {
    // Electron 45 made the clipboard async (W3C-shaped API).
    await clipboard.writeText(text);
  });

  ipcMain.handle('pi:clipboard:read', () => {
    return clipboard.readText();
  });

  ipcMain.handle('pi:clipboard:writeImage', async (_event, imagePath: string) => {
    const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(imagePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Image file not found: ${resolved}`);
    }
    const img = nativeImage.createFromPath(resolved);
    if (img.isEmpty()) {
      throw new Error(`Failed to load image from: ${resolved}`);
    }
    // `clipboard.writeImage()` is gone in Electron 45: images go through the
    // async ClipboardItem API, one MIME entry per item. Copy into a plain
    // Uint8Array — a Node Buffer's backing store may be a SharedArrayBuffer,
    // which the DOM Blob typing does not accept.
    const png = new Uint8Array(img.toPNG());
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
    ]);
  });

  ipcMain.handle('pi:clipboard:clear', () => {
    clipboard.clear();
  });

  // ── App Info ──

  ipcMain.handle('pi:app:getPath', (_event, name: string) => {
    const validPaths = ['home', 'appData', 'userData', 'sessionData', 'temp', 'exe', 'module', 'desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'recent', 'logs', 'crashDumps'];
    if (!validPaths.includes(name)) {
      throw new Error(`Invalid path name: ${name}. Valid names: ${validPaths.join(', ')}`);
    }
    return app.getPath(name as any);
  });

  ipcMain.handle('pi:app:getVersion', () => {
    return app.getVersion();
  });

  // 设置 → 通用 → 语言. The native menu bar is app-global and lives in main,
  // which cannot read the renderer's localStorage; the renderer announces the
  // value on mount and on every change so the menu can relabel itself.
  ipcMain.handle('pi:app:setLanguage', (_event, language: unknown) => {
    setApplicationLanguage(language);
  });
}
