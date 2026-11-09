import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { ImportFilesResult, SaveAttachmentInput, SavedAttachment } from '@pi/types';

/**
 * OS file drag-and-drop helpers.
 *
 * The browser exposes only `File` objects on a drop; absolute paths live in
 * the Electron preload (`webUtils.getPathForFile`, exposed as
 * `electronAPI.fs.pathForFile`). Everything here degrades to a no-op in the
 * web build, where the bridge is absent.
 */

interface FsDropBridge {
  pathForFile?: (file: File) => string;
  importFiles?: (sources: string[]) => Promise<ImportFilesResult>;
  saveAttachment?: (input: SaveAttachmentInput) => Promise<SavedAttachment>;
}

function fsBridge(): FsDropBridge | undefined {
  return (window as unknown as { electronAPI?: { fs?: FsDropBridge } }).electronAPI?.fs;
}

/**
 * True while an OS file drag is over the app.
 *
 * During `dragenter`/`dragover` the payload is empty, so `dataTransfer.types`
 * is the only reliable signal; internal app drags carry `text/plain` but no
 * `Files`.
 */
export function isOsFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).some((type) => type.toLowerCase() === 'files');
}

/** Absolute paths of the dropped items; empty on the web or for non-file drags. */
export function droppedFilePaths(dataTransfer: DataTransfer | null | undefined): string[] {
  const fs = fsBridge();
  if (!dataTransfer || !fs?.pathForFile) return [];

  const paths: string[] = [];
  for (const file of Array.from(dataTransfer.files ?? [])) {
    try {
      const path = fs.pathForFile(file);
      // JS-constructed Files (and non-file items) have no OS path.
      if (path) paths.push(path);
    } catch {
      // Not an OS-backed File — ignore it.
    }
  }
  return [...new Set(paths)];
}

/** True when this build can copy dropped files into the workspace. */
export function canImportFiles(): boolean {
  const fs = fsBridge();
  return typeof fs?.pathForFile === 'function' && typeof fs?.importFiles === 'function';
}

/** Copy dropped paths into the window's active workspace (desktop only). */
export async function importDroppedFiles(sources: string[]): Promise<ImportFilesResult> {
  const fs = fsBridge();
  if (!fs?.importFiles) throw new Error('Importing files requires the desktop app');
  return fs.importFiles(sources);
}

/** Absolute OS path of a `File`, or undefined for web/generated files. */
export function pathForFile(file: File): string | undefined {
  const fs = fsBridge();
  if (!fs?.pathForFile) return undefined;
  try {
    const p = fs.pathForFile(file);
    return p || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy a composer attachment into the workspace so it has a previewable path.
 * Undefined on the web build, where there is nothing to preview locally.
 */
export function canSaveAttachment(): boolean {
  return typeof fsBridge()?.saveAttachment === 'function';
}

export async function saveAttachmentToWorkspace(input: SaveAttachmentInput): Promise<SavedAttachment> {
  const fs = fsBridge();
  if (!fs?.saveAttachment) throw new Error('Saving attachments requires the desktop app');
  return fs.saveAttachment(input);
}

export interface OsFileDropHandlers {
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

/**
 * DOM drop target for OS files, with `dragenter`/`dragleave` depth tracking so
 * the caller's highlight does not flicker as the pointer crosses children.
 *
 * Spread `handlers` onto the container and render `active`-driven feedback.
 * `onPaths` runs on the drop with every resolved absolute path (possibly
 * empty, when the payload has no OS-backed files).
 */
export function useOsFileDropTarget(onPaths: (paths: string[]) => void): {
  active: boolean;
  handlers: OsFileDropHandlers;
} {
  const depth = useRef(0);
  const [active, setActive] = useState(false);

  return {
    active,
    handlers: {
      onDragEnter(event) {
        if (!isOsFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragOver(event) {
        if (!isOsFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave(event) {
        if (!isOsFileDrag(event.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDrop(event) {
        if (!isOsFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setActive(false);
        onPaths(droppedFilePaths(event.dataTransfer));
      },
    },
  };
}

/**
 * Stop an OS file dropped outside a real drop target from navigating the
 * renderer to `file://`. The shell has no other window-level guard, and
 * Chromium's default for a file drop is a document navigation.
 *
 * Call once from the shared app shell; target-level handlers still run first,
 * so the composer and the new drop zones keep their behavior.
 */
export function useOsFileDropGuard(): void {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
