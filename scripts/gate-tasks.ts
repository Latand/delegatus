import fs from "node:fs";
import path from "node:path";

// Real full pre-push: peak 189 tasks; kanban browser driver: 150 (2026-11-11).
// Four times the largest peak, rounded up to 64 tasks: ceil(189 * 4 / 64) * 64.
// This leaves room for thread/helper and test-concurrency variation while
// stopping recursive forks below 1,000 tasks. See docs/design/gate-task-limit.md.
export const GATE_TASKS_MAX = 768;
export const gateTaskProperties = () => ["-p", `TasksMax=${GATE_TASKS_MAX}`];
export const GATE_TASK_LIMIT_EXIT = 70;
export type GateTaskSnapshot = {
  max: string | null;
  peak: number | null;
  peakSource: "kernel" | "sampled";
  denied: number;
};

function optional(file: string): string | null {
  try { return fs.readFileSync(file, "utf8").trim(); }
  catch (error) {
    if (["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function count(value: string | null, name: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid ${name} counter`);
  return Number(value);
}

/** Read only this invocation's cgroup. Keep the last peak through unit removal;
 * old kernels without pids.peak explicitly report a sampled lower bound. */
export class GateTasks {
  snapshot: GateTaskSnapshot = { max: null, peak: null, peakSource: "sampled", denied: 0 };
  constructor(readonly directory: string) {}

  sample(): GateTaskSnapshot {
    const max = optional(path.join(this.directory, "pids.max"));
    if (max === null) return this.snapshot;
    if (max !== "max") count(max, "pids.max");
    const kernelPeak = count(optional(path.join(this.directory, "pids.peak")), "pids.peak");
    const peak = kernelPeak ?? count(optional(path.join(this.directory, "pids.current")), "pids.current");
    const events = optional(path.join(this.directory, "pids.events"));
    // systemd may remove the group between two reads in the outer client.
    if (events === null && !fs.existsSync(this.directory)) return this.snapshot;
    const denied = count(events === null ? null : /^max (\d+)$/m.exec(events)?.[1] ?? "invalid", "pids.events:max");
    if (denied === null) throw new Error("pids controller has no readable pids.events:max counter");
    this.snapshot = {
      max, peak: peak === null ? this.snapshot.peak : Math.max(this.snapshot.peak ?? 0, peak),
      peakSource: kernelPeak === null ? this.snapshot.peakSource : "kernel",
      denied: Math.max(this.snapshot.denied, denied),
    };
    return this.snapshot;
  }

  verify(limit: number): "limited" | "unavailable" {
    const snapshot = this.sample();
    if (snapshot.max === null) return "unavailable";
    if (snapshot.max !== String(limit)) throw new Error(`requested TasksMax=${limit}, kernel pids.max=${snapshot.max}`);
    return "limited";
  }
}

export function gateTaskResult(unit: string, snapshot: GateTaskSnapshot): string {
  return `gate-slot: ${unit}: pids.peak=${snapshot.peak ?? "unavailable"}${snapshot.peakSource === "sampled" && snapshot.peak !== null ? " (sampled lower bound)" : ""} pids.max=${snapshot.max ?? "unavailable"} pids.events:max=${snapshot.denied}`;
}

export function gateTaskFailure(unit: string, snapshot: GateTaskSnapshot): string {
  return `GATE_TASK_LIMIT_REACHED: task limit reached in ${unit} (pids.max=${snapshot.max}, pids.events:max=${snapshot.denied})`;
}

/** The last result belongs to the file's outer runner. Nested fixture gates
 * may deliberately fail; their diagnostics cannot refuse a successful file. */
export function gateTaskDiagnostics(output: string): { peak: string | null; failure: string | null } {
  const result = [...output.matchAll(/^gate-slot: (\S+\.service): (pids\.peak=.*)$/gm)].at(-1);
  if (!result) return { peak: null, failure: null };
  const lines = output.split("\n").filter(line => line.includes(result[1]!));
  const failure = ["GATE_TASK_LIMIT_REACHED", "GATE_TASK_LIMIT_UNAVAILABLE", "GATE_TASK_OBSERVATION_FAILED", "GATE_UNIT_START_FAILED"]
    .map(name => lines.find(line => line.startsWith(`${name}:`))).find(Boolean) ?? null;
  return { peak: `${result[1]}: ${result[2]}`, failure };
}

export function warnGateTaskFallback(reason: string, env: NodeJS.ProcessEnv = process.env, warn = console.error) {
  if (env.LLV_GATE_TASK_WARNING_SHOWN === "1") return;
  warn(`gate-slot: task limit unavailable: ${reason}; continuing with existing containment`);
  env.LLV_GATE_TASK_WARNING_SHOWN = "1";
}
