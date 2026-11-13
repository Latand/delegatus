import { expect, test } from "bun:test";
import { createLoopProfilerSupervisor, LOOP_PROFILE_COOLDOWN_MS, LOOP_PROFILE_STALL_MS,
  LOOP_PROFILE_CAPTURE_MS, loopProfileCaptureRefusal, type ProfilerControl } from "./loopProfilerSupervisor";
import { createLoopProfileStore, LOOP_PROFILE_STORED_CAP, LOOP_PROFILE_STORE_BYTES } from "./loopProfilerStore";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

function harness() {
  let at = 1_000_000, calls = 0, next = 0;
  let settings: ProfilerControl = { enabled: true, automatic: true, manualUntil: 0 };
  const decisions: string[] = [];
  let settingsRead: (() => Promise<ProfilerControl>) | undefined;
  let capture: (() => Promise<void>) | undefined;
  let beginDelay: (() => Promise<void>) | undefined;
  let afterReserve: (() => void) | undefined;
  const supervisor = createLoopProfilerSupervisor({ now: () => at,
    settings: () => settingsRead ? settingsRead() : Promise.resolve(settings),
    reserve: async now => { if (now < next) return false; next = now + LOOP_PROFILE_COOLDOWN_MS; afterReserve?.(); return true; },
    beginCapture: async (now, admittedAt) => {
      await beginDelay?.();
      if (next !== admittedAt + LOOP_PROFILE_COOLDOWN_MS || now < admittedAt) return false;
      next = now + LOOP_PROFILE_COOLDOWN_MS; return true;
    },
    cancel: async () => {},
    complete: async () => {},
    capture: async (_source, beginCapture, captureStarted) => { calls++;
      if (!await beginCapture(at)) return "cooldown"; captureStarted(); await capture?.(); return undefined; },
    decision: reason => decisions.push(reason) });
  return { supervisor, decisions, get calls() { return calls; }, get at() { return at; },
    time: (time: number) => { at = time; }, settings: (value: Partial<ProfilerControl>) => { settings = { ...settings, ...value }; },
    read: (value: () => Promise<ProfilerControl>) => { settingsRead = value; },
    capture: (value: () => Promise<void>) => { capture = value; },
    beginDelay: (value: () => Promise<void>) => { beginDelay = value; },
    reserved: (value: () => void) => { afterReserve = value; } };
}

test("a six-second recovered stall arms a bounded capture at any process age", async () => {
  const h = harness(); await h.supervisor.refresh(); h.time(h.at + 9 * 60 * 60_000);
  h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(h.calls).toBe(1); expect(h.decisions).toContain("armed-automatic");
  expect(LOOP_PROFILE_CAPTURE_MS).toBe(5000);
});

test.each([4000, LOOP_PROFILE_STALL_MS])("a %s ms stall does not arm", async gap => {
  const h = harness(); h.supervisor.stall(gap); await h.supervisor.refresh(); expect(h.calls).toBe(0);
});

test("repeated stalls obey cooldown, including a stall during collection", async () => {
  const h = harness(); h.capture(async () => { h.supervisor.stall(6000); });
  h.supervisor.stall(6000); await h.supervisor.refresh();
  for (let i = 0; i < 20; i++) { h.supervisor.stall(6000); await h.supervisor.refresh(); }
  expect(h.calls).toBe(1);
  h.time(h.at + LOOP_PROFILE_COOLDOWN_MS); h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(h.calls).toBe(2);
});

test("cooldown starts after delayed durable admission and applies to the next sampling call", async () => {
  const h = harness(); const callsAt: number[] = [];
  h.capture(async () => { callsAt.push(h.at); });
  let delayed = false;
  h.beginDelay(async () => { if (!delayed) { delayed = true; h.time(h.at + LOOP_PROFILE_COOLDOWN_MS); } });
  h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(callsAt).toEqual([1_000_000 + LOOP_PROFILE_COOLDOWN_MS]);
  h.capture(async () => { callsAt.push(h.at); });
  h.time(callsAt[0]! + LOOP_PROFILE_COOLDOWN_MS - 1); h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(callsAt).toHaveLength(1);
  h.time(callsAt[0]! + LOOP_PROFILE_COOLDOWN_MS); h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(callsAt).toEqual([1_000_000 + LOOP_PROFILE_COOLDOWN_MS, 1_000_000 + 2 * LOOP_PROFILE_COOLDOWN_MS]);
});

test("manual request works with automatic disabled and expires", async () => {
  const h = harness(); h.settings({ automatic: false, manualUntil: h.at + 30_000 });
  await h.supervisor.refresh(); expect(h.calls).toBe(1); expect(h.decisions).toContain("armed-manual");
  h.time(h.at + 30_000); await h.supervisor.refresh();
  expect(h.decisions.at(-1)).toBe("automatic-disabled"); expect(h.calls).toBe(1);
});

