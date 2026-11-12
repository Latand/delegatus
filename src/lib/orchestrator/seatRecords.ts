import { normalizeSeatAuthCredentialBaseline, type SeatAuthCredentialBaseline } from "@/lib/accounts/seatAuthCredentials";

/* The orchestrator seat record: its types and the rules that read one back.
 *
 * Pure on purpose. The store (`./seatStore`) keeps the record in SQLite and the
 * public API (`./seats`) answers questions about it; both read every row
 * through these normalizers, so a seat means the same thing whether it came
 * from a legacy `orchestrator-seats.json` or from a stored row. Project keys
 * are resolved by the caller's resolver, never here: the alias map lives in
 * another store.
 */

export const ORCHESTRATOR_SEATS_SCHEMA_VERSION = 1;

/** Newest-last bound on terminalized history, so the record cannot grow
    without limit; the oldest entries are trimmed first. */
export const ORCHESTRATOR_SEAT_HISTORY_CAP = 50;

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
  /** Trusted automatic-rotation fence, retained when the launching request dies. */
  automaticReplacement?: { conversationId: string; seatEpoch: number };
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
  workspace?: import("@/lib/team/workspacePrincipal").WorkspacePrincipal;
  /** True: `workspace` came from a member's message to a seat this one
      replaced, and nobody designated this seat for that member. Such a fence is
      message authority: the next person who writes to this seat's conversation
      decides its reach. False: the binding is the designation itself and no
      later message changes it. Absent on records written before the field
      existed; read it through `seatWorkspaceFromMessage`. */
  workspaceFromMessage?: boolean;
  project: string;
  /** Monotonic designation epoch; strictly increases across the whole record. */
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
  /** Content proof for recognizing login before the first authentication check. */
  authCredentialBaseline?: SeatAuthCredentialBaseline;
  /** Connector selection frozen with this spawn intent for idempotent replay. */
  telegramGrant?: boolean;
  /** This is the installation's first seat ever (decided under the store's lock
      when the intent began): its spawn text carries the first-run instruction,
      and a replay delivers the same bytes. The instruction is never part of
      `mandate`, so nothing that rebuilds a mandate can carry it on. */
  firstRun?: true;
  /** The mandate text delivered (active) or to be delivered (pending). */
  mandate: string;
  /** The role table (#1880) rendered from the live registry when this intent
      began. A pending replay delivers it instead of rendering again, so a role
      edited in between cannot change the text its first attempt sent. Absent
      on intents recorded before tables existed. */
  roleTable?: string | null;
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
  /** When the ended seat took the project (#1841), copied from the seat as the
      revocation is written, so the board can say how long it held it. Absent
      on revocations written before this existed. */
  activatedAt?: string | null;
  /** The ended seat's transcript path and engine, copied the same way. */
  path?: string | null;
  engine?: string | null;
}

/** A seat conversation and epoch kept when aliases collapse independent
    project rows onto one canonical key. */
export interface SeatLineageEntry {
  project: string;
  conversationId: string;
  seatEpoch: number;
}

export interface OrchestratorSeatFile {
  schemaVersion: number;
  nextSeatEpoch: number;
  /** Active seat per project. */
  seats: Record<string, OrchestratorSeat>;
  /** Seat conversations and epochs retained when aliases collapse independent
      project rows onto one canonical key. */
  seatLineage?: SeatLineageEntry[];
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

/** Resolves a stored project key to its canonical project. */
export type ProjectResolver = (project: string) => string;

/** The span fields of a stored revocation (#1841), carried only when it has
    them, so a revocation written before they existed reads back unchanged. */
export function seatSpanOf(revocation: Partial<OrchestratorRevocation>): Pick<OrchestratorRevocation, "activatedAt" | "path" | "engine"> {
  const span: Pick<OrchestratorRevocation, "activatedAt" | "path" | "engine"> = {};
  for (const key of ["activatedAt", "path", "engine"] as const) {
    const value = revocation[key];
    if (typeof value === "string" && value) span[key] = value;
  }
  return span;
}

export function emptyOrchestratorSeatFile(): OrchestratorSeatFile {
  return { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, seats: {}, seatLineage: [], pending: {}, revocations: [], history: [], rollbacks: {} };
}

/** A trigger survives the round trip only when it is fully formed; a half-written
    one is dropped, so partial provenance is never reported. */
export function normalizeSeatTrigger(value: unknown): OrchestratorSeatTrigger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trigger = value as Partial<OrchestratorSeatTrigger>;
  if (trigger.kind !== "operator" && trigger.kind !== "agent") return null;
  const conversationId = typeof trigger.conversationId === "string" && trigger.conversationId ? trigger.conversationId : null;
  const seatEpoch = typeof trigger.seatEpoch === "number" && Number.isInteger(trigger.seatEpoch) && trigger.seatEpoch >= 1
    ? trigger.seatEpoch
    : null;
  return { kind: trigger.kind, conversationId, seatEpoch };
}

