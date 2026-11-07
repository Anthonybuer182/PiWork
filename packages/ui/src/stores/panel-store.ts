import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { getDesktopLayoutId, getDesktopWindowId } from '@/lib/window-identity';
import type {
  PluginInfo,
  PluginPanelStatus,
  PanelRegion,
  PanelAnchor,
  PanelScope,
} from '@pi/types';

export type PanelKeepAlive = 'always' | 'lru' | 'never';
// Region/anchor/scope belong to the manifest contract (plugins declare them),
// so the definitions live in @pi/types. Re-exported here because most call
// sites import these from the store alongside PanelEntry.
export type { PanelRegion, PanelAnchor, PanelScope };

/**
 * An editor group: one column of the right region when split, with its own
 * tab list, active tab and width.
 */
export interface EditorGroup {
  id: string;
  tabs: string[];
  active: string | null;
  weight: number;
}

const EMPTY_GROUPS: Record<PanelRegion, EditorGroup[]> = { left: [], right: [] };

function newGroupId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function makeGroup(tabs: string[], active: string | null, weight = 1): EditorGroup {
  return { id: newGroupId(), tabs, active, weight };
}

function groupIndexContaining(groups: EditorGroup[], key: string): number {
  return groups.findIndex((g) => g.tabs.includes(key));
}

/** Most recently used tab among `tabs`, else the last one, else null. */
function recentTab(recency: string[], tabs: string[]): string | null {
  return recency.find((k) => tabs.includes(k)) ?? tabs[tabs.length - 1] ?? null;
}

function normalizeWeights(count: number, previous?: readonly number[]): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const w = previous?.[i];
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
  });
}

/** How many conversations keep their panel state when the user moves on. */
const SESSIONS_KEPT = 8;

/**
 * Unified panel entry — host panels and plugin panels share this shape.
 *
 * There is no `kind`. A panel is a panel; what differs is who provides it, and
 * that is exactly what `source` says:
 *   source === 'host'  → a React component in the shell (HOST_COMPONENTS)
 *   source === <pluginId> → a web page, hosted natively by the host
 */
export interface PanelEntry {
  /** 'host:plugins' | 'host:sessions' | 'plugin:<pluginId>:<panelId>' */
  id: string;
  title: string;
  /** Icon key resolved by the rail (see panel-icons.tsx). */
  icon: string;
  /** Plugin-provided icon (pi-plugin:// URL) — takes precedence over `icon`. */
  iconUrl?: string;
  source: 'host' | string; // 'host' or pluginId
  pluginId?: string;
  panelId?: string;
  /** The panel's page, relative to the plugin root. Absent on host panels. */
  entry?: string;
  /** Not shown in the picker/welcome grid; still openable via panel.open / events. */
  hidden?: boolean;
  keepAlive: PanelKeepAlive;
  /** Whether the panel's tabs follow the session. Defaults to 'global'. */
  scope?: PanelScope;
  /** Several host tabs of this panel may be open at once. */
  multiInstance?: boolean;
  /** Which sidebar column this panel renders in. */
  region: PanelRegion;
  /** Position within its region's icon rail (left column only). Defaults to 'top'. */
  anchor?: PanelAnchor;
  /** Sort order among installed panels sharing a region and anchor. */
  order?: number;
}

/**
 * A tab is identified by a KEY in `openPanelIds`, not by a panel entry:
 *
 *   singleton tab   → key === panel entry id (`plugin:com.pi.tasks:items`)
 *   instance tab    → key === `<panel entry id>##<instanceId>`
 *
 * The suffix is what lets one manifest panel have several host tabs (the file
 * viewer, the browser) without inventing panel ids the backend never declared.
 * `panelIdOfTab` / `instanceIdOfTab` are the only places that parse it.
 */
const TAB_INSTANCE_SEP = '##';

/** The panel entry id behind a tab key (singleton keys ARE panel ids). */
export function panelIdOfTab(key: string): string {
  const at = key.indexOf(TAB_INSTANCE_SEP);
  return at === -1 ? key : key.slice(0, at);
}

/** The instance suffix of a multi-instance tab key, or null for a singleton. */
export function instanceIdOfTab(key: string): string | null {
  const at = key.indexOf(TAB_INSTANCE_SEP);
  return at === -1 ? null : key.slice(at + TAB_INSTANCE_SEP.length);
}

export function tabKeyOf(panelId: string, instanceId?: string | null): string {
  return instanceId ? `${panelId}${TAB_INSTANCE_SEP}${instanceId}` : panelId;
}

function newInstanceId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function panelOfKey(byId: Map<string, PanelEntry>, key: string): PanelEntry | undefined {
  return byId.get(panelIdOfTab(key));
}

function isEmptyParams(params: Record<string, unknown> | undefined): boolean {
  return !params || Object.keys(params).length === 0;
}

/**
 * A closed tab will never come back under the same key, so its native view
 * (and renderer process) must be released — `detach` only hides, which is
 * right for a column collapse or a hibernated tab. Best-effort: the web build
 * has no host, and a slot that was never mounted has nothing to release.
 */
function releaseTabView(key: string, panels: PanelEntry[]): void {
  const panel = panels.find((p) => p.id === panelIdOfTab(key));
  if (!panel?.pluginId || !panel.panelId) return;
  const instanceId = instanceIdOfTab(key);
  const slotId = instanceId
    ? `${panel.pluginId}:${panel.panelId}:${instanceId}`
    : `${panel.pluginId}:${panel.panelId}`;
  const api = (
    globalThis as {
      electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }
  ).electronAPI;
  try {
    void api?.invoke?.('pi:liveview:release', { slotId })?.catch?.(() => {});
  } catch {
    /* no host bridge — nothing to release */
  }
}

/**
 * The session-scoped slice of one conversation: which session-scoped tabs
 * were open, which of them was active, their open params (e.g. which file the
 * viewer held) and title overrides. Swapped out of `openPanelIds`/`params` on
 * session switch and back in on re-entry — the right column always shows
 * "global tabs + the current conversation's tabs".
 */
export interface SessionPanelState {
  selected: string[];
  focused: string | null;
  params: Record<string, Record<string, unknown> | undefined>;
  titles?: Record<string, string>;
  /** The conversation's right-column editor groups, if it had a split. */
  splitGroups?: EditorGroup[];
}

export interface PanelRuntimeState {
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  /** Free-form status text pushed by the plugin backend. */
  detail?: string;
  /** Tab opened without focus (no-focus-steal) — the tab strip shows a dot. */
  pending?: boolean;
}

/**
 * Panels kept mounted (hidden) when inactive — 'lru' keeps this many.
 *
 * The budget is global across regions, so a panel that must never be evicted
 * (every left-sidebar view) has to declare `keepAlive: 'always'`, not 'lru'.
 */
const LRU_KEEP = 2;

/**
 * Open tabs mounted per region, on top of the active one. A tab is a promise
 * that switching back restores state, so open tabs mount unconditionally up to
 * this cap; the coldest past it hibernate. Each mounted plugin panel is a
 * renderer process (plus possibly a browser engine view), which is why the cap
 * exists at all. Browser/viewer multi-tab will need a larger budget in a later
 * phase.
 */
const TAB_MOUNT_CAP = 6;

const EMPTY_FOCUSED: Record<PanelRegion, string | null> = { left: null, right: null };
const EMPTY_TABS: Record<PanelRegion, string[]> = { left: [], right: [] };

function regionPanels(panels: PanelEntry[], region: PanelRegion): PanelEntry[] {
  return panels
    .filter((p) => p.region === region)
    .sort((a, b) => {
      const aBottom = a.anchor === 'bottom' ? 1 : 0;
      const bBottom = b.anchor === 'bottom' ? 1 : 0;
      if (aBottom !== bBottom) return aBottom - bBottom;
      return (a.order ?? 0) - (b.order ?? 0);
    });
}

/**
 * The panel the LEFT column falls back to when nothing is selected. The right
 * column deliberately has no fallback: its body shows the installed-plugin
 * grid, and an empty tab strip is the honest "nothing is open yet".
 */