test("kill switch suppresses both sources and can be released without restart", async () => {
  const h = harness(); h.settings({ enabled: false, manualUntil: h.at + 30_000 });
  h.supervisor.stall(6000); await h.supervisor.refresh(); expect(h.calls).toBe(0);
  expect(h.decisions).toEqual(["kill-switch"]);
  h.settings({ enabled: true }); await h.supervisor.refresh(); expect(h.calls).toBe(1);
});

test("expired or excessively distant manual requests never arm", async () => {
  const h = harness();
  for (const manualUntil of [h.at, h.at - 1, h.at + 60_001, Infinity, NaN]) {
    h.settings({ automatic: false, manualUntil }); await h.supervisor.refresh();
  }
  expect(h.calls).toBe(0);
});

test("stop during settings admission prevents capture and decisions are deduplicated", async () => {
  const h = harness(); await h.supervisor.refresh(); await h.supervisor.refresh();
  expect(h.decisions).toEqual(["waiting-for-stall"]);
  h.read(async () => { h.supervisor.stop(); return { enabled: true, automatic: true, manualUntil: h.at + 10_000 }; });
  await h.supervisor.refresh(); expect(h.calls).toBe(0);
});

test.each(["kill", "automatic-off", "stop"])("revalidates %s after durable admission", async change => {
  const h = harness();
  h.reserved(() => {
    if (change === "stop") h.supervisor.stop();
    else h.settings(change === "kill" ? { enabled: false } : { automatic: false });
  });
  h.supervisor.stall(6000); await h.supervisor.refresh(); expect(h.calls).toBe(0);
});

test("final capture guard rechecks expiry and source after asynchronous loading", () => {
  const control = { enabled: true, automatic: true, manualUntil: 1_030_000 };
  expect(loopProfileCaptureRefusal(control, "manual", 1_000_000)).toBeUndefined();
  expect(loopProfileCaptureRefusal(control, "manual", 1_030_000)).toBe("manual-expired");
  expect(loopProfileCaptureRefusal({ ...control, automatic: false }, "automatic", 1_000_000)).toBe("automatic-disabled");
  for (const source of ["manual", "automatic"] as const) {
    expect(loopProfileCaptureRefusal({ ...control, enabled: false }, source, 1_000_000)).toBe("kill-switch");
  }
});

test("capture and settings failures have fixed reasons and allow later recovery", async () => {
  const h = harness(); h.capture(async () => { throw new Error("private input"); });
  h.supervisor.stall(6000); await h.supervisor.refresh(); expect(h.decisions.at(-1)).toBe("capture-failed");
  h.read(async () => { throw new Error("private input"); }); await h.supervisor.refresh();
  expect(h.decisions.at(-1)).toBe("settings-unavailable");
  expect(JSON.stringify(h.decisions)).not.toContain("private input");
  h.time(h.at + LOOP_PROFILE_COOLDOWN_MS); h.capture(async () => {});
  h.read(async () => ({ enabled: true, automatic: true, manualUntil: 0 }));
  h.supervisor.stall(6000); await h.supervisor.refresh();
  expect(h.calls).toBe(2); expect(h.decisions.at(-1)).toBe("cooldown");
});

