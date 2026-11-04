import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderOpen, HardDrive, RotateCw } from 'lucide-react';
import type { StorageEntry, StorageEntryId } from '@pi/types';
import { useI18n, type MessageKey } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { openWithSystemApp, cn } from '@/lib/utils';
import { hasStorageApi, storageApi } from '@/lib/storage-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { LoadingSpinner } from '@/components/common/loading-spinner';

/** Row copy. The ids are main's; the words are this page's. */
const ENTRY_LABELS: Record<StorageEntryId, { label: MessageKey; hint: MessageKey }> = {
  sessions: {
    label: '会话记录',
    hint: '所有对话的完整记录，包括分支和回退过的内容。',
  },
  plugins: {
    label: '插件',
    hint: '已安装插件的代码和它们自己的依赖。',
  },
  skills: {
    label: '技能与扩展',
    hint: '全局技能、扩展和自定义 agent。',
  },
  runtime: {
    label: '运行时依赖',
    hint: '插件用的 npm 包，以及 fd、rg 等内置命令行工具。',
  },
  other: {
    label: '其他数据',
    hint: '全局配置、提示词、模型列表和模型凭据等小文件。',
  },
  'app-data': {
    label: '应用数据',
    hint: '窗口布局、语音模型、权限审计和 Chromium 缓存。',
  },
};

/**
 * 存储 — where the app keeps its data, and how much of it there is.
 *
 * The agent directory is the one that grows: every conversation, plugin and
 * skill lives under it, and on a small laptop drive that is the folder people
 * actually want to move. Changing it writes a small file in userData and takes
 * effect on the next launch — live sessions and plugin backends already hold
 * files open under the old root, so this cannot be hot-swapped.
 *
 * Sizes are measured in main (the renderer cannot read those paths) and are
 * shown per area rather than as one number: "sessions are 40 GB" is actionable,
 * "the app uses 41 GB" is not.
 */