function defaultActiveFor(panels: PanelEntry[], region: PanelRegion): string | null {
  return regionPanels(panels, region)[0]?.id ?? null;
}

function computeMounted(
  panels: PanelEntry[],
  focusedIds: Record<PanelRegion, string | null>,
  openPanelIds: Record<PanelRegion, string[]>,
  recency: string[],
  splitGroups: Record<PanelRegion, EditorGroup[]>,
): string[] {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const mounted = new Set<string>();
  for (const key of Object.values(focusedIds)) {
    if (key && panelOfKey(byId, key)) mounted.add(key);
  }

  // Every visible column shows its active tab; mount all of them even when
  // they never entered recency.
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const groups = splitGroups[region];
    if (groups.length < 2) continue;
    for (const group of groups) {
      if (group.active) mounted.add(group.active);
    }
  }

  // 'always' means always: mount them whether or not they are open and
  // whether or not they were ever activated. Going through `recency` alone was
  // wrong — a panel first activated by `reconcile` (not `openPanel`) never
  // enters recency, so switching away from it unmounted it and lost its state
  // (expanded folders, list scroll). recency is also capped, so even an
  // activated 'always' panel could eventually fall out of it.
  //
  // A singleton's key IS its panel id. A multi-instance panel has one key per
  // tab, so every open key of that panel stays mounted.
  const allKeys = [...openPanelIds.left, ...openPanelIds.right];
  for (const panel of panels) {
    if (panel.keepAlive !== 'always') continue;
    if (panel.multiInstance) {
      for (const key of allKeys) {
        if (panelIdOfTab(key) === panel.id) mounted.add(key);
      }
    } else {
      mounted.add(panel.id);
    }
  }

  // Open tabs mount within the per-region cap; the coldest go first
  // (hibernation — the tab keeps its strip entry and reloads when used).
  // 'never' keeps its contract even as an open tab: it unmounts while hidden.
  const rank = new Map(recency.map((id, i) => [id, i]));
  const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const hiddenTabs = openPanelIds[region]
      .filter((key) => {
        const panel = panelOfKey(byId, key);
        return panel && !mounted.has(key) && panel.keepAlive !== 'never';
      })
      .sort((a, b) => rankOf(a) - rankOf(b));
    let budget = TAB_MOUNT_CAP;
    for (const key of hiddenTabs) {
      if (budget <= 0) break;
      mounted.add(key);
      budget--;
    }
  }

  // Closed tabs stay warm through the small LRU budget: closing by mistake
  // and reopening restores without a reload. (The tab host only renders open
  // keys, so this mostly serves the left rail's host panels.)
  const openKeys = new Set(allKeys);
  let lruBudget = LRU_KEEP;
  for (const key of recency) {
    if (mounted.has(key) || openKeys.has(key)) continue;
    const panel = panelOfKey(byId, key);
    if (panel?.keepAlive === 'lru' && lruBudget > 0) {
      mounted.add(key);
      lruBudget--;
    }
  }
  return [...mounted];
}

/**
 * Recompute derived panel state after the panel LIST changes (host panels
 * registered, plugin panels refreshed). Every mutator that replaces `panels`
 * must go through this — otherwise `mountedIds`/`focusedId` keep pointing
 * at panels that no longer exist, or at panels that changed region.
 *
 * Per region: keep the active panel if it survived, else activate the last
 * remaining tab. A region left with no tab behaves differently: left re-seeds
 * its default view (a single-select container has no meaningful empty state
 * and no close gesture), right stays empty — the column opens with the plugin
 * grid and an empty tab strip until the user picks something.
 *
 * Unknown ids (panel not in the list yet) survive until the plugin registry
 * has synced once: at boot, host panels register before plugin panels, and
 * every `set` writes straight through to storage — pruning on the first
 * reconcile would clobber the persisted tabs before the plugin list exists.
 * After the first sync, an unknown id really is an uninstalled panel.
 */
function reconcile(
  panels: PanelEntry[],
  prev: {
    focusedId: Record<PanelRegion, string | null>;
    openPanelIds: Record<PanelRegion, string[]>;
    sessionPanels: Record<string, SessionPanelState>;
    recency: string[];
    panelOrder: Record<PanelRegion, string[]>;
    splitGroups: Record<PanelRegion, EditorGroup[]>;
    pluginPanelsSynced: boolean;
  },
): {
  panels: PanelEntry[];
  recency: string[];
  focusedId: Record<PanelRegion, string | null>;
  openPanelIds: Record<PanelRegion, string[]>;
  sessionPanels: Record<string, SessionPanelState>;
  panelOrder: Record<PanelRegion, string[]>;
  splitGroups: Record<PanelRegion, EditorGroup[]>;
  mountedIds: string[];
} {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const recency = prev.recency.filter((key) => panelOfKey(byId, key));

  // Groups survive session switches (their tabs may be stashed), but a tab
  // whose panel was uninstalled is dropped; an empty group disappears, and
  // fewer than two groups collapses the split.
  //
  // Pruning waits for the plugin registry's first sync: at boot the host
  // panels register before the plugin panels, so pruning now would drop a
  // persisted split naming the viewer/browser and never bring it back.
  const splitGroups = { ...prev.splitGroups };
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const groups = prev.splitGroups[region] ?? [];
    let kept = groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
    if (prev.pluginPanelsSynced) {
      kept = kept
        .map((g) => ({ ...g, tabs: g.tabs.filter((key) => Boolean(panelOfKey(byId, key))) }))
        .filter((g) => g.tabs.length > 0);
    }
    kept = kept.map((g) => ({
      ...g,
      active: g.active && g.tabs.includes(g.active) ? g.active : recentTab(recency, g.tabs),
      weight: Number.isFinite(g.weight) && g.weight > 0 ? g.weight : 1,
    }));
    if (kept.length >= 2) {
      // Every open tab must live in a group. Tabs that predate the group
      // layout (or arrived just after a restore) join the first group.
      const assigned = new Set(kept.flatMap((g) => g.tabs));
      const orphans = (prev.openPanelIds[region] ?? []).filter(
        (key) => !assigned.has(key) && Boolean(panelOfKey(byId, key)),
      );
      if (orphans.length > 0) {
        const first = kept[0];
        first.tabs = [...first.tabs, ...orphans];
        first.active = first.active ?? recentTab(recency, first.tabs);
      }
    }
    splitGroups[region] = kept.length >= 2 ? kept : [];
  }

  // The installed-panel order follows the registry: uninstall/disable removes
  // an entry, a freshly installed plugin appends (the user's drag order is kept
  // for everything that survives). Before the registry has synced once the
  // pruning is gated off — host panels register before plugin panels, so a
  // boot-time prune would drop every plugin id from the persisted arrangement
  // and resurrect registry order (the same gate the tab selection applies).
  const panelOrder: Record<PanelRegion, string[]> = { left: [], right: [] };
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const known = regionPanels(panels, region).map((p) => p.id);
    const knownSet = new Set(known);
    const kept = prev.pluginPanelsSynced
      ? prev.panelOrder[region].filter((id) => knownSet.has(id))
      : prev.panelOrder[region];
    const keptSet = new Set(kept);
    panelOrder[region] = [...kept, ...known.filter((id) => !keptSet.has(id))];
  }

  // Session tab state gets the same sync-gate treatment as the selections:
  // prune a session's stashed tabs only once the registry is authoritative,
  // and keep only panels that still point at session-scoped panels.
  let sessionPanels = prev.sessionPanels;
  if (prev.pluginPanelsSynced) {
    sessionPanels = {};
    for (const [sid, st] of Object.entries(prev.sessionPanels)) {
      const selected = (st.selected ?? []).filter((key) => {
        const panel = panelOfKey(byId, key);
        return panel?.scope === 'session';
      });
      const focused = st.focused && selected.includes(st.focused) ? st.focused : null;
      if (selected.length === 0 && !focused) continue;
      const params: SessionPanelState['params'] = {};
      const titles: Record<string, string> = {};
      for (const key of selected) {
        params[key] = st.params?.[key];
        if (st.titles?.[key]) titles[key] = st.titles[key];
      }
      const groups = (st.splitGroups ?? [])
        .map((g) => {
          const tabs = g.tabs.filter((key) => selected.includes(key));
          return {
            ...g,
            tabs,
            active: g.active && tabs.includes(g.active) ? g.active : recentTab(recency, tabs),
          };
        })
        .filter((g) => g.tabs.length > 0);
      sessionPanels[sid] = {
        selected,
        focused,
        params,
        titles,
        ...(groups.length >= 2 ? { splitGroups: groups } : {}),
      };
    }
  }

  const pick = (region: PanelRegion): { focused: string | null; selected: string[] } => {
    const selected = prev.openPanelIds[region].filter((key) => {
      const panel = panelOfKey(byId, key);
      if (panel) {
        return panel.region === region;
      }
      // Only plugin ids may be temporarily unknown (their registry syncs after
      // host panels register). A host id that is gone — e.g. `host:settings`,
      // which became a dialog — must be pruned immediately: waiting for a
      // plugin sync that never comes (the web build has no plugins) would
      // leave the column focused on a panel with no body.
      return !prev.pluginPanelsSynced && panelIdOfTab(key).startsWith('plugin:');
    });
    const current = prev.focusedId[region];
    const focused =
      current && selected.includes(current) ? current : (selected[selected.length - 1] ?? null);
    if (region === 'left' && selected.length === 0) {
      const fallback = defaultActiveFor(panels, region);
      return { focused: fallback, selected: fallback ? [fallback] : [] };
    }
    return { focused, selected };
  };

  const left = pick('left');
  const right = pick('right');
  let rightFocused = right.focused;
  const rightGroups = splitGroups.right;
  if (
    rightGroups.length >= 2 &&
    (!rightFocused || !rightGroups.some((g) => g.tabs.includes(rightFocused!)))
  ) {
    rightFocused =
      rightGroups.find((g) => g.active)?.active ?? rightGroups[0]?.active ?? rightFocused;
  }

  return {
    panels,
    recency,
    focusedId: { left: left.focused, right: rightFocused },
    openPanelIds: { left: left.selected, right: right.selected },
    sessionPanels,
    panelOrder,
    splitGroups,
    mountedIds: computeMounted(
      panels,
      { left: left.focused, right: rightFocused },
      { left: left.selected, right: right.selected },
      recency,
      splitGroups,
    ),
  };
}

