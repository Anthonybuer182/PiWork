/**
 * The scheduler's decision-making, on a fake clock.
 *
 * These are the assertions worth having, because every failure they catch is
 * silent in the app: a timezone shift still produces valid-looking dates, a
 * re-fired trigger looks like a duplicated notification, a missed occurrence
 * looks like nothing happening at all. None of that is visible by clicking
 * around, so it is pinned here instead.
 *
 * Expectations are built from local `new Date(y, m, d, h, …)` constructors, not
 * from hard-coded UTC strings, so the suite means the same thing in any
 * timezone — including the one that exposed the DTSTART bug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandOccurrences, nextOccurrence, parseRepeat, buildRRule, describeRepeat, alignStartToRule } from '../src/core/recur.js';
import { dueRuns, runKey, nextTriggerAt, nextFireAcrossItems, currentOccurrenceKey } from '../src/core/triggers.js';
import { parseWhen, normalizeRelative } from '../src/core/parse-when.js';
import { toLocalIso, dayKey, dayStart, formatOffset } from '../src/core/time.js';
import { buildDayPage, dayMark } from '../src/core/day.js';
import { migrateState, migrateCompletions, STATE_VERSION } from '../src/core/migrate.js';
import { completionKey } from '../src/core/triggers.js';
import type { Item, RunRecord, Trigger } from '../src/core/types.js';

// ── fixtures ──

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    title: 't',
    createdAt: toLocalIso(new Date(2026, 8, 1)),
    completions: [],
    triggers: [],
    ...over,
  };
}

function notify(offsetMinutes: number, id = 'tr1'): Trigger {
  return { id, offsetMinutes, action: { kind: 'notify' }, enabled: true };
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi, 0, 0);

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    key: 'k',
    itemId: 'i1',
    itemTitle: 't',
    occurrenceKey: 'once',
    triggerId: 'tr1',
    dueAt: toLocalIso(at(2026, 9, 30, 9, 0)),
    action: 'notify',
    status: 'missed',
    ...over,
  };
}

/**
 * A realistic tick: `(t - 30s, t + 30s]`, evaluated at its end.
 *
 * Tests that mean "this should fire" have to evaluate near the firing, not
 * hours later — `dueRuns` classifies anything older than the grace window as
 * missed on purpose, so an hour-late `now` asks a different question.
 */
function tick(t: Date): [Date, Date, Date] {
  const from = new Date(t.getTime() - 30_000);
  const to = new Date(t.getTime() + 30_000);
  return [from, to, to];
}

/**
 * `parseWhen` returns a result union; these narrow it for the assertions below
 * and turn a wrong-shaped result into a failure that names the input.
 */
function parseOk(text: string, now: Date) {
  const r = parseWhen(text, now);
  if (!r.ok) throw new Error(`expected "${text}" to parse, but it was refused: ${r.error}`);
  return r.value;
}

function parseErr(text: string, now: Date): string {
  const r = parseWhen(text, now);
  if (r.ok) throw new Error(`expected "${text}" to be refused, but it parsed to ${r.value.at}`);
  return r.error;
}

// ── local time is not UTC ──

test('a stored local time round-trips without shifting by the UTC offset', () => {
  // toISOString() here would turn 09:00 into 01:00 in UTC+8 — the same class of
  // bug as parsing DTSTART as UTC, and just as invisible.
  const d = at(2026, 9, 28, 9, 0);
  const iso = toLocalIso(d);
  assert.equal(new Date(iso).getTime(), d.getTime());
  assert.equal(new Date(iso).getHours(), 9);
  assert.match(iso, /^2026-09-28T09:00:00[+-]\d{2}:\d{2}$/);
});

