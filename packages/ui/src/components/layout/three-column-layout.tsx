'use client';

import { useEffect, useRef, useState, useCallback, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { getHostChrome, DRAG, NO_DRAG, WindowControls } from './title-bar';

interface ThreeColumnLayoutProps {
  leftSidebar: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  /**
   * Header band segment over the left column (workspace controls). Rendered
   * only while the sidebar is open — when it is closed the app is expected
   * to pass the same content as `centerHeader`, which then carries the
   * traffic-light inset.
   */
  leftHeader?: ReactNode;
  /** Header band segment over the centre column (future: session title). */
  centerHeader?: ReactNode;
  /** Header band segment over the right column (the panel tab strip). */
  rightHeader?: ReactNode;
  /**
   * Pinned at the far right of the header band, IN FLOW — the tab strip is
   * confined to the right column's segment, so no number of tabs can push
   * this out. It is also the only affordance that re-opens a collapsed
   * column, which is why it must never disappear.
   */
  headerTrailing?: ReactNode;
  /** Callback when right panel width changes (after drag/arrow-key resize finishes). */
  onRightWidthChange?: (width: number) => void;
  /** Callback when left sidebar width changes (after drag/arrow-key resize finishes). */
  onLeftWidthChange?: (width: number) => void;
  leftWidth?: number;
  rightWidth?: number;
  minLeftWidth?: number;
  minRightWidth?: number;
  maxLeftWidth?: number;
  maxRightWidth?: number;
  /**
   * Minimum width the centre column keeps while the right panel is widened.
   * The right panel's own `maxRightWidth` is a static cap; this is the dynamic
   * one — it also reserves the sidebar and both dividers, so dragging the
   * right divider can never squeeze the left column out of view.
   */
  minCenterWidth?: number;
  rightPanelOpen?: boolean;
  sidebarOpen?: boolean;
  /**
   * Hide the centre chat column. CSS-hidden, never unmounted: the centre owns
   * the composer, and a plugin `chat.send` from a fullscreen panel must still
   * reach it.
   */
  centerPanelOpen?: boolean;
  /**
   * Mirror the two visible columns: the panel keeps the left edge and the
   * chat takes the right. Applied only while the sidebar is closed — the chat
   * cannot cross the sidebar (they share one flex wrapper), and the sidebar
   * stays the platform's left rail.
   */
  chatRight?: boolean;
  /**
   * Drag a divider past a column's floor and release: the column closes
   * instead of stopping dead at its minimum. The layout owns the gesture and
   * the collapse animation; the host owns the open/closed flag, so it answers
   * through these. Omit one and its column simply rubber-bands back.
   */
  onSidebarCollapse?: () => void;
  onRightPanelCollapse?: () => void;
  onCenterCollapse?: () => void;
}

/** Width of each resize divider (matches the `w-1` handles below). */
const DIVIDER_WIDTH = 4;

/**
 * Past a column's floor the column still follows the pointer, at this rate.
 * A hard stop at the minimum reads as "the drag is over"; the elastic tail is
 * what tells the hand that the column can go further — and how far.
 */
const OVERSHOOT = 0.35;
/**
 * Release with the pointer inside this fraction of a column's floor and the
 * column closes. Turning the gesture into a deliberate act (rather than
 * "whatever width you landed on") is what keeps a drag from accidentally
 * closing a column while resizing near its minimum.
 */
const COLLAPSE_AT = 0.45;
/** Settle time for the width changes that follow a release (see WIDTH_EASE). */
const SETTLE_MS = 170;
/**
 * The width transition. Off while dragging (the pointer is the clock), on for
 * the settle: the elastic snap back to the minimum, or the slide to zero that
 * ends in a collapsed column.
 */
const WIDTH_EASE = `width ${SETTLE_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`;

type CollapseTarget = 'sidebar' | 'panel' | 'center';

/**
 * The right divider handle — used by BOTH the header band and the body so the
 * line is one continuous grab target from the very top of the window. Grabbing
 * it in the title bar must feel identical to grabbing it below (same cursor,
 * same hover highlight, same keyboard behaviour); the two copies are driven by
 * one `currentRightWidth`, so they can never drift apart.
 */
function RightDividerHandle({
  width,
  minWidth,
  maxWidth,
  order,
  hot,
  onDragStart,
  onKeyboardResize,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  /** Flex order — the handle travels with its column when the sides swap. */
  order?: number;
  /**
   * The drag is far enough past the edge that releasing closes a column.
   * The line lights up: the gesture has become an act, and the release is the
   * commit.
   */
  hot?: boolean;
  onDragStart: () => void;
  onKeyboardResize: (side: 'left' | 'right', delta: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={t('拖动调整预览面板宽度')}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-orientation="vertical"
      className="group relative w-1 shrink-0 cursor-col-resize"
      // The header band is a window drag region; the handle must opt out or
      // the OS swallows the mousedown and resizing from the title bar never
      // starts.
      style={{ ...NO_DRAG, order }}
      onMouseDown={onDragStart}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onKeyboardResize('right', -10);
        if (e.key === 'ArrowRight') onKeyboardResize('right', 10);
      }}
    >
      <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
      <div
        className={cn(
          'ml-auto h-full transition-colors',
          hot
            ? 'w-[2px] bg-primary'
            : 'w-px bg-border group-hover:bg-muted-foreground/60 group-active:bg-muted-foreground/40',
        )}
      />
    </div>
  );
}

