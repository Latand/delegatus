import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore, DEFAULT_ATTEMPT_TEMP_CAP_BYTES, sweepAttemptTemps } from "./attemptTempRetention";
import { attemptTempAuthority } from "./attemptTempProduction";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { savePipelines } from "../pipelines/store";
import { attemptTempJournalPath } from "@/lib/tempSweep";

const NOW = Date.parse("2035-01-15T00:00:00Z"), GiB = 1024 ** 3, roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-size-")); roots.push(root);
  const store = new AttemptTempStore(path.join(root, "attempt-temp.sqlite"));
  const make = (n: number, bytes: number, pipelineId: string | null = null) => {
    const directory = path.join(root, `llv-stage-${String(n).padStart(3, "0")}`); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), "payload");
    store.register({ directory, pipelineId, launchId: "finished", retainUntilClose: false, createdAt: NOW - 10_000 + n });
    store.measure(directory, bytes); return directory;
  };
  const options = { now: () => NOW, scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
  return { root, store, make, options };
}

test.each([false, true])("the largest root beyond 32 small roots leads the sweep (pressure=%s)", async pressure => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.make(i, 4096);
  const largest = f.make(40, GiB);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, maxRoots: 1, capBytes: pressure ? 0 : 100 * GiB,
      availableBytes: () => 200 * GiB, state: async () => "live" });
    expect(report.outcomes[0]?.directory).toBe(largest); expect(report.removed).toBe(0);
  } finally { f.store.close(); }
});

test("pressure prioritizes two largest roots across the cursor page", async () => {
  const f = fixture();
  const largest = f.make(0, 2 * GiB);
  for (let i = 1; i < 1029; i++) f.make(i, 4096);
  const nextLargest = f.make(1029, GiB);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      availableBytes: () => 1, state: async () => "live" });
    expect(report.outcomes.slice(0, 2).map(row => row.directory)).toEqual([largest, nextLargest]);
  } finally { f.store.close(); }
});

test("routine scratch expiry keeps its per-tick budget below the reserve without starting a pressure pass", async () => {
  const f = fixture(), lane = finishedLane(f.root, "2035-01-12T00:00:00Z");
  const due = Array.from({ length: 6 }, (_, i) => f.make(i, 4096, lane.id));
  try {
    savePipelines([lane]);
    for (const directory of due) f.store.retainRoot(directory, NOW - 1000);
    const report = await sweepAttemptTemps(f.store, {
      ...f.options, availableBytes: () => 1, scheduledOnly: true, requireExpired: true, maxRoots: 4,
      state: async () => "expired", authority: async () => ({
        state: "expired", expiresAt: NOW - 1000, revision: "fixture", isCurrent: () => true,
      }),
    });
    expect(report).toMatchObject({ lowSpace: true, pressure: false, pass: null, rootPageLimit: 4, checked: 4, removed: 4, errors: 0 });
    expect(due.filter(directory => fs.existsSync(directory))).toHaveLength(2);
    expect(f.store.activePressurePass()).toBeNull();
  } finally { f.store.close(); }
});

test.each(["missing", "unmoved", "replaced", "journal", "dry-run"])("recovery handles a %s trash intent without removing a root", scenario => {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, "scratch"));
  const directory = f.make(0, 4096);
  try {
    f.store.queueTrashIntent(directory, f.store.owner(directory)!.identity);
    if (scenario === "missing") fs.rmSync(directory, { recursive: true });
    if (scenario === "replaced") {
      fs.renameSync(directory, directory + "-previous");
      fs.mkdirSync(directory);
    }
    const journal = attemptTempJournalPath(directory);
    if (scenario === "journal") fs.writeFileSync(journal, "unreadable journal");
    const preview = scenario === "dry-run";
    f.store.recoverTrash(() => NOW, NOW + 1000, () => NOW, false, preview);
    expect(f.store.recoveredTrash(directory)).toBe(scenario !== "missing" && scenario !== "unmoved");
    expect(fs.existsSync(directory)).toBe(scenario !== "missing");
    expect(fs.existsSync(journal)).toBe(scenario === "journal");
  } finally { f.store.close(); }
});

test.each(["closed", "completed", "running", "paused", "needs_decision"] as const)("disk pressure below the configured cap protects %s lane ownership", async state => {
  const f = fixture(), pipeline = finishedLane(f.root, "2035-01-14T00:00:00Z");
  pipeline.state = state; savePipelines([pipeline]);
  const directory = f.make(0, 80 * GiB, pipeline.id);
  try {
    f.store.release(directory);
    const authority = (owner: Parameters<typeof attemptTempAuthority>[0]) => attemptTempAuthority(owner, undefined, () => NOW);
    const report = await sweepAttemptTemps(f.store, { ...f.options, availableBytes: () => 75 * GiB,
      authority, state: async owner => (await authority(owner)).state });
    expect(report.configuredCapBytes).toBe(DEFAULT_ATTEMPT_TEMP_CAP_BYTES);
    expect(report.capBytes).toBe(77.5 * GiB); expect(report.pressure).toBeTrue();
    expect(report.lowSpace).toBeFalse(); expect(report.errors).toBe(0);
    const finished = state === "closed" || state === "completed";
    expect(report.removed).toBe(finished ? 1 : 0); expect(fs.existsSync(directory)).toBe(!finished);
  } finally { f.store.close(); }
});

test("a reopened lane after an awaited reference read cannot be deleted under pressure", async () => {
  const f = fixture(), pipeline = finishedLane(f.root, "2035-01-14T00:00:00Z"); savePipelines([pipeline]);
  const directory = f.make(0, 80 * GiB, pipeline.id);
  let reads = 0;
  try {
    const authority = (owner: Parameters<typeof attemptTempAuthority>[0]) => attemptTempAuthority(owner, undefined, () => NOW);
    const report = await sweepAttemptTemps(f.store, { ...f.options, availableBytes: () => 75 * GiB,
      authority, state: async owner => (await authority(owner)).state,
      references: async () => { if (++reads === 1) { pipeline.state = "paused"; savePipelines([pipeline]); } return true; } });
    expect(reads).toBeGreaterThan(0); expect(report.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("payload");
  } finally { f.store.close(); }
});

test("a failed free-space observation reports the failure and keeps the configured cap", async () => {
  const f = fixture(); f.make(0, 4096);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, availableBytes: () => { throw new Error("fixture statfs refusal"); }, state: async () => "live" });
    expect(report.capBytes).toBe(DEFAULT_ATTEMPT_TEMP_CAP_BYTES); expect(report.pressure).toBeFalse();
    expect(report.spaceError).toContain("fixture statfs refusal"); expect(report.removed).toBe(0);
  } finally { f.store.close(); }
});