test('a weekly rule expands at the local wall-clock hour, not the UTC one', () => {
  // RRule.fromString('DTSTART:20260928T090000\n...') reads that stamp as UTC and
  // yields 17:00 here. Building the rule from a local Date is the fix, so this
  // asserts the wall-clock hour survives.
  const it = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const occ = expandOccurrences(it, at(2026, 9, 1), at(2026, 10, 20));
  assert.ok(occ.length >= 4);
  for (const o of occ) {
    assert.equal(o.at!.getHours(), 9, 'expanded at the wrong hour');
    assert.equal(o.at!.getMinutes(), 0);
    assert.equal(o.at!.getDay(), 1, 'should only land on Mondays');
  }
});

test('a monthly rule keeps its day instead of drifting across midnight', () => {
  // An 8-hour UTC shift moves a 18:00 monthly item to 02:00 the NEXT day, which
  // still looks like a plausible "last Friday" — the reason this is asserted by
  // date, not just by hour.
  const it = item({ start: toLocalIso(at(2026, 9, 30, 18, 0)), rrule: 'FREQ=MONTHLY;BYDAY=-1FR' });
  const occ = expandOccurrences(it, at(2026, 9, 1), at(2026, 12, 31));
  assert.deepEqual(
    occ.map((o) => dayKey(o.at!)),
    ['2026-10-30', '2026-11-27', '2026-12-25'],
  );
});

// ── the (from, to] window ──

test('expansion is exclusive on the left and inclusive on the right', () => {
  // The engine re-evaluates (lastTickAt, now] every 30s. An inclusive left edge
  // would re-fire the boundary occurrence on every single tick.
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)) });
  const boundary = at(2026, 9, 30, 9, 0);

  // Occurrence sits exactly on the left edge → excluded.
  assert.equal(expandOccurrences(it, boundary, at(2026, 9, 30, 10, 0)).length, 0);
  // Occurrence sits exactly on the right edge → included.
  assert.equal(expandOccurrences(it, at(2026, 9, 30, 8, 0), boundary).length, 1);
  assert.equal(expandOccurrences(it, at(2026, 9, 30, 8, 0), boundary)[0]!.at!.getTime(), boundary.getTime());
  // Strictly inside → included.
  assert.equal(expandOccurrences(it, at(2026, 9, 30, 8, 0), at(2026, 9, 30, 9, 30)).length, 1);
});

test('an item with no time has no occurrences to fire', () => {
  assert.deepEqual(expandOccurrences(item(), at(2026, 9, 1), at(2026, 12, 31)), []);
});

// ── nothing fires twice ──

test('a firing already in the run history is never repeated', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), triggers: [notify(0)] });
  const [from, to, now] = tick(at(2026, 9, 30, 9, 0));

  const first = dueRuns([it], new Set(), from, to, now);
  assert.equal(first.toFire.length, 1);

  const second = dueRuns([it], new Set([first.toFire[0]!.key]), from, to, now);
  assert.equal(second.toFire.length, 0, 'the same firing ran twice');
});

test('the run key is stable across evaluations', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), triggers: [notify(0)] });
  const [f1, t1, n1] = tick(at(2026, 9, 30, 9, 0));
  const a = dueRuns([it], new Set(), f1, t1, n1);
  // A differently-shaped window that still contains the same firing must
  // produce the same key, or idempotency would depend on tick boundaries.
  const wide = at(2026, 9, 30, 9, 1);
  const b = dueRuns([it], new Set(), at(2026, 9, 30, 8, 30), wide, wide);
  assert.equal(a.toFire.length, 1);
  assert.equal(b.toFire.length, 1);
  assert.equal(a.toFire[0]!.key, b.toFire[0]!.key);
  assert.equal(a.toFire[0]!.key, runKey('i1', a.toFire[0]!.occurrence.key, 'tr1'));
});

