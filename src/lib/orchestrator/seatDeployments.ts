import { runtimeHostClient } from "@/lib/runtime/client";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { statePath } from "@/lib/configDir";
import { readJsonCache, writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

/**
 * Which seat started which deployment (#2063).
 *
 * The deployment ledger records what was deployed and how it went, and nothing
 * about who asked. A seat that calls `deploy_exact_sha` ends its turn, because
 * the promotion replaces the host its turn runs on, and the seat tick then had
 * no way to tell that deploy from anyone else's: the deploy settled in five
 * minutes and the seat sat idle for thirty, with the lanes it had paused for
 * the deploy still paused.
 *
 * The binding persists the original request before dispatch and attaches its
 * deployment id after acceptance. The tick recovers lost replies by that key
 * and joins accepted records to the ledger. A deploy nobody recorded
 * here (the operator's, an HTTP caller's) wakes nobody, as before.
 */

export interface SeatDeploymentRecord {
  deploymentId: string;
  /** The seat conversation whose `deploy_exact_sha` call started it. */
  conversationId: string;
  /** The seat's project, null when the seat record names none. */
  project: string | null;
  revision: string;
  requestedAt: string;
  idempotencyKey?: string;
}

export interface PendingSeatDeployment extends Omit<SeatDeploymentRecord, "deploymentId"> {
  idempotencyKey: string;
}

interface SeatDeploymentFile {
  schemaVersion: 1;
  deployments: SeatDeploymentRecord[];
  pending?: PendingSeatDeployment[];
}

/** Newest-last bound. A seat deploys a few times a day; the tick only ever
    needs the ones that have not settled or not been announced yet. It stays
    below the 64 announcements the tick remembers, so a record still here is
    never one the tick has forgotten announcing. */
export const SEAT_DEPLOYMENTS_LIMIT = 50;

export function seatDeploymentsFile(): string {
  return statePath("seat-deployments.json");
}

function isRecord(value: unknown): value is SeatDeploymentRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SeatDeploymentRecord>;
  return typeof row.deploymentId === "string" && row.deploymentId.length > 0
    && typeof row.conversationId === "string" && row.conversationId.length > 0
    && (row.project === null || typeof row.project === "string")
    && typeof row.revision === "string"
    && typeof row.requestedAt === "string";
}

function readRecords(filePath: string): SeatDeploymentRecord[] {
  const raw = readJsonCache(filePath) as Partial<SeatDeploymentFile> | undefined;
  return Array.isArray(raw?.deployments) ? raw.deployments.filter(isRecord) : [];
}

/** Record one accepted deployment. A replayed request names the same
    deployment and leaves one row. */
export function recordSeatDeployment(record: SeatDeploymentRecord): void {
  const filePath = seatDeploymentsFile();
  withFileTransactionSync(filePath, "the seat deployment record is busy", () => {
    const previous = readRecords(filePath);
    const rows = previous.filter((row) => row.deploymentId !== record.deploymentId);
    const existing = previous.find(row => row.deploymentId === record.deploymentId);
    if (existing && existing.conversationId !== record.conversationId) throw new Error("deployment is attributed to another seat");
    rows.push(record);
    const pending = readPending(filePath).filter(row => row.idempotencyKey !== record.idempotencyKey);
    const file: SeatDeploymentFile = { schemaVersion: 1, deployments: rows.slice(-SEAT_DEPLOYMENTS_LIMIT), pending };
    writeJsonDurably(filePath, file);
  });
}

/** The deployments one seat conversation started, oldest first. */
export function seatDeploymentsFor(conversationId: string): SeatDeploymentRecord[] {
  return readRecords(seatDeploymentsFile()).filter((row) => row.conversationId === conversationId);
}

function readPending(filePath: string): PendingSeatDeployment[] {
  const raw = readJsonCache(filePath) as Partial<SeatDeploymentFile> | undefined;
  return Array.isArray(raw?.pending) ? raw.pending.filter(row => row
    && typeof row.idempotencyKey === "string" && row.idempotencyKey.length > 0
    && isRecord({ ...row, deploymentId: "pending" })) : [];
}

/** Persist attribution before any transport can admit the request. */
export function beginSeatDeployment(record: PendingSeatDeployment): void {
  const filePath = seatDeploymentsFile();
  withFileTransactionSync(filePath, "the seat deployment record is busy", () => {
    const deployments = readRecords(filePath);
    const pending = readPending(filePath);
    const previous = [...deployments, ...pending].find(row => row.idempotencyKey === record.idempotencyKey);
    if (previous) {
      if (previous.conversationId !== record.conversationId || previous.revision !== record.revision
        || previous.project !== record.project) throw new Error("deployment request key is already attributed to another request");
      return;
    }
    if (pending.length >= SEAT_DEPLOYMENTS_LIMIT) throw new Error("pending seat deployment attribution is full");
    pending.push(record);
    writeJsonDurably(filePath, { schemaVersion: 1, deployments, pending });
  });
}

/** Remove a request after definite refusal or durable accepted attribution. */
export function forgetSeatDeploymentRequest(idempotencyKey: string, conversationId: string): void {
  const filePath = seatDeploymentsFile();
  withFileTransactionSync(filePath, "the seat deployment record is busy", () => {
    writeJsonDurably(filePath, { schemaVersion: 1, deployments: readRecords(filePath),
      pending: readPending(filePath).filter(row => row.idempotencyKey !== idempotencyKey || row.conversationId !== conversationId) });
  });
}

export async function findSeatDeploymentByKey(idempotencyKey: string): Promise<ViewerDeploymentStatus | null> {
  const client = runtimeHostClient();
  if (!client?.findViewerDeploymentByIdempotencyKey) throw new Error("deployment lookup is unavailable");
  return client.findViewerDeploymentByIdempotencyKey(idempotencyKey);
}

/** Recover the original admission after a lost reply or process restart.
    Unknown keys and unavailable reads stay pending; this never submits work. */
export async function recoverSeatDeploymentRequests(
  conversationId: string,
  lookup: (key: string) => Promise<ViewerDeploymentStatus | null> = findSeatDeploymentByKey,
  record: (row: SeatDeploymentRecord) => void = recordSeatDeployment,
): Promise<void> {
  for (const pending of readPending(seatDeploymentsFile()).filter(row => row.conversationId === conversationId)) {
    try {
      const status = await lookup(pending.idempotencyKey);
      if (!status || !status.deploymentId || status.idempotencyKey !== pending.idempotencyKey
        || status.requestedRevision.toLowerCase() !== pending.revision.toLowerCase()) continue;
      record({ ...pending, deploymentId: status.deploymentId, revision: status.revision });
      forgetSeatDeploymentRequest(pending.idempotencyKey, pending.conversationId);
    } catch {
      // Attribution remains durable for the next controller check.
    }
  }
}
