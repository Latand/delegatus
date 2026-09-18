import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import type { IdentityWavePathRekey } from "@/lib/agent/identityWaveMigration";

/* Operator-selected PER-PROJECT orchestrator seats.
 *
 * The legacy single-instance record (`./store`) stays the bridge's manager
 * pointer; a seat is the operator's durable statement that ONE conversation
 * owns ONE project's board. A seat is written in two durable steps that
 * together make designate-and-inject atomic:
 *
 *  - a PENDING INTENT, persisted before anything is spawned or delivered. It
 *    carries the mandate and the client's idempotency key, so a crash between
 *    "prompt delivered" and "seat active" is recoverable: the retry replays the
 *    same key, the delivery layer deduplicates on it, and completion happens
 *    exactly once.
 *  - ACTIVATION, which seats the conversation, records the mandate that was
 *    actually delivered, and — when a different conversation held the seat —
 *    writes a durable REVOCATION for the predecessor in the same file write.
 *
 * Nothing here grants authority by itself: `./authority` reads seats and
 * revocations and fails closed on anything conflicting, revoked, superseded or
 * cross-project. A pending intent grants nothing, which is exactly why a
 * designation with no delivered mandate cannot exist as an authority.
 *
 * ABA is prevented by the seat epoch: every activation takes the next epoch
 * from a monotonic counter, and a revocation records the epoch it ended. A
 * predecessor returning from pause still names a conversation whose newest
 * revocation is >= any seat it could point at, so it stays dead until the
 * operator deliberately re-designates it — which mints a strictly newer epoch.
 */

export const ORCHESTRATOR_SEATS_SCHEMA_VERSION = 1;

export interface OrchestratorSeatIntent {
  /** Client idempotency key; doubles as the spawn clientAttemptId or the
      delivery clientMessageId, so every side effect replays instead of
      duplicating. */
  clientRequestId: string;
  mode: "spawn" | "existing";
  /** Durable launch receipt for an accepted asynchronous spawn. */
  launchId: string | null;
  /** Terminal error of the last completion attempt; null while none failed. */
  error: string | null;
}

/**
 * WHO triggered the designation this seat came from (#1402).
 *
 * Rotation refuses nobody, so this is what answers for it: the record names the
 * actor kind the request presented, the conversation that named itself (null for
 * the operator's own browser, which names none), and the seat epoch that caller
 * held at the time when it was itself a designated seat — which is how a seat
 * that rotated ITSELF is legible as exactly that. The bare lineage shows only an
 * anonymous successor standing beside a revoked predecessor.
 *
 * Absent on every designation made before this existed, and on paths that never
 * carry an actor. A reader must treat that absence as unknown provenance; "the
 * operator did it" is never a safe reading of it.
 */
export interface OrchestratorSeatTrigger {
  kind: "operator" | "agent";
  conversationId: string | null;
  seatEpoch: number | null;
}

export interface OrchestratorSeat {
  project: string;
  /** Monotonic designation epoch; strictly increases across the whole file. */
  seatEpoch: number;
  /** Null only while a spawn-mode intent has not settled a conversation. */
  conversationId: string | null;
  path: string | null;
  /** Incumbent runtime identity frozen with the request so creator-death and
      completed replays cannot reconstruct it from a changed retry payload. */
  engine?: string | null;
  model?: string | null;
  /** False only for persisted rows written before runtime identity freezing. */
  runtimeIdentityFrozen?: boolean;
  /** The mandate text delivered (active) or to be delivered (pending). */
  mandate: string;
  /** Version of the approved default prompt the mandate was based on; null
      when the designation predates versioning or the mandate is bespoke. */
  promptVersion: number | null;
  /** Rotation lineage: the conversation this seat replaced, when any. The
      matching revocation carries `successorConversationId`, so the link is
      bidirectional and both cards stay navigable. */
  predecessorConversationId: string | null;
  /** Who triggered this designation, when the request named an actor. */
  triggeredBy?: OrchestratorSeatTrigger | null;
  state: "pending" | "active";
  intent: OrchestratorSeatIntent;
  designatedAt: string;
  activatedAt: string | null;
}

/** A designation attempt that ended — never deleted. The full seat snapshot
    (key, mandate, epoch, mode, error, timestamps) stays readable so the
    operator can see what was attempted and why it failed. Written the moment
    the attempt fails (issue #1757), so a burnt epoch is never silent: a
    pending intent that records a terminal error, a pending intent whose epoch
    fell below the project's active seat, and a provisional activation rolled
    back because its launch never produced a readable conversation all land
    here. */
export interface OrchestratorSeatTerminalization {
  seat: OrchestratorSeat;
  /** Why it stopped blocking: it recorded a terminal error, or its epoch fell
      below the project's active seat (something else already seated it). */
  reason: "terminal_error" | "superseded_epoch";
  terminalizedAt: string;
}

/** What a stillborn seat's rollback did: the attempt it terminalized, and the
    predecessor — if any survived the check — that holds the project now. */
export interface StillbornSeatRollback {
  terminalized: OrchestratorSeatTerminalization;
  restored: OrchestratorSeat | null;
}

/** Newest-last bound on terminalized history, so the file cannot grow without
    limit; the oldest entries are trimmed first. */
export const ORCHESTRATOR_SEAT_HISTORY_CAP = 50;

