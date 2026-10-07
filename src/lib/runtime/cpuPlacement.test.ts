import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CpuContainmentUnavailable, cpuScopeProperties, cpuSettings, invalidateCpuContainmentProbe, planAgentCpu, probeCpuContainment,
  verifyCpuScope, workAggregateCpuQuota, workloadForMemberships, workSliceProperties, wrapWorkCommand, type CpuContainment,
} from "./cpuPlacement";

const available: CpuContainment = { kind: "available", systemdVersion: 255 };
afterEach(() => invalidateCpuContainmentProbe());

test("the work slice gets three quarters of the logical CPUs and each work scope three", () => {
  expect(workAggregateCpuQuota(24)).toBe(1800);
  expect(workAggregateCpuQuota(6)).toBe(400);
  expect(workAggregateCpuQuota(1)).toBe(100);
  expect(cpuSettings({}, 24)).toEqual({ mode: "auto", scopeQuotaPercent: 300, aggregateQuotaPercent: 1800 });
  expect(cpuSettings({ DELEGATUS_AGENT_CPU: "off", DELEGATUS_WORK_SCOPE_CPU_QUOTA: "200%", DELEGATUS_WORK_CPU_QUOTA: "900" }, 24))
    .toEqual({ mode: "off", scopeQuotaPercent: 200, aggregateQuotaPercent: 900 });
  // Entry points fold DELEGATUS_X into LLV_X before the Viewer reads it.
  expect(cpuSettings({ LLV_AGENT_CPU: "off", LLV_WORK_CPU_QUOTA: "600" }, 24)).toMatchObject({ mode: "off", aggregateQuotaPercent: 600 });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try { expect(cpuSettings({ DELEGATUS_WORK_SCOPE_CPU_QUOTA: "lots" }, 24).scopeQuotaPercent).toBe(300); }
  finally { warn.mockRestore(); }
  // The kernel reads these as cpu.max "60000 20000" per scope and "360000 20000" for the slice.
  expect(cpuScopeProperties({ weight: 100, quotaPercent: 300, periodMs: 20 })).toEqual(["-p", "CPUWeight=100", "-p", "CPUQuota=300%", "-p", "CPUQuotaPeriodSec=20ms"]);
  expect(cpuScopeProperties({ weight: 1000, quotaPercent: null, periodMs: 20 })).toEqual(["-p", "CPUWeight=1000"]);
  expect(workSliceProperties(1800)).toEqual(["CPUWeight=100", "CPUQuota=1800%", "CPUQuotaPeriodSec=20ms"]);
});

test("pipeline and flow members are work; seats and bare conversations serve the operator", () => {
  expect(workloadForMemberships([{ kind: "pipeline" }])).toBe("work");
  expect(workloadForMemberships([{ kind: "orchestrator" }, { kind: "flow" }])).toBe("work");
  expect(workloadForMemberships([{ kind: "orchestrator" }])).toBe("operator");
  expect(workloadForMemberships(undefined)).toBe("operator");
});

