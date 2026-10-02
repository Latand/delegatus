import { operatorLocale } from "@/lib/operator/settings";
import { patchTask } from "@/lib/tasks/commands";
import { mutateTasks } from "@/lib/tasks/store";
import type { Pipeline, PipelineStageAttempt } from "./types";

/** Keep host errors, paths and publication diagnostics out of the human note. */
export function parkedTaskNote(detail: string, locale: "en" | "uk", failed = false): string {
  const uk = locale === "uk";
  if (/budget|round limit|exhausted/i.test(detail)) return uk
    ? "Бюджет спроб вичерпано. Очікує рішення про продовження."
    : "The attempt budget is spent. Waiting for a decision on continuing.";
  if (/publish|publication|remote.*branch/i.test(detail)) return uk
    ? "Публікацію заблоковано. Очікує відновлення можливості опублікувати зміни."
    : "Publication is blocked. Waiting until the changes can be published.";
  if (failed || /fail|error|died|unavailable/i.test(detail)) return uk
    ? "Етап не вдалося завершити. Очікує рішення про наступну спробу."
    : "The stage could not finish. Waiting for a decision on another attempt.";
  return uk ? "Очікує вашого рішення для продовження роботи." : "Waiting for your decision before work can continue.";
}

/** Called at the engine's park transition. Compare against the attempt's start
 * under the task lock, so a note its agent just left wins even during settlement. */
export function writeParkedTaskNote(pipeline: Pipeline, detail: string, attempt?: PipelineStageAttempt | null): void {
  if (!pipeline.taskIds.length) return;
  const since = Date.parse(attempt?.startedAt ?? pipeline.createdAt);
  const now = new Date().toISOString();
  const text = parkedTaskNote(detail, operatorLocale() ?? "uk", attempt?.state === "failed" || attempt?.verdict?.status === "fail");
  const linked = new Set(pipeline.taskIds);
  mutateTasks(tasks => {
    let changed = false;
    const next = tasks.map(task => {
      if (!linked.has(task.id) || task.project !== pipeline.project) return task;
      if (task.note && (task.note.author.kind !== "orchestrator" || "conversationId" in task.note.author) && Date.parse(task.note.updatedAt) >= since) return task;
      const result = patchTask([task], task.id, { note: text }, now, { actor: "agent", noteAuthor: { kind: "orchestrator" } });
      if (!result.ok) throw new Error(result.error);
      changed = true;
      return result.task;
    });
    return { tasks: changed ? next : undefined, result: undefined };
  });
}
