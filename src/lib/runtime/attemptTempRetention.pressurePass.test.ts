import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempSweepOptions } from "./attemptTempRetention";
import * as filesystem from "./attemptTempFilesystem";
import * as mutation from "./attemptMutationFence";
import * as removal from "./attemptTempRemoval";
import { attemptTempJournalPath } from "../tempSweep";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";
import { Database } from "bun:sqlite";
import { attemptTempAuthority } from "./attemptTempProduction";
import { attemptReferencesClear } from "./attemptTempFilesystem";
import { savePipelines } from "../pipelines/store";
import { statePath } from "../configDir";
import { finishedLane, holdFinishedRoot, nameInReport } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, fixture, realParentPass, realParentWorker, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

type Report = Awaited<ReturnType<typeof sweepAttemptTemps>>;
const pad = (n: number) => String(n).padStart(6, "0");

/** One tick against a store reopened from disk: only durable state carries
 * the pass from one tick to the next. */
async function tick(filename: string, options: AttemptTempSweepOptions): Promise<Report> {
  const store = new AttemptTempStore(filename);
  try { return await sweepAttemptTemps(store, options); } finally { store.close(); }
}

test("a thousand-root pass removes from its first tick and finishes within a bounded number of ticks", async () => {
  const f = fixture(), count = 1000, held = new Set<string>(), recorded = new Map<string, number>();
  for (let n = 0; n < count; n++) {
    const directory = f.make(pad(n), NOW - 10_000 + n);
    // Distinct recorded sizes; the pass orders by them without walking a tree.
    const bytes = 12288 + ((n * 7919) % 997) * 4096 + n;
    f.store.measure(directory, bytes); recorded.set(directory, bytes);
    if (n % 100 === 7) held.add(directory);
  }
  f.store.close();
  const bySize = [...recorded].sort((a, b) => b[1] - a[1]).map(([directory]) => directory);
  // Each authority read costs one fixture second of a forty-second tick.
  // Four roots fit with their pre-quarantine and post-quarantine guards.
  const tickBudgetMs = 40_000, readCostMs = 1_000, maxRoots = 4;
  let clock = 0;
  const reads = new Map<string, number>(), visits: string[] = [];
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  const options: AttemptTempSweepOptions = { ...f.options, capBytes: 0, runBudgetMs: tickBudgetMs, maxRoots,
    now: () => NOW + clock, budgetNow: () => clock,
    state: async owner => {
      clock += readCostMs; reads.set(owner.directory, (reads.get(owner.directory) ?? 0) + 1);
      return held.has(owner.directory) ? "live" : "closed";
    },
    remove: async (trash, _eligible, dispatch, mutationStarted) => {
      if (!dispatch()) throw new AttemptTempBudgetDeferred("fixture dispatch refused");
      mutationStarted(); await fs.promises.rm(trash, { recursive: true });
    } };
  let ticks = 0, last: Report | undefined;
  try { while (ticks < 400) {
    const report = await tick(f.store.filename, options); ticks++; last = report;
    expect(report.errors).toBe(0);
    visits.push(...report.outcomes.map(row => row.directory));
    if (ticks === 1) {
      // The first tick deletes, largest recorded roots first.
      expect(report.removed).toBeGreaterThan(0);
      expect(report.outcomes.map(row => row.directory)).toEqual(bySize.slice(0, report.outcomes.length));
      expect(report.pass).toMatchObject({ ticks: 1, total: count, ended: null, removed: report.removed });
      for (const row of report.outcomes) if (row.disposition === "removed") expect(fs.existsSync(row.directory)).toBeFalse();
    }
    if (report.pass?.ended) break;
  } } finally { fence.mockRestore(); }
  // Every root is visited exactly once in the pass, in inventory order.
  expect(visits.map(file => path.basename(file))).toEqual(bySize.map(file => path.basename(file)));
  expect(Math.max(...reads.values())).toBeLessThanOrEqual(8);
  expect(ticks).toBeLessThanOrEqual(Math.ceil(count / maxRoots));
  expect(last!.pass).toMatchObject({ ended: "complete", position: count, total: count, ticks, visited: count, removed: count - held.size });
  expect(last!.lastPass).toMatchObject({ ended: "complete", ticks, visited: count, removed: count - held.size });
  expect(last!.lastPass!.durationMs).toBeGreaterThan(0);
  for (const directory of recorded.keys()) {
    if (held.has(directory)) expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
    else expect(fs.existsSync(directory)).toBeFalse();
  }
  // The next tick starts a new pass with a fresh inventory of what is left.
  const next = await tick(f.store.filename, options);
  expect(next.pass).toMatchObject({ ticks: 1, total: held.size, removed: 0 });
}, 240_000);

