import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import type { ApplyIntent } from "./apply";
import { writeAtomic } from "./apply";
export function checkoutDeployments(directory: string): ViewerDeploymentStatus[] {
  const file = join(directory, "deployments.json");
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || rows.some(row => typeof row.deploymentId !== "string" || typeof row.idempotencyKey !== "string")) throw new Error("The checkout deployment ledger is unreadable");
  return rows;
}
export function saveCheckoutDeployment(directory: string, status: ViewerDeploymentStatus): void {
  const rows = checkoutDeployments(directory);
  const index = rows.findIndex(row => row.deploymentId === status.deploymentId);
  if (index < 0) rows.push(status); else rows[index] = status;
  writeAtomic(join(directory, "deployments.json"), rows);
}
export function settleCheckoutDeployment(directory: string, intent: ApplyIntent): void {
  if (!intent.deploymentId) return;
  const status = checkoutDeployments(directory).find(row => row.deploymentId === intent.deploymentId);
  if (!status) throw new Error("The admitted checkout deployment is missing");
  const phase = intent.state === "done" ? "succeeded" : intent.state === "failed" ? intent.rolledBack ? "rolled-back" : "failed"
    : intent.state === "switching" ? "host-handoff" : "building";
  const terminal = ["done", "failed"].includes(intent.state);
  if (status.phase === phase && status.terminal === terminal && status.error === (intent.detail ?? null)) return;
  saveCheckoutDeployment(directory, { ...status, phase, terminal, error: intent.detail ?? null,
    updatedAt: new Date().toISOString(), revisionNumber: status.revisionNumber + 1 });
}

/** A cold Viewer reconciles both sides of the receipt/apply persistence boundary. */
export function recoverCheckoutDeployments(directory: string, intent: ApplyIntent | null): void {
  if (intent?.deploymentId) settleCheckoutDeployment(directory, intent);
  for (const status of checkoutDeployments(directory)) {
    if (status.terminal || status.deploymentId === intent?.deploymentId) continue;
    saveCheckoutDeployment(directory, { ...status, phase: "failed", terminal: true,
      error: "The Viewer stopped before persisting deployment ownership", updatedAt: new Date().toISOString(), revisionNumber: status.revisionNumber + 1 });
  }
}