export interface OrchestratorRevocation {
  project: string;
  conversationId: string;
  /** Epoch of the seat that ended. An identity is dead while its newest
      revocation is >= every active seat naming it. */
  seatEpoch: number;
  revokedAt: string;
  /** The seat that replaced it — the other half of the rotation lineage. */
  successorConversationId?: string | null;
  /** Who triggered the rotation that ended this seat (#1402), copied from the
      successor's intent so the lineage entry answers "who did this" on its own. */
  triggeredBy?: OrchestratorSeatTrigger | null;
}

interface OrchestratorSeatFile {
  schemaVersion: number;
  nextSeatEpoch: number;
  /** Active seat per project. */
  seats: Record<string, OrchestratorSeat>;
  /** Pending designate-and-inject intents per project. */
  pending: Record<string, OrchestratorSeat>;
  revocations: OrchestratorRevocation[];
  /** Terminalized pending intents, oldest first, bounded by
      ORCHESTRATOR_SEAT_HISTORY_CAP. */
  history: OrchestratorSeatTerminalization[];
  /**
   * Per project, the seat an ACTIVE PROVISIONAL one replaced (issue #1757) —
   * one activated on a launch that was durably accepted but has not yet
   * produced a conversation the Viewer can read.
   *
   * It is the rollback the operator's authority depends on: if that launch dies
   * before its conversation exists, the seat it seated was stillborn and the
   * predecessor recorded here is designated again, rather than the project
   * being left holding an orchestrator nobody can reach. Written at the
   * provisional activation, dropped the moment the successor proves readable.
   *
   * Kept OUT of the seat row on purpose: it is internal recovery state, and a
   * copy of a mandate-sized row riding along on every surface that reports a
   * seat is a cost nobody asked for.
   */
  rollbacks: Record<string, OrchestratorSeat>;
}

const seatsFile = () => statePath("orchestrator-seats.json");

/** One durable namespace for named projects and their repository identities. */
export function canonicalOrchestratorProject(project: string): string {
  return canonicalProject(project.trim());
}

function emptyFile(): OrchestratorSeatFile {
  return { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, seats: {}, pending: {}, revocations: [], history: [], rollbacks: {} };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

/** A trigger survives the round trip only when it is fully formed; a half-written
    one is dropped, so partial provenance is never reported. */
function normalizeSeatTrigger(value: unknown): OrchestratorSeatTrigger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trigger = value as Partial<OrchestratorSeatTrigger>;
  if (trigger.kind !== "operator" && trigger.kind !== "agent") return null;
  const conversationId = typeof trigger.conversationId === "string" && trigger.conversationId ? trigger.conversationId : null;
  const seatEpoch = typeof trigger.seatEpoch === "number" && Number.isInteger(trigger.seatEpoch) && trigger.seatEpoch >= 1
    ? trigger.seatEpoch
    : null;
  return { kind: trigger.kind, conversationId, seatEpoch };
}

function normalizeSeat(value: unknown): OrchestratorSeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seat = value as Partial<OrchestratorSeat>;
  if (typeof seat.project !== "string" || !seat.project) return null;
  if (typeof seat.seatEpoch !== "number" || !Number.isInteger(seat.seatEpoch) || seat.seatEpoch < 1) return null;
  if (seat.conversationId !== null && typeof seat.conversationId !== "string") return null;
  if (seat.path !== null && typeof seat.path !== "string") return null;
  if (typeof seat.mandate !== "string") return null;
  if (seat.state !== "pending" && seat.state !== "active") return null;
  const intent = seat.intent as Partial<OrchestratorSeatIntent> | undefined;
  if (!intent || typeof intent.clientRequestId !== "string" || !intent.clientRequestId) return null;
  if (intent.mode !== "spawn" && intent.mode !== "existing") return null;
  if (typeof seat.designatedAt !== "string") return null;
  if (seat.activatedAt !== null && typeof seat.activatedAt !== "string") return null;
  const engine = typeof seat.engine === "string" && seat.engine.trim() ? seat.engine : null;
  const model = typeof seat.model === "string" && seat.model.trim() ? seat.model : null;
  const runtimeIdentityFrozen = typeof seat.runtimeIdentityFrozen === "boolean"
    ? seat.runtimeIdentityFrozen
    : Boolean(engine || model);
  return {
    project: seat.project,
    seatEpoch: seat.seatEpoch,
    conversationId: seat.conversationId ?? null,
    path: seat.path ?? null,
    engine,
    model,
    runtimeIdentityFrozen,
    mandate: seat.mandate,
    promptVersion: typeof seat.promptVersion === "number" && Number.isInteger(seat.promptVersion) ? seat.promptVersion : null,
    predecessorConversationId: typeof seat.predecessorConversationId === "string" ? seat.predecessorConversationId : null,
    triggeredBy: normalizeSeatTrigger(seat.triggeredBy),
    state: seat.state,
    intent: {
      clientRequestId: intent.clientRequestId,
      mode: intent.mode,
      launchId: typeof intent.launchId === "string" ? intent.launchId : null,
      error: typeof intent.error === "string" ? intent.error : null,
    },
    designatedAt: seat.designatedAt,
    activatedAt: seat.activatedAt ?? null,
  };
}

