/**
 * com.pi.tasks backend — the planner's state, its agent tools, and the timer
 * that makes a scheduled item actually happen.
 *
 * Why the timer lives here and not in the panel: the host starts the backend of
 * every enabled plugin at app boot and never idles it (`PluginSystem.doInit`),
 * so a UtilityProcess long-lived process is the one place in a plugin that
 * outlives the panel being closed. A timer in the panel UI would stop the
 * moment the user switched tabs, which is exactly when a reminder is needed.
 *
 * What it cannot do is run while the app is closed, and it cannot reach a
 * conversation when the window is gone. Rather than paper over either, every
 * firing that cannot happen is *written down* — see `runMissed` and the
 * `ctx.panelAlive` check in `perform` — so the 记录 view can show what was
 * skipped and offer to do it.
 */
import { plugin, type PluginContext, type ToolResult } from '@pi/plugin-sdk';
import type { DayNote, Item, RunRecord, RunStatus, TasksState, Trigger } from '../core/types.js';
import { parseWhen, FREE_TEXT_HINT } from '../core/parse-when.js';
import { buildRRule, describeRepeat, expandOccurrences, alignStartToRule } from '../core/recur.js';
import {
  dueRuns,
  nextTriggerAt,
  nextFireAcrossItems,
  currentOccurrenceKey,
  completionKey,
  describeTrigger,
  type DueRun,
} from '../core/triggers.js';
import { emptyState, migrateState } from '../core/migrate.js';
import {
  addDays,
  dayEnd,
  dayKey,
  dayStart,
  formatWhen,
  formatMonth,
  toLocalIso,
  weekdayLabel,
  workspaceLabel,
} from '../core/time.js';

/**
 * The SDK's context, kept at module scope.
 *
 * One backend process serves exactly one plugin, so there is one context — and
 * the timer, the storage helpers and the renderers all need it. Threading it
 * through every call would be noise.
 */
let ctx: PluginContext;

// ── state ──

const STORAGE_KEY = 'tasks';
/** Older entries are dropped: the history is a convenience, not a record of account. */
const MAX_RUNS = 500;
/**
 * Ceiling on how long the engine may sleep between passes.
 *
 * The engine normally wakes exactly when the next firing is due. This cap is
 * the safety net for the cases where "the next firing" is not the whole story:
 * a clock jump, a laptop waking from sleep, or a rule that starts matching
 * because the date rolled over. Without it, a long sleep would mean the engine
 * never notices.
 */
const MAX_TICK_MS = 30_000;
/** Floor, so a firing due "now" cannot spin the loop. */
const MIN_TICK_MS = 250;

let state: TasksState = emptyState();

/** The panel this plugin draws into. One plugin, one panel. */
const PANEL = 'items';

async function load(): Promise<void> {
  const saved = await ctx.call('storage.get', { key: STORAGE_KEY }).catch(() => undefined);
  // Shape repair and schema upgrades live in one pure function so the
  // pre-workspace layouts can be pinned by tests instead of discovered by a
  // user whose notes vanished.
  const { state: next, changed } = migrateState(saved);
  state = next;
  if (changed) await save();
}

async function save(): Promise<void> {
  if (state.runs.length > MAX_RUNS) {
    state.runs = state.runs.slice(-MAX_RUNS);
  }
  await ctx.call('storage.set', { key: STORAGE_KEY, value: state }).catch((err) => {
    ctx.log.error(`storage.set failed: ${err.message}`);
  });
}

// ── the view the panel renders ──

import type { AgendaGroup, MonthOccurrence, Views, ViewItem } from '../core/view.js';
import { buildDayPage, type DayPage } from '../core/day.js';

