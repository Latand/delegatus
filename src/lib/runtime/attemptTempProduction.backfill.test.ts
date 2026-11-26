import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AttemptTempStore } from "./attemptTempRetention";
import { measureAttemptAllocation } from "./attemptTempFilesystem";
import { attemptScratchAuthority as attemptTempAuthority, backfillAttemptTempRetention } from "./attemptTempProduction";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { savePipelines } from "../pipelines/store";

const roots: string[] = [], NOW = Date.parse("2035-01-15T00:00:00Z");
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-backfill-")); roots.push(root);
  const filename = path.join(root, "attempt-temp.sqlite"), store = new AttemptTempStore(filename);
  const pipeline = finishedLane(root, "2035-01-14T00:00:00Z"); savePipelines([pipeline]);
  const make = (name: string) => {
    const directory = path.join(root, `llv-stage-${name}`); fs.mkdirSync(directory);
    store.register({ directory, pipelineId: pipeline.id, launchId: name, retainUntilClose: true, createdAt: NOW - 1 });
    return directory;
  };
  const legacyRelease = (directory: string) => {
    const db = new Database(filename);
    try { db.query("UPDATE roots SET released=1 WHERE directory=?").run(directory); }
    finally { db.close(); }
  };
  return { root, filename, store, pipeline, make, legacyRelease };
}

test.each(["closed", "completed"] as const)("release immediately records the %s lane deadline", async state => {
  const f = fixture(); f.pipeline.state = state; savePipelines([f.pipeline]);
  const directory = f.make("released");
  try {
    f.store.release(directory);
    const authority = await attemptTempAuthority(f.store.owner(directory)!, undefined, () => NOW);
    expect(f.store.retentionExpiry(directory)).toBe(authority.expiresAt!);
    expect(authority.state).toBe("closed");
  } finally { f.store.close(); }
});

test("backfill persists its page across real helper restarts and tolerates a vanished directory", async () => {
  const f = fixture(), directories = ["a", "b", "c", "d", "e"].map(f.make);
  for (const directory of directories) f.legacyRelease(directory);
  fs.rmSync(directories[2]!, { recursive: true });
  f.store.close();
  for (const expected of [2, 2, 1]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(NOW), "backfill", "2"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0); expect(JSON.parse(output)).toEqual({ checked: expected, updated: expected });
  }
  const store = new AttemptTempStore(f.filename);
  try {
    for (const directory of directories) expect(store.retentionExpiry(directory)).toBe(Date.parse("2035-01-15T00:00:00.001Z"));
    expect(fs.existsSync(directories[2]!)).toBeFalse();
    expect(await backfillAttemptTempRetention(store)).toEqual({ checked: 0, updated: 0 });
    expect(await backfillAttemptTempRetention(store)).toEqual({ checked: 5, updated: 0 });
  } finally { store.close(); }
});

test.each(["running", "paused", "needs_decision"] as const)("%s lanes receive no expiry and are found after they close", async state => {
  const f = fixture(), directory = f.make("open");
  f.pipeline.state = state; savePipelines([f.pipeline]); f.legacyRelease(directory);
  try {
    expect(await backfillAttemptTempRetention(f.store)).toEqual({ checked: 1, updated: 0 });
    expect(f.store.retentionExpiry(directory)).toBeNull();
    expect((await attemptTempAuthority(f.store.owner(directory)!)).state).toBe("unknown");
    f.pipeline.state = "closed"; savePipelines([f.pipeline]);
    await backfillAttemptTempRetention(f.store); // Wrap the durable cursor.
    expect(await backfillAttemptTempRetention(f.store)).toEqual({ checked: 1, updated: 1 });
  } finally { f.store.close(); }
});

