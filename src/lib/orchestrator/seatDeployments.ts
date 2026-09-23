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
 * So the binding writes one row here when the runtime host accepts the
 * deployment, and the tick joins it to the ledger. A deploy nobody recorded
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
}

interface SeatDeploymentFile {
  schemaVersion: 1;
  deployments: SeatDeploymentRecord[];
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
    const rows = readRecords(filePath).filter((row) => row.deploymentId !== record.deploymentId);
    rows.push(record);
    const file: SeatDeploymentFile = { schemaVersion: 1, deployments: rows.slice(-SEAT_DEPLOYMENTS_LIMIT) };
    writeJsonDurably(filePath, file);
  });
}

/** The deployments one seat conversation started, oldest first. */
export function seatDeploymentsFor(conversationId: string): SeatDeploymentRecord[] {
  return readRecords(seatDeploymentsFile()).filter((row) => row.conversationId === conversationId);
}
