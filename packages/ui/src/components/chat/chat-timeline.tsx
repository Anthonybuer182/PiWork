import { useRef, useMemo, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, AlertTriangle, RefreshCw, MessageSquare } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { useBuiltinModelsQuery, useVoiceSettingsQuery, hasVoiceApi } from '@/lib/voice/voice-client';
import { stopSpeaking, useVoicePlaybackStore } from '@/stores/voice-playback-store';
import { useComposerStore } from '@/stores/composer-store';
import { Button } from '@/components/ui/button';
import { stripAppendedContext } from '@/lib/quote-helpers';
import { MessageBubble } from './message-bubble';
import { EmptyChat } from './empty-chat';
import { StreamingIndicator } from './streaming-indicator';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { ErrorState } from '@/components/common/error-state';
import type { Message, ContentBlock, TokenUsage, ToolCallBlock } from '@pi/types';
import type { AssistantMessage } from '@pi/types';
import { usePermissionStore } from '@/stores/permission-store';
import { useAskStore } from '@/stores/ask-store';
import { useI18n, type MessageKey } from '@/i18n';
import { PermissionRequestCard } from './permission-request-card';
import { AskCard } from './ask-card';

/** Shared empty map so non-active messages keep a stable prop identity. */
const EMPTY_TOOL_TIMINGS = new Map<string, number>();

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

interface DateSeparator {
  type: 'date_separator';
  id: string;
  label: string;
}

type ChatItem = DateSeparator | Message;

function isDateSeparator(item: ChatItem): item is DateSeparator {
  return 'type' in item && item.type === 'date_separator';
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/** Format a date into Today / Yesterday / locale string */
function formatDateLabel(
  dateStr: string,
  t: (key: MessageKey) => string,
  language: 'zh' | 'en',
): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);

  if (diffDays === 0) return t('今天');
  if (diffDays === 1) return t('昨天');
  return d.toLocaleDateString(language === 'en' ? 'en' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Insert date separators between messages that fall on different days.
 */
function addDateSeparators(
  messages: Message[],
  t: (key: MessageKey) => string,
  language: 'zh' | 'en',
): ChatItem[] {
  const result: ChatItem[] = [];
  let lastDate = '';

  for (const msg of messages) {
    const msgDate = msg.createdAt.split('T')[0];
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      result.push({
        type: 'date_separator',
        id: `date_${msgDate}`,
        label: formatDateLabel(msg.createdAt, t, language),
      });
    }
    result.push(msg);
  }

  return result;
}

/**
 * Create a synthetic streaming message from live blocks and usage info.
 * Uses a stable timestamp captured at stream start.
 */
function makeStreamingMessage(
  blocks: ContentBlock[],
  usage: TokenUsage | undefined,
  createdAt: string,
): Message {
  return {
    id: '__streaming__',
    sessionId: '',
    role: 'assistant',
    status: 'streaming',
    content: blocks.filter((b) => b.type === 'text').map((b) => b.content).join(''),
    // Exclude file blocks during streaming; they appear after completion.
    blocks: blocks.filter((b) => b.type !== 'file'),
    usage,
    createdAt,
    updatedAt: new Date().toISOString(),
  } as AssistantMessage;
}

/**
 * The fallback host for approval requests.
 *
 * The inline approval card lives inside the waiting tool call's block — but
 * that block only exists in the timeline while its streaming chunks do. After
 * a renderer reload or a session switch the blocks are gone, while main's gate
 * is still holding the call: without a second mount point the agent would stay
 * blocked forever with nothing on screen to answer. Anything in the pending
 * map that no visible tool-call block claims renders here, above the composer.
 */
