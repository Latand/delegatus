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
      const argv = procBackend.readArgv(child);
      const binary = (argv[0] ?? "").split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase();
      // This executor persists between calls and is launched lazily after the
      // first turn starts. Its outstanding call, rather than its lifetime,
      // supplies inline-code activity; descendants still qualify below.
      if (binary === "codex-code-mode-host") return [];
      const startedAt = processLaunchedAt(procBackend.processIdentity(child), { now: () => now });
      const command = argv.join(" ");
      return startedAt === null ? [] : [{ startedAt, command }];
    });
  };
}
