/**
 * The item editor.
 *
 * Two things it deliberately does not do:
 *
 * - **It never invents a time.** `无时间` is a real state (a plain to-do), and
 *   turning it into midnight would both lie about the item and start firing
 *   triggers at 00:00. So the date is optional and `allDay` is separate from
 *   "has a date".
 * - **It never lets a trigger exist without a time.** A reminder with nothing
 *   to count back from can never fire; offering the control would be a promise
 *   the plugin cannot keep, so the whole section is disabled until there is a
 *   date and says why.
 */
import { useMemo, useState } from 'react';
import type { Trigger } from '../../core/types.js';
import { parseRepeat, buildRRule, describeRepeat, type RepeatKind } from '../../core/recur.js';
import { dayKey, formatTime, toLocalIso, workspaceLabel } from '../../core/time.js';
import type { ViewItem } from '../../core/view.js';

const REPEAT_KINDS: Array<{ kind: RepeatKind; label: string }> = [
  { kind: 'none', label: '不重复' },
  { kind: 'daily', label: '每天' },
  { kind: 'weekly', label: '每周' },
  { kind: 'monthly', label: '每月' },
  { kind: 'yearly', label: '每年' },
  { kind: 'custom', label: '自定义' },
];

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/** Preset offsets, in minutes before. `custom` opens a number field. */
const OFFSETS: Array<{ label: string; value: number | 'custom' }> = [
  { label: '到点时', value: 0 },
  { label: '提前 5 分钟', value: -5 },
  { label: '提前 15 分钟', value: -15 },
  { label: '提前 30 分钟', value: -30 },
  { label: '提前 1 小时', value: -60 },
  { label: '提前 1 天', value: -1440 },
  { label: '自定义…', value: 'custom' },
];

export interface Draft {
  id?: string;
  title: string;
  note: string;
  /** `''` = global. Decides which workspace's calendar this shows up in. */
  workspaceId: string;
  hasTime: boolean;
  date: string;
  time: string;
  allDay: boolean;
  repeatKind: RepeatKind;
  byDay: number[];
  rawRrule: string;
  triggers: Trigger[];
}

function blankDraft(currentWorkspaceId: string | null, initialDay?: string): Draft {
  const now = new Date();
  return {
    id: undefined,
    title: '',
    note: '',
    // New items belong to the project you are in — that is where you were
    // standing when you wrote them down.
    workspaceId: currentWorkspaceId ?? '',
    // Opened from a day in the calendar, the item is meant to land on that
    // day — so the time is on, pre-set to the date clicked. From the generic
    // 「＋ 新建」 there is no such intent, and a plain to-do is the safer
    // default.
    hasTime: Boolean(initialDay),
    date: initialDay ?? dayKey(now),
    time: '09:00',
    allDay: false,
    repeatKind: 'none',
    byDay: [now.getDay()],
    rawRrule: '',
    triggers: [],
  };
}

function draftFrom(item: ViewItem): Draft {
  const start = item.start ? new Date(item.start) : null;
  const spec = parseRepeat(item.rrule);
  return {
    id: item.id,
    title: item.title,
    note: item.note ?? '',
    // The item's own owner, never the filter's. Editing something you can see
    // through 全部 must not quietly move it into the current project.
    workspaceId: item.workspaceId ?? '',
    hasTime: Boolean(start),
    date: start ? dayKey(start) : dayKey(new Date()),
    time: start ? formatTime(start) : '09:00',
    allDay: Boolean(item.allDay),
    repeatKind: spec.kind,
    byDay: spec.byDay?.length ? spec.byDay : [start ? start.getDay() : new Date().getDay()],
    rawRrule: spec.raw ?? '',
    triggers: item.triggers.map((t) => ({ ...t })),
  };
}

let triggerSeq = 0;
function newTrigger(): Trigger {
  return {
    id: `g${Date.now().toString(36)}${(triggerSeq++).toString(36)}`,
    // "到点时" rather than "提前 15 分钟": the row is added before the action
    // is chosen, and firing exactly when the thing is due is the right default
    // for both kinds — an agent told to run 15 minutes early is a surprise,
    // not a feature.
    offsetMinutes: 0,
    action: { kind: 'notify' },
    enabled: true,
  };
}

