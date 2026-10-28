import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import type { ExternalRelayAnswer, ExternalRelayCompletion, ExternalRelayOwner, ExternalRelayTarget } from "./protocol";
import type { OwnerBridgeContext } from "./ownerBridgeContext";
import type { OwnerTurnDiagnostic } from "./diagnostic";

export type RelayTargetSettings = {
  id: string;
  name: string;
  answered_by: "install" | "service";
  fallback: "service" | "none";
  enabled: boolean;
  engine: "claude" | "codex" | "codex-cloud" | null;
  cloudEnvironmentId?: string | null;
  model: string | null;
  effort: string | null;
  project: string | null;
  concurrency: number;
  hardCapMinutes: number;
  /** Answers per member per hour in each chat (§B.8); absent is the default, null or 0 no limit. */
  memberLimitPerHour?: number | null;
  /** Absent is off; only the operator can enable full owner agent runs. */
  ownerTier?: boolean;
};
/** The open «Створити клона» request (cloneCreate.ts), until it ends. */
export type RelayCloneRequest = {
  request_id: string;
  create_url: string;
  expires_at: string;
  name: string;
  username: string;
  requestedAt: string;
};
/**
 * A clone the relay reported created while its request was open here. It
 * stays until the settings card has given the new target this install's
 * engine and route and says so, so a page closed or reloaded while the
 * relay answered still finishes the setup when it opens again.
 */
export type RelayCloneCreated = {
  request_id: string;
  target_id: string | null;
  /** The target's name as Telegram confirmed it, else the requested one. */
  name: string;
  username: string;
  photo_failed: boolean;
  createdAt: string;
};
export type PairedRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  credential: string;
  features?: string[];
  owner: ExternalRelayOwner;
  pairedAt: string;
  paused: boolean;
  limits: {
    max_response_bytes: number;
    max_wait_s: number;
    max_answer_chars: number;
  };
  targets: RelayTargetSettings[];
  cloneRequest?: RelayCloneRequest;
  cloneCreated?: RelayCloneCreated;
};
export type PendingRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  features?: string[];
  limits: PairedRelay["limits"];
  pairing_id: string;
  poll_secret: string;
  code: string;
  verify_url: string | null;
  expires_at: string;
  poll_interval_s: number;
  owner?: ExternalRelayOwner;
  targets?: ExternalRelayTarget[];
};
export type RelayStore = {
  v: 1;
  installId: string;
  label: string;
  relays: PairedRelay[];
  pending: PendingRelay[];
};
export type RunRecord = {
  /** Written before Cloud dispatch. A confirmed failure clears it for fallback;
   * a completed turn remains fenced until its completion is accepted. */
  cloudExecution?: "uncertain" | "completed";
  /** Execution ended; retained delivery/cleanup custody owns no target slot. */
  capacityReleased?: true;
  /** The service accepted this request's completion; recovery only cleans up. */
  completionAccepted?: true;
  /** Present only on a full owner run, bound by the Viewer to its spawn receipt. */
  conversationId?: string;
  /** Durable custody survives a lost lease, cutoff, or Viewer restart. */
  ownerTurn?: { rawRequest?: unknown; context?: import("./profile").OwnerInstruction; restartRetries?: 1; restartPending?: true;
    delivery?: import("./protocol").OwnerDelivery;
    /** Persisted before /complete; an absent ACK never authorizes /send. */
    completionAttempt?: { body: ExternalRelayCompletion; files: import("./attachments").StagedAttachment[] };
    lateAnswer?: { body: ExternalRelayCompletion; files: import("./attachments").StagedAttachment[];
      clientKey?: string; payload?: import("./cloneSend").CloneSendInput; firstAttemptAt?: number; nextAttemptAt?: number;
      parts?: { payload: import("./cloneSend").CloneSendInput; firstAttemptAt?: number;
        receipt?: Extract<import("./cloneSend").CloneSendResult, { kind: "sent" }> }[];
      status?: "retry" | "pending-delivery-context" | "uncertain" | "retry-expired" | "refused" };
    diagnostic?: OwnerTurnDiagnostic; continuation?: { operationId: string }; clientAttemptId: string; prototype?: true; request?: { text: string; requestText: string | null }; bridgeReport?: OwnerBridgeContext; admissionComplete?: boolean; cancel?: "interrupt" | "kill"; confirmed?: boolean;
    /** When the cutoff was first written; older rows are stamped on recovery. */
    cancelledAt?: string;
    /** Terminal local recovery; executor termination is still unproven. The
     * cutoff and evidence stay durable, without reserving execution or a chain. */
    quarantinedAt?: string;
    /** The target slot was released while this custody record is retained. */
    released?: OwnerStopRelease;
    /** The scrubbed failure reply and the request deadline it may be sent before,
     * so recovery after a restart can still answer the requester. */
    failureReply?: { answer: ExternalRelayAnswer; until: string } };
  requestId: string;
  leaseId: string;
  relayId: string;
  targetId: string;
  childPid: number | null;
  childIdentity: string | null;
  ownerPid: number;
  ownerIdentity: string | null;
  runDir: string;
  startedAt: string;
};
export type RunLedger = { v: 1; runs: RunRecord[] };
/** `no_execution` confirms absence of an executor. `stop_unconfirmed` records
 * the bounded stop's release; quarantinedAt makes local recovery terminal. */
