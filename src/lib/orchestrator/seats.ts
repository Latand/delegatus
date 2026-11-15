import { workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";
import { TeamError } from "@/lib/team/members";
import { MeasuredCache } from "@/lib/cacheTelemetry";
import { reportHeaderName } from "@/lib/projects/settings";
import { notifySeatChannel } from "./seatChannelSignal";
import { captureSeatAuthCredentialBaseline, seatAuthCredentialStamp, type SeatAuthCredentialBaseline } from "@/lib/accounts/seatAuthCredentials";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { canonicalProject, projectAliasResolver } from "@/lib/projects/aliases";
import type { IdentityWavePathRekey } from "@/lib/agent/identityWaveMigration";
import type { BoardTask } from "@/lib/tasks/types";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

import {
  cloneOrchestratorRevocation,
  cloneOrchestratorSeat,
  cloneOrchestratorSeatFile,
  cloneOrchestratorSeatTerminalization,
  emptyOrchestratorSeatFile,
  ORCHESTRATOR_SEAT_HISTORY_CAP,
  type OrchestratorRevocation,
  type OrchestratorSeat,
  type OrchestratorSeatFile,
  type OrchestratorSeatIntent,
  type OrchestratorSeatTerminalization,
  type OrchestratorSeatTrigger,
} from "./seatRecords";
import {
  ALL_SEAT_PARTS,
  mutateOrchestratorSeatStore,
  orchestratorSeatStoreSignature,
  readOrchestratorSeatStore,
  readOrchestratorSeatStoreStrict,
  type SeatPart,
  type SeatStoreCommit,
  type SeatStoreMutation,
} from "./seatStore";

export { ORCHESTRATOR_SEATS_SCHEMA_VERSION, ORCHESTRATOR_SEAT_HISTORY_CAP } from "./seatRecords";
export type {
  OrchestratorRevocation,
  OrchestratorSeat,
  OrchestratorSeatIntent,
  OrchestratorSeatTerminalization,
  OrchestratorSeatTrigger,
} from "./seatRecords";

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
 *    writes a durable REVOCATION for the predecessor in the same transaction.
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
 *
 * The record lives in `state.sqlite` (`./seatStore`), one row per seat,
 * revocation, lineage entry, history entry and distinct mandate text. Every
 * reader here asks the store for the parts its question needs and copies what
 * it hands out; every writer changes a private copy under the store's lease.
 */

/** What a stillborn seat's rollback did: the attempt it terminalized, and the
    predecessor — if any survived the check — that holds the project now. */
export interface StillbornSeatRollback {
  terminalized: OrchestratorSeatTerminalization;
  restored: OrchestratorSeat | null;
}

type RecipientRefusal = { status: 409 | 503; error: string; successorConversationId?: string; project?: string; revokedAt?: string; revokedSeatEpoch?: number } | null;

const RECIPIENT_AUTHORITY_CACHE_LIMIT = 8;
const RECIPIENT_AUTHORITY_LOOKUP_ATTEMPTS = 3;
const recipientAuthorityCacheProperty = "__delegatusOrchestratorRecipientAuthorityV3__" as const;
const identityConversationAlias = (id: string): string => id;

interface RecipientAuthorityRecord {
  activeSeatEpoch: number;
  revokedSeatEpoch: number;
  revocationOrder: number;
  successorConversationId?: string;
  project?: string;
  revokedAt?: string;
}
interface RecipientAuthorityIndex {
  activeConversations: Set<string>;
  currentSeats: Map<string, string | null>;
  records: Map<string, RecipientAuthorityRecord>;
  revocationCount: number;
}
interface RecipientAuthorityCache {
  /** Seat store signature → the authority index of that committed state. */
  indexes: Map<string, RecipientAuthorityIndex>;
}

function recipientAuthorityCache(): RecipientAuthorityCache {
  const globalCache = globalThis as typeof globalThis & { [recipientAuthorityCacheProperty]?: RecipientAuthorityCache };
  return globalCache[recipientAuthorityCacheProperty] ??= { indexes: new MeasuredCache("indexes", "orchestrator/seats") };
}

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > RECIPIENT_AUTHORITY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** One durable namespace for named projects and their repository identities. */
export function canonicalOrchestratorProject(project: string): string {
  return canonicalProject(project.trim());
}

function emptyFile(): OrchestratorSeatFile {
  return emptyOrchestratorSeatFile();
}

/** The parts of the record a question needs, shared and read-only; null when
    the durable record could not be established. */
function readSeatParts(parts: readonly SeatPart[]): OrchestratorSeatFile | null {
  return readOrchestratorSeatStore(parts).file;
}

/**
 * The whole record, or null when the durable store could not be ESTABLISHED —
 * a torn or future-schema record, an unreadable database — while an empty
 * record means the store answered and holds nothing. A machine that has never
 * designated an orchestrator has no record at all, and that is a real "no
 * seats".
 *
 * Individual malformed rows are still dropped rather than refused: a row that
 * does not normalize is not evidence of a seat, and the next designation
 * rewrites the record without it. The answer is the caller's own copy.
 */
export function readOrchestratorSeatFileOrNull(): OrchestratorSeatFile | null {
  const file = readSeatParts(ALL_SEAT_PARTS);
  return file ? cloneOrchestratorSeatFile(file) : null;
}

/**
 * A malformed or future-schema record reads as EMPTY, not as an error:
 * authority fails closed on an absent seat, and the next designation rewrites
 * the record — the same recovery shape the legacy record uses. Individual
 * malformed rows are dropped for the same reason.
 */
export function readOrchestratorSeatFile(): OrchestratorSeatFile {
  return readOrchestratorSeatFileOrNull() ?? emptyFile();
}

/** Automatic retirement must retain malformed evidence. The tolerant authority
    reader can drop a damaged row to deny authority, but that cannot prove a
    host seat-free. Reuse the lossless read; any incomplete record defers signals. */
export function readOrchestratorSeatRetirementEvidenceOrNull(): OrchestratorSeatFile | null {
  try {
    return readOrchestratorSeatStoreStrict();
  } catch {
    return null;
  }
}

/** A committed write moves the recipient authority index to the new revision
    without reading the store again, and wakes the seat channel. */
function afterSeatCommit(commit: SeatStoreCommit): void {
  notifySeatChannel(commit.addedRevocations);
  const cache = recipientAuthorityCache();
  const previousIndex = commit.previousSignature ? cache.indexes.get(commit.previousSignature) : undefined;
  const incremental = previousIndex && commit.previous
    && previousIndex.revocationCount === commit.previous.revocations.length
    && commit.file.revocations.length >= previousIndex.revocationCount;
  const rows = Object.keys(commit.file.seats).length + Object.keys(commit.file.pending).length
    + commit.file.revocations.length - (incremental ? previousIndex.revocationCount : 0);
  const index = withViewerOperation("orchestrator.recipient-authority", () => performanceSpans.sync("orchestrator.seat-index", () => incremental
    ? updateRecipientAuthorityIndexAfterWrite(previousIndex, commit.previous, commit.file)
    : recipientAuthorityIndexIn(commit.file), rows));
  rememberBounded(cache.indexes, commit.signature, index);
}

/** One serialized read-modify-write of the record, under the store's lease. */
function mutateSeats<R>(operation: (file: OrchestratorSeatFile) => SeatStoreMutation<R>): R {
  return mutateOrchestratorSeatStore(operation, afterSeatCommit);
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

/** Preserve the seat that canonical-key collapse would otherwise displace.
    Called under the mutation lock before the project alias is published, so
    subsequent canonical reads see one active seat and the former one in the
    ordinary previous-seat history. */
export function reconcileOrchestratorSeatSuccession(sourceInput: string, targetInput: string, revokedAt: string): boolean {
  return withAccountMutationLock(() => {
    /* Validate every strict migration field first, then retain fields such as
       provisional rollback custody that the strict retirement projection does
       not expose. Both reads are under the mutation lock. */
    readOrchestratorSeatStoreStrict();
    return mutateSeats((file) => {
    const source = canonicalOrchestratorProject(sourceInput);
    const target = canonicalOrchestratorProject(targetInput);
    if (source === target) return { write: false, result: true };
    const sourceSeat = file.seats[source];
    const targetSeat = file.seats[target];
    let changed = false;
    if (sourceSeat || targetSeat) {
      const winner = sourceSeat && targetSeat
        ? (sourceSeat.seatEpoch > targetSeat.seatEpoch ? sourceSeat : targetSeat)
        : sourceSeat ?? targetSeat!;
      const displaced = sourceSeat && targetSeat
        ? (winner === sourceSeat ? targetSeat : sourceSeat)
        : null;
      const rollback = winner === sourceSeat ? file.rollbacks[source] : file.rollbacks[target];
      file.seats[target] = { ...winner, project: target };
      delete file.seats[source];
      if (rollback) file.rollbacks[target] = { ...rollback, project: target };
      else delete file.rollbacks[target];
      delete file.rollbacks[source];
      if ((sourceSeat && sourceSeat.project !== target) || (targetSeat && targetSeat.project !== target)) changed = true;
      if (displaced?.conversationId && winner.conversationId && displaced.conversationId !== winner.conversationId
        && !file.revocations.some(row => row.project === target
          && row.conversationId === displaced.conversationId && row.seatEpoch === displaced.seatEpoch)) {
        file.revocations.push({
          project: target,
          conversationId: displaced.conversationId,
          seatEpoch: displaced.seatEpoch,
          revokedAt,
          successorConversationId: winner.conversationId,
          triggeredBy: winner.triggeredBy ?? null,
          activatedAt: displaced.activatedAt,
          path: displaced.path,
          engine: displaced.engine ?? null,
        });
        changed = true;
      }
    }

    const sourcePending = file.pending[source];
    const targetPending = file.pending[target];
    if (sourcePending || targetPending) {
      const winner = sourcePending && targetPending
        ? (sourcePending.seatEpoch > targetPending.seatEpoch ? sourcePending : targetPending)
        : sourcePending ?? targetPending!;
      const displaced = sourcePending && targetPending
        ? (winner === sourcePending ? targetPending : sourcePending)
        : null;
      file.pending[target] = { ...winner, project: target };
      delete file.pending[source];
      if ((sourcePending && sourcePending.project !== target) || (targetPending && targetPending.project !== target)) changed = true;
      if (displaced) {
        const alreadyRecorded = file.history.some(entry => entry.reason === "superseded_epoch"
          && entry.seat.project === target
          && entry.seat.seatEpoch === displaced.seatEpoch
          && entry.seat.intent.clientRequestId === displaced.intent.clientRequestId
          && entry.seat.conversationId === displaced.conversationId);
        if (!alreadyRecorded) {
          recordTerminalization(file, {
            seat: { ...displaced, project: target },
            reason: "superseded_epoch",
            terminalizedAt: revokedAt,
          });
          changed = true;
        }
      }
    }

    if (file.seatLineage) {
      const remapped = file.seatLineage.map(entry => entry.project === source ? { ...entry, project: target } : entry);
      const deduplicated = [...new Map(remapped.map(entry => [`${entry.project}\0${entry.conversationId}\0${entry.seatEpoch}`, entry])).values()];
      if (JSON.stringify(file.seatLineage) !== JSON.stringify(deduplicated)) changed = true;
      file.seatLineage = deduplicated;
    }

    return { write: changed, result: true };
    });
  }, { holder: "project succession seat reconciliation" });
}

/** The active seat, any pending intent, and the terminalized-intent history
    for one project (oldest first). */
export function orchestratorSeatFor(project: string): {
  active: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  history: OrchestratorSeatTerminalization[];
} {
  /* The hot read: the project's slots and the history, never the revocations
     or the lineage, and copies of only what it returns. */
  const { active, pending, history } = orchestratorSeatIn(readSeatParts(["slots", "history"]), project);
  return {
    active: active ? cloneOrchestratorSeat(active) : null,
    pending: pending ? cloneOrchestratorSeat(pending) : null,
    history: history.map(cloneOrchestratorSeatTerminalization),
  };
}

/**
 * The same answer, from a record the caller has ALREADY read.
 *
 * A caller that needs more than one thing out of the record — the status read
 * needs the active seat, the retired ones and the cross-project set — reads it
 * once and derives all three, rather than once per question. An unreadable record (`null`) answers as an empty
 * one, exactly as {@link readOrchestratorSeatFile} does.
 */
export function orchestratorSeatIn(file: OrchestratorSeatFile | null, project: string): {
  active: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  history: OrchestratorSeatTerminalization[];
} {
  const record = file ?? emptyFile();
  const canonical = canonicalOrchestratorProject(project);
  return {
    active: record.seats[canonical] ?? null,
    pending: record.pending[canonical] ?? null,
    history: record.history.filter((entry) => entry.seat.project === canonical),
  };
}

/**
 * Whether an orchestrator ever held this project (#2170): it holds it now, or
 * a seat that held it was revoked since. A designation that never took — no
 * record at all, or a stillborn seat rolled back into `history` as a terminal
 * error — is not a seat the operator had, so its absence is nothing to report.
 * An unreadable record answers true: it cannot show the project never had one.
 */
export function orchestratorSeatEverHeld(project: string): boolean {
  return orchestratorSeatEverHeldIn(readSeatParts(["slots", "revocations", "history"]), project);
}

export function orchestratorSeatEverHeldIn(file: OrchestratorSeatFile | null, project: string): boolean {
  if (!file) return true;
  const canonical = canonicalOrchestratorProject(project);
  if (file.seats[canonical]) return true;
  const stillborn = stillbornSeatKeys(file, canonical);
  return file.revocations.some((revocation) => revocation.project === canonical
    && !stillborn.has(`${revocation.conversationId}\0${revocation.seatEpoch}`));
}

/** Seats a stillborn designation rolled back into `history`; one project's, or every project's. */
function stillbornSeatKeys(file: OrchestratorSeatFile, project?: string): Set<string> {
  return new Set(file.history
    .filter((entry) => (project === undefined || entry.seat.project === project) && entry.reason === "terminal_error")
    .map((entry) => `${entry.seat.conversationId}\0${entry.seat.seatEpoch}`));
}

/**
 * Whether the installation has ever had an orchestrator in any project: an
 * active seat, or a seat that was revoked since. Stillborn designations are not
 * seats the operator had. An unreadable record answers true, as above.
 */
export function orchestratorInstallationEverHeld(file: OrchestratorSeatFile | null): boolean {
  if (!file) return true;
  if (Object.keys(file.seats).length > 0) return true;
  const stillborn = stillbornSeatKeys(file);
  return file.revocations.some((revocation) => !stillborn.has(`${revocation.conversationId}\0${revocation.seatEpoch}`));
}

/** How many previous seats a project's status read carries. */
export const PREVIOUS_SEATS_LIMIT = 20;

/** A seat that held the project and was revoked, as the board lists it (#1841). */
export interface PreviousOrchestratorSeat {
  conversationId: string;
  path: string | null;
  engine: string | null;
  /** When it took the project; null on a revocation written before that was
      recorded. */
  heldFrom: string | null;
  /** When it was revoked. */
  heldTo: string;
}

/**
 * The seats that held a project before its current one, newest revocation
 * first, at most `limit`. A conversation revoked more than once (a stillborn
 * successor's rollback restores it, a later rotation ends it again) is listed
 * once, at its newest revocation, and the conversation holding the seat now is
 * never listed.
 */
export function previousOrchestratorSeats(project: string, limit = PREVIOUS_SEATS_LIMIT): PreviousOrchestratorSeat[] {
  return previousOrchestratorSeatsIn(readSeatParts(["slots", "revocations"]), project, limit);
}

/** The same list, from a record the caller has already read: see
    {@link orchestratorSeatIn}. */
export function previousOrchestratorSeatsIn(
  file: OrchestratorSeatFile | null,
  project: string,
  limit = PREVIOUS_SEATS_LIMIT,
): PreviousOrchestratorSeat[] {
  const record = file ?? emptyFile();
  const canonical = canonicalOrchestratorProject(project);
  const current = record.seats[canonical]?.conversationId ?? null;
  const seen = new Set<string>();
  const out: PreviousOrchestratorSeat[] = [];
  const ordered = record.revocations
    .map((revocation, index) => ({ revocation, index }))
    .filter(({ revocation }) => revocation.project === canonical)
    .sort((a, b) => b.revocation.revokedAt.localeCompare(a.revocation.revokedAt) || b.index - a.index);
  for (const { revocation } of ordered) {
    if (out.length >= limit) break;
    if (revocation.conversationId === current || seen.has(revocation.conversationId)) continue;
    seen.add(revocation.conversationId);
    out.push({
      conversationId: revocation.conversationId,
      path: revocation.path ?? null,
      engine: revocation.engine ?? null,
      heldFrom: revocation.activatedAt ?? null,
      heldTo: revocation.revokedAt,
    });
  }
  return out;
}

/** Every conversation a seat record names, across EVERY project (#1841), split
    into the seats held now (active or pending) and the seats retired. */
export interface SeatConversations {
  conversationIds: string[];
  paths: string[];
  previous: { conversationIds: string[]; paths: string[] };
  /** The seats' deputies (docs/design/ghost-seat.md §5), when the reader added them. */
  deputies?: { conversationIds: string[]; paths: string[] };
}

/**
 * Every conversation any project's seat record names (#1841), from one read of
 * the record.
 *
 * The per-project answer above is what a board needs; a surface that spans
 * projects — the Overview's board — needs
 * this one, because a seat of ANOTHER project is just as much a seat and has
 * just as little to do with a task list. Read once rather than per project:
 * asking the store once per project would repeat the same read for the same
 * answer.
 *
 * Null when the record cannot be read. A surface that hides rows on this
 * answer hides nothing without it, which is why «unreadable» has to be
 * distinguishable from «no seats anywhere».
 */
export function allSeatConversations(): SeatConversations | null {
  return allSeatConversationsIn(readSeatParts(["slots", "revocations", "history"]));
}

/** The same set, from a record the caller has already read: see
    {@link orchestratorSeatIn}. Null in, null out — a record that could not be
    read names no conversations and hides no rows. */
export function allSeatConversationsIn(file: OrchestratorSeatFile | null): SeatConversations | null {
  if (file === null) return null;
  const held = { conversationIds: new Set<string>(), paths: new Set<string>() };
  for (const seat of [...Object.values(file.seats), ...Object.values(file.pending)]) {
    if (seat.conversationId) held.conversationIds.add(seat.conversationId);
    if (seat.path) held.paths.add(seat.path);
  }
  const previous = { conversationIds: new Set<string>(), paths: new Set<string>() };
  for (const revocation of file.revocations) {
    previous.conversationIds.add(revocation.conversationId);
    if (revocation.path) previous.paths.add(revocation.path);
  }
  /* A pending intent can name an existing conversation. If identity
     succession displaces that intent, its terminalization is the durable
     record that keeps the conversation out of cleanup after the alias lands. */
  for (const entry of file.history) {
    if (entry.reason !== "superseded_epoch") continue;
    const seat = entry.seat;
    if (seat.conversationId) previous.conversationIds.add(seat.conversationId);
    if (seat.path) previous.paths.add(seat.path);
  }
  return {
    conversationIds: [...held.conversationIds],
    paths: [...held.paths],
    previous: { conversationIds: [...previous.conversationIds], paths: [...previous.paths] },
  };
}

/** A seat's notes task as the status read reports it (#1841): every surface,
    including the ones that carry no task list, can name the seat and decide
    whether to offer its notes without reading the store itself. */
export interface SeatNotesTask {
  taskId: string;
  title: string | null;
  /** Whether the task carries notes at all. A seat with none draws no Notes
      control, so this has to be answered here rather than guessed by a surface
      that cannot see the task. */
  hasNotes: boolean;
}

/**
 * The task a seat conversation is assigned to, by conversation id or path: the
 * one seat launch minted, where the seat keeps its notes (`details`). The
 * newest such task wins when more than one names it. Pure: the caller hands in
 * the project's tasks.
 */
export function seatTaskOf(
  tasks: readonly Pick<BoardTask, "id" | "project" | "text" | "details" | "updatedAt" | "assignments" | "origin">[],
  project: string,
  seat: { conversationId: string | null; path: string | null },
): SeatNotesTask | null {
  return seatTaskLookup(tasks, project)(seat);
}

/** One task/alias pass for the current seat and every retired seat in a poll. */
export function seatTaskLookup(
  tasks: readonly Pick<BoardTask, "id" | "project" | "text" | "details" | "updatedAt" | "assignments" | "origin">[],
  project: string,
): (seat: { conversationId: string | null; path: string | null }) => SeatNotesTask | null {
  const resolve = projectAliasResolver();
  const canonical = resolve(project.trim());
  type Match = { task: (typeof tasks)[number]; order: number };
  const byConversation = new Map<string, Match>();
  const byPath = new Map<string, Match>();
  const newer = (left: Match | undefined, right: Match | undefined): Match | undefined => {
    if (!left) return right;
    if (!right) return left;
    if (left.task.updatedAt !== right.task.updatedAt) return left.task.updatedAt > right.task.updatedAt ? left : right;
    return left.order < right.order ? left : right;
  };
  tasks.forEach((task, order) => {
    if (task.project !== project && task.project !== canonical && resolve(task.project.trim()) !== canonical) return;
    const match = { task, order };
    for (const assignment of task.assignments) {
      if (assignment.conversationId != null) byConversation.set(assignment.conversationId, newer(byConversation.get(assignment.conversationId), match)!);
      if (assignment.path != null) byPath.set(assignment.path, newer(byPath.get(assignment.path), match)!);
    }
  });
  return (seat) => {
    const best = newer(seat.conversationId === null ? undefined : byConversation.get(seat.conversationId),
      seat.path === null ? undefined : byPath.get(seat.path))?.task;
    if (!best) return null;
    const title = best.origin?.refinement === "pending" ? "" : best.text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return { taskId: best.id, title: title || null, hasNotes: Boolean(best.details?.trim()) };
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

/** `replayOnly` was set and this key holds no live pending or completed
    intent: nothing was written. */
export type NotReplayedSeatIntent = { kind: "not_replayed" };

export interface BeginSeatIntentInput {
  workspace?: import("@/lib/team/workspacePrincipal").WorkspacePrincipal;
  /** See `OrchestratorSeat.workspaceFromMessage`. */
  workspaceFromMessage?: boolean;
  project: string;
  mandate: string;
  /** The role table this intent's delivery carries; see `OrchestratorSeat.roleTable`. */
  roleTable?: string | null;
  clientRequestId: string;
  mode: "spawn" | "existing";
  conversationId?: string | null;
  engine?: string | null;
  model?: string | null;
  telegramGrant?: boolean;
  /** Ask for the first-run instruction. Granted only when the seat record, read
      under the lock this intent begins in, shows no seat in any project, ever,
      and no other intent in flight; otherwise the record carries no `firstRun`. */
  firstRun?: boolean;
  automaticReplacement?: OrchestratorSeatIntent["automaticReplacement"];
  promptVersion?: number | null;
  /** Who triggered this designation, resolved from the request by the caller —
      never read off a caller-supplied body, so attribution cannot be dictated. */
  triggeredBy?: OrchestratorSeatTrigger | null;
  /** Finish this key's own intent only: a mandate that failed preflight may
      still replay what its first attempt admitted, and never begins anew. */
  replayOnly?: boolean;
  now?: string;
}

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
export function beginOrchestratorSeatIntent(input: BeginSeatIntentInput & { replayOnly?: false }): BeginSeatIntentResult;
export function beginOrchestratorSeatIntent(input: BeginSeatIntentInput): BeginSeatIntentResult | NotReplayedSeatIntent;
export function beginOrchestratorSeatIntent(input: BeginSeatIntentInput): BeginSeatIntentResult | NotReplayedSeatIntent {
  return withAccountMutationLock(() => {
    if (input.workspace && !workspacePrincipalAllows(input.workspace, input.project)) throw new TeamError("workspace_forbidden", "workspace access denied", 403);
    return mutateSeats<BeginSeatIntentResult | NotReplayedSeatIntent>((file) => {
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (active && active.intent.clientRequestId === input.clientRequestId) {
      return { write: false, result: { kind: "completed", seat: active } };
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
      return { write: false, result: { kind: "replay", seat: pending } };
    }
    let terminalized: OrchestratorSeatTerminalization | undefined;
    if (pending) {
      const abandoned = pending.intent.error !== null || (active !== undefined && pending.seatEpoch < active.seatEpoch);
      if (!abandoned) return { write: false, result: { kind: "in_progress", seat: pending } };
    }
    if (input.replayOnly) return { write: false, result: { kind: "not_replayed" } };
    if (pending) {
      terminalized = recordTerminalization(file, {
        seat: pending,
        reason: pending.intent.error !== null ? "terminal_error" : "superseded_epoch",
        terminalizedAt: input.now ?? new Date().toISOString(),
      });
      delete file.pending[project];
    }
    /* Decided here, under the lock: two first assignments racing in different
       projects cannot both be the first, and a record that cannot be read
       proves nothing, so it grants nothing. */
    const firstRun = input.firstRun === true
      && !Object.values(file.pending).some((other) => other.intent.error === null)
      && !orchestratorInstallationEverHeld(readSeatParts(["slots", "revocations", "history"]));
    const seat: OrchestratorSeat = {
      ...(input.workspace ? { workspace: { memberId: input.workspace.memberId, workspaceId: input.workspace.workspaceId } } : {}),
      ...(input.workspace ? { workspaceFromMessage: input.workspaceFromMessage === true } : {}),
      project,
      seatEpoch: file.nextSeatEpoch,
      conversationId: input.conversationId ?? null,
      path: null,
      engine: input.engine?.trim() || null,
      model: input.model?.trim() || null,
      runtimeIdentityFrozen: Boolean(input.engine?.trim() && input.model?.trim()),
      ...(typeof input.telegramGrant === "boolean" ? { telegramGrant: input.telegramGrant } : {}),
      ...(firstRun ? { firstRun: true as const } : {}),
      mandate: input.mandate,
      ...(typeof input.roleTable === "string" ? { roleTable: input.roleTable } : {}),
      promptVersion: input.promptVersion ?? null,
      predecessorConversationId: null,
      triggeredBy: input.triggeredBy ?? null,
      state: "pending",
      intent: { clientRequestId: input.clientRequestId, mode: input.mode, launchId: null, error: null,
        ...(input.automaticReplacement ? { automaticReplacement: { ...input.automaticReplacement } } : {}) },
      designatedAt: input.now ?? new Date().toISOString(),
      activatedAt: null,
    };
    file.nextSeatEpoch += 1;
    file.pending[project] = seat;
    return { write: true, result: { kind: "begun", seat, ...(terminalized ? { terminalized } : {}) } };
    });
  });
}

/** Discover credentials before spawn admission; return only its short commit. */
export function prepareOrchestratorSeatAuthCredentialBaseline(projectInput: string, clientRequestId: string, seatEpoch: number, engine: string, accountId: string): () => void {
  if (engine !== "claude" && engine !== "codex") return () => {};
  const scope = `seat-auth-baseline:${canonicalOrchestratorProject(projectInput)}:${seatEpoch}`;
  const stamp = seatAuthCredentialStamp(engine, accountId, scope);
  return () => withAccountMutationLock(() => mutateSeats((file) => {
    const project = canonicalOrchestratorProject(projectInput);
    const pending = file.pending[project];
    if (!pending || pending.intent.clientRequestId !== clientRequestId || pending.seatEpoch !== seatEpoch) throw new Error("seat intent changed before credential admission");
    if (!stamp) return { write: false, result: undefined };
    pending.authCredentialBaseline = { engine, accountId, stamp, scope };
    return { write: true, result: undefined };
  }));
}

/** Freeze the actual account's contents before a new seat launch is admitted. */
export function recordOrchestratorSeatAuthCredentialBaseline(projectInput: string, clientRequestId: string, seatEpoch: number, engine: string, accountId: string): void {
  prepareOrchestratorSeatAuthCredentialBaseline(projectInput, clientRequestId, seatEpoch, engine, accountId)();
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
  preparedAuthCredentialBaseline?: SeatAuthCredentialBaseline | null;
}): CompleteSeatIntentResult {
  const observed = orchestratorSeatFor(input.project).pending;
  const baseline = observed && !observed.authCredentialBaseline
    ? input.preparedAuthCredentialBaseline !== undefined ? input.preparedAuthCredentialBaseline ?? undefined
      : captureSeatAuthCredentialBaseline(observed.engine ?? input.engine, input.path, `seat-auth-baseline:${canonicalOrchestratorProject(input.project)}:${observed.seatEpoch}`)
    : undefined;
  return withAccountMutationLock(() => mutateSeats<CompleteSeatIntentResult>((file) => {
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (active && active.intent.clientRequestId === input.clientRequestId) {
      return { write: false, result: { kind: "replay", seat: active } };
    }
    const pending = file.pending[project];
    if (!pending || pending.seatEpoch !== observed?.seatEpoch || pending.intent.clientRequestId !== input.clientRequestId) return { write: false, result: { kind: "missing" } };
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
        activatedAt: active.activatedAt,
        path: active.path,
        engine: active.engine ?? null,
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
      authCredentialBaseline: pending.authCredentialBaseline ?? baseline,
    };
    delete file.pending[project];
    file.seats[project] = seat;
    return { write: true, result: { kind: "activated", seat, revoked } };
  }));
}

/** Fill runtime metadata on active seats created before engine/model became
 * durable seat fields. Existing values remain authoritative. */
export function repairOrchestratorSeatRuntimeIdentity(input: {
  project: string;
  conversationId: string;
  engine?: string | null;
  model?: string | null;
}): OrchestratorSeat | null {
  return withAccountMutationLock(() => mutateSeats<OrchestratorSeat | null>((file) => {
    const project = canonicalOrchestratorProject(input.project);
    const seat = file.seats[project];
    if (!seat || seat.conversationId !== input.conversationId) return { write: false, result: null };
    const engine = seat.engine ?? (input.engine?.trim() || null);
    const model = seat.model ?? (input.model?.trim() || null);
    if (engine === seat.engine && model === seat.model) return { write: false, result: seat };
    const repaired = { ...seat, engine, model };
    file.seats[project] = repaired;
    return { write: true, result: repaired };
  }));
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
  return withAccountMutationLock(() => mutateSeats<OrchestratorSeatTerminalization | null>((file) => {
    const canonical = canonicalOrchestratorProject(project);
    const pending = file.pending[canonical];
    if (!pending || pending.intent.clientRequestId !== clientRequestId) return { write: false, result: null };
    pending.intent.error = error.slice(0, 500);
    const terminalized = recordTerminalization(file, {
      seat: pending,
      reason: "terminal_error",
      terminalizedAt: now ?? new Date().toISOString(),
    });
    delete file.pending[canonical];
    return { write: true, result: terminalized };
  }));
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
  const observed = cloneOrchestratorSeatFile(readSeatParts(["slots", "revocations"]) ?? emptyFile());
  const file = observed;
  const project = canonicalOrchestratorProject(input.project);
  const active = file.seats[project];
  if (!active || active.intent.clientRequestId !== input.clientRequestId) return null;
  if (active.state !== "active" || active.intent.mode !== "spawn" || active.path !== null) return null;
  if (!active.conversationId) return null;

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
  return withAccountMutationLock(() => mutateSeats<StillbornSeatRollback | null>((file) => {
    if (JSON.stringify([file.seats[project], file.rollbacks[project], file.revocations]) !== JSON.stringify([observed.seats[project], observed.rollbacks[project], observed.revocations])) return { write: false, result: null };
    const now = input.now ?? new Date().toISOString();
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
      conversationId: active.conversationId!,
      seatEpoch: active.seatEpoch,
      revokedAt: now,
      successorConversationId: restored?.conversationId ?? null,
      triggeredBy: active.triggeredBy ?? null,
      activatedAt: active.activatedAt,
      path: active.path,
      engine: active.engine ?? null,
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
    return { write: true, result: { terminalized, restored } };
  }));
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
  const observed = orchestratorSeatFor(input.project).active;
  const baseline = observed && !observed.authCredentialBaseline
    ? captureSeatAuthCredentialBaseline(observed.engine, input.path, `seat-auth-baseline:${canonicalOrchestratorProject(input.project)}:${observed.seatEpoch}`) : undefined;
  return withAccountMutationLock(() => mutateSeats<OrchestratorSeat | null>((file) => {
    const project = canonicalOrchestratorProject(input.project);
    const active = file.seats[project];
    if (!active || JSON.stringify(active) !== JSON.stringify(observed) || active.intent.clientRequestId !== input.clientRequestId) return { write: false, result: null };
    if (active.conversationId !== input.conversationId) return { write: false, result: null };
    if (active.path === input.path && !file.rollbacks[project]) return { write: false, result: active };
    const confirmed: OrchestratorSeat = { ...active, path: input.path,
      authCredentialBaseline: active.authCredentialBaseline ?? baseline };
    file.seats[project] = confirmed;
    delete file.rollbacks[project];
    return { write: true, result: confirmed };
  }));
}

/** Every active seat, for the authority resolver. */
export function activeOrchestratorSeats(): OrchestratorSeat[] {
  return Object.values(readSeatParts(["slots"])?.seats ?? {}).map(cloneOrchestratorSeat);
}

/** The durable designation that identifies a writer, regardless of the
    project the writer is editing or whether its seat has since been revoked. */
export function orchestratorSeatIdentityForConversation(conversationId: string): { project: string; seatEpoch: number } | null {
  const file = readSeatParts(["slots", "revocations"]) ?? emptyFile();
  const active = Object.values(file.seats).filter((seat) => seat.conversationId === conversationId);
  const historical = active.length === 0
    ? file.revocations.filter((seat) => seat.conversationId === conversationId)
    : [];
  const candidates = active.length > 0 ? active : historical;
  candidates.sort((left, right) => right.seatEpoch - left.seatEpoch || left.project.localeCompare(right.project));
  const match = candidates[0];
  return match ? { project: canonicalOrchestratorProject(match.project), seatEpoch: match.seatEpoch } : null;
}

/**
 * Every active seat, or null when the durable store could not be established.
 *
 * {@link activeOrchestratorSeats} is fail-closed for AUTHORITY: an unreadable
 * record means nobody can prove a seat, so nobody is granted one. Automatic host
 * retirement (#747) asks the same question with the opposite consequence — a
 * silent "no seats" would clear a live orchestrator for the kill, and an
 * orchestrator is exactly the host that sits quiet for hours between operator
 * messages. So it reads this one and refuses on null.
 */
export function activeOrchestratorSeatsOrUnknown(): OrchestratorSeat[] | null {
  const file = readSeatParts(["slots"]);
  return file === null ? null : Object.values(file.seats).map(cloneOrchestratorSeat);
}

/** The request key authentication recovery rotates under
    (`seatAuthRotationKey`). That rotation records no other durable mark. */
const AUTH_RECOVERY_ROTATION_KEY = /^seat-auth-[0-9a-f]{64}$/;

/** A record written before the field existed cannot say where its binding came
    from. A rotation an agent or the seat tick triggered only ever copied the
    reach of the conversation behind it, and that copy is how a member's message
    became a permanent binding. Such a record is read as message authority: it
    stays fenced until a person writes to the seat, and then that person
    decides. Only durable marks of such a rotation count: an agent trigger, the
    automatic-replacement fence, or the authentication recovery key. A person's
    designation carries none of them, also when it replaced an incumbent. */
export function seatWorkspaceFromMessage(seat: Pick<OrchestratorSeat, "workspace" | "workspaceFromMessage" | "triggeredBy" | "intent">): boolean {
  if (!seat.workspace) return false;
  return seat.workspaceFromMessage ?? (seat.triggeredBy?.kind === "agent" || Boolean(seat.intent.automaticReplacement)
    || AUTH_RECOVERY_ROTATION_KEY.test(seat.intent.clientRequestId));
}

/** What a designation recorded about one seat conversation's workspace reach. */
export interface SeatWorkspaceBinding {
  workspace: OrchestratorSeat["workspace"];
  fromMessage: boolean;
}

// One map per process, keyed by the seat store's committed revision: peer
// writes and revocations take effect on the next call without a polling
// interval, and an unchanged record reads no row.
let workspacePrincipalsCache: {
  signature: string; principals: ReadonlyMap<string | null, SeatWorkspaceBinding>;
} | undefined;

export function orchestratorWorkspacePrincipalsOrUnknown(): ReadonlyMap<string | null, SeatWorkspaceBinding> | null {
  const signature = orchestratorSeatStoreSignature();
  if (signature === null) { workspacePrincipalsCache = undefined; return null; }
  if (workspacePrincipalsCache?.signature === signature) return workspacePrincipalsCache.principals;
  const read = readOrchestratorSeatStore(["slots"]);
  const principals = read.file === null ? null : new Map(Object.values(read.file.seats).map(seat => [seat.conversationId,
    { workspace: seat.workspace ? { ...seat.workspace } : undefined, fromMessage: seatWorkspaceFromMessage(seat) }]));
  workspacePrincipalsCache = principals === null || read.signature === null ? undefined : { signature: read.signature, principals };
  return principals;
}

/**
 * One project's active and pending seats, or null when the durable store could
 * not be established (a torn or future-schema record, an unreadable store). A
 * store that holds no record is a store with no seats.
 *
 * The per-project sibling of {@link activeOrchestratorSeatsOrUnknown}, for a
 * refusal that must not fail open: a task group hide (#1695) is refused for the
 * task holding the seat conversation, and "the record said nothing" is not
 * evidence that the task holds none. {@link orchestratorSeatFor} keeps its
 * fail-closed-for-authority reading.
 */
export function orchestratorSeatForOrUnknown(project: string): { active: OrchestratorSeat | null; pending: OrchestratorSeat | null } | null {
  const file = readSeatParts(["slots"]);
  if (file === null) return null;
  const canonical = canonicalOrchestratorProject(project);
  const active = file.seats[canonical];
  const pending = file.pending[canonical];
  return { active: active ? cloneOrchestratorSeat(active) : null, pending: pending ? cloneOrchestratorSeat(pending) : null };
}

/** Active-seat evidence for the one-time identity migration. A missing store
 * is valid before any designation; unreadable or malformed durable evidence
 * must keep the migration marker open for a later retry. */
export function activeOrchestratorSeatsForMigration(): OrchestratorSeat[] {
  return Object.values(readOrchestratorSeatStoreStrict().seats);
}

/** Converge the active authority paths with registry generation rekeys. The
 * caller invokes this before completing the one-time marker; every exact
 * replacement is idempotent, so a partial external-store retry is safe. */
export function rekeyOrchestratorSeatPaths(rekeys: readonly IdentityWavePathRekey[]): void {
  if (rekeys.length === 0) return;
  withAccountMutationLock(() => {
    /* Malformed evidence refuses here, before anything is written, so the
       caller keeps its one-time marker open and retries. */
    if (Object.keys(readOrchestratorSeatStoreStrict().seats).length === 0) return;
    const replacements = new Map(rekeys.map((rekey) => [rekey.legacyPath, rekey.sharedPath]));
    mutateSeats((file) => {
      let changed = false;
      for (const seat of Object.values(file.seats)) {
        const replacement = seat.path === null ? undefined : replacements.get(seat.path);
        if (!replacement) continue;
        seat.path = replacement;
        changed = true;
      }
      return { write: changed, result: undefined };
    });
  });
}

/** The committed revocations for the seat tick's owner discovery: the store
    revision says whether they changed, and they are read only when it moved. */
export function orchestratorSeatRevocationSource(): { identity(): string | null; revocations(): readonly OrchestratorRevocation[] | null } {
  return {
    identity: () => orchestratorSeatStoreSignature(),
    revocations: () => readSeatParts(["revocations"])?.revocations ?? null,
  };
}

/** Every durable revocation, for the authority resolver's ABA guard. */
export function orchestratorRevocations(): OrchestratorRevocation[] {
  return (readSeatParts(["revocations"])?.revocations ?? []).map(cloneOrchestratorRevocation);
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
 * identity migration rewrites the id a live host answers to while the record
 * keeps the id each row was written with, so an unresolved comparison reads a
 * revoked seat as never revoked — and, from the other direction, a
 * re-designated one as still revoked. It defaults to identity so the durable
 * store stays readable with no registry at all.
 */
export function revokedOrchestratorSeatConversationsOrUnknown(
  resolveAlias: (conversationId: string) => string = (conversationId) => conversationId,
): ReadonlySet<string> | null {
  const file = readSeatParts(["slots", "revocations"]);
  if (file === null) return null;
  return revokedOrchestratorSeatConversationsIn(file, resolveAlias);
}

function revokedOrchestratorSeatConversationsIn(
  file: OrchestratorSeatFile,
  resolveAlias: (conversationId: string) => string,
): ReadonlySet<string> {
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

/** Test seam: runs at each step of an asynchronous recipient authority
    lookup, so a test can land a rotation between them. */
type RecipientAuthorityLookupStep = "signature" | "index" | "recheck" | "sync";
let recipientAuthorityLookupHook: ((step: RecipientAuthorityLookupStep) => void) | null = null;
export function setRecipientAuthorityLookupHookForTests(hook: ((step: RecipientAuthorityLookupStep) => void) | null): void {
  recipientAuthorityLookupHook = hook;
}

/** Test seam: forget every authority index, so the next lookup builds one. */
export function resetRecipientAuthorityForTests(): void {
  recipientAuthorityCache().indexes.clear();
}

/** Recipient admission follows designation authority while historical
    conversations remain readable; delivery is fenced again at dispatch. */
export function orchestratorRecipientRefusal(
  conversationIds: readonly string[],
  resolveAlias: (conversationId: string) => string = identityConversationAlias,
): RecipientRefusal {
  return withViewerOperation("orchestrator.recipient-authority", () => {
    recipientAuthorityLookupHook?.("sync");
    const signature = orchestratorSeatStoreSignature();
    if (signature === null) return { status: 503, error: "orchestrator seat authority is unavailable" };
    const index = recipientAuthorityCache().indexes.get(signature);
    if (!index) return { status: 503, error: "orchestrator seat authority is not ready" };
    return recipientAuthorityRefusal(index, conversationIds, resolveAlias);
  });
}

/** Affirmative current-seat membership from the already hydrated shared index.
 * Missing or changed authority keeps the original individual-delivery path. */
export function isCurrentOrchestratorSeat(conversationIds: readonly string[]): boolean {
  const signature = orchestratorSeatStoreSignature();
  if (signature === null) return false;
  const index = recipientAuthorityCache().indexes.get(signature);
  return !!index && conversationIds.some(id => index.activeConversations?.has(id))
    && recipientAuthorityRefusal(index, conversationIds, identityConversationAlias) === null;
}

/** Hydrate and index seat authority before a caller reaches synchronous
    admission. Retry revision races here, before any delivery can be reserved
    or dispatched. Stable refusals still return immediately. The sync check
    above reads one revision and one Map key. */
export async function orchestratorRecipientRefusalAsync(
  conversationIds: readonly string[],
  resolveAlias: (conversationId: string) => string = identityConversationAlias,
): Promise<RecipientRefusal> {
  return withViewerOperation("orchestrator.recipient-authority", async () => {
    for (let attempt = 0; attempt < RECIPIENT_AUTHORITY_LOOKUP_ATTEMPTS; attempt++) {
      recipientAuthorityLookupHook?.("signature");
      const signature = orchestratorSeatStoreSignature();
      if (signature === null) return { status: 503, error: "orchestrator seat authority is unavailable" };
      recipientAuthorityLookupHook?.("index");
      const index = recipientAuthorityIndex(signature);
      recipientAuthorityLookupHook?.("recheck");
      const currentSignature = orchestratorSeatStoreSignature();
      if (currentSignature !== null && currentSignature !== signature
        && attempt + 1 < RECIPIENT_AUTHORITY_LOOKUP_ATTEMPTS) continue;
      if (!index) return { status: 503, error: "orchestrator seat authority is unavailable" };
      if (currentSignature !== signature) {
        return { status: 503, error: "orchestrator seat authority changed during lookup" };
      }
      return recipientAuthorityRefusal(index, conversationIds, resolveAlias);
    }
    return { status: 503, error: "orchestrator seat authority changed during lookup" };
  });
}

function recipientAuthorityRefusal(
  index: RecipientAuthorityIndex,
  conversationIds: readonly string[],
  resolveAlias: (conversationId: string) => string,
): RecipientRefusal {
  if (conversationIds.length === 0) return { status: 503, error: "orchestrator seat authority is unavailable" };
  let activeSeatEpoch = 0;
  let latestRevocation: { seatEpoch: number; order: number; successorConversationId?: string; project?: string; revokedAt?: string } | undefined;
  for (const id of conversationIds) {
    const record = index.records.get(id);
    if (!record) continue;
    activeSeatEpoch = Math.max(activeSeatEpoch, record.activeSeatEpoch);
    if (record.revokedSeatEpoch > (latestRevocation?.seatEpoch ?? 0)
      || (record.revokedSeatEpoch > 0 && record.revokedSeatEpoch === latestRevocation?.seatEpoch
        && record.revocationOrder < latestRevocation.order)) {
      latestRevocation = {
        seatEpoch: record.revokedSeatEpoch,
        order: record.revocationOrder,
        project: record.project, revokedAt: record.revokedAt,
        ...(record.successorConversationId ? { successorConversationId: record.successorConversationId } : {}),
      };
    }
  }
  if (!latestRevocation || latestRevocation.seatEpoch < activeSeatEpoch) return null;
  const successor = latestRevocation.project && index.currentSeats.has(latestRevocation.project)
    ? index.currentSeats.get(latestRevocation.project) : latestRevocation.successorConversationId;
  const successorConversationId = successor ? resolveAlias(successor) : undefined;
  return {
    status: 409,
    error: successorConversationId
      ? `This orchestrator was replaced. The current orchestrator of «${latestRevocation.project ? reportHeaderName(latestRevocation.project) : "the project"}» is ${successorConversationId}; send there.`
      : "This orchestrator was replaced; designate a current orchestrator before sending.",
    ...(successorConversationId ? { successorConversationId } : {}),
    project: latestRevocation.project, revokedAt: latestRevocation.revokedAt, revokedSeatEpoch: latestRevocation.seatEpoch,
  };
}

/** The authority index of the committed state `signature` names, built from
    the store's slots and revocations alone. Null when the store moved past
    that state while it was read, or the record could not be established. */
function recipientAuthorityIndex(signature: string): RecipientAuthorityIndex | null {
  const cache = recipientAuthorityCache();
  const cached = cache.indexes.get(signature);
  if (cached) {
    rememberBounded(cache.indexes, signature, cached);
    return cached;
  }
  const read = readOrchestratorSeatStore(["slots", "revocations"]);
  if (read.signature !== signature || !read.file) return null;
  const file = read.file;
  const rows = Object.keys(file.seats).length + Object.keys(file.pending).length + file.revocations.length;
  const index = performanceSpans.sync("orchestrator.seat-index", () => recipientAuthorityIndexIn(file), rows);
  rememberBounded(cache.indexes, signature, index);
  return index;
}

function recipientAuthorityIndexIn(
  file: OrchestratorSeatFile,
): RecipientAuthorityIndex {
  const authority = new Map<string, RecipientAuthorityRecord>();
  const recordFor = (conversationId: string): RecipientAuthorityRecord => {
    let record = authority.get(conversationId);
    if (!record) {
      record = { activeSeatEpoch: 0, revokedSeatEpoch: 0, revocationOrder: Number.MAX_SAFE_INTEGER };
      authority.set(conversationId, record);
    }
    return record;
  };
  const seatedBy = (seat: OrchestratorSeat): void => {
    if (!seat.conversationId) return;
    const record = recordFor(seat.conversationId);
    record.activeSeatEpoch = Math.max(record.activeSeatEpoch, seat.seatEpoch);
  };
  for (const seat of Object.values(file.seats)) seatedBy(seat);
  for (const seat of Object.values(file.pending)) {
    if (seat.intent.error === null) seatedBy(seat);
  }

  for (const [order, revocation] of file.revocations.entries()) {
    const record = recordFor(revocation.conversationId);
    if (record.revokedSeatEpoch >= revocation.seatEpoch) continue;
    const successor = file.seats[revocation.project]?.conversationId ?? revocation.successorConversationId;
    record.revokedSeatEpoch = revocation.seatEpoch;
    record.revocationOrder = order;
    record.project = revocation.project;
    record.revokedAt = revocation.revokedAt;
    delete record.successorConversationId;
    if (successor) record.successorConversationId = successor;
  }
  return { activeConversations: new Set(Object.values(file.seats).filter(seat => seat.state === "active" && seat.conversationId).map(seat => seat.conversationId!)), records: authority, currentSeats: new Map(Object.entries(file.seats).map(([project, seat]) => [project, seat.conversationId])), revocationCount: file.revocations.length };
}

function updateRecipientAuthorityIndexAfterWrite(
  index: RecipientAuthorityIndex,
  previous: OrchestratorSeatFile | null,
  file: OrchestratorSeatFile,
): RecipientAuthorityIndex {
  const activeEpochs = new Map<string, number>();
  const noteActive = (seat: OrchestratorSeat): void => {
    if (!seat.conversationId) return;
    activeEpochs.set(seat.conversationId, Math.max(activeEpochs.get(seat.conversationId) ?? 0, seat.seatEpoch));
  };
  for (const seat of Object.values(file.seats)) noteActive(seat);
  for (const seat of Object.values(file.pending)) if (seat.intent.error === null) noteActive(seat);

  const affected = new Set<string>();
  for (const seat of Object.values(previous?.seats ?? {})) if (seat.conversationId) affected.add(seat.conversationId);
  for (const seat of Object.values(previous?.pending ?? {})) if (seat.conversationId) affected.add(seat.conversationId);
  for (const seat of Object.values(file.seats)) if (seat.conversationId) affected.add(seat.conversationId);
  for (const seat of Object.values(file.pending)) if (seat.conversationId) affected.add(seat.conversationId);
  for (const id of affected) {
    const record = index.records.get(id);
    if (record) record.activeSeatEpoch = activeEpochs.get(id) ?? 0;
    else if (activeEpochs.has(id)) index.records.set(id, {
      activeSeatEpoch: activeEpochs.get(id)!, revokedSeatEpoch: 0, revocationOrder: Number.MAX_SAFE_INTEGER,
    });
  }

  for (let order = index.revocationCount; order < file.revocations.length; order++) {
    const revocation = file.revocations[order]!;
    let record = index.records.get(revocation.conversationId);
    if (!record) {
      record = { activeSeatEpoch: activeEpochs.get(revocation.conversationId) ?? 0,
        revokedSeatEpoch: 0, revocationOrder: Number.MAX_SAFE_INTEGER };
      index.records.set(revocation.conversationId, record);
    }
    if (record.revokedSeatEpoch >= revocation.seatEpoch) continue;
    const successor = file.seats[revocation.project]?.conversationId ?? revocation.successorConversationId;
    record.revokedSeatEpoch = revocation.seatEpoch;
    record.revocationOrder = order;
    record.project = revocation.project;
    record.revokedAt = revocation.revokedAt;
    delete record.successorConversationId;
    if (successor) record.successorConversationId = successor;
  }
  index.activeConversations = new Set(Object.values(file.seats).filter(seat => seat.state === "active" && seat.conversationId).map(seat => seat.conversationId!));
  index.currentSeats = new Map(Object.entries(file.seats).map(([project, seat]) => [project, seat.conversationId]));
  index.revocationCount = file.revocations.length;
  return index;
}
