import { isPreviewableInRightPanel, openWithSystemApp } from './utils';
import { openPreviewFile, useUIStore } from '../stores/ui-store';
import { toast } from '../stores/toast-store';
import { t } from '../i18n';

/**
 * Open OS-dropped paths in the right column, in drop order.
 *
 * Used by every right-side drop target (the tab strip, the right panel body,
 * and drops forwarded out of plugin views by the desktop preload). Folders are
 * skipped — they have no panel representation — and anything the viewer
 * plugins do not claim is handed to the system, matching a click in the file
 * tree.
 */
export async function openDroppedPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    toast(t('无法获取拖入文件的路径'), 'error');
    return;
  }

  const api = (
    window as unknown as {
      electronAPI?: { fs?: { stat?: (path: string) => Promise<{ isDirectory?: boolean }> } };
    }
  ).electronAPI;
  const workspaceId = useUIStore.getState().activeWorkspaceId ?? undefined;

  let opened = 0;
  for (const path of paths) {
    try {
      // Folders have no panel representation — skip them rather than
      // launching Finder for each one.
      const stat = await api?.fs?.stat?.(path);
      if (stat?.isDirectory) continue;
    } catch {
      continue;
    }
    if (isPreviewableInRightPanel(path)) {
      await openPreviewFile(path);
    } else {
      openWithSystemApp(path, workspaceId);
    }
    opened += 1;
  }
  if (opened === 0) toast(t('没有可打开的文件'), 'error');
}