export function StorageSettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [migrate, setMigrate] = useState(true);
  const [busy, setBusy] = useState<'choose' | 'copying' | 'reset' | 'restart' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['storage-info'],
    queryFn: () => storageApi.info(),
    staleTime: 0,
    enabled: hasStorageApi(),
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <p className="text-xs text-muted-foreground">
          {t('读取存储信息失败')}
          <br />
          <span className="font-mono text-[10px]">
            {error instanceof Error ? error.message : t('未知错误')}
          </span>
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => void refetch()}
        >
          {t('重试')}
        </Button>
      </div>
    );
  }

  const change = async () => {
    setNotice(null);
    setBusy('choose');
    try {
      const dir = await storageApi.chooseDirectory(t('选择数据存放位置'), t('选择'));
      if (!dir) return;
      setBusy('copying');
      const result = await storageApi.setLocation(dir, migrate);
      await queryClient.invalidateQueries({ queryKey: ['storage-info'] });
      setNotice({
        kind: 'ok',
        text: result.usedExisting
          ? t('已改为 {path}。这个文件夹里已经有数据，会直接使用其中的内容；重启后生效。', {
              path: result.info.pendingAgentDir ?? dir,
            })
          : result.copiedFiles > 0
            ? t('已把 {n} 个文件复制到 {path}；重启后生效。', {
                n: result.copiedFiles,
                path: result.info.pendingAgentDir ?? dir,
              })
            : t('已改为 {path}，新位置是空的；重启后生效。', {
                path: result.info.pendingAgentDir ?? dir,
              }),
      });
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setNotice(null);
    setBusy('reset');
    try {
      const result = await storageApi.resetLocation();
      await queryClient.invalidateQueries({ queryKey: ['storage-info'] });
      setNotice({
        kind: 'ok',
        text: !result.info.restartRequired
          ? t('已恢复默认位置，当前就在使用默认位置。')
          : result.usedExisting
            ? t('已恢复到默认位置 {path}。默认位置已有数据，没有覆盖；重启后生效。', {
                path: result.info.pendingAgentDir ?? result.info.defaultAgentDir,
              })
            : t('已恢复到默认位置 {path}；重启后生效。', {
                path: result.info.pendingAgentDir ?? result.info.defaultAgentDir,
              }),
      });
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy('restart');
    try {
      await storageApi.restart();
    } catch (err) {
      setBusy(null);
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-2">
      {notice && (
        <div
          className={cn(
            'mb-4 mt-2 whitespace-pre-wrap rounded-md border px-3 py-2 text-xs',
            notice.kind === 'ok'
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'border-destructive/40 text-destructive',
          )}
        >
          {notice.text}
        </div>
      )}

      <section className="pt-2">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">{t('数据位置')}</h3>
          <Badge
            variant={data.custom ? 'secondary' : 'outline'}
            className="text-[10px] font-normal"
          >
            {data.custom ? t('自定义') : t('默认')}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t('会话记录、配置、插件和技能都放在这个文件夹里。换到更大的磁盘时，数据会跟着走。')}
        </p>

        <div className="mt-2 rounded-md border px-3 py-2.5">
          <div className="flex items-start gap-2">
            <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div
              className="min-w-0 break-all font-mono text-[11px] text-muted-foreground"
              title={data.agentDir}
            >
              {data.agentDir}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={busy !== null}
              onClick={() => void change()}
            >
              {busy === 'choose'
                ? t('选择中…')
                : busy === 'copying'
                  ? t('复制中…')
                  : t('更改位置…')}
            </Button>
            {data.custom && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() => void reset()}
              >
                {busy === 'reset' ? t('恢复中…') : t('恢复默认')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => openWithSystemApp(data.agentDir)}
            >
              <FolderOpen className="mr-1 h-3.5 w-3.5" />
              {t('打开文件夹')}
            </Button>
          </div>

          <div className="mt-2 flex items-start justify-between gap-3 border-t pt-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium">{t('换位置时复制现有数据')}</div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {t(
                  '打开时会把当前文件夹里的内容复制到新位置；关掉则从空文件夹开始。目标文件夹里已经有数据时不会被覆盖，而是直接使用。',
                )}
              </p>
            </div>
            <Switch
              checked={migrate}
              onCheckedChange={setMigrate}
              aria-label={t('换位置时复制现有数据')}
            />
          </div>
        </div>

        {data.restartRequired && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
            <span className="min-w-0 break-all">
              {data.pendingAgentDir
                ? t('新位置 {path} 会在重启后生效，现在仍在使用上面的位置。', {
                    path: data.pendingAgentDir,
                  })
                : t('改动会在重启后生效。')}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 shrink-0 text-[11px]"
              disabled={busy !== null}
              onClick={() => void restart()}
            >
              <RotateCw className={cn('mr-1 h-3.5 w-3.5', busy === 'restart' && 'animate-spin')} />
              {t('立即重启')}
            </Button>
          </div>
        )}
      </section>

      <section className="pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">{t('占用空间')}</h3>
          <span className="text-[11px] text-muted-foreground">
            {t('共 {size}', { size: formatBytes(data.totalBytes) })}
          </span>
        </div>

        <div className="mt-2 divide-y rounded-md border">
          {data.entries.map((entry) => (
            <StorageRow key={entry.id} entry={entry} />
          ))}
        </div>

        <p className="pb-4 pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
          {t('点一行在文件管理器中打开。大小包含文件夹里的全部内容，符号链接不计入。')}
        </p>
      </section>
    </div>
  );
}

function StorageRow({ entry }: { entry: StorageEntry }) {
  const { t } = useI18n();
  const copy = ENTRY_LABELS[entry.id];
  const path = entry.path;

  return (
    <button
      type="button"
      onClick={() => openWithSystemApp(path)}
      title={path}
      className="flex w-full items-start justify-between gap-4 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="min-w-0">
        <div className="text-xs font-medium">{t(copy.label)}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t(copy.hint)}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs tabular-nums">{formatBytes(entry.bytes)}</div>
        <div className="text-[10px] text-muted-foreground">
          {t('{n} 个文件', { n: entry.files.toLocaleString() })}
        </div>
      </div>
    </button>
  );
}
