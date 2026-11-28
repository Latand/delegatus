import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { pipelineIdentity, savePipelines } from "../pipelines/store";
import { AttemptTempStore } from "./attemptTempRetention";
import * as production from "./attemptTempProduction";
import { finishedLane, holdFinishedRoot } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);
const { attemptTempAuthority } = production;
// The pinned-base control keeps its actual old policy when the new entry is
// absent, so failures compare behavior rather than module export availability.
const attemptScratchAuthority = production.attemptScratchAuthority ?? production.attemptTempAuthority;

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
    expect(report.pressure).toBeFalse(); expect(report.pass ?? null).toBeNull();
    expect(report.errors).toBe(0); expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(directories[0]!)).toBeFalse();
    for (const directory of directories.slice(1)) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("fixture payload");
    expect(fs.readFileSync(path.join(foreign, "data"), "utf8")).toBe("unknown payload");
    expect(store.has(foreign)).toBeFalse();
    const second = await realParentPass(true); expect(second.removed).toBe(0); expect(second.removedBytes).toBe(0);
  } finally { store.close(); restoreEnvironment(before); }
}, 120000);

test.skipIf(process.platform !== "linux")("the ordinary expiry schedule measures zero-cache roots beyond a protected prefix", async () => {
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
    const expired = count - prefix - 1;
    let removed = 0, observedMeasuredRemoval = false;
    for (let tick = 0; tick < 8 && removed < expired; tick++) {
      // A fresh helper honors earlier holds and reaches the unmeasured suffix.
      const report = await realParentPass(true); expect(report.errors).toBe(0); removed += report.removed;
      observedMeasuredRemoval ||= report.outcomes.some(row => directories.slice(prefix + 1).includes(row.directory)
        && row.disposition === "removed" && row.bytes > 0);
      expect(report).toMatchObject({ pressure: false, pass: null, rootPageLimit: 32 });
    }
    expect(removed).toBe(expired); expect(observedMeasuredRemoval).toBeTrue();
    expect(store.owner(directories[prefix]!)!.bytes).toBeGreaterThan(0);
    for (let n = 0; n < count; n++) {
      if (n <= prefix) expect(fs.readFileSync(path.join(directories[n]!, "data"))).toEqual(Buffer.alloc(4096, n));
      else expect(fs.existsSync(directories[n]!)).toBeFalse();
    }
  } finally { store.close(); restoreEnvironment(before); }
}, 180000);

test.skipIf(process.platform !== "linux")("24h boundaries upgrade legacy scheduling across real restarts without shortening evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "completion-age-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch"), day = 86400000;
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const finish = NOW - day, legacyExpiry = finish + 7 * day;
  const lane = finishedLane(root, new Date(finish).toISOString()); savePipelines([lane]);
  const store = new AttemptTempStore(), directories: string[] = [];
  const copy = path.join(state, "evidence", "attempt-temp", "c".repeat(64));
  try {
    for (let n = 0; n < 5; n++) {
      const directory = path.join(scratch, "llv-stage-age" + n); directories.push(directory); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "data"), "protected fixture payload");
      store.register({ directory, pipelineId: n === 3 ? "unknown-lane" : lane.id, launchId: "retention-launch",
        retainUntilClose: false, createdAt: NOW - 100 * day }); store.release(directory); store.measure(directory, 12288);
      fs.utimesSync(directory, 1, 1);
    }
    plantKeepMarker(path.join(directories[1]!, ".delegatus-keep"));
    await holdFinishedRoot(directories[2]!, lane.id, "day-evidence"); store.requireRootExpiry(directories[2]!, legacyExpiry);
    store.requireRootExpiry(directories[4]!, legacyExpiry);
    fs.mkdirSync(copy, { recursive: true }); fs.writeFileSync(path.join(copy, "data"), "retained evidence");
    store.registerCopy({ destination: copy, pipelineId: lane.id, launchId: "retention-launch", kind: "lane",
      createdAt: finish, expiresAt: legacyExpiry, checkedAt: legacyExpiry, bytes: 12288 });
    for (const delta of [-1, 0, 1]) {
      const authority = await attemptScratchAuthority(store.owner(directories[0]!)!, undefined, () => NOW + delta);
      expect(authority.state).toBe(delta > 0 ? "expired" : "closed"); expect(authority.expiresAt).toBe(NOW + 1);
    }
    const old = new Database(store.filename);
    try {
      old.query("UPDATE root_retention SET expiresAt=? WHERE expiresAt IS NOT NULL").run(legacyExpiry);
      old.query("UPDATE roots SET checkedAt=?").run(legacyExpiry); old.exec("PRAGMA user_version=0");
    } finally { old.close(); }
    const config = path.join(root, "fixture.json"); process.env.LLV_PRESSURE_FIXTURE = config;
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0";
    for (const delta of [-1, 0, 1]) {
      fs.writeFileSync(config, JSON.stringify({ now: NOW + delta, freeBytes: 1e12, realClock: true, measureCost: 0 }));
      const report = await realParentPass(true);
      expect(report.errors).toBe(0); expect(report.removed).toBe(delta > 0 ? 1 : 0);
      expect(report.retention).toMatchObject({ scratchPeriodDays: 1, evidencePeriodDays: 7 });
      expect(report.retention.dueBytes).toBe(0);
      expect(store.scratchRetentionVersion()).toBe(1); expect(store.retentionExpiry(directories[1]!)).toBe(NOW + 1);
      expect(store.requiredRootExpiry(directories[2]!)).toBe(legacyExpiry); expect(store.copy(copy)!.expiresAt).toBe(legacyExpiry);
      expect(fs.readFileSync(path.join(copy, "data"), "utf8")).toBe("retained evidence");
      for (const directory of directories.slice(1)) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("protected fixture payload");
    }
    const { recordedRootHeld } = await import("../recordedChecks/store"); expect(recordedRootHeld(directories[2]!)).toBeTrue();
    const reopened = await attemptScratchAuthority(store.owner(directories[1]!)!, undefined, () => NOW + 1);
    fs.unlinkSync(path.join(directories[1]!, ".delegatus-keep"));
    lane.state = "paused"; lane.closedAt = null; savePipelines([lane]);
    expect(reopened.isCurrent()).toBeFalse();
    expect((await attemptScratchAuthority(store.owner(directories[1]!)!, undefined, () => NOW + 1)).state).toBe("unknown");
    const resumed = await realParentPass(true); expect(resumed.removed).toBe(0);
    expect(fs.readFileSync(path.join(directories[1]!, "data"), "utf8")).toBe("protected fixture payload");
  } finally { store.close(); restoreEnvironment(before); }
}, 180000);
