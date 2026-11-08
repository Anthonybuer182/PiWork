/**
 * A plugin-originated message in the conversation timeline.
 *
 * Distinct from assistant/user bubbles on purpose: the user should see at a
 * glance that this came from a plugin, not from the model. The content is the
 * same declarative card tree tool results use, plus host-rendered file cards,
 * so plugin authors never ship UI code.
 *
 * Step 1 renders the card read-only; click routing (`onMessageAction`) lands in
 * the next slice.
 */
import type { FileBlock, PluginMessage } from '@pi/types';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { usePluginStore } from '@/stores/plugin-store';
import { DeclarativeRenderer, type UiEventContext } from '@/components/plugins/declarative/declarative-renderer';
import { FileBlockDisplay } from './file-block-display';

const STATUS_DOT: Record<string, string> = {
  info: 'bg-muted-foreground/50',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
  loading: 'bg-sky-500 animate-pulse',
};

export function PluginMessageBubble({ message }: { message: PluginMessage }) {
  const plugin = usePluginStore(
    (s) =>
      s.plugins.find((p) => p.id === message.pluginId) ??
      s.installed.find((p) => p.id === message.pluginId),
  );
  const name = plugin?.name ?? message.pluginId;
  const files = (message.blocks ?? []).filter((b) => b.type === 'file') as FileBlock[];

  /**
   * Card interactions go back to the plugin that owns this message. Main
   * forwards them over the backend's protocol; the plugin answers by updating
   * or removing the same message, which comes back through the normal session
   * refresh. Web builds have no host, so the card is display-only there.
   */
  const handleCardEvent = (kind: 'click' | 'submit', ctx: UiEventContext, payload?: unknown) => {
    const api = (
      window as unknown as {
        electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }
    ).electronAPI;
    if (!api?.invoke) return;
    void api
      .invoke('pi:plugin:message-action', {
        pluginId: message.pluginId,
        messageId: message.pluginMessageId,
        sessionId: message.sessionId,
        eventId: ctx.eventId,
        kind,
        payload,
      })
      .catch(() => {
        /* the plugin backend may be gone; the card stays as-is */
      });
  };

  return (
    <div className="flex w-full px-4 py-2">
      <div className="flex w-full max-w-[85%] flex-col gap-2 rounded-xl border bg-muted/20 p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {plugin?.iconUrl ? (
            <img src={plugin.iconUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span className="font-medium text-foreground/80">{name}</span>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              STATUS_DOT[message.pluginStatus ?? 'info'] ?? STATUS_DOT.info,
            )}
          />
          {message.agentVisible ? (
            <Badge
              variant="secondary"
              className="px-1 py-0 text-[9px] font-normal"
              title="这条消息也进入了 AI 上下文"
            >
              AI 可见
            </Badge>
          ) : null}
          <span className="ml-auto tabular-nums">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
        </div>

        {message.content ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
        ) : null}

        {message.card ? (
          <DeclarativeRenderer tree={message.card} onEvent={handleCardEvent} />
        ) : null}

        {files.map((block) => (
          <FileBlockDisplay key={block.id} block={block} />
        ))}
      </div>
    </div>
  );
}
