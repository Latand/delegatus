import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { allocatedAttemptBytes } from "./attemptTempFilesystem";
import { cleanupPressureFixtures, NOW, roots, realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";
import { protectedTailTests } from "./attemptTempRetention.proofCases.fixture";

afterEach(cleanupPressureFixtures);
protectedTailTests(4);

for (const lowSpace of [false, true]) for (const phase of ["allocation", "protection"] as const) {
  test(`real parent retries past multiple costly held tails (${phase}, low-space=${lowSpace})`, async () => {
    const originalEnv = { ...process.env };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-held-tails-")); roots.push(root);
    const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
    process.env.LLV_STATE_DIR = state;
    const store = new AttemptTempStore(), config = path.join(root, "fixture.json");
    const directories: { directory: string; identity: string }[] = [];
    try {
      savePipelines([finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString())]);
      // Eight exhausted proofs, one available ended root, forty expensive
      // protected roots: the latter must leave the retry reserve usable.
      for (let n = 0; n < 49; n++) {
        const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
        store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
        if (n >= 9) plantKeepMarker(path.join(directory, ".delegatus-keep"));
        store.measure(directory, await allocatedAttemptBytes(directory));
        const stat = fs.statSync(directory); directories.push({ directory, identity: `${stat.dev}:${stat.ino}` });
      }
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config;
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
        slowProof: { phase, prefix: 49, timeoutPrefix: 8, requiredCost: 1500 } }));
      const before = store.bytes();
      let report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
      for (let tick = 1; fs.existsSync(directories[8]!.directory) && tick < 5; tick++) {
        expect(report.errors).toBe(0); expect(clock.elapsed).toBeLessThanOrEqual(40_001);
        fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
          slowProof: { phase, prefix: 49, timeoutPrefix: 8, requiredCost: 1500 } }));
        report = await realParentPass(); clock = JSON.parse(fs.readFileSync(config, "utf8"));
      }
      // Inspect every protected inode and the complete payload before the
      // progress assertion, including when run against the unfixed code.
      for (const { directory, identity } of [...directories.slice(0, 8), ...directories.slice(9)]) {
        const stat = fs.statSync(directory); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
        expect(fs.readFileSync(path.join(directory, "data"))).toEqual(Buffer.alloc(4096));
      }
      for (const { directory } of directories.slice(9)) expect(fs.existsSync(path.join(directory, ".delegatus-keep"))).toBeTrue();
      expect(report.errors).toBe(0); expect(clock.elapsed).toBeLessThanOrEqual(40_001);
      expect(Math.max(...clock.windows)).toBeLessThanOrEqual(5000);
      console.error(JSON.stringify({ fixture: "multiple-costly-held-tails", phase, lowSpace,
        checked: report.checked, removed: report.removed, removedBytes: report.removedBytes,
        deferred: report.deferred, elapsed: clock.elapsed, removablePresent: fs.existsSync(directories[8]!.directory) }));
      expect(report).toMatchObject({ removed: 1, removedBytes: 12288, bytes: before - 12288 });
      expect(fs.existsSync(directories[8]!.directory)).toBeFalse();
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
    savePipelines([finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString())]);
    const ended = path.join(scratch, "llv-stage-000000"), held = path.join(scratch, "llv-stage-000001");
    for (const [index, directory] of [ended, held].entries()) {
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + index });
      if (index === 1) plantKeepMarker(path.join(directory, ".delegatus-keep"));
      store.measure(directory, await allocatedAttemptBytes(directory));
    }
    // The protected root is larger, so the pass reaches it first; the
    // ended root follows in the same tick.
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