test('a completed occurrence does not fire its reminder', () => {
  const start = toLocalIso(at(2026, 9, 30, 9, 0));
  const base = item({ start, rrule: 'FREQ=DAILY', triggers: [notify(0)] });
  const key = expandOccurrences(base, at(2026, 9, 1), at(2026, 10, 1))[0]!.key;
  const it = { ...base, completions: [key] };
  const result = dueRuns([it], new Set(), at(2026, 9, 1), at(2026, 10, 1), at(2026, 9, 1));
  assert.ok(!result.toFire.some((r) => r.occurrence.key === key), 'fired for a completed occurrence');
});

// ── triggers are relative to the occurrence ──

test('an offset trigger finds the occurrence it belongs to, outside the window', () => {
  // The occurrence is at 09:00 but the trigger fires at 08:45, so the search
  // has to widen by the offset. Without that the reminder never fires.
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), triggers: [notify(-15)] });
  const [from, to, now] = tick(at(2026, 9, 30, 8, 45));
  const result = dueRuns([it], new Set(), from, to, now);
  assert.equal(result.toFire.length, 1);
  assert.equal(result.toFire[0]!.fireAt.getHours(), 8);
  assert.equal(result.toFire[0]!.fireAt.getMinutes(), 45);
  // The occurrence itself is still at 09:00, not moved by the trigger.
  assert.equal(result.toFire[0]!.occurrence.at!.getHours(), 9);
});

test('a repeating reminder fires once per occurrence, not once per item', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=DAILY', triggers: [notify(0)] });
  const now = at(2026, 10, 2, 23, 59);
  const result = dueRuns([it], new Set(), at(2026, 9, 28, 0, 0), now, now);
  // Evaluated long after the fact, so all five are stale — what matters here is
  // that each day produced its own firing rather than one for the whole item.
  const all = [...result.toFire, ...result.missed];
  assert.equal(all.length, 5, 'Mon–Fri should give five firings');
  assert.equal(new Set(all.map((r) => r.key)).size, 5, 'firings must have distinct keys');
  assert.deepEqual(
    all.map((r) => dayKey(r.fireAt)),
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
  );
});

// ── sleep, quit, restart ──

test('eight hours asleep produces missed firings, not a burst of notifications', () => {
  // The whole point. Auto-firing the backlog at boot would spray eight hours of
  // notifications and could spend the user's credits on eight agent turns.
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), rrule: 'FREQ=HOURLY', triggers: [notify(0)] });
  const woke = at(2026, 9, 30, 17, 30);
  const result = dueRuns([it], new Set(), at(2026, 9, 30, 9, 0), woke, woke);

  assert.equal(result.toFire.length, 0, 'a stale firing must not be performed automatically');
  assert.equal(result.missed.length, 8, 'the backlog should be enumerated for the user to re-run');
  assert.ok(result.missed.every((r) => r.fireAt.getTime() < woke.getTime()));
  // And in the order they were supposed to happen.
  const times = result.missed.map((r) => r.fireAt.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('a firing inside the grace window still runs, so a slow tick is not a miss', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), triggers: [notify(0)] });
  const now = at(2026, 9, 30, 9, 1).getTime() + 30_000;
  const result = dueRuns([it], new Set(), at(2026, 9, 30, 8, 59), new Date(now), new Date(now));
  assert.equal(result.toFire.length, 1);
  assert.equal(result.missed.length, 0);
});

test('the same firing is not both fired and recorded as missed', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)), rrule: 'FREQ=HOURLY', triggers: [notify(0)] });
  const now = at(2026, 9, 30, 12, 30);
  const result = dueRuns([it], new Set(), at(2026, 9, 30, 9, 0), now, now);
  const fired = new Set(result.toFire.map((r) => r.key));
  assert.ok(result.missed.every((r) => !fired.has(r.key)));
  assert.equal(result.toFire.length + result.missed.length, 3);
});

test('a runaway rule is flagged rather than left to stall the tick', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 0, 0)), rrule: 'FREQ=SECONDLY', triggers: [notify(0)] });
  const result = dueRuns([it], new Set(), at(2026, 9, 30, 0, 0), at(2026, 10, 1, 0, 0), at(2026, 10, 1, 0, 0));
  assert.deepEqual(result.truncated, ['i1'], 'truncation must be reported, not silent');
});

