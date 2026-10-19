import { agentRegistry } from "@/lib/agent/registry";
import { maintenanceRuns } from "@/lib/boardMaintenance/store";
import { readAttentionDismissals } from "@/lib/attention/dismissals";
import { appendBridgeReports, readBridgeChannel, readBridgeReportLog } from "@/lib/bridge/store";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { operatorLocale } from "@/lib/operator/settings";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { orchestratorSeatForCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { loadTasksForList } from "@/lib/tasks/store";
import { ruleReports } from "./ruleReports";

/** Report storage reads and writes shared by the seat and its response worker. */
export type SeatTickReportRow = Pick<BridgeReportV1, "id" | "project" | "origin" | "at" | "covers" | "coversOwedAt">;

export function seatTickReportRows(project: string): SeatTickReportRow[] {
  return readBridgeReportLog().reports.filter(row => row.origin?.kind === "manager" && !!row.project
    && canonicalOrchestratorProject(row.project) === project)
    .map(({ id, project, origin, at, covers, coversOwedAt }) => ({ id, project, origin, at, covers, coversOwedAt }));
}

export function recordSeatRuleReports(project: string, at: string): void {
  const seat = orchestratorSeatForCurrentProject(project).active;
  if (!seat?.conversationId) return;
  const registry = agentRegistry().readOnlySnapshot();
  const log = readBridgeReportLog();
  // Append reads the channel cursor while holding its report transaction.
  // Resolve a cold channel import first, outside that transaction.
  readBridgeChannel();
  appendBridgeReports(ruleReports({ project, at, seatConversationId: seat.conversationId, locale: operatorLocale() === "en" ? "en" : "uk",
    tasks: loadTasksForList(), pipelines: loadPipelinesForList().map(lane => ({ ...lane, project: canonicalOrchestratorProject(lane.project) })), deliveries: Object.values(registry.heldDeliveries),
    maintenance: maintenanceRuns(project), dismissals: readAttentionDismissals().records, bridgeLog: { ...log, reports: log.reports.map(row => row.project ? { ...row, project: canonicalOrchestratorProject(row.project) } : row) },
    deliveryLost: delivery => registry.deliveryOperationOwners[delivery.command.operationId]?.terminalDisposition === "lost",
    deliveryProject: delivery => {
      const held = delivery.command.origin?.project ?? registry.conversations[delivery.conversationId]?.projectOwnership?.project;
      return held ? canonicalOrchestratorProject(held) : null;
    } }));
}
