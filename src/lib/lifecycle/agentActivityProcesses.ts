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

/** Resource scanner counterpart: use async process reads for background
    enrichment so Darwin and Windows never shell out synchronously. */
export function resourceActivityProcessReader(now: number = Date.now()): (pid: number) => Promise<NonNullable<AgentActivityFacts["workProcesses"]>> {
  let inventory: Promise<{ parents: Map<number, number>; argv: Map<number, string[]> }> | null = null;
  const snapshot = () => inventory ??= Promise.all([
    procBackend.resourcePpidMap?.() ?? Promise.resolve(procBackend.ppidMap()),
    procBackend.resourceListProcesses?.() ?? Promise.resolve(procBackend.listProcesses()),
  ]).then(([parents, processes]) => ({ parents, argv: new Map(processes.map(proc => [proc.pid, proc.argv])) }));
  return async (pid) => {
    const { parents, argv } = await snapshot();
    const children = descendantPids(pid, parents).filter(child => child !== pid && procBackend.pidAlive(child));
    const exited = await Promise.all(children.map(child => procBackend.resourceProcessExited?.(child) ?? Promise.resolve(procBackend.processExited(child))));
    return children.flatMap((child, index) => {
      if (exited[index]) return [];
      const commandArgv = argv.get(child);
      if (!commandArgv) return [];
      const binary = (commandArgv[0] ?? "").split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase();
      if (binary === "codex-code-mode-host") return [];
      const startedAt = processLaunchedAt(procBackend.processIdentity(child), { now: () => now });
      return startedAt === null ? [] : [{ startedAt, command: commandArgv.join(" ") }];
    });
  };
}