/** Append one terminalization, oldest-first, trimming to the cap. THE one
    place a burnt epoch becomes readable history (issue #1757). */
function recordTerminalization(
  file: OrchestratorSeatFile,
  entry: OrchestratorSeatTerminalization,
): OrchestratorSeatTerminalization {
  file.history.push(entry);
  if (file.history.length > ORCHESTRATOR_SEAT_HISTORY_CAP) {
    file.history.splice(0, file.history.length - ORCHESTRATOR_SEAT_HISTORY_CAP);
  }
  return entry;
}

function retainNewestSeat(collection: Record<string, OrchestratorSeat>, seat: OrchestratorSeat): void {
  const current = collection[seat.project];
  if (!current || seat.seatEpoch > current.seatEpoch) collection[seat.project] = seat;
}

/**
 * The tolerant read, with one distinction the callers above do not need and
 * #747 does: null means the durable store could not be ESTABLISHED — an
 * unreadable file, a torn write, a future schema — while an empty file means
 * the store answered and holds nothing. A machine that has never designated an
 * orchestrator has no file at all, and that is a real "no seats".
 *
 * Individual malformed rows are still dropped rather than refused: a row that
 * does not normalize is not evidence of a seat, and the next designation
 * overwrites it.
 */
function readOrchestratorSeatFileOrNull(): OrchestratorSeatFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(seatsFile(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? emptyFile() : null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorSeatFile>;
    if (parsed.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) return null;
    const file = emptyFile();
    file.nextSeatEpoch = typeof parsed.nextSeatEpoch === "number" && Number.isInteger(parsed.nextSeatEpoch) && parsed.nextSeatEpoch >= 1
      ? parsed.nextSeatEpoch
      : 1;
    for (const [project, candidate] of Object.entries(parsed.seats ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "active" && seat.conversationId) {
        retainNewestSeat(file.seats, { ...seat, project: canonicalOrchestratorProject(project) });
      }
    }
    for (const [project, candidate] of Object.entries(parsed.pending ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "pending") {
        retainNewestSeat(file.pending, { ...seat, project: canonicalOrchestratorProject(project) });
      }
    }
    for (const [project, candidate] of Object.entries(parsed.rollbacks ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.conversationId) file.rollbacks[canonicalOrchestratorProject(project)] = seat;
    }
    for (const candidate of Array.isArray(parsed.revocations) ? parsed.revocations : []) {
      const revocation = candidate as Partial<OrchestratorRevocation>;
      if (typeof revocation.project === "string" && typeof revocation.conversationId === "string"
        && typeof revocation.seatEpoch === "number" && Number.isInteger(revocation.seatEpoch)
        && typeof revocation.revokedAt === "string") {
        file.revocations.push({
          project: canonicalOrchestratorProject(revocation.project),
          conversationId: revocation.conversationId,
          seatEpoch: revocation.seatEpoch,
          revokedAt: revocation.revokedAt,
          successorConversationId: typeof revocation.successorConversationId === "string" ? revocation.successorConversationId : null,
          triggeredBy: normalizeSeatTrigger(revocation.triggeredBy),
        });
      }
    }
    for (const candidate of Array.isArray(parsed.history) ? parsed.history : []) {
      const entry = candidate as Partial<OrchestratorSeatTerminalization>;
      const seat = normalizeSeat(entry.seat);
      if (seat
        && (entry.reason === "terminal_error" || entry.reason === "superseded_epoch")
        && typeof entry.terminalizedAt === "string") {
        file.history.push({
          seat: { ...seat, project: canonicalOrchestratorProject(seat.project) },
          reason: entry.reason,
          terminalizedAt: entry.terminalizedAt,
        });
      }
    }
    /* The epoch counter must postdate everything on file, or a corrupted
       counter would let a fresh seat land at an epoch a revocation already
       covers and be born dead. */
    const highest = Math.max(0,
      ...Object.values(file.seats).map((seat) => seat.seatEpoch),
      ...Object.values(file.pending).map((seat) => seat.seatEpoch),
      ...Object.values(file.rollbacks).map((seat) => seat.seatEpoch),
      ...file.revocations.map((revocation) => revocation.seatEpoch),
      ...file.history.map((entry) => entry.seat.seatEpoch));
    if (file.nextSeatEpoch <= highest) file.nextSeatEpoch = highest + 1;
    return file;
  } catch {
    return null;
  }
}

/**
 * A malformed or future-schema file reads as EMPTY, not as an error: authority
 * fails closed on an absent seat, and the next designation overwrites the
 * corrupt file — the same recovery shape the legacy record uses. Individual
 * malformed rows are dropped for the same reason.
 */
export function readOrchestratorSeatFile(): OrchestratorSeatFile {
  return readOrchestratorSeatFileOrNull() ?? emptyFile();
}

type OrchestratorSeatMigrationEvidence = {
  raw: Record<string, unknown> | null;
  normalized: OrchestratorSeatFile;
};

function migrationEvidenceError(cause?: unknown): Error {
  return cause === undefined
    ? new Error("orchestrator seat evidence is malformed")
    : new Error("orchestrator seat evidence is malformed", { cause });
}

function recordEvidence(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw migrationEvidenceError(new Error(`${field} is invalid`));
  return value as Record<string, unknown>;
}

function arrayEvidence(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw migrationEvidenceError(new Error(`${field} is invalid`));
  return value;
}

