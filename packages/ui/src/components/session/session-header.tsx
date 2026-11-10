import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { activateSession } from '@/lib/window-actions';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Session } from '@pi/types';

/**
 * Centre-header session title, Codex-style: the active session's title with a
 * rename button, a dropdown that lists sessions for quick switching, and a
 * new-session button. Shares the `['sessions', workspaceId]` query cache with
 * the sidebar list, so both stay in sync through the same invalidations.
 */
export function SessionHeader() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const { t } = useI18n();

  const { data: sessions } = useQuery({
    queryKey: ['sessions', activeWorkspaceId],
    queryFn: () => sdk.session.list(activeWorkspaceId as string),
    enabled: !!activeWorkspaceId,
    refetchInterval: 5000,
  });

  const activeSession: Session | undefined = sessions?.find(
    (s) => s.id === activeSessionId,
  );
  // A just-created session isn't in `list` yet — the agent backend only
  // writes the session file when the first assistant message lands. Show it
  // as an unsaved "新会话" until then; rename stays disabled (nothing on disk).
  const sessionPending = !!activeSessionId && !activeSession;

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      sdk.session.updateTitle(id, title),
    onSuccess: () => {
      // Prefix invalidation also refreshes the sidebar list.
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (!activeWorkspaceId) throw new Error('No workspace selected');
      return sdk.session.create(activeWorkspaceId);
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void activateSession(session.id);
    },
  });

  // ── Inline rename ──
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = () => {
    if (!activeSession) return;
    setDraft(activeSession.title ?? '');
    setEditing(true);
  };

  const commitRename = () => {
    if (!activeSession) return;
    const title = draft.trim();
    setEditing(false);
    if (title && title !== activeSession.title) {
      renameMutation.mutate({ id: activeSession.id, title });
    }
  };

  const cancelRename = () => setEditing(false);

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
            maxLength={120}
            aria-label={t('会话标题')}
            className="h-7 w-64 rounded-md border border-input bg-background px-2 text-sm outline-hidden focus:ring-1 focus:ring-foreground/20"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commitRename}
            aria-label={t('确认重命名')}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelRename}
            aria-label={t('取消重命名')}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="group flex min-w-0 items-center gap-0.5">
          <span
            className={cn(
              'max-w-[320px] truncate px-1 text-sm',
              activeSession ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
            title={activeSession?.title}
          >
            {activeSession?.title ?? (sessionPending ? t('新会话') : t('未选择会话'))}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 text-muted-foreground/70 hover:text-foreground disabled:opacity-0"
                disabled={!activeSession}
                onClick={startRename}
                aria-label={t('重命名会话')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('重命名')}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7 text-muted-foreground/70 hover:text-foreground"
                    aria-label={t('会话列表')}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('会话列表')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="center" className="w-72 max-h-80 overflow-y-auto">
              {(sessions ?? []).map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onClick={() => void activateSession(session.id)}
                  className={cn(
                    'items-center gap-2',
                    session.id === activeSessionId && 'bg-accent/60',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {session.messageCount}
                  </span>
                  {session.id === activeSessionId && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              ))}
              {(sessions ?? []).length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t('暂无会话')}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 text-muted-foreground/70 hover:text-foreground"
                disabled={!activeWorkspaceId || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                aria-label={t('新建会话')}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('新建会话')}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
