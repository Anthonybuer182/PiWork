import { useState, useRef, useCallback, useLayoutEffect, useEffect, KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { useCommandStore } from '@/stores/command-store';
import { useI18n } from '@/i18n';

interface PendingTokenInsert {
  text: string;
  type: 'slash' | 'mention';
}

interface ComposerInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSlashDetected?: (query: string) => void;
  onMentionDetected?: (query: string) => void;
  onSlashDismiss?: () => void;
  onMentionDismiss?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoResize?: boolean;
  maxRows?: number;
  showMenu?: boolean;
  onMenuNavigate?: (direction: 'up' | 'down') => void;
  onMenuSelect?: () => void;
  totalMenuItems?: number;
  /** Called when Ctrl+Enter is pressed while streaming: steer the agent */
  onSteerSubmit?: () => void;
  /** Called when Enter is pressed while streaming: queue a follow-up */
  onFollowUpSubmit?: () => void;
  /** Whether the agent is currently generating a response */
  isStreaming?: boolean;
  /** Set by parent when a token is selected from menu. ComposerInput reads and clears it after rendering. */
  pendingTokenInsert?: React.MutableRefObject<PendingTokenInsert | null>;
  /** Version counter incremented when a token is selected, forces useEffect re-run */
  tokenInsertVersion?: number;
  /** Version counter incremented when parent wants to refocus (e.g. after file picker closes) */
  focusVersion?: number;
}

/**
 * Regex matching /command and @mention tokens at word boundaries.
 * Must be kept in sync with token-parser.tsx.
 */
const TOKEN_PATTERN = /((?:^|\s)(?:\/[^\s]+|@[^\s]+))/g;

/** Known slash command names — only these render as command chips. */
function useSlashCommandNames(): Set<string> {
  const commands = useCommandStore((s) => s.commands);
  return new Set(commands.map((c) => c.name));
}

/** Convert plain text to HTML with styled token spans */
function renderPlainTextToHTML(text: string, slashCommandNames: Set<string>): string {
  const parts = text.split(TOKEN_PATTERN);
  return parts
    .map((part) => {
      const trimmed = part.trimStart();
      if (trimmed.startsWith('/') || trimmed.startsWith('@')) {
        // Only render known slash commands as chips; unknown /words stay plain
        if (trimmed.startsWith('/') && !slashCommandNames.has(trimmed)) return part;
        const isSlash = trimmed.startsWith('/');
        const cls = isSlash ? 'token-slash' : 'token-mention';
        const leadingSpace = part.slice(0, part.length - trimmed.length);
        return `${leadingSpace}<span class="${cls}" data-token="${trimmed}" contenteditable="false">${trimmed}</span>`;
      }
      return part;
    })
    .join('');
}

/** Extract plain text from a contentEditable element */
function getPlainText(el: HTMLElement): string {
  return el.textContent || '';
}

/** Replace all token spans with their text content, restoring plain text */
function stripTokens(el: HTMLElement): void {
  const spans = el.querySelectorAll('span.token-slash, span.token-mention');
  // Convert to array since we're mutating the DOM
  Array.from(spans).forEach((span) => {
    const text = span.textContent || '';
    span.replaceWith(document.createTextNode(text));
  });
}

/** Check if any token span has been damaged (text content differs from data-token) */
function hasDamagedTokens(el: HTMLElement): boolean {
  const spans = el.querySelectorAll('span[data-token]');
  for (const span of spans) {
    if (span.textContent !== span.getAttribute('data-token')) {
      return true;
    }
  }
  return false;
}

