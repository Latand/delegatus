/* Restart admission is read afresh for each role, including after web swaps. */
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import type { HostProcessLivenessEvidence, TurnLiveness } from "@/lib/runtime/liveness";
import type { HostState } from "@/lib/runtime/engineHost";
import type { RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import { pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { RegistryRecordIssue } from "@/lib/state/registryRecords";
import type { Flow } from "@/lib/flows/types";
import { flowAwaitingAdmission } from "./drain";
import type { StoredViewSession } from "@/lib/view/types";
import type { Snapshot } from "./types";

export type BusyReason = "update" | "web" | "runtime-host" | "pipeline-controller" | "seat-tick";
export interface BlockingTurn { conversationId: string; engine: string; project: string | null; stage: { pipelineId: string; stageId: string } | null; seat: boolean }
export interface BlockingStage { pipelineId: string; stageId: string; cursor: string; task: string; conversationId: string | null }
export interface QuietBlockers {
  busyReason?: BusyReason | null;
  turnList?: BlockingTurn[];
  stageList?: BlockingStage[];
  discounted?: number;
  operatorWindowMs?: number;
  turns: number;
  stages: number;
  operatorActiveAt: string | null;
  busy: boolean;
  unreadable: string | null;
  memoryMb: number | null;
  registryIssues?: RegistryRecordIssue[];
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
  turnLiveness?(conversationId: string): Promise<{ state: TurnLiveness; currentTurnIdle?: boolean; hostEvidence?: Pick<HostProcessLivenessEvidence, "present" | "observedIdentity" | "expected"> } | null>;
  seats?(): readonly { conversationId: string; project: string }[];
}
export function currentHostTurnIdle(current: Pick<HostState, "status" | "activeTurnRef"> | undefined): boolean | undefined {
  if (!current || current.status === "dead" || current.status === "unhosted") return undefined;
  return current.status === "idle" && current.activeTurnRef === null;
}

export async function probeQuiet(snapshot: Snapshot, ports: QuietPorts, now: number, draining = false): Promise<{ quiet: boolean; blockers: QuietBlockers }> {
  const busyReason: BusyReason | null = snapshot.busy === "update" ? "update"
    : snapshot.busy === "restart-web" || snapshot.processes.web.state !== "healthy" ? "web"
    : snapshot.busy === "restart-runtime-host" || snapshot.processes.runtimeHost.state !== "healthy" ? "runtime-host" : null;
  const blockers: QuietBlockers = { turns: 0, stages: 0, operatorActiveAt: null, busy: !!busyReason, busyReason,
    turnList: [], stageList: [], discounted: 0, operatorWindowMs: (draining ? 2 : 10) * 60_000, unreadable: null, memoryMb: null };
  const verdicts = new Map<string, Promise<TurnLiveness | null>>();
  const liveness = (id: string): Promise<TurnLiveness | null> => {
    if (!verdicts.has(id)) verdicts.set(id, (async () => {
      try {
        const verdict = await ports.turnLiveness?.(id);
        // Current host work wins over transcript/process evidence read before
        // a replacement host was admitted for this conversation.
        if (verdict?.currentTurnIdle === false) return "working";
        const host = verdict?.hostEvidence;
        const processGone = !!host?.expected && (!host.present || !!host.expected.startIdentity && !!host.observedIdentity && host.expected.startIdentity !== host.observedIdentity);
        if (verdict?.state === "settled" && !processGone && verdict.currentTurnIdle !== true) return "unknown";
        if (verdict?.state === "severed") {
          // The shared liveness verdict also covers stalled *live* hosts. Only
          // process absence or verified pid reuse is safe for restart admission.
          if (!processGone) return "unknown";
        }
        return verdict?.state ?? null;
      }
      catch { return null; } // Uncertain liveness always blocks admission.
    })());
    return verdicts.get(id)!;
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
      if (["running", "reviewing"].includes(cursor.state) && conversationId && await liveness(conversationId) === "severed") continue;
      stages.push({ pipelineId: pipeline.id, stageId: cursor.stageId, cursor: cursor.state, task: (pipeline.task ?? "").split("\n")[0]!.slice(0, 80), conversationId });
    }
    blockers.stages = stages.length;
    blockers.stageList = stages.slice(0, 20);
    const seats = ports.seats?.() ?? [];
    const runtime = await ports.runtimeSnapshot();
    const turns: BlockingTurn[] = [];
    const seen = new Set<string>();
    for (const session of runtime.sessions) {
      if (!["running", "interrupt_requested"].includes(session.turn) && !["registering", "recovering"].includes(session.host)) continue;
      // A fallback can publish unhosted/running while the registry still owns
      // a live process. Host labels alone cannot establish restart admission.
      const verdict = await liveness(session.conversationId);
      if (verdict === "severed" || verdict === "settled") { blockers.discounted!++; continue; }
      if (seen.has(session.conversationId)) continue;
      seen.add(session.conversationId);
      const stage = stages.find((stage) => stage.conversationId === session.conversationId);
      turns.push({ conversationId: session.conversationId, engine: session.sessionKey?.engine ?? "unknown",
        project: session.cwd ? projectInfoFromCwd(session.cwd)?.project ?? null : null,
        stage: stage ? { pipelineId: stage.pipelineId, stageId: stage.stageId } : null,
        seat: seats.some((seat) => seat.conversationId === session.conversationId) });
    }
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
