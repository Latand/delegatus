import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GIB, planAgentMemory, wrapAgentCommand } from "./agentMemory";
import { planAgentCpu, setCpuPortsForTests, wrapWorkCommand, type CpuPorts } from "./cpuPlacement";

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
const slices = { top: `${prefix}.slice`, agents: `${prefix}-agents.slice`, work: `${prefix}-agents-work.slice` };
const ports: CpuPorts = { agentSlice: slices.agents, workSlice: slices.work, cpus: 24, runner };
const env = { DELEGATUS_AGENT_CPU: "auto", DELEGATUS_WORK_CPU_QUOTA: "1800" };
const units: string[] = [];
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cpu-scope-"));

const quiet = (command: string, args: string[]) => { try { runner(command, args); } catch { /* Already collected. */ } };
afterEach(() => { for (const unit of units.splice(0)) quiet("systemctl", ["--user", "stop", unit]); });
afterAll(() => {
  setCpuPortsForTests(null);
  quiet("systemctl", ["--user", "stop", slices.work, slices.agents, slices.top]);
  quiet("systemctl", ["--user", "revert", slices.work]);
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