export type OwnerStopRelease = { at: string; reason: "no_execution" | "stop_unconfirmed" };
/** Released owner custody stays readable this long before the sweep drops it. */
export const OWNER_RELEASED_CUSTODY_RETENTION_MS = 24 * 60 * 60_000;
/** A cutoff still undergoing bounded stop recovery. Quarantine retains the
 * evidence and revocation without claiming that the executor has stopped. */
export function ownerStopPending(run: RunRecord): boolean {
  return !!run.ownerTurn?.cancel && !run.ownerTurn.confirmed && !run.ownerTurn.quarantinedAt;
}
/** Delivery and quarantine retention are independent of execution reservation. */
export function runHoldsConversation(run: RunRecord): boolean {
  if (!run.ownerTurn) return true;
  if (ownerStopPending(run)) return true;
  return !run.capacityReleased && !run.ownerTurn?.confirmed && !run.ownerTurn?.quarantinedAt;
}
export function runHoldsCapacity(run: RunRecord): boolean {
  return !run.capacityReleased && !run.ownerTurn?.confirmed && !run.ownerTurn?.released;
}
type RelayRequestClaim = { requestId: string; leaseId: string; ownerPid: number; ownerIdentity: string; claimedAt: number; terminalAt?: number; completion?: ExternalRelayCompletion };
type RelayRequestLedger = { v: 1; claims: RelayRequestClaim[] };
const RELAY_REQUEST_CLAIM_RETENTION_MS = 24 * 60 * 60_000;
export const externalRelayFile = (name: "relays" | "runs" | "requests") =>
  statePath(`external-relay/${name}.json`);
function read<T>(file: string, fallback: () => T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}
export function writeRelayFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
// A pending pairing past its expiry can no longer be confirmed, so it and its
// poll secret leave the store on the next read or write, whether or not a
// check ever reached the service after it ran out.
const expired = (pending: PendingRelay, now: number) =>
  Date.parse(pending.expires_at) <= now;
function withoutExpired(store: RelayStore): RelayStore {
  const now = Date.now();
  return store.pending.some((item) => expired(item, now))
    ? { ...store, pending: store.pending.filter((item) => !expired(item, now)) }
    : store;
}
export function readRelayStore(): RelayStore {
  const store = readStoredRelays();
  return store.pending.some((item) => expired(item, Date.now()))
    ? updateRelayStore((current) => current)
    : store;
}
/** Authority reads never create settings or prune pending pairings. */
export function pairedTelegramOwner(userId: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    return store.v === 1 && Array.isArray(store.relays) && store.relays.some(relay =>
      relay?.paused === false && relay.owner?.namespace === "telegram" && relay.owner.id === userId);
  } catch { return false; }
}
function readStoredRelays(): RelayStore {
  const file = externalRelayFile("relays");
  const existed = fs.existsSync(file);
  const store = read(file, () => ({
    v: 1 as const,
    installId: randomUUID(),
    label: "Delegatus",
    relays: [],
    pending: [],
  }));
  if (
    store.v !== 1 ||
    !Array.isArray(store.relays) ||
    !Array.isArray(store.pending)
  )
    throw new Error("invalid relay store");
  if (!existed) writeRelayFile(file, store);
  return store;
}
export function updateRelayStore(
  change: (store: RelayStore) => RelayStore,
): RelayStore {
  const file = externalRelayFile("relays");
  return withFileLock(file, () => {
    const next = withoutExpired(change(withoutExpired(readStoredRelays())));
    writeRelayFile(file, next);
    return next;
  });
}
export function readRunLedger(): RunLedger {
  const ledger = read(externalRelayFile("runs"), () => ({
    v: 1 as const,
    runs: [],
  }));
  if (ledger.v !== 1 || !Array.isArray(ledger.runs))
    throw new Error("invalid run ledger");
  return ledger;
}
export function updateRunLedger(
  change: (ledger: RunLedger) => RunLedger,
  waitMs?: number,
): RunLedger {
  const file = externalRelayFile("runs");
  return withFileLock(file, () => {
    const next = change(readRunLedger());
    writeRelayFile(file, next);
    return next;
  }, waitMs);
}
/** The wait blocks the event loop, so an in-process async holder cannot
 * release during it; callers with their own retry pass a short wait. */
