import type { PanelEntry, PanelRegion } from '@/stores/panel-store';

/**
 * The panels the right column's grid / `+` picker offers: installed, enabled
 * (disabled plugins never reach the registry), visible, in the user's
 * installed order (`panelOrder`), with registry order as the tiebreak for
 * panels never arranged.
 *
 * Left-side host panels are deliberately excluded by `region`.
 */
export function installedPanels(
  panels: PanelEntry[],
  panelOrder: Record<PanelRegion, string[]>,
  region: PanelRegion,
): PanelEntry[] {
  const order = panelOrder[region];
  const index = new Map(order.map((id, i) => [id, i]));
  return panels
    .filter((p) => p.region === region && !p.hidden)
    .sort((a, b) => {
      const ia = index.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const ib = index.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ia === ib ? (a.order ?? 0) - (b.order ?? 0) : ia - ib;
    });
}
