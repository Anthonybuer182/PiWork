import { create } from 'zustand';

/**
 * A frozen pane: a bitmap of what one native slot was showing when a floating
 * menu opened over it.
 *
 * The host's menus live in the renderer, while plugin panes are native views
 * stacked ABOVE the renderer, so a menu cannot float over them. Freezing turns
 * the pane into an image for the menu's lifetime: the image is shown in the
 * DOM (looking exactly like the live pane), the real view is hidden, and the
 * menu floats on top. Nothing flashes white.
 *
 * Every visible pane of the right column is frozen, not just the one the menu
 * is anchored to: the popover is wider than a split column and may cross into
 * its neighbour.
 *
 * Layers: a pane can be more than one native view (a plugin page plus the
 * browser engine embedded in it), so each snapshot is a stack.
 */
export interface FreezeLayer {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FreezeState {
  /**
   * Frozen slots. A slot mapped to `[]` is frozen with no image (capture
   * failed): the LiveSlot hides its view, the same blank fallback the app used
   * before freezing existed. A slot absent from the map is not frozen.
   */
  slots: Record<string, FreezeLayer[]>;
  clear: () => void;
}

export const useFreezeStore = create<FreezeState>((set) => ({
  slots: {},
  clear: () => set({ slots: {} }),
}));

/**
 * Bumped on every freeze/clear so a slow capture cannot land after the menu
 * that asked for it has already closed (or been replaced).
 */
let generation = 0;

function decode(dataUrl: string): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

async function snapshot(slotId: string): Promise<FreezeLayer[]> {
  const api = (
    window as unknown as {
      electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }
  ).electronAPI;
  if (!api?.invoke) return [];
  try {
    const res = (await api.invoke('pi:liveview:snapshot', { slotId })) as
      { ok?: boolean; layers?: FreezeLayer[] } | undefined;
    return Array.isArray(res?.layers) ? res.layers : [];
  } catch {
    return [];
  }
}

/**
 * Capture `slotIds` and hand their layers to the renderer.
 *
 * Resolves once the images are decoded: the caller opens the menu only then,
 * so the panes already show their frozen frames when the popup appears.
 */
export async function freezeSlots(slotIds: string[]): Promise<void> {
  const unique = [...new Set(slotIds)];
  if (unique.length === 0) return;
  const current = ++generation;
  // A capture that never completes must not hold the menu hostage: give up
  // after a second and let the LiveSlots fall back to hiding their views.
  const layersBySlot = await Promise.race([
    Promise.all(unique.map((slotId) => snapshot(slotId))),
    new Promise<FreezeLayer[][]>((resolve) =>
      setTimeout(() => resolve(unique.map(() => [])), 1000),
    ),
  ]);
  if (current !== generation) return;
  await Promise.all(layersBySlot.flat().map((layer) => decode(layer.dataUrl)));
  if (current !== generation) return;
  const slots: Record<string, FreezeLayer[]> = {};
  unique.forEach((slotId, index) => {
    slots[slotId] = layersBySlot[index];
  });
  useFreezeStore.setState({ slots });
}

/** Drop every frozen frame and let the LiveSlots show their real views again. */
export function clearFreeze(): void {
  generation++;
  useFreezeStore.setState({ slots: {} });
}
