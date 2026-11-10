/**
 * Result of copying OS-dropped paths into a workspace.
 *
 * The renderer never names the destination: main resolves it from the
 * window's active workspace. This type only describes what happened, so the
 * UI can refresh its tree and report skipped entries.
 */
export interface ImportedEntry {
  /** Absolute source path the user dropped. */
  source: string;
  /** Absolute destination path written inside the workspace. */
  path: string;
}

export type ImportSkipReason =
  /** Not a non-empty absolute path. */
  | 'invalid-source'
  /** The source no longer exists or cannot be read. */
  | 'missing'
  /** The source is already this workspace-root entry. */
  | 'already-in-workspace'
  /** The source contains the workspace root (dropping a workspace ancestor). */
  | 'destination-inside-source'
  /** The same path appeared twice in one drop. */
  | 'duplicate'
  /** Copy or stat failed; `message` carries the system error. */
  | 'failed';

export interface SkippedImport {
  source: string;
  reason: ImportSkipReason;
  message?: string;
}

export interface ImportFilesResult {
  /** Workspace root the files were imported into. */
  destination: string;
  imported: ImportedEntry[];
  skipped: SkippedImport[];
}