// ── per-occurrence completion ──

test('completing today does not complete tomorrow', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=DAILY', triggers: [notify(0)] });
  const monday = currentOccurrenceKey(it, at(2026, 9, 28, 10, 0));
  const tuesday = currentOccurrenceKey(it, at(2026, 9, 29, 10, 0));
  assert.notEqual(monday, tuesday, 'a repeating item must key each day separately');

  const doneMonday = { ...it, completions: [monday] };
  assert.ok(doneMonday.completions.includes(monday));
  assert.ok(!doneMonday.completions.includes(tuesday), 'Monday ticked off Tuesday');
});

test('completion keys for a one-off are stable and start-anchored', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 30, 9, 0)) });
  assert.equal(currentOccurrenceKey(it, at(2026, 9, 1)), expandOccurrences(it, at(2026, 8, 1), at(2026, 10, 1))[0]!.key);
  assert.equal(currentOccurrenceKey(item(), at(2026, 9, 1)), 'once');
});

// ── next-firing lookahead ──

test('the next firing is reported for a rule with no end', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=WEEKLY;BYDAY=MO', triggers: [notify(-30)] });
  const next = nextTriggerAt(it, at(2026, 9, 29, 12, 0));
  assert.ok(next);
  assert.equal(dayKey(next!), '2026-10-05');
  assert.equal(next!.getHours(), 8);
  assert.equal(next!.getMinutes(), 30);
});

test('an item with no triggers has no next firing, and an unlimited rule still terminates', () => {
  assert.equal(nextTriggerAt(item({ start: toLocalIso(at(2026, 9, 28, 9, 0)) }), at(2026, 9, 29)), null);
  const never = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=DAILY;UNTIL=20260901T000000Z', triggers: [notify(0)] });
  assert.equal(nextTriggerAt(never, at(2026, 9, 29)), null);
});