/** Strict, lossless read used only by the one-time identity wave. Runtime
    authority keeps its fail-closed tolerant reader, while this path refuses to
    publish a rewritten file when any sibling evidence would be discarded. */
function readOrchestratorSeatMigrationEvidence(): OrchestratorSeatMigrationEvidence {
  let rawText: string;
  try {
    rawText = fs.readFileSync(seatsFile(), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: null, normalized: emptyFile() };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw migrationEvidenceError(error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw migrationEvidenceError();
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) throw migrationEvidenceError();
  if (typeof raw.nextSeatEpoch !== "number" || !Number.isInteger(raw.nextSeatEpoch) || raw.nextSeatEpoch < 1) {
    throw migrationEvidenceError();
  }

  const normalized = emptyFile();
  normalized.nextSeatEpoch = raw.nextSeatEpoch;
  for (const [project, candidate] of Object.entries(recordEvidence(raw.seats, "seats"))) {
    const seat = normalizeSeat(candidate);
    if (!seat || seat.project !== project || seat.state !== "active" || !seat.conversationId) throw migrationEvidenceError();
    const canonical = canonicalOrchestratorProject(project);
    if (normalized.seats[canonical]) throw migrationEvidenceError();
    normalized.seats[canonical] = { ...seat, project: canonical };
  }
  for (const [project, candidate] of Object.entries(recordEvidence(raw.pending, "pending"))) {
    const seat = normalizeSeat(candidate);
    if (!seat || seat.project !== project || seat.state !== "pending") throw migrationEvidenceError();
    const canonical = canonicalOrchestratorProject(project);
    if (normalized.pending[canonical]) throw migrationEvidenceError();
    normalized.pending[canonical] = { ...seat, project: canonical };
  }
  for (const candidate of arrayEvidence(raw.revocations, "revocations")) {
    const revocation = candidate as Partial<OrchestratorRevocation> | null;
    if (!revocation || typeof revocation !== "object"
      || typeof revocation.project !== "string" || !revocation.project
      || typeof revocation.conversationId !== "string" || !revocation.conversationId
      || typeof revocation.seatEpoch !== "number" || !Number.isInteger(revocation.seatEpoch) || revocation.seatEpoch < 1
      || typeof revocation.revokedAt !== "string"
      || (revocation.successorConversationId !== undefined
        && revocation.successorConversationId !== null
        && typeof revocation.successorConversationId !== "string")) {
      throw migrationEvidenceError();
    }
    normalized.revocations.push({
      project: canonicalOrchestratorProject(revocation.project),
      conversationId: revocation.conversationId,
      seatEpoch: revocation.seatEpoch,
      revokedAt: revocation.revokedAt,
      successorConversationId: revocation.successorConversationId ?? null,
      /* Carried through the migration: this reader's whole point is that a
         rewrite publishes everything it read. */
      triggeredBy: normalizeSeatTrigger(revocation.triggeredBy),
    });
  }
  for (const candidate of arrayEvidence(raw.history, "history")) {
    const entry = candidate as Partial<OrchestratorSeatTerminalization> | null;
    const seat = normalizeSeat(entry?.seat);
    if (!entry || !seat
      || (entry.reason !== "terminal_error" && entry.reason !== "superseded_epoch")
      || typeof entry.terminalizedAt !== "string") {
      throw migrationEvidenceError();
    }
    normalized.history.push({
      seat: { ...seat, project: canonicalOrchestratorProject(seat.project) },
      reason: entry.reason,
      terminalizedAt: entry.terminalizedAt,
    });
  }
  return { raw, normalized };
}

function writeSeatFile(file: OrchestratorSeatFile): void {
  atomicWriteJson(seatsFile(), file);
}

/** The active seat, any pending intent, and the terminalized-intent history
    for one project (oldest first). */
export function orchestratorSeatFor(project: string): {
  active: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  history: OrchestratorSeatTerminalization[];
} {
  const file = readOrchestratorSeatFile();
  const canonical = canonicalOrchestratorProject(project);
  return {
    active: file.seats[canonical] ?? null,
    pending: file.pending[canonical] ?? null,
    history: file.history.filter((entry) => entry.seat.project === canonical),
  };
}

export type BeginSeatIntentResult =
  /** A fresh pending intent; `terminalized` names the abandoned intent it
      moved into durable history, when there was one. */
  | { kind: "begun"; seat: OrchestratorSeat; terminalized?: OrchestratorSeatTerminalization }
  /** The same intent replayed by its own key, for the caller to finish. */
  | { kind: "replay"; seat: OrchestratorSeat }
  /** Another request owns the in-flight transition for this project. */
  | { kind: "in_progress"; seat: OrchestratorSeat }
  /** The same key already completed: designation and injection both happened. */
  | { kind: "completed"; seat: OrchestratorSeat };

/**
 * Persist the designate-and-inject intent BEFORE any side effect. Idempotent on
 * `clientRequestId`: a replay of a completed intent short-circuits to the active
 * seat (deliver nothing twice), and a replay of a STILL-LIVE pending one returns
 * it for the caller to finish. A NEW key is blocked (`in_progress`) only by a
 * genuinely in-flight pending intent — one with no terminal error whose epoch is
 * at or above the project's active seat. An ABANDONED pending intent — terminal
 * `intent.error` recorded, or epoch below the active seat — is TERMINALIZED in
 * the same write: moved out of the blocking `pending` position into the bounded
 * durable `history`, never deleted, and the new intent proceeds. A terminal
 * error outranks the idempotency key, so the intent that failed is cleared by
 * the very next begin whichever key sends it (issue #1067 AC 5).
 */
export function beginOrchestratorSeatIntent(input: {
  project: string;
  mandate: string;
  clientRequestId: string;
  mode: "spawn" | "existing";
  conversationId?: string | null;
  engine?: string | null;
  model?: string | null;
  promptVersion?: number | null;
  /** Who triggered this designation, resolved from the request by the caller —
      never read off a caller-supplied body, so attribution cannot be dictated. */
  triggeredBy?: OrchestratorSeatTrigger | null;
  now?: string;
}): BeginSeatIntentResult {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (active && active.intent.clientRequestId === input.clientRequestId) {
      return { kind: "completed", seat: active };
    }
    const pending = file.pending[project];
    /* TERMINAL BEATS IDEMPOTENT (issue #1067 AC 5). A recorded `intent.error` is
       the intent's FINAL state, so the row is not handed back for the caller to
       "finish" — not even to the key that created it. Replaying it re-delivers
       the STORED mandate, which is exactly the text that failed: a rotation that
       had already recomposed a mandate small enough to deliver would send the
       oversized one again, and the failed row would keep its blocking `pending`
       position forever behind a dead banner. Whoever begins next, same key or
       new, moves it into history and starts a fresh intent. Exactly-once still
       holds where it matters: delivery is deduplicated by the clientRequestId-
       derived `clientMessageId` and a spawn by its `clientAttemptId` receipt. */
    if (pending && pending.intent.error === null && pending.intent.clientRequestId === input.clientRequestId) {
      return { kind: "replay", seat: pending };
    }
    let terminalized: OrchestratorSeatTerminalization | undefined;
    if (pending) {
      const abandoned = pending.intent.error !== null || (active !== undefined && pending.seatEpoch < active.seatEpoch);
      if (!abandoned) return { kind: "in_progress", seat: pending };
      terminalized = recordTerminalization(file, {
        seat: pending,
        reason: pending.intent.error !== null ? "terminal_error" : "superseded_epoch",
        terminalizedAt: input.now ?? new Date().toISOString(),
      });
      delete file.pending[project];
    }
    const seat: OrchestratorSeat = {
      project,
      seatEpoch: file.nextSeatEpoch,
      conversationId: input.conversationId ?? null,
      path: null,
      engine: input.engine?.trim() || null,
      model: input.model?.trim() || null,
      runtimeIdentityFrozen: Boolean(input.engine?.trim() && input.model?.trim()),
      mandate: input.mandate,
      promptVersion: input.promptVersion ?? null,
      predecessorConversationId: null,
      triggeredBy: input.triggeredBy ?? null,
      state: "pending",
      intent: { clientRequestId: input.clientRequestId, mode: input.mode, launchId: null, error: null },
      designatedAt: input.now ?? new Date().toISOString(),
      activatedAt: null,
    };
    file.nextSeatEpoch += 1;
    file.pending[project] = seat;
    writeSeatFile(file);
    return { kind: "begun", seat, ...(terminalized ? { terminalized } : {}) };
  });
}

