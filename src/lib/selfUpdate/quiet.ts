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
 * cannot disagree about a dead host. `headlessReviewerAlive` is the reviewer
 * process a flow round records, which the registry row does not hold and a
 * record finds only through a transcript. `currentTurnIdle` is what a host in
 * this Viewer says about its own turn right now.
 */
export interface TurnEvidence {
  record: LivenessVerdict | null;
  registryHost?: ConversationRegistryHost | null;
  headlessReviewerAlive?: boolean;
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
  if (evidence.currentTurnIdle === false || evidence.headlessReviewerAlive) return "blocks";
  const { record, registryHost } = evidence;
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
  if (evidence.currentTurnIdle === false || evidence.registryHost?.processAlive || evidence.headlessReviewerAlive) return "blocks";
  const { record, registryHost } = evidence;
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
 * The reviewer a review stage's flow is running now, when the attempt may not
 * name it yet. A flow and the attempt that started it are stored apart, and the
 * attempt takes the new round's binding only on the pipeline's next pass, so
 * until then it still names the previous round's reviewer.
 *
 * `dispatching` is a round whose launch has started and has no conversation to
 * ask about yet, so it holds the stage. The one thing that ends that hold is
 * the process the round itself records: once that process is proven gone the
 * round has no owner, and the launch markers left beside it say nothing more.
 */
function currentReviewRound(flow: Flow | undefined, attemptConversationId: string, reviewerProcess: QuietPorts["reviewerProcess"]): { conversationId: string; artifactPath: string | null } | "dispatching" | null {
  if (!flow || (flow.state !== "spawning" && flow.state !== "reviewing")) return null;
  const round = flow.rounds.at(-1);
  if (!round || round.verdict) return null;
  if (round.reviewerConversationId) {
    return round.reviewerConversationId === attemptConversationId ? null
      : { conversationId: round.reviewerConversationId, artifactPath: round.reviewerPath ?? null };
  }
  if (reviewerProcess?.(round) === "gone") return null;
  return round.spawnStartedAt || round.launchId || round.sessionId || round.reviewerPath || round.reviewerPane || round.reviewerPid != null
    ? "dispatching" : null;
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
  const probe = {};
  const evidence = (session: Pick<RuntimeSession, "conversationId" | "artifactPath">): Promise<TurnEvidence | null> => {
    const id = session.conversationId;
    if (!readings.has(id)) readings.set(id, (async () => {
      try { return await ports.turnLiveness?.(session, probe) ?? null; }
      catch { return null; } // Evidence that could not be read always blocks admission.
    })());
    return readings.get(id)!;
  };
  if (ports.memoryAvailableMb) {
    const mb = ports.memoryAvailableMb();
    if (mb < 4_096) blockers.memoryMb = mb;
  }
  try {
    blockers.registryIssues = (ports.registryHealth ?? pipelineRegistryHealth)();
    const pipelines = ports.pipelines();
    const flows = ports.flows?.() ?? [];
    const stages: BlockingStage[] = [];
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
      if (draining && cursor.state === "reviewing" && attempt?.flowId
        && flows.some((flow) => flow.id === attempt.flowId && flowAwaitingAdmission(flow))) continue;
      // Reserved custody has no engine yet. The drain holds it before claiming
      // an owner; a claimed/reserving/dispatching launch still blocks admission.
      if (draining && cursor.state === "spawning" && attempt?.activation?.phase === "reserved"
        && !attempt.activation.owner && !attempt.launchId && !conversationId) continue;
      if (["running", "reviewing"].includes(cursor.state) && conversationId) {
        const owners = [{ conversationId, artifactPath: attempt?.agentPath ?? null }];
        const round = cursor.state === "reviewing" && attempt?.flowId
          ? currentReviewRound(flows.find((flow) => flow.id === attempt.flowId), conversationId, ports.reviewerProcess) : null;
        if (round && round !== "dispatching") owners.push(round);
        // Every owner is asked, so each unresolved one starts its bound now.
        let released = round !== "dispatching";
        for (const owner of owners) {
          const reading = await evidence(owner);
          const verdict = reading ? judgeStageOwner(reading) : "blocks";
          if (verdict === "blocks" || (verdict !== "released" && !pastBound(owner.conversationId, verdict))) released = false;
        }
        if (released) continue;
      }
      stages.push({ pipelineId: pipeline.id, stageId: cursor.stageId, cursor: cursor.state, task: (pipeline.task ?? "").split("\n")[0]!.slice(0, 80), conversationId });
    }
    blockers.stages = stages.length;
    work.push(...stages.map((stage) => `stage:${stage.pipelineId}:${stage.stageId}:${stage.conversationId ?? ""}`));
    blockers.stageList = stages.slice(0, 20);
    const seats = ports.seats?.() ?? [];
    const runtime = await ports.runtimeSnapshot();
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
      return [pipeline.id, pipeline.state, pipeline.cursor?.stageId, pipeline.cursor?.state, attempt?.conversationId, attempt?.launchId, attempt?.flowId, attempt?.activation?.phase];
    });
    const rounds = ports.flows?.().map((flow) => {
      const round = flow.rounds?.at(-1);
      return [flow.id, flow.state, flow.rounds?.length, round?.launchId, round?.sessionId, round?.spawnStartedAt, round?.relayStartedAt];
    });
    return JSON.stringify([ports.dispatchVersion?.(), stages, rounds, ports.presence(now).map((session) => [session.viewSessionId, session.lastInteractionAt])]);
  } catch { return null; }
}
