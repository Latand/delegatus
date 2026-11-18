import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, realParentWorker, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

test("a thousand roots progress through real helper deadlines, cancellation and cold restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-scale-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(root, "fixture.json"), count = 1000;
  const directories: string[] = [];
  let worker: ReturnType<typeof realParentWorker> | undefined;
  try {
    const ended = finishedLane(root, new Date(NOW - 3600_000).toISOString());
    const live = { ...finishedLane(root, new Date(NOW - 3600_000).toISOString()), id: "live-lane", state: "running" as const };
    savePipelines([ended, live]);
    for (let n = 0; n < count; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096, n % 256));
      store.register({ directory, pipelineId: n === 0 ? live.id : ended.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288 + n);
    }
    const pinned = directories[1]!; plantKeepMarker(path.join(pinned, ".delegatus-keep"));
    store.close();
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    // The parent sends a real monotonic six-second deadline. No mutation fence,
    // remover or clock is replaced. Only fixture-owned external observations
    // (free space, processes, containers) are supplied by the existing preload.
    const deadlineMs = 6000, maxTicks = 100;
    let removed = 0, ticks = 0;
    worker = realParentWorker(true, deadlineMs);
    for (; ticks < maxTicks; ticks++) {
      fs.writeFileSync(config, JSON.stringify({ now: NOW + ticks * 105_000, freeBytes: 1e12, realClock: true, measureCost: 0,
        ...(ticks === 0 ? { exhaustMeasurement: "llv-stage-000998" } : {}) }));
      // Exercise a cold owner after the actual deadline cut and midway through
      // the inventory; the remaining ticks use production warm continuations.
      if (ticks === 1 || ticks === 16) { await worker.close(); worker = realParentWorker(true, deadlineMs); }
      expect(await worker.attemptTemp()).not.toBeNull();
      const report = JSON.parse(fs.readFileSync(path.join(state, "attempt-temp-report.json"), "utf8"));
      expect(report.errors).toBe(0);
      if (ticks === 0) {
        expect(report.removed).toBeGreaterThan(0);
        expect(report.outcomes.some((row: { reason: string }) => row.reason.includes("real helper measurement deadline"))).toBeTrue();
        expect(report.pass.position).toBeLessThan(count);
        expect(fs.existsSync(directories[count - 1]!)).toBeFalse();
      }
      removed += report.removed;
      if (report.pass.ended) {
        expect(report.pass).toMatchObject({ ended: "complete", total: count, removed: count - 2 });
        expect(report.lastFullPass.removedBytes).toBeGreaterThan(0);
        break;
      }
    }
    expect(ticks + 1).toBeLessThanOrEqual(maxTicks);
    expect(removed).toBe(count - 2);
    for (let n = 0; n < count; n++) {
      if (n < 2) expect(fs.readFileSync(path.join(directories[n]!, "data"))).toEqual(Buffer.alloc(4096, n));
      else expect(fs.existsSync(directories[n]!)).toBeFalse();
    }
  } finally { await worker?.close(); store.close(); restoreEnvironment(before); }
}, 280_000);
