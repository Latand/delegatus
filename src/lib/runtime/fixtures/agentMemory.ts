import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMemoryCell, GIB, tickAgentMemoryWatchdogs, type MemoryMode, type AgentMemoryPlan } from "../agentMemory";

/** A private cgroup stand-in; the runner never reaches the user manager. */
export function fakeAgentMemory(options: { mode?: MemoryMode; admissionFailure?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-fake-memory-"));
  const plan: AgentMemoryPlan = { mechanism: "scope", mode: options.mode, platform: "linux", limitBytes: 15 * GIB, budgetBytes: 106 * GIB, reserveBytes: 19 * GIB, totalBytes: 125 * GIB, score: 500,
    unit: "delegatus-agent-test-host.scope", slice: "delegatus-agents-test.slice", viewerUnit: null, systemdVersion: 255 };
  const group = `/${plan.slice}/${plan.unit}`;
  const file = path.join(root, group, "memory.events");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "oom 0\noom_kill 0\n");
  const reaps: string[] = [];
  const cell = new AgentMemoryCell(plan, { cgroupRoot: root, cgroupForPid: () => options.admissionFailure ? null : group,
    runner: (command, args) => { reaps.push([command, ...args].join(" ")); return ""; } });
  return { cell, reaps, kill: () => { fs.writeFileSync(file, "oom 1\noom_kill 1\n"); cell.readEvents(); }, dispose: () => { cell.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** An owned child and a surviving tool; every signal stays inside this fixture. */
export function fakeHostMemory(pid: number, platform: NodeJS.Platform, mechanism: "scope" | "watchdog") {
  let rootIdentity: string | null = `${pid}:owned`;
  const descendant = pid + 1;
  const signals: number[] = [];
  const processIdentity = (target: number) => target === pid ? rootIdentity : `${target}:owned`;
  const scope = mechanism === "scope" ? fakeAgentMemory() : null;
  const cell = scope?.cell ?? new AgentMemoryCell({ mechanism: "watchdog", platform, limitBytes: 100, budgetBytes: 200,
    reserveBytes: GIB, totalBytes: 2 * GIB, score: 500, unit: null, slice: "delegatus-agents-test.slice", viewerUnit: null, systemdVersion: 255 }, {
    identity: processIdentity, readPpid: () => pid,
    sample: () => [{ pid, identity: `${pid}:owned`, rss: 101, name: "agent" }, { pid: descendant, identity: `${descendant}:owned`, rss: 1, name: "surviving-tool" }],
    kill: (target) => { signals.push(target); },
  });
  return { cell, signals, scopeReaps: scope?.reaps ?? [], processIdentity, pidAlive: () => rootIdentity !== null,
    kill: () => scope ? scope.kill() : tickAgentMemoryWatchdogs([cell]),
    rootExit: (reused: boolean) => { rootIdentity = reused ? `${pid}:replacement` : null; },
    dispose: () => scope ? scope.dispose() : cell.close(),
  };
}