/** Place the text cursor at the end of a contentEditable element */
function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  el.focus();
}

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  onSlashDetected,
  onMentionDetected,
  onSlashDismiss,
  onMentionDismiss,
  disabled,
  placeholder,
  autoResize = true,
  maxRows = 8,
  showMenu = false,
  onMenuNavigate,
  onMenuSelect,
  onSteerSubmit,
  onFollowUpSubmit,
  isStreaming = false,
  pendingTokenInsert,
  tokenInsertVersion,
  focusVersion,
}: ComposerInputProps) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t('输入消息，/ 唤起命令，@ 提及…');
  const editorRef = useRef<HTMLDivElement>(null);
  // Track IME composition state to prevent store updates during CJK input.
  const isComposing = useRef(false);
  // Prevent innerHTML override in useEffect when the value change was triggered by our own onChange.
  const justSynced = useRef(false);
  // Registry-driven command chips (host + plugin commands).
  const slashCommandNames = useSlashCommandNames();

  const [localValue, setLocalValue] = useState(value);

  // Calculate maxHeight based on line height
  useLayoutEffect(() => {
    if (!autoResize || !editorRef.current) return;
    const el = editorRef.current;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.maxHeight = `${lineHeight * maxRows}px`;
  }, [autoResize, maxRows]);

  // Sync external value → contentEditable DOM
  useEffect(() => {
    if (isComposing.current) return;
    if (justSynced.current) {
      justSynced.current = false;
      return;
    }
    if (!editorRef.current) return;

    const currentText = getPlainText(editorRef.current);
    // Re-render HTML when value changes OR when a token was selected from menu
    // (even if text matches, we need to show the styled span)
    if (currentText !== value || pendingTokenInsert?.current) {
      editorRef.current.innerHTML = renderPlainTextToHTML(value, slashCommandNames);
      setLocalValue(value);
      // Place cursor at end after external value change (e.g., menu selection)
      placeCaretAtEnd(editorRef.current);
    }

    // Clear pending token insert signal after syncing
    if (pendingTokenInsert?.current) {
      pendingTokenInsert.current = null;
    }
  }, [value, pendingTokenInsert, tokenInsertVersion, slashCommandNames]);

  // Refocus the input when parent signals (e.g. after file picker closes)
  useEffect(() => {
    if (editorRef.current && document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }
  }, [focusVersion]);

  const flushToStore = useCallback(
    (rawValue: string) => {
      onChange(rawValue);

      const textBeforeCursor = rawValue;

      // Only detect slash commands when / is at start of input or after whitespace,
      // so paths like "path/to/file" don't accidentally trigger the menu.
      const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\w*)$/);
      if (slashMatch && onSlashDetected) {
        onSlashDetected(slashMatch[1]);
        return;
      }

      // Only detect mentions when @ is at start of input or after whitespace,
      // so emails like "user@example.com" don't accidentally trigger the menu.
      const mentionMatch = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/);
      if (mentionMatch && onMentionDetected) {
        onMentionDetected(mentionMatch[1]);
        return;
      }

      // No match - dismiss menus
      onSlashDismiss?.();
      onMentionDismiss?.();
    },
    [onChange, onSlashDetected, onMentionDetected, onSlashDismiss, onMentionDismiss],
  );

  const handleInput = useCallback(() => {
    // During IME composition (e.g. typing Chinese/Japanese), skip sync to avoid
    // React's controlled re-render overwriting the IME candidate text.
    if (isComposing.current || !editorRef.current) return;

    // Strip damaged token spans: if user edited inside a token badge,
    // revert ALL tokens to plain text (simple and reliable).
    if (hasDamagedTokens(editorRef.current)) {
      stripTokens(editorRef.current);
    }

    const text = getPlainText(editorRef.current);
    setLocalValue(text);
    justSynced.current = true;
    flushToStore(text);
  }, [flushToStore]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      document.execCommand('insertText', false, text);
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // During IME composition (e.g. typing Chinese/Japanese), Enter confirms
      // the candidate character and should NOT be treated as a send/submit.
      if (isComposing.current) return;

      // When menu is open, route navigation keys to the menu
      if (showMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onMenuNavigate?.('down');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onMenuNavigate?.('up');
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onMenuSelect?.();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onSlashDismiss?.();
          onMentionDismiss?.();
          return;
        }
        return;
      }

      // During streaming: Enter = follow-up (default), Ctrl/Cmd+Enter = steer
      if (isStreaming) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (value.trim()) {
            onSteerSubmit?.();
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (value.trim()) {
            onFollowUpSubmit?.();
          }
          return;
        }
        // Escape during streaming aborts
        if (e.key === 'Escape') {
          onSlashDismiss?.();
          onMentionDismiss?.();
          return;
        }
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      if (e.key === 'Escape') {
        onSlashDismiss?.();
        onMentionDismiss?.();
      }
    },
    [value, onSubmit, onSlashDismiss, onMentionDismiss, showMenu, onMenuNavigate, onMenuSelect, isStreaming, onSteerSubmit, onFollowUpSubmit],
  );

  return (
    <div
      ref={editorRef}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-label={t('消息输入框')}
      aria-multiline="true"
      data-placeholder={resolvedPlaceholder}
      onInput={handleInput}
      onPaste={handlePaste}
      onCompositionStart={() => {
        isComposing.current = true;
      }}
      onCompositionEnd={() => {
        isComposing.current = false;
        if (editorRef.current) {
          const text = getPlainText(editorRef.current);
          setLocalValue(text);
          justSynced.current = true;
          flushToStore(text);
        }
      }}
      onBlur={() => {
        // Safety net: if compositionend was never delivered (e.g. user clicked
        // away during an active IME session), reset the flag so the next
        // keystroke isn't permanently blocked.
        if (isComposing.current) {
          isComposing.current = false;
          if (editorRef.current) {
            justSynced.current = true;
            flushToStore(getPlainText(editorRef.current));
          }
        }
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        'w-full bg-transparent px-3 py-2 text-sm',
        'focus:outline-hidden',
        disabled && 'cursor-not-allowed opacity-50',
        // Placeholder via CSS :empty pseudo-class
        '[&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-muted-foreground',
        'overflow-y-auto',
      )}
      style={{
        minHeight: '36px',
      }}
    />
  );
}
