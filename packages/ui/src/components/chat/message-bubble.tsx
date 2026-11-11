import { useState, useRef, useEffect, memo } from 'react';
import type { Message, ContentBlock, ThinkingBlock as ThinkingBlockType, ToolCallBlock, ToolResultBlock, ImageBlock, FileBlock, AssistantMessage, TokenUsage, ContextUsageInfo, MessageTiming } from '@pi/types';
import { cn } from '@/lib/utils';
import { Clock, Zap, FileText, Copy, Pencil, Check, ChevronLeft, ChevronRight, RotateCcw, GitBranch } from 'lucide-react';
import { ThinkingBlock } from './thinking-block';
import { useI18n } from '@/i18n';
import { ToolCallDisplay } from './tool-call-display';
import { MarkdownContent } from './markdown-content';
import { renderTokenizedText } from '@/lib/token-parser';
import { ImageBlockDisplay } from './image-block-display';
import { FileBlockDisplay } from './file-block-display';
import { SpeakButton } from './speak-button';
import { extractAppendedQuotes } from '@/lib/quote-helpers';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useComposerStore } from '@/stores/composer-store';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  contextUsage?: ContextUsageInfo;
  messageTiming?: MessageTiming;
  toolTimings?: Map<string, number>;
  /** Tool-call ids whose plugin card body is folded away (see suppressedToolCards). */
  suppressedCards?: ReadonlySet<string>;
  /** Callback when user clicks "Edit" on a user message */
  onEditMessage?: (message: Message) => void;
  /** Callback when user confirms inline edit with new content */
  onConfirmEdit?: (message: Message, newContent: string) => void;
  /** Callback when user cancels inline edit */
  onCancelEdit?: () => void;
  /** Show "regenerate" on this assistant message (it ends the current turn). */
  showRegenerate?: boolean;
  /** Re-run the turn this assistant message answers. */
  onRegenerate?: (message: Message) => void;
  /** Show a different version of a turn. */
  onSwitchBranch?: (entryId: string) => void;
  /** Branch switching is unavailable (a run is active, or one is in flight). */
  branchSwitchingDisabled?: boolean;
  /** Copy the conversation up to this reply into a new, independent one. */
  showFork?: boolean;
  onForkMessage?: (message: Message) => void;
  /** A branch copy is being created. */
  forking?: boolean;
}

/**
 * Pair tool_call blocks with their corresponding tool_result blocks.
 * Returns an array of rendered elements, where tool_call + result are grouped.
 */
