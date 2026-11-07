import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Plus, X } from 'lucide-react';
import { PanelRail, RailIcon } from './panel-rail';
import { PanelBody, PaneView } from './panel-slot';
import { PanelWelcome } from './panel-welcome';
import { installedPanels } from './panel-order';
import { panelTitle } from './panel-title';
import {
  usePanelStore,
  panelIdOfTab,
  type EditorGroup,
  type PanelEntry,
  type PanelRegion,
} from '@/stores/panel-store';
import { useOsFileDropTarget } from '@/lib/os-drop';
import { openDroppedPaths } from '@/lib/open-dropped';
import { useI18n } from '@/i18n';
import { useTabMenuStore } from '@/stores/tab-menu-store';
import { cn } from '@/lib/utils';

export { PanelRail };

/**
 * The panel work area.
 *
 * No split: the right column is a single tab bed — the top strip carries the
 * tabs, exactly as before.
 *
 * Split: every pane is an EDITOR GROUP with its own tab bar, its own active
 * tab and its own `+`. The tab bars live inside the panes (above the native
 * view), so the header's window controls never cover them. Opening a file or
 * adding a tab changes only that group; the other groups are untouched.
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
  const panelOrder = usePanelStore((s) => s.panelOrder);
  const openIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeId = usePanelStore((s) => s.focusedId[region]);
  const mountedIds = usePanelStore((s) => s.mountedIds);
  const groups = usePanelStore((s) => s.splitGroups[region]);
  const tabTitles = usePanelStore((s) => s.tabTitles);
  const setFocused = usePanelStore((s) => s.setFocused);
  const closeTab = usePanelStore((s) => s.closeTab);
  const splitTab = usePanelStore((s) => s.splitTab);
  const addTabToGroup = usePanelStore((s) => s.addTabToGroup);
  const moveTabBetweenGroups = usePanelStore((s) => s.moveTabBetweenGroups);
  const unsplitTab = usePanelStore((s) => s.unsplitTab);
  const setGroupWeights = usePanelStore((s) => s.setGroupWeights);
  const tabMenuTarget = useTabMenuStore((s) => s.target);
  const closeTabMenu = useTabMenuStore((s) => s.close);
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
  const pickerItems = useMemo(
    () =>
      installedPanels(panels, panelOrder, region).filter(
        (panel) => panel.multiInstance && !panel.hidden,
      ),
    [panels, panelOrder, region],
  );

  const tabMenuKey =
    tabMenuTarget && tabMenuTarget.region === region ? tabMenuTarget.key : null;
  const tabMenuPanel = tabMenuKey ? byId.get(panelIdOfTab(tabMenuKey)) : undefined;

  useEffect(() => {
    if (!tabMenuKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTabMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabMenuKey, closeTabMenu]);

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
              <GroupTabBar
                group={group}
                region={region}
                pickerItems={pickerItems}
                tabTitles={tabTitles}
                activeId={activeId}
                byId={byId}
                onSelect={(key) => setFocused(region, key)}
                onClose={(key) => closeTab(region, key)}
                onSplit={(key) => splitTab(region, key)}
                onAdd={(panelId) => addTabToGroup(region, group.id, panelId)}
                onUnsplit={() => unsplitTab(region, group.active ?? group.tabs[0] ?? '')}
                onMove={(key, beforeKey) =>
                  moveTabBetweenGroups(region, key, group.id, beforeKey)
                }
              />
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
      {tabMenuKey && tabMenuPanel && (
        <div
          className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="menu"
          data-tab-inline-menu
        >
          {tabMenuPanel.multiInstance && (
            <button
              type="button"
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
              onClick={() => {
                splitTab(region, tabMenuKey);
                closeTabMenu();
              }}
            >
              {t('向右拆分')}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
            onClick={() => {
              closeTab(region, tabMenuKey);
              closeTabMenu();
            }}
          >
            {t('关闭')}
          </button>
          <button
            type="button"
            className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
            onClick={() => {
              for (const key of [...openIds]) {
                if (key !== tabMenuKey) closeTab(region, key);
              }
              closeTabMenu();
            }}
          >
            {t('关闭其他')}
          </button>
          <button
            type="button"
            aria-label={t('关闭')}
            className="ml-auto shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
            onClick={closeTabMenu}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
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

/**
 * One editor group's tab bar.
 *
 * Lives INSIDE the pane, above the native view, so it gets the group's full
 * width and the window's header toggles cannot cover it. Every tab belongs to
 * this group; clicking one changes only this group's active tab.
 */
