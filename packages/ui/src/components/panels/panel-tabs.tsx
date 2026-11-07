import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { Check, Plus, Search, SquareSplitHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isOsFileDrag, useOsFileDropTarget, type OsFileDropHandlers } from '@/lib/os-drop';
import { openDroppedPaths } from '@/lib/open-dropped';
import {
  usePanelStore,
  panelIdOfTab,
  instanceIdOfTab,
  type EditorGroup,
  type PanelEntry,
  type PanelRegion,
} from '@/stores/panel-store';
import { freezeSlots, clearFreeze } from '@/stores/overlay-freeze-store';
import { useI18n } from '@/i18n';
import { panelTitle } from './panel-title';
import { RailIcon } from './panel-rail';
import { installedPanels } from './panel-order';
import { NO_DRAG } from '@/components/layout/title-bar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * The tab strip for the right column, in the header band (the title bar).
 *
 * Single view: one flat strip. Split view: the strip is partitioned into
 * editor groups — one bar per pane, sized by the same weights the body panes
 * use, so every bar sits above its column and the body's splitters continue
 * straight up through the band.
 *
 * Every tab has a split button (shown on hover; always visible on the active
 * tab) and every bar has a `+` that opens the plugin picker for that group.
 * There is deliberately no context menu: a popup would either be covered by
 * the native view or force the pane to be hidden.
 */
