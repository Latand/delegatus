import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { machineCpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "@/lib/runtime/cpuAdmission";
import { setMachineCpuPressureForTests } from "@/lib/runtime/cpuPressure";
import { drainFile, releaseDrain, writeDrain } from "@/lib/selfUpdate/drain";
import { defaultPorts, patchWorkflow, tickWorkflows, type WorkflowPorts } from "./engine";
import { buildWorkflow, loadWorkflows, saveWorkflows } from "./store";
import type { Workflow } from "./types";

const queueSymbol = Symbol.for("delegatus.cpuAdmission");
const globals = globalThis as typeof globalThis & { [queueSymbol]?: { file: string; queue: ReturnType<typeof machineCpuAdmissionQueue> } };
const originalRead = fs.readFileSync;
const originalNow = Date.now;
let directory: string;
let now: number;
let restores: (() => void)[];
let environment: NodeJS.ProcessEnv;

function restart(): void {
  globals[queueSymbol]?.queue.close();
  delete globals[queueSymbol];
  setMachineCpuPressureForTests(undefined);
}

beforeEach(() => {
  environment = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-cpu-"));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.LLV_GATE_LOCK_DIR = path.join(directory, "locks");
  process.env.DELEGATUS_CPU_PRESSURE = "on";
  now = originalNow();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sample = spyOn(fs, "readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) =>
    file === "/proc/pressure/cpu" ? "some avg10=90.00 avg60=90.00 avg300=90.00 total=0\n" : Reflect.apply(originalRead, fs, [file, ...args])) as typeof fs.readFileSync);
  restores = [() => sample.mockRestore(), () => clock.mockRestore()];
  restart();
  saveWorkflows([]);
});

afterEach(() => {
  restart();
  for (const restore of restores) restore();
  process.env = environment;
  fs.rmSync(directory, { recursive: true, force: true });
});

type Phase = "setup" | "stage" | "review";
function workflow(id: string, phase: Phase, mode: "auto" | "manual" = "auto"): Workflow {
  const role = { engine: "codex" as const, model: null, effort: "high" as const };
  const wf = buildWorkflow({ id, name: "CPU lifecycle", task: "Build the change", project: "repo-example",
    repoDir: path.join(directory, "repo"), mode, now: new Date(now).toISOString(),
    template: { name: "CPU lifecycle", setup: "bun install", finish: "pr", stages: [
      { kind: "implement", agent: role, scope: "Implementation" },
      { kind: "review-loop", fixer: role, reviewer: role, roundLimit: 3, reviewerMode: "headless" },
    ] } });
  wf.baseRef = "base";
  wf.baseBranch = "main";
  wf.state = phase === "setup" ? "provisioning" : phase === "review" ? "reviewing" : "implementing";
  wf.stageIndex = phase === "review" ? 1 : 0;
  for (const run of wf.stageRuns) run.accountId = "account-example";
  return wf;
}

function harness() {
  const starts: string[] = [], keys: string[] = [];
  const adapter = defaultPorts();
  const ports: WorkflowPorts = { ...adapter,
    cpuPressureHold: key => { keys.push(key); return adapter.cpuPressureHold!(key); },
    exec: async () => { throw new Error("unexpected git command"); },
    setupStatus: () => ({ status: "running", detail: "" }),
    startSetup: wf => { starts.push(`${wf.id}:setup`); return { pid: 123 }; },
    spawnAgent: async () => { starts.push("stage"); return { paneId: "pane", panePid: 123, transcript: null }; },
    now: () => new Date(now).toISOString(),
  };
  return { ports, starts, keys };
}

const transitions = (["setup", "stage", "review"] as const).flatMap(phase =>
  (["pause", "close", "needs_decision"] as const).map(action => ({ phase, action })));
