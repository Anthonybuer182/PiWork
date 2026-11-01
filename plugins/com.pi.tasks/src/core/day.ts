/**
 * One page per day: what was planned, what actually got done, what was missed,
 * and whatever the user wrote.
 *
 * The top half is assembled entirely from data the plugin already had — no
 * input required. That is the point. A day page that opens as a blank box is a
 * page nobody opens twice; one that already lists "you finished these two
 * things" only needs a sentence added to it.
 *
 * Pure, and taking `day` as a string rather than a Date, so every boundary case
 * (an entry written at 00:30, an undated to-do finished today, a reminder that
 * came due on that day) can be pinned in a test instead of waited for.
 */
import type { DayNote, Item, RunRecord } from './types.js';
import { expandOccurrences } from './recur.js';
import { completionKey } from './triggers.js';
import { dayEnd, dayKey, dayStart, toLocalIso } from './time.js';

/** One occurrence of an item, as it appears on a day page. */
export interface DayEntry {
  itemId: string;
  title: string;
  /** Occurrence key — the identity a completion is recorded against. */
  key: string;
  /** Absent for an item with no time. */
  at?: string;
  repeat: boolean;
  /** Absent = a global item. The page shows it; the filter decides. */
  workspaceId?: string;
}

export interface DayPage {
  /** `YYYY-MM-DD` */
  day: string;
  /** Occurrences falling on this day that are not yet done. */
  planned: DayEntry[];
  /** Everything finished on this day, whether or not it had a time. */
  done: DayEntry[];
  /** Firings this day that never happened, still awaiting a decision. */
  missed: RunRecord[];
  /**
   * What was written that day, per scope: `''` for global, else a workspace id.
   *
   * Kept per scope rather than merged: two projects' notes for the same date
   * are different sentences about different work, and overwriting one with the
   * other would be silent data loss.
   */
  notes: Record<string, DayNote>;
}

const MISSED_STATUSES = new Set(['missed', 'undelivered']);

/**
 * Assemble the page for `day`.
 *
 * Completion is judged two ways on purpose:
 *
 * - A dated occurrence counts as done when its key is in `completions`.
 * - An item with **no time** has the constant key `'once'`, which carries no
 *   date, so `completedAt` is what places it on a day. Without that second
 *   path, every undated to-do the user ticked off would be missing from the
 *   one view whose job is to show what they did.
 */
export function buildDayPage(
  items: Item[],
  runs: RunRecord[],
  notes: Record<string, Record<string, DayNote>>,
  completedAt: Record<string, string>,
  day: string,
): DayPage {
  const start = dayStart(day);
  const end = dayEnd(day);
  const planned: DayEntry[] = [];
  const done: DayEntry[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const repeats = Boolean(item.rrule);
    // `(start - 1ms, end]` so an occurrence at exactly 00:00 belongs to this day
    // rather than falling just outside a half-open window.
    const occurrences = expandOccurrences(item, new Date(start.getTime() - 1), end);

    for (const occ of occurrences) {
      const entry: DayEntry = {
        itemId: item.id,
        title: item.title,
        key: occ.key,
        at: occ.at ? toLocalIso(occ.at) : undefined,
        repeat: repeats,
        workspaceId: item.workspaceId,
      };
      seen.add(`${item.id}|${occ.key}`);
      if (item.completions.includes(occ.key)) done.push(entry);
      else planned.push(entry);
    }

    // Items with no time never expand to an occurrence above, so a completion
    // of one is only visible through its recorded completion timestamp.
    if (!item.start) {
      for (const key of item.completions) {
        const at = completedAt[completionKey(item.id, key)];
        if (!at || dayKey(new Date(at)) !== day) continue;
        if (seen.has(`${item.id}|${key}`)) continue;
        done.push({
          itemId: item.id,
          title: item.title,
          key,
          repeat: false,
          workspaceId: item.workspaceId,
        });
      }
    }
  }

  const missed = runs.filter(
    (r) => MISSED_STATUSES.has(r.status) && dayKey(new Date(r.dueAt)) === day,
  );

  // A day reads in the order things happened.
  const byTime = (a: DayEntry, b: DayEntry): number =>
    (a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0;
  planned.sort(byTime);
  done.sort(byTime);

  return { day, planned, done, missed, notes: notes[day] ?? {} };
}

/** Appearance of a day in the month grid: how much happened on it. */
export interface DayMark {
  planCount: number;
  doneCount: number;
  hasNote: boolean;
  missedCount: number;
}

/**
 * The marker shown in a month cell.
 *
 * `hasNote` is deliberately separate from the counts: a day you wrote about but
 * planned nothing for is still a day worth being able to find again, and it
 * would otherwise be indistinguishable from an empty one.
 */
export function dayMark(page: DayPage): DayMark {
  return {
    planCount: page.planned.length,
    doneCount: page.done.length,
    // Any scope: a day counts as "written about" if any project's note for it
    // has content. The month grid asks "is there something here", not "whose".
    hasNote: Object.values(page.notes).some((n) => Boolean(n.text?.trim())),
    missedCount: page.missed.length,
  };
}
