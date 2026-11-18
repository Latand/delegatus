import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { attemptTempAuthority } from "./attemptTempProduction";
import { pipelineIdentity, savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, realParentWorker, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

test.skipIf(process.platform !== "linux")("a thousand roots progress through real helper deadlines, cancellation and cold restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-scale-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(root, "fixture.json"), count = 1000;
  const directories: string[] = [];
  let worker: ReturnType<typeof realParentWorker> | undefined;
  try {
    const ended = finishedLane(root, new Date(NOW - 3600_000).toISOString());
    const live = finishedLane(root, new Date(NOW - 3600_000).toISOString());
    live.id = "live-lane"; Object.assign(live, pipelineIdentity(live.id, live.task, live.repoDir));
    live.state = "running"; live.closedAt = null;
    live.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
    live.runs[0]!.attempts.push({ n: 1, state: "running", launchId: "retention-launch",
      effectiveRole: live.stages[0]!.effectiveRole, conversationId: "fixture", sessionId: null,
      agentPath: null, paneId: null, flowId: null, startedAt: new Date(NOW - 1000).toISOString(),
      completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
    savePipelines([ended, live]);
    for (let n = 0; n < count; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096, n % 256));
      store.register({ directory, pipelineId: n === 0 ? live.id : ended.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288 + n);
    }
    const pinned = directories[1]!; plantKeepMarker(path.join(pinned, ".delegatus-keep"));
    expect((await attemptTempAuthority(store.owner(directories[0]!)!, undefined, () => NOW)).state).toBe("live");
    store.close();
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    // The parent sends a real monotonic five-second deadline. The deadline
    // clock, mutation fence and native remover remain real. Calendar time is
    // fixed per tick; free-space/process/container observations belong to the fixture.
    const deadlineMs = 15000, maxTicks = 48;
    let removed = 0, ticks = 0, completedPasses = 0;
    worker = realParentWorker(true, 5000);
    for (; ticks < maxTicks; ticks++) {
      fs.writeFileSync(config, JSON.stringify({ now: NOW + ticks * 105_000, freeBytes: 1e12, realClock: true, tickClock: true, measureCost: 0,
        ...(ticks === 0 ? { stallMeasurement: "llv-stage-000998" } : {}) }));
      // Exercise a cold owner after the actual deadline cut and midway through
      // the inventory; the remaining ticks use production warm continuations.
      if (ticks === 1 || ticks === 16) { await worker.close(); worker = realParentWorker(true, deadlineMs); }
      if (ticks === 0) {
        await expect(worker.attemptTemp()).rejects.toThrow("attempt temp tick exceeded 5000 ms");
        await worker.close(); worker = realParentWorker(true, deadlineMs);
        const interrupted = new AttemptTempStore();
        try {
          const pass = interrupted.activePressurePass()!;
          expect(pass).not.toBeNull(); expect(pass.position).toBeGreaterThan(0); expect(pass.position).toBeLessThan(count);
          expect(pass.removed).toBeGreaterThan(0); removed += pass.removed;
        } finally { interrupted.close(); }
        expect(JSON.parse(fs.readFileSync(config, "utf8")).stalledMeasurement).toBe("llv-stage-000998");
        expect(fs.existsSync(directories[count - 1]!)).toBeFalse();
        for (let n = 0; n < 2; n++) expect(fs.readFileSync(path.join(directories[n]!, "data"))).toEqual(Buffer.alloc(4096, n));
        continue;
      }
      expect(await worker.attemptTemp()).not.toBeNull();
      const report = JSON.parse(fs.readFileSync(path.join(state, "attempt-temp-report.json"), "utf8")) as
        NonNullable<Awaited<ReturnType<typeof import("./attemptTempProduction").runAttemptTempSweep>>>;
      expect(report.errors).toBe(0);
      removed += report.removed;
      if (report.pass?.ended) {
        expect(report.pass.ended).toBe("complete"); completedPasses++;
        // Hard cancellation advances past the interrupted proof for fairness.
        // Its untouched root is revisited in the next complete inventory.
        if (removed < count - 2) continue;
        expect(report.liveHeld).toBe(1);
        expect(report.lastFullPass!.removedBytes).toBeGreaterThan(0);
        break;
      }
    }
    expect(ticks + 1).toBeLessThanOrEqual(maxTicks);
    expect(removed).toBe(count - 2);
    expect(completedPasses).toBeGreaterThan(0);
    for (let n = 0; n < count; n++) {
      if (n < 2) expect(fs.readFileSync(path.join(directories[n]!, "data"))).toEqual(Buffer.alloc(4096, n));
      else expect(fs.existsSync(directories[n]!)).toBeFalse();
    }
  } finally { await worker?.close(); store.close(); restoreEnvironment(before); }
}, 500_000);
