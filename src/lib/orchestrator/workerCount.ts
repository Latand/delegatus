import { agentRegistry } from "@/lib/agent/registry";
import fs from "node:fs";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { seatProjectNow } from "./seatProjectIdentity";
import { activeOrchestratorSeats, canonicalOrchestratorProject, orchestratorRevocations } from "./seats";
import { deputyConversationRefs } from "./deputies";

export interface WorkerCountSources {
  pipelines: () => readonly { project: string; state: string; closedAt?: string | null; hiddenAt?: string | null; dismissedAt?: string | null }[];
  seats: () => readonly { project: string; conversationId: string | null }[];
  children: () => readonly { conversationId: string; parentConversationId: string; pipeline: boolean; deputy: boolean }[];
  deputies?: () => readonly string[];
}
function workerSeats(parentIds: ReadonlySet<string>) {
  const active = activeOrchestratorSeats();
  const registry = agentRegistry();
  const parentContexts = parentIds.size ? registry.workerSeatContexts([...parentIds]) : new Map<string, { conversationId: string; directories: string[] }>();
  const resolvedParents = new Set([...parentIds, ...[...parentContexts.values()].map(context => context.conversationId)]);
  const historical = orchestratorRevocations().filter(seat => resolvedParents.has(seat.conversationId));
  const ids = [...new Set([...active.flatMap(seat => seat.conversationId ? [seat.conversationId] : []), ...historical.map(seat => seat.conversationId)])];
  const contexts = ids.length ? registry.workerSeatContexts(ids) : new Map<string, { conversationId: string; directories: string[] }>();
  const cwdOf = (id: string) => contexts.get(id)?.directories.find(directory => {
    try { return fs.statSync(directory).isDirectory(); } catch { return false; }
  }) ?? null;
  return [
    ...active.map(seat => ({ project: seatProjectNow(seat, cwdOf), conversationId: seat.conversationId ? contexts.get(seat.conversationId)?.conversationId ?? seat.conversationId : null })),
    ...historical.map(seat => ({ project: canonicalOrchestratorProject(seat.project), conversationId: contexts.get(seat.conversationId)?.conversationId ?? seat.conversationId })),
  ];
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
  const children = (sources.children ?? (() => agentRegistry().liveWorkerChildren()))();
  const parentIds = new Set(children.map(child => child.parentConversationId));
  const seats = new Map((sources.seats ?? (() => workerSeats(parentIds)))().flatMap(seat => seat.conversationId ? [[seat.conversationId, seat.project] as const] : []));
  const counted = new Set<string>();
  const deputies = new Set(sources.deputies ? sources.deputies() : deputyConversationRefs()?.conversationIds ?? []);
  for (const child of children) {
    const project = seats.get(child.parentConversationId);
    if (!project || child.pipeline || child.deputy || deputies.has(child.conversationId) || seats.has(child.conversationId) || counted.has(child.conversationId)) continue;
    counted.add(child.conversationId);
    add(project);
  }
  return { byProject, machine: [...byProject.values()].reduce((sum, count) => sum + count, 0) };
}
