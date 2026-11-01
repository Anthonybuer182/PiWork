/**
 * The panel shell: loads state, keeps it fresh, and routes the three views.
 *
 * Data flow is pull-first with push on change. The panel asks for the state
 * when it mounts — so a panel remounted by the keep-alive budget or a window
 * reload comes back correct — and the backend pushes a fresh view after every
 * mutation and tick. Push alone would leave a remounted panel blank until the
 * next tick, which can be thirty seconds of looking broken.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonthOccurrence, MonthView, RangeView, ViewItem, Views } from '../../core/view.js';
import type { DayNote } from '../../core/types.js';
import type { DayPage } from '../../core/day.js';
import {
  addDays,
  dayKey,
  dayStart,
  formatDay,
  weekdayLabel,
  workspaceLabel,
} from '../../core/time.js';
import type { PiSDK } from './sdk.js';
import { Editor, Confirm } from './editor.js';
import { AgendaView, LogView } from './views.js';
import { CalendarView, UnscheduledLane, type CalendarMode } from './calendar.js';
import { DayPageView } from './day.js';

/** Local midnight on the Sunday of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = dayStart(dayKey(d));
  x.setDate(x.getDate() - x.getDay());
  return x;
}

/** How many days the month containing `d` has — for clamping a day-of-month. */
function lastDayOf(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Which slice of the planner is on screen.
 *
 * `all` is the default everywhere except the day page: a calendar that only
 * shows one project stops being a calendar. `workspace` narrows to the current
 * project *plus* global items — the global ones belong to no project and are
 * invisible in a project-only view, which would be a surprise.
 */
type Scope = 'all' | 'workspace';

const inScope = (itemWorkspaceId: string | undefined, scope: Scope, current: string | null): boolean =>
  scope === 'all' || !itemWorkspaceId || itemWorkspaceId === current;

type Tab = 'agenda' | 'month' | 'day' | 'log';

export function App({ sdk }: { sdk: PiSDK }) {
  const [view, setView] = useState<Views | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('agenda');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ViewItem | 'new' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Which workspace this panel serves. Null until the host says (or forever,
  // in a host that predates protocol 7) — then everything is simply global.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // Agenda and calendar default to everything; the day page defaults to the
  // project, because "what did I do today" is asked about one project.
  const [scope, setScope] = useState<Scope>('all');
  const [dayScope, setDayScope] = useState<Scope>('workspace');
  // A window with no workspace has nothing to narrow to — the "current
  // workspace" chip would be both disabled and selected, which reads as broken.
  const dayScopeNow: Scope = workspaceId ? dayScope : 'all';

  // Calendar cursor + the days it currently shows. The panel cannot expand
  // RRULEs itself, so the visible range comes from the backend — a month for
  // the grid, seven days for the week, one expansion routine behind both.
  const [calMode, setCalMode] = useState<CalendarMode>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [calView, setCalView] = useState<{
    byDay: Record<string, MonthOccurrence[]>;
    label: string;
  } | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));
  /** Set when the editor was opened from a specific day in the calendar. */
  const [editorDay, setEditorDay] = useState<string | null>(null);

  // 回顾 — one day at a time.
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [dayPage, setDayPage] = useState<DayPage | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await sdk.request<Views>('state.get'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sdk]);

  const loadCalendar = useCallback(
    async (d: Date, mode: CalendarMode) => {
      try {
        if (mode === 'month') {
          const v = await sdk.request<MonthView>('month.get', {
            year: d.getFullYear(),
            month: d.getMonth(),
          });
          setCalView({ byDay: v.byDay, label: v.label });
          return;
        }
        const from = startOfWeek(d);
        const to = addDays(from, 6);
        const v = await sdk.request<RangeView>('range.get', {
          from: dayKey(from),
          to: dayKey(to),
        });
        setCalView({ byDay: v.byDay, label: `${formatDay(from)} – ${formatDay(to)}` });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sdk],
  );

  const loadDay = useCallback(
    async (d: string) => {
      try {
        // `scope: 'all'` and a workspace id are different questions: the former
        // asks for every project, the latter for this one plus global. Sending
        // neither means "global only", which is what an empty workspace id is.
        setDayPage(
          await sdk.request<DayPage>(
            'day.get',
            dayScopeNow === 'all'
              ? { day: d, scope: 'all' }
              : { day: d, ...(workspaceId ? { workspaceId } : {}) },
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sdk, dayScopeNow, workspaceId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Workspace comes from the host, not from a backend round trip — see
  // `PiSDK.onWorkspace`. Replays the current value on subscribe, so a panel
  // that mounts before the shell settles still gets it.
  useEffect(() => {
    if (sdk.workspace !== undefined) setWorkspaceId(sdk.workspace ?? null);
    sdk.onWorkspace?.((next) => setWorkspaceId(next));
  }, [sdk]);

  useEffect(() => {
    if (tab === 'month') void loadCalendar(cursor, calMode);
  }, [tab, cursor, calMode, loadCalendar]);

  useEffect(() => {
    if (tab === 'day') void loadDay(day);
  }, [tab, day, loadDay]);

  // Backend pushes. The ref keeps the latest handler without re-subscribing.
  const onMessage = useRef<(payload: unknown) => void>(() => {});
  onMessage.current = (payload: unknown) => {
    const p = payload as { kind?: string; event?: string; data?: Views } | undefined;
    if (p?.kind === 'event' && p.event === 'ui.render' && p.data) setView(p.data);
  };
  useEffect(() => {
    sdk.onMessage((payload) => onMessage.current(payload));
  }, [sdk]);

  const act = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError(null);
      try {
        await sdk.request(method, params);
        await refresh();
        if (tab === 'month') await loadCalendar(cursor, calMode);
        if (tab === 'day') await loadDay(day);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sdk, refresh, loadCalendar, loadDay, tab, cursor, calMode, day],
  );

  const now = view ? new Date(view.now) : new Date();
  const items = useMemo(() => {
    const all = (view?.items ?? []).filter((i) => inScope(i.workspaceId, scope, workspaceId));
    const needle = query.trim();
    if (!needle) return all;
    return all.filter(
      (i) => i.title.includes(needle) || (i.note ?? '').includes(needle) || i.repeatLabel.includes(needle),
    );
  }, [view, query, scope, workspaceId]);

  /**
   * Days whose written note matches the search box.
   *
   * Found here rather than with a real search index, which would be a project
   * in itself and premature against a few weeks of notes. It exists so that
   * "where did I write about X" has an answer that does not mean clicking
   * through the month grid.
   */
  const noteHits = useMemo(() => {
    const needle = query.trim();
    if (!needle || !view) return [];
    const hits: Array<[string, DayNote]> = [];
    for (const [day, scopes] of Object.entries(view.notes)) {
      for (const [scopeKey, note] of Object.entries(scopes)) {
        // '' is global and always in scope; a project's note only when the
        // filter is on that project or showing everything.
        if (scope !== 'all' && scopeKey && scopeKey !== workspaceId) continue;
        if (!note.text.includes(needle)) continue;
        hits.push([day, note]);
        break;
      }
    }
    return hits.sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 20);
  }, [view, query, scope, workspaceId]);

  const openCount = items.filter((i) => !i.done && i.group !== 'later').length;
  const missedCount = view?.missed.length ?? 0;

  const onSubmit = async (params: Record<string, unknown>): Promise<void> => {
    // The editor owns the 归属 decision — it seeds a new item with this
    // workspace and keeps an existing one exactly as it was. Re-deriving it
    // here is how an edit made while looking at 「全部」 would silently pull
    // another project's item into this one.
    await act('item.save', params);
  };

  /**
   * Move the calendar one month or one week, and take the selection with it.
   *
   * The day panel under the grid answers about the selected day. Leaving that
   * selection behind while the grid moves on makes the two halves of the same
   * screen disagree about which day is being talked about.
   */
  const shiftCalendar = (dir: number): void => {
    const next = new Date(cursor);
    if (calMode === 'month') {
      const dayOfMonth = next.getDate();
      next.setDate(1);
      next.setMonth(next.getMonth() + dir);
      next.setDate(Math.min(dayOfMonth, lastDayOf(next)));
    } else {
      next.setDate(next.getDate() + dir * 7);
    }
    setCursor(next);

    const sel = dayStart(selectedDay);
    if (calMode === 'month') {
      setSelectedDay(
        dayKey(new Date(next.getFullYear(), next.getMonth(), Math.min(sel.getDate(), lastDayOf(next)))),
      );
    } else {
      setSelectedDay(dayKey(addDays(sel, dir * 7)));
    }
  };

  const goToday = (): void => {
    const d = new Date();
    setCursor(d);
    setSelectedDay(dayKey(d));
  };

  /**
   * Selecting a day also moves the cursor onto it.
   *
   * The week view is fetched from the cursor, but drawn around the selection.
   * If the two could drift — click 11月30 while the cursor is still on 11月1,
   * switch to 周 — the grid would show one week and the day panel another,
   * with the selected day not on screen at all. One anchor, never two.
   */
  const selectDay = (d: string): void => {
    setSelectedDay(d);
    setCursor(dayStart(d));
  };

  /** Opens the editor already dated — what 「＋ 新建」 on a calendar day means. */
  const createForDay = (day: string): void => {
    setEditorDay(day);
    setEditing('new');
  };

  const editOccurrence = (occ: MonthOccurrence): void => {
    const found = view?.items.find((i) => i.id === occ.itemId);
    if (!found) return;
    setEditorDay(null);
    setEditing(found);
  };

  /** Undated items, scoped — the calendar's backlog strip. */
  const undated = items.filter((i) => i.group === 'undated');

  // The day page has its own filter state, so the chips read and write
  // whichever one the visible tab is using. 「记录」is a flat history of
  // firings and has no scope, so the control is not shown there at all —
  // a filter that filters nothing is worse than no filter.
  const activeScope = tab === 'day' ? dayScopeNow : scope;
  const setActiveScope = tab === 'day' ? setDayScope : setScope;
  const scopeRow = tab === 'log' ? null : (
    <div className="scope-row">
      <span className="scope-label">范围</span>
      <button
        className="scope-chip"
        data-on={activeScope === 'all'}
        aria-pressed={activeScope === 'all'}
        onClick={() => setActiveScope('all')}
      >
        全部工作区
      </button>
      <button
        className="scope-chip"
        data-on={activeScope === 'workspace'}
        aria-pressed={activeScope === 'workspace'}
        disabled={!workspaceId}
        title={workspaceId ?? '这个窗口还没有打开工作区'}
        onClick={() => setActiveScope('workspace')}
      >
        {workspaceId ? workspaceLabel(workspaceId) : '当前工作区'}
      </button>
    </div>
  );

  /** Items the current filter hides — the empty state needs to say so. */
  const hiddenByScope = (view?.items ?? []).filter((i) => !inScope(i.workspaceId, scope, workspaceId)).length;

  /**
   * What the agenda says when it has nothing to show.
   *
   * "还没有任何事项" is a lie when the list is empty only because of the
   * filter — the user's items exist, they are just in another project, and
   * telling them so is the difference between a filter and a disappearing act.
   */
  const agendaEmpty =
    query.trim().length > 0 ? (
      <>
        没有找到「{query.trim()}」
        <br />
        换个词试试，或者切到「全部工作区」
      </>
    ) : hiddenByScope > 0 ? (
      <>
        这个工作区还没有事项
        <br />
        切到「全部工作区」能看到另外 {hiddenByScope} 条
      </>
    ) : (
      <>
        还没有任何事项
        <br />
        点「＋ 新建」，或者直接对 agent 说「记一下…」
      </>
    );

  return (
    <div className="app">
      <div className="hd">
        <div className="hd-row">
          <div className="tabs">
            <button className="tab" data-on={tab === 'agenda'} onClick={() => setTab('agenda')}>
              议程
              {openCount > 0 && <span className="n">{openCount}</span>}
            </button>
            <button className="tab" data-on={tab === 'month'} onClick={() => setTab('month')}>
              日历
            </button>
            <button className="tab" data-on={tab === 'day'} onClick={() => setTab('day')}>
              回顾
            </button>
            <button className="tab" data-on={tab === 'log'} onClick={() => setTab('log')}>
              记录
              {missedCount > 0 && <span className="n">{missedCount}</span>}
            </button>
          </div>
          <span className="grow" />
          <button
            className="btn primary"
            onClick={() => {
              setEditorDay(null);
              setEditing('new');
            }}
          >
            ＋ 新建
          </button>
        </div>

        {scopeRow}

        {tab === 'agenda' && (
          <input placeholder="搜索事项…" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        {/*
          Kept in the header only when it is actionable. As a permanent banner
          it is the kind of line a user stops reading after the second launch —
          and it pushes the list down on every open. The 记录 tab states the
          same rule where the consequences actually live.
        */}
        {missedCount > 0 && (
          <div className="caveat">
            <b>有 {missedCount} 次触发没送到。</b>
            <span>去「记录」看看要不要补跑。</span>
          </div>
        )}
      </div>

      <div className="body">
        {error && <div className="err">{error}</div>}

        {view?.truncated.length ? (
          <div className="warn">
            有 {view.truncated.length} 条事项的重复规则展开次数过多，本次只计算了前一部分。
            检查一下重复规则是不是设得太密（比如每秒一次）。
          </div>
        ) : null}

        {!view ? (
          <div className="empty">读取中…</div>
        ) : tab === 'agenda' ? (
          <>
            {noteHits.length > 0 && (
              <div className="day-col" style={{ marginBottom: 10 }}>
                <div className="day-sec-hd">日记里提到「{query.trim()}」</div>
                {noteHits.map(([d, n]) => (
                  <div
                    key={d}
                    className="row"
                    onClick={() => {
                      setDay(d);
                      setTab('day');
                    }}
                  >
                    <div className="main">
                      <div className="title">
                        {formatDay(dayStart(d))} {weekdayLabel(dayStart(d))}
                      </div>
                      <div className="meta">
                        <span>{n.text.replace(/\s+/g, ' ').slice(0, 70)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <AgendaView
              items={items}
              now={now}
              empty={agendaEmpty}
              currentWorkspaceId={workspaceId}
              selectedId={editing && editing !== 'new' ? editing.id : undefined}
              onSelect={(item) => setEditing(item)}
              onToggle={(item) => void act('item.toggle', { id: item.id, occurrenceKey: item.occurrenceKey })}
            />
          </>
        ) : tab === 'day' ? (
          <DayPageView
            page={dayPage}
            noteKey={workspaceId ?? ''}
            onNavigate={setDay}
            onSaveNote={async (d, t) => {
              // Writes always go to the current workspace, never to "all":
              // there is no such thing as a sentence belonging to every
              // project at once.
              await act('day.note.set', {
                day: d,
                text: t,
                mode: 'replace',
                ...(workspaceId ? { workspaceId } : {}),
              });
            }}
            onRerun={(key) => void act('run.rerun', { key })}
            onOpenItem={(id) => {
              const found = view.items.find((i) => i.id === id);
              if (found) setEditing(found);
            }}
          />
        ) : tab === 'month' ? (
          <>
            <CalendarView
              mode={calMode}
              onMode={setCalMode}
              byDay={calView?.byDay ?? null}
              label={calView?.label ?? ''}
              cursor={cursor}
              selectedDay={selectedDay}
              notes={view.notes}
              scope={scope}
              currentWorkspaceId={workspaceId}
              onPrev={() => shiftCalendar(-1)}
              onNext={() => shiftCalendar(1)}
              onToday={goToday}
              onSelectDay={selectDay}
              onOpenDay={(d) => {
                setDay(d);
                setTab('day');
              }}
              onToggle={(occ) => void act('item.toggle', { id: occ.itemId, occurrenceKey: occ.key })}
              onEdit={editOccurrence}
              onCreateForDay={createForDay}
            />
            <UnscheduledLane
              items={undated}
              onSelect={(id) => {
                const found = view.items.find((i) => i.id === id);
                if (found) {
                  setEditorDay(null);
                  setEditing(found);
                }
              }}
            />
          </>
        ) : (
          <LogView
            view={view}
            onRerun={(key) => void act('run.rerun', { key })}
            onClear={() => setConfirmClear(true)}
          />
        )}
      </div>

      {editing && (
        <Editor
          item={editing === 'new' ? undefined : editing}
          workspaces={view?.workspaces ?? []}
          currentWorkspaceId={workspaceId}
          initialDay={editing === 'new' ? (editorDay ?? undefined) : undefined}
          onSave={onSubmit}
          onClose={() => setEditing(null)}
          onDelete={
            editing === 'new'
              ? undefined
              : async () => {
                  await act('item.remove', { id: editing.id });
                  setEditing(null);
                }
          }
        />
      )}

      {confirmClear && (
        <Confirm
          title="清空触发记录？"
          body="记录只是历史，清掉不影响任何事项本身。"
          confirmLabel="清空"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void act('run.clear', {});
          }}
        />
      )}
    </div>
  );
}
