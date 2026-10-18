import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { AccountMigrationController } from "@/lib/accounts/migration/controller";

import {
  FLOW_PIPELINE_WATCHDOG_MS,
  FlowPipelineController,
  startFlowPipelineControllerRuntime,
  type FlowPipelineControllerHeartbeat,
  type FlowPipelineControllerPorts,
  writeFlowPipelineControllerHeartbeat,
} from "./controller";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-pipeline-controller-"));

test("an incomplete catalog defers flows quietly under the CLI and still reports actual failures", async () => {
  const previous = process.env.LLV_QUIET_DIAGNOSTICS;
  const info = spyOn(console, "info").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  let fail = false, flows = 0;
  const controller = new FlowPipelineController({
    tickPipelines: async () => { if (fail) throw new Error("fixture pipeline failure"); return { changed: false }; },
    tickFlows: async () => { flows++; return { changed: false }; },
    scan: async () => ({ files: [], complete: false }),
  }, { maxPasses: 1 });
  try {
    process.env.LLV_QUIET_DIAGNOSTICS = "1";
    await controller.tick();
    expect(flows).toBe(0);
    expect(info).not.toHaveBeenCalled();
    delete process.env.LLV_QUIET_DIAGNOSTICS;
    await controller.tick();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("still scanning"));
    process.env.LLV_QUIET_DIAGNOSTICS = "1";
    fail = true;
    await expect(controller.tick()).rejects.toThrow("fixture pipeline failure");
    expect(error).toHaveBeenCalledWith("[flow pipeline controller] pipelines phase failed", expect.any(Error));
  } finally {
    info.mockRestore(); error.mockRestore();
    if (previous === undefined) delete process.env.LLV_QUIET_DIAGNOSTICS;
    else process.env.LLV_QUIET_DIAGNOSTICS = previous;
  }
});

