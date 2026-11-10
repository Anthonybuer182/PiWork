import { Loader2, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  ASK_TOOL_NAME,
  TODO_TOOL_NAME,
  TODO_STATUSES,
  type TodoItem,
  type TodoPriority,
  type TodoSnapshot,
  type TodoStatus,
  type ToolCallBlock,
  type ToolResultBlock,
} from '@pi/types';
import { DeclarativeRenderer } from '@/components/plugins/declarative/declarative-renderer';
import { usePluginStore } from '@/stores/plugin-store';
import { usePermissionStore } from '@/stores/permission-store';
import { useAskStore } from '@/stores/ask-store';
import { useTodoStore } from '@/stores/todo-store';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/i18n';
import { PermissionRequestCard } from './permission-request-card';
import { AskCard } from './ask-card';
import { TodoCard } from './todo-card';
import './chat-animations.css';

interface ToolCallDisplayProps {
  block: ToolCallBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;
  durationMs?: number;
  /**
   * false folds the plugin card body away. Set on the middle batches of a run
   * that edited the same file again and again: the row keeps the record, one
   * first and one last card carry the summary.
   */
  showPluginCard?: boolean;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * A display-only snapshot built from `todotool`'s arguments, used while the
 * call is still waiting to execute (e.g. behind an approval in the same batch).
 * Same normalization the host applies, minus truncation/warnings — those only
 * matter to the model.
 */
function todosFromArgs(args: Record<string, unknown> | undefined): TodoSnapshot | null {
  const raw = args?.todos;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const todos: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    const status = TODO_STATUSES.includes(item.status as TodoStatus)
      ? (item.status as TodoStatus)
      : 'pending';
    const priority =
      item.priority === 'low' || item.priority === 'medium' || item.priority === 'high'
        ? (item.priority as TodoPriority)
        : undefined;
    todos.push({ content, status, ...(priority ? { priority } : {}) });
  }
  if (todos.length === 0) return null;
  return {
    sessionId: '',
    todos,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: new Date().toISOString(),
  };
}

function getToolPreview(block: ToolCallBlock): string {
  const input = block.args;
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';

  if (block.toolName === ASK_TOOL_NAME) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = questions[0] as { question?: unknown } | undefined;
    if (typeof first?.question === 'string') {
      const more = questions.length > 1 ? ` (+${questions.length - 1})` : '';
      return `${first.question}${more}`.slice(0, 120);
    }
  }
  if (block.toolName === TODO_TOOL_NAME) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const running = todos.filter(
      (todo) => (todo as { status?: unknown })?.status === 'in_progress',
    ).length;
    return running > 0 ? `${todos.length} 项 · ${running} 进行中` : `${todos.length} 项`;
  }

  // Office batches: the file is the subject and the batch size is the useful
  // summary — 「迎国庆.pptx · 6 个操作」beats a truncated absolute path, and it
  // is what identifies the row once the card body is folded away.
  if (typeof input.path === 'string' && Array.isArray(input.ops)) {
    const name = input.path.split(/[\\/]/).pop() || input.path;
    return input.ops.length > 0 ? `${name} · ${input.ops.length} 个操作` : name;
  }

  if ('command' in input) return String(input.command).slice(0, 120);
  if ('path' in input) return String(input.path).slice(0, 120);
  if ('file_path' in input) return String(input.file_path).slice(0, 120);
  if ('pattern' in input) return String(input.pattern).slice(0, 120);
  if ('query' in input) return String(input.query).slice(0, 120);
  if ('url' in input) return String(input.url).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

