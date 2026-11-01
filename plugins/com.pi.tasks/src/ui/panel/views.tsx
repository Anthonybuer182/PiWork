/**
 * The two list views: the agenda, and the run log.
 *
 * The agenda is the default on purpose. A calendar grid answers "what does this
 * month look like", which is rarely the question standing in front of the app —
 * "what is coming up and what did I forget" is, and that is what a grouped list
 * answers without any decoding. The calendar is the second question, asked on
 * purpose and answered in `calendar.tsx`.
 */
import type { ReactNode } from 'react';
import type { RunRecord } from '../../core/types.js';
import { GROUP_LABEL, GROUP_ORDER, type AgendaGroup, type ViewItem, type Views } from '../../core/view.js';
import { formatWhen, workspaceLabel } from '../../core/time.js';

const emptyGroup = (): Record<AgendaGroup, ViewItem[]> => ({
  overdue: [], today: [], tomorrow: [], week: [], later: [], undated: [],
});

export function AgendaView({
  items,
  selectedId,
  onSelect,
  onToggle,
  now,
  currentWorkspaceId,
  empty,
}: {
  items: ViewItem[];
  selectedId?: string;
  onSelect: (item: ViewItem) => void;
  onToggle: (item: ViewItem) => void;
  now: Date;
  /** Items from any other workspace get a badge saying whose they are. */
  currentWorkspaceId?: string | null;
  /**
   * What to say when the list is empty. Supplied by the shell because the
   * right words depend on whether it is empty of everything or only of what
   * the filter lets through.
   */
  empty?: ReactNode;
}) {
  const groups = emptyGroup();
  for (const item of items) groups[item.group]?.push(item);
  // Done items sink within their group so the open ones stay at the top.
  for (const key of GROUP_ORDER) {
    groups[key].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (a.start ?? '9999') < (b.start ?? '9999') ? -1 : 1;
    });
  }

  const total = GROUP_ORDER.reduce((n, k) => n + groups[k].length, 0);
  if (total === 0) {
    return (
      <div className="empty">
        {empty ?? (
          <>
            还没有任何事项
            <br />
            点「＋ 新建」，或者直接对 agent 说「记一下…」
          </>
        )}
      </div>
    );
  }

  let first = true;
  return (
    <>
      {GROUP_ORDER.map((key) => {
        const list = groups[key];
        if (list.length === 0) return null;
        const isFirst = first;
        first = false;
        return (
          <div key={key}>
            <div className={`group-hd ${key === 'overdue' ? 'overdue' : ''}`} data-first={isFirst}>
              {GROUP_LABEL[key]}
              <span style={{ opacity: 0.6 }}>{list.length}</span>
            </div>
            {list.map((item) => (
              <Row
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => onSelect(item)}
                onToggle={() => onToggle(item)}
                now={now}
                currentWorkspaceId={currentWorkspaceId}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function Row({
  item,
  selected,
  onSelect,
  onToggle,
  now,
  currentWorkspaceId,
}: {
  item: ViewItem;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  now: Date;
  currentWorkspaceId?: string | null;
}) {
  return (
    <div className="row" data-done={item.done} data-open={selected} onClick={onSelect}>
      <button
        className="tick"
        data-done={item.done}
        title={item.done ? '标记为未完成' : '标记完成'}
        aria-label={item.done ? `把「${item.title}」标记为未完成` : `把「${item.title}」标记完成`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        ✓
      </button>
      <div className="main">
        <div className="title">
          {item.title}
          {item.workspaceId && item.workspaceId !== currentWorkspaceId && (
            <span className="ws-badge">{workspaceLabel(item.workspaceId)}</span>
          )}
        </div>
        <div className={`when ${item.group === 'overdue' && !item.done ? 'overdue' : ''}`}>
          {item.whenLabel}
          {item.nextFireAt && ` · 下次 ${formatWhen(new Date(item.nextFireAt), now)}`}
        </div>
        {(item.rrule || item.triggerLabels.length > 0 || item.note) && (
          <div className="meta">
            {item.rrule && <span className="badge">↻ {item.repeatLabel}</span>}
            {item.triggerLabels.map((label, i) => (
              <span key={i} className="badge">
                {label}
              </span>
            ))}
            {item.note && <span>{item.note}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  ok: '已完成',
  missed: '错过',
  undelivered: '没送到',
  failed: '出错',
};

export function LogView({
  view,
  onRerun,
  onClear,
}: {
  view: Views;
  onRerun: (key: string) => void;
  onClear: () => void;
}) {
  const { runs, missed } = view;

  // The rule that matters, stated where its consequences are. It used to sit
  // in the panel header as a permanent banner, where it was read once and then
  // became furniture.
  const caveat = (
    <div className="hint" style={{ marginBottom: 10 }}>
      定时任务只在应用运行时触发。没运行时错过的会记在这里，等你决定要不要补跑——不会自动补。
    </div>
  );

  if (runs.length === 0) {
    return (
      <>
        {caveat}
        <div className="empty">
          还没有触发记录
          <br />
          给事项加一个触发，到点后这里会记下发生了什么
        </div>
      </>
    );
  }

  return (
    <>
      {caveat}
      {missed.length > 0 && (
        <>
          <div className="group-hd overdue" data-first="true">
            需要你决定 · {missed.length}
          </div>
          <div className="warn" style={{ marginBottom: 10 }}>
            这些到点的时候应用没有在运行（或者窗口没开）。它们不会自己补跑 ——
            点右边的「补跑」才会执行。
          </div>
          {missed.map((r) => (
            <div key={r.key} className="log-row">
              <span className={`st ${r.status}`} />
              <div className="log-main">
                <div className="log-title">
                  <span className="t">{r.itemTitle}</span>
                  <span className="badge">{r.action === 'notify' ? '通知' : 'agent'}</span>
                </div>
                <div className="log-sub">
                  本该 {formatWhen(new Date(r.dueAt), new Date(view.now))}
                  {r.detail ? ` · ${r.detail}` : ''}
                </div>
              </div>
              <button className="btn tiny" onClick={() => onRerun(r.key)}>
                补跑
              </button>
            </div>
          ))}
        </>
      )}

      <div className="group-hd" data-first={missed.length === 0 ? 'true' : 'false'}>
        全部记录
        <span className="grow" />
        <button className="btn tiny" onClick={onClear}>
          清空
        </button>
      </div>
      {runs.map((r) => (
        <div key={`${r.key}-${r.firedAt ?? r.dueAt}`} className="log-row">
          <span className={`st ${r.status}`} />
          <div className="log-main">
            <div className="log-title">
              <span className="t">{r.itemTitle}</span>
              <span className="badge">{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="log-sub">
              {r.firedAt
                ? `${formatWhen(new Date(r.firedAt), new Date(view.now))} 执行`
                : `本该 ${formatWhen(new Date(r.dueAt), new Date(view.now))}`}
              {r.detail ? ` · ${r.detail}` : ''}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
