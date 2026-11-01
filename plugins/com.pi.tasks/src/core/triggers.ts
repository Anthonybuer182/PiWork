/**
 * When things fire.
 *
 * The whole engine is one question, asked every tick: *which firings fall in
 * `(from, to]`, and which of those did we already handle?* Everything about
 * missed runs, sleep/wake and restart recovery falls out of answering it with
 * a stored `from` instead of assuming `from = now - 30s`.
 *
 * Not firing on time is the failure mode a user notices, so the two rules that
 * protect against it get their own paragraphs:
 *
 * - **Nothing fires twice.** Every firing has a stable key, and a firing whose
 *   key is already in the run history is skipped. This is what makes it safe
 *   for a tick and a boot-time catch-up to overlap, and for a re-run to be
 *   triggered by hand.
 * - **A stale firing is recorded, not performed.** Eight hours of backlogged
 *   notifications is noise, and eight backlogged agent prompts is worse. Past
 *   the grace window a firing is written down as `missed` for the user to
 *   re-run deliberately.
 */
import type { Item, Occurrence, Trigger } from './types.js';
import { ONCE, expandOccurrences, occurrenceKey } from './recur.js';

/**
 * How late a firing may still run normally.
 *
 * Sized to swallow tick jitter and a short sleep, not to catch up on a night.
 * Anything older is recorded as `missed` instead — see the header.
 */
export const GRACE_MS = 2 * 60_000;

/**
 * Ceiling on occurrences expanded per item per tick.
 *
 * A `FREQ=SECONDLY` rule (or a hand-written one) evaluated across a long
 * downtime would otherwise expand without bound and stall the timer that every
 * *other* item depends on. Hitting this is reported, not swallowed.
 */
export const MAX_OCCURRENCES = 2000;

/** Stable identity of one firing. Also the idempotency key. */
export function runKey(itemId: string, occKey: string, triggerId: string): string {
  return `${itemId}|${occKey}|${triggerId}`;
}

/**
 * Key for "when was this occurrence completed".
 *
 * The item id is part of it because every undated item's occurrence key is the
 * constant `'once'` — keying by occurrence alone made them share one entry,
 * so ticking one off overwrote another's timestamp and un-ticking one erased
 * them all.
 */
export function completionKey(itemId: string, occKey: string): string {
  return `${itemId}|${occKey}`;
}

/** When this trigger fires for this occurrence. */
export function fireAt(occurrence: Occurrence, trigger: Pick<Trigger, 'offsetMinutes'>): Date | null {
  if (!occurrence.at) return null;
  return new Date(occurrence.at.getTime() + trigger.offsetMinutes * 60_000);
}

export interface DueRun {
  item: Item;
  occurrence: Occurrence;
  trigger: Trigger;
  fireAt: Date;
  key: string;
}

export interface DueResult {
  /** Fire these now. */
  toFire: DueRun[];
  /** Their moment passed while we were not running. Record, don't perform. */
  missed: DueRun[];
  /** Items whose expansion hit `MAX_OCCURRENCES` — surfaced so it is never silent. */
  truncated: string[];
}

/**
 * Every firing that falls in `(from, to]`, split into fire-now and missed.
 *
 * `alreadyRun` holds run keys (see `runKey`); anything in it is skipped, which
 * is what makes repeat calls idempotent.
 */
export function dueRuns(
  items: Item[],
  alreadyRun: ReadonlySet<string>,
  from: Date,
  to: Date,
  now: Date = to,
  graceMs: number = GRACE_MS,
): DueResult {
  const toFire: DueRun[] = [];
  const missed: DueRun[] = [];
  const truncated: string[] = [];

  for (const item of items) {
    if (!item.start) continue;
    const triggers = item.triggers.filter((t) => t.enabled);
    if (triggers.length === 0) continue;

    // Widen the occurrence window by the trigger offsets.
    //
    // A trigger is anchored to an occurrence but fires at `occurrence + offset`,
    // so an occurrence just outside `(from, to]` can still have a firing inside
    // it. Searching occurrences over `(from - maxOffset, to - minOffset]` is
    // exactly the preimage of `(from, to]` under every offset in play — no
    // wider, so it costs nothing, and no narrower, so nothing is missed.
    const offsets = triggers.map((t) => t.offsetMinutes);
    const maxOffset = Math.max(...offsets);
    const minOffset = Math.min(...offsets);
    const searchFrom = new Date(from.getTime() - maxOffset * 60_000);
    const searchTo = new Date(to.getTime() - minOffset * 60_000);

    const occurrences = expandOccurrences(item, searchFrom, searchTo);
    if (occurrences.length >= MAX_OCCURRENCES) truncated.push(item.id);

    for (const occurrence of occurrences) {
      // A completed occurrence is done; its reminders have nothing left to say.
      if (occurrence.key !== undefined && item.completions.includes(occurrence.key)) continue;

      for (const trigger of triggers) {
        const at = fireAt(occurrence, trigger);
        if (!at) continue;
        const t = at.getTime();
        if (t <= from.getTime() || t > to.getTime()) continue;

        const key = runKey(item.id, occurrence.key, trigger.id);
        if (alreadyRun.has(key)) continue;

        const run: DueRun = { item, occurrence, trigger, fireAt: at, key };
        if (t < now.getTime() - graceMs) missed.push(run);
        else toFire.push(run);
      }
    }
  }

  // Oldest first, so a catch-up reads in the order things were supposed to happen.
  const byTime = (a: DueRun, b: DueRun): number => a.fireAt.getTime() - b.fireAt.getTime();
  toFire.sort(byTime);
  missed.sort(byTime);

  return { toFire, missed, truncated };
}

