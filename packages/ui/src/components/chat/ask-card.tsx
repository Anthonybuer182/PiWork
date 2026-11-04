import { useMemo } from 'react';
import { Check, Loader2, MessageCircleQuestion } from 'lucide-react';
import type { AskAnswers, AskQuestion, AskRequest } from '@pi/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { EMPTY_DRAFT, useAskStore, type AskDraft } from '@/stores/ask-store';

/**
 * The question card for `asktool`.
 *
 * One question at a time, with the progress dots acting as both an indicator
 * and a jump list — a twenty-question batch is a form, and a form you cannot
 * navigate is a dialog you cannot close. The free-text "other" box is always
 * present: a fixed option list is a guess about what the user wants, and the
 * guess is exactly what the agent said it could not make.
 *
 * Nothing here is local component state. The draft lives in the store keyed by
 * requestId, so switching conversations and coming back does not lose answers,
 * and a remount after a panel relayout is invisible.
 */
export function AskCard({ request }: { request: AskRequest }) {
  const { t } = useI18n();
  const draft = useAskStore((s) => s.drafts[request.requestId] ?? EMPTY_DRAFT);
  const submitting = useAskStore((s) => !!s.submitting[request.requestId]);
  const setIndex = useAskStore((s) => s.setIndex);
  const toggleOption = useAskStore((s) => s.toggleOption);
  const setCustom = useAskStore((s) => s.setCustom);
  const clearQuestion = useAskStore((s) => s.clearQuestion);
  const submit = useAskStore((s) => s.submit);

  const questions = request.questions;
  const total = questions.length;
  const index = Math.min(draft.index, total - 1);
  const question = questions[index];
  const selected = draft.selected[index] ?? [];
  const custom = draft.custom[index] ?? '';
  const isLast = index === total - 1;

  const answers = useMemo(() => buildAnswers(questions, draft), [questions, draft]);

  const goTo = (target: number) => {
    if (target < 0 || target >= total) return;
    setIndex(request.requestId, target);
  };

  const commit = (final: AskAnswers) => {
    void submit(request, final);
  };

  const next = () => {
    if (isLast) {
      commit(answers);
    } else {
      goTo(index + 1);
    }
  };

  // Skip means "this question has no answer". On the last question that also
  // finishes the card — with this one blank and everything before it kept.
  const skip = () => {
    clearQuestion(request.requestId, index);
    if (isLast) {
      const final = answers.slice();
      final[index] = null;
      commit(final);
    } else {
      goTo(index + 1);
    }
  };

  const refuseAll = () => commit(questions.map(() => null));

  return (
    <div className="border-t border-sky-300/50 bg-sky-50/50 px-3 py-2.5 dark:border-sky-800/40 dark:bg-sky-950/20" data-ask-card={request.requestId}>
      {/* ── Header: progress + jump dots ── */}
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
        <span className="text-[11px] font-medium text-sky-700 dark:text-sky-300">
          {t('第 {current}/{total} 题', { current: index + 1, total })}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {questions.map((_, i) => {
            const answered = isAnswered(draft, i);
            return (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t('跳到第 {current} 题', { current: i + 1 })}
                aria-current={i === index ? 'step' : undefined}
                className={cn(
                  'h-2 w-2 rounded-full transition-all',
                  i === index
                    ? 'bg-sky-500 ring-2 ring-sky-500/25 ring-offset-1 ring-offset-background'
                    : answered
                      ? 'bg-sky-500/60 hover:bg-sky-500'
                      : 'bg-muted-foreground/25 hover:bg-muted-foreground/50',
                )}
              />
            );
          })}
        </div>
      </div>

      {/* ── Question ── */}
      <p className="mt-2 text-sm leading-relaxed text-foreground">{question.question}</p>

      {/* ── Options ── */}
      <div className="mt-2 flex flex-col gap-1">
        {question.options.map((option) => {
          const active = selected.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={active}
              disabled={submitting}
              onClick={() =>
                toggleOption(request.requestId, index, option.label, question.multiSelect)
              }
              className={cn(
                'flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                active
                  ? 'border-sky-400/70 bg-sky-500/10'
                  : 'border-border bg-background/60 hover:bg-muted/40',
                submitting && 'opacity-60',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
                  question.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                  active
                    ? 'border-sky-500 bg-sky-500 text-white'
                    : 'border-muted-foreground/40',
                )}
              >
                {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-5">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {/* Free-text fallback, always present. */}
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">{t('其他')}</span>
          <input
            value={custom}
            disabled={submitting}
            onChange={(e) =>
              setCustom(request.requestId, index, e.target.value, question.multiSelect)
            }
            onKeyDown={(e) => {
              // Enter submits/navigates — except while an IME is composing,
              // where Enter belongs to the input method, not to us.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !submitting) {
                e.preventDefault();
                next();
              }
            }}
            placeholder={t('输入其他答案…')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          disabled={submitting}
          onClick={skip}
        >
          {t('跳过')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
          disabled={submitting}
          onClick={refuseAll}
        >
          {t('全部拒绝')}
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {t('回答后 agent 会继续')}
        </span>
        <Button
          size="sm"
          className="h-6 px-2.5 text-[11px]"
          disabled={submitting}
          onClick={next}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isLast ? (
            t('提交')
          ) : (
            t('下一题')
          )}
        </Button>
      </div>
    </div>
  );
}

/** A question counts as answered once it has a ticked option or typed text. */
function isAnswered(draft: AskDraft, index: number): boolean {
  return (draft.selected[index]?.length ?? 0) > 0 || (draft.custom[index]?.trim() ?? '') !== '';
}

/**
 * Fold the draft into the wire format: one entry per question, `null` when the
 * user left it blank. A single-choice answer is exactly one value even if a
 * stale selection and a typed answer ever coexisted.
 */
function buildAnswers(questions: AskQuestion[], draft: AskDraft): AskAnswers {
  return questions.map((question, i) => {
    const typed = (draft.custom[i] ?? '').trim();
    const picked = draft.selected[i] ?? [];
    if (question.multiSelect) {
      const values = [...picked];
      if (typed && !values.includes(typed)) values.push(typed);
      return values.length > 0 ? values : null;
    }
    const value = typed || picked[0];
    return value ? [value] : null;
  });
}
