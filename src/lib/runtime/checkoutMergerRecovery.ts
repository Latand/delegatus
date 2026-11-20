import fs from "node:fs";
import path from "node:path";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { structuredClaimIdentity, type RegistryFile } from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus, sameRecordedProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { readHostExit } from "./hostExit";
import { interruptionObligationId } from "./interruptionObligations";
import { readTranscriptCutEvidence } from "./liveness";

export const CHECKOUT_MERGER_CAPTURE = "checkout-mergers.json";
export const CHECKOUT_MERGER_LIMIT = 200;
export const CHECKOUT_MERGER_WINDOW_MS = 15 * 60_000;
export const CHECKOUT_MERGER_BOUNDARY = "checkout-merger:";
export const CHECKOUT_MERGER_OPERATION_PREFIX = "checkout_merger_";

type Batch = { directory: string; identity: string; branch: string };

export type CheckoutMerger = {
  conversationId: ViewerConversationId;
  engine: "claude" | "codex";
  sessionId: string;
  path: string;
  claimEpoch: number;
  process: ProcessIdentity;
  writer: ProcessIdentity | null;
  batch: Batch | null;
  turnState?: "busy" | "idle";
};

export type CheckoutMergerCut = CheckoutMerger & { capturedAt: string; boundary: string; admissionProof?: "fresh-cut-v1" };

export function standaloneMerger(file: RegistryFile, id: ViewerConversationId): boolean {
  if ((file.memberships[id] ?? []).some(member => member.kind === "pipeline" || member.kind === "flow")) return false;
  const role = conversationAgentRole(file, id);
  if (role !== null) return role === "merger";
  // The launch receipt predates some conversation role projections.
  const generation = file.conversations[id]?.generations.at(-1);
  return !!generation && registryRowsMatching(file, "receipts", "conversationId", [id]).some(receipt =>
    receipt.state === "completed" && receipt.agentRole === "merger"
    && receipt.key?.engine === file.conversations[id]?.engine && receipt.key.sessionId === generation.id
    && receipt.artifactPath === generation.path);
}

export function checkoutBatchState(directory: string, identity: string, branch?: string) {
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || `${root.dev}:${root.ino}` !== identity || fs.realpathSync(directory) !== directory) return null;
    const file = path.join(directory, "tmp", "merge-batch.json");
    if (fs.realpathSync(file) !== file) return null;
    const state = readBoundedJson(file, 1024 * 1024);
    if ((state.version !== 1 && state.version !== 3) || typeof state.branch !== "string"
      || !/^merge-batch\/[a-f0-9-]{36}$/.test(state.branch) || branch && state.branch !== branch
      || typeof state.landed !== "boolean") return null;
    const lock = fs.lstatSync(file + ".lock", { throwIfNoEntry: false });
    const finished = state.landed && !state.resolving && Array.isArray(state.rows)
      && state.rows.length > 0 && state.rows.every((row: { status?: string; detail?: string } | null) => row
        && (["needs-review", "head-moved", "culprit"].includes(row.status ?? "")
          || row.status === "merged" && ["closed", "head moved after landing; original kept open"].includes(row.detail ?? "")));
    if (!Array.isArray(state.rows) || state.resolving != null && typeof state.resolving !== "boolean") return null;
    return { branch: state.branch, locked: lock?.isDirectory() === true, finished,
      active: !state.landed || state.resolving || !finished };
  } catch { return null; }
}

function readBoundedJson(filename: string, maxBytes: number) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const status = fs.fstatSync(fd);
    if (!status.isFile() || status.size > maxBytes) throw new Error("invalid checkout merger evidence file");
    const data = Buffer.alloc(status.size + 1);
    const length = fs.readSync(fd, data, 0, data.length, 0);
    if (length !== status.size) throw new Error("checkout merger evidence changed during read");
    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function hasIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const id = value as ProcessIdentity;
  return Number.isSafeInteger(id.pid) && id.pid > 0 && typeof id.startIdentity === "string" && !!id.startIdentity
    && (id.bootEpoch == null || typeof id.bootEpoch === "string");
}

