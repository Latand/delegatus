import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMemoryCell, GIB, type MemoryMode, type AgentMemoryPlan } from "../agentMemory";

/** A private cgroup stand-in; the runner never reaches the user manager. */
export function fakeAgentMemory(options: { mode?: MemoryMode; admissionFailure?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-fake-memory-"));
  const plan: AgentMemoryPlan = { mechanism: "scope", mode: options.mode, platform: "linux", limitBytes: 15 * GIB, budgetBytes: 106 * GIB, reserveBytes: 19 * GIB, totalBytes: 125 * GIB, score: 500,
    unit: "delegatus-agent-test-host.scope", slice: "delegatus-agents-test.slice", viewerUnit: null, systemdVersion: 255 };
  const group = `/${plan.slice}/${plan.unit}`;
  const file = path.join(root, group, "memory.events");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "oom 0\noom_kill 0\n");
  const cell = new AgentMemoryCell(plan, { cgroupRoot: root, cgroupForPid: () => options.admissionFailure ? null : group, runner: () => "" });
  return { cell, kill: () => { fs.writeFileSync(file, "oom 1\noom_kill 1\n"); cell.readEvents(); }, dispose: () => { cell.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