/**
 * Panel state lives in two scopes.
 *
 *  - ARRANGEMENT (installed-panel order) belongs to the WORKSPACE: VS Code
 *    keeps a folder's layout with the folder, so reopening it anywhere — or
 *    restarting into it — restores the same arrangement.
 *  - WHICH TABS ARE OPEN belongs to the WINDOW, keyed by its stable layout id.
 *    A restored window comes back the way you left it; a NEW window starts
 *    with the plugin grid, so it never inherits another window's tabs (the
 *    plugin center used to appear this way in every new window).
 */
const PANEL_STORAGE_BASE = 'pi-panel-storage';
let layoutWorkspace: string | null = null;

function arrangementKey(): string {
  if (layoutWorkspace) return `${PANEL_STORAGE_BASE}:ws:${layoutWorkspace}`;
  const windowId = getDesktopWindowId();
  return windowId == null ? PANEL_STORAGE_BASE : `${PANEL_STORAGE_BASE}:w${windowId}`;
}

function selectionKey(): string {
  const layoutId = getDesktopLayoutId();
  if (layoutId) return `${PANEL_STORAGE_BASE}:sel:${layoutId}`;
  const windowId = getDesktopWindowId();
  return windowId == null ? `${PANEL_STORAGE_BASE}:sel` : `${PANEL_STORAGE_BASE}:sel:w${windowId}`;
}

function legacyPanelKeys(): string[] {
  const keys: string[] = [];
  const windowId = getDesktopWindowId();
  if (windowId != null) keys.push(`${PANEL_STORAGE_BASE}:w${windowId}`);
  keys.push(PANEL_STORAGE_BASE);
  return keys;
}

interface StoredBlob {
  version?: number;
  state?: Record<string, unknown>;
}

function readBlob(key: string): StoredBlob | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredBlob) : null;
  } catch {
    return null;
  }
}

const panelStorage: StateStorage = {
  getItem: (): string | null => {
    let arrangement = readBlob(arrangementKey());
    // One-time fallback for layouts written before arrangement/selection were
    // split: the old per-window blob held both.
    if (!arrangement) {
      for (const legacy of legacyPanelKeys()) {
        arrangement = readBlob(legacy);
        if (arrangement) break;
      }
    }
    const selection = readBlob(selectionKey());
    if (!arrangement && !selection) return null;
    const state = { ...(arrangement?.state ?? {}), ...(selection?.state ?? {}) };
    const version = Math.max(arrangement?.version ?? 0, selection?.version ?? 0) || undefined;
    return JSON.stringify({ state, version });
  },
  setItem: (_name: string, value: string): void => {
    try {
      const parsed = JSON.parse(value) as StoredBlob;
      const s = parsed.state ?? {};
      localStorage.setItem(
        arrangementKey(),
        JSON.stringify({
          version: parsed.version,
          state: { panelOrder: s.panelOrder },
        }),
      );
      localStorage.setItem(
        selectionKey(),
        JSON.stringify({
          version: parsed.version,
          state: {
            openPanelIds: s.openPanelIds,
            focusedId: s.focusedId,
            params: s.params,
            tabTitles: s.tabTitles,
            currentSessionId: s.currentSessionId,
            sessionPanels: s.sessionPanels,
            sessionOrder: s.sessionOrder,
            splitGroups: s.splitGroups,
          },
        }),
      );
    } catch {
      /* quota / private mode — best-effort */
    }
  },
  removeItem: (): void => {
    try {
      localStorage.removeItem(arrangementKey());
      localStorage.removeItem(selectionKey());
    } catch {
      /* ignore */
    }
  },
};

