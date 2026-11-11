import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { ThinkingBlock as ThinkingBlockType } from '@pi/types';
import { useI18n } from '@/i18n';

interface ThinkingBlockProps {
  block: ThinkingBlockType;
  isStreaming?: boolean;
}

function formatElapsed(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function ThinkingBlock({ block, isStreaming }: ThinkingBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startRef = useRef<number>(0);

  // Auto-expand when new thinking content arrives during streaming
  useEffect(() => {
    if (isStreaming && block.thinking && !userCollapsed) {
      setExpanded(true);
    }
    if (isStreaming && !startRef.current) {
      startRef.current = Date.now();
    }
  }, [block.thinking, isStreaming, userCollapsed]);

  // Track streaming elapsed time, matching the reference approach
  useEffect(() => {
    if (!isStreaming) {
      startRef.current = 0;
      setElapsed(null);
      return;
    }
    const tick = () => {
      if (startRef.current) {
        setElapsed(Date.now() - startRef.current);
      }
    };
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [isStreaming]);

  const handleToggle = () => {
    if (expanded) {
      setExpanded(false);
      setUserCollapsed(true);
    } else {
      setExpanded(true);
      setUserCollapsed(false);
    }
  };

  const showDuration = block.duration != null
    ? formatElapsed(block.duration)
    : elapsed != null
      ? formatElapsed(elapsed)
      : null;

  return (
    <div className="my-1 rounded-md border overflow-hidden text-xs border-border">
      <button
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground hover:bg-muted/50 text-left"
        onClick={handleToggle}
      >
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          className={cn(
            'shrink-0 transition-transform duration-150',
            expanded ? 'rotate-180' : '',
          )}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
        <span className="font-medium">{t('思考过程')}</span>
        {showDuration && (
          <span className="ml-auto text-muted-foreground/60 tabular-nums">
            {showDuration}
          </span>
        )}
        {isStreaming && !block.duration && !elapsed && (
          <span className="text-muted-foreground/60 animate-pulse">...</span>
        )}
      </button>
      {expanded && block.thinking && (
        <div className="border-t px-2.5 py-2 text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
          {block.thinking}
        </div>
      )}
    </div>
  );
}