test("releasing a reopened lane clears its old expiry even when the launch was replaced", async () => {
  const f = fixture(), directory = f.make("reopened");
  f.pipeline.state = "closed"; savePipelines([f.pipeline]);
  try {
    f.store.release(directory);
    expect(f.store.retentionExpiry(directory)).not.toBeNull();
    f.pipeline.state = "paused";
    savePipelines([f.pipeline]);
    f.store.release(directory);
    expect(f.store.retentionExpiry(directory)).toBeNull();
    const priorExpiry = Date.parse("2035-01-21T00:00:00Z");
    f.store.retainRoot(directory, priorExpiry); // Legacy row written before reopen handling.
    expect((await attemptTempAuthority(f.store.owner(directory)!)).state).toBe("unknown");
    expect(await backfillAttemptTempRetention(f.store)).toEqual({ checked: 1, updated: 1 });
    expect(f.store.retentionExpiry(directory)).toBeNull();
    expect(fs.existsSync(directory)).toBeTrue();
  } finally { f.store.close(); }
});

test.each(["reopen", "rebind", "unreleased"] as const)("backfill refuses %s ownership at its await boundary", async change => {
  const f = fixture(), directory = f.make("race");
  if (change !== "unreleased") f.legacyRelease(directory);
  try {
    const report = await backfillAttemptTempRetention(f.store, { authority: async owner => {
      const observed = await attemptTempAuthority(owner, undefined, () => NOW);
      if (change === "reopen") { f.pipeline.state = "paused"; savePipelines([f.pipeline]); }
      if (change === "rebind") {
        f.store.forget(directory);
        fs.unlinkSync(path.join(directory, ".delegatus-attempt-owner"));
        f.store.register({ ...owner, pipelineId: "another-lane" });
      }
      return observed;
    } });
    expect(report.updated).toBe(0); expect(f.store.retentionExpiry(directory)).toBeNull();
    expect(fs.existsSync(directory)).toBeTrue();
  } finally { f.store.close(); }
});

test("a refused authority read is reported and does not starve the next root", async () => {
  const f = fixture(), first = f.make("a-refused"), second = f.make("b-next");
  f.legacyRelease(first); f.legacyRelease(second);
  try {
    const result = await backfillAttemptTempRetention(f.store, { authority: async owner => {
      if (owner.directory === first) throw new Error("fixture owner read refusal");
      return attemptTempAuthority(owner, undefined, () => NOW);
    } });
    expect(result).toEqual({ checked: 2, updated: 1, errors: 1 });
    expect(f.store.retentionExpiry(first)).toBeNull();
    expect(f.store.retentionExpiry(second)).not.toBeNull();
  } finally { f.store.close(); }
});

test("a spent backfill deadline leaves the durable cursor available for the next process", async () => {
  const f = fixture(), directory = f.make("budget"); f.legacyRelease(directory);
  try {
    expect(await backfillAttemptTempRetention(f.store, { remaining: () => 0 })).toEqual({ checked: 0, updated: 0 });
    expect(await backfillAttemptTempRetention(f.store)).toEqual({ checked: 1, updated: 1 });
  } finally { f.store.close(); }
});

test("a newer scratch policy version fails closed without altering a root", () => {
  const f = fixture(), directory = f.make("future-policy");
  const db = new Database(f.filename);
  try {
    db.exec("PRAGMA user_version=2");
    expect(() => f.store.upgradeScratchRetention()).toThrow("unsupported scratch retention policy version");
    expect(fs.existsSync(directory)).toBeTrue(); expect(f.store.retentionExpiry(directory)).toBeNull();
  } finally { db.close(); f.store.close(); }
});