export type CompleteSeatIntentResult =
  | { kind: "activated"; seat: OrchestratorSeat; revoked: OrchestratorRevocation | null }
  | { kind: "replay"; seat: OrchestratorSeat }
  | { kind: "missing" };

/**
 * Activate the pending intent — the mandate has provably been delivered (or
 * durably accepted for exactly-once delivery by the spawn receipt) to
 * `conversationId`. One atomic write seats the conversation AND revokes a
 * differing predecessor, so there is no interleaving in which both, or
 * neither, hold the project.
 */
export function completeOrchestratorSeatIntent(input: {
  project: string;
  clientRequestId: string;
  conversationId: string;
  path: string | null;
  launchId?: string | null;
  engine?: string | null;
  model?: string | null;
  now?: string;
}): CompleteSeatIntentResult {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (active && active.intent.clientRequestId === input.clientRequestId) {
      return { kind: "replay", seat: active };
    }
    const pending = file.pending[project];
    if (!pending || pending.intent.clientRequestId !== input.clientRequestId) return { kind: "missing" };
    const now = input.now ?? new Date().toISOString();
    let revoked: OrchestratorRevocation | null = null;
    if (active && active.conversationId && active.conversationId !== input.conversationId) {
      revoked = {
        project,
        conversationId: active.conversationId,
        seatEpoch: active.seatEpoch,
        revokedAt: now,
        /* Bidirectional lineage: the revocation names its successor, the
           successor seat names its predecessor, and both cards stay navigable. */
        successorConversationId: input.conversationId,
        /* ...and WHO ended this seat (#1402), carried from the pending intent
           that the triggering request wrote it on. Reading it off the intent is
           what keeps the answer truthful for a rotation that settles long after
           its request returned — an accepted spawn activates from the
           reconciler, which has no request to ask. */
        triggeredBy: pending.triggeredBy ?? null,
      };
      file.revocations.push(revoked);
    }
    /* PROVISIONAL (issue #1757): a spawn that was durably accepted but has not
       produced a readable transcript yet. The seat is real — the launch owns
       the conversation id and the mandate is delivered exactly once by the
       receipt — but it is not yet PROVEN, so the predecessor it replaced is
       kept as the rollback until it is. */
    const provisional = pending.intent.mode === "spawn" && input.path === null;
    if (provisional && active?.conversationId && active.conversationId !== input.conversationId) {
      file.rollbacks[project] = active;
    } else {
      delete file.rollbacks[project];
    }
    const seat: OrchestratorSeat = {
      ...pending,
      conversationId: input.conversationId,
      path: input.path,
      engine: pending.engine ?? (input.engine?.trim() || null),
      model: pending.model ?? (input.model?.trim() || null),
      runtimeIdentityFrozen: pending.runtimeIdentityFrozen === true || Boolean(input.engine || input.model),
      predecessorConversationId: revoked?.conversationId ?? pending.predecessorConversationId,
      state: "active",
      intent: { ...pending.intent, launchId: input.launchId ?? pending.intent.launchId, error: null },
      activatedAt: now,
    };
    delete file.pending[project];
    file.seats[project] = seat;
    writeSeatFile(file);
    return { kind: "activated", seat, revoked };
  });
}