test("one root reuses its protection snapshot until quarantine changes its path", async () => {
  const f = fixture(), directory = f.make("snapshot");
  const original = filesystem.snapshotAttemptProtection;
  const paths: string[] = [];
  const snapshot = spyOn(filesystem, "snapshotAttemptProtection").mockImplementation(async (...args) => {
    paths.push(args[0]); return original(...args);
  });
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0 });
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(directory);
    expect(path.basename(paths[1]!)).toStartWith(".delegatus-trash-");
  } finally { snapshot.mockRestore(); f.store.close(); }
});

test("inventory discovery runs once per pass, including after reopening the ledger", async () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.make(pad(n));
  f.store.close();
  const adoption = spyOn(AttemptTempStore.prototype, "adopt");
  const options: AttemptTempSweepOptions = { ...f.options, capBytes: 0, maxRoots: 1, state: async () => "live" };
  try {
    for (let n = 0; n < 3; n++) expect((await tick(f.store.filename, options)).pass?.position).toBe(n + 1);
    expect(adoption).toHaveBeenCalledTimes(1);
    expect((await tick(f.store.filename, options)).pass?.ticks).toBe(1);
    expect(adoption).toHaveBeenCalledTimes(2);
  } finally { adoption.mockRestore(); }
});

test("finished roots are removed largest first even without backfill, with oldest creation breaking ties", async () => {
  const f = fixture();
  const live = f.make("live-large", NOW - 10), small = f.make("closed-small", NOW - 9);
  const newer = f.make("closed-newer", NOW - 2), older = f.make("closed-older", NOW - 3);
  f.store.retainRoot(small, NOW + 86400_000);
  f.store.measure(live, 1e9); f.store.measure(small, 12288);
  f.store.measure(newer, 1e6); f.store.measure(older, 1e6);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      state: async owner => owner.directory === live ? "live" : "closed" });
    expect(report.outcomes.filter(row => row.disposition === "removed").map(row => row.directory)).toEqual([older, newer, small]);
    expect(fs.existsSync(live)).toBeTrue();
  } finally { f.store.close(); }
});

test("a replaced root and a newly registered root wait for the next inventory", async () => {
  const f = fixture(), first = f.make("first", NOW - 2), replaced = f.make("replaced", NOW - 1);
  const options: AttemptTempSweepOptions = { ...f.options, capBytes: 0, maxRoots: 1, state: async () => "live" };
  try {
    expect((await sweepAttemptTemps(f.store, options)).outcomes[0]?.directory).toBe(first);
    // Retain the old inode so inode reuse cannot hide the replacement.
    fs.renameSync(replaced, path.join(f.root, "old-root")); f.store.forget(replaced);
    fs.mkdirSync(replaced); fs.writeFileSync(path.join(replaced, "data"), "replacement");
    f.store.register({ directory: replaced, pipelineId: null, launchId: "new-owner", retainUntilClose: false, createdAt: NOW });
    f.store.measure(replaced, 12288);
    const added = f.make("added", NOW);
    const continued = await sweepAttemptTemps(f.store, { ...options, state: async () => "closed" });
    expect(continued).toMatchObject({ checked: 0, removed: 0 });
    expect(continued.pass?.ended).toBe("complete");
    expect(fs.readFileSync(path.join(replaced, "data"), "utf8")).toBe("replacement");
    expect(fs.existsSync(added)).toBeTrue();
    expect((await sweepAttemptTemps(f.store, options)).pass?.total).toBe(3);
  } finally { f.store.close(); }
});

