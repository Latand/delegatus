import { operatorLocale } from "@/lib/operator/settings";
import { createTask, type CreateTaskInput } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";
import { TASK_DETAILS_LIMIT, TASK_TEXT_LIMIT } from "@/lib/tasks/types";
import type { Pipeline } from "./types";

/** Findings remain on the attempt; a bounded board card carries whole ones. */
export function budgetFollowUpInput(pipeline: Pipeline, mergedHead: string, locale: string): CreateTaskInput & { text: string; details: string } {
  const spent = pipeline.reviewBudgetSpent;
  if (!spent) throw new Error("the lane has no spent review budget");
  const findings = pipeline.runs.find(run => run.stageId === spent.stageId)?.attempts.find(attempt => attempt.n === spent.attempt)?.verdict?.findings ?? [];
  const prefix = locale === "uk" ? "Зауваження після рев’ю: " : "Review follow-up: ";
  const title = pipeline.task.split("\n")[0]!.trim();
  const pr = pipeline.merge?.prNumber ?? pipeline.delivery?.target.pr;
  const lines = [
    `Lane: ${pipeline.id}`, `Original tasks: ${pipeline.taskIds.join(", ") || "none"}`,
    `Review: ${spent.stageId} attempt ${spent.attempt}`, `Merged head: ${mergedHead}`,
    ...(pr ? [`PR: ${pipeline.merge ? pipeline.merge.repository : ""}#${pr}`] : []),
    "", "Kept findings:",
  ];
  const pointer = (first: number) => `findings ${first}–${findings.length}: get_pipeline ${pipeline.id} stageId ${spent.stageId} attempt ${spent.attempt}`;
  for (let index = 0; index < findings.length; index++) {
    const candidate = [...lines, findings[index]!];
    const reserve = index + 1 < findings.length ? pointer(index + 2).length + 1 : 0;
    if (candidate.join("\n").length + reserve > TASK_DETAILS_LIMIT) {
      lines.push(pointer(index + 1));
      break;
    }
    lines.push(findings[index]!);
  }
  return {
    project: pipeline.project, text: (prefix + title).slice(0, TASK_TEXT_LIMIT), details: lines.join("\n"),
    placement: "unplaced", clientRequestId: `review-budget-follow-up:${pipeline.id}:${spent.stageId}:${spent.attempt}`,
  };
}

/** Task first, receipt in the lane second: retries replay the persisted create. */
export function fileBudgetFollowUp(pipeline: Pipeline, mergedHead: string): { taskId: string; title: string } {
  const input = budgetFollowUpInput(pipeline, mergedHead, operatorLocale() ?? "uk");
  const outcome = mutateTasksFile(state => {
    const result = createTask(state.tasks, input, state.recentCreates, { explicit: true, allowBoardOverflow: true });
    if (result.ok && !result.replay) result.task.status = "assigned";
    return { state: result.ok && !result.replay ? { tasks: result.tasks, recentCreates: result.recentCreates } : undefined, result };
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return { taskId: outcome.task.id, title: outcome.task.text };
}