test.each(transitions)("$action releases a waiting $phase ticket for later stages and commands", async ({ phase, action }) => {
  const h = harness();
  saveWorkflows([workflow("one", phase)]);
  await tickWorkflows([], h.ports);
  expect(h.starts).toEqual([]);
  expect(h.ports.cpuPressureHold!(h.keys[0]!)).toMatchObject({ queue: { position: 1 } });
  const q = machineCpuAdmissionQueue();
  q.check("stage:later", false);
  q.check("command:later", false);
  if (action === "needs_decision") {
    const rows = loadWorkflows();
    rows[0]!.pausedState = rows[0]!.state;
    rows[0]!.state = "needs_decision";
    saveWorkflows(rows);
    await tickWorkflows([], h.ports);
  } else await patchWorkflow("one", { action }, h.ports);
  // A restart and a hundred minutes cannot leave an abandoned Viewer head.
  now += 100 * 60_000;
  restart();
  const reader = harness();
  await tickWorkflows([], reader.ports);
  expect(machineCpuAdmissionQueue().check("stage:later", false)).toBeNull();
  now += CPU_QUEUE_SPACING_MS;
  expect(machineCpuAdmissionQueue().check("command:later", false)).toBeNull();
  expect(h.starts).toEqual([]);
});

test.each(["setup", "stage", "review"] as const)("update-held %s retains FIFO and wait age across restart", async phase => {
  const h = harness(), began = now;
  saveWorkflows([workflow("one", phase), workflow("two", phase)]);
  await tickWorkflows([], h.ports);
  const [one, two] = h.keys;
  expect(one).not.toBe(two);
  writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date(now).toISOString(), until: 0, persistent: true });
  await tickWorkflows([], h.ports);
  expect(h.starts).toEqual([]);
  restart();
  const reader = harness();
  await tickWorkflows([], reader.ports);
  expect(machineCpuAdmissionQueue().check("command:check", true)).toBeNull();
  now = began + CPU_QUEUE_MAX_WAIT_MS - 1;
  releaseDrain(drainFile(), "update");
  reader.ports.cpuAdmissionReconcile!();
  expect(reader.ports.cpuPressureHold!(two!)).toMatchObject({ since: began, queue: { position: 2 } });
  expect(reader.ports.cpuPressureHold!(one!)).toMatchObject({ since: began, queue: { remainingMs: 1 } });
  now += 1;
  await tickWorkflows([], reader.ports);
  expect(reader.starts).toHaveLength(1);
  now += CPU_QUEUE_SPACING_MS;
  await tickWorkflows([], reader.ports);
  expect(reader.starts).toHaveLength(2);
});

test("pausing and resuming a workflow preserves order and age for eligible tickets", async () => {
  const h = harness(), began = now;
  saveWorkflows([workflow("one", "setup"), workflow("two", "stage")]);
  await tickWorkflows([], h.ports);
  const [one, two] = h.keys;
  await patchWorkflow("one", { action: "pause" }, h.ports);
  restart();
  const reader = harness();
  await tickWorkflows([], reader.ports);
  expect(reader.ports.cpuPressureHold!(two!)).toMatchObject({ since: began, queue: { position: 1 } });
  await patchWorkflow("one", { action: "resume" }, reader.ports);
  expect(reader.ports.cpuPressureHold!(two!)).toMatchObject({ since: began, queue: { position: 2 } });
  now = began + CPU_QUEUE_MAX_WAIT_MS;
  expect(reader.ports.cpuPressureHold!(one!)).toBeNull();
  now += CPU_QUEUE_SPACING_MS;
  expect(reader.ports.cpuPressureHold!(two!)).toBeNull();
});

test.each(["pause", "close", "update"] as const)("a real gate-slot command proceeds after workflow %s", async action => {
  const h = harness();
  saveWorkflows([workflow("one", "setup")]);
  await tickWorkflows([], h.ports);
  if (action === "update") {
    writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date(now).toISOString(), until: 0, persistent: true });
    await tickWorkflows([], h.ports);
  } else await patchWorkflow("one", { action }, h.ports);
  const child = Bun.spawn(["bash", "scripts/gate-slot.sh", "bun", "-e", 'console.log("gate proceeded")'], {
    env: { ...process.env, DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_POLL_SECONDS: "0.01" }, stdout: "pipe", stderr: "pipe",
  });
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(await new Response(child.stdout).text()).toContain("gate proceeded");
}, 20_000);