test('nextOccurrence walks forward lazily without expanding the whole rule', () => {
  const it = item({ start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=DAILY' });
  const next = nextOccurrence(it, at(2026, 9, 29, 12, 0));
  assert.equal(dayKey(next!.at!), '2026-09-30');
});

test('the soonest firing across all items is the one the engine wakes for', () => {
  // This is what lets the engine sleep until the exact moment instead of
  // polling, which is the difference between a reminder and a reminder that
  // arrives up to half a minute late.
  const now = at(2026, 9, 29, 12, 0);
  const far = item({ id: 'far', start: toLocalIso(at(2026, 9, 30, 9, 0)), triggers: [notify(0)] });
  const near = item({ id: 'near', start: toLocalIso(at(2026, 9, 29, 12, 7)), triggers: [notify(-2)] });
  const none = item({ id: 'none', title: 'no triggers' });

  const next = nextFireAcrossItems([far, none, near], now);
  // `near` fires at 12:05 — two minutes before its 12:07 start.
  assert.equal(next!.getTime(), at(2026, 9, 29, 12, 5).getTime());

  assert.equal(nextFireAcrossItems([none], now), null, 'an item with no triggers offers no wake-up');
});

// ── the repeat picker ──

test('the repeat picker round-trips through the stored RRULE body', () => {
  assert.equal(buildRRule({ kind: 'none' }), undefined);
  assert.equal(buildRRule({ kind: 'daily' }), 'FREQ=DAILY');
  assert.deepEqual(parseRepeat('FREQ=WEEKLY;BYDAY=MO,WE'), { kind: 'weekly', byDay: [1, 3] });
  assert.deepEqual(parseRepeat(buildRRule({ kind: 'weekly', byDay: [1, 3] })), { kind: 'weekly', byDay: [1, 3] });
  assert.equal(parseRepeat(undefined).kind, 'none');
  assert.equal(describeRepeat('FREQ=WEEKLY;BYDAY=MO,WE'), '每周一、周三');
  assert.equal(describeRepeat('FREQ=DAILY'), '每天');
  assert.equal(describeRepeat(undefined), '不重复');
});

test('a hand-written rule is preserved as custom rather than mangled', () => {
  const spec = parseRepeat('FREQ=MONTHLY;BYDAY=-1FR');
  assert.equal(spec.kind, 'custom');
  assert.equal(buildRRule(spec), 'FREQ=MONTHLY;BYDAY=-1FR');
});

test('a start that the rule never produces is moved onto the rule', () => {
  // RFC 5545: DTSTART bounds the recurrence set, it is not a member of it. A
  // Thursday date with BYDAY=TU therefore produces no Thursday occurrence — the
  // row would read "周四 10:00 / 每周二" and never fire. 2026-10-01 is a Thursday.
  const misaligned = { start: toLocalIso(at(2026, 10, 1, 10, 0)), rrule: 'FREQ=WEEKLY;BYDAY=TU' };
  const fixed = alignStartToRule(misaligned);
  assert.equal(dayKey(new Date(fixed!)), '2026-10-06', 'should move to the next Tuesday');
  assert.equal(new Date(fixed!).getHours(), 10, 'and keep the time of day');

  // A start that already matches is left exactly alone.
  const aligned = { start: toLocalIso(at(2026, 9, 29, 9, 0)), rrule: 'FREQ=WEEKLY;BYDAY=TU' };
  assert.equal(alignStartToRule(aligned), aligned.start);

  // No rule, or no start: nothing to align.
  assert.equal(alignStartToRule({ start: toLocalIso(at(2026, 10, 1, 10, 0)) }), misaligned.start);
  assert.equal(alignStartToRule({ rrule: 'FREQ=DAILY' }), undefined);

  // And daily items are their own first occurrence.
  assert.equal(
    alignStartToRule({ start: toLocalIso(at(2026, 10, 1, 10, 0)), rrule: 'FREQ=DAILY' }),
    toLocalIso(at(2026, 10, 1, 10, 0)),
  );
});

// ── parsing what a person says ──

test('explicit dates are read directly, with and without a time', () => {
  const timed = parseOk('2026-09-30 14:00', at(2026, 9, 29));
  assert.equal(timed.allDay, false);
  assert.equal(timed.at.getHours(), 14);

  const dated = parseOk('2026-09-30', at(2026, 9, 29));
  assert.equal(dated.allDay, true, 'a bare date is a whole day, not noon');
});

test('relative words reach a real instant', () => {
  const now = at(2026, 9, 29, 10, 0);
  for (const [text, expected] of [
    ['明天下午3点', at(2026, 9, 30, 15, 0)],
    ['今晚8点', at(2026, 9, 29, 20, 0)],
    ['周五下午两点', at(2026, 10, 2, 14, 0)],
  ] as const) {
    const value = parseOk(text, now);
    assert.equal(value.at.getTime(), expected.getTime(), `${text} → wrong instant`);
    assert.equal(value.allDay, false);
  }
});

test('the words chrono drops are normalised first', () => {
  // 后天 and 大后天 do not parse at all in chrono-node's Chinese locale, and they
  // are among the most ordinary things a Chinese speaker writes.
  const now = at(2026, 9, 29, 10, 0);
  assert.equal(dayKey(parseOk('后天', now).at), '2026-10-01');
  assert.equal(dayKey(parseOk('大后天', now).at), '2026-10-02');

  // With a time attached, the rewritten date still leaves the time for chrono.
  // It has to be separated by a space, or chrono reads the whole thing as
  // date-only — the reason normalizeRelative appends one.
  const afternoon = parseOk('后天下午3点', now);
  assert.equal(dayKey(afternoon.at), '2026-10-01');
  assert.equal(afternoon.at.getHours(), 15);

  assert.equal(dayKey(parseOk('下个月1号', now).at), '2026-10-01');
  assert.equal(normalizeRelative('大后天', now), '2026-10-02', '大后天 must win over 后天');
});

test('a bare date reads as all-day rather than as noon', () => {
  // chrono reports 12:00 for a date-only input, and reports the hour as
  // "uncertain" for both `明天` and `明天早上` — so certainty alone cannot tell
  // them apart. Treating an uncertain 12:00 as "no time" is the safe reading.
  const now = at(2026, 9, 29, 10, 0);
  assert.equal(parseOk('明天', now).allDay, true);
  assert.equal(parseOk('10月1号', now).allDay, true);
  assert.equal(parseOk('到下个月15号', now).allDay, true);
  // An explicit hour is kept.
  assert.equal(parseOk('明天早上', now).allDay, false);
});

test('an unreadable time is refused instead of being stored as text', () => {
  // The failure this replaces: the old calendar kept the string and silently
  // never fired. Refusing is the whole point.
  for (const text of ['', '   ', '随便什么时候', '下周', '看情况']) {
    assert.ok(parseErr(text, at(2026, 9, 29)).length > 0, `"${text}" should be refused`);
  }
  assert.match(
    parseErr('随便什么时候', at(2026, 9, 29)),
    /2026-09-30 14:00/,
    'the error should show an accepted form',
  );
});

test('every parse echoes what it understood', () => {
  const r = parseOk('明天下午3点', at(2026, 9, 29, 10, 0));
  assert.match(r.note, /明天|9月30日/);
  assert.match(r.note, /15:00/);
  assert.match(parseOk('2026-09-30', at(2026, 9, 29)).note, /全天/);
});

// ── the day page ──

test('a day key is parsed as local midnight, never UTC', () => {
  // `new Date('2026-09-30')` is UTC midnight, which would shift the whole day
  // and silently move entries across the boundary. Same trap as the DTSTART bug.
  const d = dayStart('2026-09-30');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 0);
  assert.equal(dayKey(d), '2026-09-30');
});

test('a day page splits the day into planned and done', () => {
  const items = [
    item({ id: 'a', title: '交周报', start: toLocalIso(at(2026, 9, 30, 14, 0)) }),
    item({ id: 'b', title: '评审', start: toLocalIso(at(2026, 9, 30, 10, 0)), completions: ['x'] }),
  ];
  // Mark b done by its real occurrence key.
  const keyB = expandOccurrences(items[1]!, at(2026, 9, 1), at(2026, 10, 1))[0]!.key;
  items[1]!.completions = [keyB];

  const page = buildDayPage(items, [], {}, {}, '2026-09-30');
  assert.deepEqual(page.planned.map((e) => e.title), ['交周报']);
  assert.deepEqual(page.done.map((e) => e.title), ['评审']);
});

test('a day page shows nothing from the days either side', () => {
  const items = [
    item({ id: 'a', title: '昨天', start: toLocalIso(at(2026, 9, 29, 23, 59)) }),
    item({ id: 'b', title: '今天', start: toLocalIso(at(2026, 9, 30, 12, 0)) }),
    item({ id: 'c', title: '明天', start: toLocalIso(at(2026, 10, 1, 0, 1)) }),
  ];
  const page = buildDayPage(items, [], {}, {}, '2026-09-30');
  assert.deepEqual(page.planned.map((e) => e.title), ['今天']);
});

test('an occurrence at exactly midnight belongs to that day, not the one before', () => {
  // The half-open `(from, to]` used everywhere else would put a 00:00
  // occurrence at the end of the previous day. The page steps back 1ms so it
  // lands where a person expects.
  const items = [item({ id: 'a', title: '零点', start: toLocalIso(at(2026, 9, 30, 0, 0)) })];
  assert.deepEqual(buildDayPage(items, [], {}, {}, '2026-09-30').planned.map((e) => e.title), ['零点']);
  assert.equal(buildDayPage(items, [], {}, {}, '2026-09-29').planned.length, 0);
});

test('a repeating item appears on every matching day', () => {
  const items = [
    item({ id: 'a', title: '站会', start: toLocalIso(at(2026, 9, 28, 9, 0)), rrule: 'FREQ=DAILY' }),
  ];
  for (const day of ['2026-09-28', '2026-09-29', '2026-09-30']) {
    assert.deepEqual(
      buildDayPage(items, [], {}, {}, day).planned.map((e) => e.title),
      ['站会'],
      `${day} should show the standup`,
    );
  }
  assert.equal(buildDayPage(items, [], {}, {}, '2026-10-05').planned.length, 1);
});

test('an undated to-do finished today shows up on today', () => {
  // Its occurrence key is the constant 'once', which carries no date at all —
  // without `completedAt` the day page would silently omit every undated item
  // the user ticked off, which is exactly what this view exists to show.
  const items = [item({ id: 'a', title: '读书', completions: ['once'] })];
  const completedAt = { [completionKey('a', 'once')]: toLocalIso(at(2026, 9, 30, 21, 30)) };

  assert.deepEqual(
    buildDayPage(items, [], {}, completedAt, '2026-09-30').done.map((e) => e.title),
    ['读书'],
  );
  // And it stays off every other day.
  assert.equal(buildDayPage(items, [], {}, completedAt, '2026-09-29').done.length, 0);
  assert.equal(buildDayPage(items, [], {}, completedAt, '2026-10-01').done.length, 0);

  // With no recorded timestamp it cannot be placed, and is dropped rather than
  // guessed onto today.
  assert.equal(buildDayPage(items, [], {}, {}, '2026-09-30').done.length, 0);
});

test('a day page lists the firings that were missed that day', () => {
  const runs = [
    run({ key: 'k1', itemTitle: '每日汇报', status: 'missed', dueAt: toLocalIso(at(2026, 9, 30, 9, 0)) }),
    run({ key: 'k2', itemTitle: '别的日子', status: 'missed', dueAt: toLocalIso(at(2026, 9, 29, 9, 0)) }),
    run({ key: 'k3', itemTitle: '成功了', status: 'ok', dueAt: toLocalIso(at(2026, 9, 30, 9, 0)) }),
  ];
  const page = buildDayPage([], runs, {}, {}, '2026-09-30');
  assert.deepEqual(page.missed.map((r) => r.key), ['k1']);
});

test('a day page carries the note and marks the day', () => {
  const notes = {
    '2026-09-30': { '': { text: '今天还行', updatedAt: toLocalIso(at(2026, 9, 30, 22, 0)) } },
  };
  const page = buildDayPage([], [], notes, {}, '2026-09-30');
  assert.equal(page.notes['']?.text, '今天还行');

  const mark = dayMark(page);
  assert.equal(mark.hasNote, true, 'a day with writing must be findable again');
  // Whitespace is not writing.
  const blank = dayMark(
    buildDayPage([], [], { '2026-09-30': { '': { text: '   ', updatedAt: '' } } }, {}, '2026-09-30'),
  );
  assert.equal(blank.hasNote, false);
});

test('a day page keeps each workspace note apart, and marks the day if any has content', () => {
  const notes = {
    '2026-09-30': {
      '': { text: '交房租', updatedAt: '' },
      '/w/a': { text: '改了登录页', updatedAt: '' },
    },
  };
  const page = buildDayPage([], [], notes, {}, '2026-09-30');
  assert.equal(page.notes['']?.text, '交房租');
  assert.equal(page.notes['/w/a']?.text, '改了登录页');
  assert.equal(dayMark(page).hasNote, true, 'any scope counts as "written about"');

  // All-blank notes are not "written about" — the marker means something.
  const blank = buildDayPage(
    [],
    [],
    { '2026-09-30': { '': { text: ' ', updatedAt: '' }, '/w/a': { text: '\n', updatedAt: '' } } },
    {},
    '2026-09-30',
  );
  assert.equal(dayMark(blank).hasNote, false);
});

test('the day marker counts plans, completions and misses', () => {
  const items = [
    item({ id: 'a', title: 'A', start: toLocalIso(at(2026, 9, 30, 9, 0)) }),
    item({ id: 'b', title: 'B', start: toLocalIso(at(2026, 9, 30, 11, 0)) }),
  ];
  const keyB = expandOccurrences(items[1]!, at(2026, 9, 1), at(2026, 10, 1))[0]!.key;
  items[1]!.completions = [keyB];
  const runs = [
    run({ key: 'k1', itemTitle: 'X', status: 'undelivered', dueAt: toLocalIso(at(2026, 9, 30, 8, 0)) }),
  ];
  const mark = dayMark(buildDayPage(items, runs, {}, {}, '2026-09-30'));
  assert.deepEqual(mark, { planCount: 1, doneCount: 1, hasNote: false, missedCount: 1 });
});

// ── small formatting ──

test('trigger offsets read as a person would say them', () => {
  assert.equal(formatOffset(0), '到点时');
  assert.equal(formatOffset(-15), '提前 15 分钟');
  assert.equal(formatOffset(-60), '提前 1 小时');
  assert.equal(formatOffset(-90), '提前 1 小时 30 分钟');
  assert.equal(formatOffset(30), '之后 30 分钟');
});

// ── migrating pre-workspace state ──

test('v1 notes become the global scope, and the upgrade is recorded', () => {
  const saved = {
    items: [item({ id: 'a', title: '旧待办' })],
    runs: [],
    notes: { '2026-09-30': { text: '以前写的', updatedAt: '2026-09-30T22:00:00+08:00' } },
    completedAt: {},
  };
  const { state, changed } = migrateState(saved);
  assert.equal(changed, true);
  assert.equal(state.version, STATE_VERSION);
  // The plugin could not see a workspace before, so guessing one would be
  // inventing history. Global is the only claim the old data supports.
  assert.equal(state.notes['2026-09-30']?.['']?.text, '以前写的');
  assert.equal(state.items[0]?.workspaceId, undefined, 'old items stay global');
});

test('migrating an already-migrated store changes nothing', () => {
  const { state } = migrateState({
    notes: { '2026-09-30': { '': { text: 'x', updatedAt: '' } } },
    items: [],
    runs: [],
    completedAt: {},
  });
  const again = migrateState(state);
  assert.equal(again.changed, false, 'a second load must not rewrite the store');
  assert.equal(again.state.notes['2026-09-30']?.['']?.text, 'x');
});

test('completion timestamps move onto their item, unambiguously', () => {
  const items = [item({ id: 'a', title: '读书', completions: ['once'] })];
  const next = migrateCompletions(items, { once: '2026-09-30T21:30:00+08:00' });
  assert.deepEqual(next, { 'a|once': '2026-09-30T21:30:00+08:00' });
});

test('an old completion key nobody can claim alone is dropped, not guessed', () => {
  // Two undated to-dos both live on the constant key `'once'` — the old key
  // cannot say which one that timestamp belonged to.
  const items = [
    item({ id: 'a', title: '甲', completions: ['once'] }),
    item({ id: 'b', title: '乙', completions: ['once'] }),
  ];
  assert.deepEqual(migrateCompletions(items, { once: '2026-09-30T21:30:00+08:00' }), {});
  // The items themselves are untouched — done state lives in `completions`.
  assert.deepEqual(items[0]?.completions, ['once']);
});

test('an empty store migrates to a usable empty state', () => {
  const { state } = migrateState(undefined);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.notes, {});
  assert.equal(state.version, STATE_VERSION);
});
