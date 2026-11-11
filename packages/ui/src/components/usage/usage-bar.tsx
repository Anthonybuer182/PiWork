import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, ArrowDown, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { useComposerStore } from '@/stores/composer-store';
import type { Message, AssistantMessage } from '@pi/types';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCostUSD(cost: number): string {
  if (cost < 0.001) return '< $0.001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function computeStatsFromMessages(messages: Message[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let cost = 0;

  for (const m of messages) {
    if (m.role === 'assistant') {
      const usage = (m as AssistantMessage).usage;
      if (usage) {
        input += usage.inputTokens;
        output += usage.outputTokens;
        total += usage.totalTokens;
        cacheRead += usage.cacheReadTokens ?? 0;
        cacheWrite += usage.cacheWriteTokens ?? 0;
        cost += usage.cost ?? 0;
      }
    }
  }

  return { input, output, cacheRead, cacheWrite, total, cost };
}

export function UsageBar() {
  const sdk = useSDK();
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const liveStats = useComposerStore((s) => s.sessionStats);
  const contextUsage = useComposerStore((s) => s.contextUsage);
  const messageTiming = useComposerStore((s) => s.messageTiming);

  const { data: session } = useQuery({
    queryKey: ['session', activeSessionId],
    queryFn: () => sdk.session.get(activeSessionId!),
    enabled: !!activeSessionId,
    staleTime: 0,
  });

  const storedMessages = session?.messages ?? [];

  const { tokens, cost } = useMemo(() => {
    if (liveStats) {
      return { tokens: liveStats.tokens, cost: liveStats.cost };
    }
    const computed = computeStatsFromMessages(storedMessages);
    return { tokens: computed, cost: computed.cost };
  }, [liveStats, storedMessages]);

  const ctx = liveStats?.contextUsage ?? contextUsage ?? undefined;

  const hasData = tokens.total > 0 || (ctx?.percent != null);

  if (!hasData) {
    return (
      <div className="flex items-center px-4 py-1 border-t text-[11px] text-muted-foreground/40 shrink-0">
        No usage data yet
      </div>
    );
  }

  return (
    // A size container like the composer's tools row: the stats must not
    // wrap into two lines when a preview panel narrows the chat column. The
    // least important numbers step aside instead.
    <div className="@container flex min-w-0 items-center gap-3 overflow-hidden px-4 py-1 border-t text-[11px] text-muted-foreground/80 shrink-0 @max-[420px]:gap-2">
      {/* Input tokens */}
      <span
        className="flex shrink-0 items-center gap-0.5 whitespace-nowrap"
        title={`Input tokens: ${tokens.input.toLocaleString()}`}
      >
        <ArrowUp className="h-3 w-3" />
        {formatTokens(tokens.input)}
      </span>
      {/* Output tokens */}
      <span
        className="flex shrink-0 items-center gap-0.5 whitespace-nowrap"
        title={`Output tokens: ${tokens.output.toLocaleString()}`}
      >
        <ArrowDown className="h-3 w-3" />
        {formatTokens(tokens.output)}
      </span>
      {/* Cache read */}
      {tokens.cacheRead > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 whitespace-nowrap @max-[420px]:hidden"
          title={`Cache read: ${tokens.cacheRead.toLocaleString()}\nCache write: ${tokens.cacheWrite.toLocaleString()}`}
        >
          <RotateCw className="h-3 w-3" />
          {formatTokens(tokens.cacheRead)}
        </span>
      )}
      {/* Cost */}
      {typeof cost === 'number' && (
        <span
          className="shrink-0 whitespace-nowrap font-mono tabular-nums"
          title={`Session cost: $${cost.toFixed(6)}`}
        >
          {formatCostUSD(cost)}
        </span>
      )}
      {/* TPS */}
      {messageTiming && (
        <span className="shrink-0 whitespace-nowrap text-muted-foreground/60 @max-[360px]:hidden">
          {messageTiming.tps} t/s
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {/* Context window usage. The SDK reports `percent` on a 0–100 scale
          (getContextUsage), not 0–1 — thresholds, width and label all use it
          directly. */}
      {ctx && ctx.percent != null && (
        <span
          title={`Context: ${ctx.tokens?.toLocaleString() ?? '?'} / ${ctx.contextWindow.toLocaleString()} (${ctx.percent.toFixed(1)}%)`}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
        >
          <div className="h-1.5 w-20 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                ctx.percent > 80
                  ? 'bg-destructive/80'
                  : ctx.percent > 60
                    ? 'bg-amber-400/80'
                    : 'bg-foreground/40',
              )}
              style={{ width: `${Math.min(ctx.percent, 100)}%` }}
            />
          </div>
          <span className="text-[10px]">{ctx.percent.toFixed(0)}%</span>
        </span>
      )}
    </div>
  );
}