export function PanelTabs({ region = 'right' }: { region?: PanelRegion }) {
  const { t } = useI18n();
  const panels = usePanelStore((s) => s.panels);
  const openIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeId = usePanelStore((s) => s.focusedId[region]);
  const panelOrder = usePanelStore((s) => s.panelOrder);
  const runtime = usePanelStore((s) => s.runtime);
  const tabTitles = usePanelStore((s) => s.tabTitles);
  const groups = usePanelStore((s) => s.splitGroups[region]);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closeTab = usePanelStore((s) => s.closeTab);
  const splitTab = usePanelStore((s) => s.splitTab);
  const setFocused = usePanelStore((s) => s.setFocused);
  const setTabOrder = usePanelStore((s) => s.setTabOrder);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Invalidate a freeze/menu-open pair whose menu was closed while the
  // snapshot was still being captured.
  const openSeq = useRef(0);

  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);

  /**
   * The native slot behind a tab, or null for host panels (plain DOM, no
   * native view to freeze) and for tabs whose panel is gone.
   */
  const slotIdForTab = (key: string | null | undefined): string | null => {
    if (!key) return null;
    const entry = byId.get(panelIdOfTab(key));
    if (!entry?.pluginId || !entry.panelId) return null;
    const instanceId = instanceIdOfTab(key);
    return instanceId
      ? `${entry.pluginId}:${entry.panelId}:${instanceId}`
      : `${entry.pluginId}:${entry.panelId}`;
  };

  /**
   * Freeze the panes a menu is about to float over, so nothing goes blank.
   * Every visible pane of the column is frozen, not only the menu's anchor
   * pane: the popover is wider than a split column and may cross into its
   * neighbour.
   */
  const freezeForTabs = async (keys: readonly (string | null | undefined)[]): Promise<void> => {
    const slotIds = keys.map(slotIdForTab).filter((slotId): slotId is string => Boolean(slotId));
    if (slotIds.length > 0) await freezeSlots(slotIds);
  };

  // Never leave a pane frozen if this strip goes away (mode switch, window
  // close) while one of its menus is open.
  useEffect(
    () => () => {
      openSeq.current++;
      clearFreeze();
    },
    [],
  );
  const tabs = useMemo(
    () =>
      openIds
        .map((key) => {
          const panel = byId.get(panelIdOfTab(key));
          return panel ? { key, panel } : null;
        })
        .filter((entry): entry is { key: string; panel: PanelEntry } => Boolean(entry)),
    [openIds, byId],
  );
  const pickerItems = useMemo(
    () => installedPanels(panels, panelOrder, region),
    [panels, panelOrder, region],
  );

  // Cmd/Ctrl+\ on the single view creates the first editor group pair. Once
  // split, each group's own bar handles tab actions.
  useEffect(() => {
    if (region !== 'right') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '\\' && e.code !== 'Backslash') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        typeof target.closest === 'function' &&
        target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      if (!activeId) return;
      e.preventDefault();
      splitTab('right', activeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [region, activeId, splitTab]);

  // OS file drops on the header strip (the body has its own targets).
  const { active: osDropActive, handlers: osDropHandlers } = useOsFileDropTarget((paths) => {
    void openDroppedPaths(paths);
  });

  const endDrag = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  // Split mode: one bar per editor group, still in the header band.
  if (groups.length >= 2) {
    return (
      <SplitTabHeader
        region={region}
        groups={groups}
        byId={byId}
        tabTitles={tabTitles}
        activeId={activeId}
        openIds={openIds}
        pickerItems={pickerItems}
        freezeForTabs={freezeForTabs}
        osDropActive={osDropActive}
        osDropHandlers={osDropHandlers}
      />
    );
  }

  // The picker opens only after its pane is frozen: the popover then floats
  // over an image of the pane instead of a blank hole.
  const openPicker = async () => {
    const seq = ++openSeq.current;
    await freezeForTabs([activeId]);
    if (seq !== openSeq.current) return;
    setPickerOpen(true);
  };
  const closePicker = () => {
    openSeq.current++;
    setPickerOpen(false);
    clearFreeze();
  };

  const picker = (
    <Popover
      open={pickerOpen}
      onOpenChange={(open) => {
        if (open) void openPicker();
        else closePicker();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('打开插件')}
          title={t('打开插件')}
          data-panel-picker-trigger={region}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0"
        data-panel-picker={region}
      >
        <PluginPickerList items={pickerItems} openIds={openIds} onPick={openPickerItem} />
      </PopoverContent>
    </Popover>
  );

  function openPickerItem(id: string) {
    openPanel(id, { focus: true });
    closePicker();
  }

  return (
    <div
      className={cn(
        'flex h-full w-full min-w-0 select-none items-center gap-1 rounded-md px-1.5 transition-colors',
        osDropActive && 'bg-primary/5 ring-1 ring-primary/40',
      )}
      // NOT opted out as a whole: the empty stretch after the tabs must keep
      // dragging the window, which is the macOS title-bar contract (see
      // globals.css). Only the tab row itself opts out — that is where OS
      // file drops land, and `-webkit-app-region: drag` swallows drop events.
      role="toolbar"
      aria-label={t('插件标签')}
      data-testid={`panel-tabs-${region}`}
      {...osDropHandlers}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div
            role="tablist"
            aria-label={t('已打开的标签')}
            // Contiguous drop target: the gaps between tabs are drop area too.
            // Individual tabs already opt out via the global rule; this covers
            // the padding around them.
            style={NO_DRAG}
            className="flex shrink-0 items-center gap-1"
          >
            {tabs.map(({ key, panel }) => {
              const title = tabTitles[key] ?? panelTitle(panel, t);
              return (
                <TabPill
                  key={key}
                  tabKey={key}
                  panel={panel}
                  title={title}
                  active={activeId === key}
                  badge={runtime[panel.id]?.badge}
                  pending={runtime[panel.id]?.pending}
                  onClick={() => setFocused(region, key)}
                  onClose={() => closeTab(region, key)}
                  onSplit={() => splitTab(region, key)}
                  onDragStart={(e) => {
                    setDragId(key);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', key);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTargetId(key);
                  }}
                  onDrop={(e) => {
                    if (isOsFileDrag(e.dataTransfer)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const from = e.dataTransfer.getData('text/plain');
                    if (from && from !== key) {
                      const keys = tabs.map((p) => p.key).filter((x) => x !== from);
                      const at = keys.indexOf(key);
                      if (at === -1) keys.push(from);
                      else keys.splice(at, 0, from);
                      setTabOrder(region, keys);
                    }
                    endDrag();
                  }}
                  onDragEnd={endDrag}
                  dropTarget={dropTargetId === key && dragId !== null && dragId !== key}
                  dimmed={dragId === key}
                />
              );
            })}
          </div>
        </div>
        {picker}
      </div>
    </div>
  );
}

/**
 * Split mode's header strip: one tab bar per editor group.
 *
 * The segment widths come from the same `weight`s the body panes use, and the
 * 6px spacers mirror the body's splitters, so every bar is aligned with the
 * column under it. The host segment reserves the layout toggles as padding —
 * `marginRight` pulls that reservation back and each bar leaves the toggles
 * zone free on its right, so the alignment survives.
 */
function SplitTabHeader({
  region,
  groups,
  byId,
  tabTitles,
  activeId,
  openIds,
  pickerItems,
  freezeForTabs,
  osDropActive,
  osDropHandlers,
}: {
  region: PanelRegion;
  groups: EditorGroup[];
  byId: Map<string, PanelEntry>;
  tabTitles: Record<string, string>;
  activeId: string | null;
  openIds: string[];
  pickerItems: PanelEntry[];
  freezeForTabs: (keys: readonly (string | null | undefined)[]) => Promise<void>;
  osDropActive: boolean;
  osDropHandlers: OsFileDropHandlers;
}) {
  const { t } = useI18n();
  const runtime = usePanelStore((s) => s.runtime);
  const setFocused = usePanelStore((s) => s.setFocused);
  const closeTab = usePanelStore((s) => s.closeTab);
  const splitTab = usePanelStore((s) => s.splitTab);
  const addTabToGroup = usePanelStore((s) => s.addTabToGroup);
  const moveTabBetweenGroups = usePanelStore((s) => s.moveTabBetweenGroups);
  const [pickerGroup, setPickerGroup] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const openSeq = useRef(0);

  const openGroupPicker = async (group: EditorGroup) => {
    const seq = ++openSeq.current;
    // Freeze every visible pane of the column: the popover may overlap more
    // than the group it was opened from.
    await freezeForTabs(groups.map((g) => g.active ?? g.tabs[0]));
    if (seq !== openSeq.current) return;
    setPickerGroup(group.id);
  };
  const closeGroupPicker = () => {
    openSeq.current++;
    setPickerGroup(null);
    clearFreeze();
  };

  useEffect(
    () => () => {
      openSeq.current++;
      clearFreeze();
    },
    [],
  );

  return (
    <div
      className={cn(
        'flex h-full w-full min-w-0 select-none items-stretch transition-colors',
        osDropActive && 'bg-primary/5 ring-1 ring-primary/40',
      )}
      role="toolbar"
      aria-label={t('插件标签')}
      data-testid={`panel-tabs-${region}`}
      // The layout reserves the toggles zone as padding-right on this
      // segment. Grow into it and pull the margin back so the group segments
      // divide the same width the body panes do; each bar re-reserves the
      // zone below.
      style={{
        width: 'calc(100% + var(--header-trailing-width, 0px))',
        marginRight: 'calc(-1 * var(--header-trailing-width, 0px))',
      }}
      {...osDropHandlers}
    >
      {groups.map((group, index) => {
        const weight = Number.isFinite(group.weight) && group.weight > 0 ? group.weight : 1;
        const dropMove = (e: ReactDragEvent, beforeKey?: string) => {
          if (isOsFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          const from = e.dataTransfer.getData('text/plain');
          if (from && from !== beforeKey) moveTabBetweenGroups(region, from, group.id, beforeKey);
          setDropTarget(null);
        };
        return (
          <Fragment key={group.id}>
            {index > 0 && <div className="w-1.5 shrink-0" aria-hidden />}
            <div
              className="flex h-full min-w-0 items-center"
              data-group-tabs={group.id}
              style={{ flexGrow: weight, flexBasis: 0 }}
            >
              {/* Reserve the toggles zone on the rightmost bar. It has to sit
                  inside the segment: padding on the flex item itself would
                  widen its share and shift the bar off its pane. */}
              <div
                className="flex h-full min-w-0 flex-1 items-center gap-1 px-1"
                style={
                  index === groups.length - 1
                    ? { paddingRight: 'var(--header-trailing-width, 0px)' }
                    : undefined
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget(group.id);
                }}
                onDragLeave={() =>
                  setDropTarget((current) => (current === group.id ? null : current))
                }
                onDrop={(e) => dropMove(e)}
              >
                <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <div
                    role="tablist"
                    aria-label={t('窗格标签')}
                    // Same contract as the single strip: the tabs (and the gaps
                    // between them) are the drop target, so they opt out of the
                    // window drag region.
                    style={NO_DRAG}
                    className="flex shrink-0 items-center gap-1"
                  >
                    {group.tabs.map((key) => {
                      const panel = byId.get(panelIdOfTab(key));
                      if (!panel) return null;
                      const title = tabTitles[key] ?? panelTitle(panel, t);
                      return (
                        <TabPill
                          key={key}
                          tabKey={key}
                          groupId={group.id}
                          panel={panel}
                          title={title}
                          active={group.active === key}
                          focused={activeId === key}
                          badge={runtime[panel.id]?.badge}
                          pending={runtime[panel.id]?.pending}
                          onClick={() => setFocused(region, key)}
                          onClose={() => closeTab(region, key)}
                          onSplit={() => splitTab(region, key)}
                          onDragStart={(e) => {
                            setDragId(key);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', key);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDropTarget(key);
                          }}
                          onDragLeave={() =>
                            setDropTarget((current) => (current === key ? null : current))
                          }
                          onDrop={(e) => dropMove(e, key)}
                          onDragEnd={() => {
                            setDragId(null);
                            setDropTarget(null);
                          }}
                          dropTarget={dropTarget === key && dragId !== null && dragId !== key}
                          dimmed={dragId === key}
                        />
                      );
                    })}
                  </div>
                </div>
                <Popover
                  open={pickerGroup === group.id}
                  onOpenChange={(open) => {
                    if (open) void openGroupPicker(group);
                    else closeGroupPicker();
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('打开插件')}
                      title={t('打开插件')}
                      data-group-add={group.id}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    className="w-80 p-0"
                    data-panel-picker={region}
                  >
                    <PluginPickerList
                      items={pickerItems}
                      openIds={openIds}
                      onPick={(id) => {
                        addTabToGroup(region, group.id, id);
                        closeGroupPicker();
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * One tab pill, shared by the single strip and every split group's bar so the
 * two states cannot drift apart visually or in keyboard behaviour.
 *
 * Actions, left to right: split right (`⧉`), close (`×`). Both are hidden on
 * inactive tabs until hover; the active tab shows them at reduced opacity so
 * the actions are discoverable.
 */
function TabPill({
  tabKey,
  groupId,
  panel,
  title,
  active,
  focused,
  badge,
  pending,
  onClick,
  onClose,
  onSplit,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  dropTarget,
  dimmed,
}: {
  tabKey: string;
  groupId?: string;
  panel: PanelEntry;
  title: string;
  active: boolean;
  focused?: boolean;
  badge?: string | number;
  pending?: boolean;
  onClick: () => void;
  onClose: () => void;
  onSplit: () => void;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave?: () => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  dropTarget: boolean;
  dimmed: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={title}
      data-panel-tab={tabKey}
      data-group-tab={groupId}
      data-state={active ? 'active' : 'inactive'}
      draggable
      onClick={onClick}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onClose();
        }
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        'group/tab relative flex h-8 max-w-[176px] shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground/80',
        focused && 'ring-1 ring-ring/40',
        dropTarget && 'ring-1 ring-muted-foreground/40',
        dimmed && 'opacity-50',
      )}
    >
      <RailIcon panel={panel} size={16} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
      {badge !== undefined && badge !== null && badge !== '' && (
        <span className="min-w-[16px] shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground">
          {badge}
        </span>
      )}
      {pending && !badge && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      )}
      <button
        type="button"
        aria-label={t('向右拆分')}
        title={t('向右拆分')}
        data-panel-tab-split={tabKey}
        onClick={(e) => {
          e.stopPropagation();
          onSplit();
        }}
        className={cn(
          'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15 focus-visible:opacity-100',
          active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70',
        )}
      >
        <SquareSplitHorizontal className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('关闭 {title}', { title })}
        data-panel-tab-close={tabKey}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15 focus-visible:opacity-100',
          active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70',
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * The `+` popover: a search box over the installed panels, in installed order.
 * Picking a row opens its tab (the store activates an already-open panel
 * instead of duplicating it). Keyboard: arrows move, Enter opens, Esc closes.
 */
function PluginPickerList({
  items,
  openIds,
  onPick,
}: {
  items: PanelEntry[];
  openIds: string[];
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter((panel) =>
      [panelTitle(panel, t), panel.title, panel.id, panel.pluginId, panel.source].some((text) =>
        (text ?? '').toLowerCase().includes(q),
      ),
    );
  }, [items, q, t]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [q]);

  return (
    <div className="flex flex-col" data-plugin-picker>
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('搜索插件…')}
          aria-label={t('搜索插件')}
          className="h-10 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const panel = filtered[activeIndex];
              if (panel) onPick(panel.id);
            }
          }}
        />
      </div>
      <div className="max-h-80 overflow-y-auto p-1" role="listbox" aria-label={t('已安装的插件')}>
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('没有匹配的插件')}
          </div>
        ) : (
          filtered.map((panel, index) => {
            const title = panelTitle(panel, t);
            const open = openIds.some((key) => panelIdOfTab(key) === panel.id);
            return (
              <button
                key={panel.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onPick(panel.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                  index === activeIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/60',
                )}
              >
                <RailIcon panel={panel} size={16} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {open && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
