import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "./store";

type LeaseScope = Pick<RunRecord, "requestId" | "leaseId" | "relayId" | "targetId" | "runDir">;
export type RequesterLease = LeaseScope & { stallMs: number; deadlineAt: number };
const leaseDir = (runDir: string) => path.join(runDir, "requester-lease");
const receiptPath = (runDir: string) => path.join(leaseDir(runDir), "receipt.json");
const scopeKey = (scope: LeaseScope) => createHash("sha256").update(
  JSON.stringify([scope.relayId, scope.targetId, scope.requestId, scope.leaseId]),
).digest("hex");

export async function openRequesterLease(lease: RequesterLease): Promise<void> {
  await fs.promises.mkdir(leaseDir(lease.runDir), { mode: 0o700 });
}

/** The heartbeat sender owns the receipt. Once freshness lapses, a delayed
 * acknowledgement cannot restore authority that may already have fallen back. */
export function requesterLeaseWriter(lease: RequesterLease) {
  let until = Infinity;
  const end = () => { until = 0; endRequesterLease(lease); };
  return {
    acknowledge(sentAt: number) {
      const next = Math.min(sentAt + lease.stallMs, lease.deadlineAt);
      if (Date.now() >= Math.min(until, next)) { end(); return; }
      until = next;
      writeReceipt(lease, until);
    },
    end,
  };
}

function writeReceipt(lease: LeaseScope, until: number): void {
  const file = receiptPath(lease.runDir);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ scope: scopeKey(lease), until }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      endRequesterLease(lease);
      console.error("External relay requester lease receipt unavailable");
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function endRequesterLease(lease: LeaseScope): void {
  // Moving the parent atomically prevents an in-flight heartbeat from
  // publishing a receipt after either process has revoked the lease.
  const directory = leaseDir(lease.runDir);
  try { fs.renameSync(directory, `${directory}-ended`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("External relay requester lease revocation unavailable");
  }
}

function receiptUntil(scope: LeaseScope, text: string): number | null {
  const receipt = JSON.parse(text);
  return receipt.scope === scopeKey(scope) && Number.isFinite(receipt.until) ? receipt.until : null;
}

export function requesterLeaseActive(scope: LeaseScope): boolean {
  try {
    const until = receiptUntil(scope, fs.readFileSync(receiptPath(scope.runDir), "utf8"));
    return until !== null && Date.now() < until;
  } catch { return false; }
}

export async function requesterLeaseUntilAsync(scope: LeaseScope): Promise<number | null> {
  try { return receiptUntil(scope, await fs.promises.readFile(receiptPath(scope.runDir), "utf8")); }
  catch { return null; }
}
