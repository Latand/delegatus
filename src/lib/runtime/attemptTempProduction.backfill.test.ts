import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AttemptTempStore } from "./attemptTempRetention";
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
