import { usePanelStore } from '@/stores/panel-store';
import { useI18n } from '@/i18n';
import { panelTitle } from './panel-title';
import { RailIcon } from './panel-rail';
import { installedPanels } from './panel-order';

/**
 * The right column's no-tabs state: the installed panels as a centred card
 * grid. Picking a card opens a tab; the grid itself is NOT a tab, so the strip
 * stays empty until something is picked.
 *
 * This is the landing surface every time the right column is opened with no
 * tabs (first open, last tab closed, new window). It replaces the old empty
 * text hint, which offered nothing to click.
 */
export function PanelWelcome({ region = 'right' }: { region?: 'left' | 'right' }) {
  const { t } = useI18n();
  const panels = usePanelStore((s) => s.panels);
  const panelOrder = usePanelStore((s) => s.panelOrder);
  const openPanel = usePanelStore((s) => s.openPanel);

  const items = installedPanels(panels, panelOrder, region);

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-auto p-6"
      data-panel-welcome={region}
    >
      {items.length === 0 ? (
        <div className="max-w-xs text-center text-xs leading-5 text-muted-foreground">
          {t('还没有可用的插件')}
        </div>
      ) : (
        <div className="grid w-full max-w-md grid-cols-2 gap-3">
          {items.map((panel) => {
            const title = panelTitle(panel, t);
            return (
              <button
                key={panel.id}
                type="button"
                data-welcome-panel={panel.id}
                title={title}
                onClick={() => openPanel(panel.id, { focus: true })}
                className="flex min-h-[104px] flex-col items-center justify-center gap-2.5 rounded-xl border bg-card px-4 py-5 text-center text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              >
                <RailIcon panel={panel} size={24} />
                <span className="max-w-full truncate">{title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
