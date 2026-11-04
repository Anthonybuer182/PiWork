import type { PanelEntry } from '@/stores/panel-store';

/**
 * Built-in left-sidebar panels, shared by both apps so the left column is
 * defined once.
 *
 * `keepAlive: 'always'` is REQUIRED for these — their DOM state (expanded
 * folders, list scroll, virtualization) has to survive switching views, and
 * 'lru' would let them compete for the global LRU budget with right-side
 * plugin panels and get evicted.
 */
export const HOST_LEFT_PANELS: PanelEntry[] = [
  {
    id: 'host:sessions',
    title: '会话',
    icon: 'sessions',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 0,
  },
  {
    id: 'host:files',
    title: '文件',
    icon: 'files',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 1,
  },
];