export function ToolCallDisplay({
  block,
  result,
  isStreaming,
  durationMs,
  showPluginCard = true,
}: ToolCallDisplayProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const isRunning = isStreaming && !result;
  // An approval request for this exact call means the gate in main is holding
  // it before execution — show the inline card instead of a running spinner.
  const pendingRequest = usePermissionStore((s) => s.pendingByToolCall[block.toolCallId]);
  const awaitingApproval = isRunning && !!pendingRequest;
  // A pending asktool request is the other kind of "this call is waiting on a
  // human" — same inline placement, different card.
  const askRequestId = useAskStore((s) => s.byToolCall[block.toolCallId]);
  const askRequest = useAskStore((s) => (askRequestId ? s.requests[askRequestId] : undefined));
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  // The composer's streaming blocks are global, so a run started in session A
  // keeps rendering after the user switches to B. A question is answerable
  // only in the conversation that asked it.
  const awaitingAnswer =
    isRunning && !!askRequest && askRequest.sessionId === (activeSessionId ?? '');
  // The checklist is rendered from the store (not from this call's args) so a
  // later todotool call updates the same card in place.
  // Guard by tool name so every OTHER tool card in the transcript keeps a
  // stable `null` subscription: a snapshot update must not re-render hundreds
  // of unrelated cards.
  const todoSnapshot = useTodoStore((s) =>
    block.toolName === TODO_TOOL_NAME && activeSessionId
      ? (s.bySession[activeSessionId] ?? null)
      : null,
  );
  // The snapshot only exists once the tool has EXECUTED. A batch that also
  // contains a call waiting for approval does not execute anything until the
  // verdict arrives (the SDK prepares the whole batch first), so the checklist
  // would stay invisible exactly when the user is looking at an approval card.
  // Render the arguments instead until then — same list, just early.
  const provisionalTodo = useMemo(
    () => (block.toolName === TODO_TOOL_NAME ? todosFromArgs(block.args) : null),
    [block.toolName, block.args],
  );
  const hasError = result?.isError;
  const rawResult = result?.result;
  const resultText = rawResult == null
    ? ''
    : typeof rawResult === 'string'
      ? rawResult
      : JSON.stringify(rawResult);
  const resultIsEmpty = result ? (resultText.trim() === '' || resultText.trim() === '(empty)') : false;

  const handleToggle = () => {
    if (expanded) {
      setExpanded(false);
      setUserCollapsed(true);
    } else {
      setExpanded(true);
      setUserCollapsed(false);
    }
  };

  const preview = getToolPreview(block);

  // Plugin message-renderer: the tool's plugin contributed a declarative
  // card tree alongside its result — render it instead of the raw output.
  // (Select a stable store slice; derive with useMemo to avoid re-render loops.)
  const plugins = usePluginStore((s) => s.plugins);
  const messageRenderers = useMemo(
    () => plugins.flatMap((p) => p.messageRenderers.map((m) => ({ type: m.type, streaming: m.streaming !== false }))),
    [plugins],
  );
  const rendererByType = useMemo(() => new Map(messageRenderers.map((m) => [m.type, m])), [messageRenderers]);
  // Card interactions route to the plugin that owns the tool, over the same
  // fire-and-forget IPC the panels' context menu uses. Web build: no host to
  // route through — events are dropped (the cards render read-only there).
  const cardEventTarget = useMemo(
    () => new Map(plugins.flatMap((p) => p.tools.map((t) => [t.name, p.id] as const))),
    [plugins],
  );
  const handleCardEvent = useCallback(
    (kind: string, event: { eventId?: string }, payload: unknown) => {
      const eventId = event?.eventId;
      if (!eventId || !result?.toolName) return;
      const pluginId = cardEventTarget.get(result.toolName);
      if (!pluginId) {
        console.warn(`[card] no plugin owns tool "${result.toolName}" — event "${eventId}" dropped`);
        return;
      }
      const api = (
        window as unknown as {
          electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
        }
      ).electronAPI;
      if (!api?.invoke) return;
      api
        .invoke('pi:plugin:card-event', { pluginId, toolName: result.toolName, eventId, kind, payload })
        .then((res) => {
          const r = res as { ok?: boolean; error?: string } | null;
          if (r && r.ok === false) {
            console.warn(`[card] ${result.toolName} event "${eventId}" dropped: ${r.error}`);
          }
        })
        .catch(() => {});
    },
    [cardEventTarget, result?.toolName],
  );
  const hasPluginCard =
    showPluginCard && !!result?.card && !!result.toolName && rendererByType.has(result.toolName);
  // Streaming args card: while the tool runs, render its args live
  // (e.g. the mail draft forms as the agent types it).
  const renderer = block.toolName ? rendererByType.get(block.toolName) : undefined;
  const argsEntries = useMemo(
    () => Object.entries(block.args ?? {}).filter(([, v]) => v != null && typeof v !== 'object'),
    [block.args],
  );
  const hasStreamingCard =
    isRunning && !!renderer?.streaming && argsEntries.length > 0;

  return (
    <div className={cn(
      'my-1 rounded-md border bg-transparent overflow-hidden text-xs',
      !isStreaming && 'animate-streaming-in',
      awaitingApproval
        ? 'border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/10'
        : awaitingAnswer
          ? 'border-foreground/25 bg-muted/20'
          : hasError
            ? 'border-destructive/30'
            : 'border-border',
    )}>
      {/* ── Header row ── */}
      <button
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/30 text-left min-w-0"
        onClick={handleToggle}
      >
        {/* Status icon */}
        {awaitingAnswer ? (
          <MessageCircleQuestion className="h-3 w-3 animate-pulse text-foreground/70 shrink-0" />
        ) : awaitingApproval ? (
          <ShieldAlert className="h-3 w-3 animate-pulse text-amber-600 dark:text-amber-400 shrink-0" />
        ) : isRunning ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
        ) : (
          <span className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            hasError ? 'bg-destructive' : 'bg-muted-foreground/50',
          )} />
        )}

        {/* Tool name */}
        <span className={cn(
          'font-medium font-mono text-[11px] shrink-0',
          hasError ? 'text-red-600 dark:text-red-400' : 'text-foreground',
        )}>
          {block.toolName}
        </span>

        {/* Args preview (always visible, like reference) */}
        {preview && (
          <span className="text-muted-foreground/60 font-mono text-[11px] truncate flex-1 min-w-0">
            {preview}
          </span>
        )}

        {/* Running indicator (only when collapsed) */}
        {awaitingAnswer && !expanded && (
          <span className="text-foreground/70 animate-pulse shrink-0 ml-auto">
            {t('等待回答')}
          </span>
        )}
        {awaitingApproval && !expanded && (
          <span className="text-amber-600/80 dark:text-amber-400/70 animate-pulse shrink-0 ml-auto">
            {t('等待批准')}
          </span>
        )}
        {isRunning && !awaitingApproval && !awaitingAnswer && !expanded && (
          <span className="text-muted-foreground/60 animate-pulse shrink-0 ml-auto">
            {t('运行中…')}
          </span>
        )}

        {/* Duration */}
        {durationMs != null && !isRunning && (
          <span className="ml-auto text-muted-foreground/60 tabular-nums shrink-0">
            {formatDuration(durationMs)}
          </span>
        )}

        {/* Chevron */}
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          className={cn(
            'shrink-0 text-muted-foreground/50 transition-transform duration-150',
            expanded ? 'rotate-180' : '',
          )}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Inline approval card: the gate is holding this call ── */}
      {awaitingApproval && pendingRequest && (
        <div data-permission-inline={pendingRequest.requestId}>
          <PermissionRequestCard request={pendingRequest} />
        </div>
      )}

      {/* ── Inline question card: the agent is waiting for an answer ── */}
      {awaitingAnswer && askRequest && (
        <div data-ask-inline={askRequest.requestId}>
          <AskCard request={askRequest} inline />
        </div>
      )}

      {/* ── Task checklist: live from the store, but only on the call that
           produced the current snapshot. Every call replaces the whole list,
           so rendering it on every historical call would stack near-identical
           cards; this keeps the list in exactly one place. ── */}
      {block.toolName === TODO_TOOL_NAME &&
        (todoSnapshot?.toolCallId === block.toolCallId ? (
          <TodoCard snapshot={todoSnapshot} />
        ) : isRunning && provisionalTodo ? (
          <TodoCard snapshot={provisionalTodo} />
        ) : null)}

      {/* ── Streaming args card (tool running, args arriving live) ── */}
      {hasStreamingCard && (
        <div
          data-plugin-card-streaming={block.toolName}
          className="border-t border-border/40 bg-background/60 px-3 py-2"
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('{tool} · 生成中', { tool: block.toolName })}
          </div>
          <div className="flex flex-col gap-1">
            {argsEntries.map(([key, value]) => (
              <div key={key} className="flex items-start gap-2 text-sm">
                <span className="w-20 shrink-0 text-muted-foreground">{key}</span>
                <span className="min-w-0 flex-1 break-words">{String(value).slice(0, 300)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Plugin message-renderer card (Tier 0 in the chat timeline) ── */}
      {hasPluginCard && result?.card && (
        <div data-plugin-card={result.toolName} className="border-t border-border/40 px-2.5 py-2">
          <DeclarativeRenderer tree={result.card} onEvent={handleCardEvent} />
        </div>
      )}

      {/* ── Expanded: args + result ── */}
      {expanded && (
        <div className="border-t border-border/40">
          {/* Input args */}
          {block.args && Object.keys(block.args).length > 0 && (
            <pre className="px-2.5 py-2 text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-48 overflow-y-auto">
              {JSON.stringify(block.args, null, 2)}
            </pre>
          )}

          {/* Result — only shown when available and expanded (like reference) */}
          {result && (
            <pre className={cn(
              'px-2.5 py-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-64 overflow-y-auto',
              'border-t border-border/30',
              hasError
                ? 'text-red-600 dark:text-red-400'
                : resultIsEmpty
                  ? 'text-muted-foreground/50 italic'
                  : 'text-muted-foreground',
            )}>
              {resultIsEmpty ? '(no output)' : resultText.length > 2000 ? resultText.slice(0, 2000) + '\n... (truncated)' : resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
