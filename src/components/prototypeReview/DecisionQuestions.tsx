"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { Check } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { PrototypeAnswer, PrototypeQuestion } from "@/lib/prototypeReview/types";

/*
 * The question rows of an operator decision: one block, drawn by the
 * prototype review window and by the «Рішення» column's card
 * (docs/design/operator-decision-forms.md §2.6), so there is one
 * implementation of a question, its options, «Інше» and the recommended mark.
 * The window boxes each question and keeps 44 px rows; the card is the box
 * itself, so its questions stand bare, with 36 px rows on a fine pointer.
 */

/** The answers after one click: a single choice replaces, a multiple one
    toggles, and «Інше» toggles beside the options it allows. */
export function selectPrototypeAnswer(questions: readonly PrototypeQuestion[], answers: readonly PrototypeAnswer[], questionId: string, option: number | "other"): PrototypeAnswer[] {
  const question = questions.find(q => q.id === questionId);
  if (!question) return [...answers];
  return answers.map(answer => {
    if (answer.questionId !== questionId) return answer;
    if (option === "other") {
      const other = !answer.other;
      return { questionId, options: question.multiple ? answer.options : [], ...(other ? { other: true as const } : {}) };
    }
    const options = question.multiple ? answer.options.includes(option) ? answer.options.filter(i => i !== option) : [...answer.options, option].sort((a, b) => a - b) : [option];
    return { questionId, options, ...(question.multiple && answer.other ? { other: true as const } : {}) };
  });
}

export function DecisionQuestions({ questions, answers, open, onSelect, boxed = true, columns = 1 }: {
  questions: readonly PrototypeQuestion[];
  /** The decision's answers once there is one, else the draft's. */
  answers: readonly PrototypeAnswer[];
  /** Whether the questions still ask: answered or retired ones read as a record. */
  open: boolean;
  onSelect: (questionId: string, option: number | "other") => void;
  /** The window's own box per question; the card is the box. */
  boxed?: boolean;
  /** Questions side by side where the card has room for two. */
  columns?: 1 | 2;
}) {
  const { t } = useLocale();
  const closed = !open;
  /* A single-choice group is one tab stop: the arrows move the focus and the
     answer together, wrapping from the last choice (Other included) to the first. */
  const stepAnswer = (event: ReactKeyboardEvent<HTMLButtonElement>, question: PrototypeQuestion, from: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!forward && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = (from + (forward ? 1 : -1) + buttons.length) % buttons.length;
    onSelect(question.id, at === question.options.length ? "other" : at);
    buttons[at]?.focus();
  };
  const row = boxed ? "min-h-11 py-2" : "min-h-9 py-1.5 [@media(pointer:coarse)]:min-h-11";
  const rows = questions.map((question, at) => {
    const answer = answers.find(a => a.questionId === question.id);
    const choice = (index: number | "other", label: string, recommended = false) => {
      const checked = index === "other" ? Boolean(answer?.other) : Boolean(answer?.options.includes(index));
      return <button key={index} type="button" role={question.multiple ? "checkbox" : "radio"} aria-checked={checked} disabled={!open}
        {...(index === "other" ? { "data-prototype-other": question.id } : { "data-prototype-option": `${question.id}:${index}` })}
        className={`flex ${row} w-full items-start gap-2 rounded-control border px-2.5 text-left text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default ${checked ? "border-accent/50 bg-accent-soft text-accent" : closed ? "border-transparent bg-transparent text-muted opacity-60" : "border-border bg-canvas text-primary enabled:hover:border-accent/45"}`}
        {...(question.multiple ? {} : { tabIndex: checked || (!answer?.other && !answer?.options.length && index === 0) ? 0 : -1, onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => open && stepAnswer(event, question, index === "other" ? question.options.length : index) })}
        onClick={() => onSelect(question.id, index)}>
        <span aria-hidden data-prototype-mark="" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${question.multiple ? "rounded-sm" : "rounded-full"} border ${checked ? "border-accent bg-accent text-white" : "border-border bg-sunken"}`}>{checked ? <Check className="h-3.5 w-3.5" /> : null}</span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
        {recommended ? <span data-prototype-recommended="" className="shrink-0 self-start whitespace-nowrap rounded-full bg-sunken px-1.5 py-0.5 text-caption font-semibold text-secondary">{t("proto.q.recommended")}</span> : null}
      </button>;
    };
    return <fieldset key={question.id} data-prototype-question={question.id} className={`m-0 min-w-0 ${boxed ? "rounded-control border border-border bg-card p-3" : "border-0 p-0"}`}>
      <legend className="sr-only">{question.text}</legend>
      <div className={`${boxed ? "mb-2" : "mb-1.5"} flex items-start gap-1.5`}><span data-prototype-question-number="" className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-caption font-bold">{at + 1}</span><p className="m-0 min-w-0 flex-1 text-ui font-semibold text-primary [overflow-wrap:anywhere]">{question.text}</p></div>
      {question.multiple && !closed ? <p data-prototype-hint="" className={`m-0 ${boxed ? "mb-2" : "mb-1.5"} text-label text-muted`}>{t("proto.q.multiple")}</p> : null}
      <div role={question.multiple ? "group" : "radiogroup"} aria-label={question.text} className={`flex flex-col ${boxed ? "gap-1.5" : "gap-1"}`}>
        {question.options.map((option, index) => choice(index, option.label, option.recommended))}
        {question.other ? choice("other", t("proto.q.other")) : null}
      </div>
    </fieldset>;
  });
  return columns === 2 ? <div className="grid grid-cols-2 gap-3">{rows}</div> : <>{rows}</>;
}
