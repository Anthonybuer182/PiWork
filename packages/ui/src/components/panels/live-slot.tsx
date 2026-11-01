import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MonitorX } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { t as translate } from '@/i18n';

/**
 * Live slot: a native WebContentsView mount point. The component
 * reports its viewport-relative bounds to the main process, which positions
 * the view over this slot; on unmount the view detaches (hidden).
 */
export function LiveSlot({
  pluginId,
  panelId,
  /**
   * Plugin web panels: tell the backend the panel mounted, and re-tell it when
   * the open params change (switching files in the same panel). The event has
   * to travel over the panel's own MessagePort, which lives in the view's
   * preload — so it goes shell → main → view rather than straight to the
   * backend, unlike the iframe path where the shell held the port itself.
   *
   * Off by default: host-managed slots (the browser preview) have no backend
   * panel to mount.
   */
  notifyMounted = false,
  params,
}: {
  pluginId: string;
  panelId: string;
  notifyMounted?: boolean;
  params?: unknown;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest measure-and-report callback, owned by the attach effect below but
  // reachable from layout-driven re-measures (a column swap moves this slot
  // without resizing it).
  const reportBoundsRef = useRef<() => void>(() => {});
  // Which side the chat is on. A swap reorders the columns, which moves this
  // slot's rect without changing its size — ResizeObserver cannot see that,
  // and the native view would stay behind over the chat.
  const chatRight = useUIStore((s) => s.chatRightOfPanels);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  // Same rule the layout applies: the swap only takes effect with the sidebar
  // closed. Opening the sidebar therefore moves the columns too.
  const swapped = chatRight && !sidebarOpen;
  // Which conversation is on screen. Sent alongside (never inside) the open
  // params — params is a store reference, and folding the session into it
  // would change that reference on every switch. Re-firing on session change
  // is the point: the backend learns the panel now serves the new session.
  const sessionId = useUIStore((s) => s.activeSessionId);
  // The workspace this window shows. Travels with the mount report for the
  // same reason `sessionId` does, and one stronger one: main cannot read it
  // off the window context here, because this effect runs before the shell's
  // "active workspace changed" IPC lands — main would still hold the previous
  // workspace, and the panel would keep that stale value until the next
  // session switch.
  const workspaceId = useUIStore((s) => s.activeWorkspaceId);
  // Host overlays that must cover native views. Settings is currently the only
  // one; a second overlay must be OR-ed in here (or this should become a
  // suspension counter on the slot registry) or it will be covered by every
  // native panel and its clicks swallowed — exactly what this flag prevents.
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const occludedRef = useRef(settingsOpen);
  occludedRef.current = settingsOpen;

  useEffect(() => {
    if (!notifyMounted) return;
    const api = (window as unknown as {
      electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).electronAPI;
    if (!api?.invoke) return;
    // Re-fires whenever params change; the view's preload queues it if the
    // panel's page (and its port) are not up yet.
    api
      .invoke('pi:plugin:panel-mounted', { pluginId, panelId, params, sessionId, workspaceId })
      .catch(() => {});
  }, [pluginId, panelId, params, sessionId, workspaceId, notifyMounted]);

  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).electronAPI;
    if (!api) {
      // Browser build: there is no host to create a native view.
      setError(translate('原生视图仅在桌面端可用'));
      return;
    }

    const slotId = `${pluginId}:${panelId}`;
    let lastBounds = '';

    const reportBounds = () => {
      const el = containerRef.current;
      if (!el) return;
      // Occluded by the settings dialog → hide this view (0×0 means hide to
      // the host). Keyed separately so closing the dialog produces a real
      // report rather than a deduped no-op.
      if (occludedRef.current) {
        if (lastBounds === 'occluded') return;
        lastBounds = 'occluded';
        api
          .invoke('pi:liveview:set-bounds', { slotId, x: 0, y: 0, width: 0, height: 0 })
          .catch(() => {});
        return;
      }
      const rect = el.getBoundingClientRect();
      const bounds = {
        slotId,
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === lastBounds) return;
      lastBounds = key;
      // Report every transition — including 0×0 (panel switched away under
      // keepAlive renders this slot display:none). Main hides the view for
      // non-positive dims; skipping the report here would leave the view at
      // stale bounds, an invisible overlay eating real mouse clicks.
      api.invoke('pi:liveview:set-bounds', bounds).catch(() => {});
    };

    api
      .invoke('pi:liveview:attach', { slotId })
      .then((res) => {
        // The host answers `{ok:false}` for a slot it has no handler for. That
        // resolves rather than rejects, so an unchecked call would leave the
        // panel silently empty — the plugin author's only clue would be a
        // blank box. Surface it instead.
        const r = res as { ok?: boolean; error?: string } | undefined;
        if (r && r.ok === false) {
          setError(r.error ?? translate('该面板没有可用的原生视图'));
          return;
        }
        setError(null);
        reportBounds();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });

    // No debounce: ResizeObserver already batches callbacks to layout frames,
    // and the `lastBounds` key dedups redundant reports. A trailing debounce
    // here made the view chase a column drag in 50ms steps — visibly lagging
    // the layout instead of tracking it. There is no feedback loop to fear:
    // the native view sits OUTSIDE the DOM, so positioning it never re-triggers
    // this observer.
    const observer = new ResizeObserver(reportBounds);
    if (containerRef.current) observer.observe(containerRef.current);
    // Also observe window resizes (layout shifts without element resize).
    window.addEventListener('resize', reportBounds);
    reportBoundsRef.current = reportBounds;

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
      reportBoundsRef.current = () => {};
      api.invoke('pi:liveview:detach', { slotId }).catch(() => {});
    };
  }, [pluginId, panelId]);

  // A two-column swap moves this slot sideways without resizing it, so the
  // ResizeObserver above stays silent and the native view would be left
  // hovering over the chat. Re-measure in a layout effect: the DOM reorder is
  // committed and the rect is final, but nothing has painted yet.
  useLayoutEffect(() => {
    reportBoundsRef.current();
  }, [swapped, pluginId, panelId, settingsOpen]);

  if (error) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
        data-panel-kind="live-slot-error"
        data-live-slot={`${pluginId}:${panelId}`}
      >
        <MonitorX className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{translate('此面板需要原生视图支持')}</p>
        <p className="text-[11px] text-muted-foreground/70 break-all max-w-full">{error}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-panel-kind="live-slot"
      data-live-slot={`${pluginId}:${panelId}`}
      className="h-full w-full bg-background"
    />
  );
}
