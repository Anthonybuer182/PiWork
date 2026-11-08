/**
 * The file viewer panel: one page, dispatching by extension.
 *
 * The host routes every previewable extension to this plugin's FIRST panel
 * (`findPreviewHandler` returns `panels[0]`), so per-format entries have to be
 * chosen here rather than in the manifest.
 *
 * `.docx` runs GenOffice's own renderer, and so do the other document formats;
 * this dispatch chooses between those apps and the small renderers that have no
 * app behind them (plain text today, media next).
 *
 * This module also runs again after a RELOAD, which is how a format switch
 * works: a mounted renderer cannot be swapped for another app in place, so the
 * shim persists the target path and reloads, and we pick the renderer afresh.
 * See `reloadForOtherFormat` in src/ui/shims/common.ts.
 */
// Removes GenOffice's AI surface (sidebar, ribbon group, canvas bar, ask
// popover) from every renderer this page loads. Must be part of the entry chunk:
// the renderers arrive via dynamic import, and this has to be in <head> by then.
import '../ai/strip-genoffice-ai.css';
// GenOffice's chrome assumes it IS the window (OS caption-button insets, a
// ribbon laid out for a window's width); this drops those assumptions.
import './panel-fit.css';

import { persistPendingPath, readPersistedPath } from '../shims/common';
import { MEDIA_EXTS } from '../media/exts';
import { mountEmptyState } from './empty-state';

/** The last `ui.render` the backend pushed, kept so a late listener can replay it. */
let lastPayload: unknown = null;
const waiters: Array<(p: unknown) => void> = [];

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string } | null;
  if (msg?.event !== 'ui.render') return;
  lastPayload = payload;
  // A push that EMPTIES the bucket — the conversation switched to one with
  // nothing open — must leave the current renderer: nothing is open any more.
  // The renderers ignore pathless pushes by contract, so the dispatcher (which
  // owns dispatching) reloads onto the empty state. Only when something was
  // actually mounted, or the very first boot push of an empty viewer would
  // reload for nothing.
  const data = (payload as { data?: { tabs?: unknown; activePath?: unknown } } | null)?.data;
  if (
    data &&
    Array.isArray(data.tabs) &&
    data.tabs.length === 0 &&
    !data.activePath &&
    (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__
  ) {
    persistPendingPath('');
    location.reload();
    return;
  }
  for (const w of waiters.splice(0)) w(payload);
});

/** Same file, forgiving separators and Windows drive casing. */
function sameFile(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  // Win32 paths are case-insensitive; POSIX ones are not.
  return /^[a-zA-Z]:/.test(x) || /^[a-zA-Z]:/.test(y)
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

/**
 * A TOOL rewrote the document this page is showing (office_edit runs in the
 * plugin backend, not in this renderer). Every renderer reads the file once
 * and keeps the parsed result in memory, and it deliberately ignores a repeat
 * of the path it already shows — so nothing would re-read it, and the panel
 * kept displaying the pre-edit document until the tab was closed and opened
 * again.
 *
 * Reloading the page is the one mechanism every renderer already supports:
 * it is what a format switch does, and the dispatcher comes back with the
 * persisted path. No renderer keeps in-panel state worth preserving here —
 * the state it holds is now stale by definition. Writes initiated by the
 * panel itself (save) do NOT arrive here; that state is already current.
 */
window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string; data?: { path?: string } } | null;
  if (msg?.event !== 'ui.fileChanged') return;
  const changed = msg.data?.path;
  if (!changed) return;
  const showing =
    (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__ || readPersistedPath();
  if (!showing || !sameFile(showing, changed)) return;
  location.reload();
});

