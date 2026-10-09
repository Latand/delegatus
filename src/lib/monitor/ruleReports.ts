import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import type { AttentionDismissalV1 } from "@/lib/attention/dismissals";
import { maintenanceDecision } from "@/lib/boardMaintenance/decision";
import type { MaintenanceRun } from "@/lib/boardMaintenance/types";
import type { BridgeReportLogV1, BridgeReportInput } from "@/lib/bridge/types";
import { pipelineCompletedUnreviewed } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

export interface RuleReportInput {
  project: string;
  seatConversationId: string;
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  deliveries: readonly HeldDelivery[];
  maintenance: readonly MaintenanceRun[];
  dismissals: readonly AttentionDismissalV1[];
  bridgeLog?: Pick<BridgeReportLogV1, "reports" | "resolvedAsks">;
  deliveryProject: (delivery: HeldDelivery) => string | null;
  deliveryLost: (delivery: HeldDelivery) => boolean;
  locale: "uk" | "en";
  at: string;
}

/** Stable outcome identities use the existing report log's replay protection.
    Held and uncertain agent messages have no outcome to report. */
export function ruleReports(input: RuleReportInput): BridgeReportInput[] {
  const { project, locale } = input;
  const uk = locale === "uk";
  const reports: BridgeReportInput[] = [];
  const title = (id: string) => input.tasks.find(t => t.id === id)?.text.split("\n")[0] ?? id;
  const add = (key: string, at: string, body: string) => reports.push({ key, at, body, class: "completed", project,
    origin: { kind: "manager", conversationId: input.seatConversationId, role: "orchestrator" }, targetSeatConversationId: input.seatConversationId });
  for (const lane of input.pipelines) {
    if (lane.project !== project) continue;
    if (lane.dismissedAt && lane.dismissedBy?.kind === "manager") {
      add(`rule:lane-hidden:${lane.id}:${lane.dismissedAt}`, lane.dismissedAt, uk
        ? `${lane.taskIds.join(" ")} ${lane.id}: оркестратор прибрав вирішене очікування зі списку.`
        : `${lane.taskIds.join(" ")} ${lane.id}: the orchestrator cleared the resolved wait.`);
    }
    if (!pipelineCompletedUnreviewed(lane)) continue;
    if (lane.merge?.state !== "merged") {
      add(`rule:budget-ready:${lane.id}`, lane.closedAt ?? lane.createdAt, uk
        ? `${lane.taskIds.join(" ")} «${lane.task.split("\n")[0]}»: бюджет рев’ю вичерпано; останні зауваження виправлено, PR готовий до злиття.`
        : `${lane.taskIds.join(" ")} “${lane.task.split("\n")[0]}”: review budget completed; final findings fixed, PR ready to merge.`);
      continue;
    }
    const at = lane.merge.mergedAt ?? lane.merge.updatedAt;
    const cards = lane.taskIds.join(" ");
    add(`rule:budget-fixed:${lane.id}`, at, uk
      ? `${cards} «${lane.task.split("\n")[0]}»: бюджет рев’ю вичерпано; останні зауваження виправлено, злито (#${lane.merge.prNumber}).`
      : `${cards} “${lane.task.split("\n")[0]}”: review budget completed; final findings fixed, merged (#${lane.merge.prNumber}).`);
  }
  for (const delivery of input.deliveries) {
    if (delivery.command.origin?.kind !== "agent" || delivery.state !== "failed" || input.deliveryProject(delivery) !== project) continue;
    // A failed record may still carry an unverified execution. Only proven
    // non-execution is a final non-delivery outcome.
    if (!input.deliveryLost(delivery)) continue;
    add(`rule:delivery-unsent:${delivery.id}`, input.at, uk
      ? `Повідомлення агента не доставлено: ${delivery.error ?? delivery.id}`
      : `Agent message was not delivered: ${delivery.error ?? delivery.id}`);
  }
  for (const run of input.maintenance) {
    if (run.project !== project || run.state !== "succeeded" || !run.endedAt) continue;
    const routine = [...run.log.leftAlone.map(row => `${row.taskId}: ${row.reason}`),
      ...run.log.attention.filter(row => !maintenanceDecision(row)).map(row => `${row.taskId}: ${row.text}`)];
    add(`rule:maintenance:${run.runId}`, run.endedAt, uk
      ? `${run.taskId ?? ""} Обслуговування дошки завершено: змінено ${run.counts.tasks} задач.${routine.length ? `\n${routine.join("\n")}` : ""}`
      : `${run.taskId ?? ""} Board maintenance completed: ${run.counts.tasks} tasks changed.${routine.length ? `\n${routine.join("\n")}` : ""}`);
  }
  for (const record of input.dismissals) {
    if (record.by.kind !== "manager") continue;
    if (record.kind !== "prototype") {
      const cards = input.tasks.filter(task => task.project === project && task.assignments.some(assignment =>
        record.conversationId ? assignment.conversationId === record.conversationId : assignment.path === record.path));
      if (cards.length) add(`rule:wait-cleared:${record.subject}:${record.at}`, record.at, uk
        ? `${cards.map(task => task.id).join(" ")}: оркестратор прибрав вирішене очікування.${record.note ? ` ${record.note}` : ""}`
        : `${cards.map(task => task.id).join(" ")}: the orchestrator cleared the resolved wait.${record.note ? ` ${record.note}` : ""}`);
      continue;
    }
    if (!record.taskId || !input.tasks.some(task => task.id === record.taskId && task.project === project)) continue;
    add(`rule:prototype-hidden:${record.subject}:${record.at}`, record.at, uk
      ? `${record.taskId} «${title(record.taskId)}»: оркестратор сховав огляд зі списку очікувань.${record.note ? ` ${record.note}` : ""}`
      : `${record.taskId} “${title(record.taskId)}”: the orchestrator hid the review from waiting.${record.note ? ` ${record.note}` : ""}`);
  }
  for (const resolved of input.bridgeLog?.resolvedAsks ?? []) {
    if (resolved.by.kind !== "manager") continue;
    const question = input.bridgeLog?.reports.find(row => row.seq === resolved.seq && row.project === project);
    if (!question) continue;
    add(`rule:question-resolved:${resolved.seq}:${resolved.at}`, resolved.at, uk
      ? `Оркестратор зняв вирішене питання: ${question.body ?? ""}${resolved.note ? ` — ${resolved.note}` : ""}`
      : `The orchestrator cleared the resolved question: ${question.body ?? ""}${resolved.note ? ` — ${resolved.note}` : ""}`);
  }
  return reports;
}