test("a fresh helper audits the old ledger after a crash before release, then respects its persisted strict deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-audit-restart-")); roots.push(root);
  const state = path.join(root, "state"), previous = process.env.LLV_STATE_DIR;
  const directory = path.join(state, "scratch", "llv-stage-oldone");
  const unknown = path.join(state, "scratch", "llv-stage-noinfo");
  let filename: string;
  process.env.LLV_STATE_DIR = state;
  try {
    const closedAt = "2035-01-14T00:00:00Z", pipeline = finishedLane(root, closedAt);
    savePipelines([pipeline]);
    const history = new Database(path.join(state, "state.sqlite"));
    try { history.query("DELETE FROM state_changes WHERE collection=?").run("pipelines"); }
    finally { history.close(); }
    for (const target of [directory, unknown]) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(target, "data"), "payload");
    }
    // Something wrote to the sibling within the last day, which keeps it ambiguous: an ownerless
    // root idle for 24 hours with no live reference is removed by the unregistered-scratch pass.
    const recent = new Date(NOW - 3_600_000);
    fs.utimesSync(path.join(unknown, "data"), recent, recent); fs.utimesSync(unknown, recent, recent);
    const store = new AttemptTempStore(); filename = store.filename;
    store.register({ directory, launchId: "legacy-launch", pipelineId: pipeline.id, retainUntilClose: true, createdAt: Date.parse(closedAt) - 1 });
    store.retainRoot(directory, Date.parse(closedAt) + 8 * 86400000);
    store.close();
    const old = new Database(filename);
    try { old.exec("DROP TABLE attempt_schedule; DROP TABLE attempt_cleanup_minutes; DROP INDEX roots_pipeline; PRAGMA user_version=0"); }
    finally { old.close(); }
  } finally { process.env.LLV_STATE_DIR = previous; }
  const tick = async (now: number) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--production-report", String(now), "--fixture-container-inventory"],
      { env: { ...process.env, LLV_STATE_DIR: state }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  expect(await tick(NOW)).toMatchObject({ checked: 0, removed: 0, adopted: 1, backfill: { checked: 1, updated: 1 } });
  const reader = new AttemptTempStore(filename!);
  try {
    expect(reader.scratchRetentionVersion()).toBe(1);
    expect(reader.owner(directory)).toMatchObject({ released: 0 });
    expect(reader.retentionExpiry(directory)).toBe(NOW + 1);
    expect(reader.owner(unknown)).toMatchObject({ pipelineId: null, launchId: "adopted" });
    expect(await tick(NOW + 1)).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(reader.has(directory)).toBeFalse();
    expect(reader.retentionExpiry(unknown)).toBeNull();
    expect(fs.readFileSync(path.join(unknown, "data"), "utf8")).toBe("payload");
  } finally { reader.close(); }
  expect(fs.existsSync(path.join(state, "attempt-temp-report.json"))).toBeTrue();
});

test("retained change rows below the feed floor cannot restart the audit every tick", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-feed-gap-")); roots.push(root);
  const state = path.join(root, "state"), prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore();
  try {
    const completedAt = "2035-01-13T00:00:00Z", lane = finishedLane(path.join(root, "repo"), completedAt);
    lane.state = "needs_decision";
    fs.mkdirSync(path.join(lane.worktreeDir!, ".git"), { recursive: true });
    lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "failed", launchId: "finished", effectiveRole: lane.stages[0]!.effectiveRole,
      conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: completedAt,
      completedAt, input: null, activatedBy: null, output: null, verdict: { status: "fail" }, error: null }] }];
    savePipelines([lane]);
    const feed = new Database(path.join(state, "state.sqlite"));
    try {
      // Production pruning advances the floor even when its bounded DELETE
      // leaves older rows. None of those rows carries this attempt's change.
      feed.exec("DELETE FROM state_changes WHERE collection='pipelines'");
      const insert = feed.query("INSERT INTO state_changes(collection,revision,row_key,operation) VALUES('pipelines',?,'other-lane','upsert')");
      for (let i = 1; i <= 8; i++) insert.run(i);
      feed.exec("UPDATE state_collections SET revision=12,change_floor=10 WHERE collection='pipelines'");
    } finally { feed.close(); }
    const directories = Array.from({ length: 129 }, (_, i) => path.join(state, "scratch", `llv-stage-a${String(i).padStart(3, "0")}`));
    for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
    const target = directories.at(-1)!;
    store.register(...directories.map(directory => ({ directory, launchId: directory === target ? "finished" : "unknown",
      pipelineId: lane.id, retainUntilClose: false, createdAt: Date.parse(completedAt) - 1 })));
    store.scheduleCheckpoint(0, "");
    const tick = async (at: number) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"),
        "--production-report", String(at), "--fixture-container-inventory"], { stdout: "pipe", stderr: "pipe" });
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, errors).toBe(0);
      return JSON.parse(output.trim().split("\n").at(-1)!);
    };
    let tickNumber = 0;
    await tick(NOW + tickNumber++ * 60_000);
    expect(store.schedulePosition().revision).toBe(12);
    let repaired = false;
    for (; tickNumber <= 4 && fs.existsSync(target); tickNumber++) {
      const report = await tick(NOW + tickNumber * 60_000);
      repaired ||= report.backfill.updated === 1;
      expect(report.errors).toBe(0);
    }
    expect(repaired).toBeTrue();
    expect(store.has(target)).toBeFalse();
    expect(fs.existsSync(target)).toBeFalse();
    expect(fs.existsSync(directories[0]!)).toBeTrue();
  } finally { store.close(); process.env.LLV_STATE_DIR = prior; }
}, 20_000);