function renderBlocks(
  blocks: ContentBlock[],
  isStreaming: boolean,
  toolTimings: Map<string, number>,
  suppressedCards?: ReadonlySet<string>,
) {
  const resultMap = new Map<string, ToolResultBlock>();
  const elements: React.ReactNode[] = [];

  // Separate file blocks — they always render at the end, regardless of
  // their position in the data, so the display is consistent between
  // streaming, cached, and loaded-from-disk views.
  const nonFileBlocks = blocks.filter((b) => b.type !== 'file');
  const fileBlocks = blocks.filter((b) => b.type === 'file');

  // First pass: collect all tool_results by toolCallId
  for (const block of nonFileBlocks) {
    if (block.type === 'tool_result') {
      const resultBlock = block as ToolResultBlock;
      resultMap.set(resultBlock.toolCallId, resultBlock);
    }
  }

  // Second pass: render non-file blocks, pairing tool_calls with results
  for (const block of nonFileBlocks) {
    switch (block.type) {
      case 'text':
        elements.push(
          <MarkdownContent key={block.id} content={block.content} isStreaming={isStreaming} />,
        );
        break;
      case 'thinking':
        elements.push(
          <ThinkingBlock key={block.id} block={block as ThinkingBlockType} isStreaming={isStreaming} />,
        );
        break;
      case 'tool_call': {
        const tcBlock = block as ToolCallBlock;
        const result = resultMap.get(tcBlock.toolCallId);
        const toolMs = toolTimings.get(tcBlock.toolCallId) ?? tcBlock.durationMs;
        elements.push(
          <ToolCallDisplay
            key={tcBlock.id}
            block={tcBlock}
            result={result}
            isStreaming={isStreaming && !result}
            durationMs={toolMs}
            showPluginCard={!suppressedCards?.has(tcBlock.toolCallId)}
          />,
        );
        break;
      }
      case 'tool_result':
        // Skip - already rendered with their tool_call parent
        break;
      case 'image':
        elements.push(
          <ImageBlockDisplay key={block.id} block={block as ImageBlock} isStreaming={isStreaming} />,
        );
        break;
      default:
        break;
    }
  }

  // Render file blocks at the end for consistent display across all data sources
  for (const block of fileBlocks) {
    elements.push(
      <FileBlockDisplay key={block.id} block={block as FileBlock} />,
    );
  }

  return elements;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Per-message metrics bar shown at bottom of assistant messages */
function MessageMetrics({ timing, contentLength, isStreaming }: { timing?: MessageTiming; contentLength: number; isStreaming: boolean }) {
  const { t } = useI18n();
  const estTokens = timing?.estTokens ?? Math.ceil(contentLength / 4);

  // Only show real metrics if we have timing data; otherwise just est
  if (!timing && isStreaming) return null;

  return (
    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/50 tabular-nums">
      {/* Estimated tokens */}
      <span className="flex items-center gap-0.5" title={t('预计输出 tokens（字符数 / 4）')}>
        <FileText className="h-2.5 w-2.5" />
        ~{estTokens.toLocaleString()} t
      </span>
      {/* TPS */}
      {timing && timing.tps > 0 && (
        <span
          className="flex items-center gap-0.5"
          title={t('每秒 tokens：{value}', { value: timing.tps.toFixed(1) })}
        >
          <Zap className="h-2.5 w-2.5" />
          {timing.tps.toFixed(1)} t/s
        </span>
      )}
      {/* Thinking time */}
      {timing && timing.thinkingTimeMs > 0 && (
        <span
          className="flex items-center gap-0.5"
          title={t('思考耗时：{duration}', {
            duration: formatDuration(timing.thinkingTimeMs),
          })}
        >
          <Clock className="h-2.5 w-2.5" />
          {formatDuration(timing.thinkingTimeMs)}
        </span>
      )}
      {/* Generation time */}
      {timing && timing.generationTimeMs > 0 && (
        <span
          className="flex items-center gap-0.5"
          title={t('生成耗时：{duration}', {
            duration: formatDuration(timing.generationTimeMs),
          })}
        >
          <span className="text-[8px] leading-none">▸</span>
          {formatDuration(timing.generationTimeMs)}
        </span>
      )}
    </div>
  );
}

/**
 * Stable empty map. An inline `new Map()` default (or one built at the call
 * site) gives a fresh identity every render, which alone defeats memoization.
 */
const EMPTY_TOOL_TIMINGS = new Map<string, number>();

function MessageBubbleImpl({
  message,
  isStreaming,
  contextUsage,
  messageTiming,
  toolTimings = EMPTY_TOOL_TIMINGS,
  suppressedCards,
  onEditMessage,
  onConfirmEdit,
  onCancelEdit,
  showRegenerate,
  onRegenerate,
  onSwitchBranch,
  branchSwitchingDisabled,
  showFork,
  onForkMessage,
  forking,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isUser = message.role === 'user';
  const hasBlocks = message.blocks && message.blocks.length > 0;
  const isAssistant = message.role === 'assistant';
  const editingMessageId = useComposerStore((s) => s.editingMessageId);
  const editingContent = useComposerStore((s) => s.editingContent);
  const setEditingContent = useComposerStore((s) => s.setEditingContent);
  const isCurrentlyEditing = isUser && editingMessageId === message.id;

  // Only show per-message metrics for assistant messages
  const showMessageMetrics = isAssistant && (hasBlocks || message.content);

  // For user messages with blocks, split text blocks from media blocks
  const userTextBlocks = isUser && hasBlocks
    ? message.blocks.filter((b) => b.type === 'text')
    : [];
  const userMediaBlocks = isUser && hasBlocks
    ? message.blocks.filter((b) => b.type === 'image' || b.type === 'file')
    : [];
  const hasUserMedia = userMediaBlocks.length > 0;

  // User bubbles show only what the user typed. Older sessions still carry the
  // quote markup the composer used to append for the model; strip it so those
  // messages read cleanly. (The quote feature itself is gone — this is purely
  // for conversations recorded before its removal.)
  const displayContent = isUser ? extractAppendedQuotes(message.content).display : message.content;

  // Attachment-only sends carry no text (`[Attached: …]` is stripped before
  // display), so the text bubble only exists when there is something to say.
  const hasUserText = isUser && displayContent.trim().length > 0;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may not be available */ }
  };

  // Auto-resize textarea and place cursor at end
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
      // Move cursor to end of content
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editingContent, isCurrentlyEditing]);

  const handleStartEdit = () => {
    onEditMessage?.(message);
  };

  // A user message can carry attachments; they survive an edit, so an empty
  // editor is still a valid "retry this turn" when the original had files.
  const hasReattachableAttachments = isUser && message.blocks.some(
    (block) => (block.type === 'image' && block.data) || (block.type === 'file' && block.workspacePath),
  );
  const canSubmitEdit = editingContent.trim().length > 0 || hasReattachableAttachments;

  const handleConfirmEdit = () => {
    if (!canSubmitEdit) return;
    onConfirmEdit?.(message, editingContent);
  };

  const handleCancelEdit = () => {
    onCancelEdit?.();
  };

  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancelEdit();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleConfirmEdit();
    }
  };

  return (
    <div className={cn('flex w-full px-4 py-2', isUser ? 'justify-end' : 'flex-col')}>
      <div className={cn('flex max-w-[85%] flex-col gap-0.5 group', isUser && 'items-end')}>
        {isUser ? (
          <div className={cn('flex flex-col', isUser && 'items-end')}>
            {/* Inline editing: textarea replaces the bubble */}
            {isCurrentlyEditing ? (
              <div className="flex flex-col gap-1.5 w-full">
                <textarea
                  ref={textareaRef}
                  className={cn(
                    'rounded-3xl bg-muted px-4 py-2.5 text-sm w-full min-w-[260px]',
                    'resize-none outline-hidden ring-1 ring-border focus:ring-foreground/20',
                    'placeholder:text-muted-foreground/60 overflow-hidden',
                  )}
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  rows={1}
                  autoFocus
                />
                <div className={cn('flex items-center gap-1', isUser && 'justify-end')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    onClick={handleCancelEdit}
                  >
                    {t('取消')}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleConfirmEdit}
                    disabled={!canSubmitEdit}
                  >
                    {t('重试')}
                  </Button>
                </div>
              </div>
            ) : hasUserText ? (
              <div className={cn(
                'max-w-full rounded-3xl bg-muted px-4 py-2.5 text-sm',
              )}>
                <p className="whitespace-pre-wrap">{renderTokenizedText(displayContent)}</p>
              </div>
            ) : null}
            {hasUserMedia && (
              <div className="flex flex-col gap-1 mt-1 max-w-full">
                {renderBlocks(userMediaBlocks, !!isStreaming, toolTimings)}
              </div>
            )}
          </div>
        ) : !hasBlocks ? (
          <div className="text-sm leading-relaxed">
            <p className="whitespace-pre-wrap">{renderTokenizedText(message.content)}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {renderBlocks(message.blocks, !!isStreaming, toolTimings, suppressedCards)}
          </div>
        )}
        {/* Action row: timestamp + metrics + hover buttons */}
        <div className={cn(
          'flex items-center gap-3',
          isUser && 'flex-row-reverse justify-start',
        )}>
          {/* Versions of this turn. Always visible — it is a fact about the
              conversation, not a hover affordance: the current bubble is one
              of N, and the arrows show the others. */}
          {message.branch && message.branch.count > 1 && (
            <div className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60 tabular-nums">
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                disabled={branchSwitchingDisabled || message.branch.index === 0}
                onClick={() => onSwitchBranch?.(message.branch!.targets[message.branch!.index - 1])}
                aria-label={t('上一个版本')}
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">
                    {message.branch.index + 1}/{message.branch.count}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('第 {index} 版，共 {count} 版', {
                    index: message.branch.index + 1,
                    count: message.branch.count,
                  })}
                </TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                disabled={branchSwitchingDisabled || message.branch.index === message.branch.count - 1}
                onClick={() => onSwitchBranch?.(message.branch!.targets[message.branch!.index + 1])}
                aria-label={t('下一个版本')}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          )}
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
          {showMessageMetrics && (
            <MessageMetrics
              timing={messageTiming}
              contentLength={message.content.length}
              isStreaming={!!isStreaming}
            />
          )}
          {/* Hover action buttons: below content, near timestamp */}
          {message.content && !isStreaming && !isCurrentlyEditing && (
            <div className={cn(
              'flex items-center gap-0.5 transition-opacity',
              'opacity-0 group-hover:opacity-100',
            )}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                    onClick={handleCopy}
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{copied ? t('已复制！') : t('复制')}</TooltipContent>
              </Tooltip>
              {isAssistant && (
                <SpeakButton messageId={message.id} text={message.content} />
              )}
              {isAssistant && showRegenerate && onRegenerate && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                      onClick={() => onRegenerate(message)}
                      disabled={branchSwitchingDisabled}
                      aria-label={t('重新生成本轮回答')}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('重新生成本轮回答')}</TooltipContent>
                </Tooltip>
              )}
              {isAssistant && showFork && onForkMessage && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                      onClick={() => onForkMessage(message)}
                      disabled={branchSwitchingDisabled || forking}
                      aria-label={t('从此回复创建分支')}
                    >
                      <GitBranch className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('从此回复创建分支')}
                    <span className="mt-1 block text-[10px] opacity-70">
                      {t('分支会复制到这条回复为止的对话，原对话保持不变。')}
                    </span>
                  </TooltipContent>
                </Tooltip>
              )}
              {isUser && message.entryId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
                      onClick={handleStartEdit}
                      disabled={branchSwitchingDisabled}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('编辑')}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized: the streaming message changes on every chunk, which re-renders the
 * whole timeline. Stored messages keep their object identity, so with stable
 * props they bail out here instead of re-parsing their markdown each time.
 */
export const MessageBubble = memo(MessageBubbleImpl);
