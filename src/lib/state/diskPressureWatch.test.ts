import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { startDiskPressureWatch, stopDiskPressureWatch } from "./diskPressureWatch";
import type { CleanerController } from "@/lib/cleaner/run";

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
    active: () => true, project: async () => "repo-test", early: () => {},
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