export function normalizeSeat(value: unknown): OrchestratorSeat | null {
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
    ...(seat.workspace ? { workspace: { memberId: seat.workspace.memberId, workspaceId: seat.workspace.workspaceId } } : {}),
    ...(seat.workspace && typeof seat.workspaceFromMessage === "boolean" ? { workspaceFromMessage: seat.workspaceFromMessage } : {}),
    seatEpoch: seat.seatEpoch,
    conversationId: seat.conversationId ?? null,
    path: seat.path ?? null,
    engine,
    model,
    runtimeIdentityFrozen,
    authCredentialBaseline: normalizeSeatAuthCredentialBaseline(seat.authCredentialBaseline),
    ...(typeof seat.telegramGrant === "boolean" ? { telegramGrant: seat.telegramGrant } : {}),
    ...(seat.firstRun === true ? { firstRun: true as const } : {}),
    mandate: seat.mandate,
    ...(typeof seat.roleTable === "string" ? { roleTable: seat.roleTable } : {}),
    promptVersion: typeof seat.promptVersion === "number" && Number.isInteger(seat.promptVersion) ? seat.promptVersion : null,
    predecessorConversationId: typeof seat.predecessorConversationId === "string" ? seat.predecessorConversationId : null,
    triggeredBy: normalizeSeatTrigger(seat.triggeredBy),
    state: seat.state,
    intent: {
      clientRequestId: intent.clientRequestId,
      mode: intent.mode,
      launchId: typeof intent.launchId === "string" ? intent.launchId : null,
      error: typeof intent.error === "string" ? intent.error : null,
      ...(intent.automaticReplacement && typeof intent.automaticReplacement.conversationId === "string"
        && Number.isSafeInteger(intent.automaticReplacement.seatEpoch) && intent.automaticReplacement.seatEpoch > 0
        ? { automaticReplacement: { conversationId: intent.automaticReplacement.conversationId, seatEpoch: intent.automaticReplacement.seatEpoch } } : {}),
    },
    designatedAt: seat.designatedAt,
    activatedAt: seat.activatedAt ?? null,
  };
}

function retainNewestSeat(collection: Record<string, OrchestratorSeat>, seat: OrchestratorSeat): void {
  const current = collection[seat.project];
  if (!current || seat.seatEpoch > current.seatEpoch) collection[seat.project] = seat;
}

function lineageKey(entry: SeatLineageEntry): string {
  return `${entry.project}\0${entry.conversationId}\0${entry.seatEpoch}`;
}

/** Called for each kept element of an ordered section with the index of the
    source element it came from, so a store can tell which stored row an
    element is. Lineage entries derived from active seats have no source. */
export type SeatDocumentTracker = (section: "revocations" | "seatLineage" | "history", element: object, sourceIndex: number) => void;

/**
 * The tolerant read, with one distinction the authority callers do not need
 * and #747 does: null means the durable record could not be ESTABLISHED — a
 * torn or future-schema document — while an empty one means the store answered
 * and holds nothing.
 *
 * Individual malformed rows are dropped rather than refused: a row that does
 * not normalize is not evidence of a seat, and the next designation rewrites
 * the record without it.
 */
