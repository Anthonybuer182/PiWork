import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { PanelRail } from './panel-rail';
import { PanelBody, PaneView } from './panel-slot';
import { PanelWelcome } from './panel-welcome';
import {
  usePanelStore,
  panelIdOfTab,
  type PanelEntry,
  type PanelRegion,
} from '@/stores/panel-store';
import { useOsFileDropTarget } from '@/lib/os-drop';
import { openDroppedPaths } from '@/lib/open-dropped';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export { PanelRail };

/**
 * The panel work area: panes only.
 *
 * The tab strip lives in the header band (PanelTabs): one flat strip when the
 * column is not split, one bar per editor group when it is. Tabs carry their
 * own split/close buttons there — there is no context menu, so this component
 * never has to draw a menu row above a native view.
 */
export function PanelHost({
  region = 'right',
  rail = region === 'left',
  railFooter,
}: {
  region?: PanelRegion;
  rail?: boolean;
  /** Host actions pinned to the bottom of this region's rail. */
  railFooter?: ReactNode;
}) {
  const { t } = useI18n();
  const panels = usePanelStore((s) => s.panels);
  const openIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeId = usePanelStore((s) => s.focusedId[region]);
  const mountedIds = usePanelStore((s) => s.mountedIds);
  const groups = usePanelStore((s) => s.splitGroups[region]);
  const setGroupWeights = usePanelStore((s) => s.setGroupWeights);
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [resizing, setResizing] = useState(false);

  // The right body's DOM fallback (the welcome grid, and any gap not covered
  // by a native view). Open tab bodies are WebContentsViews — their drops are
  // forwarded by the plugin-view preload over `pi:os:dropped-files`.
  const { active: osDropActive, handlers: osDropHandlers } = useOsFileDropTarget((paths) => {
    void openDroppedPaths(paths);
  });

  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
  const open = useMemo(
    () =>
      openIds
        .map((key) => {
          const panel = byId.get(panelIdOfTab(key));
          return panel ? { key, panel } : null;
        })
        .filter((entry): entry is { key: string; panel: PanelEntry } => Boolean(entry)),
    [openIds, byId],
  );
  const mounted = useMemo(() => new Set(mountedIds), [mountedIds]);

  // ── LEFT region: single-view rail + active pane ──
  if (region === 'left') {
    const activeEntry = activeId ? byId.get(activeId) : undefined;
    return (
      <div className="flex h-full w-full">
        {rail && <PanelRail region={region} railFooter={railFooter} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {activeEntry && (
            <div data-panel-container={activeEntry.id} className="flex min-h-0 flex-1 flex-col">
              <PanelBody panel={activeEntry} tabKey={activeEntry.id} active />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Split: one editor group per column ──
  if (groups.length >= 2) {
    const weights = groups.map((g) =>
      Number.isFinite(g.weight) && g.weight > 0 ? g.weight : 1,
    );
    const paneKeys = new Set(groups.flatMap((g) => g.tabs));

    const startDividerDrag = (e: ReactPointerEvent, index: number) => {
      e.preventDefault();
      const container = splitRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      draggingRef.current = true;
      setResizing(true);
      const startX = e.clientX;
      const initial = weights.slice();
      const total = initial.reduce((sum, w) => sum + w, 0);
      const pair = initial[index] + initial[index + 1];
      const min = Math.max(total * 0.08, 0.05);
      const move = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const delta = ((ev.clientX - startX) / rect.width) * total;
        const left = Math.min(pair - min, Math.max(min, initial[index] + delta));
        const next = [...initial];
        next[index] = left;
        next[index + 1] = pair - left;
        setGroupWeights(region, next);
      };
      const up = () => {
        draggingRef.current = false;
        setResizing(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('blur', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('blur', up);
    };

    return (
      <div
        ref={splitRef}
        className="relative flex h-full w-full"
        data-panel-slots={region}
        data-panel-split="true"
        {...osDropHandlers}
      >
        {osDropActive && (
          <div className="pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-background/80">
            <span className="px-3 text-xs font-medium text-foreground">
              {t('松开以在右栏打开')}
            </span>
          </div>
        )}
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('拖动调整分屏比例')}
                data-panel-splitter={region}
                onPointerDown={(e) => startDividerDrag(e, index - 1)}
                className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-border/60 transition-colors hover:bg-primary/50"
              >
                <span className="pointer-events-none h-8 w-px bg-muted-foreground/40 group-hover:bg-primary-foreground/60" />
              </div>
            )}
            <div
              data-panel-pane={index === 0 ? 'left' : index === groups.length - 1 ? 'right' : `middle-${index}`}
              className="flex min-h-0 min-w-0 flex-col"
              style={{ flexGrow: weights[index], flexBasis: 0 }}
            >
              <div className="relative min-h-0 flex-1">
                {group.tabs.map((key) => {
                  const entry = byId.get(panelIdOfTab(key));
                  if (!entry) return null;
                  const active = group.active === key;
                  if (!active && !mounted.has(key)) return null;
                  // MUST be a full-height flex column: PaneView grows via
                  // flex-1, and the native view measures this slot. A plain
                  // block wrapper leaves it at height 0 (blank panes).
                  return (
                    <div
                      key={key}
                      className={cn(
                        'flex h-full w-full min-h-0 flex-col',
                        !active && 'hidden',
                      )}
                    >
                      <PaneView
                        panel={entry}
                        tabKey={key}
                        active={activeId === key}
                        hidden={!active}
                        visible={!resizing}
                      />
                    </div>
                  );
                })}
                {group.tabs.length === 0 && (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t('点击 + 在此栏打开标签')}
                  </div>
                )}
              </div>
            </div>
          </Fragment>
        ))}
        {/* Any tab that is not in a group stays mounted but off-layout. */}
        {open
          .filter(({ key }) => !paneKeys.has(key) && mounted.has(key))
          .map(({ key, panel }) => (
            <PaneView key={key} panel={panel} tabKey={key} active={false} hidden />
          ))}
      </div>
    );
  }

  // ── No split: the single tab bed ──
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="relative flex min-h-0 flex-1"
        data-panel-slots={region}
        {...osDropHandlers}
      >
        {osDropActive && (
          <div className="pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-background/80">
            <span className="px-3 text-xs font-medium text-foreground">
              {t('松开以在右栏打开')}
            </span>
          </div>
        )}
        {open.length === 0 ? (
          <PanelWelcome region={region} />
        ) : (
          open.map(({ key, panel }) => {
            const active = activeId === key;
            if (!active && !mounted.has(key)) return null;
            return <PaneView key={key} panel={panel} tabKey={key} active={active} hidden={!active} />;
          })
        )}
      </div>
    </div>
  );
}
