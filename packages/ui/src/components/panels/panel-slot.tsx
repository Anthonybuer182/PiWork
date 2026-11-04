import { useEffect, type ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { usePanelStore, type PanelEntry } from '@/stores/panel-store';
import { useI18n } from '@/i18n';
import { PluginCenter } from '@/components/plugins/plugin-center';
import { FileTree } from '@/components/file/file-tree';
import { SessionList } from '@/components/session/session-list';
import { ensureRelayInstalled } from '@/components/plugins/panel-relay';
import { LiveSlot } from './live-slot';

/**
 * Host panels ("the host is the zeroth contributor") — rendered through the
 * same panel registry/lifecycle as plugin panels. File preview is
 * plugin-owned: no host preview panel.
 */
const HOST_COMPONENTS: Record<string, ComponentType> = {
  'host:plugins': PluginCenter,
  'host:files': FileTree,
  'host:sessions': SessionList,
};

/**
 * Whether this host can put a panel in a native WebContentsView.
 *
 * Every shipped build can: desktop always exposes `electronAPI`, and the web
 * build never registers plugin panels at all (`setPluginPanels` is called only
 * by the desktop renderer). A native view is a real top-level frame, which is
 * what gives a panel correct IME and working print / alert / download.
 *
 * Kept as a guard rather than assumed, because the failure it prevents — a
 * blank rectangle with no explanation — is the one this whole area is prone to.
 */
function hasNativeViewHost(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI;
  return typeof api?.invoke === 'function';
}

/**
 * A plugin web panel hosted natively. Reads the panel's open params (e.g.
 * `{ file }` for the viewer) and hands them to the slot, which forwards them to
 * the backend as the `panel.mounted` event the backend renders from.
 *
 * It also installs the relay — the theme push that keeps a panel's colors in
 * sync with the shell.
 */
function PluginWebViewPanel({
  pluginId,
  panelId,
  tabKey,
  entry,
  active,
}: {
  pluginId: string;
  panelId: string;
  tabKey: string;
  entry?: string;
  active: boolean;
}) {
  const params = usePanelStore((s) => s.params[tabKey]);
  useEffect(() => {
    ensureRelayInstalled();
  }, []);
  return (
    <LiveSlot
      pluginId={pluginId}
      panelId={panelId}
      tabKey={tabKey}
      entry={entry}
      active={active}
      notifyMounted
      params={params}
    />
  );
}

export function PanelBody({
  panel,
  tabKey,
  active = true,
}: {
  panel: PanelEntry;
  /** This tab's key (multi-instance) — also the params lookup and native view slot identity. */
  tabKey?: string;
  /** Whether this pane is the active tab (drives `panel.activated`). */
  active?: boolean;
}) {
  const { t } = useI18n();
  // Host panel: a React component the shell owns.
  if (panel.source === 'host') {
    const Host = HOST_COMPONENTS[panel.id];
    return Host ? <Host /> : null;
  }
  // Plugin panel: a web page the host hosts, in a WebContentsView.
  if (panel.pluginId && panel.panelId && panel.entry) {
    if (!hasNativeViewHost()) {
      // No shipped build reaches this. Saying so beats the alternative — an
      // empty rectangle that looks like a plugin that failed to load.
      return (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
          {t('插件面板需要桌面端')}
        </div>
      );
    }
    return (
      <PluginWebViewPanel
        pluginId={panel.pluginId}
        panelId={panel.panelId}
        tabKey={tabKey ?? panel.id}
        entry={panel.entry}
        active={active}
      />
    );
  }
  return null;
}

/**
 * One tab's pane: the panel body, hidden while another tab is active.
 *
 * The tab strip above already carries the panel's icon and title, so the pane
 * draws no header of its own — a second copy right under the strip read as
 * duplication in the old multi-pane work area too.
 *
 * `hidden` is `display:none`, not a conditional unmount: an inactive tab keeps
 * its state (scroll, expanded folders, a live browser page) while the
 * keep-alive budget holds it. A native view reports 0×0 when its host element
 * is display:none, which is the host's signal to hide the view.
 */
export function PaneView({
  panel,
  tabKey,
  active,
  hidden = false,
}: {
  panel: PanelEntry;
  /** The tab key this pane renders (params + native view identity). */
  tabKey: string;
  active: boolean;
  /** Rendered but kept off the layout (kept-alive while another tab is active). */
  hidden?: boolean;
}) {
  return (
    <div
      data-panel-container={panel.id}
      data-pane-tab={tabKey}
      data-pane-active={active ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        hidden && 'hidden',
      )}
    >
      <div className="min-h-0 flex-1">
        <PanelBody panel={panel} tabKey={tabKey} active={active} />
      </div>
    </div>
  );
}