function PendingApprovalFallback({ hostedToolCallIds }: { hostedToolCallIds: Set<string> }) {
  const pendingByToolCall = usePermissionStore((s) => s.pendingByToolCall);
  const orphaned = Object.values(pendingByToolCall).filter(
    (req) => !hostedToolCallIds.has(req.toolCallId),
  );
  if (orphaned.length === 0) return null;
  return (
    <div className="mx-4 mb-2 flex flex-col gap-2">
      {orphaned.map((req) => (
        <div
          key={req.requestId}
          data-permission-fallback={req.requestId}
          className="overflow-hidden rounded-md border border-amber-400/50 shadow-sm"
        >
          <PermissionRequestCard request={req} />
        </div>
      ))}
    </div>
  );
}

/**
 * The fallback host for `asktool` questions.
 *
 * Same reason as the approval fallback: after a reload or a session switch the
 * streaming tool-call block that owns the card is gone, but main is still
 * holding the agent turn open. Only requests belonging to the visible
 * conversation are mounted here — a question from another session must not
 * take over this one.
 */
function PendingAskFallback({ hostedToolCallIds }: { hostedToolCallIds: Set<string> }) {
  const requests = useAskStore((s) => s.requests);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const orphaned = Object.values(requests).filter(
    (req) =>
      (!activeSessionId || req.sessionId === activeSessionId) &&
      !hostedToolCallIds.has(req.toolCallId),
  );
  if (orphaned.length === 0) return null;
  return (
    <div className="mx-4 mb-2 flex flex-col gap-2">
      {orphaned.map((req) => (
        <div
          key={req.requestId}
          data-ask-fallback={req.requestId}
          className="overflow-hidden rounded-md border border-sky-400/50 shadow-sm"
        >
          <AskCard request={req} />
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

/**
 * The stream-error banner.
 *
 * Rendered by BOTH branches below, and that is the whole point. It used to sit
 * only in the populated branch, so a send that failed into an empty session
 * showed nothing at all: the failure emptied the timeline, the empty branch
 * returned early, and the banner went with it. "The model account is out of
 * credit" then looked exactly like "the send button does nothing".
 */
function StreamErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 mx-4 mt-3 px-4 py-3 rounded-lg border border-destructive/30 bg-destructive/10 text-sm">
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
      <span className="text-destructive flex-1">{error}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 text-xs border-destructive/30 hover:bg-destructive/10"
        onClick={onRetry}
      >
        <RefreshCw className="h-3 w-3" />
        Retry
      </Button>
    </div>
  );
}

export function ChatTimeline() {
  const { t, language } = useI18n();
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const isStreaming = useComposerStore((s) => s.isStreaming);
  const streamingBlocks = useComposerStore((s) => s.streamingBlocks);
  const streamingUsage = useComposerStore((s) => s.streamingUsage);
  const contextUsage = useComposerStore((s) => s.contextUsage);
  const messageTiming = useComposerStore((s) => s.messageTiming);
  const toolTimings = useComposerStore((s) => s.toolTimings);
  const streamError = useComposerStore((s) => s.streamError);
  const scrollToBottomTrigger = useComposerStore((s) => s.scrollToBottomTrigger);
  const setTriggerSend = useComposerStore((s) => s.setTriggerSend);
  const setEditingMessage = useComposerStore((s) => s.setEditingMessage);
  const clearEditingMessage = useComposerStore((s) => s.clearEditingMessage);
  const { data: voiceSettings } = useVoiceSettingsQuery();
  const { data: builtinModels = [] } = useBuiltinModelsQuery();

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Stable timestamp captured once when streaming begins
  const streamingStartRef = useRef<string>('');
  // Track last scrollToBottomTrigger to avoid duplicate scrolls when
  // chatItems.length also changes (the effect watches both values).
  const lastScrollTriggerRef = useRef(0);
  // Auto-read (设置 → 语音): speak a reply once its stream has finished and the
  // final message is in the transcript. `preStreamIds` distinguishes the new
  // reply from the previous one if the cache update lands a beat late.
  const prevVoiceStreamingRef = useRef(isStreaming);
  const preStreamIdsRef = useRef<Set<string>>(new Set());
  const autoReadPendingRef = useRef(false);
  const lastAutoReadRef = useRef<string | null>(null);
  const streamSessionRef = useRef<string | null>(null);

  const { data: session, isLoading, error, refetch } = useQuery({
    queryKey: ['session', activeSessionId],
    queryFn: () => sdk.session.get(activeSessionId!),
    enabled: !!activeSessionId,
    staleTime: 30_000,
    // Hold the current conversation on screen while the next one loads.
    // Without this the whole chat area is swapped for a "Loading messages..."
    // spinner on every first visit to a session — a hard flash. Sessions
    // visited within `staleTime` come from cache, which is why switching back
    // never flashed. The local read is ~70ms, so the swap is imperceptible;
    // showing stale content briefly beats blanking the panel.
    placeholderData: keepPreviousData,
  });

  const storedMessages = session?.messages ?? [];

  // Stable timestamp: capture once at the start of streaming
  if (isStreaming && !streamingStartRef.current) {
    streamingStartRef.current = new Date().toISOString();
  }
  if (!isStreaming) {
    streamingStartRef.current = '';
  }

  // During streaming with live blocks, append them as a synthetic message.
  const messages = useMemo(() => {
    if (isStreaming && streamingBlocks.length > 0) {
      const createdAt = streamingStartRef.current || new Date().toISOString();
      return [...storedMessages, makeStreamingMessage(streamingBlocks, streamingUsage ?? undefined, createdAt)];
    }
    return storedMessages;
  }, [storedMessages, isStreaming, streamingBlocks]);

  // Tool-call blocks that currently host an inline approval card. ONLY the
  // live streaming blocks qualify: the inline card renders inside a running
  // ToolCallDisplay (isStreaming && !result), and after a reload or session
  // switch that exists nowhere — the same block persisted in the session tree
  // renders without a running state, so counting it would make the fallback
  // abstain and the approval would be lost between the two mount points.
  const hostedToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of streamingBlocks) {
      if (b.type === 'tool_call') ids.add((b as ToolCallBlock).toolCallId);
    }
    return ids;
  }, [streamingBlocks]);

  // When streaming starts, the optimistic user message and StreamingIndicator
  // Footer (~40px) are added to Virtuoso's scrollHeight AFTER followOutput's
  // 300 ms smooth scroll has already started, causing the animation to land
  // ~40 px above the true bottom.  Wait for the smooth scroll animation to
  // finish, then force-scroll to the absolute bottom to compensate.
  const prevIsStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (isStreaming && !prevIsStreamingRef.current && virtuosoRef.current && messages.length > 0) {
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollTo({
          top: Number.MAX_SAFE_INTEGER,
          behavior: 'auto',
        });
      }, 350);
      return () => clearTimeout(timer);
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming, messages.length]);

  useEffect(() => {
    if (isStreaming && !prevVoiceStreamingRef.current) {
      preStreamIdsRef.current = new Set(storedMessages.map((message) => message.id));
      streamSessionRef.current = activeSessionId;
      autoReadPendingRef.current = false;
    } else if (!isStreaming && prevVoiceStreamingRef.current && !streamError) {
      // Only read if the reply finished in the conversation still on screen.
      autoReadPendingRef.current = streamSessionRef.current === activeSessionId;
    }
    prevVoiceStreamingRef.current = isStreaming;
  }, [isStreaming, streamError, storedMessages, activeSessionId]);

  useEffect(() => {
    lastAutoReadRef.current = null;
    autoReadPendingRef.current = false;
    preStreamIdsRef.current = new Set();
    // Leaving a conversation must stop audio it owns; otherwise speech keeps
    // playing with no visible stop control.
    return () => stopSpeaking();
  }, [activeSessionId]);

  useEffect(() => {
    if (!autoReadPendingRef.current || isStreaming || streamError) return;
    if (!hasVoiceApi() || !voiceSettings?.tts.autoRead) return;
    if (!voiceSettings.tts.activeProvider && voiceSettings.tts.builtin === 'off') return;
    // A local TTS model that is not downloaded would toast an error on every
    // reply; stay silent until it is installed.
    if (!voiceSettings.tts.activeProvider && voiceSettings.tts.builtin === 'local-tts') {
      const modelId = voiceSettings.tts.builtinModel || 'melo-int8';
      const ready = builtinModels.some((model) => model.id === modelId && model.installed);
      if (!ready) return;
    }
    // Reading from a background window is surprising; a focused window is the
    // signal that the user is actually there to listen.
    if (!document.hasFocus() || document.visibilityState !== 'visible') return;
    if (useVoicePlaybackStore.getState().status !== 'idle') {
      // Another message is being read: skip this one rather than queueing it
      // forever.
      autoReadPendingRef.current = false;
      return;
    }
    const last = [...storedMessages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim());
    if (!last || lastAutoReadRef.current === last.id) return;
    if (preStreamIdsRef.current.has(last.id)) return;
    autoReadPendingRef.current = false;
    lastAutoReadRef.current = last.id;
    void useVoicePlaybackStore.getState().speak(last.id, last.content);
  }, [storedMessages, isStreaming, streamError, voiceSettings, builtinModels]);

  const chatItems = useMemo(
    () => addDateSeparators(messages, t, language),
    [messages, t, language],
  );

  // Scroll to bottom when a slash command inserts a message via setQueryData
  // or when the composer triggers a manual scroll (e.g. after optimistic update).
  // Watches BOTH scrollToBottomTrigger AND chatItems.length so that if the
  // trigger fires before React Query propagates the cache update, the scroll
  // is retried once chatItems reflects the new message count.
  // Directly manipulates the Virtuoso scroller DOM element because Virtuoso's
  // API methods (scrollTo, autoscrollToBottom) may be ignored during internal
  // state recalculation triggered by data changes.
  useEffect(() => {
    const triggerChanged = scrollToBottomTrigger !== lastScrollTriggerRef.current;
    lastScrollTriggerRef.current = scrollToBottomTrigger;

    if (scrollToBottomTrigger > 0 && triggerChanged && chatItems.length > 0) {
      // Multiple scroll attempts at increasing delays to overcome Virtuoso's
      // internal scroll-position restoration that occurs after data changes.
      const attempt = (delay: number) => {
        setTimeout(() => {
          const scrollers = document.querySelectorAll('[data-virtuoso-scroller]');
          // Chat scroller is the one with scrollHeight > 1000 (the sidebar one is smaller)
          for (const scroller of scrollers) {
            if (scroller.scrollHeight > 1000) {
              scroller.scrollTop = scroller.scrollHeight;
              break;
            }
          }
        }, delay);
      };
      attempt(0);
      attempt(50);
      attempt(150);
    }
  }, [scrollToBottomTrigger, chatItems.length]);

  // When switching sessions, scroll to the bottom before the browser paints
  // so the user never sees the list flash at the top.
  useLayoutEffect(() => {
    if (!isLoading && session && chatItems.length > 0 && !isStreaming) {
      virtuosoRef.current?.scrollToIndex({
        index: chatItems.length - 1,
        align: 'end',
      });
    }
  }, [isLoading, session?.id]);

  const lastMessage = messages[messages.length - 1];
  const showStreamingIndicator =
    isStreaming && !streamingBlocks.length && lastMessage?.role === 'user';

  // Retry: re-send the last user message
  const handleRetry = () => {
    const lastUserMsg = [...storedMessages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg && activeSessionId) {
      setTriggerSend(lastUserMsg.content);
    }
  };

  // Edit: enter inline editing mode for a user message
  const handleEditMessage = useCallback((message: Message) => {
    if (message.role === 'user' && message.entryId) {
      setEditingMessage(message.entryId, message.id, stripAppendedContext(message.content));
    }
  }, [setEditingMessage]);

  // Confirm inline edit: optimistic truncation + trigger send
  const handleConfirmEdit = useCallback((message: Message, newContent: string) => {
    if (!activeSessionId || !message.entryId) return;

    // ① Optimistically truncate messages at the edited message (exclusive).
    //    The old message is replaced by the new one sent via setTriggerSend.
    const msgIndex = storedMessages.findIndex((m) => m.id === message.id);
    if (msgIndex >= 0) {
      queryClient.setQueryData(['session', activeSessionId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.slice(0, msgIndex),
        };
      });
    }

    // ② Set edit state and trigger send (composer's mutationFn handles navigateTree + sendMessageStream)
    setEditingMessage(message.entryId, message.id, '');
    setTriggerSend(newContent);
    // ③ Immediately clear visual edit state so the original bubble reappears
    //    (editingEntryId is preserved for navigateTree inside the composer mutation)
    useComposerStore.setState({ editingMessageId: null });
  }, [activeSessionId, storedMessages, queryClient, setEditingMessage, setTriggerSend]);

  // Cancel inline edit
  const handleCancelEdit = useCallback(() => {
    clearEditingMessage();
  }, [clearEditingMessage]);

  // Scroll to bottom
  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({
      index: chatItems.length - 1,
      align: 'end',
    });
  };

  // ----- Error loading session -----
  if (!activeSessionId) return <EmptyChat />;
  if (isLoading) return <LoadingSpinner message="Loading messages..." />;
  if (error) return <ErrorState description="Failed to load messages" onRetry={() => refetch()} />;
  if (!session) return <EmptyChat />;

  // ----- Empty session guidance -----
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex flex-1 flex-col">
        {/* A send that failed before anything landed leaves an empty timeline —
            and this branch is where that failure has to be visible. */}
        {streamError && <StreamErrorBanner error={streamError} onRetry={handleRetry} />}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
          <MessageSquare className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} />
          <div className="text-center">
            <h3 className="text-lg font-medium">{t('开始一段对话')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('在下方输入消息，开始与 AI 助手协作。')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 relative">
      {streamError && <StreamErrorBanner error={streamError} onRetry={handleRetry} />}

      <div className="flex-1">
        <Virtuoso
          key={session?.id}
          ref={virtuosoRef}
          data={chatItems}
          followOutput="smooth"
          atBottomStateChange={setIsAtBottom}
          // Large overscan keeps ~2 extra viewports of real DOM mounted on
          // each side — text selections spanning a few screens survive
          // scrolling instead of being truncated by virtualization.
          increaseViewportBy={{ top: 2400, bottom: 2400 }}
          itemContent={(_index: number, item: ChatItem) => {
            if (isDateSeparator(item)) {
              return (
                <div className="flex items-center justify-center py-3 px-4">
                  <div className="flex items-center gap-3 w-full max-w-md">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">
                      {item.label}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                </div>
              );
            }

            const message = item as Message;
            const msgIndex = messages.indexOf(message);
            const isLast = msgIndex === messages.length - 1;
            const isAssistant = message.role === 'assistant';
            return (
              <MessageBubble
                message={message}
                isStreaming={isStreaming && isLast && isAssistant}
                contextUsage={isLast ? contextUsage ?? undefined : undefined}
                messageTiming={isLast && isAssistant ? messageTiming ?? undefined : undefined}
                toolTimings={isLast && isAssistant ? toolTimings : EMPTY_TOOL_TIMINGS}
                onEditMessage={handleEditMessage}
                onConfirmEdit={handleConfirmEdit}
                onCancelEdit={handleCancelEdit}
              />
            );
          }}
          components={{
            Footer: () =>
              showStreamingIndicator ? (
                <StreamingIndicator />
              ) : null,
          }}
        />
      </div>

      {/* Approvals no visible tool-call block is hosting (e.g. after a reload
          or a session switch mid-approval) — answerable here, not lost. */}
      <PendingApprovalFallback hostedToolCallIds={hostedToolCallIds} />

      {/* Same for questions: main holds the turn open, so the card must be
          reachable even when its tool block is no longer in the timeline. */}
      <PendingAskFallback hostedToolCallIds={hostedToolCallIds} />

      {/* Floating scroll-to-bottom button */}
      {isStreaming && !isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-muted transition-colors"
          aria-label={t('滚动到底部')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