test("a protection snapshot that ages during an await refuses deletion and the next visit refreshes it", async () => {
  const f = fixture(), directory = f.make("stale-snapshot");
  let clock = NOW, age = true;
  const options: AttemptTempSweepOptions = { ...f.options, capBytes: 0, now: () => clock, budgetNow: () => 0,
    references: async () => { if (age) { clock += 30_000; age = false; } return true; } };
  try {
    const held = await sweepAttemptTemps(f.store, options);
    expect(held).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
    f.store.close();
    const refreshed = await tick(f.store.filename, options);
    expect(refreshed).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { f.store.close(); }
});

test("a completed pass survives a later pressure-cleared pass and a store restart", async () => {
  const f = fixture(); f.make("live");
  try {
    const complete = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, state: async () => "live" });
    expect(complete.lastFullPass).toMatchObject({ ended: "complete", total: 1 });
    f.make("next-a"); f.make("next-b");
    const cleared = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 24576 });
    expect(cleared.lastPass?.ended).toBe("pressure-cleared");
    f.store.close();
    const reopened = new AttemptTempStore(f.store.filename);
    try { expect(reopened.lastFullPressurePass()).toEqual(complete.lastFullPass); } finally { reopened.close(); }
  } finally { f.store.close(); }
});

test("a root with more than ten thousand directories gets a bounded protection proof", async () => {
  const f = fixture(), directory = f.make("many-directories");
  try {
    for (let n = 0; n < 10001; n++) fs.mkdirSync(path.join(directory, pad(n)));
    const proof = await filesystem.snapshotAttemptProtection(directory);
    expect(proof.current()).toBeTrue();
    plantKeepMarker(path.join(directory, pad(10000), ".delegatus-keep"));
    expect(proof.current()).toBeFalse();
    expect(await filesystem.inspectAttemptTree(directory)).toBeFalse();
  } finally { f.store.close(); }
}, 60_000);