export function withFileLock<T>(file: string, action: () => T, waitMs = 5_000): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  const deadline = Date.now() + waitMs;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > 1_000) {
        try {
          const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as {
            pid?: number;
            identity?: string;
          };
          if (
            !owner.pid ||
            !owner.identity ||
            procBackend.processIdentity(owner.pid) !== owner.identity
          )
            fs.rmSync(lock, { force: true });
        } catch {
          fs.rmSync(lock, { force: true });
        }
      }
      if (Date.now() >= deadline) throw new Error("relay store is busy");
      // eslint-disable-next-line no-restricted-syntax -- Legacy relay-store write lock during serving relay mutations.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        identity: procBackend.processIdentity(process.pid),
      }),
    );
    return action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
export class RelayStoreBusy extends Error {
  constructor() { super("relay store is busy"); this.name = "RelayStoreBusy"; }
}
export async function withFileLockAsync<T>(file: string, action: () => T | Promise<T>, until: number): Promise<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  const deadline = until;
  let firstAttempt = true;
  while (fd === null) {
    if (!firstAttempt && Date.now() >= deadline) throw new RelayStoreBusy();
    firstAttempt = false;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > 1_000) {
        try {
          const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as {
            pid?: number;
            identity?: string;
          };
          if (
            !owner.pid ||
            !owner.identity ||
            procBackend.processIdentity(owner.pid) !== owner.identity
          )
            fs.rmSync(lock, { force: true });
        } catch {
          fs.rmSync(lock, { force: true });
        }
      }
      if (Date.now() >= deadline) throw new RelayStoreBusy();
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))));
    }
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        identity: procBackend.processIdentity(process.pid),
      }),
    );
    return await action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
export async function updateRunLedgerAsync(change: (ledger: RunLedger) => RunLedger, until: number): Promise<RunLedger> {
  const file = externalRelayFile("runs");
  return withFileLockAsync(file, () => {
    const next = change(readRunLedger());
    writeRelayFile(file, next);
    return next;
  }, until);
}
export function reserveRun(
  record: RunRecord,
  maxConcurrent?: number,
): "added" | "duplicate" | "full" {
  let outcome: "added" | "duplicate" | "full" = "full";
  updateRunLedger((ledger) => {
    if (ledger.runs.some((run) => run.requestId === record.requestId)) {
      outcome = "duplicate";
      return ledger;
    }
    if (
      maxConcurrent !== undefined &&
      ledger.runs.filter(
        (run) =>
          run.relayId === record.relayId && run.targetId === record.targetId && runHoldsCapacity(run),
      ).length >= maxConcurrent
    )
      return ledger;
    outcome = "added";
    return { ...ledger, runs: [...ledger.runs, record] };
  });
  return outcome;
}
export function changeRun(
  requestId: string,
  change: (record: RunRecord) => RunRecord,
  waitMs?: number,
): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.map((run) =>
      run.requestId === requestId ? change(run) : run,
    ),
  }), waitMs);
}
export function dropRun(requestId: string): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.filter((run) => run.requestId !== requestId),
  }));
}
export async function reserveRunAsync(
  record: RunRecord,
  maxConcurrent: number | undefined,
  until: number,
  replaceStoppedOwner = false,
): Promise<"added" | "duplicate" | "full"> {
  let outcome: "added" | "duplicate" | "full" = "full";
  await updateRunLedgerAsync((ledger) => {
    const previous = ledger.runs.find(run => run.requestId === record.requestId);
    if (previous && !(replaceStoppedOwner && previous.ownerTurn?.confirmed
      && record.ownerTurn?.restartRetries === 1 && previous.relayId === record.relayId && previous.targetId === record.targetId)) {
      outcome = "duplicate";
      return ledger;
    }
    if (
      maxConcurrent !== undefined &&
      ledger.runs.filter(
        (run) =>
          run.relayId === record.relayId && run.targetId === record.targetId && runHoldsCapacity(run),
      ).length >= maxConcurrent
    )
      return ledger;
    outcome = "added";
    return { ...ledger, runs: [...ledger.runs.filter(run => run.requestId !== record.requestId), record] };
  }, until);
  return outcome;
}
export async function changeRunAsync(
  requestId: string,
  change: (record: RunRecord) => RunRecord,
  until: number,
): Promise<void> {
  await updateRunLedgerAsync((ledger) => ({
    ...ledger,
    runs: ledger.runs.map((run) =>
      run.requestId === requestId ? change(run) : run,
    ),
  }), until);
}
export async function dropRunAsync(requestId: string, until: number): Promise<void> {
  await updateRunLedgerAsync((ledger) => ({
    ...ledger,
    runs: ledger.runs.filter((run) => run.requestId !== requestId),
  }), until);
}
function readRelayRequestLedger(): RelayRequestLedger {
  const ledger = read(externalRelayFile("requests"), () => ({ v: 1 as const, claims: [] }));
  if (ledger.v !== 1 || !Array.isArray(ledger.claims)) throw new Error("invalid relay request claim ledger");
  return ledger;
}
/** Atomically claim request identity independently of the execution-slot ledger. */
export async function claimRelayRequestAsync(requestId: string, leaseId: string, until: number): Promise<
  { kind: "claimed" } | { kind: "duplicate" } | { kind: "terminal"; completion: ExternalRelayCompletion | null }
