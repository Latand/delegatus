import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DeploymentAdmissionClosedError, type ViewerDeploymentRequest, type ViewerDeploymentReceipt } from "@/lib/runtime/contracts";
import { stateLockAttempt, waitForStateLock } from "@/lib/state/lockWait";
import { checkoutDeploymentByIdempotencyKey } from "./deployments";

export class DeploymentAdmissionSupersededError extends Error {
  readonly code = "deploy_attempt_superseded";
  constructor() { super("This admission attempt was refused before execution. Retry with the same request key."); }
}

/** The release fence owns the ledger. This lock also serializes a late
 * admission with reconciliation across service instances and processes.
 * No awaited target resolution or launcher work holds it. */
export async function checkoutAdmission<T>(directory: string, request: ViewerDeploymentRequest, authorize: (() => void) | undefined, admit: (attempt: number) => T,
  options: { attempt?: number; refuse?: true; retireOnBusy?: true; deadlineAt?: number } = {}): Promise<T | ViewerDeploymentReceipt> {
  if (request.reconcileOnly !== undefined && typeof request.reconcileOnly !== "boolean") throw new Error("invalid reconciliation flag");
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(request.idempotencyKey)) throw new Error("Invalid deployment idempotency key");
  const target = request.ref ?? request.revision;
  if (!target) throw new Error("deployment target is required");
  // Next loads route modules in Node page-data workers. Resolve Bun's driver
  // only when serving an admission, as the other state stores do.
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Checkout deployment admission requires the Bun runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, "deployment-admission.sqlite");
  const db = new sqlite.Database(filename);
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
      const currentAttempt = () => {
        db.exec("CREATE TABLE IF NOT EXISTS attempts (request_key TEXT PRIMARY KEY, target TEXT NOT NULL, generation INTEGER NOT NULL)");
        db.query("INSERT OR IGNORE INTO attempts(request_key, target, generation) VALUES (?, ?, 0)").run(request.idempotencyKey, target);
        const attempt = db.query<{ target: string; generation: number }, [string]>("SELECT target, generation FROM attempts WHERE request_key = ?").get(request.idempotencyKey)!;
        if (attempt.target !== target) throw new Error("idempotency-conflict");
        if (options.attempt !== undefined && attempt.generation !== options.attempt) throw new DeploymentAdmissionSupersededError();
        return attempt.generation;
      };
      const existing = checkoutDeploymentByIdempotencyKey(directory, request.idempotencyKey);
      let result: T | ViewerDeploymentReceipt | undefined;
      if (existing) {
        if (existing.requestedRevision !== target) throw new Error("idempotency-conflict");
        result = { state: "accepted", deploymentId: existing.deploymentId, revision: existing.revision, replayed: true };
      } else if (request.reconcileOnly) {
        if (options.attempt !== undefined) currentAttempt();
        db.query("INSERT INTO refusals(request_key, target) VALUES (?, ?)").run(request.idempotencyKey, target);
        closed = true;
      } else {
        const attempt = currentAttempt();
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          db.query("INSERT INTO refusals(request_key, target) VALUES (?, ?)").run(request.idempotencyKey, target);
          closed = true;
        } else {
          // A retryable refusal retires its generation. A green/health read
          // that started before it cannot admit after the refusal was answered,
          // even in another Viewer process. The next same-key call gets the
          // new generation, with the original target still bound to the key.
          if (options.refuse) db.query("UPDATE attempts SET generation = generation + 1 WHERE request_key = ?").run(request.idempotencyKey);
          result = admit(attempt);
          if (options.retireOnBusy && typeof result === "object" && result !== null && "state" in result && result.state === "busy") {
            db.query("UPDATE attempts SET generation = generation + 1 WHERE request_key = ?").run(request.idempotencyKey);
          }
        }
      }
      db.exec("COMMIT");
      if (closed) throw new DeploymentAdmissionClosedError();
      return result!;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* committed terminal refusal */ }
      throw error;
    }
  } finally { db.close(); }
}
