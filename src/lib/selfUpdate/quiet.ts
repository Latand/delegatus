/* Restart admission is read afresh for each role, including after web swaps. */
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { STARTING_GRACE_MS, livenessRecordIsLive, type ConversationRegistryHost, type LivenessVerdict } from "@/lib/lifecycle/liveness";
import type { HostState } from "@/lib/runtime/engineHost";
import type { RuntimeSession, RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import { pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { RegistryRecordIssue } from "@/lib/state/registryRecords";
import type { Flow, Round } from "@/lib/flows/types";
import { flowAwaitingAdmission } from "./drain";
import type { StoredViewSession } from "@/lib/view/types";
import type { Snapshot } from "./types";

export type BusyReason = "update" | "web" | "runtime-host" | "pipeline-controller" | "seat-tick";
export interface BlockingTurn { conversationId: string; engine: string; project: string | null; stage: { pipelineId: string; stageId: string } | null; seat: boolean;
  /** Listed while nothing says whether a process owns it; see `unresolved`. */
  unresolved?: true }
export interface BlockingStage { pipelineId: string; stageId: string; cursor: string; task: string; conversationId: string | null }
export interface QuietBlockers {
  busyReason?: BusyReason | null;
  turnList?: BlockingTurn[];
  stageList?: BlockingStage[];
  /** Journal rows that claim an open turn whose host is proven gone. */
  discounted?: number;
  /** Conversations a journal row or a running stage names that have neither a
      liveness record nor a registry row, so nothing says whether a process
      owns them. */
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

/**
 * What one journal row is judged on (#2515).
 *
 * `record` is the row `agent_activity` answers for the conversation, and
 * `registryHost` is the host its registry row names when there is no record to
 * read. Both come from one liveness reading, so the drain and `agent_activity`
 * cannot disagree about a dead host. `headlessReviewerProcess` is the reviewer
 * process a flow round records, which the registry row does not hold and a
 * record finds only through a transcript. Its `unproven` verdict keeps a
 * recorded process protected until it is proven gone. `currentTurnIdle` is
 * what a host in this Viewer says about its own turn right now.
 */
export interface TurnEvidence {
  record: LivenessVerdict | null;
  registryHost?: ConversationRegistryHost | null;
  headlessReviewerProcess?: "alive" | "gone" | "unproven" | null;
  currentTurnIdle?: boolean;
}
export interface QuietPorts {
  /** Synchronous durable admission/start evidence; changing it invalidates an awaited probe. */
  dispatchVersion?(): string;
  runtimeSnapshot(): Promise<Pick<RuntimeSnapshot, "sessions">>;
  pipelines(): readonly Pipeline[];
  flows?(): readonly Flow[];
  presence(now: number): readonly StoredViewSession[];
  memoryAvailableMb?(): number;
  controllerIdle?(): Promise<boolean>;
  registryHealth?(): RegistryRecordIssue[];
  controllerBusyReason?(): Promise<BusyReason | null>;
  /** `probe` is one object for every row a single probe asks about, so a
      reader can share what it loads across them and no further. */
  turnLiveness?(session: Pick<RuntimeSession, "conversationId" | "artifactPath">, probe: object): Promise<TurnEvidence>;
  /** The process a headless review round records, for a round that names no
      conversation: `gone` only on proof, as `headlessRoundProcess` gives it. */
  reviewerProcess?(round: Pick<Round, "reviewerPid" | "reviewerIdentity">): "alive" | "gone" | "unproven";
  seats?(): readonly { conversationId: string; project: string }[];
}
export function currentHostTurnIdle(current: Pick<HostState, "status" | "activeTurnRef"> | undefined): boolean | undefined {
  if (!current || current.status === "dead" || current.status === "unhosted") return undefined;
  return current.status === "idle" && current.activeTurnRef === null;
}

type TurnVerdict = "blocks" | "discounted" | "unresolved";

function judgeTurn(evidence: TurnEvidence): TurnVerdict {
  // Current host work wins over transcript and registry evidence read before
  // a replacement host was admitted for this conversation.
  if (evidence.currentTurnIdle === false || evidence.headlessReviewerProcess === "alive" || evidence.headlessReviewerProcess === "unproven") return "blocks";
  const { record, registryHost } = evidence;
  // A replacement host wins over proof that the recorded reviewer is gone.
  if (registryHost?.processAlive || record?.host.state === "alive") {
    if (record?.turnState === "idle" && evidence.currentTurnIdle === true) return "discounted";
    return "blocks";
  }
  // The launch marker has no process of its own. Its grace cannot override
  // proof that the bound reviewer died or its PID was reused.
  if (evidence.headlessReviewerProcess === "gone") return "discounted";
  if (!record) {
    if (!registryHost) return "unresolved";
    // A row that records no live process and is past its launch grace proves
    // no process owns the conversation, with or without a transcript.
    return registryHost.processAlive || registryHost.state !== "gone" ? "blocks" : "discounted";
  }
  // A settled transcript cannot hide a newly admitted turn. Only the host
  // that would run it can say none was.
  if (record.turnState === "idle" && evidence.currentTurnIdle === true) return "discounted";
  // A status word can lag a process the row still records. The restart would
  // land on that process, so it counts while it answers.
  if (registryHost?.processAlive) return "blocks";
  return livenessRecordIsLive(record) ? "blocks" : "discounted";
}

/**
 * What one conversation says about the stage it runs, on the same predicate a
 * turn is judged on. `released` is a turn no process owns that did not settle,
 * so nothing is left to finish the stage. `settled` is a turn no process owns
 * that did settle: the controller still has its verdict to read, so the stage
 * holds for a bounded time.
 */
function judgeStageOwner(evidence: TurnEvidence): "blocks" | "released" | "settled" | "unresolved" {
  if (evidence.currentTurnIdle === false || evidence.registryHost?.processAlive || evidence.headlessReviewerProcess === "alive" || evidence.headlessReviewerProcess === "unproven") return "blocks";
  const { record, registryHost } = evidence;
  if (record?.host.state === "alive") return "blocks";
  if (evidence.headlessReviewerProcess === "gone") return "released";
  if (record) {
    if (livenessRecordIsLive(record)) return "blocks";
    return record.turnState === "idle" ? "settled" : "released";
  }
  // No transcript to read. A host in this Viewer still answers for the
  // conversation; otherwise the registry row is the evidence, as it is for a turn.
  if (evidence.currentTurnIdle !== undefined) return "blocks";
  if (!registryHost) return "unresolved";
  return registryHost.state === "gone" ? "released" : "blocks";
}

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
  const readings = new Map<string, Promise<TurnEvidence | null>>();
  const journalPaths = new Map<string, string>();
  const probe = {};
  const evidence = (session: Pick<RuntimeSession, "conversationId" | "artifactPath">): Promise<TurnEvidence | null> => {
    const artifactPath = session.artifactPath ?? journalPaths.get(session.conversationId) ?? null;
    const key = JSON.stringify([session.conversationId, artifactPath]);
    if (!readings.has(key)) readings.set(key, (async () => {
      try { return await ports.turnLiveness?.({ ...session, artifactPath }, probe) ?? null; }
      catch { return null; } // Evidence that could not be read always blocks admission.
    })());
    return readings.get(key)!;
  };
  if (ports.memoryAvailableMb) {
    const mb = ports.memoryAvailableMb();
    if (mb < 4_096) blockers.memoryMb = mb;
  }
  try {
    blockers.registryIssues = (ports.registryHealth ?? pipelineRegistryHealth)();
    const pipelines = ports.pipelines();
    const flows = ports.flows?.() ?? [];
    // A stage can predate its transcript binding. Read the journal before
    // judging owners so its path protects both the stage and its turn in this
    // probe; an earlier pathless reading must not hide that evidence.
    const runtime = await ports.runtimeSnapshot();
    for (const session of runtime.sessions) {
      if (session.artifactPath) journalPaths.set(session.conversationId, session.artifactPath);
    }
    const stages: BlockingStage[] = [];
    const checkedFlows = new Set<string>();
    const unresolved = new Set<string>();
    const settled = new Set<string>();
    const held = new Set<string>();
    const observed = new Set<string>();
    const memory = firstUnresolved.get(ports) ?? new Map<string, number>();
    firstUnresolved.set(ports, memory);
    /* One bound for an id, whether a journal row or a stage names it. */
    const pastBound = (id: string, kind: "unresolved" | "settled" = "unresolved"): boolean => {
      const key = `${kind}:${id}`;
      observed.add(key);
      (kind === "unresolved" ? unresolved : settled).add(id);
      const since = memory.get(key) ?? now;
      memory.set(key, since);
      if (now - since >= UNRESOLVED_TURN_GRACE_MS) return true;
      if (kind === "unresolved") held.add(id);
      return false;
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
      if (draining && cursor.state === "spawning" && attempt?.activation?.phase === "reserved"
        && !attempt.activation.owner && !attempt.launchId && !conversationId) continue;
      if (["running", "reviewing"].includes(cursor.state)) {
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
          const reading = await evidence(owner);
          const verdict = reading ? judgeStageOwner(reading) : "blocks";
          if (verdict === "blocks" || (verdict !== "released" && !((awaitingAdmission || owner.historical) && verdict === "settled")
            && !pastBound(owner.conversationId, verdict))) released = false;
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
        const reading = await evidence(owner);
        const verdict = reading ? judgeStageOwner(reading) : "blocks";
        // Parked/finished flows have no verdict collection to wait for. Unknown
        // ownership keeps the same diagnostic bound as an active stage.
        const collecting = flow.state === "reviewing" && !owner.historical;
        if (verdict === "blocks" || (verdict === "unresolved" && !pastBound(owner.conversationId))
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
    const seats = ports.seats?.() ?? [];
    const turns: BlockingTurn[] = [];
    const seen = new Set<string>();
    for (const session of runtime.sessions) {
      if (!["running", "interrupt_requested"].includes(session.turn) && !["registering", "recovering"].includes(session.host)) continue;
      // The journal's own words cannot settle this either way: a fallback can
      // publish unhosted/running over a live process, and a row can keep
      // hosted/running for days after its host died.
      const reading = await evidence(session);
      const verdict = reading ? judgeTurn(reading) : "blocks";
      if (verdict === "discounted") { blockers.discounted!++; continue; }
      if (seen.has(session.conversationId)) continue;
      seen.add(session.conversationId);
      if (verdict === "unresolved" && pastBound(session.conversationId)) continue;
      const stage = stages.find((stage) => stage.conversationId === session.conversationId);
      turns.push({ conversationId: session.conversationId, engine: session.sessionKey?.engine ?? "unknown",
        project: session.cwd ? projectInfoFromCwd(session.cwd)?.project ?? null : null,
        stage: stage ? { pipelineId: stage.pipelineId, stageId: stage.stageId } : null,
        seat: seats.some((seat) => seat.conversationId === session.conversationId),
        ...(verdict === "unresolved" ? { unresolved: true as const } : {}) });
    }
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
