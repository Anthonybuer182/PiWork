/**
 * 设置 → 关于 → 检查更新.
 *
 * The check reads the newest GitHub release and compares its tag with
 * `app.getVersion()`. When it is newer, the release's installer for this
 * platform is downloaded to the user's Downloads folder and opened — the app
 * ships unsigned and has no updater feed, so installing stays a step the user
 * sees and starts, not a silent replacement of a running bundle.
 *
 * Fetch runs in main, where the proxy chosen in 设置 → 通用 already applies
 * (see network/proxy.ts): the GitHub API is not reachable directly from every
 * network this app is used on.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, chmod, rename, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, shell } from 'electron';
import type {
  UpdateAsset,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateDownloadState,
  UpdateInstallResult,
} from '@pi/types';
import {
  compareVersions,
  isSupportedPlatform,
  normalizeVersion,
  pickAsset,
  toUpdateAsset,
  type ReleaseAssetLike,
  type UpdatePlatform,
} from './release';

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'Anthonybuer182/PiWork';
const RELEASES_PAGE = `https://github.com/${DEFAULT_REPO}/releases`;
const UPDATE_DIR_NAME = 'PiWork-updates';
const CHECK_TIMEOUT_MS = 20_000;
/** Notes are formatted Markdown; long changelogs only flood the dialog. */
const NOTES_LIMIT = 8_000;

export interface UpdateServiceOptions {
  /**
   * GitHub API base. `PI_UPDATE_API_BASE` overrides it at runtime so the whole
   * check/download path can be exercised against a local server.
   */
  apiBase?: string;
  repo?: string;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where installers land. Defaults to `<Downloads>/PiWork-updates`. */
  downloadsDir?: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class UpdateService {
  private readonly apiBase: string;
  private readonly repo: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly downloadsDirOption: string | undefined;
  private readonly currentVersionValue: string;

  private state: UpdateDownloadState = {
    phase: 'idle',
    received: 0,
    total: 0,
    fileName: null,
    filePath: null,
    error: null,
  };
  /** The download in flight, if any. One at a time. */
  private inflight: { controller: AbortController } | null = null;

  constructor(options: UpdateServiceOptions = {}) {
    this.apiBase = (options.apiBase ?? process.env.PI_UPDATE_API_BASE ?? DEFAULT_API_BASE).replace(
      /\/+$/,
      '',
    );
    this.repo = options.repo ?? DEFAULT_REPO;
    this.platform = (options.platform ?? process.platform) as NodeJS.Platform;
    this.arch = options.arch ?? process.arch;
    this.downloadsDirOption = options.downloadsDir;
    this.currentVersionValue = options.currentVersion ?? app.getVersion();
  }

  get currentVersion(): string {
    return this.currentVersionValue;
  }

  /** Where installers are saved; created on the first download. */
  downloadsDir(): string {
    return this.downloadsDirOption ?? join(app.getPath('downloads'), UPDATE_DIR_NAME);
  }

  /** The download's current state, so reopening the dialog can pick it up. */
  snapshot(): UpdateDownloadState {
    return { ...this.state };
  }

  /**
   * Ask GitHub for the newest release. Never throws: every failure comes back
   * as `error`, so the renderer has one shape to render.
   */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = this.currentVersion;
    const empty: UpdateCheckResult = {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      asset: null,
      releaseUrl: RELEASES_PAGE,
      releaseName: null,
      publishedAt: null,
      notes: null,
      error: null,
    };

    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/repos/${this.repo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `PiWork/${currentVersion}`,
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (err) {
      return { ...empty, error: errorMessage(err) };
    }

    if (response.status === 404) {
      return { ...empty, error: '没有找到发布版本。' };
    }
    if (!response.ok) {
      return {
        ...empty,
        error: `GitHub 返回 ${response.status}${response.status === 403 ? '（可能是接口调用过于频繁，稍后再试）' : ''}`,
      };
    }

    let release: GitHubRelease;
    try {
      release = (await response.json()) as GitHubRelease;
    } catch {
      return { ...empty, error: '更新信息格式不正确。' };
    }

    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    if (!tag) return { ...empty, error: '更新信息里没有版本号。' };

    const latestVersion = normalizeVersion(tag);
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    const assets = Array.isArray(release.assets)
      ? (release.assets as ReleaseAssetLike[]).filter(
          (asset): asset is ReleaseAssetLike =>
            !!asset &&
            typeof asset.name === 'string' &&
            typeof asset.browser_download_url === 'string',
        )
      : [];

    const platform = this.platform as UpdatePlatform;
    const picked =
      hasUpdate && isSupportedPlatform(this.platform)
        ? pickAsset(assets, platform, this.arch)
        : null;

    const notes = typeof release.body === 'string' ? release.body.slice(0, NOTES_LIMIT) : null;

    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      asset: picked ? toUpdateAsset(picked) : null,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : RELEASES_PAGE,
      releaseName: typeof release.name === 'string' ? release.name : tag,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      notes,
      error: null,
    };
  }

