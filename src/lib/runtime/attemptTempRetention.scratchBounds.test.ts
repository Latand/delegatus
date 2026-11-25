import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, PRESSURE_INVENTORY_PAGE, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { attemptTempConfigParent } from "./attemptTempPaths";
import { attemptReferencesClear } from "./attemptTempFilesystem";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { savePipelines } from "../pipelines/store";

const NOW = Date.parse("2035-01-15T00:00:00Z"), MiB = 1024 ** 2, roots: string[] = [];
const environment = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A state directory, a home with the config cache, and an expired lane. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-bounds-")); roots.push(root);
  const state = path.join(root, "state"), home = path.join(root, "home");
  fs.mkdirSync(path.join(state, "scratch"), { recursive: true }); fs.mkdirSync(path.join(state, "backups"));
  process.env.LLV_STATE_DIR = state; process.env.HOME = home;
  const config = attemptTempConfigParent();
  fs.mkdirSync(config, { recursive: true });
  const lane = finishedLane(root, new Date(NOW - 3 * 86400_000).toISOString());
  savePipelines([lane]);
  const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
  let created = 0;
  const make = (parent: string, name: string, bytes = 12288) => {
    const directory = path.join(parent, name); fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "data"), "protected payload");
    store.register({ directory, pipelineId: lane.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 10_000 + created++ });
    store.measure(directory, bytes); store.retainRoot(directory, NOW - 1000);
    return directory;
  };
  const options: AttemptTempSweepOptions = { now: () => NOW, availableBytes: () => 1, scan: () => ({ ownNamespace: null, processes: [] }),
    references: async () => true, state: async () => "expired",
    authority: async () => ({ state: "expired", expiresAt: NOW - 1000, revision: "fixture", isCurrent: () => true }) };
  return { root, state, config, lane, store, make, options };
}

test.each(["pressure", "scheduled"] as const)("a scratch parent moved into backups holds its root and spares the backup payload (%s)", async mode => {
  const f = fixture();
  try {
    const scratch = path.join(f.state, "scratch"), moved = path.join(f.state, "backups", "scratch-moved");
    const root = f.make(scratch, "llv-stage-aaaaaa"), sibling = f.make(f.config, "llv-stage-config-bbbbbb");
    fs.renameSync(scratch, moved); fs.symlinkSync(moved, scratch);
    const report = await sweepAttemptTemps(f.store, { ...f.options, ...(mode === "pressure" ? { capBytes: 0 }
      : { scheduledOnly: true as const, requireExpired: true as const }) });
    expect(fs.readFileSync(path.join(moved, "llv-stage-aaaaaa", "data"), "utf8")).toBe("protected payload");
    expect(report.outcomes.find(row => row.directory === root)).toMatchObject({ disposition: "held", reasonCode: "root_ancestry_changed" });
    expect(f.store.has(root)).toBeTrue();
    // The same tick still retires the unredirected config sibling.
    expect(fs.existsSync(sibling)).toBeFalse();
    expect(report.outcomes.find(row => row.directory === sibling)).toMatchObject({ disposition: "removed", reasonCode: "retired" });
  } finally { f.store.close(); }
});

test("registration refuses a root whose parent is redirected into backups", () => {
  const f = fixture();
  try {
    const moved = path.join(f.state, "backups", "scratch-moved"); fs.mkdirSync(moved);
    const linked = path.join(f.state, "scratch-link"); fs.symlinkSync(moved, linked);
    fs.mkdirSync(path.join(moved, "llv-stage-cccccc"), { mode: 0o700 });
    expect(() => f.store.register({ directory: path.join(linked, "llv-stage-cccccc"), pipelineId: null, launchId: "x",
      retainUntilClose: false, createdAt: NOW })).toThrow("redirected or protected parent");
    expect(f.store.has(path.join(linked, "llv-stage-cccccc"))).toBeFalse();
  } finally { f.store.close(); }
});

test.skipIf(process.platform !== "linux")("reclaim reports observed freed space beside the stale ledger value", async () => {
  const f = fixture();
  try {
    const directory = f.make(path.join(f.state, "scratch"), "llv-stage-dddddd", 4096);
    f.store.measure(directory, 4096, NOW - 1000);
    fs.writeFileSync(path.join(directory, "dense"), Buffer.alloc(32 * MiB, 7));
    const sparse = fs.openSync(path.join(directory, "sparse"), "w"); fs.ftruncateSync(sparse, 256 * MiB); fs.closeSync(sparse);
    const report = await sweepAttemptTemps(f.store, { ...f.options, scheduledOnly: true, requireExpired: true });
    expect(report).toMatchObject({ removed: 1, removedBytes: 4096 });
    expect(report.outcomes[0]).toMatchObject({ disposition: "removed", allocation: "recorded" });
    expect(report.reclaimedBytes).toBeGreaterThan(30 * MiB);
    expect(report.reclaimedBytes).toBeLessThan(100 * MiB);
  } finally { f.store.close(); }
});

