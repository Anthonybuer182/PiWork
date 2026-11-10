import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  Clock,
  FileText,
  Folder,
  Info,
  Link as LinkIcon,
  Mail,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { UiNode } from '@pi/types';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface UiEventContext {
  eventId: string;
  node: UiNode;
}

interface RendererProps {
  tree: UiNode;
  onEvent: (event: 'click' | 'submit', ctx: UiEventContext, data?: unknown) => void;
}

/** A deliberately small icon vocabulary: plugins name a meaning, the host picks the glyph. */
const ICONS: Record<string, LucideIcon> = {
  file: FileText,
  folder: Folder,
  check: Check,
  mail: Mail,
  calendar: Calendar,
  clock: Clock,
  alert: AlertTriangle,
  info: Info,
  link: LinkIcon,
  sparkles: Sparkles,
};

const STATUS_DOT: Record<string, string> = {
  success: 'bg-emerald-500',
  info: 'bg-foreground/35',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
  loading: 'animate-pulse bg-foreground/30',
};

/**
 * Tier 0 renderer: maps declarative UiNode trees to host components.
 * The plugin ships data, never UI code — theming/a11y/scrolling come free.
 *
 * The visual language is the same one the hand-written chat cards use
 * (ask-card, todo-card): hairline borders, `foreground/xx` tints instead of
 * fixed greys, an 11–13px type scale, and one accent per card at most. Plugins
 * describe hierarchy; they never pick colours, so a card cannot arrive looking
 * like a different product.
 */
export function DeclarativeRenderer({ tree, onEvent }: RendererProps) {
  return <NodeView node={tree} onEvent={onEvent} />;
}

