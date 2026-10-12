import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { processLaunchedAt } from "@/lib/runtime/liveness";
import type { AgentActivityFacts } from "./agentActivity";

/** One process-table read per observation, then only the host's descendants. */
export function activityProcessReader(now: number = Date.now()): (pid: number) => NonNullable<AgentActivityFacts["workProcesses"]> {
  let parents: Map<number, number> | null = null;
  return (pid) => {
    parents ??= procBackend.ppidMap();
    return descendantPids(pid, parents).flatMap(child => {
      if (child === pid || !procBackend.pidAlive(child) || procBackend.processExited(child)) return [];
      const startedAt = processLaunchedAt(procBackend.processIdentity(child), { now: () => now });
      const command = procBackend.readArgv(child).join(" ");
      return startedAt === null || !command ? [] : [{ startedAt, command }];
    });
  };
}
