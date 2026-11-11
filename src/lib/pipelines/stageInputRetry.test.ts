import "./engineEnvironment.fixture";
import { expect, spyOn, test } from "bun:test";
import * as timers from "node:timers/promises";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { create, harness, tickPipelines, loadPipelines, savePipelines, reserveActivationOnly, frozenWallClock } from "./engine.fixture";
import { roleMemoryCollection, storedLessonRevision } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { RoleMemoryChanged } from "@/lib/memory/privacy";

const rule = "Keep silver orchard evidence private until the owning operation completes";
test.each(["timeout-recovery", "busy-recovery", "exhaustion", "permanent"] as const)("stage preparation retains its privacy fence through %s", async mode => {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_stage_read", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z",
  }));
  const h = harness();
  let clock = 0, failures = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    expect(h.spawnInputs).toHaveLength(0);
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (++failures <= 2 || mode === "exhaustion" || mode === "permanent") {
      if (mode !== "permanent") clock += Math.min(60_000, 180_000 - clock);
      throw Object.assign(new Error(rule), { code: mode === "permanent" ? "EACCES" : mode === "busy-recovery" ? "SQLITE_BUSY" : "ETIMEDOUT" });
    }
    return real.call(this, request);
  });
  try {
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build safely. ${rule}`, next: null }] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    const text = log.mock.calls.flat().join("\n");
    expect(text).not.toContain(rule);
    if (mode.endsWith("recovery")) {
      expect(h.spawnInputs).toHaveLength(1);
      expect(h.spawnInputs[0]!.prompt).toContain("[learned rule]");
      expect(h.spawnInputs[0]!.prompt).not.toContain(rule);
      expect(lane.runs[0]!.attempts.at(-1)!.state).toBe("running");
      expect(text).toContain(mode === "busy-recovery" ? "store-busy" : "worker-timeout");
    } else {
      expect(h.spawnInputs).toHaveLength(0);
      expect(lane.state).toBe(mode === "permanent" ? "needs_decision" : "running");
      expect(lane.stateDetail).toContain(mode === "permanent" ? "access-denied" : "worker-timeout; retry window exhausted after 180 seconds");
      expect(lane.stateDetail).not.toContain(rule);
      expect(clock).toBe(mode === "permanent" ? 0 : 180_000);
      if (mode === "permanent") expect(pause).not.toHaveBeenCalled();
    }
  } finally { worker.mockRestore(); pause.mockRestore(); now.mockRestore(); log.mockRestore(); await shutdownTaskPageWorker(); }
});

// Keep the retained filesystem-level probe at each launch-side read. Resolving
// the call site lets unrelated edits move engine.ts without disabling injection.
for (const boundary of ["input", "wait", "cached"] as const) {
  const modes: Array<"once" | "persistent" | "permanent" | "handoff"> = boundary === "wait"
    ? ["once", "persistent", "permanent", "handoff"] : ["once", "persistent", "permanent"];
  test.each(modes)(`launch ${boundary} revision read: %s`, async mode => {
    roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
      kind: "rule", id: "r_stage_boundary", scope: "machine", rule, why: "", state: "active", hints: [],
      source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
      createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z",
    }));
    const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build safely. ${rule}`, next: null }] as never;
    const h = boundary === "wait" ? await reserveActivationOnly(stages) : harness();
    let delivered = 0;
    const spawn = h.ports.spawnAgent;
    h.ports.spawnAgent = async (input, reserved, prepare) => {
      // The cached-input check belongs to the adapter's pre-delivery callback.
      // Count the effect only after that callback accepts its filtered input.
      if (boundary === "cached") input = { ...input, prompt: await prepare!() };
      delivered++;
      return spawn(input, reserved, prepare);
    };
    if (boundary !== "wait") {
      await create(h.ports, stages);
      await tickPipelines([], h.ports);
    }
    if (boundary === "wait") {
      const lane = loadPipelines()[0]!;
      const attempt = lane.runs[0]!.attempts.at(-1)!;
      attempt.roleMemoryFailures = 1;
      attempt.roleMemoryWait = { revision: storedLessonRevision(), observations: 1, retryAfter: "1970-01-01T00:00:00Z" };
      savePipelines([lane]);
    }
    const wallTime = h.ports.now();
    h.ports.now = () => wallTime;
    const source = fs.readFileSync(path.join(import.meta.dir, "engine.ts"), "utf8");
    const marker = boundary === "input" ? "inputRevision = storedLessonRevision();"
      : boundary === "wait" ? "const revision = storedLessonRevision();"
      : "if (inputRevision !== null && storedLessonRevision() === inputRevision)";
    const offset = source.indexOf(marker);
    expect(offset).toBeGreaterThan(0);
    const location = `engine.ts:${source.slice(0, offset).split("\n").length}:`;
    const inputLocation = `engine.ts:${source.slice(0, source.indexOf("inputRevision = storedLessonRevision();")).split("\n").length}:`;
    let clock = 0, injected = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
      expect(delivered).toBe(0);
      clock += mode === "handoff" && injected === 1 ? 170_000 : Number(ms);
      return value as T;
    });
    const log = spyOn(console, "warn").mockImplementation(() => {});
    const stat = fs.statSync;
    const read = spyOn(fs, "statSync").mockImplementation(new Proxy(stat, {
      apply(target, thisArg, args) {
        const stack = new Error().stack ?? "";
        const atBoundary = mode === "handoff" ? stack.includes(injected === 0 ? location : inputLocation) : stack.includes(location);
        if (String(args[0]) === path.join(process.env.LLV_STATE_DIR!, "state.sqlite")
          && atBoundary && (mode !== "once" || injected === 0)) {
          injected++;
          throw Object.assign(new Error(rule), { code: mode === "permanent" ? "EACCES" : "SQLITE_BUSY" });
        }
        return Reflect.apply(target, thisArg, args);
      },
    }));
    try {
      await tickPipelines([], h.ports);
      const lane = loadPipelines()[0]!;
      const text = log.mock.calls.flat().join("\n");
      expect(injected).toBeGreaterThan(0);
      expect(text).not.toContain(rule);
      if (mode === "once") {
        expect(injected).toBe(1);
        expect(pause).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(1);
        expect(h.spawnInputs[0]!.prompt).not.toContain(rule);
        expect(h.spawnInputs[0]!.prompt).toContain("[learned rule]");
      } else {
        expect(delivered).toBe(0);
        expect(lane.state).toBe(mode === "permanent" ? "needs_decision" : "running");
        expect(lane.stateDetail).toContain(mode === "permanent" ? "access-denied" : "store-busy; retry window exhausted after 180 seconds");
        expect(lane.stateDetail).not.toContain(rule);
        const windows = (lane.runs[0]!.attempts.at(-1)!.roleMemoryFailures ?? 0) - (boundary === "wait" ? 1 : 0);
        expect(clock).toBe(mode === "permanent" ? 0 : windows * 180_000);
        if (mode === "permanent") expect(pause).not.toHaveBeenCalled();
      }
    } finally { read.mockRestore(); now.mockRestore(); pause.mockRestore(); log.mockRestore(); await shutdownTaskPageWorker(); }
  });
}

