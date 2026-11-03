import { useMemo, type ReactNode } from 'react';
import { PanelRail } from './panel-rail';
import { PanelBody, PaneView } from './panel-slot';
import { PanelWelcome } from './panel-welcome';
import { usePanelStore, panelIdOfTab, type PanelEntry, type PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * The panel work area (2026-11 redesign).
 *
 * The RIGHT region is a tab bed: `openPanelIds.right` is the strip order, the
 * active tab is `focusedId.right`, and exactly one pane is visible. Inactive
 * open tabs stay mounted while their keep-alive budget allows it (a browser
 * page, a document, an expanded tree) and are CSS-hidden otherwise. With no
 * open tabs the body is the install-plugin grid (`PanelWelcome`) — not a
 * blank tab; the strip has no entry for it.
 *
 * The LEFT region keeps its single-view shape: one vertical icon rail plus
 * the active panel, because a sidebar is a view switcher, not a document area.
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
  const panels = usePanelStore((s) => s.panels);
  const openIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeId = usePanelStore((s) => s.focusedId[region]);
  const mountedIds = usePanelStore((s) => s.mountedIds);

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

  // ── RIGHT region: one visible pane per active tab ──
  return (
    <div className="flex h-full w-full" data-panel-slots={region}>
      {open.length === 0 ? (
        <PanelWelcome region={region} />
      ) : (
        open.map(({ key, panel }) => {
          const active = activeId === key;
          // The active tab always renders. Other open tabs render only while
          // their keep-alive budget holds them; beyond it they hibernate and
          // reload on activation.
          if (!active && !mounted.has(key)) return null;
          return <PaneView key={key} panel={panel} tabKey={key} active={active} hidden={!active} />;
        })
      )}
    </div>
  );
}
