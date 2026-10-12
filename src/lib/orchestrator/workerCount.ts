import { agentRegistry } from "@/lib/agent/registry";
import fs from "node:fs";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { seatProjectNow } from "./seatProjectIdentity";
import { activeOrchestratorSeats, canonicalOrchestratorProject } from "./seats";
import { deputyConversationRefs } from "./deputies";

export interface WorkerCountSources {
  pipelines: () => readonly { project: string; state: string; closedAt?: string | null; hiddenAt?: string | null; dismissedAt?: string | null }[];
  seats: () => readonly { project: string; conversationId: string | null }[];
  children: () => readonly { conversationId: string; parentConversationId: string; pipeline: boolean; deputy: boolean }[];
  deputies?: () => readonly string[];
}
function workerSeats() {
  const seats = activeOrchestratorSeats();
  const contexts = seats.length ? agentRegistry().workerSeatContexts(seats.flatMap(seat => seat.conversationId ? [seat.conversationId] : [])) : new Map<string, { conversationId: string; directories: string[] }>();
  const cwdOf = (id: string) => contexts.get(id)?.directories.find(directory => {
    try { return fs.statSync(directory).isDirectory(); } catch { return false; }
  }) ?? null;
  return seats.map(seat => ({ ...seat, project: seatProjectNow(seat, cwdOf), conversationId: seat.conversationId ? contexts.get(seat.conversationId)?.conversationId ?? seat.conversationId : null }));
}
export function projectWorkerCounts(sources: Partial<WorkerCountSources> = {}) {
  const byProject = new Map<string, number>();
  const add = (project: string) => {
    const key = canonicalOrchestratorProject(project);
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  };
  for (const lane of (sources.pipelines ?? loadPipelinesForList)()) {
    if (!lane.closedAt && !lane.hiddenAt && !lane.dismissedAt && (lane.state === "running" || lane.state === "provisioning")) add(lane.project);
  }
  const seats = new Map((sources.seats ?? workerSeats)().flatMap(seat => seat.conversationId ? [[seat.conversationId, seat.project] as const] : []));
  const counted = new Set<string>();
  const deputies = new Set(sources.deputies ? sources.deputies() : deputyConversationRefs()?.conversationIds ?? []);
  for (const child of (sources.children ?? (() => agentRegistry().liveWorkerChildren()))()) {
    const project = seats.get(child.parentConversationId);
    if (!project || child.pipeline || child.deputy || deputies.has(child.conversationId) || seats.has(child.conversationId) || counted.has(child.conversationId)) continue;
    counted.add(child.conversationId);
    add(project);
  }
  return { byProject, machine: [...byProject.values()].reduce((sum, count) => sum + count, 0) };
}
