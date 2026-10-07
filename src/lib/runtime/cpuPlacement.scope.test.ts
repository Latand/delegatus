import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GIB, planAgentMemory, setAgentMemoryPortsForTests, wrapAgentCommand } from "./agentMemory";
import { invalidateCpuContainmentProbe, planAgentCpu, setCpuPortsForTests, wrapWorkCommand, type CpuPorts } from "./cpuPlacement";
import { CpuPressureGate } from "./cpuPressure";
import { startupAdoptionCell } from "./fixtures/startupAdoptionCell";

/*
 * Real transient scopes in private slices (`llvcputest…`), created and torn
 * down here. Nothing touches delegatus.slice, the live agent slices or a
 * service unit. Runs where a systemd user manager delegates the cpu controller.
 */
const uid = process.getuid?.() ?? -1;
const managerControllers = (() => {
  try { return fs.readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, "utf8"); } catch { return ""; }
})();
const reachable = process.platform === "linux" && managerControllers.split(/\s+/).includes("cpu")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const scopeTest = reachable ? test : test.skip;

const runner = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
const prefix = `llvcputest${process.pid}x${randomUUID().slice(0, 6)}`;
const slices = { top: `${prefix}.slice`, agents: `${prefix}-agents.slice`, work: `${prefix}-agents-work.slice`,
  // A work slice whose scopes get no cpu controller, and a branch where the agents slice gets none either.
  workOff: `${prefix}-agents-off.slice`, pinned: `${prefix}-agents-pinned.slice`, off: `${prefix}-off.slice`, offAgents: `${prefix}-off-agents.slice`, offWork: `${prefix}-off-agents-work.slice` };
const ports: CpuPorts = { agentSlice: slices.agents, workSlice: slices.work, cpus: 24, runner };
const env = { DELEGATUS_AGENT_CPU: "auto", DELEGATUS_WORK_CPU_QUOTA: "1800" };
const units: string[] = [];
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cpu-scope-"));