test.each(["allocation", "protection"] as const)("a large recorded root can finish a six-second %s proof within its bounded window", async phase => {
  const f = fixture(), originalEnv = { ...process.env }, state = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = state;
  const directory = path.join(state, "scratch", "llv-stage-000000"), config = path.join(f.root, "fixture.json");
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
  const store = new AttemptTempStore();
  try {
    savePipelines([finishedLane(f.root, new Date(NOW - 2 * 86400_000).toISOString())]);
    store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
    store.measure(directory, 8 * 1024 ** 3);
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, fixtureMutationFence: true, fixtureRemoval: true,
      slowProof: { phase, prefix: 1, requiredCost: 6000 } }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    const report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(report).toMatchObject({ removed: 1, errors: 0, deferred: 0 });
    expect(clock.windows).toHaveLength(1);
    expect(Math.min(...clock.windows)).toBeGreaterThanOrEqual(6000);
    expect(Math.max(...clock.windows)).toBeLessThanOrEqual(13_000);
    expect(clock.elapsed).toBeLessThanOrEqual(13_000);
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 60_000);

test.each(["closed", "completed"] as const)("a large %s lane root retires in one tick with a bounded descendant snapshot", async state => {
  const f = fixture(), originalEnv = { ...process.env }, stateRoot = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = stateRoot;
  const directory = path.join(stateRoot, "scratch", "llv-stage-000000"), config = path.join(f.root, "fixture.json");
  fs.mkdirSync(directory, { recursive: true });
  const store = new AttemptTempStore();
  try {
    const lane = finishedLane(f.root, new Date(NOW - 2 * 86400_000).toISOString()); lane.state = state; savePipelines([lane]);
    for (let n = 0; n < 10001; n++) fs.mkdirSync(path.join(directory, pad(n)));
    const payload = fs.openSync(path.join(directory, "data"), "w");
    try { fs.ftruncateSync(payload, 16 * 1024 ** 3); } finally { fs.closeSync(payload); }
    store.register({ directory, pipelineId: lane.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
    store.measure(directory, 16 * 1024 ** 3);
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, realClock: true,
      forbidFullMeasurement: true, measureCost: 1000 }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    const started = performance.now(), report = await realParentPass(true);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(40_000);
    expect(report).toMatchObject({ checked: 1, removed: 1, removedBytes: 16 * 1024 ** 3, errors: 0, deferred: 0 });
    expect(report.outcomes[0]?.allocation).toBe("recorded");
    expect(report.pass?.ticks).toBe(1);
    expect(report.pass!.elapsedMs).toBeLessThanOrEqual(40_000);
    expect(fs.existsSync(directory)).toBeFalse();
    console.error(JSON.stringify({ fixture: "large-finished-root", state, directories: 10001, logicalBytes: 16 * 1024 ** 3,
      elapsedMs, tickBudgetMs: 40_000, removed: report.removed, deferred: report.deferred }));
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 120_000);

test.each([null, "missing-lane"])("roots without a lane obey the one-day orphan grace (%s)", async pipelineId => {
  const f = fixture(), fresh = f.make("fresh-orphan", NOW - 86400_000 + 1, pipelineId);
  const old = f.make("old-orphan", NOW - 86400_000, pipelineId);
  const authority: NonNullable<AttemptTempSweepOptions["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => NOW);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, authority,
      state: async (owner, inventory) => (await authority(owner, inventory)).state });
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(fresh)).toBeTrue(); expect(fs.existsSync(old)).toBeFalse();
  } finally { f.store.close(); }
});

test("a real locked root database defers that root and the durable cursor reaches the next one", async () => {
  const f = fixture(), first = f.make("lock-first", NOW - 3, "lane"), second = f.make("lock-second", NOW - 2, "lane");
  const third = f.make("lock-third", NOW - 1, "lane");
  f.store.measure(first, 1e6);
  const filename = path.join(f.root, "root-state.sqlite"), writer = new Database(filename), locker = new Database(filename);
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  writer.exec("PRAGMA busy_timeout=0; CREATE TABLE probe(value INTEGER)");
  let attempted = false;
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, maxRoots: 2, state: async owner => {
      if (owner.directory === first && !attempted) {
        attempted = true; locker.exec("BEGIN IMMEDIATE");
        try { writer.exec("INSERT INTO probe VALUES(1)"); } finally { locker.exec("ROLLBACK"); }
      }
      return "closed";
    } });
    expect(attempted).toBeTrue(); expect(report).toMatchObject({ checked: 2, removed: 1, deferred: 1, errors: 0 });
    expect(report.outcomes[0]?.reason).toContain("database is locked");
    expect(fs.existsSync(first)).toBeTrue(); expect(fs.existsSync(second)).toBeFalse();
    f.store.close();
    const config = path.join(f.root, "fixture.json");
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, fixtureMutationFence: true }));
    const child = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "attemptTempPressure.preload.ts"),
      path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.store.filename, String(NOW), "pressure"],
      { env: { ...process.env, LLV_PRESSURE_FIXTURE: config }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0); expect(JSON.parse(output).outcomes[0].directory).toBe(third);
    expect(fs.existsSync(first)).toBeTrue(); expect(fs.existsSync(third)).toBeFalse();
  } finally { fence.mockRestore(); writer.close(); locker.close(); f.store.close(); }
});

test.each(["defer", "recordBlocked"] as const)("a busy root %s write cannot stop later candidates", async method => {
  const f = fixture(), first = f.make("busy-first", NOW - 2), second = f.make("busy-second", NOW - 1);
  const original = f.store[method].bind(f.store);
  const write = spyOn(f.store, method).mockImplementation(((...args: unknown[]) => {
    if (args[0] === first) throw new Error("database is locked");
    return (original as (...args: unknown[]) => unknown)(...args);
  }) as never);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      state: async owner => owner.directory === first ? "live" : "closed" });
    expect(report.removed).toBe(1); expect(report.pass?.position).toBe(2);
    expect(fs.existsSync(first)).toBeTrue(); expect(fs.existsSync(second)).toBeFalse();
  } finally { write.mockRestore(); f.store.close(); }
});

