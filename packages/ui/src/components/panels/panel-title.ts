import type { PanelEntry } from '@/stores/panel-store';
import type { MessageKey } from '@/i18n';

/**
 * Host panels predate i18n and carry Chinese titles in the registry, which is
 * also persisted. Resolve their display name from the id at render time
 * instead of mutating the store. Plugin panels keep whatever their manifest
 * declares — that text belongs to the plugin, not the shell.
 */
const HOST_PANEL_TITLES: Record<string, MessageKey> = {
  'host:sessions': '会话',
  'host:files': '文件',
  'host:plugins': '插件中心',
};

export function panelTitle(
  panel: PanelEntry,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (panel.source === 'host') {
    const key = HOST_PANEL_TITLES[panel.id];
    if (key) return t(key);
  }
  return panel.title;
}
