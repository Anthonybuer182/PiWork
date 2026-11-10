/**
 * GenOffice's AI surface, answered by the host agent instead of theirs.
 *
 * Three vendored modules are aliased here (see `aiPanelSwap` in
 * scripts/build-panel.mjs):
 *
 *   `ai/AiPanel`     — the sidebar of docs / slides / pdf
 *   `ai/AiChatPanel` — sheets' sidebar, a *different* component
 *   `ai/transport`   — sheets only, and inert (see shims/ai-transport.ts)
 *
 * ## What this file is for
 *
 * The sidebar itself stays gone: the host already has one conversation surface,
 * and a second chat inside a document panel is the "two products stacked"
 * problem. What must NOT go with it is the *submission* path — GenOffice's
 * panels were the consumer of every AI action in these apps, so removing them
 * silently disconnected the selection popover and the ribbon presets. Those are
 * worth keeping: they carry a selection the user made on purpose.
 *
 * So this module re-implements the one thing the missing panels did that
 * mattered — and does it the way the host wants: forward the text to
 * `chat.send`, the same capability the composer uses, so an action taken here
 * behaves exactly like a message the user typed.
 *
 * ## Carrying the context the instruction is missing
 *
 * An instruction like "把选中的这句改得更正式" is not actionable on its own —
 * the agent has no document in front of it. Verified live: forwarded bare, the
 * agent answers "我看不到你选中的是哪句话" and asks for the file and the text.
 *
 * The fix needs no vendor change, because the props carry everything — each app
 * just carries it somewhere different, and none of them as a selection prop:
 *
 *   - docs gives `AiPanel` the tiptap `editor`, so this module can read exactly
 *     what the popover reads: `editor.state.selection`.
 *   - pdf gives it `api`, whose `selection()` returns the current range.
 *   - slides inlines the selected elements into the preset text it sends, ids
 *     and all, so there is nothing left to look up.
 *
 * All three also pass `filePath`, which the agent needs to open anything at all.
 *
 * The excerpt is read at submit time, and *also* cached on every commit or
 * `selectionUpdate`, because the two are not reliably the same instant: the
 * popover's own close path touches the editor and takes focus, and a submission
 * lands after that. Preferring the live value and falling back to the last
 * non-empty one means the excerpt survives either way. (The DOM selection is
 * useless here — measured empty at submit time, while ProseMirror still held the
 * range, and pdf clears its own `aiSelection` on the same collapse.)
 *
 * ## Two paths, and why both are watched
 *
 * `preset` is "立即发送": docs / slides / pdf all funnel their AI actions
 * through this one prop, each carrying a `nonce` that changes per request.
 *
 * `editQueue` is "加入队列" — and the Enter key. The queue was a *deferred*
 * batch, run later from a control in the sidebar this module removed, so with
 * the sidebar gone every queued instruction went nowhere. Forwarding on add
 * turns that dead end back into a submission, and consuming the item afterwards
 * keeps the queue's own machinery honest (see the note at the consume call).
 * docs' queue items arrive with their own `capturedText`, so there the excerpt
 * comes for free.
 *
 * sheets is on neither path: its actions go through its own `handleSend`, so it
 * gets its own watcher below.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** GenOffice stamps this on revisions its AI made. The host agent's edits are
 *  not GenOffice revisions, but docs' App.tsx imports it unconditionally. */
export const AI_REVISION_AUTHOR = 'AI Assistant';

/**
 * Upstream exports this beside `AiPanel` (it resolves the Settings user name).
 * docs' App.tsx imports the pair from `./ai/AiPanel`, which this module
 * replaces, so the export has to exist here too. There is no GenOffice Settings
 * user to read — the host agent is the author.
 */
export function aiRevisionAuthor(): string {
  return AI_REVISION_AUTHOR;
}

/** The host agent, reached exactly the way the composer reaches it. */
function sendToHost(text: string): void {
  const sdk = (window as unknown as {
    piSDK?: { request: (method: string, params?: unknown) => Promise<unknown> };
  }).piSDK;
  if (!sdk) return;
  void sdk.request('chat.send', { text }).catch(() => undefined);
}

/** Just enough of tiptap's Editor to read a selection, so this file does not
 *  depend on the vendored types. */
interface ProseMirrorish {
  state?: {
    selection?: { from: number; to: number; empty?: boolean };
    doc?: { textBetween: (a: number, b: number, sep: string, leaf: string) => string };
  };
  on?: (event: string, handler: () => void) => void;
  off?: (event: string, handler: () => void) => void;
}