test("the probe names why CPU placement is missing or does not apply", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cpu-probe-"));
  const manager = path.join(root, "user.slice/user-1000.slice/user@1000.service");
  fs.mkdirSync(manager, { recursive: true });
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids");
  fs.writeFileSync(path.join(manager, "cgroup.controllers"), "cpu memory pids");
  const calls: string[][] = [];
  let kernel = "1000\nmax 100000\nmax 100000\n";
  const options = { platform: "linux" as const, cgroupRoot: root, uid: 1000, container: false, slice: "test-agents.slice",
    runner: (command: string, args: string[]) => { calls.push([command, ...args]); return args[0] === "--version" ? "systemd 255 (255.4)" : kernel; } };
  try {
    expect(probeCpuContainment(options)).toEqual({ kind: "available", systemdVersion: 255 });
    const probe = calls.at(-1)!;
    expect(probe.slice(0, probe.indexOf("--") + 3)).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--expand-environment=no", "--slice=test-agents.slice", "-p", "CPUWeight=1000", "--", "/bin/sh", "-c"]);
    expect(probe.slice(-2)).toEqual(["delegatus-cpu-probe", root]);
    // systemd accepts the scope where an ancestor keeps the cpu controller off; the kernel files show it.
    kernel = "absent\nabsent\nabsent\n";
    expect(probeCpuContainment(options)).toEqual({ kind: "missing", reason: "the kernel applied no CPU controls to a scope in test-agents.slice; the cpu controller is off on one of its ancestors" });
    kernel = "1000\nmax 100000\nmax 100000\n";
    expect(probeCpuContainment({ ...options, platform: "darwin" }).kind).toBe("not-applicable");
    expect(probeCpuContainment({ ...options, container: true }).kind).toBe("not-applicable");
    expect(probeCpuContainment({ ...options, runner: (command, args) => args[0] === "--version" ? "systemd 241" : "" }))
      .toEqual({ kind: "missing", reason: "systemd 241 predates CPUQuotaPeriodSec (needs 242)" });
    expect(probeCpuContainment({ ...options, runner: (command, args) => { if (args[0] === "--version") return "systemd 255"; throw Object.assign(new Error("exit 1"), { stderr: "Failed to connect to bus: No medium found\n" }); } }))
      .toEqual({ kind: "missing", reason: "the user manager refused a CPU scope in test-agents.slice (Failed to connect to bus: No medium found)" });
    fs.writeFileSync(path.join(manager, "cgroup.controllers"), "memory pids");
    expect(probeCpuContainment(options)).toEqual({ kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" });
    fs.rmSync(path.join(root, "user.slice"), { recursive: true });
    expect(probeCpuContainment(options).kind).toBe("missing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("operator hosts get a high weight and no ceiling; work gets its slice quota once and a scope quota", () => {
  const calls: string[][] = [];
  const ports = { probe: () => available, cpus: 24, agentSlice: "test-agents.slice", workSlice: "test-agents-work.slice",
    runner: (command: string, args: string[]) => { calls.push([command, ...args]); return ""; } };
  expect(planAgentCpu("operator", {}, ports)).toEqual({ workload: "operator", slice: "test-agents.slice", weight: 1000, quotaPercent: null, periodMs: 20, systemdVersion: 255 });
  expect(calls).toEqual([]);
  const work = planAgentCpu("work", {}, ports);
  expect(work).toEqual({ workload: "work", slice: "test-agents-work.slice", weight: 100, quotaPercent: 300, periodMs: 20, systemdVersion: 255 });
  planAgentCpu("work", {}, ports);
  expect(calls).toEqual([["systemctl", "--user", "set-property", "--runtime", "test-agents-work.slice", "CPUWeight=100", "CPUQuota=1800%", "CPUQuotaPeriodSec=20ms"]]);
  expect(planAgentCpu("work", { DELEGATUS_AGENT_CPU: "off" }, ports)).toBeNull();
});

test("a work scope the kernel gives no quota is refused before any work runs", () => {
  const kernel = { scope: "60000 20000", slice: "360000 20000" };
  const work = { workload: "work" as const, slice: "test-agents-work.slice", weight: 100, quotaPercent: 300, periodMs: 20, systemdVersion: 255 };
  const runner = (command: string, args: string[]) => {
    expect(args).toEqual(expect.arrayContaining(["--slice=test-agents-work.slice", "CPUWeight=100", "CPUQuota=300%", "CPUQuotaPeriodSec=20ms"]));
    return `100\n${kernel.scope}\n${kernel.slice}\n`;
  };
  expect(verifyCpuScope(work, runner)).toBeNull();
  kernel.scope = "absent";
  expect(verifyCpuScope(work, runner)).toBe("the kernel applied no CPU quota to a scope in test-agents-work.slice (cpu.max absent)");
  Object.assign(kernel, { scope: "60000 20000", slice: "max 20000" });
  expect(verifyCpuScope(work, runner)).toBe("the kernel applied no aggregate CPU quota to test-agents-work.slice (cpu.max max 20000)");
  expect(verifyCpuScope(work, () => { throw Object.assign(new Error("exit 1"), { stderr: "Failed to start transient scope unit: Access denied\n" }); }))
    .toBe("the user manager refused a CPU scope in test-agents-work.slice (Failed to start transient scope unit: Access denied)");
});

test("a missing mechanism refuses work explicitly and leaves operator hosts running", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const missing = { probe: (): CpuContainment => ({ kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" }), runner: () => "" };
    expect(() => planAgentCpu("work", {}, missing)).toThrow(CpuContainmentUnavailable);
    expect(() => planAgentCpu("work", {}, missing)).toThrow("Set DELEGATUS_AGENT_CPU=off");
    expect(planAgentCpu("operator", {}, missing)).toBeNull();
    const refusedQuota = { probe: () => available, runner: () => { throw new Error("Access denied"); } };
    expect(() => planAgentCpu("work", {}, refusedQuota)).toThrow("the work slice quota could not be set (Access denied)");
    const notApplicable = { probe: (): CpuContainment => ({ kind: "not-applicable", reason: "CPU placement uses Linux cgroups" }), runner: () => "" };
    expect(planAgentCpu("work", {}, notApplicable)).toBeNull();
  } finally { warn.mockRestore(); }
});

test("a first-party heavy command keeps its argv and runs in its own work scope", () => {
  const ports = { probe: () => available, cpus: 24, workSlice: "test-agents-work.slice", runner: () => "" };
  const wrapped = wrapWorkCommand("git", ["push", "origin", "$literal"], { label: "publish push", env: {}, ports });
  expect(wrapped.command).toBe("systemd-run");
  expect(wrapped.args).toContain("--expand-environment=no");
  expect(wrapped.args.find((arg) => arg.startsWith("--unit="))).toMatch(/^--unit=delegatus-work-publish-push-[0-9a-f-]{12}\.scope$/);
  expect(wrapped.args).toContain("--slice=test-agents-work.slice");
  expect(wrapped.args).toContain("CPUQuota=300%");
  expect(wrapped.args.slice(-4)).toEqual(["git", "push", "origin", "$literal"]);
  expect(wrapWorkCommand("git", ["push"], { label: "x", env: { DELEGATUS_AGENT_CPU: "off" }, ports })).toEqual({ command: "git", args: ["push"] });
});
