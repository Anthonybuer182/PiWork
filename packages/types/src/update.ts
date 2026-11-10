/**
 * Desktop update check: GitHub releases → the installer for this platform.
 *
 * Checking is a plain fetch against the public releases API (no electron-updater
 * feed, no signing key); the update itself is a manual install the user starts
 * by opening the downloaded package. The shape below is what main returns to
 * the renderer's 设置 → 关于 page.
 */

export interface UpdateAsset {
  /** Release asset file name, e.g. `Pi.Coding.Agent-0.2.0-arm64.dmg`. */
  name: string;
  /** Direct download URL for the asset. */
  url: string;
  /** Size in bytes; 0 when the release metadata does not report one. */
  size: number;
  /** Expected sha256 (lower-case hex) when GitHub publishes a digest. */
  sha256: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  /** Version from the latest release tag, with any leading `v` stripped. */
  latestVersion: string | null;
  hasUpdate: boolean;
  /** The installer for this platform/arch; null when this release has none. */
  asset: UpdateAsset | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  /** Release body (Markdown), capped to a readable length. */
  notes: string | null;
  /** Set when the check itself failed — network, rate limit, no releases. */
  error: string | null;
}

export type UpdateDownloadPhase = 'idle' | 'downloading' | 'downloaded' | 'error';

export interface UpdateDownloadState {
  phase: UpdateDownloadPhase;
  /** Bytes written so far. */
  received: number;
  /** Total bytes, or 0 while unknown. */
  total: number;
  fileName: string | null;
  filePath: string | null;
  error: string | null;
}

export interface UpdateDownloadResult {
  ok: boolean;
  filePath: string | null;
  error: string | null;
}

export interface UpdateInstallResult {
  ok: boolean;
  error: string | null;
  /**
   * True when the app must exit now so the installer can replace it
   * (darwin/win32). Linux hands the file to the desktop instead.
   */
  willQuit: boolean;
}
