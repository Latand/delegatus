import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { allocatedAttemptBytes } from "./attemptTempFilesystem";

import { cleanupPressureFixtures, NOW, fixture, realParentPass, restoreEnvironment, nativeFenceDeferrals, ledgerRoots } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

test.each([
  { phase: "allocation" as const, holdFirst: false }, { phase: "protection" as const, holdFirst: false },
  { phase: "allocation" as const, holdFirst: true }, { phase: "protection" as const, holdFirst: true },
])("real parent makes progress across restarts with a uniform finite $phase cost (held-prefix=$holdFirst)", async ({ phase, holdFirst }) => {
  const originalEnv = { ...process.env }, f = fixture();
  const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json");
  try {
    savePipelines([finishedLane(f.root, new Date(NOW - 2 * 86400_000).toISOString())]);
    for (let n = 0; n < 33; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      if (holdFirst && n === 0) plantKeepMarker(path.join(directory, ".delegatus-keep"));
    }
    const heldBytes = holdFirst ? await allocatedAttemptBytes(path.join(scratch, "llv-stage-000000")) : 0;
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    let removed = 0;
    const nativeRefused = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: 1e12, slowProof: { phase, prefix: 33, requiredCost: 1500 } }));
      const before = store.bytes(), report = await realParentPass();
      for (const directory of nativeFenceDeferrals(report, store)) nativeRefused.add(directory);
      const clock = JSON.parse(fs.readFileSync(config, "utf8"));
      if (before > heldBytes) expect(report.removed).toBeGreaterThan(0);
      expect(report.errors).toBe(0); expect(report.checked).toBeLessThanOrEqual(32);
      // The timeout seam crosses its assigned deadline by one millisecond.
      expect(clock.elapsed ?? 0).toBeLessThanOrEqual(40_001);
      expect(Math.max(...(clock.windows ?? [0]))).toBeLessThanOrEqual(5000);
      removed += report.removed;
      console.error(JSON.stringify({ fixture: "uniform-finite-proof", phase, holdFirst, pass, removed: report.removed,
        checked: report.checked, deferred: report.deferred, bytes: report.bytes, elapsed: clock.elapsed }));
    }
    for (let retry = 0; retry < 3 && store.bytes() > heldBytes; retry++) {
      for (const owner of ledgerRoots(store, scratch).filter(row => !holdFirst || !row.directory.endsWith("000000")))
        expect(nativeRefused.has(owner.directory)).toBeTrue();
      fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: 1e12, slowProof: { phase, prefix: 33, requiredCost: 1500 } }));
      const report = await realParentPass(); expect(report.errors).toBe(0); removed += report.removed;
      for (const directory of nativeFenceDeferrals(report, store)) nativeRefused.add(directory);
    }
    expect(removed).toBe(holdFirst ? 32 : 33); expect(store.bytes()).toBe(heldBytes);
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 120_000);

for (const lowSpace of [false, true]) for (const timeoutPrefix of [1, 8, 32]) {
  test.each(["allocation", "protection"] as const)(
    `real parent progresses through mixed timeout/finite %s proofs (timeouts=${timeoutPrefix}, low-space=${lowSpace})`, async phase => {
    const originalEnv = { ...process.env }, f = fixture();
    const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
    process.env.LLV_STATE_DIR = state;
    const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json");
    const directories: { directory: string; identity: string }[] = [];
    const finiteCount = timeoutPrefix === 1 ? 32 : 8, count = timeoutPrefix + finiteCount;
    try {
      savePipelines([finishedLane(f.root, new Date(NOW - 2 * 86400_000).toISOString())]);
      for (let n = 0; n < count; n++) {
        const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
        store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
        store.measure(directory, 12288);
        const stat = fs.statSync(directory); directories.push({ directory, identity: `${stat.dev}:${stat.ino}` });
      }
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config;
      let removed = 0;
      let previousFirst: string | undefined;
      for (let pass = 0; pass < 8 && removed < finiteCount; pass++) {
        fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: lowSpace ? 0 : 1e12,
          slowProof: { phase, prefix: count, timeoutPrefix, requiredCost: 1500 } }));
        const report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
        // Fully unavailable roots get bounded visits and a durable cursor.
        // A tick spent on that prefix need not repeat it on the next start.
        expect(report.pass?.position).toBeGreaterThan(0);
        expect(report.errors).toBe(0); expect(report.checked).toBeLessThanOrEqual(count + 32);
        expect(clock.elapsed ?? 0).toBeLessThanOrEqual(40_001);
        expect(Math.max(...(clock.windows ?? [0]))).toBeLessThanOrEqual(5000);
        if (timeoutPrefix > 1 && removed < finiteCount) {
          const first = report.outcomes[0]!.directory;
          if (previousFirst) expect(first > previousFirst).toBeTrue();
          previousFirst = first;
        }
        removed += report.removed;
        expect(report.bytes).toBe((count - removed) * 12288);
        for (const { directory, identity } of directories.slice(0, timeoutPrefix)) {
          const stat = fs.statSync(directory); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
          expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
        }
        console.error(JSON.stringify({ fixture: "mixed-timeout-finite", phase, timeoutPrefix, lowSpace, pass,
          checked: report.checked, removed: report.removed, removedBytes: report.removedBytes,
          deferred: report.deferred, bytes: report.bytes, elapsed: clock.elapsed }));
      }
      expect(removed).toBe(finiteCount);
      if (timeoutPrefix === 8) expect(fs.existsSync(directories[timeoutPrefix]!.directory)).toBeFalse();
      // A new helper with the same ledger recovers when the unavailable
      // proofs return. Timeout roots retained their bytes and inode above.
      fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: lowSpace ? 0 : 1e12 }));
      for (let pass = 0; store.bytes() > 0 && pass < 3; pass++) {
        const report = await realParentPass(); expect(report.removed).toBeGreaterThan(0); expect(report.errors).toBe(0);
      }
      expect(store.bytes()).toBe(0);
      for (const { directory } of directories) expect(fs.existsSync(directory)).toBeFalse();
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.failing).toBeFalse();
    } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

test.each(["timeout", "permission-denied"] as const)("real parent retains pressure after a %s lower-bound measurement", async partialMeasurement => {
  const originalEnv = { ...process.env }, f = fixture();
  const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json"), directories: string[] = [];
  try {
    savePipelines([finishedLane(f.root, new Date(NOW - 2 * 86400_000).toISOString())]);
    for (let n = 0; n < 2; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      if (partialMeasurement === "permission-denied") plantKeepMarker(path.join(directory, ".delegatus-keep"));
    }
    fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: 1e12, partialMeasurement }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "20000"; process.env.LLV_PRESSURE_FIXTURE = config;
    for (let pass = 0; pass < 2; pass++) {
      const report = await realParentPass();
      expect(report).toMatchObject({ removed: 0, bytes: 24576, overCapBytes: 4576, errors: 0 });
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.overCap).toBeTrue();
      let physical = 0;
      for (const directory of directories) {
        physical += await allocatedAttemptBytes(directory);
        expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
      }
      expect(physical).toBeGreaterThan(20000);
    }
    removeKeepMarkers();
    fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: 1e12 }));
    const recovered = await realParentPass();
    expect(recovered).toMatchObject({ removed: 1, bytes: 12288, overCapBytes: 0, errors: 0 });
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 120_000);
