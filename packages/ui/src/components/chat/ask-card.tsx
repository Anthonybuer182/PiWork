import { useMemo } from 'react';
import { ArrowRight, Check, Loader2, MessageCircleQuestion } from 'lucide-react';
import type { AskAnswers, AskQuestion, AskRequest } from '@pi/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { EMPTY_DRAFT, useAskStore, type AskDraft } from '@/stores/ask-store';

/**
 * The question card for `asktool`.
 *
 * One question at a time, with the progress segments acting as both an
 * indicator and a jump list — a twenty-question batch is a form, and a form
 * you cannot navigate is a dialog you cannot close. The free-text "other" box
 * is always present: a fixed option list is a guess about what the user wants,
 * and the guess is exactly what the agent said it could not make.
 *
 * Styling is token-only (foreground / border / muted / primary): the card has
 * to sit inside the user's theme, not next to it. The previous sky-blue tint
 * was a fixed accent in a deliberately neutral, theme-driven palette.
 *
 * Nothing here is local component state. The draft lives in the store keyed by
 * requestId, so switching conversations and coming back does not lose answers,
 * and a remount after a panel relayout is invisible.
 */
export function AskCard({ request, inline = false }: { request: AskRequest; inline?: boolean }) {
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
    <div
      className={cn('px-3 py-3', inline && 'border-t border-border/60 bg-muted/15')}
      data-ask-card={request.requestId}
    >
      {/* ── Header: what this is, and where in the batch we are ── */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70">
          <MessageCircleQuestion className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 text-[11px] font-medium text-foreground/80">{t('提问')}</span>
        {total > 1 && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
            {t('第 {current}/{total} 题', { current: index + 1, total })}
          </span>
        )}
      </div>

      {/* ── Progress: one segment per question, click to jump ── */}
      {total > 1 && (
        <div className="mt-2 flex items-center gap-1">
          {questions.map((_, i) => {
            const answered = isAnswered(draft, i);
            return (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t('跳到第 {current} 题', { current: i + 1 })}
                aria-current={i === index ? 'step' : undefined}
                className="group flex-1 py-1"
              >
                <span
                  className={cn(
                    'block h-1 rounded-full transition-colors',
                    i === index
                      ? 'bg-foreground/70'
                      : answered
                        ? 'bg-foreground/30 group-hover:bg-foreground/45'
                        : 'bg-foreground/10 group-hover:bg-foreground/20',
                  )}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* ── Question ── */}
      <p className="mt-2.5 text-sm leading-relaxed text-foreground">{question.question}</p>

      {/* ── Options ── */}
      <div className="mt-2.5 flex flex-col gap-1.5">
        <div
          className="flex flex-col gap-1.5"
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-label={question.question}
        >
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
                  'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                  active
                    ? 'border-foreground/25 bg-foreground/[0.05]'
                    : 'border-border/70 bg-card hover:border-foreground/15 hover:bg-muted/40',
                  submitting && 'cursor-default opacity-60',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors',
                    question.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-foreground/25 bg-transparent',
                  )}
                >
                  {active &&
                    (question.multiSelect ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                    ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-5 text-foreground">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Free-text fallback, always present. */}
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 transition-colors focus-within:border-foreground/25 focus-within:bg-muted/30">
          <span className="shrink-0 text-[11px] text-muted-foreground/70">{t('其他')}</span>
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
      <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px] text-muted-foreground"
          disabled={submitting}
          onClick={skip}
        >
          {t('跳过')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
          disabled={submitting}
          onClick={refuseAll}
        >
          {t('全部拒绝')}
        </Button>
        <Button
          size="sm"
          className="ml-auto h-7 gap-1 px-3 text-[11px]"
          disabled={submitting}
          onClick={next}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isLast ? (
            <>
              <Check className="h-3 w-3" />
              {t('提交')}
            </>
          ) : (
            <>
              {t('下一题')}
              <ArrowRight className="h-3 w-3" />
            </>
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
