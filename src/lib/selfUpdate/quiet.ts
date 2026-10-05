/* Restart admission is read afresh for each role, including after web swaps. */
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { STARTING_GRACE_MS, livenessRecordIsLive, type ConversationRegistryHost, type LivenessVerdict } from "@/lib/lifecycle/liveness";
import type { HostState } from "@/lib/runtime/engineHost";
import type { RuntimeSession, RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import { pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { RegistryRecordIssue } from "@/lib/state/registryRecords";
import type { Flow } from "@/lib/flows/types";
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
  /** Journal rows that claim an open turn and have neither a liveness record
      nor a registry row, so nothing says whether a process owns them. */
  unresolved?: number;
  /** The part of `unresolved` still inside `unresolvedGraceMs`; these are also
      counted in `turns`. */
  unresolvedBlocking?: number;
  /** How long an unresolved row blocks, counted from the first probe that saw it. */
  unresolvedGraceMs?: number;
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
 * cannot disagree about a dead host. `currentTurnIdle` is the one thing neither
 * holds: what a host in this Viewer says about its own turn right now.
 */
export interface TurnEvidence {
  record: LivenessVerdict | null;
  registryHost?: ConversationRegistryHost | null;
  currentTurnIdle?: boolean;
}
export interface QuietPorts {
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
  if (evidence.currentTurnIdle === false) return "blocks";
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

/** An open turn whose host is proven gone: nothing is left to finish the stage. */
function stageHostGone(evidence: TurnEvidence): boolean {
  return evidence.currentTurnIdle !== false && !evidence.registryHost?.processAlive
    && evidence.record?.host.state === "gone" && evidence.record.turnState === "busy";
}

/* When each unresolved row was first seen, per set of ports: one for the life
   of the Viewer in production, a fresh one for each test. Kept beside the
   ports so no caller can forget to carry it, which would make the bound
   restart on every probe and hold the drain for good. */
const firstUnresolved = new WeakMap<QuietPorts, Map<string, number>>();

export async function probeQuiet(snapshot: Snapshot, ports: QuietPorts, now: number, draining = false): Promise<{ quiet: boolean; blockers: QuietBlockers }> {
  const busyReason: BusyReason | null = snapshot.busy === "update" ? "update"
    : snapshot.busy === "restart-web" || snapshot.processes.web.state !== "healthy" ? "web"
    : snapshot.busy === "restart-runtime-host" || snapshot.processes.runtimeHost.state !== "healthy" ? "runtime-host" : null;
  const blockers: QuietBlockers = { turns: 0, stages: 0, operatorActiveAt: null, busy: !!busyReason, busyReason,
    turnList: [], stageList: [], discounted: 0, unresolved: 0, unresolvedBlocking: 0, unresolvedGraceMs: UNRESOLVED_TURN_GRACE_MS,
    operatorWindowMs: (draining ? 2 : 10) * 60_000, unreadable: null, memoryMb: null };
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
    const flows = draining ? ports.flows?.() ?? [] : [];
    const stages: BlockingStage[] = [];
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
        const reading = await evidence({ conversationId, artifactPath: attempt?.agentPath ?? null });
        if (reading && stageHostGone(reading)) continue;
      }
      stages.push({ pipelineId: pipeline.id, stageId: cursor.stageId, cursor: cursor.state, task: (pipeline.task ?? "").split("\n")[0]!.slice(0, 80), conversationId });
    }
    blockers.stages = stages.length;
    blockers.stageList = stages.slice(0, 20);
    const seats = ports.seats?.() ?? [];
    const runtime = await ports.runtimeSnapshot();
    const turns: BlockingTurn[] = [];
    const seen = new Set<string>();
    const unresolved = new Set<string>();
    const memory = firstUnresolved.get(ports) ?? new Map<string, number>();
    firstUnresolved.set(ports, memory);
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
      if (verdict === "unresolved") {
        unresolved.add(session.conversationId);
        const since = memory.get(session.conversationId) ?? now;
        memory.set(session.conversationId, since);
        if (now - since >= UNRESOLVED_TURN_GRACE_MS) continue;
      }
      const stage = stages.find((stage) => stage.conversationId === session.conversationId);
      turns.push({ conversationId: session.conversationId, engine: session.sessionKey?.engine ?? "unknown",
        project: session.cwd ? projectInfoFromCwd(session.cwd)?.project ?? null : null,
        stage: stage ? { pipelineId: stage.pipelineId, stageId: stage.stageId } : null,
        seat: seats.some((seat) => seat.conversationId === session.conversationId),
        ...(verdict === "unresolved" ? { unresolved: true as const } : {}) });
    }
    // A row that resolved, or left the journal, starts a new bound if it is
    // ever unresolved again.
    for (const id of memory.keys()) if (!unresolved.has(id)) memory.delete(id);
    blockers.unresolved = unresolved.size;
    blockers.unresolvedBlocking = turns.filter((turn) => turn.unresolved).length;
    blockers.turns = turns.length;
    blockers.turnList = turns.slice(0, 20);
    const controller = ports.controllerBusyReason ? await ports.controllerBusyReason()
      : ports.controllerIdle && !await ports.controllerIdle() ? "pipeline-controller" : null;
    if (controller && !blockers.busyReason) { blockers.busy = true; blockers.busyReason = controller; }
    const latest = ports.presence(now).filter((session) => now - session.lastInteractionAt < blockers.operatorWindowMs!).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)[0];
    blockers.operatorActiveAt = latest ? new Date(latest.lastInteractionAt).toISOString() : null;
  } catch (error) {
    blockers.unreadable = error instanceof Error ? error.message : String(error);
  }
  return { quiet: !blockers.turns && !blockers.stages && !blockers.operatorActiveAt && !blockers.busy && !blockers.unreadable && blockers.memoryMb === null, blockers };
}