export const usePanelStore = create<PanelStoreState>()(
  persist(
    (set, get) => ({
      panels: [],
      focusedId: EMPTY_FOCUSED,
      openPanelIds: EMPTY_TABS,
      panelOrder: { left: [], right: [] },
      splitGroups: EMPTY_GROUPS,
      currentSessionId: null,
      sessionPanels: {},
      sessionOrder: [],
      mountedIds: [],
      recency: [],
      runtime: {},
      params: {},
      tabTitles: {},
      activationNonces: {},
      pluginPanelsSynced: false,

      setHostPanels: (hostPanels) =>
        set((s) => reconcile([...hostPanels, ...s.panels.filter((p) => p.source !== 'host')], s)),

      setPluginPanels: (infos) =>
        set((s) => {
          const pluginPanels: PanelEntry[] = infos.flatMap((plugin) =>
            plugin.panels
              // A panel is a web page. Manifest validation guarantees an entry,
              // but a malformed descriptor must not take the whole list down.
              .filter((panel) => Boolean(panel.entry))
              .map((panel) => ({
                id: pluginPanelId(plugin.id, panel.id),
                title: panel.title,
                icon: panel.icon ?? 'puzzle',
                iconUrl: panel.iconUrl,
                source: plugin.id,
                pluginId: plugin.id,
                panelId: panel.id,
                entry: panel.entry,
                hidden: panel.hidden === true,
                // Default 'lru' so switching away and back does not reload
                // the page from scratch. (Host panels carry their own
                // keepAlive and never route through this mapping.)
                keepAlive: panel.keepAlive ?? 'lru',
                scope: panel.scope,
                multiInstance: panel.multiInstance === true,
                region: panel.region ?? 'right',
                anchor: panel.anchor,
                order: panel.order,
              })),
          );
          const hostPanels = s.panels.filter((p) => p.source === 'host');
          // The registry is now authoritative: sync BEFORE reconciling so this
          // very call prunes stale tabs (an uninstalled plugin's panels), and
          // every reconcile after it does too.
          return {
            ...reconcile([...hostPanels, ...pluginPanels], { ...s, pluginPanelsSynced: true }),
            pluginPanelsSynced: true,
          };
        }),

      openPanel: (id, opts) =>
        set((s) => {
          const focus = opts?.focus !== false;
          const entry = s.panels.find((p) => p.id === id);
          // Resolve the region from the entry. Unknown ids default to 'right':
          // every id arriving from outside (find-preview routing, panel-open
          // events) is plugin-owned, and plugin panels always live on the right.
          const region = entry?.region ?? 'right';
          const selected = s.openPanelIds[region];
          const runtime = { ...s.runtime };
          const params = { ...s.params };
          const tabTitles = { ...s.tabTitles };
          const multi = entry?.multiInstance === true;

          // Pick the tab this open lands in.
          //
          // Singleton: the panel id IS the tab key, so a second open focuses
          // the existing tab.
          //
          // Multi-instance: prefer a tab already showing the same params (the
          // same file/page), then an unloaded tab of the same panel (the
          // "open into the empty viewer tab" rule), else a new instance.
          const samePanel = selected.filter((key) => panelIdOfTab(key) === id);
          const groups = s.splitGroups[region];
          const hasSplit = groups.length >= 2;
          const focusedGroup =
            hasSplit && s.focusedId[region]
              ? groupIndexContaining(groups, s.focusedId[region]!)
              : -1;
          // An empty tab is a natural destination. In a split, prefer one in
          // the FOCUSED group, so a file opened from the tree lands in the
          // column the user is working in.
          const emptyTabs = samePanel.filter((key) => isEmptyParams(s.params[key]));
          const pickEmpty = (): string | null => {
            if (!hasSplit) return emptyTabs[0] ?? null;
            const focused = groups[focusedGroup];
            const inFocused =
              focused && emptyTabs.find((key) => focused.tabs.includes(key));
            return (
              inFocused ??
              emptyTabs.find((key) => groupIndexContaining(groups, key) !== -1) ??
              emptyTabs[0] ??
              null
            );
          };
          let targetKey: string | null = null;
          if (multi) {
            const wanted = opts?.params;
            if (wanted) {
              const same = samePanel.find((key) => {
                try {
                  return JSON.stringify(s.params[key] ?? null) === JSON.stringify(wanted);
                } catch {
                  return false;
                }
              });
              targetKey = same ?? pickEmpty();
            } else {
              targetKey = pickEmpty();
            }
            if (!targetKey) targetKey = tabKeyOf(id, opts?.instanceId ?? newInstanceId());
          } else {
            targetKey = samePanel[0] ?? id;
          }
          // Every branch above assigns; the guard keeps TypeScript honest.
          if (!targetKey) targetKey = id;

          const wasOpen = selected.includes(targetKey);
          if (opts?.params) params[targetKey] = opts.params;

          // In split mode, new tabs (and the empty tab reused by an open)
          // belong to the FOCUSED group. Opening a file never disturbs the
          // other columns and never collapses the split.
          let splitGroups = s.splitGroups;
          if (hasSplit) {
            const nextGroups = groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
            if (wasOpen) {
              const gi = groupIndexContaining(nextGroups, targetKey);
              if (gi !== -1 && focus) nextGroups[gi].active = targetKey;
            } else if (entry || focus) {
              const gi = focusedGroup >= 0 ? focusedGroup : 0;
              nextGroups[gi].tabs.push(targetKey);
              if (focus) nextGroups[gi].active = targetKey;
            }
            splitGroups = { ...s.splitGroups, [region]: nextGroups };
          }

          // No-focus-steal: the tab is opened (so its group's strip shows it
          // and its dot) but the active tab does not change. Unknown ids
          // without a registered panel — a panel.open racing the registry sync
          // — only get the badge; the tab is added once the panel exists.
          if (!focus) {
            runtime[id] = { ...runtime[id], pending: true };
            const openPanelIds =
              entry && !wasOpen
                ? { ...s.openPanelIds, [region]: [...selected, targetKey] }
                : s.openPanelIds;
            const recency = [targetKey, ...s.recency.filter((r) => r !== targetKey)].slice(0, 12);
            return {
              runtime,
              params,
              tabTitles,
              openPanelIds,
              recency,
              splitGroups,
              mountedIds: computeMounted(s.panels, s.focusedId, openPanelIds, recency, splitGroups),
            };
          }

          const focusedId = { ...s.focusedId, [region]: targetKey };
          const recency = [targetKey, ...s.recency.filter((r) => r !== targetKey)].slice(0, 12);

          if (wasOpen) {
            delete runtime[id];
            return {
              focusedId,
              recency,
              runtime,
              params,
              tabTitles,
              splitGroups,
              activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
              mountedIds: computeMounted(
                s.panels,
                focusedId,
                s.openPanelIds,
                recency,
                splitGroups,
              ),
            };
          }

          // A new tab joins the strip at the end.
          delete tabTitles[targetKey];
          const openPanelIds = { ...s.openPanelIds, [region]: [...selected, targetKey] };
          return {
            focusedId,
            openPanelIds,
            recency,
            runtime,
            params,
            tabTitles,
            splitGroups,
            activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, recency, splitGroups),
          };
        }),

      /**
       * Close a tab: it leaves the strip and its pane goes away. The active
       * tab falls to the next tab in strip order (or the previous one when the
       * closed tab was last); with no tabs left the column shows the plugin
       * grid. Closing is deliberate — the LRU keeps the page warm for a while.
       */
      closeTab: (region, key) =>
        set((s) => {
          const selected = s.openPanelIds[region];
          const idx = selected.indexOf(key);
          if (idx === -1) return s;
          releaseTabView(key, s.panels);
          const remaining = selected.filter((t) => t !== key);
          let fallback: string | null = remaining[Math.min(idx, remaining.length - 1)] ?? null;
          if (!fallback && remaining.length > 0) fallback = remaining[remaining.length - 1];

          // Closing a tab inside an editor group removes it from that group.
          // Its active tab falls to the group's most recent remaining tab; an
          // empty group disappears, and fewer than two groups collapses the
          // split back to the single-view strip.
          const groups = s.splitGroups[region];
          let splitGroups = s.splitGroups;
          if (groups.length >= 2) {
            const gi = groupIndexContaining(groups, key);
            if (gi !== -1) {
              const next = groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
              const group = next[gi];
              group.tabs = group.tabs.filter((t) => t !== key);
              if (group.tabs.length === 0) {
                next.splice(gi, 1);
              } else if (group.active === key) {
                group.active = recentTab(s.recency, group.tabs);
              }
              if (next.length >= 1) {
                const focusGroup = next[Math.min(gi, next.length - 1)] ?? next[0];
                fallback = focusGroup?.active ?? fallback;
              }
              splitGroups = {
                ...s.splitGroups,
                [region]: next.length >= 2 ? next : [],
              };
            }
          }

          const focusedId = {
            ...s.focusedId,
            [region]: s.focusedId[region] === key ? fallback : s.focusedId[region],
          };
          const openPanelIds = { ...s.openPanelIds, [region]: remaining };
          const params = { ...s.params };
          delete params[key];
          const tabTitles = { ...s.tabTitles };
          delete tabTitles[key];
          const runtime = { ...s.runtime };
          // Runtime (badge/pending) is panel-scoped; clear it only when the
          // last tab of that panel is gone.
          const panelId = panelIdOfTab(key);
          if (!remaining.some((k) => panelIdOfTab(k) === panelId)) delete runtime[panelId];
          if (region === 'left' && remaining.length === 0) {
            const fallbackLeft = defaultActiveFor(s.panels, region);
            if (fallbackLeft) {
              openPanelIds[region] = [fallbackLeft];
              focusedId[region] = fallbackLeft;
            }
          }
          return {
            focusedId,
            openPanelIds,
            params,
            tabTitles,
            runtime,
            splitGroups,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, s.recency, splitGroups),
          };
        }),

      /**
       * Move `key` into the right pane (VS Code "Split & Move").
       *
       * The selected tab itself goes right — no second instance is created.
       * The left pane takes the most recently used remaining tab; when the
       * moved tab was the only one, the left group gets an empty tab of the
       * same plugin so it still has somewhere to open a file from.
       */
      splitTab: (region, key) =>
        set((s) => {
          if (region !== 'right') return s;
          const panelId = panelIdOfTab(key);
          const entry = s.panels.find((p) => p.id === panelId);
          const selected = s.openPanelIds[region];
          if (!entry?.multiInstance || !selected.includes(key)) return s;

          const groups = s.splitGroups[region] ?? [];
          let nextSelected = selected;
          let nextGroups: EditorGroup[];

          if (groups.length < 2) {
            // First split: the moved tab becomes the new right group; the
            // left group keeps the other tabs (or gets a fresh empty one).
            const sourceTabs = selected.filter((k) => k !== key);
            let sourceActive = recentTab(s.recency, sourceTabs);
            if (!sourceActive) {
              const fresh = tabKeyOf(panelId, newInstanceId());
              sourceTabs.push(fresh);
              sourceActive = fresh;
              nextSelected = [...selected];
              nextSelected.splice(selected.indexOf(key), 0, fresh);
            }
            nextGroups = [
              makeGroup(sourceTabs, sourceActive),
              makeGroup([key], key),
            ];
          } else {
            // New column to the right of the source group. Moving the last tab
            // out of a group backfills it with a fresh empty tab so the column
            // (and the split) survives.
            nextGroups = groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
            const gi = groupIndexContaining(nextGroups, key);
            if (gi === -1) {
              nextGroups.push(makeGroup([key], key));
            } else {
              const source = nextGroups[gi];
              source.tabs = source.tabs.filter((k) => k !== key);
              if (source.tabs.length === 0) {
                const fresh = tabKeyOf(panelId, newInstanceId());
                source.tabs = [fresh];
                source.active = fresh;
                nextSelected = [...selected];
                nextSelected.splice(selected.indexOf(key), 0, fresh);
              } else if (source.active === key) {
                source.active = recentTab(s.recency, source.tabs);
              }
              nextGroups.splice(gi + 1, 0, makeGroup([key], key));
            }
          }

          const openPanelIds = { ...s.openPanelIds, [region]: nextSelected };
          const splitGroups = { ...s.splitGroups, [region]: nextGroups };
          const focusedId = { ...s.focusedId, [region]: key };
          const recency = [key, ...s.recency.filter((r) => r !== key)].slice(0, 12);
          return {
            openPanelIds,
            splitGroups,
            focusedId,
            recency,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, recency, splitGroups),
          };
        }),

      /**
       * Click a tab inside the split's LEFT group.
       *
       * It becomes the left pane's active tab and the split stays visible
       * (VS Code: each editor group has its own active tab). The right
       * pane's tab is never disturbed.
       */
      focusSplitTab: (region, key) =>
        set((s) => {
          const selected = s.openPanelIds[region];
          if (!selected.includes(key)) return s;
          const groups = s.splitGroups[region] ?? [];
          let splitGroups = s.splitGroups;
          if (groups.length >= 2) {
            const gi = groupIndexContaining(groups, key);
            if (gi !== -1) {
              splitGroups = {
                ...s.splitGroups,
                [region]: groups.map((g, i) => (i === gi ? { ...g, active: key } : g)),
              };
            } else {
              // A tab not yet assigned to a column: put it in the focused
              // column and activate it there.
              const focusIndex =
                groupIndexContaining(groups, s.focusedId[region] ?? '') >= 0
                  ? groupIndexContaining(groups, s.focusedId[region] ?? '')
                  : 0;
              splitGroups = {
                ...s.splitGroups,
                [region]: groups.map((g, i) =>
                  i === focusIndex
                    ? { ...g, tabs: [...g.tabs, key], active: key }
                    : g,
                ),
              };
            }
          }
          const focusedId = { ...s.focusedId, [region]: key };
          const recency = [key, ...s.recency.filter((r) => r !== key)].slice(0, 12);
          return {
            splitGroups,
            focusedId,
            recency,
            mountedIds: computeMounted(s.panels, focusedId, s.openPanelIds, recency, splitGroups),
          };
        }),

      /** Open a fresh tab of `panelId` inside one editor group (its `+`). */
      addTabToGroup: (region, groupId, panelId) =>
        set((s) => {
          const groups = s.splitGroups[region] ?? [];
          const group = groups.find((g) => g.id === groupId);
          const entry = s.panels.find((p) => p.id === panelId);
          if (!group || !entry) return s;
          const selected = s.openPanelIds[region];
          const key = entry.multiInstance
            ? tabKeyOf(panelId, newInstanceId())
            : panelId;
          if (selected.includes(key)) return s; // a singleton exists once
          const openPanelIds = { ...s.openPanelIds, [region]: [...selected, key] };
          const splitGroups = {
            ...s.splitGroups,
            [region]: groups.map((g) =>
              g.id === groupId ? { ...g, tabs: [...g.tabs, key], active: key } : g,
            ),
          };
          const focusedId = { ...s.focusedId, [region]: key };
          const recency = [key, ...s.recency.filter((r) => r !== key)].slice(0, 12);
          return {
            openPanelIds,
            splitGroups,
            focusedId,
            recency,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, recency, splitGroups),
          };
        }),

      /**
       * Move a tab into another editor group (drag between group tab bars).
       * Moving the last tab out of a group removes that group; when only one
       * group remains the split collapses.
       */
      moveTabBetweenGroups: (region, key, targetGroupId, beforeKey) =>
        set((s) => {
          const groups = s.splitGroups[region] ?? [];
          const sourceIdx = groupIndexContaining(groups, key);
          const targetIdx = groups.findIndex((g) => g.id === targetGroupId);
          if (sourceIdx === -1 || targetIdx === -1) return s;

          const next = groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
          const source = next[sourceIdx];
          const target = next[targetIdx];
          source.tabs = source.tabs.filter((k) => k !== key);

          if (sourceIdx !== targetIdx) {
            const at = beforeKey ? target.tabs.indexOf(beforeKey) : -1;
            if (at >= 0) target.tabs.splice(at, 0, key);
            else target.tabs.push(key);
            target.active = key;
            if (source.tabs.length === 0) {
              next.splice(sourceIdx, 1);
            } else if (source.active === key) {
              source.active = recentTab(s.recency, source.tabs);
            }
          } else {
            const at = beforeKey ? target.tabs.indexOf(beforeKey) : -1;
            if (at >= 0) target.tabs.splice(at, 0, key);
            else target.tabs.push(key);
            target.active = key;
          }

          const splitGroups = {
            ...s.splitGroups,
            [region]: next.length >= 2 ? next : [],
          };
          const focusedId = { ...s.focusedId, [region]: key };
          const recency = [key, ...s.recency.filter((r) => r !== key)].slice(0, 12);
          return {
            splitGroups,
            focusedId,
            recency,
            mountedIds: computeMounted(s.panels, focusedId, s.openPanelIds, recency, splitGroups),
          };
        }),

      /** Collapse the split containing `key`; every tab stays open. */
      unsplitTab: (region, key) =>
        set((s) => {
          const groups = s.splitGroups[region] ?? [];
          if (!groups.some((g) => g.tabs.includes(key))) return s;
          const splitGroups = { ...s.splitGroups, [region]: [] };
          return {
            splitGroups,
            mountedIds: computeMounted(s.panels, s.focusedId, s.openPanelIds, s.recency, splitGroups),
          };
        }),

      setGroupWeights: (region, weights) =>
        set((s) => {
          const groups = s.splitGroups[region] ?? [];
          if (groups.length < 2 || weights.length !== groups.length) return s;
          return {
            splitGroups: {
              ...s.splitGroups,
              [region]: groups.map((g, i) => ({
                ...g,
                weight: Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 1,
              })),
            },
          };
        }),

      /** Drag-reorder of the open tabs (the strip is the only order). */
      setTabOrder: (region, ids) =>
        set((s) => {
          const selected = s.openPanelIds[region];
          const next = ids.filter((id) => selected.includes(id));
          for (const id of selected) if (!next.includes(id)) next.push(id);
          return { openPanelIds: { ...s.openPanelIds, [region]: next } };
        }),

      /** The user's arrangement of the installed-panel list (left rail / picker). */
      setPanelOrder: (region, ids) =>
        set((s) => {
          const known = regionPanels(s.panels, region).map((p) => p.id);
          const knownSet = new Set(known);
          const filtered = ids.filter((id) => knownSet.has(id));
          const filteredSet = new Set(filtered);
          const merged = [...filtered, ...known.filter((id) => !filteredSet.has(id))];
          return { panelOrder: { ...s.panelOrder, [region]: merged } };
        }),

      /** Activate an open tab (does not change the tab list). */
      setFocused: (region, key) =>
        set((s) => {
          if (!s.openPanelIds[region].includes(key)) return s;
          const groups = s.splitGroups[region] ?? [];
          let splitGroups = s.splitGroups;
          if (groups.length >= 2) {
            const gi = groupIndexContaining(groups, key);
            if (gi !== -1) {
              splitGroups = {
                ...s.splitGroups,
                [region]: groups.map((g, i) => (i === gi ? { ...g, active: key } : g)),
              };
            }
          }
          const focusedId = { ...s.focusedId, [region]: key };
          const recency = [key, ...s.recency.filter((r) => r !== key)].slice(0, 12);
          return {
            focusedId,
            splitGroups,
            recency,
            mountedIds: computeMounted(s.panels, focusedId, s.openPanelIds, recency, splitGroups),
          };
        }),

      /** Override a tab's label (viewer file name, browser page title). */
      setTabTitle: (key, title) =>
        set((s) => {
          const next = title && title.trim() ? title : '';
          if ((s.tabTitles[key] ?? '') === next) return s;
          const tabTitles = { ...s.tabTitles };
          if (next) tabTitles[key] = next;
          else delete tabTitles[key];
          return { tabTitles };
        }),

      /** A plugin changed a tab's params/title from inside its panel. */
      updateTab: (key, update) =>
        set((s) => {
          if (!s.openPanelIds.left.includes(key) && !s.openPanelIds.right.includes(key)) return s;
          // `panel.mounted` re-fires when params change; a backend that
          // publishes its tab state on mount would otherwise loop. Equal
          // values must keep the same store objects (and therefore the same
          // LiveSlot effect dependencies).
          const sameParams =
            update.params === undefined ||
            JSON.stringify(s.params[key] ?? null) === JSON.stringify(update.params);
          const nextTitle =
            update.title === undefined
              ? undefined
              : update.title && update.title.trim()
                ? update.title
                : '';
          const sameTitle =
            nextTitle === undefined || (s.tabTitles[key] ?? '') === nextTitle;
          if (sameParams && sameTitle) return s;
          const params = sameParams ? s.params : { ...s.params, [key]: update.params };
          let tabTitles = s.tabTitles;
          if (!sameTitle && nextTitle !== undefined) {
            tabTitles = { ...s.tabTitles };
            if (nextTitle) tabTitles[key] = nextTitle;
            else delete tabTitles[key];
          }
          return { params, tabTitles };
        }),

      /** The active panel (not tab) of a region. */
      focusedPanelOf: (region: PanelRegion): string | null => {
        const key = get().focusedId[region];
        return key ? panelIdOfTab(key) : null;
      },

      /**
       * Switch conversations: the session-scoped slice of the tab list
       * (tabs, active tab, params) detaches into `sessionPanels`; the incoming
       * session's slice attaches. Global tabs never move. Idempotent — safe to
       * re-run after plugin registration, which re-classifies panels whose
       * scope was unknown at first call.
       */
      enterSession: (sessionId) =>
        set((s) => {
          const scopeOf = (key: string): 'session' | 'global' | 'unknown' => {
            const p = s.panels.find((x) => x.id === panelIdOfTab(key));
            return p ? (p.scope === 'session' ? 'session' : 'global') : 'unknown';
          };

          // Before the plugin registry syncs, panels of not-yet-registered
          // entries are unclassifiable. Running the swap then would stash a
          // half-read list — worst case an EMPTY stash overwriting the
          // persisted one (params are not persisted, so they cannot be
          // recovered). Defer the whole swap: the App re-enters once the
          // registry has synced.
          const stripIds = [...s.openPanelIds.left, ...s.openPanelIds.right];
          if (!s.pluginPanelsSynced && stripIds.some((id) => scopeOf(id) === 'unknown')) {
            const order = [sessionId, s.currentSessionId, ...s.sessionOrder].filter(
              (id): id is string => id !== null,
            );
            return { currentSessionId: sessionId, sessionOrder: [...new Set(order)] };
          }

          const sessionPanels = { ...s.sessionPanels };
          const params = { ...s.params };
          const tabTitles = { ...s.tabTitles };
          const splitGroups = { ...s.splitGroups };

          // ── Stash: the outgoing conversation takes its slice with it. ──
          if (s.currentSessionId !== null) {
            const stashSelected: string[] = [];
            const stashParams: SessionPanelState['params'] = {};
            const stashTitles: Record<string, string> = {};
            let stashFocused: string | null = null;
            for (const region of ['left', 'right'] as PanelRegion[]) {
              for (const key of s.openPanelIds[region]) {
                // Only KNOWN session panels detach: an unknown id (plugin not
                // registered yet) may be global — stashing it here would pin a
                // global panel to one conversation.
                if (scopeOf(key) !== 'session') continue;
                stashSelected.push(key);
                stashParams[key] = params[key];
                delete params[key];
                if (tabTitles[key]) stashTitles[key] = tabTitles[key];
                delete tabTitles[key];
              }
              if (
                s.focusedId[region] &&
                scopeOf(s.focusedId[region]!) === 'session' &&
                stashSelected.includes(s.focusedId[region]!)
              ) {
                stashFocused = s.focusedId[region];
              }
            }
            // A split belongs to the conversation when every tab in every
            // group does. Stash it and clear it from the outgoing column; the
            // incoming conversation gets its own.
            const groups = s.splitGroups.right ?? [];
            const stashedGroups =
              groups.length >= 2 &&
              groups.every((g) => g.tabs.every((k) => stashSelected.includes(k)))
                ? groups
                : [];
            if (stashedGroups.length >= 2) splitGroups.right = [];

            const prevStash = sessionPanels[s.currentSessionId];
            const mergedParams: SessionPanelState['params'] = { ...(prevStash?.params ?? {}) };
            for (const [k, v] of Object.entries(stashParams)) {
              if (v !== undefined) mergedParams[k] = v;
            }
            for (const k of Object.keys(mergedParams)) {
              if (!stashSelected.includes(k)) delete mergedParams[k];
            }
            const mergedTitles: Record<string, string> = { ...(prevStash?.titles ?? {}) };
            for (const [k, v] of Object.entries(stashTitles)) mergedTitles[k] = v;
            for (const k of Object.keys(mergedTitles)) {
              if (!stashSelected.includes(k)) delete mergedTitles[k];
            }
            sessionPanels[s.currentSessionId] = {
              selected: stashSelected,
              focused: stashFocused,
              params: mergedParams,
              titles: mergedTitles,
              splitGroups: stashedGroups,
            };
          }

          // ── Restore: the incoming conversation's slice attaches. ──
          const incoming = sessionId !== null ? sessionPanels[sessionId] : undefined;
          const openPanelIds = { ...s.openPanelIds };
          const focusedId = { ...s.focusedId };
          for (const region of ['left', 'right'] as PanelRegion[]) {
            openPanelIds[region] = s.openPanelIds[region].filter((id) => scopeOf(id) !== 'session');
            if (focusedId[region] && scopeOf(focusedId[region]!) === 'session')
              focusedId[region] = null;
          }
          if (incoming) {
            for (const key of incoming.selected) {
              const p = s.panels.find((x) => x.id === panelIdOfTab(key));
              const region: PanelRegion = p?.region ?? 'right';
              if (!openPanelIds[region].includes(key)) {
                openPanelIds[region] = [...openPanelIds[region], key];
              }
              if (incoming.params?.[key] !== undefined) params[key] = incoming.params[key];
              if (incoming.titles?.[key]) tabTitles[key] = incoming.titles[key];
            }
            const incomingFocused =
              incoming.focused && incoming.selected.includes(incoming.focused)
                ? incoming.focused
                : null;
            if (incomingFocused) {
              const p = s.panels.find((x) => x.id === panelIdOfTab(incomingFocused));
              focusedId[p?.region ?? 'right'] = incomingFocused;
            }
            const incomingGroups = incoming.splitGroups ?? [];
            if (incomingGroups.length >= 1) {
              const valid = incomingGroups
                .map((g) => {
                  const tabs = g.tabs.filter((k) => openPanelIds.right.includes(k));
                  return {
                    ...g,
                    tabs,
                    active:
                      g.active && tabs.includes(g.active)
                        ? g.active
                        : recentTab(s.recency, tabs),
                  };
                })
                .filter((g) => g.tabs.length > 0);
              splitGroups.right = valid.length >= 2 ? valid : [];
            }
          }

          // Tabs that did not survive the swap must not linger.
          const currentGroups = (splitGroups.right ?? [])
            .map((g) => {
              const tabs = g.tabs.filter((k) => openPanelIds.right.includes(k));
              return {
                ...g,
                tabs,
                active:
                  g.active && tabs.includes(g.active)
                    ? g.active
                    : recentTab(s.recency, tabs),
              };
            })
            .filter((g) => g.tabs.length > 0);
          splitGroups.right = currentGroups.length >= 2 ? currentGroups : [];
          if (splitGroups.right.length >= 2) {
            const inGroup = splitGroups.right.some((g) =>
              g.tabs.includes(focusedId.right ?? ''),
            );
            if (!inGroup) {
              focusedId.right =
                splitGroups.right.find((g) => g.active)?.active ??
                splitGroups.right[0]?.active ??
                focusedId.right;
            }
          }

          // A tab bed always has an active tab when it has tabs. The stash can
          // hold a session slice with no active tab (the previously active
          // panel may have been global, or was closed while away), so fall back
          // to the last tab in strip order instead of leaving the body blank.
          for (const region of ['left', 'right'] as PanelRegion[]) {
            const current = focusedId[region];
            if (current && openPanelIds[region].includes(current)) continue;
            focusedId[region] = openPanelIds[region][openPanelIds[region].length - 1] ?? null;
          }

          return {
            currentSessionId: sessionId,
            sessionPanels,
            sessionOrder:
              sessionId !== null
                ? [sessionId, ...s.sessionOrder.filter((id) => id !== sessionId)].slice(
                    0,
                    SESSIONS_KEPT,
                  )
                : s.sessionOrder,
            openPanelIds,
            focusedId,
            params,
            tabTitles,
            splitGroups,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, s.recency, splitGroups),
          };
        }),

      setPanelStatus: (status) =>
        set((s) => {
          const id = status.panelId
            ? pluginPanelId(status.pluginId, status.panelId)
            : s.panels.find((p) => p.source === status.pluginId)?.id;
          if (!id) return s;
          return {
            runtime: {
              ...s.runtime,
              [id]: {
                ...s.runtime[id],
                badge: status.badge,
                activity: status.activity,
                detail: status.detail,
              },
            },
          };
        }),

      clearPending: (id) =>
        set((s) => {
          const rt = { ...s.runtime[id] };
          delete rt.pending;
          return { runtime: { ...s.runtime, [id]: rt } };
        }),
    }),
    {
      name: 'pi-panel-storage',
      version: 14,
      // Installed-panel order → workspace key, open tabs → window key: see panelStorage.
      storage: createJSONStorage(() => panelStorage),
      partialize: (state) => ({
        focusedId: state.focusedId,
        openPanelIds: state.openPanelIds,
        params: state.params,
        tabTitles: state.tabTitles,
        panelOrder: state.panelOrder,
        currentSessionId: state.currentSessionId,
        sessionPanels: state.sessionPanels,
        sessionOrder: state.sessionOrder,
        splitGroups: state.splitGroups,
      }),
      migrate: (persisted, version) => {
        // v10 drops pane widths and the zoom: the right column is a tab strip
        // now, and the layout's own toggles give the panel the full width.
        // v11 adds per-tab params/titles so a multi-instance tab reopens on
        // the same file/page after a restart. v12 adds a right-column split;
        // v13 generalises it to N panes; v14 turns panes into editor groups.
        const p = (persisted ?? {}) as {
          panelOrder?: Record<PanelRegion, string[]>;
          openPanelIds?: Record<PanelRegion, string[]>;
          focusedId?: Record<PanelRegion, string | null>;
          params?: Record<string, Record<string, unknown> | undefined>;
          tabTitles?: Record<string, string>;
          currentSessionId?: string | null;
          sessionPanels?: Record<string, SessionPanelState>;
          sessionOrder?: string[];
          splitGroups?: Record<PanelRegion, EditorGroup[]>;
          splitPanes?: Record<PanelRegion, string[]>;
          splitWeights?: Record<PanelRegion, number[]>;
          splitPair?: Record<PanelRegion, { left: string; right: string } | null>;
          splitRatio?: Record<PanelRegion, number>;
        };
        const DEVDOCS_PANEL = 'plugin:com.pi.devdocs:docs';
        const order = p.panelOrder ?? { left: [], right: [] };
        // v7 default: the dev-docs panel is a reference surface, kept last in
        // the right strip unless the user drags it elsewhere. Only the old
        // migrations apply it — a v9 arrangement may be the user's own.
        if (version < 9 && Array.isArray(order.right) && order.right.includes(DEVDOCS_PANEL)) {
          order.right = [...order.right.filter((id) => id !== DEVDOCS_PANEL), DEVDOCS_PANEL];
        }
        // v5..v8 mixed arrangement and "which panels are open" in one blob;
        // those selections were written before panels were scoped to the
        // window, so they cannot be attributed reliably. Carry over the
        // arrangement only; v9+ selections are already scoped correctly.
        if (version < 9) {
          return { panelOrder: order } as never;
        }

        const groupsFromPanes = (
          panes: string[] | undefined,
          weights: number[] | undefined,
          legacyPair: { left: string; right: string } | null | undefined,
          legacyRatio: number | undefined,
        ): EditorGroup[] => {
          let list = Array.isArray(panes) ? panes : [];
          if (list.length < 2 && legacyPair) list = [legacyPair.left, legacyPair.right];
          if (list.length < 2) return [];
          const w = Array.isArray(weights)
            ? weights
            : typeof legacyRatio === 'number'
              ? [legacyRatio, 1 - legacyRatio]
              : undefined;
          const normalized = normalizeWeights(list.length, w);
          return list.map((key, i) => makeGroup([key], key, normalized[i]));
        };

        const splitGroups: Record<PanelRegion, EditorGroup[]> = { left: [], right: [] };
        for (const region of ['left', 'right'] as PanelRegion[]) {
          const existing = p.splitGroups?.[region];
          if (Array.isArray(existing) && existing.length >= 2) {
            const groups = existing
              .filter((g) => Array.isArray(g.tabs) && g.tabs.length > 0)
              .map((g) => ({
                id: typeof g.id === 'string' && g.id ? g.id : newGroupId(),
                tabs: g.tabs.filter((k): k is string => typeof k === 'string'),
                active:
                  typeof g.active === 'string' && g.tabs.includes(g.active)
                    ? g.active
                    : ((g.tabs.find((k): k is string => typeof k === 'string') as string) ?? null),
                weight: Number.isFinite(g.weight) && g.weight > 0 ? g.weight : 1,
              }));
            if (groups.length >= 2) splitGroups[region] = groups;
          } else {
            splitGroups[region] = groupsFromPanes(
              p.splitPanes?.[region],
              p.splitWeights?.[region],
              p.splitPair?.[region],
              p.splitRatio?.[region],
            );
          }
        }

        const sessionPanels = p.sessionPanels ?? {};
        for (const st of Object.values(sessionPanels)) {
          if (!st.splitGroups) {
            const legacy = st as unknown as {
              splitPanes?: string[];
              splitPair?: { left: string; right: string } | null;
            };
            st.splitGroups = groupsFromPanes(
              legacy.splitPanes,
              undefined,
              legacy.splitPair,
              undefined,
            );
          }
        }

        return {
          panelOrder: order,
          openPanelIds: p.openPanelIds ?? { left: [], right: [] },
          focusedId: p.focusedId ?? { left: null, right: null },
          params: p.params ?? {},
          tabTitles: p.tabTitles ?? {},
          currentSessionId: p.currentSessionId ?? null,
          sessionPanels,
          sessionOrder: p.sessionOrder ?? [],
          splitGroups,
        } as never;
      },
    },
  ),
);