/** The selected text, or '' when there is nothing to read. */
function readExcerpt(editor: unknown): string {
  const state = (editor as ProseMirrorish | undefined)?.state;
  const { selection, doc } = state ?? {};
  if (!selection || !doc || selection.empty) return '';
  try {
    return doc.textBetween(selection.from, selection.to, ' ', ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return ''; // positions can be transiently unmappable mid-transaction
  }
}

/**
 * pdf's current selection, which it publishes through the `api` prop
 * (`selection: () => aiSelection`).
 *
 * pdf has neither a tiptap editor nor a selection event, so this is the only
 * reading available — and it has to be *polled*, not read at submit time. By the
 * time a submission fires the selection is normally gone: the popover's input
 * takes focus, the document selection collapses, and pdf clears `aiSelection`
 * when that happens. That is precisely why pdf's own popover captures the
 * excerpt into state when it opens.
 *
 * slides needs none of this: it inlines the selected elements into the preset
 * text it sends (`buildSelectionInstruction`), ids included.
 */
function readPdfExcerpt(props: Record<string, unknown>): string {
  const api = props.api as { selection?: () => unknown } | undefined;
  const selection = api?.selection?.() as { text?: unknown } | null | undefined;
  return typeof selection?.text === 'string'
    ? selection.text.replace(/\s+/g, ' ').trim()
    : '';
}

/**
 * The instruction, wrapped so the agent knows what it is looking at.
 *
 * Plain prose rather than a JSON envelope: this lands in the conversation as a
 * user message, and the agent reads the path and the quote the same way it
 * reads anything else the user says. The labels are only added when there is
 * something behind them, so an instruction with no context still reads as a
 * normal sentence.
 */
function composeMessage(instruction: string, filePath: string, excerpt: string): string {
  const lines: string[] = [];
  if (filePath) lines.push(`文件：${filePath}`);
  if (excerpt) lines.push(`选中内容：${excerpt}`);
  lines.push(`指令：${instruction}`);
  if (lines.length === 1) return instruction;
  return `[来自文件查看器]\n${lines.join('\n')}`;
}

/**
 * Everything a submission might carry, as either path supplies it.
 *
 * The two apps' queue items do not agree on shape. docs carries the selected
 * text (`capturedText`); slides carries element references instead, because its
 * selections are canvas elements rather than a text range — so the closest
 * thing to an excerpt there is the slide the elements sit on.
 */
interface Submission {
  instruction?: unknown;
  /** docs: the text snapshot taken when the selection was annotated. */
  capturedText?: unknown;
  /** docs identifies a queue item by `qid`, slides by `key`. */
  qid?: unknown;
  key?: unknown;
  /** slides: where the annotated elements are. */
  slideIndex?: unknown;
}

/** A queue item's identity, whichever name that app uses. */
function queueId(item: Submission): unknown {
  return item?.qid ?? item?.key;
}

/** The context a queue item carries on its own, if any. */
function queueExcerpt(item: Submission): string {
  if (typeof item?.capturedText === 'string' && item.capturedText.trim()) {
    return item.capturedText.trim();
  }
  if (typeof item?.slideIndex === 'number') return `第 ${item.slideIndex + 1} 张幻灯片上选中的元素`;
  return '';
}

/**
 * docs / slides / pdf sidebar. Renders nothing; forwards submissions.
 *
 * Each app exposes its selection differently, and none of them passes it as a
 * prop: docs via the tiptap `editor`, pdf via `api.selection()`, slides by
 * inlining it into the preset text. The three readers below cover exactly that,
 * and each app only ever hits its own.
 */
export function AiPanel(props: Record<string, unknown>): ReactNode {
  const editor = props.editor;
  const filePath = typeof props.filePath === 'string' ? props.filePath : '';

  // The last non-empty selection seen, as a fallback for readExcerpt's live read.
  const lastExcerpt = useRef('');
  useEffect(() => {
    const ed = editor as ProseMirrorish | undefined;
    if (!ed?.on || !ed.off) return;
    const capture = (): void => {
      const text = readExcerpt(ed);
      if (text) lastExcerpt.current = text;
    };
    ed.on('selectionUpdate', capture);
    return () => ed.off?.('selectionUpdate', capture);
  }, [editor]);

  // pdf's, recorded on every commit — see readPdfExcerpt for why it cannot wait
  // until submit. Deliberately NOT cleared after a send: it holds the most
  // recent real selection, so asking twice about the same one still works.
  const lastPdfExcerpt = useRef('');
  useLayoutEffect(() => {
    const text = readPdfExcerpt(props);
    if (text) lastPdfExcerpt.current = text;
  });

  const liveExcerpt = (): string =>
    readExcerpt(editor) || readPdfExcerpt(props) || lastPdfExcerpt.current || lastExcerpt.current;

  // ── 立即发送: the preset prop ─────────────────────────────────────────
  const preset = props.preset as { text?: string; nonce?: number } | undefined;
  const nonce = preset?.nonce;
  const text = typeof preset?.text === 'string' ? preset.text.trim() : '';
  // The nonce is what identifies a request; a re-render must not resend one.
  const sentRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (nonce === undefined || nonce === sentRef.current || !text) return;
    sentRef.current = nonce;
    sendToHost(composeMessage(text, filePath, liveExcerpt()));
    lastExcerpt.current = '';
  }, [nonce, text, filePath]);

  // ── 加入队列: the editQueue prop ──────────────────────────────────────
  // Forwarded on ADD only. An update to an already-forwarded item would be a
  // second message about the same edit, and the queue's own review UI — the
  // place an update was meant to be read from — is the sidebar this module
  // replaced.
  const queue = props.editQueue as readonly Submission[] | undefined;
  const consume = props.onQueueConsume as ((ids: readonly unknown[]) => void) | undefined;
  const queuedRef = useRef<Set<unknown> | null>(null);

  useEffect(() => {
    if (!Array.isArray(queue)) return;
    // Baseline on first sight: mounting must not replay an existing queue.
    if (queuedRef.current === null) {
      queuedRef.current = new Set(queue.map(queueId));
      return;
    }
    for (const item of queue) {
      const id = queueId(item);
      if (id === undefined || queuedRef.current.has(id)) continue;
      queuedRef.current.add(id);
      const instruction = typeof item?.instruction === 'string' ? item.instruction.trim() : '';
      if (!instruction) continue;
      sendToHost(composeMessage(instruction, filePath, queueExcerpt(item)));
      // Hand the item back the way a finished run would. It is NOT optional
      // bookkeeping: a queued item carries a visible highlight in the document
      // (`.ai-queue-anchor`) and nothing else in this build ever consumes the
      // queue — the run control lived in the removed sidebar — so without this
      // every "加入队列" would leave a permanent highlight with no way to clear
      // it. The instruction has been delivered; the queue has no further use
      // for it.
      consume?.([id]);
    }
  }, [queue, filePath, consume]);

  return null;
}