/**
 * The next moment this item will do something, or null.
 *
 * Looks ahead far enough to find the next firing of a long-period rule (a
 * yearly item is ~365 days out), without walking an unbounded rule forward
 * indefinitely.
 */
export function nextTriggerAt(item: Item, now: Date): Date | null {
  if (!item.start) return null;
  const triggers = item.triggers.filter((t) => t.enabled);
  if (triggers.length === 0) return null;

  const offsets = triggers.map((t) => t.offsetMinutes);
  const maxOffset = Math.max(...offsets);

  // One year ahead covers yearly rules with room for a before/after offset.
  const horizon = new Date(now.getTime() + 400 * 86_400_000);
  const occurrences = expandOccurrences(
    item,
    new Date(now.getTime() - (maxOffset + 1) * 60_000),
    horizon,
  );

  let best: Date | null = null;
  for (const occurrence of occurrences) {
    if (item.completions.includes(occurrence.key)) continue;
    for (const trigger of triggers) {
      const at = fireAt(occurrence, trigger);
      if (!at || at.getTime() <= now.getTime()) continue;
      if (!best || at.getTime() < best.getTime()) best = at;
    }
  }
  return best;
}

/**
 * The soonest moment anything will fire, across every item.
 *
 * Used to wake the engine at the right instant instead of on a fixed poll. A
 * fixed 30-second tick means a reminder can land up to 30 seconds late, which
 * is exactly the kind of sloppiness a scheduler should not have — and it is
 * free to avoid, since the next fire time is already computable.
 */
export function nextFireAcrossItems(items: Item[], now: Date): Date | null {
  let best: Date | null = null;
  for (const item of items) {
    const next = nextTriggerAt(item, now);
    if (next && (!best || next.getTime() < best.getTime())) best = next;
  }
  return best;
}

/** Whether an item is done *for a given occurrence* — the per-occurrence rule, in one place. */
export function isDone(item: Item, occurrenceKeyValue: string): boolean {
  return item.completions.includes(occurrenceKeyValue);
}

/**
 * The occurrence a plain done-toggle applies to: the item's own single
 * occurrence for a one-off, or the one nearest `now` for a repeating item.
 */
export function currentOccurrenceKey(item: Item, now: Date): string {
  if (!item.start) return ONCE;
  if (!item.rrule) return occurrenceKey(new Date(item.start));

  // Nearest occurrence at or before `now`; if the series starts later, that one.
  const past = expandOccurrences(item, new Date(now.getTime() - 400 * 86_400_000), now);
  if (past.length > 0) return past[past.length - 1]!.key;
  const upcoming = expandOccurrences(item, now, new Date(now.getTime() + 400 * 86_400_000));
  return upcoming[0]?.key ?? occurrenceKey(new Date(item.start));
}

/** Human summary of a trigger, e.g. `提前 15 分钟 · 系统通知`. */
export function describeTrigger(trigger: Trigger): string {
  const when =
    trigger.offsetMinutes === 0
      ? '到点时'
      : trigger.offsetMinutes < 0
        ? `提前 ${formatSpan(-trigger.offsetMinutes)}`
        : `之后 ${formatSpan(trigger.offsetMinutes)}`;
  const what = trigger.action.kind === 'notify' ? '系统通知' : '让 agent 干活';
  return `${when} · ${what}`;
}

function formatSpan(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
