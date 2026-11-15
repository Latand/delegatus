import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { allocatedAttemptBytes } from "./attemptTempFilesystem";

const NOW = Date.parse("2030-01-20T00:00:00Z");
const roots: string[] = [];
afterEach(() => {
  removeKeepMarkers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function restoreEnvironment(original: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
async function realParentPass() {
  const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload",
    args: [path.join(import.meta.dir, "attemptTempPressure.preload.ts"), path.join(import.meta.dir, "../worktreeSweep.worker.ts")] },
  60_000, { now: () => 0, setTimeout, clearTimeout });
  try { return await worker.attemptTemp() as {
    checked: number; removed: number; removedBytes: number; deferred: number; errors: number; bytes: number; overCapBytes: number;
    outcomes: { directory: string; reason: string }[];
  }; } finally { await worker.close(); }
}
function nativeFenceDeferrals(report: { outcomes: { directory: string; reason: string }[] }, store: AttemptTempStore) {
  const refused = new Set<string>();
  for (const row of report.outcomes) {
    if (!row.reason.includes("attempt mutation fence mount namespace changed")) continue;
    const owner = store.owner(row.directory), stat = fs.statSync(row.directory);
    expect(owner).not.toBeNull(); expect(`${stat.dev}:${stat.ino}`).toBe(owner!.identity);
    expect(fs.readFileSync(path.join(row.directory, "data")).length).toBe(4096);
    refused.add(row.directory);
    console.error(JSON.stringify({ fixture: "native-fence-deferral", root: path.basename(row.directory), reason: row.reason,
      identity: owner!.identity, payloadBytes: 4096 }));
  }
  return refused;
}

for (const lowSpace of [false, true]) for (const timeoutPrefix of [4, 8]) for (const clearsCap of lowSpace ? [false] : [false, true]) {
  test.each([
    { phase: "allocation" as const, requiredCost: 1500, costlyTail: false },
    { phase: "protection" as const, requiredCost: 1500, costlyTail: false },
    { phase: "allocation" as const, requiredCost: 3000, costlyTail: true },
  ])(
    `real parent reuses a protected tail's proof window (timeouts=${timeoutPrefix}, low-space=${lowSpace}, clears-cap=${clearsCap}, phase=$phase, costly-tail=$costlyTail)`, async ({ phase, requiredCost, costlyTail }) => {
    const originalEnv = { ...process.env };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-windows-")); roots.push(root);
    const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
    process.env.LLV_STATE_DIR = state;
    const store = new AttemptTempStore(), config = path.join(root, "fixture.json");
    const directories: { directory: string; identity: string }[] = [];
    const count = timeoutPrefix + 32;
    try {
      savePipelines([finishedLane(root, new Date(NOW - 3600_000).toISOString())]);
      for (let n = 0; n <= count; n++) {
        const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
        store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
        if (n === count) plantKeepMarker(path.join(directory, ".delegatus-keep"));
        store.measure(directory, await allocatedAttemptBytes(directory));
        const stat = fs.statSync(directory); directories.push({ directory, identity: `${stat.dev}:${stat.ino}` });
      }
      const held = directories[count]!, heldBytes = store.owner(held.directory)!.bytes;
      if (clearsCap) store.measure(held.directory, 2e9);
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace || clearsCap ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config;
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
        slowProof: { phase, prefix: count + Number(costlyTail), timeoutPrefix, requiredCost } }));
      const before = store.bytes(), report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
      if (clearsCap) {
        expect(report).toMatchObject({ removed: 0, removedBytes: 0, errors: 0, overCapBytes: 0, checked: count + 1 });
        expect(report.deferred).toBe(count);
        expect(clock.elapsed).toBeLessThanOrEqual(40_001);
        for (const { directory, identity } of directories) {
          const stat = fs.statSync(directory); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
          expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
        }
        expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.failing).toBeFalse();
        return;
      }
      expect(report.removed).toBeGreaterThan(0); expect(report.errors).toBe(0);
      expect(report.checked).toBeLessThanOrEqual(count + 1 + 32);
      expect(report.outcomes).toHaveLength(count + 1);
      expect(new Set(report.outcomes.map(row => row.directory)).size).toBe(count + 1);
      expect(report.deferred).toBe(count - report.removed);
      expect(clock.elapsed).toBeLessThanOrEqual(40_001);
      expect(Math.max(...clock.windows)).toBeLessThanOrEqual(5000);
      expect(report.removedBytes).toBe(before - report.bytes);
      for (const { directory, identity } of [...directories.slice(0, timeoutPrefix), held]) {
        expect(`${fs.statSync(directory).dev}:${fs.statSync(directory).ino}`).toBe(identity);
        expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
      }
      expect(fs.existsSync(path.join(held.directory, ".delegatus-keep"))).toBeTrue();
      // The tail retry never checkpoints past the first fractional probe.
      const next = store.pressurePage(1)[0]!.directory;
      expect(next < directories[timeoutPrefix]!.directory || next === directories[timeoutPrefix]!.directory).toBeTrue();
      console.error(JSON.stringify({ fixture: "protected-proof-tail", phase, timeoutPrefix, lowSpace, costlyTail,
        checked: report.checked, removed: report.removed, removedBytes: report.removedBytes, deferred: report.deferred,
        bytes: report.bytes, elapsed: clock.elapsed }));
      // Restore proof and restart the actual helper over the same durable
      // cursor. The protected root stays while every ended sibling recovers.
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12 }));
      process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = String(heldBytes);
      let removed = report.removed;
      const nativeRefused = new Set<string>();
      for (let pass = 0; pass < 3 && store.bytes() > heldBytes; pass++) {
        const recovered = await realParentPass();
        if (pass === 0) expect(recovered.outcomes[0]!.directory).toBe(next);
        for (const directory of nativeFenceDeferrals(recovered, store)) nativeRefused.add(directory);
        expect(recovered.errors).toBe(0); removed += recovered.removed;
      }
      // Only a named native refusal with proven zero effects permits more
      // starts. A pressure-budget or cursor failure retains the three-pass
      // assertion rather than receiving an unconditional retry.
      for (let retry = 0; retry < 3 && store.bytes() > heldBytes; retry++) {
        for (const owner of store.pressurePage(count + 1).filter(row => row.directory !== held.directory)) {
          expect(nativeRefused.has(owner.directory)).toBeTrue();
          const stat = fs.statSync(owner.directory); expect(`${stat.dev}:${stat.ino}`).toBe(owner.identity);
          expect(fs.readFileSync(path.join(owner.directory, "data")).length).toBe(4096);
        }
        const recovered = await realParentPass(); expect(recovered.errors).toBe(0); removed += recovered.removed;
        for (const directory of nativeFenceDeferrals(recovered, store)) nativeRefused.add(directory);
      }
      expect(removed).toBe(count); expect(store.bytes()).toBe(heldBytes);
      expect(fs.readFileSync(path.join(held.directory, "data")).length).toBe(4096);
      expect(fs.existsSync(path.join(held.directory, ".delegatus-keep"))).toBeTrue();
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.failing).toBeFalse();
    } finally { store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

test.each([false, true])("real parent resumes behind a held suffix without an empty pressure pass (low-space=%s)", async lowSpace => {
  const originalEnv = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-suffix-")); roots.push(root);
  const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(root, "fixture.json");
  try {
    savePipelines([finishedLane(root, new Date(NOW - 3600_000).toISOString())]);
    const ended = path.join(scratch, "llv-stage-000000"), held = path.join(scratch, "llv-stage-000001");
    for (const [index, directory] of [ended, held].entries()) {
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + index });
      if (index === 1) plantKeepMarker(path.join(directory, ".delegatus-keep"));
      store.measure(directory, await allocatedAttemptBytes(directory));
    }
    // A previous full-window deferral checkpointed this ended root. The
    // fresh helper first sees the protected suffix, then must wrap now.
    store.checkpointPressure(store.owner(ended)!);
    const identity = store.owner(held)!.identity, heldBytes = store.owner(held)!.bytes;
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
    process.env.LLV_PRESSURE_FIXTURE = config;
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
      slowProof: { phase: "allocation", prefix: 2, requiredCost: 1500 } }));
    const report = await realParentPass();
    expect(report).toMatchObject({ removed: 1, removedBytes: 12288, checked: 2, deferred: 0, errors: 0, bytes: heldBytes });
    expect(report.outcomes.map(row => row.directory)).toEqual([held, ended]);
    expect(fs.existsSync(ended)).toBeFalse();
    const stat = fs.statSync(held); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
    expect(fs.readFileSync(path.join(held, "data")).length).toBe(4096);
    expect(fs.existsSync(path.join(held, ".delegatus-keep"))).toBeTrue();
    const clock = JSON.parse(fs.readFileSync(config, "utf8")); expect(clock.elapsed).toBeLessThanOrEqual(40_000);
  } finally { store.close(); restoreEnvironment(originalEnv); }
}, 120_000);