/**
 * Three-column workbench layout with a partitioned header band.
 *
 * The band is NOT a separate title bar floating above the columns: each
 * column owns a header segment sized by the SAME width state that drives its
 * body. That is what lets the column dividers run unbroken from the very top
 * — the band's divider continuations sit at the same x positions as the body
 * handles, because both come from one `currentLeftWidth`/`currentRightWidth`.
 *
 * On desktop the band is the window drag region (`-webkit-app-region` is not
 * a Tailwind utility and would be purged from the build — it must be inline
 * styles, see title-bar.tsx). Interactive segments opt out with NO_DRAG.
 */
export function ThreeColumnLayout({
  leftSidebar,
  centerPanel,
  rightPanel,
  leftHeader,
  centerHeader,
  rightHeader,
  headerTrailing,
  onRightWidthChange,
  onLeftWidthChange,
  leftWidth = 260,
  rightWidth = 600,
  minLeftWidth = 200,
  minRightWidth = 300,
  maxLeftWidth = 400,
  maxRightWidth = 1200,
  minCenterWidth = 360,
  rightPanelOpen = true,
  sidebarOpen = true,
  centerPanelOpen = true,
  chatRight = false,
  onSidebarCollapse,
  onRightPanelCollapse,
  onCenterCollapse,
}: ThreeColumnLayoutProps) {
  const { t } = useI18n();
  const [currentLeftWidth, setCurrentLeftWidth] = useState(leftWidth);
  const [currentRightWidth, setCurrentRightWidth] = useState(rightWidth);
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  // Which column this drag would close if the pointer were released now.
  // Drives the hint pill and the highlighted divider line.
  const [closing, setClosing] = useState<CollapseTarget | null>(null);
  // Measured width of the whole row — the centre's share (and therefore the
  // point at which a leftward drag starts eating into the chat) is derived
  // from it.
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftWidthRef = useRef(currentLeftWidth);
  const rightWidthRef = useRef(currentRightWidth);
  // The pointer's own width value (un-elastic, un-clamped). Every release
  // decision is made from it, never from the animated width on screen.
  const rawWidthRef = useRef(0);
  // The width the column had when the drag began: a collapse animates to zero
  // but must not overwrite the remembered preference with zero.
  const dragStartWidthRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);
  const onLeftWidthChangeRef = useRef(onLeftWidthChange);
  const onRightWidthChangeRef = useRef(onRightWidthChange);

  const chrome = getHostChrome();
  const draggable = chrome.platform !== 'web';

  // Two visible columns, chat on the right of the panel. Only that state has a
  // defined other side: with the sidebar open the chat cannot cross it (they
  // are one flex wrapper), so the preference lies dormant rather than
  // reordering three columns behind the user's back.
  //
  // The columns are moved with CSS `order`, never by changing DOM order: the
  // centre owns the composer and the right column owns the native views, and
  // a reorder in the tree would remount both.
  const swapped = chatRight && !sidebarOpen && rightPanelOpen && centerPanelOpen;

  // The trailing zone (layout toggles) is pinned absolutely at the band's
  // top-right — in flow it would eat its 100-odd px out of the flex-1 centre
  // segment and break the divider alignment with the body. Segments that sit
  // at the band's right edge reserve its measured width instead.
  const trailingRef = useRef<HTMLDivElement>(null);
  const [trailingWidth, setTrailingWidth] = useState(0);
  useEffect(() => {
    const el = trailingRef.current;
    if (!el) return;
    const measure = () => setTrailingWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep refs in sync. During a drag the refs are also written directly by the
  // handlers below so that rapid events accumulate correctly even when React
  // has not re-rendered yet.
  leftWidthRef.current = currentLeftWidth;
  rightWidthRef.current = currentRightWidth;
  onLeftWidthChangeRef.current = onLeftWidthChange;
  onRightWidthChangeRef.current = onRightWidthChange;

  const applyLeftWidth = useCallback((next: number) => {
    const clamped = Math.max(minLeftWidth, Math.min(maxLeftWidth, next));
    leftWidthRef.current = clamped;
    setCurrentLeftWidth(clamped);
    return clamped;
  }, [minLeftWidth, maxLeftWidth]);

  /**
   * The right panel's real ceiling right now. `maxRightWidth` is a static
   * preference (a 1200px panel on a 1400px window is legal by that number),
   * so it also has to leave room for the sidebar, both dividers and a usable
   * centre — otherwise the left column is clipped out of view and the panel
   * appears to cover it.
   */
  const maxRightWidthNow = useCallback(() => {
    const width = containerRef.current?.getBoundingClientRect().width;
    if (width === undefined) return maxRightWidth;
    const leftColumn = sidebarOpen ? currentLeftWidth + DIVIDER_WIDTH : 0;
    const centre = centerPanelOpen ? minCenterWidth : 0;
    const cap = width - leftColumn - DIVIDER_WIDTH - centre;
    return Math.max(minRightWidth, Math.min(maxRightWidth, cap));
  }, [maxRightWidth, minRightWidth, minCenterWidth, sidebarOpen, centerPanelOpen, currentLeftWidth]);

  const applyRightWidth = useCallback((next: number) => {
    const clamped = Math.max(minRightWidth, Math.min(maxRightWidthNow(), next));
    rightWidthRef.current = clamped;
    setCurrentRightWidth(clamped);
    return clamped;
  }, [minRightWidth, maxRightWidthNow]);

  // A panel that was already wide must not survive a window shrink or a wider
  // sidebar: re-clamp whenever the container or the left column changes, so
  // the left column is never left clipped.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const clamp = () => {
      const width = el.getBoundingClientRect().width;
      setContainerWidth(width);
      const cap = maxRightWidthNow();
      if (rightWidthRef.current > cap) {
        applyRightWidth(cap);
        onRightWidthChangeRef.current?.(rightWidthRef.current);
      }
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxRightWidthNow, applyRightWidth]);

  /** Write a width without the floor/ceiling — the drag's elastic tail and the
   *  collapse animation both live outside the legal range on purpose. */
  const setLeftWidthRaw = useCallback((next: number) => {
    leftWidthRef.current = next;
    setCurrentLeftWidth(next);
  }, []);
  const setRightWidthRaw = useCallback((next: number) => {
    rightWidthRef.current = next;
    setCurrentRightWidth(next);
  }, []);

  /**
   * The width the right panel needs to swallow the whole row. Used only by the
   * centre's collapse: sliding the panel to this width takes the chat to zero,
   * so the release that hides the chat has nothing left to jump.
   */
  const fullPanelWidth = useCallback(() => {
    const width = containerRef.current?.getBoundingClientRect().width ?? containerWidth;
    const leftColumn = sidebarOpen ? currentLeftWidth + DIVIDER_WIDTH : 0;
    return Math.max(minRightWidth, width - leftColumn - DIVIDER_WIDTH);
  }, [containerWidth, sidebarOpen, currentLeftWidth, minRightWidth]);

  /** Cancel a pending settle (a new drag started before the last one ended). */
  const cancelSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /**
   * Finish a collapse after the width has animated. The flag flips only once
   * the column is already zero-width, so closing never pops: what the eye sees
   * is a column sliding shut, not the layout re-flowing.
   */
  const collapse = useCallback(
    (target: CollapseTarget) => {
      const restore = dragStartWidthRef.current;
      if (target === 'sidebar') {
        setLeftWidthRaw(0);
      } else if (target === 'panel') {
        setRightWidthRaw(0);
      } else {
        setRightWidthRaw(fullPanelWidth());
      }
      cancelSettle();
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (target === 'sidebar') {
          onSidebarCollapse?.();
          setLeftWidthRaw(restore);
        } else if (target === 'panel') {
          onRightPanelCollapse?.();
          setRightWidthRaw(restore);
        } else {
          onCenterCollapse?.();
          setRightWidthRaw(restore);
        }
      }, SETTLE_MS);
    },
    [
      onSidebarCollapse,
      onRightPanelCollapse,
      onCenterCollapse,
      setLeftWidthRaw,
      setRightWidthRaw,
      fullPanelWidth,
      cancelSettle,
    ],
  );

  // Never let a pending settle fire after the layout is gone.
  useEffect(() => () => cancelSettle(), [cancelSettle]);

  /**
   * Which column a release at this pointer width would close. Computed from
   * the pointer value, never from rendered state: the pointer can enter a
   * collapse zone and lift in the same frame, and a stale render must not turn
   * that into a resize.
   */
  const collapseTargetFor = useCallback(
    (side: 'left' | 'right', raw: number): CollapseTarget | null => {
      if (side === 'left') {
        return raw < minLeftWidth * COLLAPSE_AT ? 'sidebar' : null;
      }
      if (raw < minRightWidth * COLLAPSE_AT) return 'panel';
      const cap = maxRightWidthNow();
      // `cap` is exactly the width that leaves the chat its minimum; pulling
      // deeper than the last stretch of that minimum closes the chat and hands
      // the row to the panel.
      return raw > cap + (1 - COLLAPSE_AT) * minCenterWidth ? 'center' : null;
    },
    [minLeftWidth, minRightWidth, minCenterWidth, maxRightWidthNow],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      rawWidthRef.current = dragging === 'left' ? x : swapped ? x : rect.width - x;
      const raw = rawWidthRef.current;
      setClosing(collapseTargetFor(dragging, raw));

      if (dragging === 'left') {
        // Past the minimum the sidebar keeps following, elastically — the
        // tail is the "you can keep going" signal.
        setLeftWidthRaw(
          raw >= minLeftWidth
            ? Math.min(maxLeftWidth, raw)
            : minLeftWidth - (minLeftWidth - raw) * OVERSHOOT,
        );
        return;
      }

      // The right divider has a floor on one side (the panel's own minimum)
      // and a ceiling on the other (the chat's minimum). Both ends elastic;
      // both ends able to close the column they squeeze.
      const cap = maxRightWidthNow();
      setRightWidthRaw(
        raw < minRightWidth
          ? minRightWidth - (minRightWidth - raw) * OVERSHOOT
          : raw > cap
            ? cap + (raw - cap) * OVERSHOOT
            : raw,
      );
    },
    [
      dragging,
      swapped,
      minLeftWidth,
      maxLeftWidth,
      minRightWidth,
      maxRightWidthNow,
      collapseTargetFor,
      setLeftWidthRaw,
      setRightWidthRaw,
    ],
  );

  const handleMouseUp = useCallback(() => {
    const raw = rawWidthRef.current;
    const target = dragging ? collapseTargetFor(dragging, raw) : null;
    setDragging(null);
    setClosing(null);
    if (!target) {
      // Settled inside the legal range: snap back out of the elastic tail (if
      // any) and persist — only the side that was actually dragged.
      if (dragging === 'left') {
        const settled = Math.max(minLeftWidth, Math.min(maxLeftWidth, raw));
        setLeftWidthRaw(settled);
        onLeftWidthChangeRef.current?.(settled);
      } else if (dragging === 'right') {
        const settled = Math.max(minRightWidth, Math.min(maxRightWidthNow(), raw));
        setRightWidthRaw(settled);
        onRightWidthChangeRef.current?.(settled);
      }
      return;
    }
    // A collapse is not a width the user chose: the remembered width stays
    // whatever it was before the drag.
    collapse(target);
  }, [
    dragging,
    collapse,
    collapseTargetFor,
    minLeftWidth,
    maxLeftWidth,
    minRightWidth,
    maxRightWidthNow,
    setLeftWidthRaw,
    setRightWidthRaw,
  ]);

  const handleKeyboardResize = useCallback(
    (side: 'left' | 'right', delta: number) => {
      if (side === 'left') {
        onLeftWidthChangeRef.current?.(applyLeftWidth(leftWidthRef.current + delta));
      } else {
        onRightWidthChangeRef.current?.(applyRightWidth(rightWidthRef.current + delta));
      }
    },
    [applyLeftWidth, applyRightWidth],
  );

  // Centre hidden + right panel open → the right column absorbs the freed
  // space instead of leaving a dead gap between the columns: it becomes the
  // working surface (viewer, browser, plugin panels all want the room).
  // Two flex-1 siblings would split the space 50/50, so the left column must
  // collapse to just the sidebar.
  const rightTakesCenter = !centerPanelOpen && rightPanelOpen;

  const beginDrag = useCallback(
    (side: 'left' | 'right') => {
      // A settle left over from the previous gesture must not land in the
      // middle of this one.
      cancelSettle();
      setClosing(null);
      dragStartWidthRef.current = side === 'left' ? leftWidthRef.current : rightWidthRef.current;
      rawWidthRef.current = dragStartWidthRef.current;
      setDragging(side);
    },
    [cancelSettle],
  );

  // Off while dragging: the pointer is the clock. On afterwards, which is what
  // turns the elastic snap-back and the collapse into one continuous motion.
  const widthTransition = dragging ? 'none' : WIDTH_EASE;

  // The hint pill is centred on the divider being dragged, derived from the
  // same width state that positions the columns — it cannot drift from the
  // line it annotates.
  const hintX = !closing
    ? 0
    : closing === 'sidebar'
      ? currentLeftWidth + DIVIDER_WIDTH / 2
      : swapped
        ? currentRightWidth + DIVIDER_WIDTH / 2
        : containerWidth - currentRightWidth - DIVIDER_WIDTH / 2;
  const hintLabel =
    closing === 'sidebar' ? t('左侧栏') : closing === 'panel' ? t('面板') : t('对话');

  useEffect(() => {
    if (dragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  return (
    <div ref={containerRef} className="flex flex-1 flex-col overflow-hidden">
      {/* ============ Header band ============ */}
      {/* No bottom border: the band merges into the body (Codex-style); the
          column separators themselves carry the structure. */}
      <div
        className="relative flex h-11 shrink-0 select-none items-stretch bg-background"
        data-testid="header-band"
        // Marks the band for the drag-region rule in globals.css: interactive
        // descendants opt out, everything else in here drags the window.
        data-drag-region=""
        style={draggable ? DRAG : undefined}
      >
        {sidebarOpen && (
          <>
            <div
              className="flex h-full min-w-0 shrink-0 items-center overflow-hidden border-r bg-sidebar"
              style={{ width: currentLeftWidth, paddingLeft: chrome.insetLeft, transition: widthTransition }}
            >
              {leftHeader != null && (
                <div className="flex min-w-0 items-center gap-0.5">
                  {leftHeader}
                </div>
              )}
            </div>
            {/* Left divider continuation — same x as the body separator. */}
            <div className="w-1 shrink-0" aria-hidden />
          </>
        )}
        {!rightTakesCenter && (
          <div
            className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
            style={{
              order: swapped ? 2 : 0,
              // Leftmost segment carries the traffic-light inset, rightmost
              // reserves the toggles zone — both follow the swap.
              paddingLeft: sidebarOpen || swapped ? 0 : chrome.insetLeft,
              paddingRight: swapped || !rightPanelOpen ? trailingWidth : 0,
            }}
          >
            {centerHeader != null && (
              <div className="flex min-w-0 items-center gap-0.5">
                {centerHeader}
              </div>
            )}
          </div>
        )}
        {/* Right divider continuation — the same interactive handle as the
            body, flush against the right column (the segment's own border-l
            would double the line). */}
        {rightPanelOpen && !rightTakesCenter && (
          <RightDividerHandle
            width={currentRightWidth}
            minWidth={minRightWidth}
            maxWidth={maxRightWidthNow()}
            order={swapped ? 1 : 0}
            hot={closing === 'panel' || closing === 'center'}
            onDragStart={() => beginDrag('right')}
            onKeyboardResize={handleKeyboardResize}
          />
        )}
        {rightPanelOpen && (
          <div
            className={cn(
              'flex h-full min-w-0 items-stretch overflow-hidden',
              rightTakesCenter ? 'flex-1' : 'shrink-0',
            )}
            style={{
              order: swapped ? 0 : undefined,
              width: rightTakesCenter ? undefined : currentRightWidth,
              transition: rightTakesCenter ? undefined : widthTransition,
              // Swapped → this segment is the leftmost column and takes the
              // traffic-light inset; otherwise the chat's segment keeps it.
              paddingLeft:
                (rightTakesCenter || swapped) && !sidebarOpen ? chrome.insetLeft : 0,
              // The toggles zone sits over this segment's right end — unless
              // the chat has taken that edge.
              paddingRight: swapped ? 0 : trailingWidth,
              // Split tab bars need to divide the SAME width as the body panes
              // under them. They read this to cancel the reservation above and
              // then re-reserve it on the rightmost bar (panel-tabs.tsx).
              ['--header-trailing-width' as string]: `${swapped ? 0 : trailingWidth}px`,
            } as CSSProperties}
          >
            {rightHeader != null && (
              <div className="flex h-full min-w-0 flex-1 items-stretch">
                {rightHeader}
              </div>
            )}
          </div>
        )}
        {/* The gesture's commitment point, stated plainly. Lives in the band
            (no native view can sit above it) and follows the divider. */}
        {closing && containerWidth > 0 && (
          <div
            data-testid="collapse-hint"
            className="pointer-events-none absolute inset-y-0 z-30 flex items-center"
            style={{
              ...NO_DRAG,
              left: Math.max(72, Math.min(containerWidth - 72, hintX)),
              transform: 'translateX(-50%)',
            }}
          >
            <span className="whitespace-nowrap rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium leading-none text-primary-foreground shadow-xs">
              {t('松开收起{label}', { label: hintLabel })}
            </span>
          </div>
        )}
        <div
          ref={trailingRef}
          className="absolute inset-y-0 right-0 z-10 flex shrink-0 items-center gap-1 px-2"
          data-testid="header-trailing"
        >
          {headerTrailing}
          {chrome.customControls && <WindowControls />}
        </div>
      </div>

      {/* ============ Body band ============ */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ============== Left + Center column ============== */}
        <div
          style={{ order: swapped ? 2 : 0 }}
          className={cn(
            'flex min-w-0 flex-col overflow-hidden',
            // Centre hidden with the right panel absorbing the space: shrink to
            // just the sidebar. Two `flex-1` siblings would split the free
            // width instead of handing it all over.
            rightTakesCenter ? 'flex-none' : 'flex-1',
          )}
        >
          {/* Sidebar + Center */}
          <div className="flex flex-1 overflow-hidden">
            {/* Hidden, not unmounted, when collapsed — same reasoning as the
                centre column below. The sidebar hosts the left PanelHost, whose
                keepAlive:'always' panels (session list, file tree, settings
                forms) must survive a collapse/expand cycle with their state.
                Unmounting here silently defeated that policy. The resize handle
                is chrome, not state, so it still goes away. */}
            <div
              style={
                sidebarOpen ? { width: currentLeftWidth, transition: widthTransition } : undefined
              }
              className={cn(
                'shrink-0 overflow-hidden border-r',
                !sidebarOpen && 'hidden',
              )}
            >
              {leftSidebar}
            </div>
            {sidebarOpen && (
              <div
                role="separator"
                tabIndex={0}
                aria-label={t('拖动调整侧栏宽度')}
                aria-valuenow={currentLeftWidth}
                aria-valuemin={minLeftWidth}
                aria-valuemax={maxLeftWidth}
                aria-orientation="vertical"
                className={cn(
                  'w-1 cursor-col-resize transition-colors',
                  closing === 'sidebar' ? 'bg-primary' : 'hover:bg-muted-foreground/40',
                )}
                onMouseDown={() => beginDrag('left')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') handleKeyboardResize('left', -10);
                  if (e.key === 'ArrowRight') handleKeyboardResize('left', 10);
                }}
              />
            )}
            {/* Hidden, not unmounted: the centre column owns the composer, and a
                plugin panel can trigger a send from fullscreen (`chat.send`).
                Unmounting would take that path with it. */}
            <div
              className={cn('min-w-0 flex-1 overflow-hidden', !centerPanelOpen && 'hidden')}
            >
              {centerPanel}
            </div>
          </div>
        </div>

        {/* ============== Right column ============== */}
        {rightPanelOpen ? (
          <>
            {!rightTakesCenter ? (
              <RightDividerHandle
                width={currentRightWidth}
                minWidth={minRightWidth}
                maxWidth={maxRightWidthNow()}
                order={swapped ? 1 : 0}
                hot={closing === 'panel' || closing === 'center'}
                onDragStart={() => beginDrag('right')}
                onKeyboardResize={handleKeyboardResize}
              />
            ) : null}
            <div
              style={{
                order: swapped ? 0 : undefined,
                ...(rightTakesCenter
                  ? undefined
                  : { width: currentRightWidth, transition: widthTransition }),
              }}
              className={cn(
                'overflow-hidden flex flex-col',
                rightTakesCenter ? 'min-w-0 flex-1' : 'shrink-0',
              )}
            >
              <div className="flex-1 overflow-hidden">{rightPanel}</div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
