import { Hand, Loader2, MessageSquare, MoreHorizontal, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useComposerStore } from '@/stores/composer-store';
import { useAskStore } from '@/stores/ask-store';
import { usePermissionStore } from '@/stores/permission-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Session } from '@pi/types';
import { useI18n } from '@/i18n';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete?: () => void;
  /** Desktop only: open this conversation in its own window. */
  onOpenInNewWindow?: () => void;
}

export function SessionItem({
  session,
  isActive,
  onClick,
  onDelete,
  onOpenInNewWindow,
}: SessionItemProps) {
  const { t } = useI18n();
  // Background runs are visible in the list even while another conversation
  // is on screen: a spinner replaces the message count for that session.
  const running = useComposerStore((s) => Boolean(s.streams[session.id]?.isStreaming));
  // A run blocked on an approval or a question is not "busy" — it is waiting
  // for the user. That needs a different mark, or the spinner hides the one
  // thing the user has to act on.
  const waitingApproval = usePermissionStore((s) =>
    Object.values(s.pendingByToolCall).some((request) => request.sessionId === session.id),
  );
  const waitingAsk = useAskStore((s) =>
    Object.values(s.requests).some((request) => request.sessionId === session.id),
  );
  const waiting = waitingApproval || waitingAsk;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      aria-current={isActive ? 'page' : undefined}
      aria-label={t('切换到会话：{title}', { title: session.title })}
      className={cn(
        'group flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer transition-colors',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50 text-foreground',
      )}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{session.title}</span>
      {waiting ? (
        <span className="shrink-0" title={t('等待你的操作')}>
          <Hand className="h-3.5 w-3.5 animate-pulse text-amber-500" aria-label={t('等待你的操作')} />
        </span>
      ) : running ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-500"
          aria-label={t('正在运行')}
        />
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {session.messageCount}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
            aria-label={t('更多选项')}
          >
            <MoreHorizontal className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {onOpenInNewWindow && (
            <DropdownMenuItem onClick={() => onOpenInNewWindow()}>
              <SquareArrowOutUpRight className="mr-2 h-4 w-4" />
              {t('在新窗口打开')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => onDelete?.()}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('删除')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
