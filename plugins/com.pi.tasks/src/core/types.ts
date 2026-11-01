/**
 * One record, three shapes.
 *
 * There is no `kind` field, and that is deliberate. A to-do, a calendar event
 * and a scheduled job are the same thing — something to do at some point —
 * differing only in whether it has a time, whether that time repeats, and
 * whether reaching it fires an action. Modelling them as one type is what
 * makes "mark done" mean the same thing everywhere and lets a plain to-do
 * grow a due time without being recreated.
 */

/** A single thing to do. */
export interface Item {
  id: string;
  title: string;
  note?: string;
  createdAt: string;

  /**
   * The workspace this belongs to — `Workspace.id`, which is the absolute
   * directory path. Absent means **global**: not part of any project ("交房租",
   * "每周一整理待办"). That absence is the whole distinction; there is no
   * separate flag.
   *
   * Treated as an opaque string here. The display label is the basename, which
   * is exactly as stable as the id itself (both break if the folder is moved).
   */
  workspaceId?: string;

  /** Local ISO with offset. Absent = a plain to-do with no time at all. */
  start?: string;
  /** Local ISO with offset. Optional even when `start` is set. */
  end?: string;
  allDay?: boolean;

  /**
   * The RRULE *body* only — `FREQ=WEEKLY;BYDAY=MO`, never a `DTSTART:` line.
   *
   * This is not a style choice. `RRule.fromString('DTSTART:20260928T090000\n...')`
   * parses that stamp as **UTC**, so a 09:00 weekly item expands to 17:00 in
   * UTC+8 — and a monthly one can shift a whole day while still looking
   * plausible. The expansion therefore builds the rule with an explicit local
   * `dtstart` derived from `start` (see `recur.ts`). Keeping the two fields
   * apart is what makes that impossible to get wrong by accident.
   */
  rrule?: string;

  /**
   * Occurrence keys already completed — see `occurrenceKey`.
   *
   * Per-occurrence rather than a single boolean: completing this Monday's
   * standup must not tick off next Monday's. A plain to-do has exactly one
   * occurrence, so it behaves like a boolean to anyone who never repeats
   * anything.
   */
  completions: string[];

  /** Only meaningful when `start` is set — with no time there is nothing to fire against. */
  triggers: Trigger[];
}

/** What to do when an item's moment arrives. */
export interface Trigger {
  id: string;
  /**
   * Minutes relative to the occurrence, not an absolute time.
   * `-15` fires 15 minutes before, `0` at the moment, `30` half an hour after.
   *
   * Relative is the only form that survives repetition: "every Monday 9:00,
   * remind me 15 minutes before" cannot be written as a fixed timestamp.
   */
  offsetMinutes: number;
  action: TriggerAction;
  enabled: boolean;
}

export type TriggerAction =
  /** A desktop notification. Always deliverable — main shows it, no renderer needed. */
  | { kind: 'notify'; title?: string }
  /** Text put into the conversation, exactly as typing it would. Needs a live window. */
  | { kind: 'agent'; prompt: string };

/** One occurrence of an item — a repeating item has many. */
export interface Occurrence {
  itemId: string;
  /** Stable identity of this occurrence; see `occurrenceKey`. */
  key: string;
  /** Absent for an item with no time. */
  at?: Date;
}

/**
 * Why a firing did or did not happen. Every value is a distinct thing a reader
 * would act on differently, so they are never collapsed into "ok"/"error".
 */
export type RunStatus =
  /** Fired on time. */
  | 'ok'
  /** Its moment passed while the app was not running. Not fired; offered for re-run. */
  | 'missed'
  /**
   * It fired, but an `agent` action never reached the conversation — the window
   * was closed, or nothing was there to receive it.
   *
   * Separate from `failed` on purpose: this is a situation, not a defect, and
   * the user's response is the same as for `missed` (re-run it when convenient).
   */
  | 'undelivered'
  /** The action itself threw — a notification that could not be shown, say. */
  | 'failed';

/** One line in the run history shown by the panel's 记录 view. */
export interface RunRecord {
  /** `${itemId}|${occurrenceKey}|${triggerId}` — also the idempotency key. */
  key: string;
  itemId: string;
  /** Denormalised: the history must still read correctly after the item is deleted. */
  itemTitle: string;
  occurrenceKey: string;
  triggerId: string;
  /** When it was supposed to fire. */
  dueAt: string;
  /** When it actually ran. Absent for `missed`. */
  firedAt?: string;
  action: TriggerAction['kind'];
  status: RunStatus;
  /** Human-readable outcome or error. */
  detail?: string;
}

/**
 * What the user wrote about a day.
 *
 * One block of free text per day, and nothing else — no mood, no tags, no
 * rating. Those are the fields that turn a daily note into a form you stop
 * filling in; the whole reason this exists is that writing two lines has to be
 * effortless enough to survive a busy week.
 */
export interface DayNote {
  text: string;
  /** Last edit, local ISO. */
  updatedAt: string;
}

/** The whole persisted state, as stored under one `storage` key. */
export interface TasksState {
  /**
   * Schema version. Absent (or 1) means the pre-workspace layout, which
   * `migrate()` upgrades on load — see `backend/index.ts`.
   */
  version: number;
  items: Item[];
  runs: RunRecord[];
  /**
   * Free text per day, per scope: `notes[YYYY-MM-DD][scopeKey]`.
   *
   * Nested rather than `"${scopeKey}|${day}"` because a workspace id is a
   * filesystem path and can contain any separator we might pick.
   * `scopeKey` is `''` for global, otherwise the workspace id.
   */
  notes: Record<string, Record<string, DayNote>>;
  /**
   * When each completion happened, keyed by `${itemId}|${occurrenceKey}`.
   *
   * `completions` alone cannot answer "what did I finish today" for an item
   * with no time: its occurrence key is the constant `'once'`, which carries no
   * date at all. Without this, ticking off an undated to-do would leave no
   * trace on any day, and the day page — whose entire job is "what did I
   * actually do" — would quietly omit them.
   *
   * The item id is part of the key, not decoration: every undated item's
   * occurrence key is `'once'`, so keying by occurrence alone made all of them
   * share one timestamp — completing one overwrote the others, un-completing
   * one erased them all.
   */
  completedAt: Record<string, string>;
  /**
   * Upper bound of the last evaluation window. The trigger engine only ever
   * looks at `(lastTickAt, now]`, which is what makes a laptop that was asleep
   * for eight hours reconcile in one pass instead of firing eight hours of
   * backlog — see `triggers.ts`.
   */
  lastTickAt?: string;
}