function GroupTabBar({
  group,
  region,
  pickerItems,
  tabTitles,
  activeId,
  byId,
  onSelect,
  onClose,
  onSplit,
  onAdd,
  onUnsplit,
  onMove,
}: {
  group: EditorGroup;
  region: PanelRegion;
  pickerItems: PanelEntry[];
  tabTitles: Record<string, string>;
  activeId: string | null;
  byId: Map<string, PanelEntry>;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onSplit: (key: string) => void;
  onAdd: (panelId: string) => void;
  onUnsplit: () => void;
  onMove: (key: string, beforeKey?: string) => void;
}) {
  const { t } = useI18n();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    { type: 'tab'; key: string } | { type: 'bar' } | null
  >(null);

  // `+` adds a tab immediately: a new tab of the group's active panel type
  // (viewer column → viewer tab, browser column → browser tab). It never
  // opens a menu, so it cannot blank the pane or depend on a popup.
  const addTab = () => {
    if (pickerItems.length === 0) return;
    const activePanelId = group.active ? panelIdOfTab(group.active) : null;
    const preferred =
      pickerItems.find((panel) => panel.id === activePanelId) ?? pickerItems[0];
    if (preferred) onAdd(preferred.id);
  };

  const menuPanel =
    menu?.type === 'tab' ? byId.get(panelIdOfTab(menu.key)) : undefined;

  const onDrop = (e: ReactDragEvent, beforeKey?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const from = e.dataTransfer.getData('text/plain');
    if (from && from !== beforeKey) onMove(from, beforeKey);
    setDropTarget(null);
  };

  return (
    <div className="flex shrink-0 flex-col">
      <div
        className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label={t('窗格标签')}
        data-group-tabs={group.id}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(group.id);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => onDrop(e)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ type: 'bar' });
        }}
      >
      {group.tabs.map((key) => {
        const panel = byId.get(panelIdOfTab(key));
        if (!panel) return null;
        const title = tabTitles[key] ?? panelTitle(panel, t);
        const active = group.active === key;
        const focused = activeId === key;
        return (
          <div
            key={key}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            title={title}
            data-panel-tab={key}
            data-group-tab={group.id}
            data-state={active ? 'active' : 'inactive'}
            draggable
            onClick={() => onSelect(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(key);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                onClose(key);
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(key);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ type: 'tab', key });
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', key);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(key);
            }}
            onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
            onDrop={(e) => onDrop(e, key)}
            className={cn(
              'group/tab flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground/80',
              focused && 'ring-1 ring-ring/40',
              dropTarget === key && 'bg-accent/70',
            )}
          >
            <RailIcon panel={panel} size={14} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
            <button
              type="button"
              aria-label={t('关闭 {title}', { title })}
              data-panel-tab-close={key}
              onClick={(e) => {
                e.stopPropagation();
                onClose(key);
              }}
              className="shrink-0 rounded-sm p-0.5 opacity-60 hover:bg-accent-foreground/15 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label={t('在此栏打开新标签')}
        title={t('在此栏打开新标签')}
        data-group-add={group.id}
        onClick={addTab}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      </div>
      {menu && (
        <div
          className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="menu"
          data-tab-inline-menu
        >
          {menu.type === 'tab' && menuPanel && (
            <>
              {menuPanel.multiInstance && (
                <button
                  type="button"
                  className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
                  onClick={() => {
                    onSplit(menu.key);
                    setMenu(null);
                  }}
                >
                  {t('向右拆分')}
                </button>
              )}
              <button
                type="button"
                className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
                onClick={() => {
                  onClose(menu.key);
                  setMenu(null);
                }}
              >
                {t('关闭')}
              </button>
              <button
                type="button"
                className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
                onClick={() => {
                  for (const other of group.tabs) {
                    if (other !== menu.key) onClose(other);
                  }
                  setMenu(null);
                }}
              >
                {t('关闭其他')}
              </button>
              <button
                type="button"
                className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
                onClick={() => {
                  for (const other of [...group.tabs]) onClose(other);
                  setMenu(null);
                }}
              >
                {t('关闭该栏')}
              </button>
            </>
          )}
          {menu.type === 'bar' && (
            <button
              type="button"
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] hover:bg-accent"
              onClick={() => {
                onUnsplit();
                setMenu(null);
              }}
            >
              {t('取消拆分')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('关闭')}
            className="ml-auto shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
            onClick={() => setMenu(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
