import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { startDiskPressureWatch, stopDiskPressureWatch } from "./diskPressureWatch";
import type { CleanerController } from "@/lib/cleaner/run";
import type { DiskPressure } from "./diskPressure";
import type { MemoryReading } from "./memoryPressure";

test("the pressure observer starts without a resources request and retires its held tick", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    startDiskPressureWatch({ observe: async () => { calls++; started(); await held; } });
    await Promise.race([ready, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("pressure observer did not start")), 5000); })]);
    stopDiskPressureWatch(); release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
  } finally { if (deadline) clearTimeout(deadline); stopDiskPressureWatch(); release(); }
});

test("a standalone watcher anchors daily eligibility once for its whole lifetime", async () => {
  const previousPort = process.env.PORT;
  const previousOwner = process.env.LLV_STATE_OWNER;
  const previousState = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-watch-"));
  process.env.LLV_STATE_DIR = state;
  process.env.PORT = "9230";
  process.env.LLV_STATE_OWNER = "viewer";
  let now = 10_000, launches = 0;
  const callbacks: Array<() => void> = [];
  let completeTick: (() => void) | undefined;
  const schedule = ((callback: () => void) => {
    callbacks.push(callback);
    const fake = { unref() {}, hasRef: () => false, ref() { return this; }, refresh() { return this; } };
    return fake as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const pressure = { at: new Date(now).toISOString(), episode: null, volumes: [], consumers: [], warningBytes: 0, criticalBytes: 0 };
  const cleaner = {
    reconcile: async () => {},
    launchCleanerIfDue: async (_project: () => Promise<string | null>, since: number | (() => number)) => {
      if (now - (typeof since === "function" ? since() : since) >= 10 * 60_000) launches++;
      completeTick?.();
    },
  } as unknown as CleanerController;
  const actions = {
    active: () => true, project: async () => "repo-test",
    card: async () => true, report: async () => true,
  };
  const tick = async () => {
    const done = new Promise<void>(resolve => { completeTick = resolve; });
    callbacks.shift()?.();
    await done;
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    startDiskPressureWatch({ cleaner, actions, now: () => now, readPressure: async () => pressure, schedule });
    await tick();
    now = 10_000 + 10 * 60_000 - 1;
    await tick();
    expect(launches).toBe(0);
    now++;
    await tick();
    expect(launches).toBe(1);
  } finally {
    stopDiskPressureWatch();
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = previousOwner;
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("the automatic pass starts on an unmeasured warning and does not overlap the next observation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-watch-"));
  const saved = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_STATE_OWNER: process.env.LLV_STATE_OWNER };
  process.env.LLV_STATE_DIR = root;
  process.env.LLV_STATE_OWNER = "viewer";
  const pressure: DiskPressure = {
    at: "2031-01-01T00:00:00Z", episode: "warning-fixture",
    volumes: [{ roles: ["state"], level: "warning", freeBytes: 120e9 }],
    consumers: [], criticalBytes: 2e9, warningBytes: 130e9,
  };
  const scheduled: Array<() => void> = [];
  const schedule = ((callback: () => void) => {
    scheduled.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let launches = 0, cards = 0, observations = 0;
  try {
    startDiskPressureWatch({ schedule, readPressure: async () => { observations++; return pressure; },
      automatic: async report => { expect(report).toBe(pressure); launches++; await hold; },
      actions: { active: () => true, project: async () => "repo-fixture",
        card: async () => { cards++; return true; }, report: async () => true },
    });
    scheduled.shift()!();
    for (let i = 0; i < 100 && !scheduled.length; i++) await Bun.sleep(2);
    expect(launches).toBe(1);
    expect(cards).toBe(0);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    for (let i = 0; i < 100 && !scheduled.length; i++) await Bun.sleep(2);
    expect(observations).toBe(2);
    expect(launches).toBe(1);
  } finally {
    stopDiskPressureWatch(); release();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory is read off the beat: a held read delays no disk observation, one runs at a time, and pressure sweeps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-watch-"));
  const saved = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_STATE_OWNER: process.env.LLV_STATE_OWNER };
  process.env.LLV_STATE_DIR = root;
  process.env.LLV_STATE_OWNER = "viewer";
  const scheduled: Array<() => void> = [];
  const schedule = ((callback: () => void) => {
    scheduled.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const calm: DiskPressure = { at: "2031-01-01T00:00:00Z", episode: null, volumes: [], consumers: [], criticalBytes: 0, warningBytes: 0 };
  const answers: Array<{ resolve: (value: MemoryReading) => void; reject: (error: Error) => void }> = [];
  let observations = 0, sweeps = 0;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const tick = async () => {
    scheduled.shift()!();
    for (let i = 0; i < 200 && !scheduled.length; i++) await Bun.sleep(2);
    expect(scheduled).toHaveLength(1);
  };
  try {
    startDiskPressureWatch({ schedule, now: () => Date.parse("2031-01-01T00:00:00Z"), readPressure: async () => { observations++; return calm; },
      actions: { active: () => true, project: async () => "repo-fixture", card: async () => true, report: async () => true },
      readMemory: () => new Promise<MemoryReading>((resolve, reject) => { answers.push({ resolve, reject }); }),
      memoryActions: { active: () => true, project: async () => null, card: async () => true, report: async () => true, sweep: () => { sweeps++; } },
    });
    await tick();
    await tick();
    expect(observations).toBe(2);
    expect(answers).toHaveLength(1);
    answers[0]!.reject(new Error("reader stopped"));
    await Bun.sleep(5);
    expect(logged).toHaveBeenCalledWith("[memory pressure] observation failed", "reader stopped");
    await tick();
    expect(answers).toHaveLength(2);
    answers[1]!.resolve({ ram: { usedBytes: 1, totalBytes: 2 }, swap: { usedBytes: 9, totalBytes: 10 }, tmp: null });
    for (let i = 0; i < 500 && !sweeps; i++) await Bun.sleep(2);
    expect(sweeps).toBe(1);
  } finally {
    stopDiskPressureWatch(); logged.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
