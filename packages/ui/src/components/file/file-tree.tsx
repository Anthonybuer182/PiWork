import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileText, Folder, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { FileEntry, FileSearchResult } from '@pi/sdk-wrapper';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/stores/toast-store';
import { useI18n } from '@/i18n';
import { FileTreeNode } from './file-tree-node';
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
import { isPreviewableInRightPanel, openWithSystemApp } from '@/lib/utils';

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.vite', 'dist', '.next', '__pycache__', '.DS_Store']);
const DEBOUNCE_MS = 150;

interface DeleteTarget {
  workspaceId: string;
  entry: FileEntry;
}

/** True when `child` is `parent` or lives under it (either separator). */
function isPathWithin(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent + '/') ||
    child.startsWith(parent + '\\')
  );
}

export function FileTree() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);
  const { t } = useI18n();

  // Filename search over the whole workspace; while a query is active it
  // replaces the tree with a flat result list.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const activeSearchIdRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: files, isLoading, error, isFetching } = useQuery({
    queryKey: ['files', activeWorkspaceId, activeWorkspaceId],
    queryFn: () => sdk.file.list(activeWorkspaceId!),
    enabled: !!activeWorkspaceId,
    staleTime: 5_000,
  });

  const {
    data: searchResult,
    isFetching: searchFetching,
    error: searchError,
  } = useQuery<FileSearchResult | null>({
    queryKey: ['file-search', activeWorkspaceId, debounced],
    queryFn: async () => {
      if (!activeWorkspaceId || !debounced) return null;
      // Stop the previous walk before starting a new one — the transport has
      // no cancellation signal, so it is cooperative and keyed by id.
      if (activeSearchIdRef.current) {
        sdk.file.cancelSearch(activeSearchIdRef.current).catch(() => {});
      }
      const searchId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeSearchIdRef.current = searchId;
      return sdk.file.search(activeWorkspaceId, debounced, { searchId });
    },
    enabled: !!activeWorkspaceId && debounced.length > 0,
  });

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (target: DeleteTarget) => sdk.file.delete(target.workspaceId, target.entry.path),
    onSuccess: (_result, target) => {
      // Prefix invalidation covers the root list and every expanded directory.
      queryClient.invalidateQueries({ queryKey: ['files', target.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['file-search', target.workspaceId] });

      const active = useUIStore.getState().activePreviewFilePath;
      if (active && isPathWithin(active, target.entry.path)) {
        useUIStore.getState().setActivePreviewFile(null);
      }

      toast(t('已删除「{name}」', { name: target.entry.name }));
      setDeleteTarget(null);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toast(t('删除失败：{message}', { message }), 'error');
      setDeleteTarget(null);
    },
  });

  const requestDelete = (entry: FileEntry) => {
    if (!activeWorkspaceId) return;
    setDeleteTarget({ workspaceId: activeWorkspaceId, entry });
  };

  const handleFileClick = (path: string) => {
    if (isPreviewableInRightPanel(path)) {
      setActivePreviewFile(path);
    } else {
      openWithSystemApp(path, activeWorkspaceId!);
    }
  };

  if (!activeWorkspaceId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        Select a workspace to view files
      </div>
    );
  }

  const searching = searchFetching && !!debounced;
  const hasQuery = debounced.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
        <Folder className="h-3.5 w-3.5" />
        <span className="flex-1">{t('文件')}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['files', activeWorkspaceId] })}
          disabled={isFetching}
          aria-label={t('刷新文件')}
        >
          <RefreshCw className={isFetching ? 'animate-spin' : ''} style={{ width: 12, height: 12 }} />
        </Button>
      </div>

      <div className="flex items-center gap-2 px-3 py-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          aria-label={t('搜索文件')}
          placeholder={t('搜索文件...')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-hidden placeholder:text-muted-foreground"
        />
        {searching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      {!hasQuery && (
        <>
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('正在加载文件…')}
            </div>
          )}

          {error && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('加载文件失败')}
            </div>
          )}

          {!isLoading && !error && files && files.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('没有找到文件')}
            </div>
          )}
        </>
      )}

      {hasQuery ? (
        <div className="flex-1 overflow-auto min-h-0">
          {searchError && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive/80">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t('搜索失败')}
            </div>
          )}
          {!searching && !searchError && (!searchResult || searchResult.entries.length === 0) && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('未找到匹配')}</p>
          )}
          {searchResult?.entries.map((entry) => (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              onClick={() => handleFileClick(entry.path)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter') handleFileClick(entry.path);
              }}
              className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
              <span className="shrink-0 truncate text-[10px] text-muted-foreground max-w-[45%]">
                {entry.path.split('/').slice(-2, -1)[0]}
              </span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('删除 {name}', { name: entry.name })}
                title={t('删除 {name}', { name: entry.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  requestDelete(entry);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {/* The three non-empty outcomes are reported differently on purpose —
              "capped" and "partly unreadable" are not the same as "no matches". */}
          {!searching && searchResult?.truncated && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              {t('结果已截断（已扫描 {count} 个目录）', { count: searchResult.scanned })}
            </p>
          )}
          {!searching && !!searchResult?.errors?.length && (
            <p className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-500">
              {t('{count} 个目录无法读取', { count: searchResult.errors.length })}
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto min-h-0">
          {files
            ?.filter((f) => (f.type === 'directory' && !HIDDEN_DIRS.has(f.name)) || f.type === 'file')
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                workspaceId={activeWorkspaceId}
                depth={0}
                onFileClick={handleFileClick}
                onRequestDelete={requestDelete}
              />
            ))}
        </div>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          // A running recursive delete must not be dismissed into the background.
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget
                ? deleteTarget.entry.type === 'directory'
                  ? t('删除文件夹「{name}」？', { name: deleteTarget.entry.name })
                  : t('删除文件「{name}」？', { name: deleteTarget.entry.name })
                : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.entry.type === 'directory'
                ? t('文件夹及其中的全部内容都会被删除，且无法恢复。')
                : t('删除后无法恢复。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                // AlertDialogAction closes by default; keep the dialog up until
                // the mutation settles so 「正在删除…」 is actually visible.
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
            >
              {deleteMutation.isPending ? t('正在删除…') : t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
