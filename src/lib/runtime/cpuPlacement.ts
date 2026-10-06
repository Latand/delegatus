import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/*
 * CPU placement for agent hosts and heavy work (docs/design/cpu-placement.md).
 *
 * Operator hosts keep their scopes in `delegatus-agents.slice` with a high CPU
 * weight. Pipeline and flow hosts, headless runs, gates and the first-party
 * builds the service starts go to the subordinate `delegatus-agents-work.slice`,
 * each scope with a low weight and its own quota, the slice with an aggregate
 * quota. Placement is decided apart from the memory mode: an agent whose memory
 * mode is `watchdog` or `off` still gets its CPU scope.
 *
 * Where the mechanism should exist (Linux outside a container) and cannot be
 * used, work is refused with the reason and the setting that opts out. Operator
 * hosts never wait on it.
 */

export type AgentWorkload = "operator" | "work";
export const AGENT_SLICE = "delegatus-agents.slice";
export const WORK_SLICE = "delegatus-agents-work.slice";
export const OPERATOR_CPU_WEIGHT = 1000;
export const WORK_CPU_WEIGHT = 100;
/** Three CPU-equivalents per work scope. */
export const WORK_SCOPE_CPU_QUOTA = 300;
export const CPU_QUOTA_PERIOD_MS = 20;
/** CPUQuotaPeriodSec appeared in systemd 242. */
const MIN_SYSTEMD = 242;

/** Three quarters of the logical CPUs, in whole CPUs, as a systemd percentage. */
export function workAggregateCpuQuota(cpus: number): number {
  return Math.max(100, Math.floor(Math.max(1, cpus) * 0.75) * 100);
}

export interface AgentCpuPlan {
  workload: AgentWorkload;
  slice: string;
  weight: number;
  /** Percent of one CPU per scope; null leaves the scope without a ceiling. */
  quotaPercent: number | null;
  periodMs: number;
  systemdVersion: number;
}

export type CpuContainment =
  | { kind: "available"; systemdVersion: number }
  | { kind: "not-applicable"; reason: string }
  | { kind: "missing"; reason: string };

/** Pipeline and flow members are work; every other host serves the operator. */
export function workloadForMemberships(memberships: readonly { kind: string }[] | undefined): AgentWorkload {
  return (memberships ?? []).some((membership) => membership.kind === "pipeline" || membership.kind === "flow") ? "work" : "operator";
}

export class CpuContainmentUnavailable extends Error {
  constructor(reason: string) {
    super(`CPU containment for agent work is unavailable: ${reason}. Set DELEGATUS_AGENT_CPU=off to run work without CPU placement.`);
    this.name = "CpuContainmentUnavailable";
  }
}

export type CpuRunner = (command: string, args: string[]) => string;
const run: CpuRunner = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
const diagnostics = new Set<string>();
function diagnostic(key: string, message: string) { if (!diagnostics.has(key)) { diagnostics.add(key); console.warn(`[delegatus] ${message}`); } }

/** Entry points fold `DELEGATUS_X` into `LLV_X` (bin/envAlias.mjs); read both. */
export function delegatusSetting(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return env[`DELEGATUS_${name}`] ?? env[`LLV_${name}`];
}

function percent(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = /^(\d+)%?$/.exec(value.trim());
  const number = parsed ? Number(parsed[1]) : NaN;
  if (Number.isSafeInteger(number) && number >= 1) return number;
  diagnostic(name, `Invalid ${name}; using ${fallback}%.`);
  return fallback;
}

export interface CpuSettings {
  mode: "auto" | "off";
  scopeQuotaPercent: number;
  aggregateQuotaPercent: number;
}

