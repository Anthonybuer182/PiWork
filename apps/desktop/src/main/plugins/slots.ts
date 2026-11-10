import { ipcMain } from 'electron';

/**
 * Live slots — generic native-view mount points.
 *
 * A live slot is backed by a real `WebContentsView` that lives OUTSIDE the
 * renderer's DOM. The renderer therefore cannot lay it out: it only measures the
 * rectangle its slot occupies and reports it here, and the host positions the
 * view to match.
 *
 * Naming note: the wire channels below are still `pi:liveview:*` — a historical
 * name from when this mechanism served the (since removed) liveview panel kind.
 * The channels are internal, shared with the web build's LiveSlot component;
 * not worth a breaking rename.
 *
 * Two consequences drive this design:
 *  - A view that is not hidden **occludes the DOM and swallows clicks**. Hiding
 *    is not cosmetic; the renderer reports degenerate (0×0) bounds when its slot
 *    is unmounted or display:none, and that must map to a hidden view.
 *  - A renderer reload skips React cleanup entirely, so a slot can vanish
 *    without ever calling detach. `hideAll()` is the guard for that case.
 *
 * Multiple slots are supported: each registers its own handler, and each owns
 * its own view, so slots never fight over bounds (which they would if they all
 * drove one shared view).
 *
 * Slots are not a plugin-facing concept. Plugin panels are hosted by
 * `plugin-webview.ts` (one slot per panel, keyed `<pluginId>:<panelId>`), and a
 * host engine view (the embedded browser) is registered by `plugin-webview.ts`
 * the same way under `<pluginId>:<slotName>` when the plugin's page declares a
 * live slot via `piSDK.liveSlot`. There is no plugin-visible manifest field for
 * any of this — a plugin just provides a page.
 */
export interface LiveSlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One layer of a frozen slot: a bitmap of what the slot was showing.
 *
 * The panel view and an engine view embedded in its page are separate native
 * views, so the pane is captured as a stack: the panel first, then each engine
 * at its offset above it. `x`/`y` are relative to the slot's own rect.
 */
export interface LiveSlotSnapshotLayer {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * WHICH engine view the slot wants, when the view behind a slot is one of a
 * set (the multi-tab browser's tabs). Empty string = "no preference" — the
 * host falls back to whatever it currently considers active.
 */
export type LiveSlotTag = string;

export interface LiveSlotHandler {
  /** Called when the slot mounts. Use for one-time warm-up (e.g. connect CDP). */
  attach?(): void | Promise<void>;
  /**
   * Position and reveal the view. Bounds are in window-content coordinates.
   * `tag` names the target engine view, for slots backed by a set of them.
   */
  show(bounds: LiveSlotBounds, tag?: LiveSlotTag): void | Promise<void>;
  /** Hide the view so it neither paints nor intercepts input. */
  hide(): void;
  /**
   * Tear the backing view down entirely — the host tab it belonged to was
   * closed, not merely switched away from. Omit for slots whose view outlives
   * its reporter (the browser engine).
   */
  destroy?(): void;
  /**
   * Capture what this slot is currently showing (its own view plus any engine
   * views layered inside it). Used to keep the pane looking alive while a
   * floating menu needs to sit above the native views.
   */
  snapshot?(): Promise<LiveSlotSnapshotLayer[]>;
}

/**
 * Lazy slot resolver. Multi-instance panels create a new native view per host
 * tab, so their slot ids are not known at boot — the renderer's first attach
 * carries enough identity (plugin, panel, tab) to build the handler. Returns
 * undefined for a slot this host does not serve.
 */
export type LiveSlotFactory = (
  slotId: string,
  meta?: Record<string, unknown>,
) => LiveSlotHandler | undefined;

export class LiveSlotRegistry {
  private handlers = new Map<string, LiveSlotHandler>();
  private factory: LiveSlotFactory | null = null;
  /**
   * The last non-degenerate bounds each slot was shown at, with the tag that
   * named the target engine view.
   *
   * `reshow` replays them for slots whose reporter cannot re-report on its own:
   * a reused plugin panel view remounts with its page exactly as it was, so its
   * ResizeObserver never fires again — but the engine view positioned inside
   * that page must come back, showing the SAME tab it left on. detach/hide
   * deliberately do NOT clear the memory; only a degenerate setBounds (the
   * "this slot is gone" signal) does.
   */
  private lastShown = new Map<string, { bounds: LiveSlotBounds; tag?: LiveSlotTag }>();

  register(slotId: string, handler: LiveSlotHandler): void {
    if (this.handlers.has(slotId)) {
      console.warn(`[slots] slot "${slotId}" is already registered — replacing`);
    }
    this.handlers.set(slotId, handler);
  }

  /** Install the lazy resolver used for slots not registered at boot. */
  setFactory(factory: LiveSlotFactory | null): void {
    this.factory = factory;
  }

  private resolve(slotId: string, meta?: Record<string, unknown>): LiveSlotHandler | undefined {
    let handler = this.handlers.get(slotId);
    if (!handler && this.factory) {
      handler = this.factory(slotId, meta);
      if (handler) this.handlers.set(slotId, handler);
    }
    return handler;
  }

  unregister(slotId: string): void {
    this.handlers.get(slotId)?.hide();
    this.handlers.delete(slotId);
  }

  has(slotId: string): boolean {
    return this.handlers.has(slotId);
  }

  slots(): string[] {
    return [...this.handlers.keys()];
  }

  async attach(slotId: string, meta?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const handler = this.resolve(slotId, meta);
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };
    await handler.attach?.();
    return { ok: true };
  }

  async setBounds(
    slotId: string,
    bounds: LiveSlotBounds,
    tag?: LiveSlotTag,
    meta?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const handler = this.resolve(slotId, meta);
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };

    const { x, y, width, height } = bounds;
    // Degenerate bounds mean "not laid out" — a collapsed sidebar, a hidden
    // panel, or an unmounted slot. Hide rather than position a zero-size view.
    if (width <= 0 || height <= 0) {
      handler.hide();
      this.lastShown.delete(slotId);
      return { ok: true };
    }
    const shown = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
    this.lastShown.set(slotId, { bounds: shown, tag });
    await handler.show(shown, tag);
    return { ok: true };
  }