test("an automatic handoff holds a new controller cycle until the next tick", async () => {
  let held = true;
  let stages = 0;
  const controller = new FlowPipelineController({
    handoffHeld: () => held,
    tickPipelines: async () => { stages += 1; return { changed: false }; },
    tickFlows: async () => ({ changed: false }),
  }, { maxPasses: 1 });
  await controller.tick();
  expect(stages).toBe(0);
  held = false;
  await controller.tick();
  expect(stages).toBe(1);
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function accountControllerWedgedInRuntime(): Promise<void> {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`));
  let markRuntimeStarted = () => {};
  const runtimeStarted = new Promise<void>((resolve) => { markRuntimeStarted = resolve; });
  const wedged = new Promise<void>(() => {});
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => undefined },
    null,
    {
      scan: async () => ({ files: [], projectCatalog: [], complete: true }),
      reconcileInventory: async () => registry.snapshot(),
      reconcileFlowOwnership: async () => undefined,
      reconcileWorkflowOwnership: async () => undefined,
      reconcileHandoffOwnership: async () => undefined,
      reconcileFiles: async () => undefined,
      reconcileRuntime: async () => {
        markRuntimeStarted();
        await wedged;
      },
      reconcileTaskStore: async () => undefined,
      syncRouting: async () => undefined,
      reconcileMigrationCycle: async () => undefined,
    },
  );
  void controller.tick();
  return runtimeStarted;
}

test("a terminal event advances once and launches one reviewer while the account runtime phase is wedged", async () => {
  await accountControllerWedgedInRuntime();
  let state: "terminal" | "review-pending" | "review-spawning" | "reviewing" = "terminal";
  let passTransitions = 0;
  let reviewerLaunches = 0;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (state === "terminal") {
        state = "review-pending";
        passTransitions += 1;
        return { changed: true };
      }
      if (state === "review-pending") {
        state = "review-spawning";
        return { changed: true };
      }
      return { changed: false };
    },
    tickFlows: async () => {
      if (state === "review-spawning") {
        state = "reviewing";
        reviewerLaunches += 1;
        return { changed: true };
      }
      return { changed: false };
    },
  });

  await Promise.all([
    controller.tick("terminal-event"),
    controller.tick("terminal-event"),
    controller.tick("terminal-event"),
  ]);

  expect(state as string).toBe("reviewing");
  expect(passTransitions).toBe(1);
  expect(reviewerLaunches).toBe(1);
});

test("a phase deadline releases the controller and later watchdog ticks keep pipelines moving", async () => {
  type ManualTimer = { active: boolean; callback: () => void };
  const timers: ManualTimer[] = [];
  const heartbeats: FlowPipelineControllerHeartbeat[] = [];
  const heartbeatFile = path.join(sandbox, "wedged-heartbeat.json");
  let now = 1_000;
  let flowCalls = 0;
  let pipelineCalls = 0;
  let markFlowStarted = () => {};
  const flowStarted = new Promise<void>((resolve) => { markFlowStarted = resolve; });
  const wedged = new Promise<never>(() => {});
  const ports: FlowPipelineControllerPorts = {
    tickPipelines: async () => {
      pipelineCalls += 1;
      return { changed: false };
    },
    tickFlows: async () => {
      flowCalls += 1;
      markFlowStarted();
      return wedged;
    },
    now: () => now,
    scheduleTimeout: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as ManualTimer).active = false; },
    publishHeartbeat: (heartbeat) => {
      heartbeats.push(heartbeat);
      writeFlowPipelineControllerHeartbeat(heartbeat, heartbeatFile);
    },
  };
  const controller = new FlowPipelineController(ports, { phaseDeadlineMs: 500 });

  const first = controller.tick("terminal-event");
  await flowStarted;
  now = 1_500;
  timers.find((timer) => timer.active)!.callback();
  await first;

  expect(flowCalls).toBe(1);
  expect(pipelineCalls).toBe(2);
  expect(heartbeats).toContainEqual(expect.objectContaining({
    phase: "flows",
    state: "timed-out",
    ageMs: 500,
    deadlineMs: 500,
  }));
  expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8"))).toMatchObject({
    phase: "flows",
    state: "blocked",
    ageMs: 500,
    deadlineMs: 500,
  });

  await controller.poll();
  expect(flowCalls).toBe(1);
  expect(pipelineCalls).toBe(4);
  expect(heartbeats).toContainEqual(expect.objectContaining({
    phase: "flows",
    state: "blocked",
    ageMs: 500,
  }));
});

test("a blocked flow phase still lets the completed scan feed pipeline settlement (#529)", async () => {
  type ManualTimer = { active: boolean; callback: () => void };
  const timers: ManualTimer[] = [];
  const entry = { path: "/sessions/completed-builder.jsonl" } as never;
  const pipelineEntries: unknown[][] = [];
  let scans = 0;
  let markFlowStarted = () => {};
  const flowStarted = new Promise<void>((resolve) => { markFlowStarted = resolve; });
  const wedged = new Promise<never>(() => {});
  const controller = new FlowPipelineController({
    scan: async () => {
      scans += 1;
      return { files: [entry], complete: true };
    },
    tickPipelines: async (entries) => {
      pipelineEntries.push(entries);
      return { changed: false };
    },
    tickFlows: async () => {
      markFlowStarted();
      return wedged;
    },
    scheduleTimeout: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as ManualTimer).active = false; },
  }, { phaseDeadlineMs: 500 });

  const tick = controller.tick("durable-pass-verdict");
  await flowStarted;
  timers.find((timer) => timer.active)!.callback();
  await tick;

  expect(scans).toBe(1);
  expect(pipelineEntries).toEqual([[], [entry]]);
});

test("startup recovery and the watchdog converge a pending transition without duplicate effects", async () => {
  let pending = true;
  let transitions = 0;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (!pending) return { changed: false };
      pending = false;
      transitions += 1;
      return { changed: true };
    },
    tickFlows: async () => ({ changed: false }),
  });

  await controller.recover();
  await controller.poll();
  await controller.poll();

  expect(transitions).toBe(1);
});

test("a wake during controller settlement runs one additional cycle without duplicate transition effects", async () => {
  const idleCycles: number[] = [];
  let transitionPending = false;
  let transitionEffects = 0;
  let settlementWake: Promise<void> | null = null;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (!transitionPending) return { changed: false };
      transitionPending = false;
      transitionEffects += 1;
      return { changed: true };
    },
    tickFlows: async () => ({ changed: false }),
    publishHeartbeat: (heartbeat) => {
      if (heartbeat.phase !== "idle") return;
      idleCycles.push(heartbeat.cycle);
      if (heartbeat.cycle !== 1) return;
      queueMicrotask(() => {
        queueMicrotask(() => {
          transitionPending = true;
          settlementWake = controller.tick("settlement-wake");
        });
      });
    },
  });

  await controller.tick("initial");
  if (settlementWake === null) throw new Error("settlement wake was not scheduled");
  await settlementWake;

  expect(idleCycles).toEqual([1, 2]);
  expect(transitionEffects).toBe(1);
});

test("controller runtime registers startup recovery and one deterministic watchdog", async () => {
  const calls: string[] = [];
  const signals: Array<() => Promise<void>> = [];
  const watchdogs: Array<{ callback: () => void; delayMs: number; unrefCalls: number }> = [];
  let unregisterCalls = 0;
  const controller = {
    tick: async (trigger: string) => { calls.push(trigger); },
    recover: async () => { calls.push("startup"); },
    poll: async () => { calls.push("watchdog"); },
  } as unknown as FlowPipelineController;
  const state = {};
  const start = () => startFlowPipelineControllerRuntime(controller, state, {
    registerTick: (tick) => {
      signals.push(tick);
      return () => { unregisterCalls += 1; };
    },
    scheduleInterval: (callback, delayMs) => {
      const watchdog = {
        callback,
        delayMs,
        unrefCalls: 0,
        unref() { this.unrefCalls += 1; },
      };
      watchdogs.push(watchdog);
      return watchdog;
    },
    log: () => undefined,
  });

  start();
  await Promise.resolve();
  expect(calls).toEqual(["startup"]);
  expect(watchdogs).toHaveLength(1);
  expect(watchdogs[0]).toMatchObject({ delayMs: FLOW_PIPELINE_WATCHDOG_MS, unrefCalls: 1 });

  watchdogs[0]!.callback();
  await Promise.resolve();
  await signals[0]!();
  expect(calls).toEqual(["startup", "watchdog", "signal"]);

  start();
  await Promise.resolve();
  expect(unregisterCalls).toBe(1);
  expect(signals).toHaveLength(2);
  expect(watchdogs).toHaveLength(1);
  expect(calls).toEqual(["startup", "watchdog", "signal", "startup"]);
});

test("pipeline settlement leads the cycle and one scanner snapshot feeds every flow pass", async () => {
  const entry = { path: "/sessions/reviewer.jsonl" };
  const calls: string[] = [];
  let pipelineChanged = true;
  const ports = {
    scan: async () => {
      calls.push("scan");
      return { files: [entry], complete: true };
    },
    tickPipelines: async (...args: unknown[]) => {
      const files = args[0] as unknown[] | undefined;
      calls.push(`pipelines:${files?.length ?? 0}`);
      const changed = pipelineChanged;
      pipelineChanged = false;
      return { changed };
    },
    tickFlows: async (...args: unknown[]) => {
      const files = args[0] as unknown[] | undefined;
      calls.push(`flows:${files?.length ?? 0}`);
      expect(files).toEqual([entry]);
      return { changed: false };
    },
  } as unknown as FlowPipelineControllerPorts;

  await new FlowPipelineController(ports).tick("terminal-event");

  expect(calls).toEqual([
    "pipelines:0",
    "scan",
    "flows:1",
    "pipelines:1",
    "flows:1",
  ]);
});

test("every settled cycle starts the spawn completion-notice sweep, and a sweep that throws does not fail the cycle", async () => {
  let sweeps = 0;
  const logged: string[] = [];
  const controller = new FlowPipelineController({
    tickPipelines: async () => ({ changed: false }),
    tickFlows: async () => ({ changed: false }),
    sweepSpawnNotices: () => { sweeps += 1; if (sweeps === 2) throw new Error("store busy"); },
    log: (message) => { logged.push(message); },
  }, { maxPasses: 1 });
  await controller.tick("signal");
  await controller.tick("signal");
  await controller.tick("watchdog");
  expect(sweeps).toBe(3);
  expect(logged).toContain("[flow pipeline controller] spawn notice sweep failed to start");
});


test("one failed cycle settles before trailing success, with one phase failure", async () => {
  let reject!: (error: Error) => void;
  let release!: () => void;
  let entered!: () => void;
  const first = new Promise<never>((_, fail) => { reject = fail; });
  const trailing = new Promise<{ changed: boolean }>(resolve => { release = () => resolve({ changed: false }); });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const errors: unknown[] = [];
  let calls = 0;
  const controller = new FlowPipelineController({ now: () => 0,
    tickPipelines: () => { calls++; entered(); return calls === 1 ? first : trailing; },
    tickFlows: async () => ({ changed: false }), log: (_, error) => { if (error) errors.push(error); },
  }, { maxPasses: 1 });
  let settled = false;
  const failure = new Error("one admission refusal");
  const result = controller.tick().catch(error => { settled = true; expect(error).toBe(failure); });
  await started;
  for (let i = 0; i < 953; i++) controller.tick("signal");
  reject(failure);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const observed = settled;
  release();
  await result;
  expect(observed).toBe(true);
  expect(errors).toEqual([failure]);
});

test("continuous wakes cannot extend a controller request beyond its cycle budget", async () => {
  let calls = 0;
  const controller: FlowPipelineController = new FlowPipelineController({ now: () => 0,
    tickPipelines: async () => { calls++; if (calls < 12) controller.tick("more"); return { changed: false }; },
    tickFlows: async () => ({ changed: false }),
  }, { maxPasses: 1 });
  await controller.tick();
  expect(calls).toBeLessThanOrEqual(2);
});

test("a tick after the second cycle snapshot gets a paced retained dispatch", async () => {
  type ManualTimer = { active: boolean; callback: () => void; delayMs: number };
  const timers: ManualTimer[] = [];
  const pipelineRevisions: number[] = [];
  let revision = 0;
  let now = 10;
  let releaseFirstFlow!: () => void;
  let releaseSecondFlow!: () => void;
  let firstFlowStarted!: () => void;
  let secondFlowStarted!: () => void;
  let revisionOneSeen!: () => void;
  const firstFlow = new Promise<void>((resolve) => { releaseFirstFlow = resolve; });
  const secondFlow = new Promise<void>((resolve) => { releaseSecondFlow = resolve; });
  const firstStarted = new Promise<void>((resolve) => { firstFlowStarted = resolve; });
  const flowStarted = new Promise<void>((resolve) => { secondFlowStarted = resolve; });
  const processedRevisionOne = new Promise<void>((resolve) => { revisionOneSeen = resolve; });
  let flowCalls = 0;
  const controller = new FlowPipelineController({
    monotonicNow: () => now,
    tickPipelines: async () => {
      pipelineRevisions.push(revision);
      if (revision === 1) revisionOneSeen();
      return { changed: pipelineRevisions.length === 1 };
    },
    tickFlows: async () => {
      flowCalls += 1;
      if (flowCalls === 1) {
        firstFlowStarted();
        await firstFlow;
      }
      if (flowCalls === 2) {
        secondFlowStarted();
        await secondFlow;
      }
      return { changed: false };
    },
    scheduleTimeout: (callback, delayMs) => {
      const timer = { active: true, callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as ManualTimer).active = false; },
  }, { maxPasses: 1, requestDeadlineMs: 100 });

  const firstRequest = controller.tick("initial");
  await firstStarted;
  const cycleTwoRequest = controller.tick("cycle-two");
  releaseFirstFlow();
  await flowStarted;
  revision = 1;
  const lateRequest = controller.tick("late-revision");
  releaseSecondFlow();
  await Promise.all([firstRequest, cycleTwoRequest, lateRequest]);

  expect(pipelineRevisions).toEqual([0, 0]);
  const retainedWake = timers.find((timer) => timer.active && timer.delayMs === 25);
  expect(retainedWake).toBeDefined();
  now = 500;
  retainedWake!.active = false;
  retainedWake!.callback();
  await processedRevisionOne;
  await controller.poll();

  expect(pipelineRevisions).toEqual([0, 0, 1]);
  expect(timers.filter((timer) => timer.active && timer.delayMs === 25)).toHaveLength(0);
});

test("watchdog keeps only one observer while its poll remains in flight", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  let callback!: () => void;
  let polls = 0;
  const logs: unknown[] = [];
  const controller = { tick: () => pending, recover: async () => {}, poll: () => { polls++; return pending; } } as unknown as FlowPipelineController;
  startFlowPipelineControllerRuntime(controller, {}, {
    registerTick: () => () => {}, scheduleInterval: fn => { callback = fn; return {}; },
    log: (_, error) => { logs.push(error); },
  });
  for (let i = 0; i < 31; i++) callback();
  const failure = new Error("one watchdog refusal");
  reject(failure);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(polls).toBe(1);
  expect(logs).toEqual([failure]);
});


test.each([1, 2, 3])("one deferred error with 953 wakes, 31 polls and 9 remote waiters, repeat %i", async repeat => {
  const { registerPipelineTick, requestPipelineTick } = await import("./controllerSignal");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const { POST } = await import("@/app/api/pipelines/tick/route");
  const { NextRequest } = await import("next/server");
  let reject!: (error: Error) => void, release!: () => void, entered!: () => void;
  const first = new Promise<never>((_, fail) => { reject = fail; });
  const trailing = new Promise<{ changed: boolean }>(resolve => { release = () => resolve({ changed: false }); });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0, phase = 0, requested = 0, watchdog = 0, route = 0;
  const controller = new FlowPipelineController({ now: () => 0,
    tickPipelines: () => { calls++; entered(); return calls === 1 ? first : trailing; },
    tickFlows: async () => ({ changed: false }),
    log: (_, error) => { if (error) phase++; },
  }, { maxPasses: 1 });
  const unregister = registerPipelineTick(() => controller.tick("signal"));
  const log = spyOn(console, "error").mockImplementation((message) => { if (String(message).includes("requested tick failed")) requested++; });
  let poll!: () => void;
  const pollController = { poll: () => controller.poll(), recover: async () => {}, tick: () => controller.tick() } as FlowPipelineController;
  startFlowPipelineControllerRuntime(pollController, {}, {
    registerTick: () => () => {}, scheduleInterval: callback => { poll = callback; return {}; }, log: () => { watchdog++; },
  });
  const drain = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  try {
    requestPipelineTick(); await started;
    for (let i = 1; i < 953; i++) { requestPipelineTick(); await Promise.resolve(); }
    for (let i = 0; i < 31; i++) poll();
    const replies = Array.from({ length: 9 }, () => POST.withDependencies(new NextRequest("http://127.0.0.1:19000/api/pipelines/tick", {
      method: "POST", headers: { host: "127.0.0.1:19000", origin: "http://127.0.0.1:19000" },
    }), () => controller.tick("remote-signal")).catch(() => { route++; }));
    reject(new StateLockDeferredError("fixture.admission"));
    await drain();
    const failuresBeforeTrailingSettlement = requested + watchdog;
    release(); await Promise.all(replies); await drain();
    console.log(JSON.stringify({ workload: "deferred-tick-fanout", repeat, wakes: 953, polls: 31, remoteWaiters: 9, phase, requested, watchdog, route, failuresBeforeTrailingSettlement, calls }));
    expect(phase).toBe(1);
    expect(requested).toBe(1);
    expect(watchdog).toBe(1);
    expect(route).toBe(0);
    expect(failuresBeforeTrailingSettlement).toBe(2);
    expect(calls).toBeLessThanOrEqual(2);
  } finally { release(); await drain(); unregister(); log.mockRestore(); }
});


test("initial and trailing cycles share the same request deadline", async () => {
  let now = 0, calls = 0;
  const controller: FlowPipelineController = new FlowPipelineController({ now: () => now,
    tickPipelines: async () => { calls++; now += 6; controller.tick("more"); return { changed: false }; },
    tickFlows: async () => { now += 6; return { changed: false }; },
  }, { maxPasses: 1, requestDeadlineMs: 10 });
  await controller.tick();
  expect(calls).toBe(1);
  now = 20;
  await controller.tick();
  expect(calls).toBe(2);
});


test("fresh controller processes retain bounded observers after a restart", async () => {
  for (let generation = 1; generation <= 2; generation++) {
    const root = fs.mkdtempSync(path.join(sandbox, `generation-${generation}-`));
    for (const directory of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(root, directory));
    const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "controller.test.ts"), "-t", "one deferred error with 953"], {
      env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors: code ? stderr : "" }).toEqual({ code: 0, errors: "" });
      const records = stdout.split("\n").filter(line => line.startsWith("{\"workload\"")).map(line => JSON.parse(line));
      expect(records).toHaveLength(3);
      for (const record of records) expect(record).toMatchObject({ requested: 1, watchdog: 1, route: 0, calls: 2 });
    } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
}, 30_000);
