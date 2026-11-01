/**
 * The shape the backend hands the panel.
 *
 * Kept here rather than in the backend so both sides import one definition —
 * and so the panel can import it with `import type`, which erases at build time
 * and therefore never drags the backend's Node dependencies into the browser
 * bundle.
 */
import type { DayNote, RunRecord, Trigger } from './types.js';

export type AgendaGroup = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'undated';

/** One row in the agenda. Everything the panel needs, precomputed. */
export interface ViewItem {
  id: string;
  title: string;
  note?: string;
  start?: string;
  end?: string;
  allDay: boolean;
  rrule?: string;
  /** `每天` / `每周一、周三` — the panel does not parse RRULEs. */
  repeatLabel: string;
  triggers: Trigger[];
  /** `提前 15 分钟 · 系统通知` */
  triggerLabels: string[];
  /**
   * Done *for the occurrence nearest now*, not for all time. A weekly item
   * ticked off this week stays open next week.
   */
  done: boolean;
  occurrenceKey: string;
  nextFireAt?: string;
  /** `今天 09:00` / `9月30日 周三 14:00` / `无日期` */
  whenLabel: string;
  group: AgendaGroup;
  /** Absent = a global item (not part of any project). */
  workspaceId?: string;
}

export interface Views {
  items: ViewItem[];
  /**
   * Every workspace id that appears in `notes` or `items`, so the panel's
   * filter can list them without a second round trip. Ids are absolute paths;
   * the panel derives the label (see `workspaceLabel`).
   */
  workspaces: string[];
  /** Newest first. */
  runs: RunRecord[];
  /** Recorded as missed or undelivered — awaiting a decision. */
  missed: RunRecord[];
  /**
   * Every day's free text, per scope, so the panel's search box can match it
   * without a round trip per keystroke. Bounded by how much a person writes,
   * which is small; a real index would be premature.
   */
  notes: Record<string, Record<string, DayNote>>;
  now: string;
  /** Items whose rule expansion hit its ceiling. Surfaced, never hidden. */
  truncated: string[];
}

/** One occurrence in the month grid or the week columns. */
export interface MonthOccurrence {
  itemId: string;
  title: string;
  key: string;
  at: string;
  /** An all-day item shows no clock time — the cell has no room for a fake one. */
  allDay?: boolean;
  done: boolean;
  /** Absent = a global item. */
  workspaceId?: string;
}

/** A span of whole days — what the week view asks for. */
export interface RangeView {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
  byDay: Record<string, MonthOccurrence[]>;
}

export interface MonthView {
  year: number;
  month: number;
  label: string;
  byDay: Record<string, MonthOccurrence[]>;
}

export const GROUP_LABEL: Record<AgendaGroup, string> = {
  overdue: '已过期',
  today: '今天',
  tomorrow: '明天',
  week: '本周',
  later: '以后',
  undated: '无日期',
};

export const GROUP_ORDER: AgendaGroup[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'undated'];
