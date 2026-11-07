import { create } from 'zustand';
import type { PanelRegion } from './panel-store';

/**
 * The single-view tab strip's context menu target.
 *
 * The menu itself is rendered INLINE by PanelHost (a flow row above the
 * panes), not as a floating popup: a DOM popup would be covered by the native
 * WebContentsView, and hiding the views to reveal it made the content flash
 * blank. An inline row pushes the content down instead, so it works with any
 * right-click gesture and never hides anything.
 */
export interface TabMenuTarget {
  region: PanelRegion;
  key: string;
}

interface TabMenuState {
  target: TabMenuTarget | null;
  open: (region: PanelRegion, key: string) => void;
  close: () => void;
}

export const useTabMenuStore = create<TabMenuState>((set) => ({
  target: null,
  open: (region, key) => set({ target: { region, key } }),
  close: () => set({ target: null }),
}));