/** Fill runtime metadata on active seats created before engine/model became
 * durable seat fields. Existing values remain authoritative. */
export function repairOrchestratorSeatRuntimeIdentity(input: {
  project: string;
  conversationId: string;
  engine?: string | null;
  model?: string | null;
}): OrchestratorSeat | null {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const project = canonicalOrchestratorProject(input.project);
    const seat = file.seats[project];
    if (!seat || seat.conversationId !== input.conversationId) return null;
    const engine = seat.engine ?? (input.engine?.trim() || null);
    const model = seat.model ?? (input.model?.trim() || null);
    if (engine === seat.engine && model === seat.model) return seat;
    const repaired = { ...seat, engine, model };
    file.seats[project] = repaired;
    writeSeatFile(file);
    return repaired;
  });
}

/**
 * Record why a pending intent could not complete; the previous active seat
 * (if any) stays authoritative.
 *
 * The recorded error is the intent's TERMINAL state (issue #1067) — and since
 * #1757 the row is terminalized in the SAME write: it leaves the blocking
 * `pending` position and lands in `history` as `terminal_error`, carrying the
 * epoch it burnt and the reason it burnt it. It used to sit in `pending` until
 * the next `beginOrchestratorSeatIntent`, which is a call that may never come:
 * three rotation attempts died in one morning and `intentHistory` — the record
 * the operator actually reads — held nothing newer than eight days before.
 * A failure is history the moment it happens, not the next time somebody tries.
 *
 * Returns the terminalization so the refusing caller can answer with the very
 * row it just wrote, rather than reading back a `pending` slot that is now
 * empty; null when no pending intent under that key was there to fail.
 */
export function failOrchestratorSeatIntent(
  project: string,
  clientRequestId: string,
  error: string,
  now?: string,
): OrchestratorSeatTerminalization | null {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const canonical = canonicalOrchestratorProject(project);
    const pending = file.pending[canonical];
    if (!pending || pending.intent.clientRequestId !== clientRequestId) return null;
    pending.intent.error = error.slice(0, 500);
    const terminalized = recordTerminalization(file, {
      seat: pending,
      reason: "terminal_error",
      terminalizedAt: now ?? new Date().toISOString(),
    });
    delete file.pending[canonical];
    writeSeatFile(file);
    return terminalized;
  });
}

/**
 * Roll back a PROVISIONAL activation whose launch died before it ever produced
 * a conversation the Viewer can read (issue #1757).
 *
 * The incident: a rotation's spawn was durably accepted (202) with a reserved
 * conversation id, the seat activated on that acceptance, and the deferred
 * launch then failed. The seat held a conversation with no transcript and no
 * registry row for as long as anyone cared to look — `get_conversation`
 * answered «not found», the successor's handover pointed at it, and the
 * operator typed two messages into its composer that nothing could receive.
 * Nothing in the store repaired an ALREADY ACTIVE seat when its launch receipt
 * turned terminal; only pending intents were reconciled.
 *
 * So: the stillborn seat is revoked and terminalized into `history` with its
 * reason, and the predecessor it superseded — kept in `rollbacks` since the
 * provisional activation for exactly this — is designated again at a FRESH
 * epoch, which is what lifts the revocation that ended it. A rollback with no predecessor on
 * record leaves the project undesignated, which is the honest answer and the
 * one `create_orchestrator` exists for.
 *
 * Two things the restoration is not allowed to assume, both of them ways the
 * repair would reach the state it exists to prevent:
 *
 *  - that the recorded predecessor is STILL reachable. It can stop being so
 *    inside the provisional window, so `resolvable` is asked before the project
 *    is designated onto it again, and a predecessor that fails leaves the
 *    project undesignated with that said in the terminalization reason.
 *  - that a `rollbacks` entry exists at all. A seat already standing on a
 *    stillborn conversation when this shipped has none, so the revocation
 *    lineage — which names the predecessor each successor superseded — is the
 *    fallback, and `restorableSeat` composes the row from that identity.
 *
 * Refuses (null) unless the active seat is the one named, is still provisional
 * and came from a spawn: a seat that has proved readable is a live
 * orchestrator, and nothing here may unseat one of those.
 */
