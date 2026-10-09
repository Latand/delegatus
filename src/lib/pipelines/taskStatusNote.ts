import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { patchTask } from "@/lib/tasks/commands";
import { mutateTasks } from "@/lib/tasks/store";
import type { Pipeline, PipelineStageAttempt } from "./types";

export type ParkedTaskReason = { kind: "signed-out"; engine: "claude" | "codex" } | { kind: "quota-reset" } | { kind: "review-budget" }
  | { kind: "provider-retry"; resumeAt: string; timeZone?: string };

/** Keep host errors, paths and publication diagnostics out of the human note. */
export function parkedTaskNote(detail: string, locale: "en" | "uk", failed = false, reason?: ParkedTaskReason): string {
  const uk = locale === "uk";
  if (reason?.kind === "provider-retry") {
    const zone = reason.timeZone ?? operatorTimeZone() ?? "UTC";
    const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", {
      timeZone: zone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(reason.resumeAt)).replace(",", "");
    const label = zone.split("/").at(-1)!.replaceAll("_", " ");
    return uk ? `Автоповтор ${time} (${label}).` : `Automatic retry ${time} (${label}).`;
  }
  if (reason?.kind === "signed-out") {
    const engine = reason.engine === "codex" ? "Codex" : "Claude";
    return uk
      ? `Для ${engine} не під’єднано обліковий запис. Під’єднайте його, щоб продовжити.`
      : `No ${engine} account is connected. Connect one to continue.`;
  }
  if (reason?.kind === "quota-reset") return uk
    ? "Вичерпано ліміт використання. Очікуємо на його оновлення для повторної спроби."
    : "The usage limit was reached. Waiting for it to reset before retrying.";
  if (reason?.kind === "review-budget") return uk
    ? "Бюджет рев’ю вичерпано; збільшувати не можна. Решта зауважень переходить до наступного завдання."
    : "The review budget is spent and cannot increase. Remaining findings go to a follow-up task.";
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
export function writeParkedTaskNote(pipeline: Pipeline, detail: string, attempt?: PipelineStageAttempt | null, reason?: ParkedTaskReason): void {
  if (!pipeline.taskIds.length) return;
  const now = new Date().toISOString();
  /* A pending attempt can park before it has started. Its activating stage's
     completion is the boundary: an earlier-stage note predates it, while a
     note written during this wait follows it. */
  const activatedAt = attempt?.activatedBy
    ? pipeline.runs.find(run => run.stageId === attempt.activatedBy!.stageId)?.attempts[attempt.activatedBy.attempt - 1]?.completedAt
    : null;
  const since = Date.parse(attempt?.startedAt ?? attempt?.activation?.startedAt ?? activatedAt ?? pipeline.createdAt);
  const text = parkedTaskNote(detail, operatorLocale() ?? "uk", attempt?.state === "failed" || attempt?.verdict?.status === "fail", reason);
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

/** Remove an automatic park note after its blocker clears, leaving any note
 * written by a stage agent, orchestrator conversation or operator untouched. */
export function clearEngineParkedTaskNote(pipeline: Pipeline): void {
  if (!pipeline.taskIds.length) return;
  const linked = new Set(pipeline.taskIds);
  const now = new Date().toISOString();
  mutateTasks(tasks => {
    let changed = false;
    const next = tasks.map(task => {
      if (!linked.has(task.id) || task.project !== pipeline.project
        || task.note?.author.kind !== "orchestrator" || task.note.author.conversationId != null) return task;
      const result = patchTask([task], task.id, { note: null }, now, { actor: "agent", noteAuthor: { kind: "orchestrator" } });
      if (!result.ok) throw new Error(result.error);
      changed = true;
      return result.task;
    });
    return { tasks: changed ? next : undefined, result: undefined };
  });
}