export function readCheckoutMergerCuts(directory: string, now = Date.now()): CheckoutMergerCut[] {
  try {
    const rows: unknown = readBoundedJson(path.join(directory, CHECKOUT_MERGER_CAPTURE), 512 * 1024);
    if (!Array.isArray(rows) || rows.length > CHECKOUT_MERGER_LIMIT) throw new Error("invalid checkout merger inventory");
    return rows.map((row: CheckoutMergerCut) => {
      if (!row || !/^conversation_[\w-]+$/.test(row.conversationId) || !["claude", "codex"].includes(row.engine)
        || typeof row.sessionId !== "string" || !row.sessionId || typeof row.path !== "string" || !path.isAbsolute(row.path)
        || row.turnState != null && row.turnState !== "busy" && row.turnState !== "idle"
        || !Number.isSafeInteger(row.claimEpoch) || row.claimEpoch < 1 || !hasIdentity(row.process)
        || row.writer !== null && !hasIdentity(row.writer)
        || !/^checkout-merger:[0-9a-f]{32}$/.test(row.boundary) || row.admissionProof != null && row.admissionProof !== "fresh-cut-v1"
        || typeof row.capturedAt !== "string"
        || !Number.isFinite(Date.parse(row.capturedAt)) || Date.parse(row.capturedAt) > now
        || row.batch !== null && (!row.batch || typeof row.batch.directory !== "string" || !path.isAbsolute(row.batch.directory)
          || typeof row.batch.identity !== "string" || typeof row.batch.branch !== "string")) throw new Error("invalid checkout merger row");
      return row;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function checkoutMergerWithinWindow(cut: CheckoutMergerCut, now = Date.now()) {
  return now - Date.parse(cut.capturedAt) <= CHECKOUT_MERGER_WINDOW_MS;
}

export function checkoutMergerHostKey(cut: CheckoutMerger) {
  return sessionKeyId({ engine: cut.engine, sessionId: cut.sessionId });
}

export function checkoutMergerOperationId(cut: CheckoutMergerCut) {
  return CHECKOUT_MERGER_OPERATION_PREFIX + interruptionObligationId({
    conversationId: cut.conversationId, hostKey: checkoutMergerHostKey(cut), owner: cut.process,
    turnRef: null, boundary: cut.boundary,
  });
}

export function checkoutMergerCutForOperation(filename: string, conversationId: string, operationId: string) {
  return readCheckoutMergerCuts(path.dirname(filename)).find(cut =>
    cut.conversationId === conversationId && checkoutMergerWithinWindow(cut) && checkoutMergerOperationId(cut) === operationId);
}

export function currentCheckoutMerger(file: RegistryFile, cut: CheckoutMerger) {
  const conversation = file.conversations[cut.conversationId];
  const generation = conversation?.generations.at(-1);
  if (!conversation || conversation.engine !== cut.engine || conversation.supersededBy || conversation.migration
    || generation?.id !== cut.sessionId || generation.path !== cut.path || !standaloneMerger(file, cut.conversationId)) return null;
  const entry = file.entries[checkoutMergerHostKey(cut)];
  return entry?.artifactPath === cut.path ? entry : null;
}

const CUTOVER_STOPS = new Set(["deploy-cut", "host-checkpoint-failure", "claude-host-fault", "codex-host-fault", "structured-orphan-stop"]);

export function checkoutMergerCustody(file: RegistryFile, cut: CheckoutMerger) {
  const entry = currentCheckoutMerger(file, cut);
  if (!entry || entry.claimEpoch !== cut.claimEpoch || entry.host) return "changed";
  const process = entry.structuredHost?.process ?? entry.hostExitProcess;
  if (!process || !sameRecordedProcessIdentity(process, cut.process)) return "changed";
  const writer = entry.claimOwner && structuredClaimIdentity(entry.claimOwner);
  if (entry.claimOwner && (!writer || !cut.writer || !sameRecordedProcessIdentity(writer, cut.writer))) return "changed";
  const exit = readHostExit(cut.process);
  const saved = entry.previousHostExit;
  const stop = exit?.stop ?? (saved && sameRecordedProcessIdentity(saved.process, cut.process) ? saved.stop : null);
  if (stop && !CUTOVER_STOPS.has(stop.path)) return "stopped";
  const domain = entry.structuredHost?.signalDomain;
  const survivors = [...entry.structuredTerminationSurvivors ?? [], ...(domain && !domain.retired
    ? [domain.monitor, domain.bubblewrap, domain.init, domain.native] : [])];
  if (exit?.unavailable || [cut.process, ...(cut.writer ? [cut.writer] : []), ...survivors]
    .some(identity => processIdentityStatus(identity) !== "dead")) return "wait";
  return "ended";
}

export async function checkoutMergerTurn(cut: CheckoutMergerCut) {
  const turn = await readTranscriptCutEvidence(cut.engine, cut.path);
  const batch = cut.batch && checkoutBatchState(cut.batch.directory, cut.batch.identity, cut.batch.branch);
  if (batch?.finished) return "finished";
  if (!turn.verified || cut.batch && !batch) return "wait";
  if (turn.turn === "busy") return "interrupted";
  // An engine can close its turn by reporting the command's interruption
  // during systemd stop. The batch was locked in the pre-stop census. The
  // driver may have released its lock while unwinding an interrupted command.
  if (turn.turn === "terminal" && turn.lastWork && turn.lastWork.at >= Date.parse(cut.capturedAt)) return batch ? "interrupted" : "wait";
  return turn.turn === "terminal" ? "finished" : "wait";
}
