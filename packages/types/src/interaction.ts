/**
 * The agent's two interaction tools, shared by the enforcer and the renderer.
 *
 * Both tools live in the desktop main process (they are the only place that
 * can hold an agent turn open), and both surfaces are rendered by the shell —
 * but the tool names, the snapshot/request payloads and the size limits cross
 * that boundary. Defining them once here keeps the prompt, the validator and
 * the card from drifting apart.
 */

/** Replaces the current task's checklist. Non-blocking. */
export const TODO_TOOL_NAME = 'todotool';
/** Asks the user one to twenty questions and waits for the answer. Blocking. */
export const ASK_TOOL_NAME = 'asktool';

// ── todotool ──────────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export const TODO_STATUSES: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
];

export type TodoPriority = 'low' | 'medium' | 'high';

export const TODO_PRIORITIES: readonly TodoPriority[] = ['low', 'medium', 'high'];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
}

/**
 * A full replacement of one session's checklist, pushed after every call.
 *
 * `revision` is monotonic per session: a reloaded renderer can answer a sync
 * and a live push out of order, and the older one must not win.
 */
export interface TodoSnapshot {
  sessionId: string;
  todos: TodoItem[];
  revision: number;
  updatedAt: string;
  /**
   * The call that produced this snapshot. The card renders only on that call's
   * tool block, so a run that updates the list five times does not stack five
   * identical checklists in the transcript. Absent on snapshots written before
   * this field existed (they simply show no card until the next update).
   */
  toolCallId?: string;
}

export const MAX_TODO_ITEMS = 50;
/** Longer items are truncated by the host and the truncation is reported. */
export const MAX_TODO_CONTENT = 500;

// ── asktool ───────────────────────────────────────────────────────────

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** main → renderer: the agent turn is held open until this is answered. */
export interface AskRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskQuestion[];
  createdAt: string;
}

/**
 * One entry per question. `null` means "skipped" — the user moved past it, or
 * refused the whole card. An empty array is a multi-select with nothing ticked.
 */
export type AskAnswers = (string[] | null)[];

/** Minimum/asked limits, enforced in the tool before a card is ever shown. */
export const MAX_ASK_QUESTIONS = 20;
export const MAX_ASK_QUESTION_CHARS = 300;

/**
 * Marker the composer appends to a message that references skills from `/`.
 *
 * The block is model-only: the UI strips it from the bubble and from session
 * titles, which is why the marker lives here — three places match on it and
 * must not drift.
 */
export const SKILL_REFERENCE_MARKER = '[本条消息请使用这些技能]';

// ── tool catalog (Settings → 工具 and the composer picker) ─────────────

export type ToolSource = 'builtin' | 'host' | 'plugin';

/** One toggleable tool, as listed in settings and the composer. */
export interface ToolCatalogEntry {
  name: string;
  /** Short display label; the tool name itself for tools without one. */
  label: string;
  /** The model-facing description (used as a tooltip). */
  description: string;
  source: ToolSource;
  pluginId?: string;
  /** Plugin display name, for grouping in the settings page. */
  pluginName?: string;
  readOnly?: boolean;
}
