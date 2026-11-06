import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isOsFileDrag, useOsFileDropTarget } from '@/lib/os-drop';
import { openDroppedPaths } from '@/lib/open-dropped';
import { usePanelStore, panelIdOfTab, type PanelEntry, type PanelRegion } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/i18n';
import { panelTitle } from './panel-title';
import { RailIcon } from './panel-rail';
import { installedPanels } from './panel-order';
import { NO_DRAG } from '@/components/layout/title-bar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * The right column's tab strip (2026-11 redesign).
 *
 * It is a TAB strip, not a plugin switcher: only open panels appear here, plus
 * a trailing `+` that opens the searchable plugin picker. Discovery of panels
 * that are not open lives in two places instead — the no-tabs welcome grid in
 * the body and this picker.
 *
 *  - click a tab → activate it;
 *  - `×` → close it (active falls to the next tab, then the previous);
 *  - drag a tab onto another → reorder the strip;
 *  - `+` → searchable list of installed panels; picking one opens (or, for a
 *    panel that is already open, activates) its tab.
 *
 * The old `⋯` overflow button is gone: the strip scrolls horizontally and `+`
 * stays pinned at its end. There is also no zoom button — hiding the left and
 * centre columns already gives the panel the whole window.
 */
export function PanelTabs({ region = 'right' }: { region?: PanelRegion }) {
  const { t } = useI18n();
  const panels = usePanelStore((s) => s.panels);
  const openIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeId = usePanelStore((s) => s.focusedId[region]);
  const panelOrder = usePanelStore((s) => s.panelOrder);
  const runtime = usePanelStore((s) => s.runtime);
  const tabTitles = usePanelStore((s) => s.tabTitles);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closeTab = usePanelStore((s) => s.closeTab);
  const setFocused = usePanelStore((s) => s.setFocused);
  const setTabOrder = usePanelStore((s) => s.setTabOrder);
  const setPanelPickerOpen = useUIStore((s) => s.setPanelPickerOpen);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Native panel views sit above the DOM; the picker is a DOM popover that
  // extends below the header band, so the views must be silenced while it is
  // open or they would paint over it and swallow the search field's clicks.
  useEffect(() => {
    setPanelPickerOpen(pickerOpen);
    return () => setPanelPickerOpen(false);
  }, [pickerOpen, setPanelPickerOpen]);

  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
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

  const endDrag = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  // ── OS file drop: open each dropped file as a panel tab ──
  // The strip is a DOM fallback for the right column: the body of an open tab
  // is a native view, so plugin views forward their own drops (preload →
  // main → `pi:os:dropped-files`). Open order is drop order, so the last
  // dropped file ends up focused.
  const { active: osDropActive, handlers: osDropHandlers } = useOsFileDropTarget((paths) => {
    void openDroppedPaths(paths);
  });

  const pick = (id: string) => {
    openPanel(id, { focus: true });
    setPickerOpen(false);
  };

  const renderTab = ({ key, panel }: { key: string; panel: PanelEntry }) => {
    const title = tabTitles[key] ?? panelTitle(panel, t);
    const active = activeId === key;
    const rt = runtime[panel.id];
    const badge = rt?.badge;
    const pending = rt?.pending;

    return (
      <div
        key={key}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        title={title}
        data-panel-tab={key}
        data-panel-id={panel.id}
        data-state={active ? 'active' : 'inactive'}
        draggable
        onClick={() => setFocused(region, key)}
        onAuxClick={(e) => {
          // Middle-click closes, as in every tabbed editor.
          if (e.button === 1) {
            e.preventDefault();
            closeTab(region, key);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setFocused(region, key);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            closeTab(region, key);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const i = tabs.findIndex((p) => p.key === key);
            const next = tabs[i + (e.key === 'ArrowLeft' ? -1 : 1)];
            if (next) {
              const el = document.querySelector(
                `[data-panel-tab="${CSS.escape(next.key)}"]`,
              ) as HTMLElement | null;
              el?.focus();
            }
          }
        }}
        onDragStart={(e) => {
          setDragId(key);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses drags without payload; the key doubles as the
          // reorder source so the drop never depends on React state.
          e.dataTransfer.setData('text/plain', key);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTargetId(key);
        }}
        onDrop={(e) => {
          // OS file drops belong to the strip root: letting them bubble keeps
          // the highlight state and open path in one place. This handler's
          // unconditional stopPropagation would otherwise swallow them.
          if (isOsFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          const from = e.dataTransfer.getData('text/plain');
          if (from && from !== key) {
            // `from` re-seats before `key`; the store filters to open tabs.
            const keys = tabs.map((p) => p.key).filter((x) => x !== from);
            const at = keys.indexOf(key);
            if (at === -1) keys.push(from);
            else keys.splice(at, 0, from);
            setTabOrder(region, keys);
          }
          endDrag();
        }}
        onDragEnd={endDrag}
        className={cn(
          'group/tab relative flex h-8 max-w-[176px] shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground/80',
          dropTargetId === key &&
            dragId !== null &&
            dragId !== key &&
            'ring-1 ring-muted-foreground/40',
          dragId === key && 'opacity-50',
        )}
      >
        <RailIcon panel={panel} size={16} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
        {badge !== undefined && badge !== null && badge !== '' && (
          <span
            data-panel-tab-badge={key}
            className="min-w-[16px] shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground"
          >
            {badge}
          </span>
        )}
        {pending && !badge && (
          <span
            data-panel-tab-pending={key}
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
        )}
        <button
          type="button"
          aria-label={t('关闭 {title}', { title })}
          data-panel-tab-close={key}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(region, key);
          }}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15',
            active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const picker = (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
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
        <PluginPickerList items={pickerItems} openIds={openIds} onPick={pick} />
      </PopoverContent>
    </Popover>
  );

  return (
    <div
      className={cn(
        'flex h-full w-full min-w-0 select-none items-center gap-1 rounded-md px-1.5 transition-colors',
        osDropActive && 'bg-primary/5 ring-1 ring-primary/40',
      )}
      // The header band is a window drag region, and `-webkit-app-region: drag`
      // swallows drag events — a drop target inside it would never fire. Opting
      // this strip out costs window dragging over the tab row only; the rest
      // of the header still moves the window.
      style={NO_DRAG}
      role="toolbar"
      aria-label={t('插件标签')}
      data-testid={`panel-tabs-${region}`}
      {...osDropHandlers}
    >
      {/* Tabs and `+` scroll together, with `+` immediately after the last
          tab (not pinned to the strip's right edge). With no tabs it is the
          first thing in the row — the cursor-style empty tab row — and the
          body carries the plugin grid. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label={t('已打开的标签')} className="flex shrink-0 items-center gap-1">
          {tabs.map(renderTab)}
        </div>
        {picker}
      </div>
    </div>
  );
}

/**
 * The `+` popover: a search box over the installed panels, in installed order.
 * Picking a row opens its tab (the store activates an already-open panel
 * instead of duplicating it). Keyboard: arrows move, Enter opens, Esc closes
 * (Radix handles Esc and focus restoration).
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
                data-plugin-picker-item={panel.id}
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