> {
  const file = externalRelayFile("requests");
  const ownerPid = process.pid;
  const ownerIdentity = procBackend.processIdentity(ownerPid);
  if (!ownerIdentity) throw new Error("relay request owner identity unavailable");
  let result: { kind: "claimed" } | { kind: "duplicate" } | { kind: "terminal"; completion: ExternalRelayCompletion | null } = { kind: "duplicate" };
  await withFileLockAsync(file, () => {
    const now = Date.now();
    const ledger = readRelayRequestLedger();
    const claims = ledger.claims.filter(claim => claim.terminalAt === undefined || now - claim.terminalAt < RELAY_REQUEST_CLAIM_RETENTION_MS);
    const existing = claims.find(claim => claim.requestId === requestId && claim.leaseId === leaseId);
    if (existing) {
      if (existing.terminalAt !== undefined) {
        result = { kind: "terminal", completion: existing.completion ?? null };
        writeRelayFile(file, { v: 1, claims });
        return;
      }
      if (procBackend.processIdentity(existing.ownerPid) === existing.ownerIdentity) {
        writeRelayFile(file, { v: 1, claims });
        return;
      }
      const recovered = claims.filter(claim => claim.requestId !== requestId || claim.leaseId !== leaseId);
      writeRelayFile(file, { v: 1, claims: [...recovered, { requestId, leaseId, ownerPid, ownerIdentity, claimedAt: now }] });
      result = { kind: "claimed" };
      return;
    }
    writeRelayFile(file, { v: 1, claims: [...claims, { requestId, leaseId, ownerPid, ownerIdentity, claimedAt: now }] });
    result = { kind: "claimed" };
  }, until);
  return result;
}
/** Keep a terminal tombstone after delivery, or release a claim whose delivery was definitely refused. */
export async function settleRelayRequestClaimAsync(
  requestId: string,
  leaseId: string,
  ownerPid: number,
  ownerIdentity: string,
  disposition: "terminal" | "release",
  completion: ExternalRelayCompletion | null,
  until: number,
): Promise<void> {
  const file = externalRelayFile("requests");
  await withFileLockAsync(file, () => {
    const ledger = readRelayRequestLedger();
    const claims = ledger.claims.flatMap(claim => {
      if (claim.requestId !== requestId || claim.leaseId !== leaseId || claim.ownerPid !== ownerPid || claim.ownerIdentity !== ownerIdentity || claim.terminalAt !== undefined) return [claim];
      return disposition === "terminal" ? [{ ...claim, terminalAt: Date.now(), ...(completion ? { completion } : {}) }] : [];
    });
    writeRelayFile(file, { v: 1, claims });
  }, until);
}
/** New targets use Cloud; existing settings are retained when targets refresh. */
export function newTargetSettings(
  target: ExternalRelayTarget,
): RelayTargetSettings {
  return {
    id: target.target_id,
    name: target.name,
    answered_by: target.answered_by,
    fallback: target.fallback,
    enabled: true,
    engine: "codex-cloud",
    model: "gpt-6.1-sol",
    effort: null,
    project: null,
    concurrency: 1,
    hardCapMinutes: 30,
  };
}
/**
 * The service's list, in its order, over the stored settings: a target it
 * still lists keeps the operator's settings and takes the service's name,
 * `answered_by` and `fallback`; a new one uses the Cloud default; one it no
 * longer lists is dropped.
 */
export function mergeRelayTargets(
  stored: RelayTargetSettings[],
  remote: ExternalRelayTarget[],
): RelayTargetSettings[] {
  const byId = new Map(stored.map((target) => [target.id, target]));
  return remote.map((target) => {
    const kept = byId.get(target.target_id);
    return kept
      ? {
          ...kept,
          name: target.name,
          answered_by: target.answered_by,
          fallback: target.fallback,
        }
      : newTargetSettings(target);
  });
}
export function publicRelay(
  relay: PairedRelay,
): Omit<PairedRelay, "credential"> {
  const { credential: _credential, ...publicRecord } = relay;
  return publicRecord;
}
export function publicPending(
  pending: PendingRelay,
): Omit<PendingRelay, "poll_secret"> {
  const { poll_secret: _secret, ...publicRecord } = pending;
  return publicRecord;
}
