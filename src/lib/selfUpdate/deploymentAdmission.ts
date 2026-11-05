import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DeploymentAdmissionClosedError, type ViewerDeploymentRequest, type ViewerDeploymentReceipt } from "@/lib/runtime/contracts";
import { stateLockAttempt, waitForStateLock } from "@/lib/state/lockWait";
import { checkoutDeploymentByIdempotencyKey } from "./deployments";

/** The release fence owns the ledger. This lock also serializes a late
 * admission with reconciliation across service instances and processes.
 * No awaited target resolution or launcher work holds it. */
export async function checkoutAdmission<T>(directory: string, request: ViewerDeploymentRequest, authorize: (() => void) | undefined, admit: () => T): Promise<T | ViewerDeploymentReceipt> {
  if (request.reconcileOnly !== undefined && typeof request.reconcileOnly !== "boolean") throw new Error("invalid reconciliation flag");
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(request.idempotencyKey)) throw new Error("Invalid deployment idempotency key");
  const target = request.ref ?? request.revision;
  if (!target) throw new Error("deployment target is required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, "deployment-admission.sqlite");
  const db = new Database(filename);
  chmodSync(filename, 0o600);
  let closed = false;
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL");
    await waitForStateLock("checkout.deployment-admission", () => {
      stateLockAttempt("checkout.deployment-admission", () => db.exec("BEGIN IMMEDIATE"), "checkout deployments");
    }, { waitMs: 1000, subject: "checkout deployments" });
    try {
      authorize?.();
      db.exec("CREATE TABLE IF NOT EXISTS refusals (request_key TEXT PRIMARY KEY, target TEXT NOT NULL)");
      const prior = db.query<{ target: string }, [string]>("SELECT target FROM refusals WHERE request_key = ?").get(request.idempotencyKey);
      if (prior && prior.target !== target) throw new Error("idempotency-conflict");
      if (prior) throw new DeploymentAdmissionClosedError();
      const existing = checkoutDeploymentByIdempotencyKey(directory, request.idempotencyKey);
      let result: T | ViewerDeploymentReceipt | undefined;
      if (existing) {
        if (existing.requestedRevision !== target) throw new Error("idempotency-conflict");
        result = { state: "accepted", deploymentId: existing.deploymentId, revision: existing.revision, replayed: true };
      } else if (request.reconcileOnly) {
        db.query("INSERT INTO refusals(request_key, target) VALUES (?, ?)").run(request.idempotencyKey, target);
        closed = true;
      } else result = admit();
      db.exec("COMMIT");
      if (closed) throw new DeploymentAdmissionClosedError();
      return result!;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* committed terminal refusal */ }
      throw error;
    }
  } finally { db.close(); }
}
