/**
 * Where the app keeps its data on disk, and how much of it there is.
 *
 * The agent's data directory is the one that matters: sessions, settings,
 * auth, models, plugins, skills and prompts all derive from it. The desktop
 * shell persists a chosen location and hands it to the SDK at startup, so a
 * change here needs a restart — everything already open under the old root
 * cannot be moved out from under a running session.
 */

/**
 * A measured area of on-disk data. `id` is stable; the settings UI owns the
 * label, so the list can be reordered or renamed without touching main.
 */
export type StorageEntryId = 'sessions' | 'plugins' | 'skills' | 'runtime' | 'other' | 'app-data';

export interface StorageEntry {
  id: StorageEntryId;
  path: string;
  bytes: number;
  /** Regular files only; directories are counted as containers, not data. */
  files: number;
}

export interface StorageInfo {
  /** The directory the SDK is using in this run. */
  agentDir: string;
  /** The built-in location, `~/.pi/agent`. */
  defaultAgentDir: string;
  /** The location came from Settings rather than the built-in default. */
  custom: boolean;
  /** A different location is saved and will be used after a restart. */
  restartRequired: boolean;
  /**
   * The location that takes effect after a restart. Null when nothing is
   * pending. Never equals `agentDir` while a change is waiting.
   */
  pendingAgentDir: string | null;
  /** App-level data: window layout, permission audit, voice models, caches. */
  appDataDir: string;
  entries: StorageEntry[];
  totalBytes: number;
}

export interface ChangeAgentDirResult {
  info: StorageInfo;
  /**
   * Files copied from the old location. 0 when the target was not empty (the
   * data already there is used as-is) or migration was declined.
   */
  copiedFiles: number;
  /** The target directory already held data, so nothing was copied. */
  usedExisting: boolean;
}