export function normalizeOrchestratorSeatDocument(value: unknown, resolve: ProjectResolver, track?: SeatDocumentTracker): OrchestratorSeatFile | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = value as Partial<Record<keyof OrchestratorSeatFile, unknown>>;
    if (parsed.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) return null;
    const file = emptyOrchestratorSeatFile();
    const seatLineage: SeatLineageEntry[] = [];
    file.nextSeatEpoch = typeof parsed.nextSeatEpoch === "number" && Number.isInteger(parsed.nextSeatEpoch) && parsed.nextSeatEpoch >= 1
      ? parsed.nextSeatEpoch
      : 1;
    for (const [project, candidate] of Object.entries(parsed.seats ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "active" && seat.conversationId) {
        const canonical = resolve(project);
        seatLineage.push({ project: canonical, conversationId: seat.conversationId, seatEpoch: seat.seatEpoch });
        retainNewestSeat(file.seats, { ...seat, project: canonical });
      }
    }
    for (const [index, candidate] of (Array.isArray(parsed.seatLineage) ? parsed.seatLineage : []).entries()) {
      if (candidate && typeof candidate === "object") {
        const lineage = candidate as { project?: unknown; conversationId?: unknown; seatEpoch?: unknown };
        if (typeof lineage.project === "string" && lineage.project
          && typeof lineage.conversationId === "string" && lineage.conversationId
          && typeof lineage.seatEpoch === "number" && Number.isInteger(lineage.seatEpoch) && lineage.seatEpoch >= 1) {
          const entry = { project: resolve(lineage.project), conversationId: lineage.conversationId, seatEpoch: lineage.seatEpoch };
          track?.("seatLineage", entry, index);
          seatLineage.push(entry);
        }
      }
    }
    file.seatLineage = [...new Map(seatLineage.map((entry) => [lineageKey(entry), entry])).values()];
    for (const [project, candidate] of Object.entries(parsed.pending ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "pending") {
        retainNewestSeat(file.pending, { ...seat, project: resolve(project) });
      }
    }
    for (const [project, candidate] of Object.entries(parsed.rollbacks ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.conversationId) file.rollbacks[resolve(project)] = seat;
    }
    for (const [index, candidate] of (Array.isArray(parsed.revocations) ? parsed.revocations : []).entries()) {
      const revocation = candidate as Partial<OrchestratorRevocation> | null;
      if (revocation && typeof revocation.project === "string" && typeof revocation.conversationId === "string"
        && typeof revocation.seatEpoch === "number" && Number.isInteger(revocation.seatEpoch)
        && typeof revocation.revokedAt === "string") {
        const entry: OrchestratorRevocation = {
          project: resolve(revocation.project),
          conversationId: revocation.conversationId,
          seatEpoch: revocation.seatEpoch,
          revokedAt: revocation.revokedAt,
          successorConversationId: typeof revocation.successorConversationId === "string" ? revocation.successorConversationId : null,
          triggeredBy: normalizeSeatTrigger(revocation.triggeredBy),
          ...seatSpanOf(revocation),
        };
        track?.("revocations", entry, index);
        file.revocations.push(entry);
      }
    }
    for (const [index, candidate] of (Array.isArray(parsed.history) ? parsed.history : []).entries()) {
      const entry = candidate as Partial<OrchestratorSeatTerminalization> | null;
      const seat = normalizeSeat(entry?.seat);
      if (entry && seat
        && (entry.reason === "terminal_error" || entry.reason === "superseded_epoch")
        && typeof entry.terminalizedAt === "string") {
        const terminalization: OrchestratorSeatTerminalization = {
          seat: { ...seat, project: resolve(seat.project) },
          reason: entry.reason,
          terminalizedAt: entry.terminalizedAt,
        };
        track?.("history", terminalization, index);
        file.history.push(terminalization);
      }
    }
    /* The epoch counter must postdate everything on record, or a corrupted
       counter would let a fresh seat land at an epoch a revocation already
       covers and be born dead. */
    const highest = Math.max(0,
      ...Object.values(file.seats).map((seat) => seat.seatEpoch),
      ...file.seatLineage.map((seat) => seat.seatEpoch),
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

export function seatEvidenceError(cause?: unknown): Error {
  return cause === undefined
    ? new Error("orchestrator seat evidence is malformed")
    : new Error("orchestrator seat evidence is malformed", { cause });
}

function recordEvidence(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw seatEvidenceError(new Error(`${field} is invalid`));
  return value as Record<string, unknown>;
}

function arrayEvidence(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw seatEvidenceError(new Error(`${field} is invalid`));
  return value;
}

/**
 * The strict, lossless read shared by the identity wave and the retirement
 * guard. Runtime authority keeps its fail-closed tolerant reader; this one
 * throws when any row would be discarded, so nothing decides on a record that
 * dropped evidence. Provisional rollback custody is not part of this
 * projection; a writer that needs it reads the tolerant record as well.
 */
export function strictOrchestratorSeatDocument(value: unknown, resolve: ProjectResolver): OrchestratorSeatFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw seatEvidenceError();
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) throw seatEvidenceError();
  if (typeof raw.nextSeatEpoch !== "number" || !Number.isInteger(raw.nextSeatEpoch) || raw.nextSeatEpoch < 1) {
    throw seatEvidenceError();
  }

  const normalized = emptyOrchestratorSeatFile();
  const seatLineage: SeatLineageEntry[] = [];
  normalized.nextSeatEpoch = raw.nextSeatEpoch;
  for (const [project, candidate] of Object.entries(recordEvidence(raw.seats, "seats"))) {
    const seat = normalizeSeat(candidate);
    if (!seat || seat.project !== project || seat.state !== "active" || !seat.conversationId) throw seatEvidenceError();
    const canonical = resolve(project);
    if (normalized.seats[canonical]) throw seatEvidenceError();
    normalized.seats[canonical] = { ...seat, project: canonical };
    seatLineage.push({ project: canonical, conversationId: seat.conversationId, seatEpoch: seat.seatEpoch });
  }
  for (const candidate of arrayEvidence(raw.seatLineage, "seatLineage")) {
    const lineage = candidate as { project?: unknown; conversationId?: unknown; seatEpoch?: unknown } | null;
    if (!lineage || typeof lineage.project !== "string" || !lineage.project
      || typeof lineage.conversationId !== "string" || !lineage.conversationId
      || typeof lineage.seatEpoch !== "number" || !Number.isInteger(lineage.seatEpoch) || lineage.seatEpoch < 1) throw seatEvidenceError();
    seatLineage.push({ project: resolve(lineage.project), conversationId: lineage.conversationId, seatEpoch: lineage.seatEpoch });
  }
  normalized.seatLineage = [...new Map(seatLineage.map((entry) => [lineageKey(entry), entry])).values()];
  for (const [project, candidate] of Object.entries(recordEvidence(raw.pending, "pending"))) {
    const seat = normalizeSeat(candidate);
    if (!seat || seat.project !== project || seat.state !== "pending") throw seatEvidenceError();
    const canonical = resolve(project);
    if (normalized.pending[canonical]) throw seatEvidenceError();
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
      throw seatEvidenceError();
    }
    normalized.revocations.push({
      project: resolve(revocation.project),
      conversationId: revocation.conversationId,
      seatEpoch: revocation.seatEpoch,
      revokedAt: revocation.revokedAt,
      successorConversationId: revocation.successorConversationId ?? null,
      /* Carried through: this reader's whole point is that a rewrite
         publishes everything it read. */
      triggeredBy: normalizeSeatTrigger(revocation.triggeredBy),
      ...seatSpanOf(revocation),
    });
  }
  for (const candidate of arrayEvidence(raw.history, "history")) {
    const entry = candidate as Partial<OrchestratorSeatTerminalization> | null;
    const seat = normalizeSeat(entry?.seat);
    if (!entry || !seat
      || (entry.reason !== "terminal_error" && entry.reason !== "superseded_epoch")
      || typeof entry.terminalizedAt !== "string") {
      throw seatEvidenceError();
    }
    normalized.history.push({
      seat: { ...seat, project: resolve(seat.project) },
      reason: entry.reason,
      terminalizedAt: entry.terminalizedAt,
    });
  }
  return normalized;
}