test.each(["recordBlocked", "defer"] as const)("a busy operator-hold %s write cannot escape the root failure handler", async method => {
  const f = fixture(), first = f.make("operator-busy-first", NOW - 2), second = f.make("operator-busy-second", NOW - 1);
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  const measure = filesystem.measureAttemptAllocation, record = f.store[method].bind(f.store);
  let refused = false;
  const allocation = spyOn(filesystem, "measureAttemptAllocation").mockImplementation(async (directory, settings) => {
    if (directory === first) { refused = true; throw new Error("privileged cleanup unavailable: fixture refusal"); }
    return measure(directory, settings);
  });
  const write = spyOn(f.store, method).mockImplementation(((...args: unknown[]) => {
    if (args[0] === first && refused) throw new Error("database is locked");
    return (record as (...args: unknown[]) => unknown)(...args);
  }) as never);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0 });
    expect(report.removed).toBe(1); expect(report.pass?.position).toBe(2);
    expect(report.outcomes.filter(row => row.directory === first)).toHaveLength(1);
    expect(report.outcomes.find(row => row.directory === first)).toMatchObject({ disposition: "deferred" });
    expect(report.held).toBe(0);
    expect(fs.existsSync(first)).toBeTrue(); expect(fs.existsSync(second)).toBeFalse();
  } finally { allocation.mockRestore(); write.mockRestore(); fence.mockRestore(); f.store.close(); }
});

test.skipIf(process.platform !== "linux").each([{ current: 0o550, stale: 0o770 }, { current: 0o500, stale: 0o755 }])(
  "closed protection refuses stale or wider non-owner permissions ($current, $stale)", ({ current, stale }) => {
    const f = fixture(), directory = f.make("owner-mode", NOW, "lane"), child = path.join(directory, "modules");
    fs.mkdirSync(child); fs.chmodSync(child, current);
    const proof = filesystem.closedAttemptProtection(directory);
    try {
      expect(() => proof.permissionChange!(child, stale, () => fs.chmodSync(child, stale))).toThrow("owner");
      expect(fs.statSync(child).mode & 0o7777).toBe(current);
      const repaired = current | 0o700;
      proof.permissionChange!(child, repaired, () => fs.chmodSync(child, repaired));
      expect(fs.statSync(child).mode & 0o7777).toBe(repaired); expect(proof.current()).toBeTrue();
    } finally { fs.chmodSync(child, 0o755); f.store.close(); }
  });