const quiet = (command: string, args: string[]) => { try { runner(command, args); } catch { /* Already collected. */ } };
afterEach(() => { for (const unit of units.splice(0)) quiet("systemctl", ["--user", "stop", unit]); });
afterAll(() => {
  setCpuPortsForTests(null);
  quiet("systemctl", ["--user", "stop", slices.offWork, slices.offAgents, slices.off, slices.workOff, slices.pinned, slices.work, slices.agents, slices.top]);
  quiet("systemctl", ["--user", "revert", slices.work, slices.workOff, slices.pinned, slices.off, slices.offWork]);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const cgroupOf = (pid: number | "self") => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((line) => line.startsWith("0::"))!.slice(3);
const control = (group: string, file: string) => fs.readFileSync(path.join("/sys/fs/cgroup", group, file), "utf8").trim();
const ppid = (pid: number) => { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Prints the command's own cgroup and kernel controls, then the parent's. */
const REPORT = 'g=$(sed -n "s/^0:://p" /proc/self/cgroup); p=$(dirname "$g"); echo "$g|$(cat /sys/fs/cgroup$g/cpu.weight)|$(cat /sys/fs/cgroup$g/cpu.max)|$(cat /sys/fs/cgroup$g/memory.max)|$(cat /sys/fs/cgroup$p/cpu.max)"';
const report = (stdout: string) => { const [group, weight, max, memory, parentMax] = stdout.trim().split("\n").at(-1)!.split("|"); return { group, weight, max, memory, parentMax }; };

scopeTest("an operator host scope sits in the agents slice with weight 1000 and no ceiling", () => {
  const cpu = planAgentCpu("operator", env, ports)!;
  const plan = { ...planAgentMemory({ engine: "test", sessionKey: "operator", liveAgents: 1, cpu }, { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "scope" },
    { totalBytes: 16 * GIB, probe: () => 255, runner: () => "" })!, slice: slices.agents, viewerUnit: null };
  units.push(plan.unit!);
  const wrapped = wrapAgentCommand(plan, "/bin/sh", ["-c", REPORT]);
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: "utf8" });
  expect(result.stderr).toBe("");
  const seen = report(result.stdout);
  expect(seen.group).toEndWith(`/${slices.top}/${slices.agents}/${plan.unit}`);
  expect(seen.weight).toBe("1000");
  expect(seen.max).toBe("max 100000");
  expect(Number(seen.memory)).toBe(plan.limitBytes);
});

scopeTest("a work host keeps its descendants and an orphaned fixture in its quota-bound work scope", async () => {
  const cpu = planAgentCpu("work", env, ports)!;
  const plan = { ...planAgentMemory({ engine: "test", sessionKey: "work", liveAgents: 1, cpu }, { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "scope" },
    { totalBytes: 16 * GIB, probe: () => 255, runner: () => "" })!, slice: slices.agents, viewerUnit: null };
  units.push(plan.unit!);
  const script = 'sleep 60 & echo "descendant $!"; (setsid sleep 60 </dev/null >/dev/null 2>&1 & echo "orphan $!"); echo ready; exec sleep 60';
  const wrapped = wrapAgentCommand(plan, "/bin/bash", ["-c", script]);
  const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { lines.push(...chunk.split("\n").filter(Boolean)); if (lines.includes("ready")) resolve(); });
    child.once("error", reject);
    child.once("close", () => reject(new Error("work scope ended before its fixture was ready")));
  });
  const descendant = Number(lines.find((line) => line.startsWith("descendant "))!.split(" ")[1]);
  const orphan = Number(lines.find((line) => line.startsWith("orphan "))!.split(" ")[1]);
  expect(ppid(descendant)).toBe(child.pid!);
  expect(ppid(orphan)).not.toBe(child.pid!);
  const group = cgroupOf(child.pid!);
  expect(group).toEndWith(`/${slices.top}/${slices.agents}/${slices.work}/${plan.unit}`);
  for (const pid of [descendant, orphan]) expect(cgroupOf(pid)).toBe(group);
  expect(control(group, "cpu.max")).toBe("60000 20000");
  expect(control(group, "cpu.weight")).toBe("100");
  expect(Number(control(group, "memory.max"))).toBe(plan.limitBytes);
  expect(control(group, "memory.swap.max")).toBe("0");
  expect(control(path.dirname(group), "cpu.max")).toBe("360000 20000");
  // Stopping the unit by its recorded name ends every member, the orphan included.
  runner("systemctl", ["--user", "stop", plan.unit!]);
  for (let i = 0; i < 50 && [child.pid!, descendant, orphan].some(alive); i++) await Bun.sleep(100);
  expect([child.pid!, descendant, orphan].filter(alive)).toEqual([]);
}, 30_000);

