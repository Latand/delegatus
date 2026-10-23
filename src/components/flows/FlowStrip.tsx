"use client";

import type { ReviewGroup } from "./reviewGroup";
import { useLocale } from "@/lib/i18n";
import { openReviewHistory } from "./ReviewHistory";
import { flowPresentation } from "./flowModel";

/** Recorded state and round navigation for cached legacy board layouts. */
export function FlowStrip({ flow, onFocusRound }: { flow: ReviewGroup; onFocusRound?: (n: number) => void }) {
  const { t, locale } = useLocale();
  return <div data-scheme-ui data-review-history-strip className="pointer-events-auto flex h-11 w-full items-center gap-2 rounded-[14px] border border-border bg-card px-3 shadow-1">
    <span className="min-w-0 shrink truncate text-xs font-semibold" title={flowPresentation(t, flow, locale).label}>{flowPresentation(t, flow, locale).label}</span>
    <span className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label={t("reviewHistory.rounds")}>
      {flow.rounds.map(round => <button key={round.n} type="button" className="min-h-8 shrink-0 rounded-full border border-border px-2 text-xs" onClick={() => { onFocusRound?.(round.n); openReviewHistory(flow.id, round.n); }}>R{round.n}</button>)}
    </span>
    <button type="button" className="min-h-8 shrink-0 rounded-full border border-border px-2 text-xs text-accent" onClick={() => openReviewHistory(flow.id)}>{t("reviewHistory.open")}</button>
  </div>;
}