export function cpuSettings(env: Readonly<Record<string, string | undefined>> = process.env, cpus = os.availableParallelism()): CpuSettings {
  const raw = delegatusSetting(env, "AGENT_CPU") ?? "auto";
  if (raw !== "auto" && raw !== "off") diagnostic("DELEGATUS_AGENT_CPU", "Invalid DELEGATUS_AGENT_CPU; using auto.");
  return {
    mode: raw === "off" ? "off" : "auto",
    scopeQuotaPercent: percent(delegatusSetting(env, "WORK_SCOPE_CPU_QUOTA"), WORK_SCOPE_CPU_QUOTA, "DELEGATUS_WORK_SCOPE_CPU_QUOTA"),
    aggregateQuotaPercent: percent(delegatusSetting(env, "WORK_CPU_QUOTA"), workAggregateCpuQuota(cpus), "DELEGATUS_WORK_CPU_QUOTA"),
  };
}

/** `systemd-run -p` arguments for one scope. */
export function cpuScopeProperties(plan: Pick<AgentCpuPlan, "weight" | "quotaPercent" | "periodMs">): string[] {
  return ["-p", `CPUWeight=${plan.weight}`,
    ...(plan.quotaPercent === null ? [] : ["-p", `CPUQuota=${plan.quotaPercent}%`, "-p", `CPUQuotaPeriodSec=${plan.periodMs}ms`])];
}

/** `systemctl set-property` assignments for the aggregate work slice. */
export function workSliceProperties(aggregateQuotaPercent: number): string[] {
  return [`CPUWeight=${WORK_CPU_WEIGHT}`, `CPUQuota=${aggregateQuotaPercent}%`, `CPUQuotaPeriodSec=${CPU_QUOTA_PERIOD_MS}ms`];
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return text.trim().split("\n")[0]!.slice(0, 200);
}

