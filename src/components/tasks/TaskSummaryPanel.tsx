"use client";

import { browserZone, clockText, dateTimeText } from "@/components/activity/format";
import { stageNames } from "@/components/pipelines/pipelineModel";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskNote, TaskSummary } from "@/lib/tasks/types";

/*
 * The task's «Summary» (the operator's variant 3 of 2026-10-26): a panel on
 * the well surface the card's details use, with the writer and time in its
 * head, a bold headline, two or three sentences and what is left. The last
 * stage of a finishing lane writes it, or the orchestrator through
 * update_task; nothing shows while nobody has written one.
 */

function writer(t: TFunction, summary: TaskSummary, pipelines: readonly Pipeline[]): string {
  const author = summary.author;
  if (author.kind === "stage") {
    const pipeline = pipelines.find((entry) => entry.id === author.pipelineId);
    return pipeline ? stageNames(t, pipeline).get(author.stageId) ?? author.stageId : t("taskSummary.who.agent");
  }
  if (author.kind === "orchestrator") return t("taskSummary.who.seat");
  if (author.kind === "operator") return t("taskSummary.who.operator");
  return t("taskSummary.who.agent");
}

/** The agent note says less than a summary written after it: it hides until a newer note arrives. */
export function noteShownBesideSummary(note: TaskNote | undefined, summary: TaskSummary | undefined): TaskNote | undefined {
  if (!note || !summary) return note;
  return Date.parse(note.updatedAt) > Date.parse(summary.updatedAt) ? note : undefined;
}

export function TaskSummaryPanel({ summary, pipelines, nowMs, phone = false }: {
  summary?: TaskSummary;
  pipelines: readonly Pipeline[];
  nowMs: number;
  phone?: boolean;
}) {
  const { t, locale } = useLocale();
  if (!summary) return null;
  const at = Date.parse(summary.updatedAt);
  const zone = browserZone();
  const time = new Date(at).toDateString() === new Date(nowMs).toDateString() ? clockText(at, locale, zone) : dateTimeText(at, locale, zone);
  const heading = t("taskSummary.heading");
  return (
    <section className={`task-summary${phone ? " phone" : ""}`} data-task-summary="" aria-label={heading}>
      <div className="task-summary-head">
        <h4 className="chronology-head">{heading}</h4>
        <span className="task-summary-by" data-task-summary-by="" title={summary.updatedAt}>{t("taskSummary.by", { who: writer(t, summary, pipelines), time })}</span>
      </div>
      <p className="task-summary-headline" data-task-summary-headline="">{summary.headline}</p>
      <p className="task-summary-text" data-task-summary-text="">{summary.text}</p>
      {summary.left ? (
        <p className="task-summary-left" data-task-summary-left="">
          <b>{t("taskSummary.left")}</b>{"\u00a0"}{summary.left}
        </p>
      ) : null}
    </section>
  );
}