  /**
   * Stream the installer to disk, reporting progress as it goes.
   *
   * The body is hashed while it is written and checked against the digest
   * GitHub publishes, so a truncated or replaced download is caught before it
   * is ever opened. Progress callbacks are throttled to ~10/s — a 300 MB file
   * arrives in far more chunks than a progress bar can use.
   */
  async download(
    asset: UpdateAsset,
    onState: (state: UpdateDownloadState) => void,
  ): Promise<UpdateDownloadResult> {
    // A second click replaces the first download instead of racing it.
    this.cancel();

    if (!asset || typeof asset.url !== 'string' || !/^https?:\/\//i.test(asset.url)) {
      return this.fail(null, '下载地址无效。', onState);
    }

    const fileName = basename(asset.name || 'PiWork-update');
    const dir = this.downloadsDir();
    const finalPath = join(dir, fileName);
    // Unique per attempt: a replaced download must not delete the part file
    // of the one now running.
    const token = Math.random().toString(36).slice(2, 8);
    const partPath = `${finalPath}.${token}.part`;

    const controller = new AbortController();
    this.inflight = { controller };

    const total = asset.size > 0 ? asset.size : 0;
    const downloading: UpdateDownloadState = {
      phase: 'downloading',
      received: 0,
      total,
      fileName,
      filePath: null,
      error: null,
    };
    this.setState(downloading, onState);

    let received = 0;
    let lastEmit = 0;
    try {
      await mkdir(dir, { recursive: true });

      const response = await fetch(asset.url, {
        headers: { 'User-Agent': `PiWork/${this.currentVersion}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`下载失败，服务器返回 ${response.status}`);
      }

      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) {
        downloading.total = length;
        this.setState(downloading, onState);
      }

      const hash = createHash('sha256');
      const report = (state: UpdateDownloadState) => {
        // The abort path already moved the UI on; a late chunk must not
        // resurrect a "downloading" state.
        if (controller.signal.aborted) return;
        this.setState({ ...state }, onState);
      };
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          received += (chunk as Buffer).length;
          const now = Date.now();
          if (now - lastEmit >= 100) {
            lastEmit = now;
            downloading.received = received;
            report(downloading);
          }
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(partPath),
      );

      const digest = hash.digest('hex');
      if (asset.sha256 && digest.toLowerCase() !== asset.sha256.toLowerCase()) {
        throw new Error('下载的文件校验不通过，请重试。');
      }

      await rm(finalPath, { force: true });
      await rename(partPath, finalPath);

      const done: UpdateDownloadState = {
        phase: 'downloaded',
        received,
        total: downloading.total || received,
        fileName,
        filePath: finalPath,
        error: null,
      };
      this.state = done;
      onState({ ...done });
      return { ok: true, filePath: finalPath, error: null };
    } catch (err) {
      await rm(partPath, { force: true }).catch(() => undefined);

      if (controller.signal.aborted) {
        const idle: UpdateDownloadState = { ...downloading, phase: 'idle', received, error: null };
        this.state = idle;
        onState({ ...idle });
        return { ok: false, filePath: null, error: null };
      }

      return this.fail(fileName, errorMessage(err), onState);
    } finally {
      // A newer download may already own the slot; only clear our own.
      if (this.inflight?.controller === controller) this.inflight = null;
    }
  }

  /** Stop the download in flight, if any. The part file is removed. */
  cancel(): void {
    this.inflight?.controller.abort();
  }

  /**
   * Start the update: hand the downloaded installer to the OS.
   *
   * On macOS and Windows the caller quits the app next (`willQuit`) — the
   * installer has to replace files the running app holds open, and even a
   * successful overwrite would leave the old process running old code.
   * Linux never replaces the running app this way, so it just opens the file.
   */
  async openInstaller(filePath: unknown): Promise<UpdateInstallResult> {
    if (!this.isDownloadedFile(filePath)) {
      return { ok: false, error: '文件不存在。', willQuit: false };
    }

    if (this.platform === 'linux') {
      // AppImages need the exec bit before a desktop will run them, and a deb
      // goes to whatever package manager xdg-open resolves to. Neither
      // replaces the running app, so there is nothing to quit for.
      if (filePath.toLowerCase().endsWith('.appimage')) {
        await chmod(filePath, 0o755).catch(() => undefined);
      }
      const error = await shell.openPath(filePath);
      if (error) shell.showItemInFolder(filePath);
      return { ok: true, error: null, willQuit: false };
    }

    // darwin/win32: the app must be gone before the installer replaces it —
    // Windows locks the running bundle's files, and on macOS a running
    // process keeps executing the old code even after the .app is replaced.
    const error = await shell.openPath(filePath);
    return error ? { ok: false, error, willQuit: false } : { ok: true, error: null, willQuit: true };
  }

  /** Reveal the downloaded installer in the file manager. */
  reveal(filePath: unknown): { ok: boolean; error: string | null } {
    if (!this.isDownloadedFile(filePath)) return { ok: false, error: '文件不存在。' };
    shell.showItemInFolder(filePath);
    return { ok: true, error: null };
  }

  /**
   * Only files this service downloaded may be opened — the renderer must not
   * be able to turn "打开安装包" into a general "run this path" primitive.
   */
  private isDownloadedFile(filePath: unknown): filePath is string {
    if (typeof filePath !== 'string' || !filePath) return false;
    const root = resolve(this.downloadsDir());
    const target = resolve(filePath);
    return target.startsWith(root + sep) && existsSync(target);
  }

  private setState(
    state: UpdateDownloadState,
    onState: (state: UpdateDownloadState) => void,
  ): void {
    this.state = state;
    onState({ ...state });
  }

  private fail(
    fileName: string | null,
    error: string,
    onState: (state: UpdateDownloadState) => void,
  ): UpdateDownloadResult {
    const state: UpdateDownloadState = {
      phase: 'error',
      received: this.state.received,
      total: this.state.total,
      fileName,
      filePath: null,
      error,
    };
    this.setState(state, onState);
    return { ok: false, filePath: null, error };
  }
}
