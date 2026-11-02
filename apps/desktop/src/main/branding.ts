/**
 * The name the OS shows for this app — Dock tooltip, application menu, window
 * titles — and the one Electron derives the userData directory from.
 *
 * A plain constant rather than a `package.json` read: `app.setName()` has to
 * run synchronously at module scope, before the first `app.getPath()` call.
 *
 * It must stay in sync with `productName` in electron-builder.yml, which is
 * what a packaged build's Info.plist / Windows version resource says.
 */
export const APP_NAME = 'PiWork';
