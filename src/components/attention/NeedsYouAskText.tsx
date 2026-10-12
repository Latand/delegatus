"use client";

import { useLocale } from "@/lib/i18n";

import type { OperatorAsk } from "./operatorAsk";

/**
 * What a «Waiting for you» row asks (docs/design/attention-auto-resolve.md):
 * the question in its author's words, its choices with the recommended one
 * marked, and the sentence saying what to choose or do and what happens next.
 * Nothing here is clamped or cut: the list stays open, so the row grows to fit
 * its words and a long word wraps. Spans only, so the row's own open button
 * can hold it; the answer is given where the row opens.
 */
export function NeedsYouAskText({ ask, size = "panel" }: { ask: OperatorAsk; size?: "panel" | "touch" }) {
  const { t } = useLocale();
  const text = size === "touch" ? "text-label" : "text-[11px]";
  return (
    <>
      {ask.question ? (
        <span className={`block w-full whitespace-pre-line ${size === "touch" ? "text-ui" : "text-[12px]"} text-primary [overflow-wrap:anywhere]`} data-needs-you-question="">{ask.question}</span>
      ) : null}
      {ask.options.length ? (
        <span className="flex w-full flex-col gap-0.5" role="list" aria-label={t("needs.ask.options")} data-needs-you-options={ask.options.length}>
          {ask.options.map((option, index) => (
            <span
              key={`${index}:${option}`}
              role="listitem"
              className={`flex w-full min-w-0 items-baseline gap-1.5 ${text} text-secondary [overflow-wrap:anywhere]`}
              data-needs-you-option={index}
              data-recommended={ask.recommended === index ? "" : undefined}
            >
              <span aria-hidden className="shrink-0 tabular-nums text-muted">{index + 1}.</span>
              <span className="min-w-0">
                {option}
                {ask.recommended === index ? <span className="ml-1.5 rounded-[4px] bg-accent/10 px-1 text-[10px] font-semibold text-accent">{t("needs.ask.recommended")}</span> : null}
              </span>
            </span>
          ))}
        </span>
      ) : null}
      <span data-attention-decision="" data-needs-you-sentence="" className={`block w-full ${text} text-muted [overflow-wrap:anywhere]`}>{ask.sentence}</span>
    </>
  );
}
