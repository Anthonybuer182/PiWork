/**
 * Time arithmetic, all of it in the machine's local timezone.
 *
 * The one rule that matters: never use `Date#toISOString()` to *store* a local
 * time. It converts to UTC, so a 09:00 item round-trips to 01:00 and comes back
 * wrong by the offset — the same class of bug as parsing `DTSTART` as UTC, and
 * just as quiet, because the stored value still looks like a valid timestamp.
 * `toLocalIso` is the only writer.
 */

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

/**
 * Local ISO 8601 with an explicit offset: `2026-09-28T09:00:00+08:00`.
 *
 * The offset is included so the stored string is unambiguous on its own, and
 * reading it back with `new Date(...)` yields the same instant. The local part
 * stays the wall-clock time the user typed.
 */
export function toLocalIso(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

/** Local calendar day as `YYYY-MM-DD`. Used for grouping, never for instants. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parse a `YYYY-MM-DD` day key back into local midnight.
 *
 * Hand-rolled rather than `new Date('2026-09-30')`, which the spec treats as
 * **UTC** midnight — the same trap as `toISOString` and the `DTSTART` parsing
 * bug, and it shifts the whole day by the offset. Every day boundary in this
 * plugin goes through here.
 */
export function dayStart(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/** The last millisecond of a `YYYY-MM-DD` day, locally. */
export function dayEnd(day: string): Date {
  const d = dayStart(day);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** Whole days from `a` to `b`, ignoring time of day. Negative when `b` is earlier. */
export function daysBetween(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86_400_000);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `9月29日` / `2027年9月29日` once the year differs from `now`'s. */
export function formatDay(date: Date, now = new Date()): string {
  const stem = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? stem : `${date.getFullYear()}年${stem}`;
}

export function weekdayLabel(date: Date): string {
  return WEEKDAYS[date.getDay()]!;
}

/**
 * `今天 09:00` / `明天 14:30` / `9月29日 周三 18:00` — the day only gets a
 * weekday once it is far enough away for the weekday to be the useful handle.
 */
export function formatWhen(date: Date, now = new Date(), allDay = false): string {
  const delta = daysBetween(now, date);
  const time = allDay ? '' : ` ${formatTime(date)}`;
  if (delta === 0) return `今天${time}`;
  if (delta === 1) return `明天${time}`;
  if (delta === -1) return `昨天${time}`;
  if (delta > 1 && delta < 7) return `${weekdayLabel(date)}${time}`;
  return `${formatDay(date, now)} ${weekdayLabel(date)}${time}`;
}

/** `2026年9月` — the month grid's heading. */
export function formatMonth(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

/**
 * A workspace id's display label: its last path segment.
 *
 * Workspace ids ARE absolute paths, and the plugin has no access to the
 * workspace registry, so the folder name is the best label available. Doing it
 * here rather than denormalising a name onto every item keeps one source of
 * truth: if the folder moves, the id is stale too, and a stored copy would just
 * be stale in a second place.
 */
export function workspaceLabel(workspaceId: string): string {
  const trimmed = workspaceId.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/** `1 小时 30 分钟` / `15 分钟` — trigger offsets, read by a person. */
export function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  const body =
    abs < 60
      ? `${abs} 分钟`
      : abs % 60 === 0
        ? `${abs / 60} 小时`
        : `${Math.floor(abs / 60)} 小时 ${abs % 60} 分钟`;
  if (minutes === 0) return '到点时';
  return minutes < 0 ? `提前 ${body}` : `之后 ${body}`;
}
