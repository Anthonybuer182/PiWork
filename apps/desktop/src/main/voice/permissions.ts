/**
 * Microphone permission for the app's own renderer.
 *
 * Electron grants nothing by default (`getUserMedia` fails without a request
 * handler). Only the host windows may ask, and only for audio: plugin panel
 * WebContentsViews share this session and must not be able to open the mic.
 * The embedded browser uses its own partition and is unaffected.
 */

import { session } from 'electron';
import type { WindowRegistry } from '../windows.js';

export function installMicrophonePermissionHandler(windows: WindowRegistry): void {
  const isHostWindow = (sender: Electron.WebContents | null | undefined): boolean => {
    if (!sender) return false;
    const context = windows.byWebContents(sender);
    return !!context && context.hostWebContentsId === sender.id;
  };

  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Only media is constrained here. Electron grants other requests when no
    // handler is installed; denying them would quietly break clipboard and
    // notification behaviour that already worked.
    if (permission !== 'media') {
      callback(true);
      return;
    }
    const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? [];
    const audioOnly = mediaTypes.includes('audio') && !mediaTypes.includes('video');
    callback(isHostWindow(webContents) && audioOnly);
  });

  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (permission !== 'media') return true;
    const mediaType = (details as { mediaType?: string } | undefined)?.mediaType;
    return isHostWindow(webContents) && mediaType !== 'video';
  });
}