export function abandonStillbornOrchestratorSeat(input: {
  project: string;
  clientRequestId: string;
  error: string;
  now?: string;
  /** Whether the Viewer can still resolve a conversation. Absent means the
      caller is not asking — only this store's own tests pass nothing. */
  resolvable?: (conversationId: string) => boolean;
  /** Compose the row for a predecessor the lineage names and `rollbacks` does
      not hold. The store supplies the identity; naming a mandate and reading a
      transcript belong to the caller. */
  restorableSeat?: (input: { conversationId: string; stillborn: OrchestratorSeat }) => OrchestratorSeat | null;
}): StillbornSeatRollback | null {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (!active || active.intent.clientRequestId !== input.clientRequestId) return null;
    if (active.state !== "active" || active.intent.mode !== "spawn" || active.path !== null) return null;
    if (!active.conversationId) return null;
    const now = input.now ?? new Date().toISOString();
    const recorded = file.rollbacks[project] ?? null;
    /* Newest-first, so a project rotated more than once follows the revocation
       that actually seated the stillborn conversation. */
    const lineagePredecessor = recorded
      ? null
      : [...file.revocations].reverse().find((revocation) =>
        revocation.project === project && revocation.successorConversationId === active.conversationId)?.conversationId ?? null;
    const candidate = recorded
      ?? (lineagePredecessor ? input.restorableSeat?.({ conversationId: lineagePredecessor, stillborn: active }) ?? null : null);
    const unresolvable = Boolean(
      candidate?.conversationId && input.resolvable && !input.resolvable(candidate.conversationId),
    );
    const predecessor = unresolvable ? null : candidate;
    let restored: OrchestratorSeat | null = null;
    if (predecessor?.conversationId) {
      restored = {
        ...predecessor,
        project,
        /* A fresh epoch, strictly newer than the revocation that ended this
           seat: the ABA guard reads an identity as dead while its newest
           revocation stands at or above every seat naming it, so restoring at
           the old epoch would designate a conversation that still reads as
           revoked. */
        seatEpoch: file.nextSeatEpoch,
        state: "active",
        activatedAt: now,
      };
      file.nextSeatEpoch += 1;
      file.seats[project] = restored;
    } else {
      delete file.seats[project];
    }
    file.revocations.push({
      project,
      conversationId: active.conversationId,
      seatEpoch: active.seatEpoch,
      revokedAt: now,
      successorConversationId: restored?.conversationId ?? null,
      triggeredBy: active.triggeredBy ?? null,
    });
    delete file.rollbacks[project];
    /* WHY the project ends undesignated, on the row the operator reads. A bare
       «the launch failed» beside an empty seat reads as a second, unexplained
       failure. */
    const reason = unresolvable
      ? `${input.error}; the predecessor ${candidate!.conversationId} it would have been rolled back to is no longer resolvable either, so the project is left undesignated`
      : input.error;
    const terminalized = recordTerminalization(file, {
      seat: { ...active, intent: { ...active.intent, error: reason.slice(0, 500) } },
      reason: "terminal_error",
      terminalizedAt: now,
    });
    writeSeatFile(file);
    return { terminalized, restored };
  });
}

/**
 * Drop a provisional seat's rollback once its launch has proved readable, and
 * record the transcript path the launch produced.
 *
 * The other half of {@link abandonStillbornOrchestratorSeat}: a seat stops
 * being provisional the moment the Viewer can resolve its conversation, and
 * from then on it holds no copy of the predecessor it replaced. Idempotent,
 * and refuses any seat but the named one.
 */
export function confirmOrchestratorSeatMaterialization(input: {
  project: string;
  clientRequestId: string;
  conversationId: string;
  path: string;
}): OrchestratorSeat | null {
  return withAccountMutationLock(() => {
    const file = readOrchestratorSeatFile();
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (!active || active.intent.clientRequestId !== input.clientRequestId) return null;
    if (active.conversationId !== input.conversationId) return null;
    if (active.path === input.path && !file.rollbacks[project]) return active;
    const confirmed: OrchestratorSeat = { ...active, path: input.path };
    file.seats[project] = confirmed;
    delete file.rollbacks[project];
    writeSeatFile(file);
    return confirmed;
  });
}

/** Every active seat, for the authority resolver. */
export function activeOrchestratorSeats(): OrchestratorSeat[] {
  return Object.values(readOrchestratorSeatFile().seats);
}

/**
 * Every active seat, or null when the durable store could not be established.
 *
 * {@link activeOrchestratorSeats} is fail-closed for AUTHORITY: an unreadable
 * file means nobody can prove a seat, so nobody is granted one. Automatic host
 * retirement (#747) asks the same question with the opposite consequence — a
 * silent "no seats" would clear a live orchestrator for the kill, and an
 * orchestrator is exactly the host that sits quiet for hours between operator
 * messages. So it reads this one and refuses on null.
 */
export function activeOrchestratorSeatsOrUnknown(): OrchestratorSeat[] | null {
  const file = readOrchestratorSeatFileOrNull();
  return file === null ? null : Object.values(file.seats);
}

