import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Boxes,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Power,
  RotateCw,
} from 'lucide-react';
import type { UpdateAsset, UpdateDownloadState } from '@pi/types';
import { useI18n } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { hasUpdateApi, updateApi, updatePlatform } from '@/lib/update-client';
import { bugReportUrl, featureRequestUrl } from '@/lib/feedback';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const REPO_URL = 'https://github.com/Anthonybuer182/PiWork';
const RELEASES_URL = `${REPO_URL}/releases`;

const IDLE_DOWNLOAD: UpdateDownloadState = {
  phase: 'idle',
  received: 0,
  total: 0,
  fileName: null,
  filePath: null,
  error: null,
};

type ElectronShellBridge = {
  shell?: { openExternal?: (url: string) => Promise<void> };
};

/** Open a web link in the OS browser; the web build falls back to a tab. */
function openLink(url: string): void {
  const bridge = (window as unknown as { electronAPI?: ElectronShellBridge }).electronAPI;
  if (bridge?.shell?.openExternal) {
    void bridge.shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function LinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => openLink(url)}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-2"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}

/**
 * 关于 — what this build is, and how it gets replaced by a newer one.
 *
 * The update is deliberately manual: the app is unsigned and has no updater
 * feed, so "检查更新" downloads the installer for this platform next to the
 * user's other downloads. Installing then quits the app first — the installer
 * cannot replace files the running app holds open, and a running process would
 * keep executing the old code even after the bundle was replaced.
 *
 * The check auto-runs when the page opens (react-query caches it for a
 * minute), but the download and its progress live in main: closing the dialog
 * mid-download must not lose the transfer, which is why the page adopts
 * `pi:update:state` on mount.
 */
export function AboutSettingsPage() {
  const { t } = useI18n();
  const platform = updatePlatform();
  const [download, setDownload] = useState<UpdateDownloadState>(IDLE_DOWNLOAD);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => updateApi.version(),
    staleTime: Infinity,
    enabled: hasUpdateApi(),
  });

  const checkQuery = useQuery({
    queryKey: ['update-check'],
    queryFn: () => updateApi.check(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: hasUpdateApi(),
  });

  useEffect(() => {
    if (!hasUpdateApi()) return;
    let alive = true;
    void updateApi
      .state()
      .then((state) => {
        if (alive) setDownload(state);
      })
      .catch(() => undefined);
    const unsubscribe = updateApi.onProgress((state) => setDownload(state));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const result = checkQuery.data;
  const checking = checkQuery.isFetching;
  const version = versionQuery.data;

  const startDownload = async (asset: UpdateAsset) => {
    setActionError(null);
    const res = await updateApi.download(asset);
    if (!res.ok && res.error) {
      setActionError(res.error);
      setDownload((prev) => ({ ...prev, phase: 'error', error: res.error }));
    }
  };

  const installDownloaded = async (filePath: string) => {
    setActionError(null);
    setInstalling(true);
    const res = await updateApi.install(filePath);
    // macOS/Windows quit the app right after the answer lands; the busy state
    // below covers the moment until the window actually goes away. Linux does
    // not quit, so the controls stay usable.
    if (!res.ok || !res.willQuit) setInstalling(false);
    if (!res.ok && res.error) setActionError(res.error);
  };

  const revealDownloaded = async (filePath: string) => {
    setActionError(null);
    const res = await updateApi.reveal(filePath);
    if (!res.ok && res.error) setActionError(res.error);
  };

  // The downloaded file belongs to the release on screen only when the names
  // match — after an update is published, the old installer is not an answer.
  const assetName = result?.asset?.name ?? null;
  const downloadedForAsset =
    download.phase === 'downloaded' &&
    download.filePath &&
    assetName &&
    download.fileName === assetName
      ? download
      : null;
  const downloadingForAsset =
    download.phase === 'downloading' && assetName && download.fileName === assetName
      ? download
      : null;
  const downloadError =
    download.phase === 'error' &&
    download.error &&
    (download.fileName == null || assetName == null || download.fileName === assetName)
      ? download.error
      : null;

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-2">
      <div className="flex items-start gap-4 py-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
          <Boxes className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold">PiWork</span>
            {version && <span className="text-xs text-muted-foreground">v{version}</span>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t('基于 Electron 和 React 的 AI 编程助手。')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <LinkButton url={REPO_URL}>{t('GitHub 仓库')}</LinkButton>
            <LinkButton url={RELEASES_URL}>{t('发布说明')}</LinkButton>
            <LinkButton url={bugReportUrl({ version, platform })}>{t('报告问题')}</LinkButton>
            <LinkButton url={featureRequestUrl()}>{t('功能建议')}</LinkButton>
          </div>
        </div>
      </div>

      <div className="divide-y border-t">
        <div className="py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('软件更新')}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {checking && !result
                  ? t('正在检查更新…')
                  : result?.error
                    ? t('检查更新失败：{message}', { message: result.error })
                    : result?.hasUpdate
                      ? t('发现新版本 {version}。', { version: result.latestVersion ?? '' })
                      : t('已是最新版本。')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[11px]"
                onClick={() => void checkQuery.refetch()}
                disabled={checking}
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
                {checking ? t('正在检查…') : t('检查更新')}
              </Button>
            </div>
          </div>

          {result?.error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{result.error}</span>
            </div>
          )}

          {result?.hasUpdate && (
            <div className="mt-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {result.latestVersion}
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                      {t('当前版本 {version}', { version: result.currentVersion })}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {downloadedForAsset
                      ? t('已下载 {name}。', { name: downloadedForAsset.fileName ?? '' })
                      : result.asset
                        ? platform === 'linux'
                          ? t('下载完成后打开安装包，按提示更新并重新启动应用。')
                          : t('下载完成后退出并安装，装好后重新打开应用即可。')
                        : t('这个版本没有提供适合当前平台的安装包，请到发布页面手动下载。')}
                  </p>
                </div>

                {installing ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('正在退出并安装…')}
                  </span>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    {result.asset && !downloadedForAsset && !downloadingForAsset && (
                      <Button
                        size="sm"
                        className="h-7 gap-1.5 text-[11px]"
                        onClick={() => void startDownload(result.asset!)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {result.asset.size > 0
                          ? t('下载更新（{size}）', { size: formatBytes(result.asset.size) })
                          : t('下载更新')}
                      </Button>
                    )}
                    {downloadedForAsset?.filePath && (
                      <>
                        <Button
                          size="sm"
                          className="h-7 gap-1.5 text-[11px]"
                          onClick={() => {
                            // Linux does not need the app gone first, so skip
                            // the confirm and hand the file straight over.
                            if (platform === 'linux') {
                              void installDownloaded(downloadedForAsset.filePath!);
                            } else {
                              setConfirmingInstall(true);
                            }
                          }}
                        >
                          <Power className="h-3.5 w-3.5" />
                          {platform === 'linux' ? t('打开安装包') : t('退出并安装')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-[11px]"
                          onClick={() => void revealDownloaded(downloadedForAsset.filePath!)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          {t('在文件夹中显示')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {downloadingForAsset && (
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span className="truncate">
                      {t('正在下载 {name}…', { name: downloadingForAsset.fileName ?? '' })}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {downloadingForAsset.total > 0
                        ? `${formatBytes(downloadingForAsset.received)} / ${formatBytes(
                            downloadingForAsset.total,
                          )}`
                        : formatBytes(downloadingForAsset.received)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full bg-primary transition-[width] duration-200',
                        downloadingForAsset.total === 0 && 'w-1/3 animate-pulse',
                      )}
                      style={
                        downloadingForAsset.total > 0
                          ? {
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (downloadingForAsset.received / downloadingForAsset.total) * 100,
                                ),
                              )}%`,
                            }
                          : undefined
                      }
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {downloadingForAsset.total > 0
                        ? `${Math.round(
                            (downloadingForAsset.received / downloadingForAsset.total) * 100,
                          )}%`
                        : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-muted-foreground"
                      onClick={() => void updateApi.cancel()}
                    >
                      {t('取消下载')}
                    </Button>
                  </div>
                </div>
              )}

              {downloadError && (
                <p className="mt-2 text-[11px] leading-relaxed text-destructive">
                  {t('下载失败：{message}', { message: downloadError })}
                </p>
              )}

              {actionError && (
                <p className="mt-2 text-[11px] leading-relaxed text-destructive">{actionError}</p>
              )}

              {result.notes && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
                    {t('更新内容')}
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                    {result.notes}
                  </pre>
                </details>
              )}

              <div className="mt-3 flex items-center gap-4">
                <LinkButton url={result.releaseUrl ?? RELEASES_URL}>
                  {t('在 GitHub 上查看')}
                </LinkButton>
                {result.publishedAt && (
                  <span className="text-[11px] text-muted-foreground/70">
                    {t('发布于 {date}', {
                      date: new Date(result.publishedAt).toLocaleDateString(),
                    })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="pb-4 pt-2 text-[11px] text-muted-foreground/70">
        {t('更新包会下载到本机的下载文件夹，安装前需要退出 PiWork。')}
      </p>

      <AlertDialog open={confirmingInstall} onOpenChange={setConfirmingInstall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('退出并安装？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('安装前会先退出 PiWork，正在运行的任务会中断。装好后重新打开应用即可。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingInstall(false);
                if (downloadedForAsset?.filePath) void installDownloaded(downloadedForAsset.filePath);
              }}
            >
              {t('退出并安装')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