/* Copies for callers. Every reader hands out its own objects, so a caller that
   edits what it read (several write paths do, before they write) can never
   reach a record another reader shares. Strings are immutable and stay shared,
   which is what keeps a copy of a mandate-sized seat cheap. */

export function cloneOrchestratorSeat(seat: OrchestratorSeat): OrchestratorSeat {
  const copy: OrchestratorSeat = { ...seat, intent: { ...seat.intent } };
  if (seat.intent.automaticReplacement) copy.intent.automaticReplacement = { ...seat.intent.automaticReplacement };
  if (seat.workspace) copy.workspace = { ...seat.workspace };
  if (seat.triggeredBy) copy.triggeredBy = { ...seat.triggeredBy };
  if (seat.authCredentialBaseline) copy.authCredentialBaseline = { ...seat.authCredentialBaseline };
  return copy;
}

export function cloneOrchestratorRevocation(revocation: OrchestratorRevocation): OrchestratorRevocation {
  return revocation.triggeredBy ? { ...revocation, triggeredBy: { ...revocation.triggeredBy } } : { ...revocation };
}

export function cloneOrchestratorSeatTerminalization(entry: OrchestratorSeatTerminalization): OrchestratorSeatTerminalization {
  return { ...entry, seat: cloneOrchestratorSeat(entry.seat) };
}

function cloneSeatMap(seats: Readonly<Record<string, OrchestratorSeat>>): Record<string, OrchestratorSeat> {
  const copy: Record<string, OrchestratorSeat> = {};
  for (const [project, seat] of Object.entries(seats)) copy[project] = cloneOrchestratorSeat(seat);
  return copy;
}

/** A whole-record copy. `onElement` sees each ordered element beside its
    copy, so a store can carry what it knows about one onto the other. */
export function cloneOrchestratorSeatFile(
  file: OrchestratorSeatFile,
  onElement?: (original: object, copy: object) => void,
): OrchestratorSeatFile {
  const copyEach = <T extends object>(items: readonly T[], clone: (item: T) => T): T[] => items.map((item) => {
    const copy = clone(item);
    onElement?.(item, copy);
    return copy;
  });
  return {
    schemaVersion: file.schemaVersion,
    nextSeatEpoch: file.nextSeatEpoch,
    seats: cloneSeatMap(file.seats),
    seatLineage: copyEach(file.seatLineage ?? [], (entry) => ({ ...entry })),
    pending: cloneSeatMap(file.pending),
    revocations: copyEach(file.revocations, cloneOrchestratorRevocation),
    history: copyEach(file.history, cloneOrchestratorSeatTerminalization),
    rollbacks: cloneSeatMap(file.rollbacks),
  };
}
