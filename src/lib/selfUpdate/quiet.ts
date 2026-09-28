/* Restart admission is read afresh for each role, including after web swaps. */
import type { RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import type { StoredViewSession } from "@/lib/view/types";
import type { Snapshot } from "./types";

export interface QuietBlockers {
  turns: number;
  stages: number;
  operatorActiveAt: string | null;
  busy: boolean;
  unreadable: string | null;
  memoryMb: number | null;
}
export interface QuietPorts {
  runtimeSnapshot(): Promise<Pick<RuntimeSnapshot, "sessions">>;
  pipelines(): readonly Pipeline[];
  presence(now: number): readonly StoredViewSession[];
  memoryAvailableMb?(): number;
}
export async function probeQuiet(snapshot: Snapshot, ports: QuietPorts, now: number): Promise<{ quiet: boolean; blockers: QuietBlockers }> {
  const blockers: QuietBlockers = { turns: 0, stages: 0, operatorActiveAt: null, busy: snapshot.busy !== null || snapshot.processes.web.state !== "healthy" || snapshot.processes.runtimeHost.state !== "healthy", unreadable: null, memoryMb: null };
  if (ports.memoryAvailableMb) {
    const mb = ports.memoryAvailableMb();
    if (mb < 4_096) blockers.memoryMb = mb;
  }
  try {
    const runtime = await ports.runtimeSnapshot();
    blockers.turns = runtime.sessions.filter((session) => ["running", "interrupt_requested"].includes(session.turn) || ["registering", "recovering"].includes(session.host)).length;
  } catch (error) {
    blockers.unreadable = error instanceof Error ? error.message : String(error);
  }
  try {
    blockers.stages = ports.pipelines().filter((pipeline) => pipeline.state === "running" && pipeline.cursor && ["spawning", "running", "reviewing", "committing"].includes(pipeline.cursor.state)).length;
    const latest = ports.presence(now).filter((session) => now - session.lastInteractionAt < 10 * 60_000).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)[0];
    blockers.operatorActiveAt = latest ? new Date(latest.lastInteractionAt).toISOString() : null;
  } catch (error) {
    blockers.unreadable = error instanceof Error ? error.message : String(error);
  }
  return { quiet: !blockers.turns && !blockers.stages && !blockers.operatorActiveAt && !blockers.busy && !blockers.unreadable && blockers.memoryMb === null, blockers };
}