test("advancing a queued setup cancels its phase while the next stage gets a distinct key", async () => {
  const h = harness();
  saveWorkflows([workflow("one", "setup")]);
  await tickWorkflows([], h.ports);
  const setup = h.keys[0]!;
  await patchWorkflow("one", { action: "advance" }, h.ports);
  await tickWorkflows([], h.ports);
  expect(h.keys[1]).not.toBe(setup);
  expect(h.ports.cpuPressureHold!(h.keys[1]!)).toMatchObject({ queue: { position: 1 } });
});

test.each(["setup", "stage"] as const)("an update suspends automatic %s while manual work remains eligible", async phase => {
  const h = harness();
  saveWorkflows([workflow("one", phase), workflow("two", phase, "manual")]);
  await tickWorkflows([], h.ports);
  writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date(now).toISOString(), until: 0, persistent: true });
  now += CPU_QUEUE_MAX_WAIT_MS;
  await tickWorkflows([], h.ports);
  expect(h.starts).toHaveLength(1);
  const rows = loadWorkflows();
  expect(rows[0]?.setupPid).toBeNull();
  expect(rows[0]?.stageRuns[0]?.startedAt).toBeNull();
  expect(phase === "setup" ? rows[1]?.setupPid : rows[1]?.stageRuns[0]?.startedAt).not.toBeNull();
});

test.each(["setup", "stage"] as const)("a mid-tick update suspends %s before later work asks for admission", async phase => {
  const h = harness();
  saveWorkflows([workflow("one", phase)]);
  await tickWorkflows([], h.ports);
  const rows = loadWorkflows();
  rows.push(workflow("two", "stage", "manual"));
  saveWorkflows(rows);
  const reconcile = h.ports.cpuAdmissionReconcile!;
  h.ports.cpuAdmissionReconcile = () => {
    reconcile();
    writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date(now).toISOString(), until: 0, persistent: true });
  };
  const check = h.ports.cpuPressureHold!;
  h.ports.cpuPressureHold = key => {
    // The manual workflow asks before tickWorkflows' final reconciliation.
    expect(machineCpuAdmissionQueue().check("command:mid-tick", true)).toBeNull();
    return check(key);
  };
  await tickWorkflows([], h.ports);
  expect(h.starts).toEqual([]);
});

test.each(["poll", "timer", "retry"] as const)("%s reconciles held tickets while another workflow's finish operation is in flight", async action => {
  const h = harness();
  saveWorkflows([workflow("one", "setup")]);
  await tickWorkflows([], h.ports);
  const finishing = workflow("two", "stage");
  finishing.state = "finishing";
  saveWorkflows([finishing, ...loadWorkflows()]);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { entered = resolve; });
  h.ports.exec = async () => {
    entered();
    await held;
    return { code: 1, stdout: "", stderr: "finish probe completed" };
  };
  const reconcile = h.ports.cpuAdmissionReconcile!;
  let refuseNextRead = false;
  const errors = action === "retry" ? spyOn(console, "error").mockImplementation(() => {}) : null;
  h.ports.cpuAdmissionReconcile = () => {
    if (refuseNextRead) { refuseNextRead = false; throw new Error("temporary queue read failure"); }
    reconcile();
  };
  if (action !== "poll") setMachineCpuPressureForTests(undefined, 10);
  const pending = tickWorkflows([], h.ports);
  try {
    await began;
    writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date(now).toISOString(), until: 0, persistent: true });
    if (action === "poll") {
      const poll = await tickWorkflows([], h.ports);
      expect(poll.changed).toBe(false);
    } else {
      refuseNextRead = action === "retry";
      const until = performance.now() + 2_000;
      while (machineCpuAdmissionQueue().check("command:finish-check", true, undefined, false) && performance.now() < until) await Bun.sleep(10);
    }
    expect(machineCpuAdmissionQueue().check("command:finish-check", true)).toBeNull();
    if (errors) expect(errors.mock.calls).toHaveLength(1);
  } finally { errors?.mockRestore(); release(); await pending; }
  expect(h.starts).toEqual([]);
});