/**
 * One project's active and pending seats, or null when the durable store could
 * not be established (a torn or future-schema file, an unreadable path). A
 * missing file is a store with no seats.
 *
 * The per-project sibling of {@link activeOrchestratorSeatsOrUnknown}, for a
 * refusal that must not fail open: a task group hide (#1695) is refused for the
 * task holding the seat conversation, and "the record said nothing" is not
 * evidence that the task holds none. {@link orchestratorSeatFor} keeps its
 * fail-closed-for-authority reading.
 */
export function orchestratorSeatForOrUnknown(project: string): { active: OrchestratorSeat | null; pending: OrchestratorSeat | null } | null {
  const file = readOrchestratorSeatFileOrNull();
  if (file === null) return null;
  const canonical = canonicalOrchestratorProject(project);
  return { active: file.seats[canonical] ?? null, pending: file.pending[canonical] ?? null };
}

/** Active-seat evidence for the one-time identity migration. A missing store
 * is valid before any designation; unreadable or malformed durable evidence
 * must keep the migration marker open for a later retry. */
export function activeOrchestratorSeatsForMigration(): OrchestratorSeat[] {
  return Object.values(readOrchestratorSeatMigrationEvidence().normalized.seats);
}

/** Converge the active authority paths with registry generation rekeys. The
 * caller invokes this before completing the one-time marker; every exact
 * replacement is idempotent, so a partial external-store retry is safe. */
export function rekeyOrchestratorSeatPaths(rekeys: readonly IdentityWavePathRekey[]): void {
  if (rekeys.length === 0) return;
  withAccountMutationLock(() => {
    const evidence = readOrchestratorSeatMigrationEvidence();
    if (!evidence.raw || Object.keys(evidence.normalized.seats).length === 0) return;
    const replacements = new Map(rekeys.map((rekey) => [rekey.legacyPath, rekey.sharedPath]));
    const seats = recordEvidence(evidence.raw.seats, "seats");
    let changed = false;
    for (const candidate of Object.values(seats)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const row = candidate as Record<string, unknown>;
      if (typeof row.path !== "string") continue;
      const replacement = replacements.get(row.path);
      if (!replacement) continue;
      row.path = replacement;
      changed = true;
    }
    if (changed) atomicWriteJson(seatsFile(), evidence.raw);
  });
}

/** Every durable revocation, for the authority resolver's ABA guard. */
export function orchestratorRevocations(): OrchestratorRevocation[] {
  return readOrchestratorSeatFile().revocations;
}

/**
 * Conversations whose orchestrator authority has been revoked, or null when the
 * durable store could not be established.
 *
 * The same ABA guard {@link authorizedManagerSeats} denies authority with,
 * asked the other way round: a conversation is revoked while its newest
 * revocation stands at or above every epoch a live or pending seat still names
 * it at, and a deliberate re-designation mints a strictly newer epoch that
 * lifts it again.
 *
 * Automatic host retirement (#1245) is the caller. Rotation is authority-only
 * by design, so the predecessor keeps its host, its tools and — if it schedules
 * itself — its clock; the retirement sweep is the thing that ends it, and this
 * is the fact that tells the sweep a busy-looking host is a seat nobody seated.
 * Null rather than an empty set for the same reason
 * {@link activeOrchestratorSeatsOrUnknown} exists: silence here would read as
 * "revoked by nobody", which is the answer that keeps a rotated-away
 * orchestrator alive.
 *
 * `resolveAlias` is the seam {@link authorizedManagerSeats} takes from its
 * sources, needed here for the same reason and on both sides of the join: an
 * identity migration rewrites the id a live host answers to while this file
 * keeps the id each row was written with, so an unresolved comparison reads a
 * revoked seat as never revoked — and, from the other direction, a
 * re-designated one as still revoked. It defaults to identity so the durable
 * store stays readable with no registry at all.
 */
export function revokedOrchestratorSeatConversationsOrUnknown(
  resolveAlias: (conversationId: string) => string = (conversationId) => conversationId,
): ReadonlySet<string> | null {
  const file = readOrchestratorSeatFileOrNull();
  if (file === null) return null;
  const seatedAt = new Map<string, number>();
  const seatedBy = (seat: OrchestratorSeat): void => {
    if (!seat.conversationId) return;
    const id = resolveAlias(seat.conversationId);
    seatedAt.set(id, Math.max(seatedAt.get(id) ?? 0, seat.seatEpoch));
  };
  for (const seat of Object.values(file.seats)) seatedBy(seat);
  for (const seat of Object.values(file.pending)) {
    /* A pending intent protects its conversation while it is still in flight —
       retiring the host mid-designation would kill the seat the operator is in
       the middle of creating. A TERMINAL error ends that protection at the
       error, not at some later event: the row keeps its pending position until
       the next `beginOrchestratorSeatIntent` for the project moves it to
       history, and that call may never come. Reading a designation that failed
       as one that seats somebody is what leaves a predecessor's revocation
       masked, and its host running, for as long as nobody designates again. */
    if (seat.intent.error !== null) continue;
    seatedBy(seat);
  }
  const revoked = new Set<string>();
  for (const revocation of file.revocations) {
    const id = resolveAlias(revocation.conversationId);
    if (revocation.seatEpoch >= (seatedAt.get(id) ?? 0)) revoked.add(id);
  }
  return revoked;
}