const taskset = Bun.which("taskset");
const onlineCpus = Number(spawnSync("getconf", ["_NPROCESSORS_ONLN"], { encoding: "utf8" }).stdout.trim());
// The first CPU this process may use: a cpuset (a work slice under AllowedCPUs=6-23) can leave CPU 0 out.
const allowedCpu = reachable ? /^Cpus_allowed_list:\s*(\d+)/m.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1] : undefined;
(reachable && taskset && allowedCpu && onlineCpus > 1 ? test : test.skip)("a caller pinned to one CPU and a gate give the work slice the same machine-wide quota", () => {
  const expected = `${Math.floor(onlineCpus * 0.75) * 100 * 200} 20000`;
  // Inherited CPU settings (a hook's own gate) must not choose the quota.
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: sandbox, NODE_ENV: "test",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, DELEGATUS_AGENT_CPU: "auto", DELEGATUS_CPU_PRESSURE: "off",
    LLV_GATE_SLICE: slices.pinned, LLV_GATE_SLOTS: "1", LLV_GATE_LOCK_DIR: sandbox };
  const sliceMax = () => {
    const unit = `${prefix}-pinned-${randomUUID().slice(0, 8)}.scope`;
    units.push(unit);
    return report(runner("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--slice=${slices.pinned}`, `--unit=${unit}`, "/bin/sh", "-c", REPORT])).parentMax;
  };
  const lower = () => runner("systemctl", ["--user", "set-property", "--runtime", slices.pinned, "CPUQuota=100%", "CPUQuotaPeriodSec=20ms"]);
  lower();
  expect(sliceMax()).toBe("20000 20000");
  const runtime = spawnSync(taskset!, ["-c", allowedCpu!, process.execPath, "-e", `const { planAgentCpu } = await import(${JSON.stringify(path.join(import.meta.dir, "cpuPlacement.ts"))});
planAgentCpu("work", process.env, { agentSlice: ${JSON.stringify(slices.agents)}, workSlice: ${JSON.stringify(slices.pinned)} });
console.log((await import("node:os")).availableParallelism());`], { env: childEnv, encoding: "utf8" });
  expect([runtime.status, runtime.stderr, runtime.stdout.trim()]).toEqual([0, "", "1"]);
  expect(sliceMax()).toBe(expected);
  lower();
  const gate = spawnSync(taskset!, ["-c", allowedCpu!, "/bin/bash", path.join(import.meta.dir, "../../../scripts/gate-slot.sh"), "/bin/sh", "-c", `nproc; ${REPORT}`], { env: childEnv, encoding: "utf8" });
  expect(gate.status).toBe(0);
  expect(gate.stdout.split("\n")[0]).toBe("1");
  expect(report(gate.stdout).parentMax).toBe(expected);
}, 30_000);

scopeTest("memory mode off still gets the work scope's CPU quota", () => {
  const cpu = planAgentCpu("work", env, ports)!;
  const plan = planAgentMemory({ engine: "test", sessionKey: "off", liveAgents: 1, cpu }, { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "off" })!;
  units.push(plan.unit!);
  const wrapped = wrapAgentCommand({ ...plan, viewerUnit: null }, "/bin/sh", ["-c", REPORT]);
  const seen = report(spawnSync(wrapped.command, wrapped.args, { encoding: "utf8" }).stdout);
  expect(seen.group).toEndWith(`/${slices.work}/${plan.unit}`);
  expect([seen.max, seen.memory, seen.parentMax]).toEqual(["60000 20000", "max", "360000 20000"]);
});

scopeTest("a publication push or release build runs in its own work scope", async () => {
  const wrapped = wrapWorkCommand("/bin/sh", ["-c", REPORT], { label: "publish-push", env, ports });
  units.push(wrapped.args.find((arg) => arg.startsWith("--unit="))!.slice("--unit=".length));
  const seen = report(spawnSync(wrapped.command, wrapped.args, { encoding: "utf8" }).stdout);
  expect(seen.group).toMatch(new RegExp(`/${slices.work}/delegatus-work-publish-push-[0-9a-f-]{12}\\.scope$`));
  expect([seen.weight, seen.max, seen.parentMax]).toEqual(["100", "60000 20000", "360000 20000"]);

  // The self-update port wraps install and build the same way.
  const { realPorts } = await import("@/lib/selfUpdate/steps");
  const { buildEnv } = await import("@/lib/selfUpdate/env");
  const previous = process.env.LLV_AGENT_CPU;
  process.env.LLV_AGENT_CPU = "auto";
  setCpuPortsForTests(ports);
  const lines: string[] = [];
  try {
    const code = await realPorts(() => {}).run(["/bin/sh", "-c", REPORT], { cwd: sandbox, env: { ...buildEnv(sandbox), TMPDIR: sandbox }, onLine: (line) => lines.push(line), work: "update-build" });
    expect(code).toBe(0);
  } finally {
    setCpuPortsForTests(null);
    if (previous === undefined) delete process.env.LLV_AGENT_CPU; else process.env.LLV_AGENT_CPU = previous;
  }
  const build = report(lines.join("\n"));
  expect(build.group).toMatch(new RegExp(`/${slices.work}/delegatus-work-update-build-[0-9a-f-]{12}\\.scope$`));
  expect(build.max).toBe("60000 20000");
});

scopeTest("a headless review run launches into the work slice", async () => {
  const { launchDetached } = await import("@/lib/agent/headless");
  const previous = { cpu: process.env.LLV_AGENT_CPU, memory: process.env.LLV_AGENT_MEMORY };
  Object.assign(process.env, { LLV_AGENT_CPU: "auto", LLV_AGENT_MEMORY: "off", LLV_WORK_CPU_QUOTA: "1800" });
  setCpuPortsForTests(ports);
  const stdout = path.join(sandbox, "headless.out");
  let exited!: () => void;
  const done = new Promise<void>((resolve) => { exited = resolve; });
  try {
    const launched = launchDetached({ key: `cpu-${prefix}`, cwd: sandbox, stdoutPath: stdout, stderrPath: path.join(sandbox, "headless.err"), timeoutMs: 10_000,
      built: { command: "/bin/sh", args: ["-c", REPORT], env: { ...process.env }, stdin: null, outputPath: null, sessionId: null, reviewerPath: null },
      onExit: () => exited() });
    expect(launched?.pid).toBeGreaterThan(0);
    await done;
  } finally {
    setCpuPortsForTests(null);
    for (const [key, value] of [["LLV_AGENT_CPU", previous.cpu], ["LLV_AGENT_MEMORY", previous.memory]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete process.env.LLV_WORK_CPU_QUOTA;
  }
  const seen = report(fs.readFileSync(stdout, "utf8"));
  expect(seen.group).toMatch(new RegExp(`/${slices.work}/delegatus-agent-headless-[0-9a-f]{12}\\.scope$`));
  expect([seen.weight, seen.max, seen.parentMax]).toEqual(["100", "60000 20000", "360000 20000"]);
});

scopeTest("gate-slot runs a gate in the work slice with the same quotas", () => {
  const lock = fs.mkdtempSync(path.join(sandbox, "locks-"));
  const result = spawnSync("/bin/bash", [path.join(import.meta.dir, "../../../scripts/gate-slot.sh"), "/bin/sh", "-c", REPORT], { encoding: "utf8",
    env: { ...process.env, ...env, DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLICE: slices.work, LLV_GATE_LOCK_DIR: lock, LLV_GATE_SLOTS: "1" } });
  expect(result.status).toBe(0);
  const seen = report(result.stdout);
  expect(seen.group).toMatch(new RegExp(`/${slices.top}/${slices.agents}/${slices.work}/run-[^/]+\\.scope$`));
  expect([seen.weight, seen.max, seen.memory, seen.parentMax]).toEqual(["100", "60000 20000", String(8 * GIB), "360000 20000"]);
});

scopeTest("a workflow setup and its orphaned child run in a work scope without memory properties", async () => {
  process.env.LLV_STATE_DIR ??= fs.mkdtempSync(path.join(sandbox, "state-"));
  const { startSetup, setupStatus } = await import("@/lib/workflows/provision");
  const { setupStdoutPath } = await import("@/lib/workflows/store");
  const wf = { id: `cpu${prefix.slice(-8)}`, worktreeDir: sandbox, setupPid: null as number | null,
    template: { setup: `${REPORT}; (setsid sh -c 'sed -n "s/^0:://p" /proc/self/cgroup > "${sandbox}/setup-orphan"' </dev/null >/dev/null 2>&1 &); sleep 0.3` } } as unknown as import("@/lib/workflows/types").Workflow;
  const started = startSetup(wf, { env: { ...process.env, ...env, DELEGATUS_AGENT_MEMORY: "off" }, ports });
  expect(started.error).toBeUndefined();
  wf.setupPid = started.pid;
  for (let i = 0; i < 100 && setupStatus(wf).status === "running"; i++) await Bun.sleep(50);
  expect(setupStatus(wf).status).toBe("done");
  const seen = report(fs.readFileSync(setupStdoutPath(wf.id), "utf8"));
  expect(seen.group).toMatch(new RegExp(`/${slices.top}/${slices.agents}/${slices.work}/delegatus-work-workflow-setup-[0-9a-f-]{12}\\.scope$`));
  expect(seen.group).not.toBe(cgroupOf("self"));
  expect([seen.weight, seen.max, seen.memory, seen.parentMax]).toEqual(["100", "60000 20000", "max", "360000 20000"]);
  expect(fs.readFileSync(path.join(sandbox, "setup-orphan"), "utf8").trim()).toBe(seen.group!);
});

scopeTest("a merger gate runs in the work slice, on a shared slot, and waits out CPU pressure", async () => {
  const { MergeBatch, commandRunner } = await import("../../../scripts/merge-batch");
  const repo = fs.mkdtempSync(path.join(sandbox, "merger-"));
  runner("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const stateFile = path.join(sandbox, "merge-batch.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, repo, work: repo, branch: `merge-batch/${randomUUID()}`, base: "", tip: "", rows: [], gated: null, batch: null, published: null, refreshes: 0, landed: false, gates: [] }));
  const lock = fs.mkdtempSync(path.join(sandbox, "merger-locks-"));
  const pressure = path.join(sandbox, "merger-pressure");
  fs.writeFileSync(pressure, "some avg10=80.00 avg60=0.00 avg300=0.00 total=1\n");
  const gateEnv = { ...env, DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_PSI_FILE: pressure, LLV_GATE_PSI_RELEASE_SECONDS: "1", LLV_GATE_POLL_SECONDS: "0.1",
    LLV_GATE_SLICE: slices.work, LLV_GATE_LOCK_DIR: lock, LLV_GATE_SLOTS: "1" };
  const marker = path.join(sandbox, "merger-ran");
  const slot = `flock -n "${lock}/llv-heavy-gate.slot1.lock" true && echo free || echo taken`;
  const batch = new MergeBatch(repo, stateFile, (cwd, args, runEnv) => commandRunner(cwd, args, { ...runEnv, ...gateEnv } as NodeJS.ProcessEnv), async () => "");
  const gated = batch.bisectSubject({ id: "fixture", args: ["/bin/sh", "-c", `echo run >> "${marker}"; ${slot}; ${REPORT}`] });
  await Bun.sleep(1_000);
  expect(fs.existsSync(marker)).toBe(false); // high pressure: no gate child
  fs.writeFileSync(pressure, "some avg10=1.00 avg60=0.00 avg300=0.00 total=1\n");
  const result = await gated;
  expect(result.code).toBe(0);
  expect(result.output).toContain("gate-slot: held for CPU pressure: avg10 80.00% >= 20%");
  expect(result.output).toContain("taken"); // the gate holds the shared slot while its command runs
  expect(fs.readFileSync(marker, "utf8")).toBe("run\n");
  const seen = report(result.output);
  expect(seen.group).toMatch(new RegExp(`/${slices.top}/${slices.agents}/${slices.work}/run-[^/]+\\.scope$`));
  expect([seen.weight, seen.max, seen.memory, seen.parentMax]).toEqual(["100", "60000 20000", String(8 * GIB), "360000 20000"]);
}, 30_000);

scopeTest("boot adoption relaunches Codex and Claude hosts in the CPU scope of their class, with memory off and on", async () => {
  const saved = { cpu: process.env.LLV_AGENT_CPU, memory: process.env.LLV_AGENT_MEMORY, quota: process.env.LLV_WORK_CPU_QUOTA };
  Object.assign(process.env, { LLV_AGENT_CPU: "auto", LLV_WORK_CPU_QUOTA: "1800" });
  setCpuPortsForTests(ports);
  // The memory budget goes to a fake runner: the live agent slice is never probed or budgeted.
  setAgentMemoryPortsForTests({ totalBytes: 16 * GIB, probe: () => 255, runner: () => "" });
  const pressure = spyOn(CpuPressureGate.prototype, "check");
  try {
    for (const memory of ["off", "scope"] as const) {
      process.env.LLV_AGENT_MEMORY = memory;
      for (const engine of ["codex", "claude"] as const) {
        for (const member of ["pipeline", "flow", null] as const) {
          const adopted = await startupAdoptionCell(sandbox, engine, member);
          if (!("cell" in adopted)) throw adopted.refused;
          const cell = adopted.cell!;
          units.push(cell.plan.unit!);
          // The host spawns its engine through exactly this wrapper.
          const child = cell.wrapSpawn()("/bin/sh", ["-c", REPORT], {});
          let stdout = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
          cell.close();
          const seen = report(stdout);
          if (member) {
            expect(seen.group).toEndWith(`/${slices.top}/${slices.agents}/${slices.work}/${cell.plan.unit}`);
            expect([seen.weight, seen.max, seen.parentMax]).toEqual(["100", "60000 20000", "360000 20000"]);
          } else {
            expect(seen.group).toEndWith(`/${slices.top}/${slices.agents}/${cell.plan.unit}`);
            expect([seen.weight, seen.max]).toEqual(["1000", "max 100000"]);
          }
          expect(seen.memory).toBe(memory === "off" ? "max" : String(cell.plan.limitBytes));
        }
      }
    }
    expect(pressure).not.toHaveBeenCalled();
  } finally {
    pressure.mockRestore();
    setCpuPortsForTests(null);
    setAgentMemoryPortsForTests(null);
    for (const [key, value] of [["LLV_AGENT_CPU", saved.cpu], ["LLV_AGENT_MEMORY", saved.memory], ["LLV_WORK_CPU_QUOTA", saved.quota]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 60_000);

scopeTest("a slice whose cpu controller is disabled refuses work in both implementations, before any work runs", async () => {
  // systemd accepts every CPU property here; the scopes below simply get no cpu.max.
  runner("systemctl", ["--user", "set-property", "--runtime", slices.workOff, "DisableControllers=cpu"]);
  runner("systemctl", ["--user", "set-property", "--runtime", slices.off, "DisableControllers=cpu"]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const saved = { cpu: process.env.LLV_AGENT_CPU, memory: process.env.LLV_AGENT_MEMORY, quota: process.env.LLV_WORK_CPU_QUOTA };
  try {
    // The work scope itself: the agents slice keeps its controls, the work slice hands none to its scopes.
    expect(() => planAgentCpu("work", env, { ...ports, workSlice: slices.workOff }))
      .toThrow(`CPU containment for agent work is unavailable: the kernel applied no CPU controls to a scope in ${slices.workOff}; the cpu controller is off on one of its ancestors`);
    // The whole branch: the probe itself sees no controls; operator hosts run without placement.
    invalidateCpuContainmentProbe();
    const offPorts = { ...ports, agentSlice: slices.offAgents, workSlice: slices.offWork };
    expect(() => planAgentCpu("work", env, offPorts)).toThrow(`the kernel applied no CPU controls to a scope in ${slices.offAgents}; the cpu controller is off on one of its ancestors`);
    expect(planAgentCpu("operator", env, offPorts)).toBeNull();
    // Boot adoption of a pipeline host is refused with the same reason.
    Object.assign(process.env, { LLV_AGENT_CPU: "auto", LLV_AGENT_MEMORY: "off", LLV_WORK_CPU_QUOTA: "1800" });
    setCpuPortsForTests(offPorts);
    for (const engine of ["codex", "claude"] as const) {
      const refused = await startupAdoptionCell(sandbox, engine, "pipeline");
      expect("refused" in refused && refused.refused.message).toContain(`the kernel applied no CPU controls to a scope in ${slices.offAgents}`);
    }
    // The gate: systemd-run starts its scope, the scope's own check refuses before the command.
    for (const slice of [slices.workOff, slices.offWork]) {
      const lock = fs.mkdtempSync(path.join(sandbox, "off-locks-"));
      const marker = path.join(sandbox, `off-ran-${path.basename(lock)}`);
      const result = spawnSync("/bin/bash", [path.join(import.meta.dir, "../../../scripts/gate-slot.sh"), "/bin/sh", "-c", `echo run > "${marker}"`], { encoding: "utf8",
        env: { ...process.env, ...env, DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLICE: slice, LLV_GATE_LOCK_DIR: lock, LLV_GATE_SLOTS: "1" } });
      expect(result.status).toBe(69);
      expect(result.stderr).toContain("gate-slot: CPU containment for gates is unavailable: the kernel applied no CPU quota to");
      expect(fs.existsSync(marker)).toBe(false);
    }
  } finally {
    warn.mockRestore();
    setCpuPortsForTests(null);
    invalidateCpuContainmentProbe();
    for (const [key, value] of [["LLV_AGENT_CPU", saved.cpu], ["LLV_AGENT_MEMORY", saved.memory], ["LLV_WORK_CPU_QUOTA", saved.quota]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 60_000);

const tmuxScopeTest = reachable && spawnSync("tmux", ["-V"]).status === 0 ? test : test.skip;

/**
 * The shared tmux launch path, end to end, on a private tmux server: a fake
 * `codex` reaches an idle composer, records its own descendant and an
 * intentionally orphaned `setsid` child, then waits. The operator's tmux
 * server and its panes are never addressed.
 */
tmuxScopeTest("tmux launches place the pane, the agent, its descendants and an orphan in the classified CPU scope", async () => {
  const { spawnAgentWithPrompt } = await import("@/lib/tmux");
  const { agentRegistry } = await import("@/lib/agent/registry");
  // Unix socket names must fit even when the gate nests a long TMPDIR.
  const tmuxTmpdir = fs.mkdtempSync("/tmp/llv-cpu-tmux-");
  const bin = path.join(sandbox, "tmux-bin");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, "codex");
  // argv[0] `codex` is how pane_current_command and the agent scan both see the CLI.
  fs.writeFileSync(fake, [
    "#!/bin/bash",
    'out="$LLV_FAKE_CODEX_OUT"',
    'sleep 600 & echo "$!" > "$out.descendant"',
    '(setsid sleep 600 </dev/null >/dev/null 2>&1 & echo "$!" > "$out.orphan")',
    'echo "$$" > "$out.agent"',
    "stty -echo",
    "printf '\\n› \\n  ? for shortcuts\\n'",
    "exec -a codex sleep 600",
  ].join("\n") + "\n", { mode: 0o700 });
  const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, LLV_AGENT_CPU: process.env.LLV_AGENT_CPU, LLV_AGENT_MEMORY: process.env.LLV_AGENT_MEMORY, LLV_WORK_CPU_QUOTA: process.env.LLV_WORK_CPU_QUOTA };
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxTmpdir, HOME: sandbox, SHELL: "/bin/bash" };
  const tmux = (...args: string[]) => spawnSync("tmux", args, { env: tmuxEnv, encoding: "utf8" });
  let serverPid: number | null = null;
  const pids: number[] = [];
  try {
    // The server runs in an agent's scope, as one an agent started does, and
    // cannot reach the user bus itself, as when its own pane move times out
    // under load: every new pane stays in that agent scope and must still be
    // placed. Panes get the real bus through the global environment.
    const serverUnit = `delegatus-agent-codex-${randomUUID().replace(/-/g, "").slice(0, 12)}.scope`;
    units.push(serverUnit);
    expect(spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--slice=${slices.top}`, `--unit=${serverUnit}`, "--",
      "env", "DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent", "XDG_RUNTIME_DIR=/nonexistent",
      "tmux", "-f", "/dev/null", "new-session", "-d", "-x", "160", "-y", "40", "-s", "agents"], { env: tmuxEnv }).status).toBe(0);
    serverPid = Number(tmux("display-message", "-p", "#{pid}").stdout.trim());
    expect(cgroupOf(serverPid)).toEndWith(`/${serverUnit}`);
    for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) {
      const value = process.env[name];
      if (value) expect(tmux("set-environment", "-g", name, value).status).toBe(0);
    }
    expect(tmux("set-option", "-g", "default-shell", "/bin/bash").status).toBe(0);
    Object.assign(process.env, { TMUX_TMPDIR: tmuxTmpdir, LLV_AGENT_CPU: "auto", LLV_AGENT_MEMORY: "off", LLV_WORK_CPU_QUOTA: "1800" });
    setCpuPortsForTests(ports);
    const registry = agentRegistry();
    const launch = async (name: string, options: { workload?: "work" | "operator"; membership?: "pipeline" | "flow" }) => {
      const out = path.join(sandbox, `tmux-${name}`);
      const spec = { command: `env LLV_FAKE_CODEX_OUT=${out} ${fake} --fixture`, cwd: sandbox, windowName: `cpu-${name}`, engine: "codex" as const };
      const begun = registry.beginSpawnRequest({ engine: "codex", cwd: sandbox, launchProfile: { title: `CPU placement ${name}` }, ...(options.membership ? { memberships: [{ kind: options.membership,
        containerId: `${options.membership}-${prefix}`, role: options.membership === "flow" ? "reviewer" : "builder", slot: `${name}:1`, stageId: null,
        stageOrder: 1, round: options.membership === "flow" ? 1 : null, parentConversationId: null }] } : {}) });
      if (begun.kind === "conflict") throw new Error("fixture receipt conflicted");
      const pane = await spawnAgentWithPrompt(spec, `cpu placement ${name}`, begun.receipt, options.workload ? { workload: options.workload } : {});
      const read = (suffix: string) => Number(fs.readFileSync(`${out}.${suffix}`, "utf8").trim());
      const agent = read("agent"), descendant = read("descendant"), orphan = read("orphan");
      pids.push(pane.panePid!, agent, descendant, orphan);
      const group = cgroupOf(pane.panePid!);
      units.push(path.basename(group));
      expect(ppid(descendant)).toBe(agent);
      expect(ppid(orphan)).not.toBe(agent);
      for (const pid of [agent, descendant, orphan]) expect(cgroupOf(pid)).toBe(group);
      expect(group).toMatch(/\/delegatus-agent-codex-pane-[0-9a-f-]{12}\.scope$/);
      return group;
    };

    // A workflow stage names its class; a pane reviewer and a tmux pipeline
    // stage carry it in their receipt's membership; anything else is the operator's.
    for (const [name, options] of [["workflow", { workload: "work" }], ["reviewer", { membership: "flow" }], ["pipeline", { membership: "pipeline" }]] as const) {
      const group = await launch(name, options);
      expect(path.dirname(group)).toEndWith(`/${slices.top}/${slices.agents}/${slices.work}`);
      expect([control(group, "cpu.weight"), control(group, "cpu.max"), control(group, "memory.max"), control(path.dirname(group), "cpu.max")])
        .toEqual(["100", "60000 20000", "max", "360000 20000"]);
    }
    const operator = await launch("operator", {});
    expect(path.dirname(operator)).toEndWith(`/${slices.top}/${slices.agents}`);
    expect([control(operator, "cpu.weight"), control(operator, "cpu.max")]).toEqual(["1000", "max 100000"]);

    // Work that cannot be contained is refused before any window exists.
    setCpuPortsForTests({ ...ports, probe: () => ({ kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" }) });
    const windows = tmux("list-windows", "-a").stdout;
    const refused = registry.beginSpawnRequest({ engine: "codex", cwd: sandbox, launchProfile: { title: "CPU placement refused" } });
    if (refused.kind === "conflict") throw new Error("fixture receipt conflicted");
    await expect(spawnAgentWithPrompt({ command: `${fake} --refused`, cwd: sandbox, windowName: "cpu-refused", engine: "codex" }, "refused", refused.receipt, { workload: "work" }))
      .rejects.toThrow("CPU containment for agent work is unavailable: the systemd user manager does not delegate the cpu controller");
    expect(tmux("list-windows", "-a").stdout).toBe(windows);
  } finally {
    setCpuPortsForTests(null);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    if (serverPid) { try { process.kill(serverPid, "SIGTERM"); } catch { /* Private server exited. */ } }
    fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  }
}, 60_000);