test.skipIf(process.platform !== "linux")("closed permission repair refuses a directory rebound outside its admitted root", async () => {
  const f = fixture(), directory = f.make("rebound-permission", NOW, "lane");
  const parent = path.join(directory, "modules"), child = path.join(parent, "package"), outside = path.join(f.root, "escaped-package");
  fs.mkdirSync(child, { recursive: true }); fs.chmodSync(child, 0o550);
  const proof = filesystem.closedAttemptProtection(directory);
  let rebound = false, nativeCalls = 0, failure: unknown;
  try {
    try { await filesystem.removeAttemptTree(directory, directory, async () => true, false, () => proof.current(), () => true, true, undefined, {
      closedRoot: true, permissionAuthority: () => true,
      permissionDispatchGuard: (binding?: () => boolean) => proof.current() && (binding?.() ?? true),
      permissionChange: (file, mode, apply) => {
        if (file === child && !rebound) {
          rebound = true; fs.chmodSync(child, 0o750); fs.renameSync(child, outside); fs.chmodSync(outside, 0o550);
          fs.mkdirSync(child); fs.chmodSync(child, 0o550);
        }
        proof.permissionChange!(file, mode, apply);
      }, nativeRemove: async () => { nativeCalls++; throw new Error("unexpected native removal"); },
    }); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(rebound).toBeTrue(); expect(nativeCalls).toBe(0);
    expect(fs.existsSync(outside), String(failure)).toBeTrue();
    expect(fs.statSync(outside).mode & 0o7777).toBe(0o550);
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  } finally { for (const file of [child, outside]) if (fs.existsSync(file)) fs.chmodSync(file, 0o755); f.store.close(); }
});

test.skipIf(process.platform !== "linux")("closed pressure cleanup repairs read-only nested node_modules before native removal", async () => {
  const f = fixture(), directory = f.make("read-only-modules", NOW - 1000, "lane");
  const modules = path.join(directory, "node_modules", ".pnpm"), directories: string[] = [];
  fs.mkdirSync(modules, { recursive: true });
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const external = path.join(outside, "shared.js"); fs.writeFileSync(external, "external fixture"); fs.chmodSync(external, 0o444);
  fs.symlinkSync(outside, path.join(modules, "external-link")); fs.linkSync(external, path.join(modules, "shared.js"));
  for (let n = 0; n < 256; n++) {
    const packageRoot = path.join(modules, `package-${pad(n)}`), lib = path.join(packageRoot, "lib");
    fs.mkdirSync(lib, { recursive: true }); fs.writeFileSync(path.join(lib, "index.js"), "fixture");
    fs.chmodSync(path.join(lib, "index.js"), 0o444);
    directories.push(lib, packageRoot);
  }
  directories.push(modules, path.dirname(modules));
  for (const file of directories) fs.chmodSync(file, 0o550);
  f.store.measure(directory, 16 * 1024 ** 3);
  const nativeRemove = removal.removeTreeWithinAttemptBudget;
  const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs), descriptors = new Set<number>();
  let peakDescriptors = 0;
  const opened = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(file, flags, mode);
    if (typeof flags === "number" && (flags & 0x200000) !== 0) {
      descriptors.add(fd); peakDescriptors = Math.max(peakDescriptors, descriptors.size);
    }
    return fd;
  }) as typeof fs.openSync);
  const closed = spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); descriptors.delete(fd); });
  let removed = false;
  const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (trash, started) => {
    for (const file of directories) expect(fs.statSync(path.join(trash, path.relative(directory, file))).mode & 0o777).toBe(0o750);
    expect(fs.statSync(external).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeTrue();
    expect(peakDescriptors).toBeLessThanOrEqual(8); expect(descriptors.size).toBe(0);
    removed = true; return nativeRemove(trash, started);
  });
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0 });
    expect(report).toMatchObject({ removed: 1, errors: 0, deferred: 0 }); expect(removed).toBeTrue();
    expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.readFileSync(external, "utf8")).toBe("external fixture");
    expect(fs.statSync(external).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
  } finally {
    rm.mockRestore(); fence.mockRestore(); opened.mockRestore(); closed.mockRestore();
    for (const file of [...directories].reverse()) if (fs.existsSync(file)) fs.chmodSync(file, 0o700);
    f.store.close();
  }
}, 120_000);

test.skipIf(process.platform !== "linux")("a permission-repair failure records the cause, preserves data and lets the next root retire", async () => {
  const f = fixture(), failed = f.make("permission-first", NOW - 2, "lane"), next = f.make("permission-next", NOW - 1, "lane");
  const modules = path.join(failed, "node_modules"); fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, "payload"), "retained"); fs.chmodSync(modules, 0o550);
  f.store.measure(failed, 1e6);
  const chmod = fs.chmodSync.bind(fs);
  const write = spyOn(fs, "chmodSync").mockImplementation((file, mode) => {
    if (String(file).startsWith("/proc/self/fd/") && fs.readlinkSync(file).endsWith("/node_modules"))
      throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    return chmod(file, mode);
  });
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0 });
    expect(report).toMatchObject({ checked: 2, removed: 1, errors: 1 });
    expect(fs.readFileSync(path.join(modules, "payload"), "utf8")).toBe("retained"); expect(fs.existsSync(next)).toBeFalse();
    const inspect = new Database(f.store.filename, { readonly: true });
    try { expect(inspect.query<{ failure: string }, [string]>("SELECT failure FROM root_retention WHERE directory=?").get(failed)?.failure).toContain("EACCES"); }
    finally { inspect.close(); }
  } finally { write.mockRestore(); fence.mockRestore(); if (fs.existsSync(modules)) chmod(modules, 0o700); f.store.close(); }
});

