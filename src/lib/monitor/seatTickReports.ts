import { DeadlineExceededError } from "@/lib/deadline";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { readStateCollectionRevisions } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { agentRegistry } from "@/lib/agent/registry";
import { maintenanceRuns } from "@/lib/boardMaintenance/store";
import { readAttentionDismissals } from "@/lib/attention/dismissals";
import { appendBridgeReports, scopedReportId, bridgeReportId, readBridgeChannel, readBridgeReportLog } from "@/lib/bridge/store";
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

// One resident response worker owns this bounded cache. Cross-process revisions
// invalidate it; legacy stores use their atomic file identities instead.
const unchanged = new Map<string, string>();
function reportInputRevision(project: string, seat: string): string {
  const collections = ["tasks", "pipelines", "board_maintenance_runs", "attention_dismissals", "bridge_reports", "project_aliases", "worktree_map"];
  const revisions = readStateCollectionRevisions(statePath("state.sqlite"), collections);
  const files = ["orchestrator-seats.json", "operator-settings.json", "project-aliases.json", "tasks.json", "pipelines.json", "attention-dismissals.json", "bridge-reports.json", "worktree-map.json"];
  const identity = (filename: string, versioned = true) => {
    try { const stat = fs.statSync(filename); return [stat.dev, stat.ino, ...(versioned ? [stat.size, stat.mtimeMs] : [])]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return ["absent"];
    }
  };
  const registry = agentRegistry();
  return JSON.stringify([identity(statePath("state.sqlite"), false), project, seat, operatorLocale(), [...revisions], files.map(file => identity(statePath(file))),
    registry.storageDiagnostics().revision ?? identity(registry.filename)]);
}

export async function recordSeatRuleReports(project: string, at: string, deadlineAt = Date.now() + 5_000): Promise<void> {
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  if (remaining() <= 0) throw new DeadlineExceededError("seat rule reports source deadline exhausted", 0);
  const prepared = await waitForStateLock("seat-tick.rule-reports.prepare", () => {
    const seat = orchestratorSeatForCurrentProject(project).active;
    if (!seat?.conversationId) return null;
    const cacheKey = `${statePath("state.sqlite")}:${project}`;
    const revision = reportInputRevision(project, seat.conversationId);
    if (unchanged.get(cacheKey) === revision) return null;
    const registry = agentRegistry().readOnlySnapshot();
    const log = readBridgeReportLog();
    readBridgeChannel();
    const known = new Set([...log.reports.map(row => row.id), ...log.retired]);
    const inputs = ruleReports({ project, at, seatConversationId: seat.conversationId, locale: operatorLocale() === "en" ? "en" : "uk",
      tasks: loadTasksForList().filter(task => canonicalOrchestratorProject(task.project) === project),
      pipelines: loadPipelinesForList().flatMap(lane => canonicalOrchestratorProject(lane.project) === project ? [{ ...lane, project }] : []), deliveries: Object.values(registry.heldDeliveries),
      maintenance: maintenanceRuns(project), dismissals: readAttentionDismissals().records, bridgeLog: { ...log, reports: log.reports.map(row => row.project ? { ...row, project: canonicalOrchestratorProject(row.project) } : row) },
      deliveryLost: delivery => registry.deliveryOperationOwners[delivery.command.operationId]?.terminalDisposition === "lost",
      deliveryProject: delivery => {
        const held = delivery.command.origin?.project ?? registry.conversations[delivery.conversationId]?.projectOwnership?.project;
        return held ? canonicalOrchestratorProject(held) : null;
      } }).filter(row => !known.has(scopedReportId(project, row.key)) && !known.has(bridgeReportId(row.key)));
    return { inputs, cacheKey, revision, conversationId: seat.conversationId };
  }, { waitMs: remaining() });
  if (!prepared) return;
  if (remaining() <= 0) throw new DeadlineExceededError("seat rule reports source deadline exhausted", 0);
  await waitForStateLock("seat-tick.rule-reports.append", () => appendBridgeReports(prepared.inputs), { waitMs: remaining() });
  if (reportInputRevision(project, prepared.conversationId) === prepared.revision) {
    unchanged.delete(prepared.cacheKey);
    unchanged.set(prepared.cacheKey, prepared.revision);
    if (unchanged.size > 128) unchanged.delete(unchanged.keys().next().value!);
  }
}
