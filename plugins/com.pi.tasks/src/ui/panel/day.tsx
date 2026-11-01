/**
 * 回顾 — one page per day.
 *
 * The top half is assembled from data the plugin already had, so opening a day
 * never shows a blank box: you see what you planned, what you actually
 * finished, and what never happened. The bottom half is yours to write in.
 *
 * That order matters. A page that opens empty is a page you stop opening; a
 * page that already says "you finished these two things" only needs a sentence
 * added. It is also why the note saves itself — a save button is a small
 * friction that, on a thing you are supposed to do daily, is the difference
 * between a habit and a chore.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DayEntry, DayPage } from '../../core/day.js';
import type { RunRecord } from '../../core/types.js';
import { dayKey, dayStart, formatDay, weekdayLabel, workspaceLabel } from '../../core/time.js';

/** Quiet period before a keystroke becomes a save. */
const AUTOSAVE_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved';

export function DayPageView({
  page,
  noteKey,
  onNavigate,
  onSaveNote,
  onRerun,
  onOpenItem,
}: {
  page: DayPage | null;
  /**
   * Which note the textarea edits: `''` for the global one, else a workspace
   * id. Notes are per scope, so this is the difference between writing "what I
   * did in this project" and overwriting another project's day by accident.
   */
  noteKey: string;
  onNavigate: (day: string) => void;
  onSaveNote: (day: string, text: string) => Promise<void>;
  onRerun: (key: string) => void;
  onOpenItem: (itemId: string) => void;
}) {
  const day = page?.day ?? dayKey(new Date());
  const date = dayStart(day);
  const isToday = day === dayKey(new Date());

  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which day the textarea currently holds, so switching days does not
  // overwrite the new day's text with the old day's keystrokes.
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    const incoming = page?.notes?.[noteKey]?.text ?? '';
    if (loadedFor.current === day) {
      // Already showing this day. Adopt incoming text only when we are not
      // holding something of our own:
      //  - identical text means this is just the echo of our own save, so
      //    returning early keeps the "已保存" confirmation on screen instead of
      //    blinking it away the moment the refresh lands;
      //  - unsaved edits mean the user is mid-sentence, and the agent (or
      //    another window) must not yank the textarea out from under them.
      if (incoming === text) return;
      if (text !== saved) return;
    }
    loadedFor.current = day;
    setText(incoming);
    setSaved(incoming);
    setState('idle');
    // Keyed on the day and the note's timestamp rather than the whole `page`
    // object, which is replaced on every tick and would re-run this constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, noteKey, page?.notes?.[noteKey]?.updatedAt]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (text === saved) return;
    timer.current = setTimeout(() => {
      setState('saving');
      void onSaveNote(day, text)
        .then(() => {
          setSaved(text);
          setState('saved');
        })
        .catch(() => setState('idle'));
    }, AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `onSaveNote` is stable enough; including it would re-arm on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, saved, day]);

  const shift = (delta: number): void => {
    const d = dayStart(day);
    d.setDate(d.getDate() + delta);
    onNavigate(dayKey(d));
  };

  // `page` is null until the first fetch lands. Checking it explicitly rather
  // than folding it into `nothingHappened` matters: that expression is `null`
  // (falsy) while loading, which would fall through to the populated branch and
  // dereference a null page.
  if (!page) {
    return (
      <>
        <div className="month-hd">
          <span className="label">
            {formatDay(date)} {weekdayLabel(date)}
          </span>
        </div>
        <div className="empty">读取中…</div>
      </>
    );
  }

  const nothingHappened = page.planned.length === 0 && page.done.length === 0 && page.missed.length === 0;

  /**
   * Notes for this day written in OTHER scopes.
   *
   * Shown, not editable: the textarea belongs to the scope the filter is on.
   * Seeing the other halves is still the point — "I wrote about today" should
   * not look false just because it was written under a different project.
   */
  const otherNotes = Object.entries(page.notes).filter(
    ([key, note]) => key !== noteKey && Boolean(note.text?.trim()),
  );

  return (
    <>
      <div className="month-hd">
        <span className="label">
          {formatDay(date)} {weekdayLabel(date)}
          {isToday && <span className="badge" style={{ marginLeft: 6 }}>今天</span>}
        </span>
        <span className="grow" />
        <button className="btn tiny" onClick={() => shift(-1)}>
          ‹
        </button>
        <button className="btn tiny" onClick={() => onNavigate(dayKey(new Date()))}>
          今天
        </button>
        <button className="btn tiny" onClick={() => shift(1)}>
          ›
        </button>
      </div>

      <div className="day-col">
        <div className="day-label">那天</div>
        {nothingHappened ? (
          // Only the auto half is empty here — whatever the user wrote renders
          // below, so claiming "也没有记录" would contradict the textarea
          // sitting right under it.
          <div className="day-empty">这一天没有计划。</div>
        ) : (
          <>
            {page.done.length > 0 && (
              <Section title="完成" tone="done">
                {page.done.map((e) => (
                  <DayRow key={`${e.itemId}-${e.key}`} entry={e} onClick={() => onOpenItem(e.itemId)} />
                ))}
              </Section>
            )}
            {page.planned.length > 0 && (
              <Section title="没完成" tone="open">
                {page.planned.map((e) => (
                  <DayRow key={`${e.itemId}-${e.key}`} entry={e} onClick={() => onOpenItem(e.itemId)} />
                ))}
              </Section>
            )}
            {page.missed.length > 0 && (
              <Section title="错过的触发" tone="miss">
                {page.missed.map((r) => (
                  <MissedRow key={r.key} run={r} onRerun={() => onRerun(r.key)} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>

      {otherNotes.length > 0 && (
        <div className="day-col">
          <div className="day-label">别处写的</div>
          {otherNotes.map(([key, note]) => (
            <div key={key} className="note-other">
              <div className="note-other-hd">{key ? workspaceLabel(key) : '全局'}</div>
              <div className="note-other-body">{note.text}</div>
            </div>
          ))}
        </div>
      )}

      <div className="day-col">
        <div className="day-label">
          写点什么
          <span className="grow" />
          {state === 'saving' && <span className="save-tag">保存中…</span>}
          {state === 'saved' && <span className="save-tag">已保存</span>}
          {state === 'idle' && text !== saved && <span className="save-tag">未保存</span>}
        </div>
        <textarea
          className="day-note"
          value={text}
          placeholder={isToday ? '今天怎么样？想写就写，不写也行。' : '这一天还没有写什么。'}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="hint">
          也可以直接对 agent 说「把今天整理一下」，它会替你写在这里。
        </div>
      </div>
    </>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'done' | 'open' | 'miss';
  children: ReactNode;
}) {
  return (
    <div className="day-section">
      <div className={`day-sec-hd ${tone}`}>{title}</div>
      {children}
    </div>
  );
}

function DayRow({ entry, onClick }: { entry: DayEntry; onClick: () => void }) {
  return (
    <div className="row" data-done="true" onClick={onClick}>
      <span className="mark">✓</span>
      <div className="main">
        <div className="title">{entry.title}</div>
        <div className="meta">
          {entry.at && <span>{entry.at.slice(11, 16)}</span>}
          {entry.repeat && <span className="badge">↻ 重复</span>}
          {!entry.at && <span className="badge">无时间</span>}
        </div>
      </div>
    </div>
  );
}

function MissedRow({ run, onRerun }: { run: RunRecord; onRerun: () => void }) {
  return (
    <div className="log-row" style={{ paddingLeft: 8 }}>
      <span className={`st ${run.status}`} />
      <div className="log-main">
        <div className="log-title">
          <span className="t">{run.itemTitle}</span>
          <span className="badge">{run.action === 'notify' ? '通知' : 'agent'}</span>
        </div>
        <div className="log-sub">{run.detail}</div>
      </div>
      <button className="btn tiny" onClick={onRerun}>
        补跑
      </button>
    </div>
  );
}