function awaitRender(timeoutMs: number): Promise<unknown> {
  if (lastPayload) return Promise.resolve(lastPayload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    waiters.push((p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
}

/**
 * Boot pull: ask the backend what it is showing, in the same envelope a
 * `ui.render` carries. Faster than waiting on the mounted push, and the only
 * source when the panel reloaded without unmounting — the host pushes
 * `ui.render` on MOUNT only. Falls back to the push (and its 5s cap) when the
 * pull fails, so an older backend or a lost SDK degrades instead of blanking.
 */
async function pullState(): Promise<unknown> {
  try {
    const state = (await window.piSDK?.request('state.get')) as { path?: string } | null;
    if (state && typeof state === 'object') return { event: 'ui.render', data: state };
  } catch {
    /* fall through to the push */
  }
  return awaitRender(5000);
}

void (async () => {
  // A reload carries no `ui.render` — the host only sends one when the panel
  // MOUNTS, and this panel never unmounted. So the path the previous load
  // recorded is the only source, and we do not wait for a fresh one.
  const persisted = readPersistedPath();
  // A reload already knows which file it is for: `reloadForOtherFormat` wrote
  // the path before navigating (see shims/common.ts). So it dispatches at once
  // instead of pulling or waiting for a fresh `ui.render` — the host does not
  // re-raise `panel.mounted` when the open params are unchanged. If a newer
  // render does arrive, the loaded renderer handles it exactly as it handles
  // any other switch.
  const payload = persisted ? null : ((await pullState()) as { data?: { path?: string } } | null);
  const path = payload?.data?.path ?? persisted;
  if (path) persistPendingPath(path);

  // No file to show — the normal case when the panel is opened from the rail
  // rather than by clicking a file. Its own state rather than a fall-through to
  // a renderer: the colors come from the host's theme tokens, and nothing else
  // has to be loaded to draw a screen with nothing on it.
  if (!path) {
    mountEmptyState();
    // The empty state has to keep listening. This dispatcher runs once — the
    // long-lived `ui.render` listeners are the loaded renderers, which is how
    // switching files inside one panel works (see reloadForOtherFormat in
    // shims/common). With no renderer loaded nothing else is listening, so
    // without this a file opened after the panel had already shown its empty
    // state would arrive with no one to receive it.
    window.piSDK?.onMessage((payload) => {
      const msg = payload as { event?: string; data?: { path?: string } } | null;
      if (msg?.event !== 'ui.render') return;
      const next = msg.data?.path;
      // No path means "nothing open" — reloading on that would loop.
      if (!next) return;
      persistPendingPath(next);
      location.reload();
    });
    return;
  }

  const ext = path.toLowerCase().split('.').pop() ?? '';

  // Handed to whichever renderer loads, so it does not have to re-derive it
  // from a message it may have missed.
  (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__ = path || undefined;

  // `.docm` is `.docx` plus a `vbaProject.bin` part — the same OOXML the docs
  // renderer already parses, exactly as `.xlsm` is to `.xlsx`. Same for `.pptm`.
  if (ext === 'docx' || ext === 'docm') {
    await import('../docx/main');
    return;
  }

  if (ext === 'pptx' || ext === 'pptm') {
    await import('../slides/main');
    return;
  }

  if (ext === 'pdf') {
    await import('../pdf/main');
    return;
  }

  // No `ods`: the spreadsheet renderer is Univer, which speaks OOXML. An
  // OpenDocument file is a different format entirely — a zip with content.xml,
  // not a variant of xlsx — so listing the extension here would only promise a
  // render that cannot happen. `.xlsm` IS here and does work: it is xlsx plus a
  // macro payload. The manifest is the gate for all of these either way.
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'csv') {
    await import('../sheets/main');
    return;
  }

  // Markdown gets GenOffice's own viewer — a document renderer (images, links,
  // blockquotes), not the chat-bubble Markdown component .md used to go through.
  if (ext === 'md' || ext === 'markdown') {
    await import('../markdown/main');
    return;
  }

  if (ext === 'html' || ext === 'htm') {
    await import('../html/main');
    return;
  }

  // Images, video and audio: the engine decodes these itself, so no app to
  // vendor and no parser to write. The list lives beside that renderer because
  // it is also the list that decides what a reload keeps vs. hands over.
  if (MEDIA_EXTS.includes(ext)) {
    await import('../media/main');
    return;
  }

  // What is left is plain text (txt / json / log) — no app to vendor, so it is
  // a small renderer of our own. It reads the path from `__PI_OPEN_PATH__` (set
  // above) or the persisted pending path, which covers both the mount and the
  // reload-after-format-switch cases; nothing has to be replayed into it.
  await import('../text/main');
})();
