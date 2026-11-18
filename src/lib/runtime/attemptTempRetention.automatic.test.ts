import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { pipelineIdentity, savePipelines } from "../pipelines/store";
import { AttemptTempStore } from "./attemptTempRetention";
import { attemptTempAuthority } from "./attemptTempProduction";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

test.skipIf(process.platform !== "linux")("the ordinary automatic owner retires expired scratch and preserves live, protected and unknown work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-attempt-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const ended = finishedLane(root, "2020-01-01T00:00:00Z");
  const running = (id: string, launchId: string) => {
    const lane = finishedLane(root, "2020-01-01T00:00:00Z");
    lane.id = id; Object.assign(lane, pipelineIdentity(id, lane.task, lane.repoDir)); lane.state = "running"; lane.closedAt = null;
    lane.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
    lane.runs[0]!.attempts.push({ n: 1, state: "running", launchId, effectiveRole: lane.stages[0]!.effectiveRole,
      conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: new Date(NOW - 1000).toISOString(), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
    return lane;
  };
  const live = running("automatic-live", "retention-launch"), unknown = running("automatic-unknown", "another-launch");
  savePipelines([ended, live, unknown]);
  const store = new AttemptTempStore(), directories: string[] = [];
  try {
    for (let n = 0; n < 4; n++) {
      const directory = path.join(scratch, "llv-stage-auto" + n); directories.push(directory);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "fixture payload");
      store.register({ directory, pipelineId: n === 2 ? live.id : n === 3 ? unknown.id : ended.id,
        launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 10 * 86400000 });
      store.release(directory); store.measure(directory, 12288);
    }
    plantKeepMarker(path.join(directories[1]!, ".delegatus-keep"));
    const foreign = path.join(scratch, "unknown-root"); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "data"), "unknown payload");
    expect((await attemptTempAuthority(store.owner(directories[0]!)!, undefined, () => NOW)).state).toBe("expired");
    expect((await attemptTempAuthority(store.owner(directories[2]!)!, undefined, () => NOW)).state).toBe("live");
    expect((await attemptTempAuthority(store.owner(directories[3]!)!, undefined, () => NOW)).state).toBe("unknown");
    const config = path.join(root, "fixture.json");
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, realClock: true, measureCost: 0 }));
    process.env.LLV_PRESSURE_FIXTURE = config; process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = String(1e12);
    const report = await realParentPass(true);
    expect(report.pressure).toBeFalse(); expect(report.pass).toBeNull();
    expect(report.errors).toBe(0); expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(directories[0]!)).toBeFalse();
    for (const directory of directories.slice(1)) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("fixture payload");
    expect(fs.readFileSync(path.join(foreign, "data"), "utf8")).toBe("unknown payload");
    expect(store.has(foreign)).toBeFalse();
    const second = await realParentPass(true); expect(second.removed).toBe(0); expect(second.removedBytes).toBe(0);
  } finally { store.close(); restoreEnvironment(before); }
}, 120000);

test.skipIf(process.platform !== "linux")("the ordinary persisted cursor measures zero-cache roots beyond a protected prefix", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zero-cache-attempt-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const ended = finishedLane(root, "2020-01-01T00:00:00Z"); savePipelines([ended]);
  const store = new AttemptTempStore(), directories: string[] = [], count = 80, prefix = 40;
  try {
    for (let n = 0; n < count; n++) {
      const directory = path.join(scratch, "llv-stage-zero" + String(n).padStart(3, "0")); directories.push(directory);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096, n));
      store.register({ directory, pipelineId: ended.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.release(directory); if (n < prefix) store.measure(directory, 1000000);
      if (n <= prefix) plantKeepMarker(path.join(directory, ".delegatus-keep"));
    }
    expect(store.owner(directories[prefix]!)!.bytes).toBe(0);
    const config = path.join(root, "fixture.json");
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, realClock: true, measureCost: 0 }));
    process.env.LLV_PRESSURE_FIXTURE = config; process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0";
    let removed = 0, observedUncachedMeasurement = false, complete = false;
    for (let tick = 0; tick < 8; tick++) {
      // A fresh real helper must resume the same inventory rather than
      // restarting on the known-size protected prefix.
      const report = await realParentPass(true); expect(report.errors).toBe(0); removed += report.removed;
      observedUncachedMeasurement ||= report.outcomes.some(row => directories.slice(prefix + 1).includes(row.directory)
        && row.disposition === "removed" && row.bytes > 0 && row.allocation !== "recorded");
      if (report.pass?.ended === "complete") {
        expect(report.pass.total).toBe(count); complete = true; break;
      }
    }
    expect(complete).toBeTrue(); expect(removed).toBe(count - prefix - 1); expect(observedUncachedMeasurement).toBeTrue();
    expect(store.owner(directories[prefix]!)!.bytes).toBeGreaterThan(0);
    for (let n = 0; n < count; n++) {
      if (n <= prefix) expect(fs.readFileSync(path.join(directories[n]!, "data"))).toEqual(Buffer.alloc(4096, n));
      else expect(fs.existsSync(directories[n]!)).toBeFalse();
    }
  } finally { store.close(); restoreEnvironment(before); }
}, 180000);