test("cleanup metrics persist across ledger reopen and expire old minute buckets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-metrics-")); roots.push(root);
  const filename = path.join(root, "attempt-temp.sqlite"), first = new AttemptTempStore(filename);
  const directory = path.join(root, "llv-stage-metrics"); fs.mkdirSync(directory);
  first.register({ directory, pipelineId: null, launchId: "metric-launch", createdAt: NOW - 5000, retainUntilClose: false });
  first.retainRoot(directory, NOW - 2000);
  expect(first.cleanupMetrics(NOW, 8192, 0.5)).toMatchObject({ reclaimedBytesLastHour: 8192, sweepCpuSecondsLastHour: 0.5, oldestEligibleRootAgeSeconds: 2 });
  first.close();
  const reopened = new AttemptTempStore(filename);
  try {
    expect(reopened.cleanupMetrics(NOW + 60_000, 4096, 0.75)).toMatchObject({ reclaimedBytesLastHour: 12288, sweepCpuSecondsLastHour: 1.25, oldestEligibleRootAgeSeconds: 62 });
    reopened.requireRootExpiry(directory, NOW + 7200_000);
    expect(reopened.cleanupMetrics(NOW + 3600_000, 0, 0.25)).toMatchObject({ reclaimedBytesLastHour: 4096, sweepCpuSecondsLastHour: 1, oldestEligibleRootAgeSeconds: 0 });
  } finally { reopened.close(); }
});

test("bounded allocation refresh counts live registered growth without expiry selection", async () => {
  const f = fixture(), directory = f.make("live-growth");
  fs.writeFileSync(path.join(directory, "payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  try {
    expect(f.store.retentionExpiry(directory)).toBeNull();
    expect(f.store.due(NOW, 4, true)).toEqual([]);
    const [owner] = f.store.allocationDue(NOW, 4);
    expect(owner?.directory).toBe(directory);
    const measured = await measureAttemptAllocation(directory, { budgetMs: 5000 });
    f.store.measure(directory, measured.bytes, NOW);
    expect(f.store.bytes()).toBeGreaterThanOrEqual(2 * 1024 ** 2);
    expect(f.store.allocationDue(NOW + 30_000, 4)).toEqual([]);
  } finally { f.store.close(); }
});

test("an expiry retry leaves zero and stale allocations in the measurement queue", () => {
  const f = fixture(), zero = f.make("unmeasured"), stale = f.make("stale"), recent = f.make("recent");
  try {
    for (const directory of [zero, stale, recent]) {
      f.store.retainRoot(directory, NOW - 1);
      f.store.defer(directory, NOW + 86400_000);
    }
    f.store.measure(stale, 8192, NOW - 3600_000);
    f.store.measure(recent, 8192, NOW - 60_000);
    expect(f.store.allocationDue(NOW).map(row => row.directory)).toEqual([zero, stale]);
    expect(f.store.due(NOW, 4, true)).toEqual([]);
  } finally { f.store.close(); }
});
