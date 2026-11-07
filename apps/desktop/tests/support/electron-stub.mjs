/**
 * The slice of `electron` the main-process modules touch at import time.
 *
 * Importing the real package from plain Node fails (it is a CJS shim that
 * expects Electron's runtime), and a unit test never registers IPC anyway, so
 * the channels are inert.
 */

export const ipcMain = {
  handle() {},
  removeHandler() {},
  on() {},
  once() {},
  removeAllListeners() {},
};

/**
 * Inference runs in a utility process in the app; unit tests never reach it
 * (they only import the module graph), so forking is a hard error.
 */
export const utilityProcess = {
  fork() {
    throw new Error('utilityProcess is not available in unit tests');
  },
};

/** Minimal app/browser stubs for main modules that import them at load time. */
export const app = {
  getPath: () => '/tmp',
  getVersion: () => '0.0.0',
  getName: () => 'test',
};
export class BrowserWindow {
  static getFocusedWindow() {
    return null;
  }
  static getAllWindows() {
    return [];
  }
}
export const shell = {
  openPath: async () => '',
  showItemInFolder() {},
};
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
};
export class Notification {
  constructor() {}
  show() {}
}
export const net = {
  fetch: async () => {
    throw new Error('net.fetch is not available in unit tests');
  },
};

export default { ipcMain, utilityProcess, app, shell, BrowserWindow, dialog, Notification, net };