test("stored summaries remain capped and durable cooldown survives fresh store owners", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-store-"));
  try {
    for (let i = 0; i < LOOP_PROFILE_STORED_CAP + 5; i++) {
      const at = 1_000_000 + i * (LOOP_PROFILE_COOLDOWN_MS + 10);
      const store = createLoopProfileStore(directory);
      expect(await store.reserve(at)).toBe(true);
      expect(await store.beginCapture(at, at)).toBe(true);
      expect(await store.completeCapture(at + 10, at)).toBe(true);
      await store.save({ status: "captured", from: at, to: at + 5000, intervalUs: 10000 }, "a".repeat(40), at + 5000);
      expect(await createLoopProfileStore(directory).reserve(at + 1)).toBe(false);
    }
    const saved = JSON.parse(await readFile(path.join(directory, "loop-profiler-captures.json"), "utf8"));
    expect(saved.profiles).toHaveLength(LOOP_PROFILE_STORED_CAP);
    expect(saved.profiles[0].profile.from).toBe(1_000_000 + 5 * (LOOP_PROFILE_COOLDOWN_MS + 10));
    expect(saved.profiles[0].revision).toBe("a".repeat(40));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an in-flight durable admission blocks a fresh store owner and finalizes from sampling time", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-store-pending-"));
  try {
    const first = createLoopProfileStore(directory);
    const reservedAt = 1_000_000;
    expect(await first.reserve(reservedAt)).toBe(true);
    expect(await first.beginCapture(reservedAt, reservedAt)).toBe(true);
    const restartedOwner = createLoopProfileStore(directory);
    expect(await restartedOwner.reserve(reservedAt + LOOP_PROFILE_COOLDOWN_MS * 4)).toBe(false);
    const samplingAt = reservedAt + LOOP_PROFILE_COOLDOWN_MS * 4;
    expect(await first.completeCapture(samplingAt, reservedAt)).toBe(true);
    expect(await createLoopProfileStore(directory).reserve(samplingAt + LOOP_PROFILE_COOLDOWN_MS - 1)).toBe(false);
    expect(await createLoopProfileStore(directory).reserve(samplingAt + LOOP_PROFILE_COOLDOWN_MS)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a dead process's unfinished admission recovers to a full conservative cooldown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-store-recovery-"));
  try {
    const store = createLoopProfileStore(directory);
    const reservedAt = 1_000_000;
    expect(await store.reserve(reservedAt)).toBe(true);
    const file = path.join(directory, "loop-profiler-captures.json");
    const ledger = JSON.parse(await readFile(file, "utf8"));
    ledger.pendingCapture.pid = 2_147_483_647;
    await writeFile(file, JSON.stringify(ledger));
    const recoveredAt = reservedAt + 4 * LOOP_PROFILE_COOLDOWN_MS;
    expect(await createLoopProfileStore(directory).reserve(recoveredAt)).toBe(false);
    expect(await createLoopProfileStore(directory).reserve(recoveredAt + LOOP_PROFILE_COOLDOWN_MS - 1)).toBe(false);
    expect(await createLoopProfileStore(directory).reserve(recoveredAt + LOOP_PROFILE_COOLDOWN_MS)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("corrupt storage refuses admission and oversized summaries cannot grow the file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-store-invalid-"));
  try {
    const store = createLoopProfileStore(directory);
    await writeFile(path.join(directory, "loop-profiler-captures.json"), "invalid");
      await expect(store.reserve(1_000_000)).rejects.toThrow();
    await rm(path.join(directory, "loop-profiler-captures.json"));
    expect(await store.reserve(1_000_000)).toBe(true);
    const before = await readFile(path.join(directory, "loop-profiler-captures.json"), "utf8");
    await expect(store.save({ status: "captured", from: 0, to: 5000, intervalUs: 10000,
      frames: { samples: 1, inspectedSamples: 1, sampleCap: 4096, depthCap: 32, frameCap: 128, topN: 16,
        rows: [{ function: "x".repeat(9000), file: "src/example.ts",
        line: 1, column: 1, self: 1, total: 1, selfWeight: 1, totalWeight: 1 }] } }, "a".repeat(40), 1_000_000)).rejects.toThrow("profile-store-invalid");
    expect(await readFile(path.join(directory, "loop-profiler-captures.json"), "utf8")).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("each persisted guard refuses without rewriting history and releases admission", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-store-guards-"));
  try {
    const file = path.join(directory, "loop-profiler-captures.json");
    const row = { revision: "a".repeat(40), capturedAt: 1_000_000,
      profile: { status: "captured", from: 0, to: 5000, intervalUs: 10000 } };
    const ledger = { nextCaptureAt: 0, profiles: [row] };
    const full = { nextCaptureAt: 0, profiles: [], padding: "" };
    full.padding = "x".repeat(LOOP_PROFILE_STORE_BYTES - Buffer.byteLength(JSON.stringify(full)));
    const invalid = ["null", " ".repeat(LOOP_PROFILE_STORE_BYTES + 1),
      JSON.stringify(full),
      JSON.stringify({ ...ledger, nextCaptureAt: -1 }), JSON.stringify({ ...ledger, profiles: {} }),
      JSON.stringify({ ...ledger, profiles: Array(LOOP_PROFILE_STORED_CAP + 1).fill(row) }),
      ...[{ ...row, revision: "invalid" }, { ...row, revision: 1234567 }, { ...row, capturedAt: -1 },
        { ...row, capturedAt: 1.5 }, { ...row, profile: null },
        { ...row, profile: { status: "not-armed", reason: "stopped" } },
        { ...row, profile: { ...row.profile, padding: "x".repeat(9000) } }]
        .map(value => JSON.stringify({ ...ledger, profiles: [value] }))];
    const store = createLoopProfileStore(directory);
    for (const value of invalid) {
      await writeFile(file, value); await expect(store.reserve(1_000_000)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(value);
      await writeFile(file, JSON.stringify(ledger)); expect(await store.reserve(1_000_000)).toBe(true);
    }
    const before = await readFile(file, "utf8");
    for (const at of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) await expect(store.reserve(at)).rejects.toThrow();
    for (const [revision, capturedAt] of [["invalid", 1_000_000], ["a".repeat(40), -1]] as const) {
      await expect(store.save({ status: "captured", from: 0, to: 5000, intervalUs: 10000 }, revision, capturedAt)).rejects.toThrow();
    }
    await expect(store.save({ status: "not-armed", reason: "stopped" }, "a".repeat(40), 1_000_000)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