/**
 * Two windows on the SAME workspace share one layout key, and localStorage is
 * one blob per key: without this, the other window's next persist write would
 * put its stale installed-panel order back. Only the ARRANGEMENT travels —
 * installed-panel order. Which tabs are open stays per window: the two windows
 * sit on different conversations, and syncing tabs would drag one window's
 * session tabs into the other. The comparison stops the echo.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.newValue || event.key !== arrangementKey()) return;
    try {
      const parsed = JSON.parse(event.newValue) as { state?: { panelOrder?: unknown } } | null;
      const incoming = parsed?.state;
      if (!incoming) return;
      const current = usePanelStore.getState();
      const nextOrder = (incoming.panelOrder ??
        current.panelOrder) as PanelStoreState['panelOrder'];
      if (JSON.stringify(nextOrder) === JSON.stringify(current.panelOrder)) return;
      usePanelStore.setState({ panelOrder: nextOrder });
    } catch {
      /* malformed payload — keep the current layout */
    }
  });
}

export { pluginPanelId };

function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

/**
 * Activation counter for one panel — changes whenever that panel is explicitly
 * activated. Use as an effect dependency to focus an input on activation.
 */
export function usePanelActivation(panelId: string): number {
  return usePanelStore((s) => s.activationNonces[panelId] ?? 0);
}

