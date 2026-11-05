import "./engineEnvironment.fixture";
import { expect, spyOn, test } from "bun:test";
import * as timers from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { create, harness, tickPipelines, loadPipelines, savePipelines, reserveActivationOnly } from "./engine.fixture";
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
      expect(lane.state).toBe("needs_decision");
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
        expect(lane.state).toBe("needs_decision");
        expect(lane.stateDetail).toContain(mode === "permanent" ? "access-denied" : "store-busy; retry window exhausted after 180 seconds");
        expect(lane.stateDetail).not.toContain(rule);
        expect(clock).toBe(mode === "permanent" ? 0 : 180_000);
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
      expect(after.state).toBe("needs_decision");
      expect(after.stateDetail).toContain("store-busy; retry window exhausted after 180 seconds");
      expect(after.stateDetail).not.toContain(rule);
      expect(clock).toBe(180_000);
    }
  } finally { read.mockRestore(); now.mockRestore(); pause.mockRestore(); log.mockRestore(); await shutdownTaskPageWorker(); }
});
