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
  saveCheckoutDeployment(directory, { ...status, phase, terminal: ["done", "failed"].includes(intent.state), error: intent.detail ?? null,
    updatedAt: new Date().toISOString(), revisionNumber: status.revisionNumber + 1 });
}
