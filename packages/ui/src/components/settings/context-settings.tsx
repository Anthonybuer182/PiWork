'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { AgentContextConfig, GlobalContextFile } from '@pi/types';
import { useSDK } from '@/hooks/use-sdk';
import { useI18n } from '@/i18n';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/common/loading-spinner';
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

/**
 * 上下文 — the global prompt/context files, and what the current workspace
 * actually contributes.
 *
 * This used to be a left-sidebar panel. It is a settings page now because
 * everything it edits is global configuration, not a view of what is open: the
 * file tree already covers workspace-scoped `.pi/SYSTEM.md` and `AGENTS.md`,
 * and having two editors for the same files only made the file tree look like
 * it might not be authoritative.
 *
 * What is left here cannot be reached from the file tree at all: the agent dir
 * is outside every workspace, and the AGENTS.md files from ancestor directories
 * are invisible to it. The page also reports which copy is in effect — a
 * project `.pi/SYSTEM.md` silently shadows the global one.
 */
export function ContextSettingsPage() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activeSessionId = useUIStore((s) => s.activeSessionId);

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });
  const workspacePath = workspaces?.find((w) => w.id === activeWorkspaceId)?.path ?? null;

  const globalQuery = useQuery({
    queryKey: ['global-context'],
    queryFn: () => sdk.chat.getGlobalContextInfo(),
    staleTime: 0,
  });

  const contextQuery = useQuery({
    queryKey: ['agent-context', workspacePath, activeSessionId],
    queryFn: () =>
      sdk.chat.getAgentContextConfig(
        workspacePath as string,
        undefined,
        activeSessionId ?? undefined,
      ),
    enabled: !!workspacePath,
    staleTime: 0,
  });

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['global-context'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-context'] }),
    ]);
  };

  const writeFile = useMutation({
    mutationFn: async (vars: { path: string; content: string; expectedMtime?: number }) =>
      sdk.chat.writeContextFile({ workspacePath: workspacePath ?? undefined, ...vars }),
  });

  const deleteFile = useMutation({
    mutationFn: async (vars: { path: string; expectedMtime?: number }) =>
      sdk.chat.deleteContextFile({ workspacePath: workspacePath ?? undefined, ...vars }),
  });

  const describe = (err: unknown, action: '保存' | '删除'): string => {
    const raw = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(raw)) {
      return t(
        '{action}被拒绝：这个文件在你打开之后被外部改过，宿主拒绝写入以免覆盖别人刚做的修改。请先取消、重新打开拿到最新内容。\n（宿主的说明：{error}）',
        { action: t(action), error: raw },
      );
    }
    return raw;
  };

  const reloadNote = (result: {
    applied: boolean;
    reason?: string;
    message?: string;
  }): string => {
    if (result.applied) return t('已保存并生效，下一条消息就会带上新内容。');
    if (result.reason === 'busy') return t('已保存；正在生成回复，将在下一个新会话生效。');
    if (result.reason === 'no-session') return t('已保存；尚未建立会话，将在新会话建立时生效。');
    if (result.reason === 'error') {
      return t('文件已保存，但让改动生效时出错了 —— 改动会在新会话建立时生效。\n（{error}）', {
        error: result.message ?? t('未知错误'),
      });
    }
    return t('已保存，将在下一次建立会话时生效。');
  };

  const openEditor = (file: GlobalContextFile, content?: string) => {
    setEditorError(null);
    setNotice(null);
    setEditor({
      path: file.path,
      content: content ?? file.content ?? '',
      mtimeMs: file.mtimeMs,
      isNew: !file.exists,
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    setEditorError(null);
    setNotice(null);
    try {
      const res = await writeFile.mutateAsync({
        path: editor.path,
        content: editor.content,
        expectedMtime: editor.isNew ? undefined : editor.mtimeMs,
      });
      setEditor(null);
      await refresh();
      setNotice({ kind: 'ok', text: reloadNote(res.reload) });
    } catch (err) {
      setEditorError(describe(err, '保存'));
    }
  };

  const removeFile = (file: GlobalContextFile) => {
    setConfirm({
      title: t('删除这个文件？'),
      description: t(
        '{path}\n\n删掉之后，它注入的内容会立即从系统提示词里消失，恢复成没有这个文件时的样子。',
        { path: file.path },
      ),
      confirmLabel: t('删除'),
      run: () => {
        void (async () => {
          setNotice(null);
          try {
            const res = await deleteFile.mutateAsync({
              path: file.path,
              expectedMtime: file.mtimeMs,
            });
            if (editor?.path === file.path) setEditor(null);
            await refresh();
            setNotice({
              kind: 'ok',
              text: res.deleted.deleted
                ? t('已删除。{note}', { note: reloadNote(res.reload) })
                : t('文件已不存在。'),
            });
          } catch (err) {
            setNotice({ kind: 'err', text: describe(err, '删除') });
          }
        })();
      },
    });
  };

  if (globalQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (globalQuery.error || !globalQuery.data) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain px-6 py-5">
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {globalQuery.error instanceof Error
              ? globalQuery.error.message
              : t('读取全局上下文失败')}
          </span>
        </div>
      </div>
    );
  }

  const info = globalQuery.data;
  const config = contextQuery.data;
  const byKind = (kind: GlobalContextFile['kind']) =>
    info.files.find((f) => f.kind === kind);

  const projectSystem = config?.promptFiles.find(
    (f) => f.kind === 'system' && f.scope === 'project' && f.exists,
  );
  const projectAppend = config?.promptFiles.find(
    (f) => f.kind === 'append' && f.scope === 'project' && f.exists,
  );

  const systemFile = byKind('system');
  const appendFile = byKind('append');
  const agentsFile = byKind('agents');

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-5">
      {notice && (
        <div
          className={cn(
            'mb-4 rounded-md border px-3 py-2 text-xs whitespace-pre-wrap',
            notice.kind === 'ok'
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'border-destructive/40 text-destructive',
          )}
        >
          {notice.text}
        </div>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">{t('全局上下文')}</h3>
          <span className="truncate font-mono text-[10px] text-muted-foreground" title={info.agentDir}>
            {info.agentDir}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(
            '这些文件对所有工作区生效。工作区里的 .pi/SYSTEM.md 和 .pi/APPEND_SYSTEM.md 会遮住这里的同名文件；AGENTS.md 不会遮住，而是叠加。',
          )}
        </p>

        <div className="mt-4 space-y-3">
          {systemFile && (
            <FileCard
              title="SYSTEM.md"
              subtitle={t('替换系统提示词')}
              description={t(
                '写入后会完全替换 SDK 内置的系统提示词。除非你自己把工具用法和行为说明写进去，否则 agent 会失去这些能力。',
              )}
              file={systemFile}
              inactive={!!projectSystem}
              overriddenNote={
                projectSystem
                  ? t('当前工作区有自己的 .pi/SYSTEM.md，这里的全局文件不会生效。')
                  : undefined
              }
              editor={editor}
              editorError={editorError}
              saving={writeFile.isPending}
              seedOnly
              canSeed={!!config?.sections.base.text}
              seedHint={
                workspacePath
                  ? t('需要一次对话后才能读取完整提示词')
                  : t('先选择一个工作区')
              }
              onSeed={
                config?.sections.base.text
                  ? () =>
                      openEditor(
                        systemFile,
                        `${config.sections.base.text}\n`,
                      )
                  : undefined
              }
              onEdit={() => openEditor(systemFile)}
              onDelete={() => removeFile(systemFile)}
              onCancel={() => {
                setEditor(null);
                setEditorError(null);
              }}
              onSave={() => void saveEditor()}
              onContentChange={(content) =>
                setEditor((e) => (e ? { ...e, content } : e))
              }
            />
          )}

          {appendFile && (
            <FileCard
              title="APPEND_SYSTEM.md"
              subtitle={t('追加到系统提示词')}
              description={t('在内置提示词之后追加你自己的指令，原有的内容都保留。')}
              file={appendFile}
              inactive={!!projectAppend}
              overriddenNote={
                projectAppend
                  ? t('当前工作区有自己的 .pi/APPEND_SYSTEM.md，这里的全局文件不会生效。')
                  : undefined
              }
              editor={editor}
              editorError={editorError}
              saving={writeFile.isPending}
              onEdit={() => openEditor(appendFile)}
              onDelete={() => removeFile(appendFile)}
              onCancel={() => {
                setEditor(null);
                setEditorError(null);
              }}
              onSave={() => void saveEditor()}
              onContentChange={(content) =>
                setEditor((e) => (e ? { ...e, content } : e))
              }
            />
          )}

          {agentsFile && (
            <FileCard
              title={agentsFile.path.split(/[\\/]/).pop() ?? 'AGENTS.md'}
              subtitle={t('全局上下文')}
              description={t(
                '会叠加到每个工作区的上下文里，和工作区及上级目录的 AGENTS.md 一起注入。',
              )}
              file={agentsFile}
              shadowedNote={
                agentsFile.shadowed.length > 0
                  ? t(
                      '同目录下还有 {paths}。SDK 按 AGENTS.md → CLAUDE.md 的顺序只读取第一个，这些文件不会被读取。',
                      {
                        paths: agentsFile.shadowed
                          .map((p) => p.split(/[\\/]/).pop() ?? p)
                          .join('、'),
                      },
                    )
                  : undefined
              }
              createLabel={t('创建全局 AGENTS.md')}
              createHint={t('创建后写入全局，对所有工作区生效。')}
              editor={editor}
              editorError={editorError}
              saving={writeFile.isPending}
              onEdit={() => openEditor(agentsFile)}
              onDelete={() => removeFile(agentsFile)}
              onCancel={() => {
                setEditor(null);
                setEditorError(null);
              }}
              onSave={() => void saveEditor()}
              onContentChange={(content) =>
                setEditor((e) => (e ? { ...e, content } : e))
              }
            />
          )}
        </div>
      </section>

      {workspacePath && (
        <WorkspaceAgents
          config={config}
          loading={contextQuery.isLoading}
          error={contextQuery.error}
        />
      )}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              {confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── cards ──

interface EditorState {
  path: string;
  content: string;
  mtimeMs: number;
  isNew: boolean;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => void;
}

function FileCard({
  title,
  subtitle,
  description,
  file,
  inactive,
  overriddenNote,
  shadowedNote,
  createLabel,
  createHint,
  seedOnly,
  canSeed,
  seedHint,
  onSeed,
  editor,
  editorError,
  saving,
  onEdit,
  onDelete,
  onCancel,
  onSave,
  onContentChange,
}: {
  title: string;
  subtitle: string;
  description: string;
  file: GlobalContextFile;
  /** The file exists but a workspace copy shadows it. */
  inactive?: boolean;
  overriddenNote?: string;
  shadowedNote?: string;
  createLabel?: string;
  createHint?: string;
  /** SYSTEM.md may only be created from the live prompt — an empty one would
   *  silently take away every built-in instruction. */
  seedOnly?: boolean;
  canSeed?: boolean;
  seedHint?: string;
  onSeed?: () => void;
  editor: EditorState | null;
  editorError: string | null;
  saving: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onSave: () => void;
  onContentChange: (content: string) => void;
}) {
  const { t } = useI18n();
  const editing = editor?.path === file.path;

  return (
    <div className="rounded-md border px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        <Badge
          variant={file.exists && !inactive ? 'secondary' : 'outline'}
          className="ml-auto text-[10px] font-normal"
        >
          {!file.exists ? t('未创建') : inactive ? t('被遮住') : t('生效中')}
        </Badge>
      </div>

      <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
        {file.path}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>

      {file.exists && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t('{n} 字符', { n: file.chars.toLocaleString() })}
        </div>
      )}

      {overriddenNote && (
        <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
          {overriddenNote}
        </div>
      )}
      {shadowedNote && (
        <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
          {shadowedNote}
        </div>
      )}

      {editing ? (
        <div className="mt-2 space-y-1.5">
          <Textarea
            value={editor.content}
            spellCheck={false}
            onChange={(e) => onContentChange(e.target.value)}
            className="min-h-[180px] font-mono text-[11px] leading-relaxed"
          />
          {editorError && (
            <div className="whitespace-pre-wrap rounded-md border border-destructive/40 px-2 py-1.5 text-[11px] text-destructive">
              {editorError}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" className="h-7 text-[11px]" disabled={saving} onClick={onSave}>
              {saving ? t('保存中…') : editor.isNew ? t('创建并生效') : t('保存')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={onCancel}
            >
              {t('取消')}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {editor.isNew
                ? t('保存之前不会写入任何文件，取消就等于什么都没做。')
                : t('保存后立即生效；正在生成回复时则于下一个新会话生效。')}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {file.exists ? (
            <>
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onEdit}>
                {t('编辑')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px] text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                {t('删除')}
              </Button>
            </>
          ) : (
            <>
              {seedOnly ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={onSeed}
                  disabled={!canSeed}
                  title={!canSeed ? seedHint : undefined}
                >
                  {t('以当前提示词为起点创建')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={onEdit}
                >
                  {createLabel ?? t('创建')}
                </Button>
              )}
              {createHint && (
                <span className="text-[11px] text-muted-foreground">{createHint}</span>
              )}
              {seedOnly && !canSeed && (
                <span className="text-[11px] text-muted-foreground">
                  {seedHint ?? t('需要一次对话后才能读取完整提示词')}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceAgents({
  config,
  loading,
  error,
}: {
  config?: AgentContextConfig;
  loading: boolean;
  error: unknown;
}) {
  const { t } = useI18n();
  if (error) {
    return (
      <section className="mt-6 border-t pt-5">
        <h3 className="text-sm font-medium">{t('当前工作区注入的 AGENTS.md')}</h3>
        <p className="mt-2 text-xs text-destructive">
          {error instanceof Error ? error.message : t('未知错误')}
        </p>
      </section>
    );
  }
  if (!config) {
    return (
      <section className="mt-6 border-t pt-5">
        <h3 className="text-sm font-medium">{t('当前工作区注入的 AGENTS.md')}</h3>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('读取中…')}
        </div>
      </section>
    );
  }

  const files = config.sections.contextFiles;
  const scopeText = (scope: (typeof files)[number]['scope']) =>
    scope === 'global'
      ? t('全局')
      : scope === 'ancestor'
        ? t('上级目录')
        : t('工作区');

  return (
    <section className="mt-6 border-t pt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-medium">{t('当前工作区注入的 AGENTS.md')}</h3>
        <span className="text-xs text-muted-foreground">
          {t('{n} 个', { n: files.length })}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t('这些文件会全部叠加进上下文，按全局 → 上级目录 → 工作区的顺序排列。')}
      </p>

      {files.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('没有找到 AGENTS.md / CLAUDE.md。放进这些文件的内容会成为 agent 的常驻指令。')}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border px-2.5 py-1.5"
            >
              <Badge variant="outline" className="text-[10px] font-normal">
                {scopeText(file.scope)}
              </Badge>
              <span className="min-w-0 flex-1 break-all font-mono text-[10px] text-muted-foreground">
                {file.path}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t('{n} 字符', { n: file.chars.toLocaleString() })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