function NodeView({ node, onEvent }: { node: UiNode; onEvent: RendererProps['onEvent'] }) {
  const { component, props = {}, events, children } = node;

  switch (component) {
    case 'Column':
      return (
        <div
          className={cn(
            'flex min-w-0 flex-col',
            gapClass(props.gap),
            padClass(props.padding),
            props.grow === true && 'flex-1',
          )}
          style={alignStyle(props.align)}
        >
          <Children nodes={children} onEvent={onEvent} />
        </div>
      );

    case 'Row':
      return (
        <div
          className={cn(
            'flex min-w-0 flex-row items-center',
            gapClass(props.gap),
            padClass(props.padding),
            justifyClass(props.justify),
            props.grow === true && 'flex-1',
          )}
        >
          <Children nodes={children} onEvent={onEvent} />
        </div>
      );

    case 'Text': {
      const variant = String(props.variant ?? 'default');
      return (
        <span
          className={cn(
            'min-w-0 text-[13px] leading-snug text-foreground',
            variant === 'muted' && 'text-[12px] text-muted-foreground',
            variant === 'small' && 'text-[11px] text-muted-foreground/80',
            variant === 'title' && 'text-[13px] font-semibold leading-snug text-foreground',
            props.weight === 'bold' && 'font-semibold',
            props.mono === true && 'font-mono text-[12px]',
            props.truncate === true && 'truncate',
          )}
        >
          {String(props.text ?? '')}
        </span>
      );
    }

    case 'Button': {
      // Outline by default: a card lives inside the conversation, so a filled
      // primary button on every one of them reads as a wall of alerts. A
      // plugin that really wants the loud one asks for `variant: 'primary'`.
      const variant =
        props.variant === 'primary' || props.variant === 'default'
          ? 'default'
          : props.variant === 'secondary'
            ? 'secondary'
            : props.variant === 'ghost'
              ? 'ghost'
              : 'outline';
      return (
        <Button
          variant={variant}
          size="sm"
          disabled={props.disabled === true}
          className={cn('h-7 w-fit shrink-0 px-2.5 text-xs', variant === 'outline' && 'border-border/70')}
          data-ui-event={events?.onClick}
          onClick={() => events?.onClick && onEvent('click', { eventId: events.onClick, node }, props)}
        >
          {String(props.label ?? t('按钮'))}
        </Button>
      );
    }

    case 'Input': {
      const eventId = events?.onSubmit;
      return (
        <Input
          placeholder={props.placeholder ? String(props.placeholder) : undefined}
          defaultValue={props.value !== undefined ? String(props.value) : undefined}
          className="h-8 text-[13px]"
          data-ui-event={eventId}
          onKeyDown={(e) => {
            if (eventId && e.key === 'Enter') {
              onEvent('submit', { eventId, node }, (e.target as HTMLInputElement).value);
            }
          }}
        />
      );
    }

    case 'Card': {
      const Icon = typeof props.icon === 'string' ? ICONS[props.icon] : undefined;
      const status = typeof props.status === 'string' ? props.status : undefined;
      return (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card">
          {props.title ? (
            <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
              {Icon ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70">
                  <Icon className="h-3.5 w-3.5" />
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-foreground">
                {String(props.title)}
              </span>
              {status ? (
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[status] ?? STATUS_DOT.info)}
                  title={status}
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <Children nodes={children} onEvent={onEvent} />
          </div>
        </div>
      );
    }

    case 'Badge':
      return (
        <span className="inline-flex shrink-0 items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {String(props.text ?? '')}
        </span>
      );

    case 'List': {
      const items = (props.items ?? []) as Array<{ key?: string; label: string; description?: string; badge?: string | number }>;
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {items.map((item, i) => (
            <button
              key={item.key ?? i}
              type="button"
              data-ui-event={events?.onClick}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-left text-[13px] transition-colors',
                events?.onClick && 'hover:bg-muted/40',
              )}
              onClick={() => events?.onClick && onEvent('click', { eventId: events.onClick, node }, { key: item.key, label: item.label })}
            >
              <span className="shrink-0 font-medium">{item.label}</span>
              {item.description ? <span className="flex-1 truncate text-[12px] text-muted-foreground">{item.description}</span> : null}
              {item.badge !== undefined ? (
                <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                  {item.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      );
    }

    case 'Separator':
      return <Separator className="my-1.5" />;

    case 'Image': {
      const src = typeof props.source === 'string' && props.source.startsWith('data:')
        ? String(props.source)
        : `data:${String(props.mimeType ?? 'image/png')};base64,${String(props.source ?? '')}`;
      const maxHeight = typeof props.maxHeight === 'number' ? props.maxHeight : 280;
      return (
        <img
          src={src}
          alt={String(props.alt ?? '')}
          style={{ maxHeight }}
          className="max-w-full rounded-md border border-border/60"
        />
      );
    }

    case 'KeyValue': {
      // Both shapes are in the wild: `{ key, value }` objects and the compact
      // `['key', value]` tuples the tasks plugin writes.
      const items = (props.items ?? []) as Array<{ key?: unknown; value?: unknown } | unknown[]>;
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {items.map((raw, i) => {
            const tuple = Array.isArray(raw);
            const key = tuple ? raw[0] : raw?.key;
            const value = tuple ? raw[1] : raw?.value;
            return (
              <div key={i} className="flex min-w-0 items-start gap-3 text-[13px]">
                <span className="w-16 shrink-0 text-[12px] leading-5 text-muted-foreground/80">
                  {String(key ?? '')}
                </span>
                <span className="min-w-0 flex-1 break-words leading-5 text-foreground">
                  {String(value ?? '')}
                </span>
              </div>
            );
          })}
        </div>
      );
    }

    case 'Spinner':
      return (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {props.label ? String(props.label) : null}
        </div>
      );

    case 'EmptyState':
      return (
        <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
          <span className="text-[13px] font-medium">{String(props.title ?? t('暂无内容'))}</span>
          {props.description ? <span className="text-[11px] text-muted-foreground">{String(props.description)}</span> : null}
        </div>
      );

    default:
      return null;
  }
}

function Children({ nodes, onEvent }: { nodes?: UiNode[]; onEvent: RendererProps['onEvent'] }): ReactNode {
  if (!nodes?.length) return null;
  return (
    <>
      {nodes.map((child, i) => (
        <NodeView key={i} node={child} onEvent={onEvent} />
      ))}
    </>
  );
}

function gapClass(gap: unknown): string {
  switch (gap) {
    case 'sm': return 'gap-1';
    case 'md': return 'gap-2';
    case 'lg': return 'gap-4';
    default: return 'gap-2';
  }
}

function padClass(padding: unknown): string {
  switch (padding) {
    case 'sm': return 'p-1';
    case 'md': return 'p-2';
    case 'lg': return 'p-4';
    case 'none': return '';
    default: return '';
  }
}

function justifyClass(justify: unknown): string {
  switch (justify) {
    case 'between': return 'justify-between';
    case 'end': return 'justify-end';
    case 'center': return 'justify-center';
    default: return '';
  }
}

function alignStyle(align: unknown): { alignItems?: string } | undefined {
  if (align === 'center') return { alignItems: 'center' };
  return undefined;
}
