"use client";

import type { TaskStepsSummary } from "@/lib/tasks/steps";
import { useLocale } from "@/lib/i18n";

/** The checklist's compact card reading; step rows stay in task data and
    never add a second card disclosure. */
export function TaskStepsLine({ summary }: { summary: TaskStepsSummary | null }) {
  const { t } = useLocale();
  if (!summary) return null;
  const text = [t("kanban.steps.doneOf", { done: summary.done, total: summary.total })];
  if (summary.dropped) text.push(t("kanban.steps.dropped", { count: summary.dropped }));
  if (summary.working) text.push(`${summary.working} ${t("kanban.steps.openKind.working")}`);
  if (summary.needsYou) text.push(`${summary.needsYou} ${t(summary.needsYou === 1 ? "kanban.steps.needsYou.one" : "kanban.steps.needsYou.many")}`);
  const waiting = summary.reasons.reduce((count, reason) => count + reason.count, 0);
  if (waiting && summary.reasons.length !== 1) text.push(t("kanban.steps.mixed", { count: waiting }));
  else if (waiting) {
    const reason = summary.reasons[0]!;
    const label = reason.note || t(`kanban.steps.defaultReason.${reason.kind}`);
    text.push(`${reason.count} ${t(`kanban.steps.openKind.${reason.kind}`)}: ${label}`);
  }
  return <span className="task-steps-line block text-label leading-snug text-muted [overflow-wrap:anywhere]" data-task-steps={`${summary.done}/${summary.total}`}>
    {text.join(" · ")}
  </span>;
}
