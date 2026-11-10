import { ipcMain } from 'electron';
import { assertHostWindow } from './guard.js';
import { saveAttachmentIntoWorkspace } from '../files/save-attachment.js';

/**
 * Copy a composer attachment into this window's workspace.
 *
 * Same trust boundary as `pi:fs:importFiles`: the destination root comes from
 * main's per-window context, never from the renderer. The source is whatever
 * the user picked or dropped — and, on the web build, absent, in which case
 * the preload sends the already-read bytes.
 */
export function registerAttachmentIpc(): void {
  ipcMain.handle('pi:fs:saveAttachment', async (event, input: unknown) => {
    const ctx = assertHostWindow(event);
    if (!ctx.workspacePath) throw new Error('No active workspace');
    return saveAttachmentIntoWorkspace(ctx.workspacePath, input);
  });
}