export interface PanelStoreState {
  panels: PanelEntry[];
  /** The active tab per region — one of that region's open tabs. */
  focusedId: Record<PanelRegion, string | null>;
  /**
   * Open tabs per region, in strip order. Opening a panel appends here;
   * closing removes; drag-reorder rewrites. The session stash swaps the
   * session-scoped slice per conversation.
   */
  openPanelIds: Record<PanelRegion, string[]>;
  /**
   * Installed-panel order per region. Used by the left icon rail and the
   * right column's plugin grid / `+` picker. Entries missing from the array
   * trail in registry order; unknown ids are pruned by reconcile. Persisted.
   */
  panelOrder: Record<PanelRegion, string[]>;
  /**
   * The right column's editor groups when split. Empty means the single-view
   * tab strip; fewer than two groups is also treated as no split.
   */
  splitGroups: Record<PanelRegion, EditorGroup[]>;
  /** The conversation whose session tabs currently sit in `openPanelIds`. */
  currentSessionId: string | null;
  /** Per-conversation session-tab state, most recently entered tracked in `sessionOrder`. */
  sessionPanels: Record<string, SessionPanelState>;
  sessionOrder: string[];
  /** Panels currently mounted (visible or hidden-kept-alive). Flat; filter by region at render. */
  mountedIds: string[];
  /** Last-activation order for LRU bookkeeping (most recent first). */
  recency: string[];
  runtime: Record<string, PanelRuntimeState>;
  /** Open params per TAB KEY (e.g. { file } for a viewer tab). */
  params: Record<string, Record<string, unknown> | undefined>;
  /** Per-tab label overrides (viewer file name, browser page title). */
  tabTitles: Record<string, string>;
  /**
   * Bumped every time a panel is explicitly activated. Panels stay mounted when
   * hidden, so "focus my input on mount" fires only once — a panel that wants
   * focus on activation must depend on this instead.
   */
  activationNonces: Record<string, number>;
  /**
   * Whether the plugin registry has contributed its panels at least once.
   * Runtime-only (not persisted): reset false at boot, set by the first
   * `setPluginPanels`. Gates reconcile's pruning of unknown ids — see
   * its doc comment.
   */
  pluginPanelsSynced: boolean;

