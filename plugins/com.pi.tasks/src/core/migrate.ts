/**
 * Bringing stored state up to the current schema.
 *
 * Runs on every load, but does nothing once `version` matches — the cost of
 * checking is a couple of property reads, and the alternative (a flag someone
 * has to remember to bump) is how stores drift.
 *
 * Two things changed in v2 and both had to be decided rather than computed:
 *
 * 1. Everything stored before v2 has NO workspace, because the plugin could not
 *    see one. Attributing it to "the workspace that was open at the time" would
 *    be inventing history, so it becomes **global** — visible in the 全部 view,
 *    assignable by the user, and never lost.
 * 2. `completedAt` used to be keyed by the occurrence alone. Every undated
 *    item's occurrence key is the constant `'once'`, so those entries collided.
 *    The old key cannot say WHICH item it belonged to; `completions` can, so
 *    the migration asks it and drops the ones nobody can claim.
 *
 * Pure and dependency-free, so every case below is pinned by a test rather
 * than discovered by a user.
 */
import type { DayNote, Item, RunRecord, TasksState } from './types.js';
import { completionKey } from './triggers.js';

export const STATE_VERSION = 2;

export function emptyState(): TasksState {
  return { version: STATE_VERSION, items: [], runs: [], notes: {}, completedAt: {} };
}

/** A v1 note: the text lives directly on the value. */
export function isDayNote(value: unknown): value is DayNote {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as DayNote).text === 'string'
  );
}

export interface MigrationResult {
  state: TasksState;
  /** True when anything was rewritten, so the caller knows to persist. */
  changed: boolean;
}

export function migrateState(saved: unknown): MigrationResult {
  const raw = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const version = typeof raw.version === 'number' ? raw.version : 1;

  const items = Array.isArray(raw.items) ? (raw.items as Item[]) : [];
  const runs = Array.isArray(raw.runs) ? (raw.runs as RunRecord[]) : [];

  // ── notes: v1 `day → DayNote`, v2 `day → scope → DayNote` ──
  const rawNotes =
    raw.notes && typeof raw.notes === 'object' ? (raw.notes as Record<string, unknown>) : {};
  const notes: Record<string, Record<string, DayNote>> = {};
  let changed = version !== STATE_VERSION;
  for (const [day, value] of Object.entries(rawNotes)) {
    if (isDayNote(value)) {
      notes[day] = { '': value };
      changed = true;
    } else if (value && typeof value === 'object') {
      notes[day] = value as Record<string, DayNote>;
    }
  }

  // ── completedAt: v1 `occurrenceKey`, v2 `itemId|occurrenceKey` ──
  const rawCompleted =
    raw.completedAt && typeof raw.completedAt === 'object'
      ? (raw.completedAt as Record<string, string>)
      : {};
  const completedAt =
    version < STATE_VERSION ? migrateCompletions(items, rawCompleted) : rawCompleted;

  const state: TasksState = {
    version: STATE_VERSION,
    items,
    runs,
    notes,
    completedAt,
    lastTickAt: typeof raw.lastTickAt === 'string' ? raw.lastTickAt : undefined,
  };
  return { state, changed };
}

/**
 * Re-key completion timestamps onto their item.
 *
 * `completions` on each item already says which occurrences were completed —
 * the old timestamp only adds *when*. So each old key is attributed to the one
 * item that claims it.
 *
 * Several claimants means the old data genuinely cannot say (two undated
 * to-dos both on `'once'`); those are dropped rather than guessed. That loses
 * only "this was finished on that day" from the day page — the item's done
 * state lives in `completions` and is untouched.
 */
export function migrateCompletions(
  items: Item[],
  old: Record<string, string>,
): Record<string, string> {
  const claimants = new Map<string, string[]>();
  for (const item of items) {
    for (const key of item.completions ?? []) {
      const list = claimants.get(key);
      if (list) list.push(item.id);
      else claimants.set(key, [item.id]);
    }
  }

  const next: Record<string, string> = {};
  for (const [key, at] of Object.entries(old)) {
    const owners = claimants.get(key);
    if (owners?.length === 1) next[completionKey(owners[0], key)] = at;
  }
  return next;
}