  /**
   * Snapshot one slot without changing its visibility. Returns [] when the
   * slot is unknown, not attached, or its handler cannot capture — callers
   * treat that as "no frozen image" and fall back to hiding the view.
   */
  async snapshot(slotId: string): Promise<LiveSlotSnapshotLayer[]> {
    const handler = this.handlers.get(slotId);
    if (!handler?.snapshot) return [];
    try {
      return await handler.snapshot();
    } catch (err) {
      console.error('[slots] snapshot failed:', err);
      return [];
    }
  }

  /**
   * Re-show a hidden slot at its last known bounds (and tag).
   *
   * For slots whose page cannot re-report (a reused panel view remounts with
   * the page exactly as it was — no resize, no observer fire). Fails with
   * `never shown` when there is nothing to replay; callers treat that as
   * "nothing to do", not as an error to surface.
   */
  async reshow(slotId: string): Promise<{ ok: boolean; error?: string }> {
    const handler = this.handlers.get(slotId);
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };
    const last = this.lastShown.get(slotId);
    if (!last) return { ok: false, error: 'never shown' };
    await handler.show(last.bounds, last.tag);
    return { ok: true };
  }

  detach(slotId: string): { ok: boolean } {
    this.handlers.get(slotId)?.hide();
    return { ok: true };
  }

  /**
   * Release a closed tab's view. Distinct from `detach` (hide, e.g. the column
   * collapsed or the tab hibernated): a closed tab will never come back under
   * this slot id, so keeping its renderer process alive is a leak.
   */
  release(slotId: string): { ok: boolean } {
    const handler = this.handlers.get(slotId);
    if (handler) {
      try {
        handler.destroy?.();
        if (!handler.destroy) handler.hide();
      } catch (err) {
        console.error(`[slots] destroy "${slotId}" failed:`, err);
      }
      this.handlers.delete(slotId);
      this.lastShown.delete(slotId);
    }
    return { ok: true };
  }

  /**
   * Hide every view. Called when the renderer navigates: a reload never runs
   * React cleanup, so slots would otherwise keep stale bounds and invisibly
   * occlude the UI, eating real mouse clicks.
   */
  hideAll(): void {
    for (const handler of this.handlers.values()) {
      try {
        handler.hide();
      } catch (err) {
        console.error('[slots] hide failed:', err);
      }
    }
  }
}

/**
 * Slot reports carry only a slot id — the same `pluginId:panelId` is mounted
 * in every window that shows that panel. The host therefore resolves the
 * SENDER window and hands the report to that window's registry; without this,
 * window B's bounds would reposition window A's view.
 */
export interface LiveSlotIpcHost {
  forSender(sender: Electron.WebContents): LiveSlotRegistry | undefined;
}

export function registerLiveSlotIpcHandlers(host: LiveSlotIpcHost): void {
  ipcMain.handle('pi:liveview:attach', (event, payload: { slotId?: string }) => {
    const registry = host.forSender(event.sender);
    if (!registry) return { ok: false, error: 'unknown window' };
    // The payload carries the tab identity a lazily-created slot needs
    // (pluginId / panelId / entry / tabKey); the slot id alone is not enough
    // for a multi-instance panel's Nth view.
    return registry.attach(String(payload?.slotId ?? ''), payload as Record<string, unknown>);
  });

  ipcMain.handle(
    'pi:liveview:set-bounds',
    (
      event,
      payload: { slotId?: string; x?: number; y?: number; width?: number; height?: number; tag?: string },
    ) => {
      const registry = host.forSender(event.sender);
      if (!registry) return { ok: false, error: 'unknown window' };
      return registry.setBounds(
        String(payload?.slotId ?? ''),
        {
          x: payload?.x ?? 0,
          y: payload?.y ?? 0,
          width: payload?.width ?? 0,
          height: payload?.height ?? 0,
        },
        payload?.tag || undefined,
      );
    },
  );

  ipcMain.handle(
    'pi:liveview:snapshot',
    async (event, payload: { slotId?: string }) => {
      const registry = host.forSender(event.sender);
      if (!registry) return { ok: false, layers: [] as LiveSlotSnapshotLayer[] };
      const layers = await registry.snapshot(String(payload?.slotId ?? ''));
      return { ok: true, layers };
    },
  );

  ipcMain.handle('pi:liveview:detach', (event, payload: { slotId?: string }) => {
    const registry = host.forSender(event.sender);
    if (!registry) return { ok: false, error: 'unknown window' };
    registry.detach(String(payload?.slotId ?? ''));
    return { ok: true };
  });

  ipcMain.handle('pi:liveview:release', (event, payload: { slotId?: string }) => {
    const registry = host.forSender(event.sender);
    if (!registry) return { ok: false, error: 'unknown window' };
    return registry.release(String(payload?.slotId ?? ''));
  });
}
