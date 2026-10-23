"use client";

import type { ReviewGroup } from "./reviewGroup";
import { useLocale } from "@/lib/i18n";
import { openReviewHistory } from "./ReviewHistory";
import { FLOW_HUB } from "./flowHubGeometry";

/** Historical relation, with no live progress or mutation controls. */
export function FlowHub({ flow, x, y, interactive, moveTransition }: {
  flow: ReviewGroup; x: number; y: number; interactive: boolean; moveTransition: string;
}) {
  const { t } = useLocale();
  return <button type="button" data-scheme-ui data-flow-hub={flow.id}
    disabled={!interactive} aria-label={t("reviewHistory.open")} title={t("reviewHistory.open")}
    className="absolute left-0 top-0 inline-flex items-center rounded-full border border-border bg-card px-2 text-xs text-muted shadow-1"
    style={{ transform: "translate(" + x + "px, " + y + "px) translate(-50%, -50%)", transition: moveTransition, height: FLOW_HUB.h }}
    onClick={() => openReviewHistory(flow.id)}>↗</button>;
}