/**
 * sheets sidebar. Its actions arrive as chat entries, not as a preset.
 *
 * The entry's text field is `text`, not `content` — `AiChatMessage` is
 * `{ role, text, tools, ... }` in `sheets/renderer/ai/AiChatPanel.tsx`. Reading
 * `content` here silently matched nothing, which is worth remembering: a watcher
 * that forwards on a field name looked exactly like a working one.
 */
export function AiChatPanel(props: Record<string, unknown>): ReactNode {
  const chat = props.chat as readonly { role?: string; text?: unknown }[] | undefined;
  // Start at the current length so mounting does not replay the history.
  const forwardedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Array.isArray(chat)) return;
    if (forwardedRef.current === null) {
      forwardedRef.current = chat.length;
      return;
    }
    for (let i = forwardedRef.current; i < chat.length; i++) {
      const entry = chat[i];
      if (entry?.role !== 'user' || typeof entry.text !== 'string') continue;
      const text = entry.text.trim();
      if (text) sendToHost(text);
    }
    forwardedRef.current = chat.length;
  }, [chat]);

  return null;
}

/** pdf takes the brand mark from `ai/AiPanel` for its own header. There is
 *  nothing to draw here: the Genspark brand is not ours to show. */
export function GensparkMark(_props: { size?: number }): ReactNode {
  return null;
}

/**
 * Re-implemented rather than stubbed to an empty string: sheets' `App.tsx:2928`
 * calls this to label an AI-scope card, and that call site is compiled as
 * vendored. Returning "" would leave an unlabelled card; returning the same
 * string upstream does keeps that path inert instead of broken.
 */
export function scopeLabel(
  range: string,
  columns: readonly string[] | null,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (columns?.length === 1) return t('aiScopeColumn', { name: columns[0] ?? '' });
  if (columns && columns.length > 1) {
    return t('aiScopeColumns', { names: columns.join(', '), count: columns.length });
  }
  return t('aiScopeRange', { range });
}
