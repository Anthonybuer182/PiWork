import { ipcMain } from 'electron';
import { assertHostWindow } from './guard.js';
import { importFilesIntoWorkspace } from '../files/import-files.js';

/**
 * Copy OS-dropped paths into the window's active workspace.
 *
 * The destination is main's own per-window `workspacePath`, never a
 * renderer-supplied root — the same trust boundary as the other privileged
 * channels (see `guard.ts`). Dropping into a window with no workspace yet is a
 * real race (main learns the workspace from the renderer after startup) and
 * surfaces as a clear rejection rather than a silent no-op.
 */
export function registerImportFilesIpc(): void {
  ipcMain.handle('pi:fs:importFiles', async (event, sources: unknown) => {
    const ctx = assertHostWindow(event);
    if (!ctx.workspacePath) throw new Error('No active workspace');
    return importFilesIntoWorkspace(ctx.workspacePath, sources);
  });
}
