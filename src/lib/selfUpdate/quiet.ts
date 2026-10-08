/* Restart admission is read afresh for each role, including after web swaps. */
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { STARTING_GRACE_MS } from "@/lib/lifecycle/liveness";
import type { OwnerReference, OwnerRole } from "@/lib/lifecycle/owners";
import type { RuntimeSession, RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import type { RegistryFile } from "@/lib/agent/registry";
import { admittedRecords } from "../../../bin/self-update-supervisor.mjs";
import { pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { RegistryRecordIssue } from "@/lib/state/registryRecords";
import type { Flow, Round } from "@/lib/flows/types";
import { flowAwaitingAdmission } from "./drain";
import type { StoredViewSession } from "@/lib/view/types";
import type { Snapshot } from "./types";

export type BusyReason = "update" | "web" | "runtime-host" | "pipeline-controller" | "seat-tick";
export interface BlockingTurn { conversationId: string; engine: string; project: string | null; stage: { pipelineId: string; stageId: string } | null; seat: boolean;
  /** Listed while nothing says whether a process owns it; see `unresolved`. */
  unresolved?: true;
  /** Why the first owner of this entry holds (R11). */
  reason?: OwnerReason }
export interface BlockingStage { pipelineId: string; stageId: string; cursor: string; task: string; conversationId: string | null }
export interface QuietBlockers {
  busyReason?: BusyReason | null;
  turnList?: BlockingTurn[];
  stageList?: BlockingStage[];
  /** Journal rows that claim an open turn while every owner they name is released. */
  discounted?: number;
  /** What nothing can say is working or finished (R8): an unconfirmed host
      launch with no sign of a turn and no settled transcript, a turn claim with no recorded
      author, a row that claims a host and records no process, and a journal
      row or stage the registry knows nothing about. */
  unresolved?: number;
  /** The part of `unresolved` still inside `unresolvedGraceMs`; these are also
      counted in `turns`, or in `stages` when only a stage names them. */
  unresolvedBlocking?: number;
  /** How long an unresolved id blocks, counted from the first probe that saw it.
      A settled stage holds for the same time. */
  unresolvedGraceMs?: number;
  /** Running stages whose conversation settled its turn with no process left
      to own it, so the controller has a verdict to read. Each is also counted
      in `stages` while inside `unresolvedGraceMs`. */
  settled?: number;
  operatorWindowMs?: number;
  turns: number;
  stages: number;
  operatorActiveAt: string | null;
  busy: boolean;
  unreadable: string | null;
  memoryMb: number | null;
  registryIssues?: RegistryRecordIssue[];
}

/**
 * How long a journal row nothing can resolve keeps blocking a restart, counted
 * from the first probe that saw it (#2515).
 *
 * It is the launch grace the liveness verdict already gives a conversation
 * with no host evidence, under its own name here because it is counted from a
 * different moment: a row with no transcript has no silence to age it by. A
 * launch whose registry row has not been written yet is the one honest reason
 * such a row can be alive, and it has a row well inside this.
 */
export const UNRESOLVED_TURN_GRACE_MS = STARTING_GRACE_MS;

/** Why an owner holds the drain, or why it is unknown (R7, R8). */
export type OwnerReason = "setup" | "reviewer" | "host-turn" | "turn-claimed" | "turn-open"
  | "turn-unattributed" | "turn-unread" | "launch-unproven" | "unresolved";

/** The turn state of one transcript tail and its newest record. */
export interface TailReading { turn: "busy" | "idle" | "unknown"; lastRecordAt: number | null }

/** Where an owner is shown and found. It never chooses evidence. */
interface OwnerPlace {
  id: string;
  binding: string | null;
  /** The conversations of the receipts that record the same process (R1, R10). */
  custody?: readonly string[];
  artifactPath: string | null;
  entryKey: string | null;
  launchId?: string | null;
  engine?: string | null;
  cwd?: string | null;
}

/**
 * One recorded process and the transcript its record names, with what its own
 * records say (docs/design/update-drain-liveness.md, R1–R5). Turn sources are
 * read for a live host only:
 * - `handle`: the host this Viewer holds under the owner's session key;
 * - `rowReference`: the active turn reference of the owner's own entry;
 * - `journal`: the status mark of the journal row whose mark names the
 *   owner's key and writer (`claimed` when it claims a turn, `idle` when that
 *   writer reports idle), independently of the row's current fence,
 *   or a row at the owner's fence that claims a turn and carries no mark
 *   (`unattributed`);
 * - `tail`: the owner's own transcript.
 */
export interface OwnerReading extends OwnerPlace {
  role: OwnerRole;
  process: "alive" | "gone";
  /** A durable host record names this live pid and its start identity. Even
      a cold Viewer must protect it when its turn evidence cannot be read. */
  confirmed?: boolean;
  handle?: "busy" | "idle" | null;
  rowReference?: boolean;
  journal?: "claimed" | "idle" | "unattributed" | null;
  tail?: TailReading | null;
}

/** A row that claims a host and records no process (R2, R8). */
export interface OwnerlessReading extends OwnerPlace {
  kind: "hosted-row" | "open-receipt";
  /** When a hosted registry row was last written (R8 clock 1). */
  updatedAt: number | null;
  tail?: TailReading | null;
}

/** One probe's census of owners, and the lookups a stage, a flow and a
    journal row are judged through. */
export interface OwnerCensusReading {
  /** Every owner the turn pass judges. */
  owners: readonly OwnerReading[];
  ownerless: readonly OwnerlessReading[];
  /** Every owner and ownerless record bound to a reference (R10). */
  bound(reference: OwnerReference): readonly (OwnerReading | OwnerlessReading)[];
  /** Whether the registry holds anything the reference names (R9). */
  names(reference: OwnerReference): boolean;
  /** The reference's own transcript: its path, or its conversation's current
      generation path when it names only an id (R10). */
  tail(reference: OwnerReference): Promise<TailReading | null>;
}

/** An observational reader can time and yield between individual reads.
    Admission leaves this unset and reads the same evidence directly. */
export type OwnerRead = <T>(reference: OwnerReference, read: () => Promise<T>) => Promise<T>;

export interface QuietPorts {
  /** Synchronous durable admission/start evidence; changing it invalidates an awaited probe. */
  dispatchVersion?(): string;
  runtimeSnapshot(): Promise<Pick<RuntimeSnapshot, "sessions">>;
  /** Every recorded owner with its own evidence. `probe` is one object per
      probe, so a reader can share what it loads across one probe and no
      further. A reading that throws holds admission through `unreadable`. */
  owners?(sessions: readonly RuntimeSession[], probe: object, read?: OwnerRead): Promise<OwnerCensusReading>;
  pipelines(): readonly Pipeline[];
  flows?(): readonly Flow[];
  presence(now: number): readonly StoredViewSession[];
  memoryAvailableMb?(): number;
  controllerIdle?(): Promise<boolean>;
  registryHealth?(): RegistryRecordIssue[];
  controllerBusyReason?(): Promise<BusyReason | null>;
  /** The process a headless review round records, for a round that names no
      conversation: `gone` only on proof, as `headlessRoundProcess` gives it. */
  reviewerProcess?(round: Pick<Round, "reviewerPid" | "reviewerIdentity">): "alive" | "gone" | "unproven";
  seats?(): readonly { conversationId: string; project: string }[];
}

/** A session row that says a host is working on a turn, or is about to. */
export function sessionClaimsOpenTurn(session: Pick<RuntimeSession, "host" | "turn" | "activeTurnId">): boolean {
  return session.turn === "running" || session.turn === "interrupt_requested" || !!session.activeTurnId
    || session.host === "registering" || session.host === "recovering";
}

/**
 * The verdict table (R7), read top to bottom; the first matching row decides.
 * A busy verdict needs one positive sign from the owner's own sources, an idle
 * one needs its own idle evidence and no sign of a turn. A confirmed live
 * host with unreadable turn evidence holds; an unconfirmed launch is unknown.
 * A handle that says idle supersedes the row reference and
 * the journal, both copies of what the host said earlier.
 */
export function ownerVerdict(owner: Pick<OwnerReading, "role" | "process" | "confirmed" | "handle" | "rowReference" | "journal" | "tail">):
  { verdict: "released"; reason: "process-gone" | "turn-settled" } | { verdict: "holds" | "unknown"; reason: OwnerReason } {
  if (owner.process === "gone") return { verdict: "released", reason: "process-gone" };
  if (owner.role === "setup") return { verdict: "holds", reason: "setup" };
  if (owner.role === "reviewer") return { verdict: "holds", reason: "reviewer" };
  if (owner.handle === "busy") return { verdict: "holds", reason: "host-turn" };
  const handleIdle = owner.handle === "idle";
  if (!handleIdle && (owner.rowReference || owner.journal === "claimed")) return { verdict: "holds", reason: "turn-claimed" };
  if (owner.tail?.turn === "busy") return { verdict: "holds", reason: "turn-open" };
  if (handleIdle || owner.journal === "idle") return { verdict: "released", reason: "turn-settled" };
  if (owner.journal === "unattributed") return { verdict: owner.confirmed ? "holds" : "unknown", reason: "turn-unattributed" };
  if (owner.tail?.turn === "idle") return { verdict: "released", reason: "turn-settled" };
  if (owner.confirmed) return { verdict: "holds", reason: "turn-unread" };
  return { verdict: "unknown", reason: "turn-unread" };
}

/** The id an owner is grouped and shown under (R11). */
function displayId(item: OwnerPlace): string {
  return item.binding ?? item.entryKey ?? item.artifactPath ?? item.launchId ?? item.id;
}

const isOwner = (item: OwnerReading | OwnerlessReading): item is OwnerReading => "process" in item;

/**
 * A reviewer a review stage's flow has launched, when the attempt may not name
 * it. Findings and a new round do not prove that a previous reviewer exited.
 * Bound historical owners are read through the common evidence reader, and
 * unbound recorded processes retain custody until proof of death or reuse.
 *
 * `dispatching` is a round whose launch has started and has no conversation to
 * ask about yet, so it holds the stage. The one thing that ends that hold is
 * the process the round itself records: once that process is proven gone the
 * round has no owner, and the launch markers left beside it say nothing more.
 */
function reviewRoundOwner(flow: Flow, round: Round, attemptConversationId: string | null, reviewerProcess: QuietPorts["reviewerProcess"]): { conversationId: string; artifactPath: string | null; historical: boolean } | "dispatching" | "gone" | null {
  const historical = round !== flow.rounds.at(-1);
  // A bound host can still be running after findings arrive, including a
  // reviewer whose process is recorded only by the registry.
  if (round.reviewerConversationId) {
    return round.reviewerConversationId === attemptConversationId ? null
      : { conversationId: round.reviewerConversationId, artifactPath: round.reviewerPath ?? null, historical };
  }
  const recordedProcess = Number.isInteger(round.reviewerPid) && (round.reviewerPid ?? 0) > 0;
  // A materialized path can outlive both its binding and recorded process.
  // The common reader lets a replacement host retain its ownership.
  if (round.reviewerPath) {
    return { conversationId: `flow:${flow.id}:round:${round.n}:reviewer`, artifactPath: round.reviewerPath, historical };
  }
  // A parked flow can still own a reviewer. Only active dispatch phases
  // receive protection from launch markers without a recorded process.
  if (!recordedProcess && (historical || round.verdict || (flow.state !== "spawning" && flow.state !== "reviewing"))) return null;
  if (reviewerProcess?.(round) === "gone") return "gone";
  return round.spawnStartedAt || round.launchId || round.sessionId || round.reviewerPath || round.reviewerPane || round.reviewerPid != null
    ? "dispatching" : null;
}

type StageOwner = { conversationId: string; artifactPath: string | null; historical?: boolean };

/** Flow custody survives a parent cursor parking, completing or disappearing. */
function flowCustody(flow: Flow | undefined, attemptConversationId: string | null, reviewerProcess: QuietPorts["reviewerProcess"]) {
  const owners: StageOwner[] = [];
  let dispatching = false;
  let currentRoundGone = false;
  if (flow) for (const round of flow.rounds) {
    const owner = reviewRoundOwner(flow, round, attemptConversationId, reviewerProcess);
    if (owner === "dispatching") dispatching = true;
    else if (owner === "gone") currentRoundGone ||= round === flow.rounds.at(-1);
    else if (owner) owners.push(owner);
  }
  // The review attempt can still name its reviewer while the implementer fixes.
  const phase = flow?.pausedState ?? flow?.state;
  const review = flow?.rounds.at(-1);
  const fixingDecision = phase === "needs_decision" && review?.verdict === "REQUEST_CHANGES" && review.relayedAt;
  if (flow && (flow.implementerConversationId || flow.implementerPath)
    && (["waiting_ready", "fixing", "relaying"].includes(phase ?? "") || fixingDecision)) {
    owners.push({ conversationId: flow.implementerConversationId ?? `flow:${flow.id}:implementer`, artifactPath: flow.implementerPath });
  }
  // Accepted delivery retains custody until its controller settles it.
  const relayInFlight = Boolean(review?.relayPendingSettlement
    || (phase === "relaying" && review?.relayStartedAt && !review.relayedAt));
  return { owners, dispatching, currentRoundGone, relayInFlight };
}

/* When each unresolved id or settled stage owner was first seen, per set of
   ports: one for the life of the Viewer in production, a fresh one for each
   test. Kept beside the ports so no caller can forget to carry it, which would
   make the bound restart on every probe and hold the drain for good. */
const firstUnresolved = new WeakMap<QuietPorts, Map<string, number>>();

/* The live host owners whose own sources have shown a turn, by owner id, which
   names the process and its start identity, with the reason that showed it. A
   proven turn holds through a later unreadable tail until the owner's own
   sources say idle or its process is gone or reused (R8). Kept per set of
   ports to retain observed proof and its display reason. Cold safety comes
   independently from the durable host identity and retained writer statement
   in OwnerReading (R8). */
const provenTurns = new WeakMap<QuietPorts, Map<string, OwnerReason>>();

const emptyCensus: OwnerCensusReading = {
  owners: [], ownerless: [], bound: () => [], names: () => false, tail: async () => null,
};

export async function probeQuiet(snapshot: Snapshot, ports: QuietPorts, now: number, draining = false): Promise<{ quiet: boolean; blockers: QuietBlockers; work: string[] }> {
  const busyReason: BusyReason | null = snapshot.busy === "update" ? "update"
    : snapshot.busy === "restart-web" || snapshot.processes.web.state !== "healthy" ? "web"
    : snapshot.busy === "restart-runtime-host" || snapshot.processes.runtimeHost.state !== "healthy" ? "runtime-host" : null;
  const blockers: QuietBlockers = { turns: 0, stages: 0, operatorActiveAt: null, busy: !!busyReason, busyReason,
    turnList: [], stageList: [], discounted: 0, unresolved: 0, unresolvedBlocking: 0, settled: 0, unresolvedGraceMs: UNRESOLVED_TURN_GRACE_MS,
    operatorWindowMs: (draining ? 2 : 10) * 60_000, unreadable: null, memoryMb: null };
  // Every open turn and stage this probe saw, by identity. The lists in the
  // blockers are cut for display; an admission compares the whole set.
  const work: string[] = [];
  const probe = {};
  if (ports.memoryAvailableMb) {
    const mb = ports.memoryAvailableMb();
    if (mb < 4_096) blockers.memoryMb = mb;
  }
  try {
    blockers.registryIssues = (ports.registryHealth ?? pipelineRegistryHealth)();
    const pipelines = ports.pipelines();
    const flows = ports.flows?.() ?? [];
    // A stage can predate its transcript binding. Read the journal before
    // judging owners so its path protects the stage in this probe; an earlier
    // pathless reading must not hide that evidence. The first row wins.
    const runtime = await ports.runtimeSnapshot();
    const census = ports.owners ? await ports.owners(runtime.sessions, probe) : emptyCensus;
    const journalPaths = new Map<string, string>();
    for (const session of runtime.sessions) {
      if (session.artifactPath && !journalPaths.has(session.conversationId)) journalPaths.set(session.conversationId, session.artifactPath);
    }
    const stages: BlockingStage[] = [];
    const checkedFlows = new Set<string>();
    const unresolved = new Set<string>();
    const settled = new Set<string>();
    const held = new Set<string>();
    const observed = new Set<string>();
    const memory = firstUnresolved.get(ports) ?? new Map<string, number>();
    firstUnresolved.set(ports, memory);
    /* One bound per clock: a recorded owner and an ownerless record each have
       their own, keyed by the record, its process and the transcript it
       names, and a reference a journal row
       or a stage names has one by its id. It runs from the newest record of
       the transcript the item names when one can be read, else from the first
       probe that saw the item (R8). `shownAs` is the id the item is counted
       under, which several owners can share (R11). */
    const pastBound = (clock: string, kind: "unresolved" | "settled" = "unresolved", recordedAt: number | null = null, shownAs = clock): boolean => {
      const key = `${kind}:${clock}`;
      observed.add(key);
      (kind === "unresolved" ? unresolved : settled).add(shownAs);
      const first = memory.get(key) ?? now;
      memory.set(key, first);
      if (now - (recordedAt ?? first) >= UNRESOLVED_TURN_GRACE_MS) return true;
      if (kind === "unresolved") held.add(shownAs);
      return false;
    };
    /* R8 clock 1: a hosted row with no process past its launch grace proves
       nothing owns it. */
    const expired = (record: OwnerlessReading): boolean => record.kind === "hosted-row"
      && record.updatedAt !== null && now - record.updatedAt >= UNRESOLVED_TURN_GRACE_MS;
    /* The clocks in R8's order: an expired hosted row's own write, then the
       newest record of the transcript the item names, then the first probe.
       Every item is counted in `unresolved`, whichever clock releases it. */
    const ownerPastBound = (item: OwnerReading | OwnerlessReading): boolean =>
      pastBound(`${isOwner(item) ? "owner" : "ownerless"}:${item.id}:${item.artifactPath ?? ""}`, "unresolved",
        !isOwner(item) && expired(item) ? item.updatedAt : item.tail?.lastRecordAt ?? null, displayId(item));
    /* What a stage reference says, from the set of owners bound to it (R10). */
    const judgeStageOwner = async (owner: StageOwner): Promise<{ verdict: "blocks" | "released" | "pending" | "settled" | "unresolved"; since: number | null }> => {
      const reference = { conversationId: owner.conversationId, artifactPath: owner.artifactPath ?? journalPaths.get(owner.conversationId) ?? null };
      const bound = census.bound(reference);
      if (bound.some((item) => isOwner(item) && item.process === "alive")) return { verdict: "blocks", since: null };
      // A launch marker has no process of its own: proof that the reviewer
      // the round records is gone releases its stage.
      if (bound.some((item) => isOwner(item) && item.role === "reviewer")) return { verdict: "released", since: null };
      // Each ownerless record keeps its own bound, so one seen earlier cannot
      // age a record that has just appeared under the same reference.
      const pending = bound.filter((item): item is OwnerlessReading => !isOwner(item) && !expired(item));
      if (pending.length) return { verdict: pending.map(ownerPastBound).every(Boolean) ? "released" : "pending", since: null };
      const transcript = await census.tail(reference);
      if (!bound.length && !census.names(reference)) return { verdict: "unresolved", since: transcript?.lastRecordAt ?? null };
      return { verdict: transcript?.turn === "idle" ? "settled" : "released", since: null };
    };
    for (const pipeline of pipelines) {
      const cursor = pipeline.cursor;
      if (pipeline.state !== "running" || !cursor || !["spawning", "running", "reviewing", "committing"].includes(cursor.state)) continue;
      const attempt = pipeline.runs?.find((run) => run.stageId === cursor.stageId)?.attempts.findLast((attempt) => !attempt.historical);
      const conversationId = attempt?.conversationId ?? null;
      const flow = cursor.state === "reviewing" && attempt?.flowId
        ? flows.find((flow) => flow.id === attempt.flowId) : undefined;
      const awaitingAdmission = draining && !!flow && flowAwaitingAdmission(flow);
      // Reserved custody has no engine yet. The drain holds it before claiming
      // an owner; a claimed/reserving/dispatching launch still blocks admission.
      const heldReservation = draining && cursor.state === "spawning" && attempt?.activation?.phase === "reserved"
        && !attempt.activation.owner && !attempt.launchId && !conversationId;
      if (heldReservation && !attempt?.agentPath) continue;
      if (["running", "reviewing"].includes(cursor.state) || heldReservation) {
        const { owners, dispatching, currentRoundGone, relayInFlight } = flowCustody(flow, conversationId, ports.reviewerProcess);
        if (flow) checkedFlows.add(flow.id);
        const attemptOwnerId = conversationId ?? `stage:${pipeline.id}:${cursor.stageId}:attempt:${attempt?.n ?? 0}`;
        if (conversationId || attempt?.agentPath) owners.push({ conversationId: attemptOwnerId, artifactPath: attempt?.agentPath ?? null });
        // A stage without a binding or readable transcript is an unresolved
        // owner too. Keep its identity stable across probes so its bound ages.
        if (!owners.length && !dispatching && !currentRoundGone && !awaitingAdmission) {
          owners.push({ conversationId: attemptOwnerId, artifactPath: null });
        }
        // Every owner is asked, so each unresolved one starts its bound now.
        // The first review attempt may have no binding yet. A proven-gone
        // round releases it; absence of any owner evidence proves nothing.
        // A held next action owns no work, but the reviewer can still be
        // running after its findings moved the flow to relaying. Read every
        // existing owner before discounting the held action. A settled owner
        // needs no verdict-collection grace here: that action is already held.
        let released = !relayInFlight && !dispatching && (awaitingAdmission || owners.length > 0 || currentRoundGone);
        for (const owner of owners) {
          const { verdict, since } = await judgeStageOwner(owner);
          if (verdict === "blocks" || verdict === "pending" || (verdict !== "released" && !((awaitingAdmission || owner.historical) && verdict === "settled")
            && !pastBound(owner.conversationId, verdict, verdict === "unresolved" ? since : null))) released = false;
        }
        if (released) continue;
      }
      stages.push({ pipelineId: pipeline.id, stageId: cursor.stageId, cursor: cursor.state, task: (pipeline.task ?? "").split("\n")[0]!.slice(0, 80), conversationId });
    }
    for (const flow of flows) {
      if (checkedFlows.has(flow.id)) continue;
      const { owners, dispatching, relayInFlight } = flowCustody(flow, null, ports.reviewerProcess);
      let blocks = dispatching || relayInFlight;
      for (const owner of owners) {
        const { verdict, since } = await judgeStageOwner(owner);
        // Parked/finished flows have no verdict collection to wait for. Unknown
        // ownership keeps the same diagnostic bound as an active stage.
        const collecting = flow.state === "reviewing" && !owner.historical;
        if (verdict === "blocks" || verdict === "pending" || (verdict === "unresolved" && !pastBound(owner.conversationId, "unresolved", since))
          || (verdict === "settled" && collecting && !pastBound(owner.conversationId, "settled"))) blocks = true;
      }
      if (!blocks) continue;
      const parent = pipelines.find((pipeline) => pipeline.runs?.some((run) => run.attempts.some((attempt) => attempt.flowId === flow.id)));
      const run = parent?.runs?.find((run) => run.attempts.some((attempt) => attempt.flowId === flow.id));
      const pipelineId = parent?.id ?? `flow:${flow.id}`;
      const stageId = run?.stageId ?? "review";
      if (!stages.some((stage) => stage.pipelineId === pipelineId && stage.stageId === stageId)) {
        stages.push({ pipelineId, stageId, cursor: flow.state, task: (parent?.task ?? flow.stateDetail ?? "").split("\n")[0]!.slice(0, 80),
          conversationId: owners[0]?.conversationId ?? null });
      }
    }
    blockers.stages = stages.length;
    work.push(...stages.map((stage) => `stage:${stage.pipelineId}:${stage.stageId}:${stage.conversationId ?? ""}`));
    blockers.stageList = stages.slice(0, 20);
    /* R7 per owner, then R11: owners that hold, or are unknown inside their
       bound, are grouped by display id only after every verdict is read. */
    const holding = new Map<string, { item: OwnerReading | OwnerlessReading; reason: OwnerReason; unresolved: boolean }>();
    const proven = provenTurns.get(ports) ?? new Map<string, OwnerReason>();
    provenTurns.set(ports, proven);
    for (const id of proven.keys()) if (!census.owners.some((owner) => owner.id === id)) proven.delete(id);
    for (const owner of census.owners) {
      const { verdict, reason } = ownerVerdict(owner);
      // Losing the evidence of a proven turn is no end of it: only the
      // owner's settled tail, its handle saying idle, or its process being
      // gone ends what its own sources showed.
      if (verdict === "released" || owner.handle === "idle") proven.delete(owner.id);
      else if (verdict === "holds" && owner.role === "host" && !proven.has(owner.id)) proven.set(owner.id, reason);
      if (verdict === "released") continue;
      const kept = verdict === "unknown" || reason === "turn-unread" ? proven.get(owner.id) : undefined;
      if (kept) {
        holding.set(owner.id, { item: owner, reason: kept, unresolved: false });
        continue;
      }
      if (verdict === "unknown" && ownerPastBound(owner)) continue;
      holding.set(owner.id, { item: owner, reason, unresolved: verdict === "unknown" });
    }
    for (const record of census.ownerless) {
      if (ownerPastBound(record)) continue;
      holding.set(record.id, { item: record, reason: "launch-unproven", unresolved: true });
    }
    const seats = ports.seats?.() ?? [];
    const groups = new Map<string, BlockingTurn>();
    const group = (id: string, engine: string | null | undefined, cwd: string | null | undefined, reason: OwnerReason, isUnresolved: boolean) => {
      const existing = groups.get(id);
      if (existing) {
        if (!isUnresolved) delete existing.unresolved;
        return;
      }
      const stage = stages.find((stage) => stage.conversationId === id);
      groups.set(id, { conversationId: id, engine: engine ?? "unknown",
        project: cwd ? projectInfoFromCwd(cwd)?.project ?? null : null,
        stage: stage ? { pipelineId: stage.pipelineId, stageId: stage.stageId } : null,
        seat: seats.some((seat) => seat.conversationId === id), reason,
        ...(isUnresolved ? { unresolved: true as const } : {}) });
    };
    /* R9: a journal row is turn evidence only through an owner's own status
       mark, which the reader already read. Here it is a claim: one the
       registry knows nothing about is unresolved, and one whose every owner
       is released is discounted. Rows come first so the list keeps their order. */
    for (const session of runtime.sessions) {
      const reference = { conversationId: session.conversationId, artifactPath: session.artifactPath, sessionKey: session.sessionKey };
      const bound = census.bound(reference);
      const holders = bound.filter((item) => holding.has(item.id));
      for (const item of holders) {
        const { reason, unresolved: isUnresolved } = holding.get(item.id)!;
        group(displayId(item), item.engine, item.cwd ?? session.cwd, reason, isUnresolved);
      }
      if (holders.length) continue;
      if (!bound.length && !census.names(reference)) {
        if (!sessionClaimsOpenTurn(session)) continue;
        const transcript = session.artifactPath ? await census.tail({ artifactPath: session.artifactPath }) : null;
        if (!pastBound(session.conversationId, "unresolved", transcript?.lastRecordAt ?? null)) {
          group(session.conversationId, session.sessionKey?.engine, session.cwd, "unresolved", true);
        }
        continue;
      }
      if (sessionClaimsOpenTurn(session)) blockers.discounted!++;
    }
    for (const { item, reason, unresolved: isUnresolved } of holding.values()) group(displayId(item), item.engine, item.cwd, reason, isUnresolved);
    const turns = [...groups.values()];
    // An id that resolved, or that nothing names any more, starts a new bound
    // if it is ever unresolved again.
    for (const key of memory.keys()) if (!observed.has(key)) memory.delete(key);
    blockers.unresolved = unresolved.size;
    blockers.settled = settled.size;
    blockers.unresolvedBlocking = held.size;
    blockers.turns = turns.length;
    work.push(...turns.map((turn) => `turn:${turn.conversationId}`));
    blockers.turnList = turns.slice(0, 20);
    const controller = ports.controllerBusyReason ? await ports.controllerBusyReason()
      : ports.controllerIdle && !await ports.controllerIdle() ? "pipeline-controller" : null;
    if (controller && !blockers.busyReason) { blockers.busy = true; blockers.busyReason = controller; }
    const latest = ports.presence(now).filter((session) => now - session.lastInteractionAt < blockers.operatorWindowMs!).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)[0];
    blockers.operatorActiveAt = latest ? new Date(latest.lastInteractionAt).toISOString() : null;
  } catch (error) {
    blockers.unreadable = error instanceof Error ? error.message : String(error);
  }
  return { quiet: !blockers.turns && !blockers.stages && !blockers.operatorActiveAt && !blockers.busy && !blockers.unreadable && blockers.memoryMb === null, blockers, work };
}

/**
 * The registry half of the quiet fence's dispatch version: the admitted entries
 * and the owner of every spawn receipt. The fence reads it before and after
 * each awaited step of an adoption, so it reads the shared registry view, which
 * a repeated read at an unchanged revision answers without loading anything,
 * and only reads it: nothing here writes into the view it is given.
 */
export function registryAdmissionEvidence(registry: RegistryFile): [records: NonNullable<ReturnType<typeof admittedRecords>>, receiptOwners: unknown[][]] {
  const records = admittedRecords(registry);
  if (!records) throw new Error("Runtime admission evidence is unavailable");
  const receiptOwners = Object.values(registry.receipts).map((receipt) => [
    receipt.launchId, receipt.conversationId, receipt.state, receipt.artifactPath,
    receipt.admissionOwner, receipt.verifiedHost?.agent, receipt.pane?.panePid,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return [records, receiptOwners];
}

/** What a synchronous fence compares across an awaited read: the stages and
    flow rounds that are filed, by launch, and the operator's last interaction.
    A stage's progress notes and a tab's heartbeat are traffic of work already
    admitted, so neither is part of it. */
export function quietDispatchVersion(ports: QuietPorts | undefined, now: number): string | null {
  if (!ports) return null;
  try {
    const stages = ports.pipelines().map((pipeline) => {
      const attempt = pipeline.runs?.find((run) => run.stageId === pipeline.cursor?.stageId)?.attempts.findLast((attempt) => !attempt.historical);
      return [pipeline.id, pipeline.state, pipeline.cursor?.stageId, pipeline.cursor?.state, attempt?.conversationId, attempt?.agentPath, attempt?.launchId, attempt?.flowId, attempt?.activation?.phase];
    });
    const rounds = ports.flows?.().map((flow) => {
      const round = flow.rounds?.at(-1);
      return [flow.id, flow.state, flow.pausedState, flow.implementerConversationId, flow.implementerPath,
        flow.rounds?.map((owner) => [owner.reviewerConversationId, owner.reviewerPath, owner.reviewerPid, owner.reviewerIdentity]),
        flow.rounds?.length, round?.launchId, round?.sessionId, round?.spawnStartedAt,
        round?.relayStartedAt, round?.relayPendingSettlement, round?.relayedAt];
    });
    return JSON.stringify([ports.dispatchVersion?.(), stages, rounds, ports.presence(now).map((session) => [session.viewSessionId, session.lastInteractionAt])]);
  } catch { return null; }
}