test.skipIf(process.platform !== "linux")("a partial native permission failure retains its quarantine journal and does not stop a sibling", async () => {
  const f = fixture(), failed = f.make("partial-permissions", NOW - 2, "lane"), next = f.make("permission-sibling", NOW - 1, "lane");
  fs.writeFileSync(path.join(failed, "first"), "remove"); fs.writeFileSync(path.join(failed, "second"), "retain"); f.store.measure(failed, 1e6);
  const nativeRemove = removal.removeTreeWithinAttemptBudget, originalEnv = { ...process.env }, bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync(Bun.which(command)!, path.join(bin, command));
  process.env.PATH = bin; delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (trash, started) => {
    if (path.basename(trash).includes("partial-permissions")) {
      started(); fs.unlinkSync(path.join(trash, "first"));
      throw Object.assign(new Error("fixture native permission denied"), { code: "EACCES" });
    }
    return nativeRemove(trash, started);
  });
  const fence = spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0 });
    expect(report.removed).toBe(1); expect(fs.existsSync(next)).toBeFalse();
    const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(failed), "utf8"));
    expect(journal.directory).toBe(failed); expect(journal.trash.startsWith(f.root + path.sep)).toBeTrue();
    expect(fs.existsSync(path.join(journal.trash, "first"))).toBeFalse();
    expect(fs.readFileSync(path.join(journal.trash, "second"), "utf8")).toBe("retain"); expect(f.store.has(failed)).toBeTrue();
  } finally { rm.mockRestore(); fence.mockRestore(); restoreEnvironment(originalEnv); f.store.close(); }
});

test("protected, live and newly protected roots survive a multi-tick pass; vanished roots are tolerated", async () => {
  const f = fixture(), kinds = ["live", "process", "command-input", "operator", "recorded", "linked", "marked-mid-pass", "starts-mid-pass", "vanished", "forgotten"];
  const directories = new Map<string, string>(), removable: string[] = [];
  // Kinds that a later tick changes sort last, after the first tick has run.
  kinds.forEach((kind, n) => {
    const directory = f.make(kind, NOW - 1000 + n, "retention-lane"); directories.set(kind, directory);
    f.store.measure(directory, kind.endsWith("mid-pass") || kind === "vanished" || kind === "forgotten" ? 4096 : 1e6 - n);
  });
  for (let n = 0; n < 12; n++) { const directory = f.make(`ended-${pad(n)}`, NOW - 500 + n, "retention-lane"); f.store.measure(directory, 5e5 - n); removable.push(directory); }
  plantKeepMarker(path.join(directories.get("operator")!, ".delegatus-keep"));
  await holdFinishedRoot(directories.get("recorded")!);
  fs.writeFileSync(path.join(directories.get("linked")!, "frame.png"), "evidence"); nameInReport(path.join(directories.get("linked")!, "frame.png"));
  let clock = 0, started = false;
  const live = () => [directories.get("live"), ...(started ? [directories.get("starts-mid-pass")] : [])];
  const options: AttemptTempSweepOptions = { ...f.options, capBytes: 0, maxRoots: 1, runBudgetMs: 6_000, now: () => NOW + clock, budgetNow: () => clock,
    state: async owner => { clock += 100; return live().includes(owner.directory) ? "live" : "closed"; },
    authority: async owner => { const state = live().includes(owner.directory) ? "live" : "closed";
      return { state, revision: "fixture", isCurrent: () => (live().includes(owner.directory) ? "live" : "closed") === state }; },
    references: async (original, current) => attemptReferencesClear(original, current, { ownNamespace: null, processes: [
      { pid: process.pid, paths: [directories.get("process")!], namespace: null, stamped: false,
        references: [`--input=${path.join(directories.get("command-input")!, "data")}`] },
    ] }, async () => true) };
  f.store.close();
  let ticks = 0, report: Report | undefined;
  const reasons = new Map<string, string>();
  while (ticks < 60) {
    report = await tick(f.store.filename, options); ticks++;
    expect(report.errors).toBe(0);
    for (const row of report.outcomes) reasons.set(row.directory, `${row.disposition}: ${row.reason}`);
    if (ticks === 1) {
      // After the inventory: a new keep marker, a lane that starts again,
      // a root removed by its owner and a ledger row forgotten.
      expect(report.pass).toBeDefined();
      expect(report.pass!.position).toBeLessThan(report.pass!.total);
      plantKeepMarker(path.join(directories.get("marked-mid-pass")!, ".delegatus-keep"));
      started = true;
      fs.rmSync(directories.get("vanished")!, { recursive: true });
      const store = new AttemptTempStore(f.store.filename); store.forget(directories.get("forgotten")!); store.close();
    }
    if (report.pass?.ended) break;
  }
  expect(report!.pass?.ended).toBe("complete");
  for (const kind of kinds.filter(kind => kind !== "vanished" && kind !== "forgotten")) {
    const directory = directories.get(kind)!;
    expect(fs.existsSync(directory), `${kind}: ${reasons.get(directory)}`).toBeTrue();
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  }
  expect(reasons.get(directories.get("process")!)).toStartWith("live:");
  expect(reasons.get(directories.get("command-input")!)).toStartWith("live:");
  expect(fs.existsSync(directories.get("forgotten")!)).toBeTrue();
  expect(reasons.has(directories.get("forgotten")!)).toBeFalse();
  for (const directory of removable) expect(fs.existsSync(directory), reasons.get(directory)).toBeFalse();
  const store = new AttemptTempStore(f.store.filename);
  try { expect(store.has(directories.get("vanished")!)).toBeFalse(); } finally { store.close(); }
}, 120_000);