/** One probe scope proves the user manager can place CPU under `slice`. */
export function probeCpuContainment(options: { platform: NodeJS.Platform; cgroupRoot: string; uid: number; runner: CpuRunner; container: boolean; slice: string }): CpuContainment {
  if (options.platform !== "linux") return { kind: "not-applicable", reason: "CPU placement uses Linux cgroups" };
  if (options.container) return { kind: "not-applicable", reason: "inside a container the container runtime owns CPU limits" };
  if (!fs.existsSync(path.join(options.cgroupRoot, "cgroup.controllers"))) return { kind: "missing", reason: "cgroup v2 is not mounted" };
  const manager = path.join(options.cgroupRoot, `user.slice/user-${options.uid}.slice/user@${options.uid}.service/cgroup.controllers`);
  let delegated = "";
  try { delegated = fs.readFileSync(manager, "utf8"); } catch { return { kind: "missing", reason: "the systemd user manager is not running for this user" }; }
  if (!delegated.split(/\s+/).includes("cpu")) return { kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" };
  let version: number;
  try { version = Number(/systemd\s+(\d+)/.exec(options.runner("systemd-run", ["--version"]))?.[1]); }
  catch (error) { return { kind: "missing", reason: `systemd-run is unavailable (${firstLine(error)})` }; }
  if (!(version >= MIN_SYSTEMD)) return { kind: "missing", reason: `systemd ${version || "unknown"} predates CPUQuotaPeriodSec (needs ${MIN_SYSTEMD})` };
  try {
    options.runner("systemd-run", ["--user", "--scope", "--quiet", "--collect", ...(version >= 254 ? ["--expand-environment=no"] : []),
      `--slice=${options.slice}`, "-p", `CPUWeight=${WORK_CPU_WEIGHT}`, "--", "true"]);
  } catch (error) { return { kind: "missing", reason: `the user manager refused a CPU scope (${firstLine(error)})` }; }
  return { kind: "available", systemdVersion: version };
}

export interface CpuPorts {
  probe?: () => CpuContainment;
  runner?: CpuRunner;
  cpus?: number;
  /** Test seams; production uses the slices above. */
  agentSlice?: string;
  workSlice?: string;
}

let cachedContainment: CpuContainment | null = null;
const configuredSlices = new Set<string>();
let testPorts: CpuPorts | null = null;
export function invalidateCpuContainmentProbe(): void { cachedContainment = null; configuredSlices.clear(); }
/** Points every caller that passes no ports at private slices or fakes. */
export function setCpuPortsForTests(ports: CpuPorts | null): void { testPorts = ports; invalidateCpuContainmentProbe(); }

/**
 * The CPU placement for one launch, or null when this install runs without it.
 * Throws CpuContainmentUnavailable for work when the mechanism is expected and
 * missing, including a failed aggregate quota on the work slice.
 */
export function planAgentCpu(workload: AgentWorkload, env: Readonly<Record<string, string | undefined>> = process.env, ports: CpuPorts = testPorts ?? {}): AgentCpuPlan | null {
  const settings = cpuSettings(env, ports.cpus);
  if (settings.mode === "off") return null;
  const agentSlice = ports.agentSlice ?? AGENT_SLICE;
  const workSlice = ports.workSlice ?? WORK_SLICE;
  const runner = ports.runner ?? run;
  // A missing mechanism is probed again next time: a user manager that was
  // briefly unreachable must not refuse work until the Viewer restarts.
  const containment = ports.probe ? ports.probe() : cachedContainment ?? probeCpuContainment({ platform: process.platform, cgroupRoot: "/sys/fs/cgroup",
    uid: process.getuid?.() ?? -1, runner, container: fs.existsSync("/.dockerenv") || env.LLV_DOCKER_NSENTER_SHIMS === "1", slice: agentSlice });
  if (!ports.probe && containment.kind !== "missing") cachedContainment = containment;
  if (containment.kind === "not-applicable") { diagnostic("cpu-na", `Agent CPU placement is off: ${containment.reason}.`); return null; }
  if (containment.kind === "missing") {
    if (workload === "work") throw new CpuContainmentUnavailable(containment.reason);
    diagnostic("cpu-missing", `Operator agents run without CPU placement: ${containment.reason}.`);
    return null;
  }
  if (workload === "operator") {
    return { workload, slice: agentSlice, weight: OPERATOR_CPU_WEIGHT, quotaPercent: null, periodMs: CPU_QUOTA_PERIOD_MS, systemdVersion: containment.systemdVersion };
  }
  const key = `${workSlice}:${settings.aggregateQuotaPercent}`;
  if (!configuredSlices.has(key)) {
    try { runner("systemctl", ["--user", "set-property", "--runtime", workSlice, ...workSliceProperties(settings.aggregateQuotaPercent)]); }
    catch (error) {
      if (!ports.probe) cachedContainment = null;
      throw new CpuContainmentUnavailable(`the work slice quota could not be set (${firstLine(error)})`);
    }
    configuredSlices.add(key);
  }
  return { workload, slice: workSlice, weight: WORK_CPU_WEIGHT, quotaPercent: settings.scopeQuotaPercent, periodMs: CPU_QUOTA_PERIOD_MS, systemdVersion: containment.systemdVersion };
}

/**
 * Wraps a first-party heavy command (a publication push and its hooks, a
 * release build) in its own work scope. `systemd-run --scope` executes the
 * command in place, so its PID, process group and inherited descriptors stay
 * the caller's.
 */
export function wrapWorkCommand(command: string, args: string[], options: { label: string; env?: Readonly<Record<string, string | undefined>>; ports?: CpuPorts }): { command: string; args: string[] } {
  const plan = planAgentCpu("work", options.env ?? process.env, options.ports ?? testPorts ?? {});
  if (!plan) return { command, args };
  const label = options.label.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  return { command: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect",
    ...(plan.systemdVersion >= 254 ? ["--expand-environment=no"] : []),
    `--unit=delegatus-work-${label}-${randomUUID().slice(0, 12)}.scope`, `--slice=${plan.slice}`, "--description=Delegatus work",
    ...cpuScopeProperties(plan), "--", command, ...args] };
}
