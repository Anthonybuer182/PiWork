/**
 * The calendar: a month grid and a week of columns, over one map of days.
 *
 * Both modes are fed by the same `byDay` shape, so a day cell and a week
 * column can never disagree about what is on a day — the only difference is
 * how much room each has to say it.
 *
 * What neither mode does is draw a 24-hour time axis. The panel is a sidebar
 * that can be dragged narrow, and a time grid needs width to be legible; at
 * that width it becomes lines you cannot read rather than a schedule you can.
 * A day is a stack of what is on it, ordered by time, which is what the
 * "what's on today" question actually needs.
 */
import { useMemo, type ReactNode } from 'react';
import type { MonthOccurrence } from '../../core/view.js';
import type { DayNote } from '../../core/types.js';
import { dayKey, dayStart, formatDay, formatTime, weekdayLabel, workspaceLabel } from '../../core/time.js';

export type CalendarMode = 'month' | 'week';

/** Which of the visible scopes an occurrence belongs to. */
const visible = (
  occ: MonthOccurrence,
  scope: 'all' | 'workspace',
  current: string | null,
): boolean => !occ.workspaceId || scope === 'all' || occ.workspaceId === current;

/** How many titles a month cell can hold before it starts lying about content. */
const CELL_EVENTS = 2;

export function CalendarView({
  mode,
  onMode,
  byDay,
  label,
  cursor,
  selectedDay,
  notes,
  scope,
  currentWorkspaceId,
  onPrev,
  onNext,
  onToday,
  onSelectDay,
  onOpenDay,
  onToggle,
  onEdit,
  onCreateForDay,
}: {
  mode: CalendarMode;
  onMode: (mode: CalendarMode) => void;
  byDay: Record<string, MonthOccurrence[]> | null;
  label: string;
  cursor: Date;
  selectedDay: string;
  notes: Record<string, Record<string, DayNote>>;
  scope: 'all' | 'workspace';
  currentWorkspaceId: string | null;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelectDay: (day: string) => void;
  onOpenDay: (day: string) => void;
  onToggle: (occ: MonthOccurrence) => void;
  onEdit: (occ: MonthOccurrence) => void;
  /** Opens the editor already dated to this day. */
  onCreateForDay: (day: string) => void;
}) {
  const todayKey = dayKey(new Date());

  const inView = (occ: MonthOccurrence): boolean => visible(occ, scope, currentWorkspaceId);

  const wroteOn = (day: string): boolean =>
    Object.entries(notes[day] ?? {}).some(([key, note]) => {
      if (!note.text?.trim()) return false;
      return scope === 'all' || !key || key === currentWorkspaceId;
    });

  /** The days drawn by the grid: whole weeks, Sunday first, month mode only. */
  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  /** The seven days of the week containing the selection, week mode only. */
  const weekCells = useMemo(() => {
    const d = dayStart(selectedDay);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    return Array.from({ length: 7 }, (_, i) => {
      const x = new Date(start);
      x.setDate(start.getDate() + i);
      return x;
    });
  }, [selectedDay]);

  const dayItems = (byDay?.[selectedDay] ?? []).filter(inView);
  const dayWrote = wroteOn(selectedDay);

  return (
    <>
      <div className="month-hd">
        <span className="label">{label}</span>
        <span className="grow" />
        <div className="mode-tabs" role="group" aria-label="日历视图">
          {(['month', 'week'] as const).map((m) => (
            <button
              key={m}
              className="mode-tab"
              data-on={mode === m}
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
            >
              {m === 'month' ? '月' : '周'}
            </button>
          ))}
        </div>
        <button className="btn tiny" onClick={onPrev} aria-label={mode === 'month' ? '上个月' : '上一周'}>
          ‹
        </button>
        <button className="btn tiny" onClick={onToday}>
          今天
        </button>
        <button className="btn tiny" onClick={onNext} aria-label={mode === 'month' ? '下个月' : '下一周'}>
          ›
        </button>
      </div>

      {mode === 'month' ? (
        <div className="grid">
          {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
            <div key={d} className="dow">
              {d}
            </div>
          ))}
          {monthCells.map((d) => {
            const key = dayKey(d);
            const list = (byDay?.[key] ?? []).filter(inView);
            const shown = list.slice(0, CELL_EVENTS);
            const more = list.length - shown.length;
            return (
              <button
                key={key}
                className="cell"
                data-out={d.getMonth() !== cursor.getMonth()}
                data-today={key === todayKey}
                data-sel={key === selectedDay}
                data-note={wroteOn(key)}
                onClick={() => onSelectDay(key)}
                onDoubleClick={() => onCreateForDay(key)}
                title={list.length ? list.map((o) => `· ${o.title}`).join('\n') : undefined}
              >
                <span className="dnum">{d.getDate()}</span>
                <span className="evs">
                  {shown.map((o) => (
                    <span key={o.key} className="ev" data-done={o.done}>
                      {!o.allDay && <span className="ev-t">{formatTime(new Date(o.at))}</span>}
                      <span className="ev-x">{o.title}</span>
                    </span>
                  ))}
                  {more > 0 && <span className="ev ev-more">还有 {more} 条</span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="week">
          {weekCells.map((d) => {
            const key = dayKey(d);
            const list = (byDay?.[key] ?? []).filter(inView);
            return (
              <div className="wk-col" key={key}>
                <button
                  className="wk-hd"
                  data-today={key === todayKey}
                  data-sel={key === selectedDay}
                  onClick={() => onSelectDay(key)}
                  onDoubleClick={() => onCreateForDay(key)}
                >
                  <span className="wk-dow">{weekdayLabel(d)}</span>
                  <span className="wk-dnum">{d.getDate()}</span>
                </button>
                <div className="wk-evs">
                  {list.map((o) => (
                    <button
                      key={o.key}
                      className="wk-ev"
                      data-done={o.done}
                      onClick={() => onEdit(o)}
                      title={`${o.title}${o.workspaceId ? ` · ${workspaceLabel(o.workspaceId)}` : ''}`}
                    >
                      <span className="wk-ev-t">{o.allDay ? '全天' : formatTime(new Date(o.at))}</span>
                      <span className="wk-ev-x">{o.title}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="wk-add"
                  onClick={() => onCreateForDay(key)}
                  aria-label={`在 ${key} 新建事项`}
                  title="在这一天新建"
                >
                  ＋
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/*
        The day the grid has selected, at the grid's own width so the two
        halves line up. Always rendered, in both modes: after clicking a day,
        "what is on it" is the question, and a month cell only ever had room to
        answer half of it.
      */}
      <div className="cal-detail">
        <div className="group-hd" style={{ paddingTop: 14 }}>
          {formatDay(dayStart(selectedDay))} {weekdayLabel(dayStart(selectedDay))}
          <span className="grow" />
          <button className="btn tiny" onClick={() => onCreateForDay(selectedDay)}>
            ＋ 新建
          </button>
          <button className="btn tiny" onClick={() => onOpenDay(selectedDay)}>
            {dayWrote ? '看这一天的记录' : '写这一天的记录'}
          </button>
        </div>

        {dayItems.length === 0 ? (
          <div className="empty" style={{ padding: '14px 0' }}>
            {(byDay?.[selectedDay] ?? []).length > 0 ? '这一天的事项都在别的工作区' : '这一天没有事项'}
          </div>
        ) : (
          dayItems.map((o) => (
            <div key={o.key} className="row" data-done={o.done} onClick={() => onEdit(o)}>
              <button
                className="tick"
                data-done={o.done}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(o);
                }}
                title={o.done ? '标记为未完成' : '标记完成'}
                aria-label={o.done ? `把「${o.title}」标记为未完成` : `把「${o.title}」标记完成`}
              >
                ✓
              </button>
              <div className="main">
                <div className="title">
                  {o.title}
                  {o.workspaceId && o.workspaceId !== currentWorkspaceId && (
                    <span className="ws-badge">{workspaceLabel(o.workspaceId)}</span>
                  )}
                </div>
                <div className="when">{o.allDay ? '全天' : formatTime(new Date(o.at))}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * Things with no date at all.
 *
 * They belong to no day, so no day can show them — which is exactly why they
 * are the easiest things in a planner to forget. This strip is their home, and
 * the reason the agenda's 「无日期」 group is not the only place they appear.
 */
export function UnscheduledLane({
  items,
  empty,
  onSelect,
}: {
  items: Array<{ id: string; title: string; workspaceId?: string }>;
  empty?: ReactNode;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return empty ? <div className="unsched empty-lane">{empty}</div> : null;
  }
  return (
    <div className="unsched">
      <div className="group-hd" data-first="true">
        未排期
        <span style={{ opacity: 0.6 }}>{items.length}</span>
        <span className="grow" />
        <span className="unsched-hint">没有时间的待办</span>
      </div>
      <div className="unsched-items">
        {items.map((i) => (
          <button key={i.id} className="unsched-chip" onClick={() => onSelect(i.id)} title={i.title}>
            {i.title}
          </button>
        ))}
      </div>
    </div>
  );
}