test("the real helper resumes one pass across restarts and reports its progress and duration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-pass-")); roots.push(root);
  const originalEnv = { ...process.env };
  const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite")), config = path.join(root, "fixture.json");
  const count = 96, directories: string[] = [];
  let worker: ReturnType<typeof realParentWorker> | undefined;
  try {
    savePipelines([finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString())]);
    for (let n = 0; n < count; n++) {
      const directory = path.join(scratch, `llv-stage-${pad(n)}`); directories.push(directory);
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288 + n);
      store.retainRoot(directory, NOW + 6 * 86400_000);
    }
    const kept = directories[count - 1]!;
    plantKeepMarker(path.join(kept, ".delegatus-keep"));
    store.close();
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    const visited: string[] = [];
    let ticks = 0, removed = 0, restarts = 0, last: Awaited<ReturnType<typeof realParentPass>> | undefined;
    worker = realParentWorker();
    // Real cold starts after the first and second ticks
    // prove recovery. Warm continuations match the production helper owner.
    // Measurements spend one fixture second; the progress page caps visits at 32.
    for (; ticks < 40 && !last?.pass?.ended; ticks++) {
      fs.writeFileSync(config + ".next", JSON.stringify({ now: NOW + ticks * 105_000, freeBytes: 1e12, measureCost: 1_000,
        fixtureMutationFence: true, fixtureRemoval: true, tickClock: true }));
      fs.renameSync(config + ".next", config);
      if (ticks === 1 || ticks === 2) { await worker.close(); worker = realParentWorker(); restarts++; }
      last = await worker.attemptTemp() as NonNullable<Awaited<ReturnType<typeof realParentPass>>>;
      expect(last!.errors).toBe(0);
      if (ticks === 0) expect(last!.removed).toBeGreaterThan(0);
      removed += last!.removed;
      visited.push(...last!.outcomes.map(row => row.directory));
      const written = JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
      expect(written.pass).toMatchObject({ total: count, ticks: ticks + 1 });
      expect(written.summary).toContain(`Pressure pass at ${written.pass.position} of ${count} roots`);
    }
    // Largest first, never repeated, at most one tick per 32-root page plus
    // the completion tick. This also catches any process-local cursor.
    expect(visited).toEqual([...directories].reverse());
    expect(ticks).toBeLessThanOrEqual(Math.ceil(count / 32) + 1);
    expect(restarts).toBe(2);
    expect(removed).toBe(count - 1);
    expect(fs.readFileSync(path.join(kept, "data")).length).toBe(4096);
    const written = JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
    expect(written.lastPass).toMatchObject({ ended: "complete", ticks, visited: count, removed: count - 1 });
    expect(written.lastFullPass).toEqual(written.lastPass);
    expect(written.lastPass.durationMs).toBeGreaterThanOrEqual((ticks - 1) * 105_000);
    expect(written.summary).toContain(`Last pass completed in`);
  } finally { await worker?.close(); store.close(); restoreEnvironment(originalEnv); }
}, 240_000);