  setHostPanels: (panels: PanelEntry[]) => void;
  setPluginPanels: (infos: PluginInfo[]) => void;
  /** Open a panel as a tab (and activate it). focus=false → tab + pending dot.
   *  `instanceId` forces a specific instance of a multi-instance panel (used by
   *  the backend's `panel.open` so it learns the host tab key). */
  openPanel: (
    id: string,
    opts?: { focus?: boolean; params?: Record<string, unknown>; instanceId?: string },
  ) => void;
  /** Close a tab (it leaves the strip; active falls to a neighbour). */
  closeTab: (region: PanelRegion, key: string) => void;
  /**
   * Show `key` side by side with a second tab of the same multi-instance
   * panel (an existing empty tab, else a new instance). No-op for panels that
   * cannot have several tabs, and for the left region.
   */
  splitTab: (region: PanelRegion, key: string) => void;
  /** Open a fresh tab of `panelId` inside one editor group (its `+`). */
  addTabToGroup: (region: PanelRegion, groupId: string, panelId: string) => void;
  /** Move a tab into another group (drag between group tab bars). */
  moveTabBetweenGroups: (
    region: PanelRegion,
    key: string,
    targetGroupId: string,
    beforeKey?: string,
  ) => void;
  /** Activate a tab within its group (or assign it to the focused group). */
  focusSplitTab: (region: PanelRegion, key: string) => void;
  /** Collapse the split containing `key`; every tab stays open. */
  unsplitTab: (region: PanelRegion, key: string) => void;
  /** Replace the groups' relative widths (same length as `splitGroups`). */
  setGroupWeights: (region: PanelRegion, weights: number[]) => void;
  /** Drag-reorder the open tabs. */
  setTabOrder: (region: PanelRegion, keys: string[]) => void;
  /** The user's arrangement of the installed-panel list (left rail / picker). */
  setPanelOrder: (region: PanelRegion, ids: string[]) => void;
  /** Activate an open tab. */
  setFocused: (region: PanelRegion, key: string) => void;
  /** Override a tab's label (viewer file name, browser page title). */
  setTabTitle: (key: string, title: string | null) => void;
  /** A plugin changed a tab's params/title from inside its panel. */
  updateTab: (
    key: string,
    update: { title?: string | null; params?: Record<string, unknown> },
  ) => void;
  /** The active panel (not tab) of a region. */
  focusedPanelOf: (region: PanelRegion) => string | null;
  /**
   * Switch conversations: the session-scoped slice of the tab list detaches
   * into `sessionPanels`; the incoming session's slice attaches. Global tabs
   * never move. Idempotent — safe to re-run after plugin registration.
   */
  enterSession: (sessionId: string | null) => void;
  setPanelStatus: (status: PluginPanelStatus) => void;
  clearPending: (id: string) => void;
}

/**
 * Point the panel store at a workspace's layout and load it.
 *
 * Called by the UI store whenever the active workspace changes (and once at
 * boot after rehydration). The workspace's saved installed-panel order becomes
 * the store's arrangement; switching back re-reads the same key, so the
 * arrangement follows the folder — the way VS Code remembers a folder's
 * layout rather than a window's.
 */
export function setPanelLayoutWorkspace(workspaceId: string | null): void {
  const next = workspaceId ?? null;
  if (layoutWorkspace === next) return;
  layoutWorkspace = next;
  void usePanelStore.persist.rehydrate();
}