function groupOf(start: Date | undefined, now: Date): AgendaGroup {
  if (!start) return 'undated';
  const days = Math.floor(
    (new Date(start).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}

function toViewItem(item: Item, now: Date): ViewItem {
  const occKey = currentOccurrenceKey(item, now);
  const start = item.start ? new Date(item.start) : undefined;
  const next = nextTriggerAt(item, now);
  const done = item.completions.includes(occKey);
  return {
    id: item.id,
    title: item.title,
    note: item.note,
    start: item.start,
    end: item.end,
    allDay: Boolean(item.allDay),
    rrule: item.rrule,
    repeatLabel: describeRepeat(item.rrule),
    triggers: item.triggers,
    triggerLabels: item.triggers.map(describeTrigger),
    done,
    occurrenceKey: occKey,
    nextFireAt: next ? next.toISOString() : undefined,
    whenLabel: item.start
      ? item.allDay
        ? `${formatWhen(start!, now, true)} 全天`
        : formatWhen(start!, now)
      : '无日期',
    group: groupOf(start, now),
    workspaceId: item.workspaceId,
  };
}

/** Every workspace id the stored data mentions — items and notes alike. */
function knownWorkspaces(): string[] {
  const ids = new Set<string>();
  for (const item of state.items) if (item.workspaceId) ids.add(item.workspaceId);
  for (const scopes of Object.values(state.notes)) {
    for (const key of Object.keys(scopes)) if (key) ids.add(key);
  }
  return [...ids].sort();
}

function buildView(now: Date, truncated: string[] = []): Views {
  const runs = [...state.runs].reverse();
  return {
    // Deliberately unfiltered: the panel is the only place that knows which
    // workspace IT is showing, and `ui.render` goes to every window's view of
    // this panel. Filtering here would mean the last window to mount decides
    // what all of them see.
    items: state.items.map((i) => toViewItem(i, now)),
    workspaces: knownWorkspaces(),
    runs,
    missed: runs.filter((r) => r.status === 'missed' || r.status === 'undelivered'),
    notes: state.notes,
    now: now.toISOString(),
    truncated,
  };
}

/** Assemble one day's page — the auto half plus whatever the user wrote. */
function dayPage(day: string): DayPage {
  return buildDayPage(state.items, state.runs, state.notes, state.completedAt, day);
}

/**
 * The day page narrowed to one workspace (plus global), or everything.
 *
 * Narrowing happens here rather than in `buildDayPage` because the page's
 * assembly — which occurrence belongs to which day, which completion landed on
 * it — is scope-independent. Only the final lists are.
 */
function scopedDayPage(day: string, workspaceId: string | undefined, all: boolean): DayPage {
  const page = dayPage(day);
  if (all) return page;
  const keep = (e: { workspaceId?: string }): boolean => !e.workspaceId || e.workspaceId === workspaceId;
  const notes: Record<string, DayNote> = {};
  for (const [scope, note] of Object.entries(page.notes)) {
    if (!scope || scope === workspaceId) notes[scope] = note;
  }
  return { ...page, planned: page.planned.filter(keep), done: page.done.filter(keep), notes };
}

/**
 * Occurrences inside `[from, to]`, grouped by local day and time-ordered.
 *
 * `expandOccurrences` is half-open `(from, to]`, so the window starts one
 * millisecond earlier: an item at exactly 00:00 belongs to the day the caller
 * asked from, not to the one before it.
 */
function occurrencesBetween(from: Date, to: Date): Record<string, MonthOccurrence[]> {
  const byDay: Record<string, MonthOccurrence[]> = {};
  const start = new Date(from.getTime() - 1);
  for (const item of state.items) {
    for (const occ of expandOccurrences(item, start, to)) {
      const key = dayKey(occ.at!);
      (byDay[key] ??= []).push({
        itemId: item.id,
        title: item.title,
        key: occ.key,
        at: toLocalIso(occ.at!),
        allDay: Boolean(item.allDay),
        done: item.completions.includes(occ.key),
        workspaceId: item.workspaceId,
      });
    }
  }
  // A day reads in the order things happen; the grid shows the first two.
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
  return byDay;
}

/** A day's written notes, each labelled with the workspace it came from. */
function noteLines(page: DayPage): string[] {
  return Object.entries(page.notes)
    .filter(([, n]) => Boolean(n.text?.trim()))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([scope, n]) => `${scope ? `[${workspaceLabel(scope)}] ` : ''}${n.text.trim()}`);
}

function render(truncated: string[] = []): void {
  ctx.send(PANEL, 'ui.render', buildView(new Date(), truncated));
  // A newly saved item can be due seconds from now; re-arming here means it is
  // picked up then rather than at the next poll.
  scheduleNextTick();
}

// ── the tick ──

let ticking = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm the timer for the next moment something is due.
 *
 * Not a fixed interval: that would make a reminder up to a full tick late, and
 * the next fire time is already known, so there is no reason to be. Bounded
 * above by `MAX_TICK_MS` and below by `MIN_TICK_MS` — see both.
 */
function scheduleNextTick(): void {
  if (tickTimer) clearTimeout(tickTimer);
  const now = new Date();
  const next = nextFireAcrossItems(state.items, now);
  const delay =
    next === null
      ? MAX_TICK_MS
      : Math.min(Math.max(next.getTime() - now.getTime(), MIN_TICK_MS), MAX_TICK_MS);
  tickTimer = setTimeout(() => void tick(), delay);
}

async function tick(): Promise<void> {
  // A slow tick must not overlap the next one: two concurrent passes would both
  // compute the same due set and, before either had written its run records,
  // both fire it.
  if (ticking) return;
  ticking = true;
  const now = new Date();
  try {
    const from = state.lastTickAt ? new Date(state.lastTickAt) : now;
    const alreadyRun = new Set(state.runs.map((r) => r.key));
    const { toFire, missed, truncated } = dueRuns(state.items, alreadyRun, from, now, now);

    for (const run of missed) {
      state.runs.push(record(run, 'missed', undefined, '当时应用没有在运行'));
    }

    for (const run of toFire) {
      await perform(run);
    }

    state.lastTickAt = now.toISOString();
    await save();
    render(truncated);
  } catch (err) {
    ctx.log.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    // Re-arm even on failure: a throwing pass must not stop the clock, or one
    // bad item would silence every reminder after it.
    scheduleNextTick();
  } finally {
    ticking = false;
  }
}

function record(
  run: DueRun,
  status: RunStatus,
  firedAt: Date | undefined,
  detail: string | undefined,
): RunRecord {
  return {
    key: run.key,
    itemId: run.item.id,
    itemTitle: run.item.title,
    occurrenceKey: run.occurrence.key,
    triggerId: run.trigger.id,
    dueAt: toLocalIso(run.fireAt),
    firedAt: firedAt ? toLocalIso(firedAt) : undefined,
    action: run.trigger.action.kind,
    status,
    detail,
  };
}

/** Carry out one firing and record what actually happened. */
async function perform(run: DueRun): Promise<void> {
  const { trigger, item, fireAt } = run;
  const now = new Date();

  // Raise a badge without stealing focus, so a firing is visible even when the
  // panel is closed. Done for both action kinds — a notification the user
  // missed entirely would otherwise leave no trace in the UI.
  void ctx.call('panel.open', { panelId: 'items', focus: false }).catch(() => undefined);

  if (trigger.action.kind === 'notify') {
    const title = trigger.action.title || item.title;
    // Name the project: a reminder with no context reads as noise, and with
    // several workspaces in play "站会" alone does not say which standup.
    const body =
      [formatWhen(fireAt, now, Boolean(item.allDay)), item.workspaceId ? workspaceLabel(item.workspaceId) : '', item.note]
        .filter(Boolean)
        .join(' · ');
    try {
      await ctx.call('notify.show', { title, body });
      state.runs.push(record(run, 'ok', now, '已发送系统通知'));
    } catch (err) {
      state.runs.push(record(run, 'failed', now, err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  // A live panel is necessary but not sufficient. The composer lives in the
  // shell window, and on macOS closing that window leaves the panel's view —
  // and therefore this port — alive, so the probe can answer "yes" while there
  // is nowhere for a message to land. That was measured, not assumed: with the
  // window closed the probe passed and the send threw `Object has been
  // destroyed`. So the probe stays as a cheap pre-check, and the authoritative
  // answer is whether the send itself succeeded.
  if (!(await ctx.panelAlive(PANEL))) {
    state.runs.push(record(run, 'undelivered', undefined, '当时没有打开任何窗口'));
    return;
  }

  try {
    // `workspaceId` routes the message to the window showing that workspace.
    // Without it the host falls back to the focused window, and a reminder for
    // project A would land in project B's conversation — the agent would then
    // write its follow-up into the wrong project.
    await ctx.call('chat.send', {
      text: trigger.action.prompt,
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    });
    state.runs.push(record(run, 'ok', now, '已送进对话'));
  } catch (err) {
    // Recorded as "not delivered" rather than "failed". From the user's side
    // there is one fact and one action — the message never reached the
    // conversation, and they can re-run it — and `failed` would read as a
    // plugin bug instead. The raw error is kept in the detail because it is a
    // real Electron message, and swallowing it would make an actual defect
    // harder to find than a closed window.
    state.runs.push(
      record(run, 'undelivered', undefined, `没能送进对话（${errMessage(err)}）—— 通常是应用窗口已经关闭`),
    );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-run a firing the user asked for, ignoring the grace window. */
async function rerun(key: string): Promise<void> {
  const existing = state.runs.find((r) => r.key === key);
  if (!existing) return;
  // Drop the old record so the idempotency check in `dueRuns` does not block
  // the re-run, then rebuild the firing from the item as it stands now.
  state.runs = state.runs.filter((r) => r.key !== key);
  const item = state.items.find((i) => i.id === existing.itemId);
  const trigger = item?.triggers.find((t) => t.id === existing.triggerId);
  if (!item || !trigger || !item.start) {
    // The item or trigger was deleted since — nothing to re-run.
    await save();
    render();
    return;
  }
  await perform({
    item,
    occurrence: { itemId: item.id, key: existing.occurrenceKey, at: new Date(existing.occurrenceKey) },
    trigger,
    fireAt: new Date(existing.dueAt),
    key: existing.key,
  });
  await save();
  render();
}

// ── writing items ──

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function newTrigger(action: Trigger['action'], offsetMinutes: number): Trigger {
  return { id: newId('g'), offsetMinutes, action, enabled: true };
}

interface SaveInput {
  id?: string;
  title?: string;
  note?: string;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  rrule?: string | null;
  triggers?: Trigger[];
  /** `null` / `''` puts the item in the global list. */
  workspaceId?: string | null;
}

/** Create or update an item. Returns the stored item. */
function saveItem(input: SaveInput): Item {
  const existing = input.id ? state.items.find((i) => i.id === input.id) : undefined;
  const item: Item = existing ?? {
    id: newId('i'),
    title: '',
    createdAt: toLocalIso(new Date()),
    completions: [],
    triggers: [],
  };

  if (input.title !== undefined) item.title = String(input.title).slice(0, 200);
  if (input.note !== undefined) item.note = String(input.note).slice(0, 2000) || undefined;
  if (input.start !== undefined) item.start = input.start || undefined;
  if (input.end !== undefined) item.end = input.end || undefined;
  if (input.allDay !== undefined) item.allDay = input.allDay;
  if (input.rrule !== undefined) item.rrule = input.rrule || undefined;
  if (input.triggers !== undefined) item.triggers = input.triggers;
  if (input.workspaceId !== undefined) item.workspaceId = input.workspaceId || undefined;

  // Triggers are anchored to an occurrence, so an item with no time can have
  // none — and nothing to repeat either. Dropping them here rather than letting
  // them sit inert means the UI never shows a reminder that could not possibly
  // fire. Callers that set either without a time report it as an error first.
  if (!item.start) {
    item.triggers = [];
    item.rrule = undefined;
  }

  if (existing) {
    state.items = state.items.map((i) => (i.id === item.id ? item : i));
  } else {
    state.items = [...state.items, item];
  }

  // Keep the stored time and the rule consistent — see `alignStartToRule`.
  // Applied after insertion so the corrected value is what every reader sees,
  // and to items created either by the editor or by an agent tool call.
  if (item.rrule && item.start) {
    const aligned = alignStartToRule(item);
    if (aligned && aligned !== item.start) item.start = aligned;
  }

  return item;
}

// ── agent tools ──

/**
 * Mark an occurrence done or not done, and record *when*.
 *
 * The timestamp is the whole reason `completedAt` exists: it is what lets an
 * item with no time appear on the day it was actually finished, since its
 * occurrence key is the dateless constant `'once'`.
 */
function setCompletion(item: Item, key: string, done: boolean, now = new Date()): void {
  const stamp = completionKey(item.id, key);
  if (done) {
    item.completions = Array.from(new Set([...item.completions, key]));
    state.completedAt[stamp] = toLocalIso(now);
  } else {
    item.completions = item.completions.filter((k) => k !== key);
    delete state.completedAt[stamp];
  }
}

/**
 * The items a call may see: the calling conversation's workspace plus global
 * ones.
 *
 * Scoping reads as well as writes is the point — an agent working in project B
 * asking to update "周会" must not silently edit project A's 周会. `all` is the
 * deliberate opt-out for genuinely cross-project questions.
 */
function itemsInScope(workspaceId: string | undefined, all: boolean): Item[] {
  if (all) return state.items;
  return state.items.filter((i) => !i.workspaceId || i.workspaceId === workspaceId);
}

/** `scope: 'all'` in a tool call — everything, regardless of workspace. */
function wantsAll(scope: unknown): boolean {
  return String(scope ?? '').trim().toLowerCase() === 'all';
}

/** `scope: 'global'` in a tool call — put it in the cross-project list. */
function wantsGlobal(scope: unknown): boolean {
  return String(scope ?? '').trim().toLowerCase() === 'global';
}

/** Find an item by title substring, most recently created first. */
function findByTitle(title: string, pool: Item[], preferOpen = true): Item | undefined {
  const needle = String(title ?? '').trim();
  if (!needle) return undefined;
  const matches = pool
    .filter((i) => i.title.includes(needle))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (preferOpen && matches.find((i) => i.completions.length === 0)) || matches[0];
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Run statuses as the agent should read them out. */
const STATUS_CN: Record<RunStatus, string> = {
  ok: '已完成',
  missed: '错过',
  undelivered: '没送到',
  failed: '出错',
};

/**
 * Accepts either a picker word or a raw RRULE body.
 *
 * Both are allowed because the picker cannot express everything — `每月最后一个
 * 工作日` has no picker entry — and refusing a valid RRULE just because the UI
 * has no button for it would be a strange limit to impose on the agent.
 */
function repeatSpec(value: unknown): string | undefined {
  const spec = String(value ?? '').trim();
  if (!spec) return undefined;
  if (spec.toUpperCase().includes('FREQ=')) return spec;
  const kind = spec.toLowerCase();
  if (kind === 'daily' || kind === 'weekly' || kind === 'monthly' || kind === 'yearly') {
    return buildRRule({ kind });
  }
  throw new Error(
    `看不懂的重复方式：${spec}。可用 daily / weekly / monthly / yearly，` +
      `或直接给 RRULE，例如 FREQ=WEEKLY;BYDAY=MO。`,
  );
}

async function onTool(
  name: string,
  params: Record<string, unknown>,
  _context: PluginContext,
  call: { sessionId?: string; workspaceId?: string } = {},
): Promise<ToolResult | string> {
  const p = params ?? {};
  /**
   * Where new items go by default: the workspace this conversation belongs to.
   *
   * Undefined when the host could not resolve one (a session that was never
   * sent from). That is NOT a cue to fall back to whatever window is focused —
   * it means "global", which is the only claim we can actually make.
   */
  const workspaceId = call.workspaceId;

  switch (name) {
    case 'item_add': {
      if (!p.title) throw new Error('missing title');
      let start: string | undefined;
      let allDay = false;
      let echo = '';

      if (p.when) {
        const parsed = parseWhen(String(p.when));
        if (!parsed.ok) throw new Error(parsed.error);
        start = toLocalIso(parsed.value.at);
        allDay = parsed.value.allDay;
        echo = parsed.value.note;
      }

      let rrule: string | undefined;
      if (p.repeat !== undefined && p.repeat !== null && String(p.repeat).trim() !== '') {
        rrule = repeatSpec(p.repeat);
        if (rrule && !start) throw new Error('要重复就得先有时间。请同时给 when。');
      }

      const triggers: Trigger[] = [];
      if (p.remindBefore !== undefined) {
        const minutes = Number(p.remindBefore);
        if (!Number.isFinite(minutes)) throw new Error('remindBefore 要是一个分钟数');
        triggers.push(newTrigger({ kind: 'notify' }, -Math.abs(minutes)));
      }
      if (p.onDue) {
        triggers.push(newTrigger({ kind: 'agent', prompt: String(p.onDue) }, 0));
      }
      if (triggers.length > 0 && !start) {
        throw new Error('要设提醒就得先有时间。请同时给 when。');
      }

      const item = saveItem({
        title: String(p.title),
        note: p.note === undefined ? undefined : String(p.note),
        start,
        allDay,
        rrule,
        triggers,
        workspaceId: wantsGlobal(p.scope) ? null : workspaceId,
      });
      await save();
      render();

      const lines = [`已记下：${item.title}`];
      if (echo) lines.push(`时间：${echo}${p.when && !String(p.when).match(/^\d{4}-/) ? `（${FREE_TEXT_HINT}）` : ''}`);
      else lines.push('时间：无（纯待办）');
      if (item.rrule) lines.push(`重复：${describeRepeat(item.rrule)}`);
      lines.push(`归属：${item.workspaceId ? workspaceLabel(item.workspaceId) : '全局'}`);
      for (const t of item.triggers) lines.push(`触发：${describeTrigger(t)}`);
      return {
        ...text(lines.join('\n')),
        card: {
          component: 'Card',
          props: { title: '已记下' },
          children: [
            {
              component: 'KeyValue',
              props: {
                items: [
                  ['事项', item.title],
                  ...(echo ? [['时间', echo]] : []),
                  ['归属', item.workspaceId ? workspaceLabel(item.workspaceId) : '全局'],
                  ...(item.rrule ? [['重复', describeRepeat(item.rrule)]] : []),
                  ...item.triggers.map((t) => ['触发', describeTrigger(t)]),
                ],
              },
            },
          ],
        },
      };
    }

    case 'day_read': {
      // A range so that "整理一下这周" is one call rather than seven.
      const today = dayKey(new Date());
      const to = String(p.to ?? today);
      const from = String(p.from ?? (p.day ? p.day : dayKey(addDays(new Date(), -6))));
      const fromD = dayStart(from);
      const toD = dayStart(to);
      if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
        throw new Error('日期要写成 2026-09-30 这样');
      }
      const span = Math.round((toD.getTime() - fromD.getTime()) / 86_400_000);
      if (span < 0) throw new Error('from 比 to 还晚');
      if (span > 90) throw new Error('一次最多读 90 天，请缩短范围');

      const all = wantsAll(p.scope);
      const lines: string[] = [];
      let wrote = 0;
      for (let i = 0; i <= span; i++) {
        const day = dayKey(addDays(fromD, i));
        const page = scopedDayPage(day, workspaceId, all);
        const notes = noteLines(page);
        const empty =
          page.planned.length === 0 && page.done.length === 0 && page.missed.length === 0 && notes.length === 0;
        if (empty) continue;
        wrote++;

        lines.push(`【${day} ${weekdayLabel(dayStart(day))}】`);
        if (page.done.length) lines.push(`  完成：${page.done.map((e) => e.title).join('、')}`);
        if (page.planned.length) lines.push(`  没完成：${page.planned.map((e) => e.title).join('、')}`);
        if (page.missed.length) {
          lines.push(`  错过的触发：${page.missed.map((r) => `${r.itemTitle}（${STATUS_CN[r.status]}）`).join('、')}`);
        }
        if (notes.length) lines.push(`  用户写的：${notes.join('\n    ')}`);
        lines.push('');
      }

      if (wrote === 0) return text(`${from} 到 ${to} 之间没有任何记录。`);
      return text(`从 ${from} 到 ${to} 的记录：\n\n${lines.join('\n')}`);
    }

    case 'day_write': {
      const day = String(p.day ?? dayKey(new Date()));
      if (Number.isNaN(dayStart(day).getTime())) throw new Error('日期要写成 2026-09-30 这样');
      const body = String(p.text ?? '').trim();
      if (!body) throw new Error('没给要写的内容');

      const mode = p.mode === 'replace' ? 'replace' : 'append';
      // One note per (day, workspace). Writing project B's day must not touch
      // project A's — they are different sentences about different work.
      const scopeKey = wantsGlobal(p.scope) ? '' : (workspaceId ?? '');
      const existing = state.notes[day]?.[scopeKey]?.text ?? '';
      const next = mode === 'replace' || !existing.trim() ? body : `${existing}\n\n${body}`;
      state.notes[day] = {
        ...(state.notes[day] ?? {}),
        [scopeKey]: { text: next, updatedAt: toLocalIso(new Date()) },
      };
      await save();
      render();

      return text(
        `已写入 ${day} 的记录${scopeKey ? `（${workspaceLabel(scopeKey)}）` : '（全局）'}` +
          `${mode === 'replace' && existing.trim() ? '，覆盖了原来的内容' : ''}。\n` +
          `现在这一天是：\n${next}`,
      );
    }

    case 'item_list': {
      const now = new Date();
      const range = String(p.range ?? 'week');
      const all = wantsAll(p.scope);
      let items = itemsInScope(workspaceId, all);
      if (range === 'today') {
        const today = dayKey(now);
        items = items.filter((i) => i.start && dayKey(new Date(i.start)) === today);
      } else if (range === 'week') {
        const end = new Date(now.getTime() + 7 * 86_400_000);
        items = items.filter((i) => i.start && new Date(i.start) <= end);
      }
      if (items.length === 0) return text('没有符合条件的事项。');

      const lines = items
        .sort((a, b) => (a.start ?? '9999') < (b.start ?? '9999') ? -1 : 1)
        .map((i) => {
          const v = toViewItem(i, now);
          const mark = v.done ? '✓' : '○';
          const rep = i.rrule ? ` ↻${describeRepeat(i.rrule)}` : '';
          const fire = v.nextFireAt ? ` · 下次触发 ${formatWhen(new Date(v.nextFireAt), now)}` : '';
          // Always name the owner: with scoped reads an item may be global or
          // come from the current project, and the agent must be able to say
          // which when it reports back.
          const owner = i.workspaceId ? ` ·[${workspaceLabel(i.workspaceId)}]` : ' ·[全局]';
          return `${mark} ${v.whenLabel} — ${i.title}${owner}${rep}${fire}${i.note ? `（${i.note}）` : ''}`;
        });
      const open = items.filter((i) => !toViewItem(i, now).done).length;
      const where = all ? '全部工作区' : `${workspaceId ? workspaceLabel(workspaceId) : '全局'} 及全局`;
      return text(`事项（范围：${range}，${where}，${open} 项未完成）：\n${lines.join('\n')}`);
    }

    case 'item_update': {
      const item = findByTitle(String(p.title ?? ''), itemsInScope(workspaceId, wantsAll(p.scope)), true);
      if (!item) throw new Error(`没找到事项：${p.title}${wantsAll(p.scope) ? '' : '（只在当前工作区和全局里找；要跨工作区请用 scope: "all"）'}`);
      const input: SaveInput = { id: item.id };

      if (p.when !== undefined) {
        if (p.when === null || p.when === '') {
          input.start = null;
        } else {
          const parsed = parseWhen(String(p.when));
          if (!parsed.ok) throw new Error(parsed.error);
          input.start = toLocalIso(parsed.value.at);
          input.allDay = parsed.value.allDay;
        }
      }
      if (p.note !== undefined) input.note = String(p.note);
      if (p.repeat !== undefined) {
        const next = repeatSpec(p.repeat);
        // A repeat with no time has nothing to anchor to — refuse it here so the
        // reason reaches the agent, rather than being dropped silently in saveItem.
        if (next && !(input.start !== undefined ? input.start : item.start)) {
          throw new Error('要重复就得先有时间。请同时给 when。');
        }
        input.rrule = next ?? null;
      }
      const updated = saveItem(input);

      if (p.done !== undefined) {
        setCompletion(updated, currentOccurrenceKey(updated, new Date()), Boolean(p.done));
      }
      await save();
      render();
      const v = toViewItem(updated, new Date());
      return text(`已更新：${updated.title}\n时间：${v.whenLabel}\n状态：${v.done ? '已完成' : '未完成'}`);
    }

    case 'item_remove': {
      const item = findByTitle(String(p.title ?? ''), itemsInScope(workspaceId, wantsAll(p.scope)), false);
      if (!item) throw new Error(`没找到事项：${p.title}${wantsAll(p.scope) ? '' : '（只在当前工作区和全局里找；要跨工作区请用 scope: "all"）'}`);
      state.items = state.items.filter((i) => i.id !== item.id);
      await save();
      render();
      return text(`已删除：${item.title}`);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── panel requests ──

async function onUiRequest(method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'state.get':
      return buildView(new Date());

    /**
     * One day's page.
     *
     * `workspaceId` narrows it to that project plus global; `scope: 'all'`
     * keeps every project. The panel sends whichever its filter is showing —
     * the backend does not guess, because it cannot know which window asked.
     */
    case 'day.get': {
      const day = String(params?.day ?? dayKey(new Date()));
      const workspaceId =
        typeof params?.workspaceId === 'string' && params.workspaceId ? params.workspaceId : undefined;
      return scopedDayPage(day, workspaceId, wantsAll(params?.scope));
    }

    /**
     * Write the day's free text.
     *
     * The note is the user's own words, so the destructive shape is opt-in:
     * callers pass `mode: 'replace'` explicitly, and anything else appends.
     * Reaching for a text field and wiping what someone wrote about their day
     * is not a failure mode worth leaving to a default.
     */
    case 'day.note.set': {
      const day = String(params?.day ?? dayKey(new Date()));
      const text = String(params?.text ?? '');
      const mode = params?.mode === 'replace' ? 'replace' : 'append';
      // `''` is the global scope; the panel passes a workspace id when writing
      // from a project view. Two scopes never share one block of text.
      const scopeKey =
        typeof params?.workspaceId === 'string' && params.workspaceId ? params.workspaceId : '';
      const dayNotes = state.notes[day] ?? {};
      const existing = dayNotes[scopeKey]?.text ?? '';
      const next = mode === 'replace' || !existing.trim() ? text : `${existing}\n\n${text}`;
      if (next.trim()) {
        state.notes[day] = { ...dayNotes, [scopeKey]: { text: next, updatedAt: toLocalIso(new Date()) } };
      } else {
        delete dayNotes[scopeKey];
        if (Object.keys(dayNotes).length > 0) state.notes[day] = dayNotes;
        else delete state.notes[day];
      }
      await save();
      render();
      return { ok: true, day, workspaceId: scopeKey, text: next };
    }

    /** Occurrences for the month grid. The panel cannot expand RRULEs itself. */
    case 'month.get': {
      const year = Number(params?.year ?? new Date().getFullYear());
      const month = Number(params?.month ?? new Date().getMonth());
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      return { year, month, label: formatMonth(from), byDay: occurrencesBetween(from, to) };
    }

    /**
     * Occurrences for an arbitrary span of whole days.
     *
     * The month grid asks "what does 11月 look like"; the week view asks the
     * same question about seven days, which may straddle two months. One
     * expansion routine answers both, so the two views cannot drift.
     */
    case 'range.get': {
      const from = dayStart(String(params?.from ?? dayKey(new Date())));
      const to = dayEnd(String(params?.to ?? dayKey(new Date())));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error('日期要写成 2026-09-30 这样');
      }
      if (to < from) throw new Error('from 比 to 还晚');
      return { from: dayKey(from), to: dayKey(to), byDay: occurrencesBetween(from, to) };
    }

    case 'item.save': {
      const item = saveItem(params as SaveInput);
      await save();
      render();
      return { ok: true, id: item.id };
    }

    case 'item.remove': {
      state.items = state.items.filter((i) => i.id !== String(params?.id));
      await save();
      render();
      return { ok: true };
    }

    case 'item.toggle': {
      const item = state.items.find((i) => i.id === String(params?.id));
      if (!item) throw new Error('没有这条事项');
      const key = String(params?.occurrenceKey ?? currentOccurrenceKey(item, new Date()));
      setCompletion(item, key, !item.completions.includes(key));
      await save();
      render();
      return { ok: true };
    }

    case 'run.rerun':
      await rerun(String(params?.key));
      return { ok: true };

    case 'run.clear':
      state.runs = [];
      await save();
      render();
      return { ok: true };

    default:
      throw new Error(`unknown ui request: ${method}`);
  }
}

// ── the plugin ──

plugin({
  async onInit(context) {
    ctx = context;
    await load();
    render();
    // The first tick reconciles anything that came due while the app was
    // closed: `lastTickAt` is from the previous session, so the window covers
    // the gap. That is the whole catch-up mechanism.
    await tick();
  },

  async onPanelMounted() {
    render();
    // A badge set while no window existed is lost — it is renderer state and
    // does not survive a reload — so it is re-asserted on every mount.
    const due = buildView(new Date()).missed.length;
    if (due > 0) await ctx.setBadge(PANEL, due);
  },

  onTool,

  onRequest(_panelId, method, params) {
    return onUiRequest(method, params);
  },
});
