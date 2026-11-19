import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureProcessIdentity } from "../processIdentity";
import { withoutInheritedGate } from "../testing/inheritedGateEnv";
import { realExec } from "../workflows/provision";
import { CpuAdmissionQueue, CPU_QUEUE_SPACING_MS, CPU_STAGE_POLL_MS } from "./cpuAdmission";
import { hasStartupCpuHeadroom, urgentStageCapacitySampler } from "./urgentStageCapacity";

const first = `stage:${"a".repeat(64)}:fixture-first:build:3`;
const second = `stage:${"a".repeat(64)}:fixture-second:build:1`;
const start = Date.parse("2026-11-18T00:00:00.000Z");

function withQueue(run: (fixture: ReturnType<typeof queueFixture>) => void) {
  const fixture = queueFixture();
  try { run(fixture); } finally { fixture.close(); }
}

function queueFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "urgent-stage-cpu-"));
  const file = path.join(root, "admission.sqlite");
  const database = path.join(root, "priority.sqlite");
  const tasks = new Database(database);
  tasks.exec("CREATE TABLE state_rows (collection TEXT, row_key TEXT, value_json TEXT, PRIMARY KEY(collection, row_key))");
  const add = tasks.query("INSERT INTO state_rows VALUES ('tasks', ?, ?)");
  add.run("t:high", JSON.stringify({ priority: "high" }));
  add.run("t:normal", JSON.stringify({ priority: "normal" }));
  let now = start;
  const queue = new CpuAdmissionQueue(file, () => now);
  const priority = { database, taskIds: ["high"] };
  const revision = "pending-revision-three";
  const capacity = (key: string, hasCapacity: boolean) => ({ key, revision, sampledAt: now, lastBeforeProbe: queue.lastAdmission(), hasCapacity });
  const poll = (key: string, evidence = capacity(key, true), source = priority, currentRevision = () => revision) =>
    queue.check(key, false, undefined, true, source, false, undefined, { evidence, currentRevision });
  return { root, queue, database, priority, revision, capacity, poll, now: () => now, at: (elapsed: number) => { now = start + elapsed; }, close() {
    queue.close();
    tasks.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

test("an urgent attempt three admits on the next poll after fresh spare CPU is observed under sustained pressure", () => withQueue(f => {
  expect(f.poll(first, f.capacity(first, false))).toMatchObject({ since: start, priority: "high", position: 1, heldBy: "pressure" });
  expect(f.queue.lastAdmission()).toBeNull();
  f.at(CPU_STAGE_POLL_MS);
  expect(f.poll(first)).toBeNull();
  expect(f.queue.lastAdmission()).toBe(start + CPU_STAGE_POLL_MS);
}));

test("high startup keeps FIFO and spacing when fresh CPU evidence is available", () => withQueue(f => {
  expect(f.poll(first, f.capacity(first, false))).toMatchObject({ position: 1 });
  f.at(1);
  expect(f.poll(second)).toMatchObject({ position: 2, heldBy: "queue" });
  f.at(CPU_STAGE_POLL_MS);
  expect(f.poll(first)).toBeNull();
  expect(f.poll(second)).toMatchObject({ position: 1, heldBy: "queue" });
  f.at(CPU_STAGE_POLL_MS + CPU_QUEUE_SPACING_MS);
  expect(f.poll(second)).toBeNull();
}));

test("an intervening heavy admission and an expired measurement both require a new capacity observation", () => withQueue(f => {
  const key = "command:bounded:fixture-heavy";
  const before = f.capacity(first, true);
  const owner = captureProcessIdentity(process.pid);
  expect(f.queue.check(key, false, owner, true, f.priority, true, { slot: 1, cap: 1, lastBeforeProbe: null }, { evidence: before, currentRevision: () => f.revision }))
    .toMatchObject({ heldBy: "pressure" });
  expect(f.queue.check(key, true, owner, true, f.priority, true, { slot: 1, cap: 1, lastBeforeProbe: null })).toBeNull();
  f.at(CPU_QUEUE_SPACING_MS);
  expect(f.poll(first, before)).toMatchObject({ heldBy: "pressure" });
  const old = f.capacity(first, true);
  f.at(CPU_QUEUE_SPACING_MS + CPU_STAGE_POLL_MS + 1);
  expect(f.poll(first, old)).toMatchObject({ heldBy: "pressure" });
  expect(f.poll(first)).toBeNull();
}));

test("CPU capacity alone gives no early admission to normal stages or high workflows", () => withQueue(f => {
  expect(f.poll(first, f.capacity(first, true), { database: f.database, taskIds: ["normal"] })).toMatchObject({ heldBy: "pressure" });
  expect(f.poll("workflow:fixture:build:1")).toMatchObject({ heldBy: "pressure", priority: "high" });
}));

const firstCpuSample = { at: 0, total: 10_000, idle: 1_000, quota: 160_000, period: 20_000, usageUsec: 1_000_000, throttled: 9 };
const nextCpuSample = { ...firstCpuSample, at: 250, total: 10_600, idle: 1_150, usageUsec: 2_000_000 };

test.each([
  ["spare in both budgets", {}, true],
  ["work slice quota exhausted", { usageUsec: 3_000_000 }, false],
  ["host CPUs saturated", { idle: 1_025 }, false],
  ["kernel throttled the work slice", { throttled: 10 }, false],
  ["work quota changed", { quota: 120_000 }, false],
  ["work counter reset", { usageUsec: 0 }, false],
] as const)("urgent CPU sampling checks %s", (_reason, override, expected) => {
  expect(hasStartupCpuHeadroom(firstCpuSample, { ...nextCpuSample, ...override }, 24, 300)).toBe(expected);
});

test.skipIf(process.platform !== "linux")("a real heavy gate keeps its slot during bounded urgent startup", async () => {
  const f = queueFixture();
  const control = new AbortController();
  const pressure = path.join(f.root, "pressure");
  const ready = path.join(f.root, "ready");
  const release = path.join(f.root, "release");
  const env = { ...process.env, LLV_GATE_LOCK_DIR: f.root, LLV_GATE_SLOTS: "1", LLV_GATE_PSI_FILE: pressure,
    LLV_GATE_POLL_SECONDS: "0.02", LLV_GATE_PSI_RELEASE_SECONDS: "0", LLV_GATE_RUNNER: "off",
    DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "on", URGENT_GATE_READY: ready, URGENT_GATE_RELEASE: release };
  withoutInheritedGate(env, { keepSandbox: true });
  writeFileSync(pressure, "some avg10=0.00 total=1\n");
  const command = 'touch "$URGENT_GATE_READY"; while [[ ! -f "$URGENT_GATE_RELEASE" ]]; do sleep 0.02; done';
  const gate = realExec("bash", ["scripts/gate-slot.sh", "bash", "-c", command], process.cwd(), env,
    { timeoutMs: 15_000, signal: control.signal });
  try {
    const deadline = performance.now() + 10_000;
    while (!existsSync(ready)) {
      if (performance.now() >= deadline) throw new Error("background heavy slot was never acquired");
      await Bun.sleep(10);
    }
    const claimedAt = f.queue.lastAdmission();
    if (claimedAt === null) throw new Error("the background heavy command has no durable admission");
    const slot = path.join(f.root, "llv-heavy-gate.slot1.lock");
    expect(Bun.spawnSync(["flock", "-n", slot, "true"]).exitCode).toBe(1);
    writeFileSync(pressure, "some avg10=90.00 total=1\n");
    f.at(claimedAt - start + CPU_QUEUE_SPACING_MS);
    expect(f.poll(first, f.capacity(first, false))).toMatchObject({ heldBy: "pressure" });
    expect(f.poll(first)).toBeNull();
    expect(Bun.spawnSync(["flock", "-n", slot, "true"]).exitCode).toBe(1);
    writeFileSync(release, "release\n");
    const result = await gate;
    expect(result.code, result.stderr).toBe(0);
    expect(Bun.spawnSync(["flock", "-n", slot, "true"]).exitCode).toBe(0);
  } finally {
    control.abort();
    await Promise.allSettled([gate]);
    f.close();
  }
}, 30_000);


test.each([5_000, 5_500, 8_000])("capacity completion wakes the current high stage before a %i ms periodic poll", async period => {
  const f = queueFixture();
  const measure = Promise.withResolvers<boolean>();
  const sampler = urgentStageCapacitySampler(() => measure.promise, f.now);
  const admission: Array<{ key: string; elapsed: number }> = [];
  const currentRevision = () => f.revision;
  const check = () => {
    const evidence = sampler.latest(f.queue, first);
    return f.queue.check(first, false, undefined, true, f.priority, false, undefined,
      evidence ? { evidence, currentRevision } : undefined);
  };
  try {
    expect(check()).toMatchObject({ heldBy: "pressure", position: 1 });
    const work = sampler.refresh(f.queue, first, { currentRevision,
      async makeDue(revision, expiresAt) {
        expect(revision).toBe(f.revision);
        expect(expiresAt).toBe(start + 250 + CPU_STAGE_POLL_MS);
        return revision;
      },
      wake() { if (check() === null) admission.push({ key: first, elapsed: f.now() - start }); },
    });
    expect(work).toBeDefined();
    f.at(250);
    measure.resolve(true);
    await work;
    f.at(period);
    expect(admission).toEqual([{ key: first, elapsed: 250 }]);
    expect(f.queue.lastAdmission()).toBe(start + 250);
  } finally { measure.resolve(false); f.close(); }
});

test.each(["head", "last-admission", "new-revision", "no-budget", "expired"] as const)(
  "a changed %s during urgent admission keeps the stage pending", async change => {
    const f = queueFixture();
    const measured = Promise.withResolvers<boolean>();
    const sampler = urgentStageCapacitySampler(() => measured.promise, f.now);
    let revision = f.revision;
    let admitted = false, wakes = 0;
    const currentRevision = () => revision;
    try {
      if (change === "head") {
        f.poll(second, f.capacity(second, false));
        f.queue.suspend(second);
        f.at(1);
      }
      f.poll(first, f.capacity(first, false));
      const work = sampler.refresh(f.queue, first, { currentRevision,
        async makeDue(observed, expiresAt) {
          if (change === "expired") f.at(expiresAt - start + 1);
          return observed;
        },
        wake() {
          wakes++;
          const evidence = sampler.latest(f.queue, first);
          admitted = f.queue.check(first, false, undefined, true, f.priority, false, undefined,
            evidence ? { evidence, currentRevision } : undefined) === null;
        },
      });
      expect(work).toBeDefined();
      f.at(250);
      if (change === "head") expect(f.poll(second, f.capacity(second, false))?.position).toBe(1);
      if (change === "last-admission") {
        const key = "command:bounded:fixture-heavy";
        const owner = captureProcessIdentity(process.pid);
        expect(f.queue.check(key, true, owner, true, f.priority, true, { slot: 1, cap: 1, lastBeforeProbe: null })).toBeNull();
      }
      if (change === "new-revision") revision = "replacement-revision";
      measured.resolve(change !== "no-budget");
      await work;
      expect(admitted).toBe(false);
      expect(wakes).toBe(change === "head" || change === "expired" ? 1 : 0);
      expect(f.queue.lastAdmission()).toBe(change === "last-admission" ? start + 250 : null);
    } finally { measured.resolve(false); f.close(); }
  });