test.each(["once", "persistent"] as const)("revision-change recovery retries its protected stability read: %s", async mode => {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_recovery_read", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z",
  }));
  const h = harness();
  const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build safely. ${rule}`, next: null }] as never;
  await create(h.ports, stages);
  const spawn = h.ports.spawnAgent;
  let failLaunch = true;
  h.ports.spawnAgent = async (...args) => {
    if (failLaunch) { failLaunch = false; throw new RoleMemoryChanged(); }
    return spawn(...args);
  };
  for (let tick = 0; tick < 3; tick++) {
    await tickPipelines([], h.ports);
    if (loadPipelines()[0]?.runs[0]?.attempts.at(-1)?.roleMemoryWait) break;
  }
  const deferred = loadPipelines()[0]!;
  expect(deferred.runs[0]!.attempts.at(-1)!.roleMemoryWait?.revision).toBe("");
  expect(h.spawnInputs).toHaveLength(0);

  const source = fs.readFileSync(path.join(import.meta.dir, "engine.ts"), "utf8");
  const marker = "const revision = storedLessonRevision();";
  const offset = source.indexOf(marker);
  expect(offset).toBeGreaterThan(0);
  const location = `engine.ts:${source.slice(0, offset).split("\n").length}:`;
  let clock = 0, injected = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    expect(h.spawnInputs).toHaveLength(0);
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const stat = fs.statSync;
  const read = spyOn(fs, "statSync").mockImplementation(new Proxy(stat, {
    apply(target, thisArg, args) {
      const atRead = (new Error().stack ?? "").includes(location);
      if (String(args[0]) === path.join(process.env.LLV_STATE_DIR!, "state.sqlite") && atRead
        && (mode === "persistent" || injected === 0)) {
        injected++;
        throw Object.assign(new Error(rule), { code: "SQLITE_BUSY" });
      }
      return Reflect.apply(target, thisArg, args);
    },
  }));
  try {
    await tickPipelines([], h.ports);
    const after = loadPipelines()[0]!;
    expect(injected).toBeGreaterThan(0);
    expect(log.mock.calls.flat().join("\n")).not.toContain(rule);
    if (mode === "once") {
      expect(injected).toBe(1);
      expect(h.spawnInputs).toHaveLength(0);
      expect(after.runs[0]!.attempts.at(-1)!.roleMemoryWait?.observations).toBe(0);
      read.mockRestore();
      for (let tick = 0; tick < 8 && h.spawnInputs.length === 0; tick++) await tickPipelines([], h.ports);
      expect(h.spawnInputs).toHaveLength(1);
      expect(h.spawnInputs[0]!.prompt).toContain("[learned rule]");
      expect(h.spawnInputs[0]!.prompt).not.toContain(rule);
    } else {
      expect(h.spawnInputs).toHaveLength(0);
      expect(after.state).toBe("running");
      expect(after.stateDetail).toContain("store-busy; retry window exhausted after 180 seconds");
      expect(after.stateDetail).not.toContain(rule);
      expect(clock).toBe(180_000);
    }
  } finally { read.mockRestore(); now.mockRestore(); pause.mockRestore(); log.mockRestore(); await shutdownTaskPageWorker(); }
});


test.each(["slow-worker", "changing-store"] as const)("privacy preparation resumes durably after %s", async mode => {
  if (process.env.LLV_PRIVACY_RETRY_CASE !== mode) {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-retry-case-"));
    try {
      const child = Bun.spawn([process.execPath, "test", "--timeout=60000", import.meta.path,
        "-t", `^privacy preparation resumes durably after ${mode}$`], {
        env: { ...process.env, LLV_STATE_DIR: directory, LLV_PRIVACY_RETRY_CASE: mode },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit, output + errors).toBe(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  let sequence = mode === "slow-worker" ? 1_000_000 : 2_000_000;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const variants = ["amber", "cobalt", "indigo", "saffron", "violet", "umber", "coral"];
  const protectedText = (index: number) => `Preserve ${variants[index] ?? `variant-${index}`} fixture launch evidence until its declared owner completes preparation`;
  const collection = roleMemoryCollection(true)!;
  const put = (index: number) => collection.boundedPatch(1, tx => tx.put({
    kind: "rule", id: `r_slow_${index}`, scope: "machine", rule: protectedText(index), why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-09T00:00:00Z", changedAt: "2026-11-09T00:00:00Z",
  }));
  put(0);
  const h = harness();
  const advanceWall = frozenWallClock(h);
  let clock = 0, calls = 0, unstable = true;
  const { waitForPipelineControllerJob } = await import("./controllerJobs");
  const step = async () => {
    await tickPipelines([], h.ports);
    await waitForPipelineControllerJob(loadPipelines()[0]!.id, "settlement");
  };
  const inputModule = await import("./stageInput");
  const compose = inputModule.composeStageInput;
  const compositionWork: number[] = [];
  const composition = spyOn(inputModule, "composeStageInput").mockImplementation(async (...args) => {
    const before = calls;
    try { return await compose(...args); }
    finally { compositionWork.push(calls - before); }
  });
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    calls++;
    const result = await real.call(this, request);
    if (unstable) {
      if (mode === "slow-worker") clock += 180_000;
      else put(calls);
    }
    return result;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const quoted = Array.from({ length: mode === "changing-store" ? 7 : 1 }, (_, index) => protectedText(index)).join("\n");
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build safely. ${quoted}`, next: null }] as never);
    await step();
    await step();
    const deferred = loadPipelines()[0]!;
    expect(h.spawnInputs).toHaveLength(0);
    expect(deferred.state).toBe("running");
    const attempt = deferred.runs[0]!.attempts.at(-1)!;
    expect(attempt.state).toBe("pending");
    expect(attempt.roleMemoryFailures).toBe(1);
    expect(attempt.roleMemoryWait).toBeDefined();
    if (mode === "slow-worker") expect(attempt.roleMemoryWait!.detail).toContain("window-exhausted; retry window exhausted after 180 seconds during privacy worker request");
    expect(calls).toBeLessThanOrEqual(mode === "slow-worker" ? 1 : 3);
    const restarted = Bun.spawn([process.execPath, "-e", `
      import { loadPipelines } from "./src/lib/pipelines/store";
      const attempt = loadPipelines()[0].runs[0].attempts.at(-1);
      console.log(JSON.stringify({ state: attempt.state, failures: attempt.roleMemoryFailures, retryAfter: attempt.roleMemoryWait.retryAfter, detail: attempt.roleMemoryWait.detail }));
    `], { cwd: process.cwd(), env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exit, output, errors] = await Promise.all([restarted.exited, new Response(restarted.stdout).text(), new Response(restarted.stderr).text()]);
    expect(exit, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({ state: "pending", failures: 1, retryAfter: attempt.roleMemoryWait!.retryAfter, ...(attempt.roleMemoryWait!.detail ? { detail: attempt.roleMemoryWait!.detail } : {}) });
    // Reload the durable writer's output before the next scheduled turn.
    savePipelines(loadPipelines());
    if (mode === "changing-store") {
      const firstCalls = calls;
      for (let turn = 0; turn < 8 && loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.roleMemoryFailures === 1; turn++) {
        advanceWall(31_000); await step();
      }
      const again = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
      expect(again.roleMemoryFailures, JSON.stringify({ calls, firstCalls, state: again.state, observations: again.roleMemoryWait?.observations })).toBe(2);
      expect(again.roleMemoryWait!.retryAfter > attempt.roleMemoryWait!.retryAfter).toBe(true);
      expect(compositionWork.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...compositionWork)).toBeLessThanOrEqual(3);
      savePipelines(loadPipelines());
    }
    unstable = false;
    advanceWall(31_000);
    for (let turn = 0; turn < 8 && h.spawnInputs.length === 0; turn++) await step();
    expect(h.spawnInputs).toHaveLength(1);
    for (const text of quoted.split("\n")) expect(h.spawnInputs[0]!.prompt).not.toContain(text);
    expect(h.spawnInputs[0]!.prompt).toContain("[learned rule]");
    const running = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(running.state).toBe("running");
    expect(running.roleMemoryFailures).toBeUndefined();
    if (mode === "slow-worker") expect(calls).toBe(2);
    expect(clock).toBe(mode === "slow-worker" ? 180_000 : 0);
    for (const text of quoted.split("\n")) expect(log.mock.calls.flat().join("\n")).not.toContain(text);
  } finally { worker.mockRestore(); composition.mockRestore(); now.mockRestore(); log.mockRestore(); ids.mockRestore(); await shutdownTaskPageWorker(); }
});
