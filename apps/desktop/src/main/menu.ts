import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from './branding';
import type { WindowRegistry } from './windows';

/**
 * macOS app menu. Spelled out instead of `role: 'appMenu'` so it shows the
 * product name rather than whatever the running bundle happens to be called
 * (in development that is still Electron.app, even though `app.setName()` in
 * index.ts has already fixed the userData directory and the window titles).
 */
const APP_MENU: MenuItemConstructorOptions = {
  label: APP_NAME,
  submenu: [
    { role: 'about' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ],
};

/**
 * The application menu.
 *
 * Electron ships a default menu when none is set; replacing it means the
 * standard roles (Edit copy/paste, View reload, Window) have to be spelled
 * out again, otherwise macOS loses its text-editing accelerators the moment
 * we add a File menu of our own.
 */
export function installApplicationMenu(windows: WindowRegistry): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([APP_MENU] satisfies MenuItemConstructorOptions[]) : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            windows.newFromFocused();
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub',
          click: () => {
            void import('electron').then(({ shell }) =>
              shell.openExternal('https://github.com/Anthonybuer182/PiWork'),
            );
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