test("a spent tick writes no pressure inventory", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 40; n++) f.make(path.join(f.state, "scratch"), `llv-stage-${String(n).padStart(6, "0")}`);
    let tick = 0;
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, runBudgetMs: 500, budgetNow: () => tick,
      prepare: async () => { tick = 501; } });
    expect(report).toMatchObject({ checked: 0, removed: 0, pass: null });
    const db = new Database(f.store.filename, { readonly: true });
    try { expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM pressure_pass_roots").get()!.n).toBe(0); } finally { db.close(); }
    expect(f.store.activePressurePass()).toBeNull(); expect(f.store.pressureInventoryBuilding()).toBeFalse();
  } finally { f.store.close(); }
});

test("an inventory larger than one page resumes across ticks and keeps size order", () => {
  const f = fixture();
  try {
    const scratch = path.join(f.state, "scratch");
    const made = Array.from({ length: 7 }, (_, n) => f.make(scratch, `llv-stage-${String(n).padStart(6, "0")}`, 4096 * (n + 1)));
    let pages = 0;
    // One page per call: the budget is spent after each.
    const spent = () => pages++ === 0;
    expect(f.store.pressurePass(NOW, false, spent, 3)).toBeNull();
    expect(f.store.pressureInventoryBuilding()).toBeTrue();
    expect(f.store.activePressurePass()).toBeNull();
    pages = 0;
    expect(f.store.pressurePass(NOW, false, spent, 3)).toBeNull();
    pages = 0;
    const pass = f.store.pressurePass(NOW, false, () => true, 3)!;
    expect(pass).toMatchObject({ total: 7, position: 0 });
    expect(f.store.pressureInventoryBuilding()).toBeFalse();
    const order: string[] = [];
    for (let next = f.store.pressurePassRoot(0); next; next = f.store.pressurePassRoot(next.seq)) order.push(next.directory);
    expect(order).toEqual([...made].reverse());
    expect(pass.totalBytes).toBe(4096 * 28);
  } finally { f.store.close(); }
});

test("one pressure pass over more roots than a page visits every root", async () => {
  const f = fixture();
  try {
    const count = PRESSURE_INVENTORY_PAGE + 88;
    for (let n = 0; n < count; n++) f.make(path.join(f.state, "scratch"), `llv-stage-${String(n).padStart(6, "0")}`);
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, state: async () => "live",
      authority: async () => ({ state: "live", revision: "fixture", isCurrent: () => true }) });
    expect(report.checked).toBe(count);
    expect(report.pass).toMatchObject({ total: count, visited: count });
    expect(report.removed).toBe(0);
  } finally { f.store.close(); }
});

test.skipIf(process.platform !== "linux")("a live process whose cwd is a vanished /proc path holds no root; one inside the root still does", async () => {
  const f = fixture();
  try {
    const scratch = path.join(f.state, "scratch");
    const idle = f.make(scratch, "llv-stage-eeeeee"), busy = f.make(scratch, "llv-stage-ffffff");
    const vanishedHelper = path.join("/proc", String(2 ** 22 + 1), "fdinfo");
    expect(fs.existsSync(vanishedHelper)).toBeFalse();
    // Both processes are alive: they carry the namespace the scan reads from /proc.
    const renderer = { pid: process.pid, namespace: "mnt:[fixture]", stamped: false, paths: [vanishedHelper] };
    const worker = { pid: process.pid, namespace: "mnt:[fixture]", stamped: false, paths: [busy] };
    const report = await sweepAttemptTemps(f.store, { ...f.options, scheduledOnly: true, requireExpired: true,
      scan: () => ({ ownNamespace: null, processes: [renderer, worker] }),
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true) });
    expect(report.outcomes.find(row => row.directory === idle)).toMatchObject({ disposition: "removed", reasonCode: "retired" });
    expect(fs.existsSync(idle)).toBeFalse();
    expect(report.outcomes.find(row => row.directory === busy)).toMatchObject({ disposition: "live" });
    expect(fs.readFileSync(path.join(busy, "data"), "utf8")).toBe("protected payload");
    expect(report.outcomes.some(row => row.reasonCode === "checkout_unreadable")).toBeFalse();
  } finally { f.store.close(); }
});