export function Editor({
  item,
  workspaces,
  currentWorkspaceId,
  initialDay,
  onSave,
  onDelete,
  onClose,
}: {
  /** Absent = creating a new item. */
  item?: ViewItem;
  /** Every workspace the planner knows about, for the 归属 select. */
  workspaces: string[];
  currentWorkspaceId: string | null;
  /** A day picked in the calendar — a new item defaults onto it. */
  initialDay?: string;
  onSave: (params: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    item ? draftFrom(item) : blankDraft(currentWorkspaceId, initialDay),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  /**
   * Options for 归属: everything the planner knows, plus the item's own owner
   * and this window's workspace. The last one matters for an item whose
   * project was deleted — dropping it from the list would silently rewrite it
   * to 全局 the moment the dialog opened.
   */
  const ownerOptions = useMemo(() => {
    const ids = new Set<string>(workspaces);
    if (currentWorkspaceId) ids.add(currentWorkspaceId);
    if (draft.workspaceId) ids.add(draft.workspaceId);
    return [...ids].sort((a, b) => workspaceLabel(a).localeCompare(workspaceLabel(b)));
  }, [workspaces, currentWorkspaceId, draft.workspaceId]);

  /** Built here so the preview line and the save agree on one interpretation. */
  const rrule = useMemo(
    () => buildRRule({ kind: draft.repeatKind, byDay: draft.byDay, raw: draft.rawRrule }),
    [draft.repeatKind, draft.byDay, draft.rawRrule],
  );

  const start = useMemo(() => {
    if (!draft.hasTime) return null;
    const d = new Date(`${draft.date}T${draft.time || '00:00'}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [draft.hasTime, draft.date, draft.time]);

  async function submit(): Promise<void> {
    const title = draft.title.trim();
    if (!title) {
      setError('给这件事起个名字吧');
      return;
    }
    if (draft.hasTime && !start) {
      setError('日期或时间读不出来，检查一下');
      return;
    }
    if (rrule && !draft.hasTime) {
      setError('要重复就得先有时间');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        id: draft.id,
        title,
        note: draft.note.trim() || undefined,
        workspaceId: draft.workspaceId || null,
        start: start ? toLocalIso(start) : null,
        allDay: draft.hasTime ? draft.allDay : undefined,
        rrule: rrule ?? null,
        // A trigger with no date cannot fire, so it is not saved either.
        triggers: draft.hasTime ? draft.triggers : [],
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      {error && <div className="err">{error}</div>}

      <div className="field">
        <label>标题</label>
        <input
          autoFocus
          value={draft.title}
          placeholder="要做什么？"
          onChange={(e) => set('title', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
      </div>

      <div className="field">
        <label>备注</label>
        <textarea value={draft.note} placeholder="可选" onChange={(e) => set('note', e.target.value)} />
      </div>

      <div className="field">
        <label>归属</label>
        <select value={draft.workspaceId} onChange={(e) => set('workspaceId', e.target.value)}>
          <option value="">全局（不属于任何项目）</option>
          {ownerOptions.map((id) => (
            <option key={id} value={id}>
              {workspaceLabel(id)}
              {id === currentWorkspaceId ? '（当前工作区）' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>时间</label>
        <div className="chips" style={{ marginBottom: 6 }}>
          <button className="chip" data-on={!draft.hasTime} onClick={() => set('hasTime', false)}>
            无时间
          </button>
          <button className="chip" data-on={draft.hasTime} onClick={() => set('hasTime', true)}>
            有日期
          </button>
        </div>
        {draft.hasTime && (
          <>
            <div className="f2">
              <input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
              <input
                type="time"
                value={draft.time}
                disabled={draft.allDay}
                onChange={(e) => set('time', e.target.value)}
              />
            </div>
            <div className="chips" style={{ marginTop: 6 }}>
              <button className="chip" data-on={draft.allDay} onClick={() => set('allDay', !draft.allDay)}>
                全天
              </button>
            </div>
          </>
        )}
        {!draft.hasTime && (
          <div className="hint">
            没有时间就是一条纯待办，不会触发任何提醒。要定时提醒、或者让 agent 到点干活，先切到「有日期」。
          </div>
        )}
      </div>

      {draft.hasTime && (
        <div className="field">
          <label>重复</label>
          <div className="chips">
            {REPEAT_KINDS.map((r) => (
              <button
                key={r.kind}
                className="chip"
                data-on={draft.repeatKind === r.kind}
                onClick={() => set('repeatKind', r.kind)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {draft.repeatKind === 'weekly' && (
            <div className="chips" style={{ marginTop: 6 }}>
              {DOW.map((d, i) => (
                <button
                  key={d}
                  className="chip"
                  data-on={draft.byDay.includes(i)}
                  onClick={() =>
                    set(
                      'byDay',
                      draft.byDay.includes(i) ? draft.byDay.filter((x) => x !== i) : [...draft.byDay, i],
                    )
                  }
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          {draft.repeatKind === 'custom' && (
            <>
              <input
                style={{ marginTop: 6 }}
                value={draft.rawRrule}
                placeholder="FREQ=MONTHLY;BYDAY=-1FR"
                onChange={(e) => set('rawRrule', e.target.value)}
              />
              <div className="hint">
                标准 iCalendar RRULE。例如「每月最后一个周五」是 FREQ=MONTHLY;BYDAY=-1FR。
              </div>
            </>
          )}
          {rrule && <div className="hint">当前：{describeRepeat(rrule)}</div>}
        </div>
      )}

      {draft.hasTime && (
        <div className="field">
          <label>触发（到点做什么）</label>
          {draft.triggers.length === 0 && (
            <div className="hint" style={{ marginBottom: 6 }}>
              还没有触发。加一个，到点就会发系统通知，或者让 agent 去干活。
            </div>
          )}
          {draft.triggers.map((t, i) => (
            <TriggerRow
              key={t.id}
              trigger={t}
              onChange={(next) =>
                set(
                  'triggers',
                  draft.triggers.map((x, j) => (j === i ? next : x)),
                )
              }
              onRemove={() => set('triggers', draft.triggers.filter((_, j) => j !== i))}
            />
          ))}
          <button className="btn tiny" onClick={() => set('triggers', [...draft.triggers, newTrigger()])}>
            + 加一个触发
          </button>
        </div>
      )}

      <div className="editor-actions">
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '保存中…' : draft.id ? '保存' : '创建'}
        </button>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <span className="grow" />
        {draft.id && onDelete && (
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>
            删除
          </button>
        )}
      </div>

      {confirmDelete && (
        <Confirm
          title="删除这件事项？"
          body={`「${draft.title}」会被删掉。已经跑过的触发记录会保留在记录里。`}
          confirmLabel="删除"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void onDelete?.();
          }}
        />
      )}
    </div>
  );
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
  onRemove: () => void;
}) {
  const preset = OFFSETS.find((o) => o.value === trigger.offsetMinutes);
  const [custom, setCustom] = useState(preset === undefined);

  return (
    <div className="trig">
      <select
        value={custom ? 'custom' : String(trigger.offsetMinutes)}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
          } else {
            setCustom(false);
            onChange({ ...trigger, offsetMinutes: Number(e.target.value) });
          }
        }}
      >
        {OFFSETS.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>

      {custom && (
        <input
          type="number"
          style={{ maxWidth: 76 }}
          value={Math.abs(trigger.offsetMinutes)}
          title="提前多少分钟"
          onChange={(e) => onChange({ ...trigger, offsetMinutes: -Math.abs(Number(e.target.value) || 0) })}
        />
      )}

      <select
        value={trigger.action.kind}
        onChange={(e) =>
          onChange({
            ...trigger,
            action:
              e.target.value === 'notify'
                ? { kind: 'notify' }
                : { kind: 'agent', prompt: trigger.action.kind === 'agent' ? trigger.action.prompt : '' },
          })
        }
      >
        <option value="notify">系统通知</option>
        <option value="agent">让 agent 干活</option>
      </select>

      {trigger.action.kind === 'agent' && (
        <input
          value={trigger.action.prompt}
          placeholder="到点发给 agent 的话"
          onChange={(e) => onChange({ ...trigger, action: { kind: 'agent', prompt: e.target.value } })}
        />
      )}

      <button className="btn tiny" onClick={onRemove} title="删掉这个触发">
        ×
      </button>
    </div>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mask" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="acts">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
