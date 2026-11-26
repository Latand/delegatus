import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { pipelineIdentity, savePipelines } from "@/lib/pipelines/store";
import { scanProcesses, type ProcessScan, type ScannedProcess } from "@/lib/tempSweep";
import { AttemptTempStore } from "./attemptTempRetention";
import { sweepMonotonicNow, withAttemptTempDeadline } from "./attemptTempDeadline";
import { removeTreeWithinAttemptBudget } from "./attemptTempRemoval";
import { reportMediaRoot } from "@/lib/reportMedia/lookup";
import { finishedLane, nameInReport } from "./attemptTempRetention.testSupport";
import { runAttemptTempSweep } from "./attemptTempProduction";
import { runUnregisteredScratchPass, UNREGISTERED_LOW_FREE_BYTES, UNREGISTERED_ORDINARY_LIMITS, UNREGISTERED_PRESSURE_LIMITS,
  UNREGISTERED_CLAIM_PREFIX, unregisteredScratchTrigger, type UnregisteredScratchPorts } from "./unregisteredScratch";
import { UnregisteredScratchLedger } from "./unregisteredScratchLedger";

const NOW = Date.parse("2031-03-10T12:00:00Z");
const MINUTE = 60_000, HOUR = 3_600_000, MIB = 1024 ** 2;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** A private state directory, its scratch root and a ledger, removed with the test. */
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unregistered-scratch-")));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const scratch = statePath("scratch");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const held = { store: new AttemptTempStore() };
  cleanups.push(() => {
    held.store.close();
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, scratch, held, get store() { return held.store; },
    /** Closes and reopens the ledger, as a restarted helper would. */
    restart() { held.store.close(); held.store = new AttemptTempStore(); } };
}
type World = ReturnType<typeof world>;
/** Reads what the pass remembered, through its own connection. */
const remembered = <T>(w: World, read: (ledger: UnregisteredScratchLedger) => T): T => {
  const ledger = UnregisteredScratchLedger.open(w.store.filename);
  try { return read(ledger); } finally { ledger.close(); }
};

/** Gives every entry of a tree one modification time, deepest first. */
function setTimes(directory: string, at: number) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.lstatSync(file).isDirectory()) setTimes(file, at); else fs.utimesSync(file, at / 1000, at / 1000);
  }
  fs.utimesSync(directory, at / 1000, at / 1000);
}
/** A stage-shaped scratch root whose whole tree was last written `age` ago. */
function make(w: World, name: string, options: { age?: number; bytes?: number } = {}) {
  const directory = path.join(w.scratch, name);
  fs.mkdirSync(path.join(directory, "cache"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "cache", "data"), Buffer.alloc(options.bytes ?? 4096, 1));
  fs.chmodSync(directory, 0o700);
  setTimes(directory, NOW - (options.age ?? 30 * HOUR));
  return directory;
}
const allocated = (directory: string): number => {
  const stat = fs.lstatSync(directory);
  return stat.blocks * 512 + (stat.isDirectory() ? fs.readdirSync(directory).reduce((sum, name) => sum + allocated(path.join(directory, name)), 0) : 0);
};
const empty: ProcessScan = { ownNamespace: null, processes: [] };
const holder = (paths: string[], references: string[] = []): ScannedProcess => ({ pid: process.pid, namespace: "fixture", stamped: false, paths, references });
/** Real reference observer and admission; fixed container, lane and custody observations. */
const ports = (over: Partial<UnregisteredScratchPorts> = {}): UnregisteredScratchPorts => ({
  mode: "on", now: () => NOW, scan: () => empty, containers: async () => true, availableBytes: () => 400e9,
  lanes: () => () => false, attributable: () => false, ...over,
});
const journalRows = (day = "2031-03-10") => {
  const file = statePath("disk-cleaner", `ordinary-${day}.ndjson`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
};
const names = (w: World) => fs.readdirSync(w.scratch).sort();

test("an expired unregistered root with no live reference is deleted and journaled with its measured allocation", async () => {
  const w = world();
  const directory = make(w, "llv-stage-AAAAAA", { bytes: 32 * MIB });
  const sparse = path.join(directory, "cache", "sparse");
  fs.closeSync(fs.openSync(sparse, "w")); fs.truncateSync(sparse, 256 * MIB);
  setTimes(directory, NOW - 30 * HOUR);
  const sibling = make(w, "llv-stage-BBBBBB", { age: 2 * HOUR });
  const expected = allocated(directory);
  // The apparent size is 288 MiB; the allocation of a sparse file is its written blocks.
  const sparseSupported = fs.lstatSync(sparse).blocks * 512 < MIB;
  if (sparseSupported) { expect(expected).toBeGreaterThanOrEqual(32 * MIB); expect(expected).toBeLessThan(33 * MIB); }
  let free = 400e9;
  const report = (await runUnregisteredScratchPass(w.store, ports({ availableBytes: () => free,
    remove: async (...args) => { await removeTreeWithinAttemptBudget(...args); free += expected; } })))!;
  expect(fs.existsSync(directory)).toBeFalse();
  expect(fs.existsSync(sibling)).toBeTrue();
  expect(names(w)).toEqual(["llv-stage-BBBBBB"]);
  expect(report).toMatchObject({ found: 2, examined: 2, removed: 1, removedBytes: expected, observedFreedBytes: expected, errors: 0, trigger: null });
  expect(report.kept.young).toBe(1);
  const rows = journalRows().filter(row => row.phase !== "skipped");
  expect(rows.map(row => row.phase)).toEqual(["intent", "removed"]);
  for (const row of rows) expect(row).toMatchObject({ path: "scratch/llv-stage-AAAAAA", bytes: expected, class: "attempt-temp", kind: "scratch",
    scope: "unregistered", reason: "expired-24h-unreferenced", ageMs: 30 * HOUR });
  // A 4 KiB ledger value or the 288 MiB apparent size would both be wrong.
  expect(rows[1]!.bytes).not.toBe(4096); expect(rows[1]!.bytes as number).toBeLessThan(sparseSupported ? 40 * MIB : Infinity);
  expect(JSON.stringify(journalRows())).not.toContain(w.root);
  expect(report.totals).toEqual({ removedRoots: 1, removedBytes: expected });
});

test("a live process whose cwd, open file or command line is inside a root keeps it; the wait survives a restart", async () => {
  const w = world();
  const byCwd = make(w, "llv-stage-CWDCWD"), byFd = make(w, "llv-stage-FDFDFD"), byArgument = make(w, "llv-stage-ARGARG"), free = make(w, "llv-stage-FREEEE");
  const scan: ProcessScan = { ownNamespace: "fixture", processes: [
    holder([byCwd]), holder([w.root, path.join(byFd, "cache", "data")]), holder([w.root], [`--cache=${byArgument}/cache`])] };
  const first = (await runUnregisteredScratchPass(w.store, ports({ scan: () => scan })))!;
  expect(first).toMatchObject({ examined: 4, removed: 1, found: 4 });
  expect(first.kept.live_reference).toBe(3);
  expect(names(w)).toEqual(["llv-stage-ARGARG", "llv-stage-CWDCWD", "llv-stage-FDFDFD"]);
  expect(fs.existsSync(free)).toBeFalse();
  expect(journalRows().filter(row => row.phase === "skipped").map(row => [row.path, row.code]).sort())
    .toEqual([["scratch/llv-stage-ARGARG", "live_reference"], ["scratch/llv-stage-CWDCWD", "live_reference"], ["scratch/llv-stage-FDFDFD", "live_reference"]]);
  // The helper restarts one minute later: the kept roots wait, nothing is examined, nothing is journaled again.
  w.restart();
  const second = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + MINUTE })))!;
  expect(second).toMatchObject({ examined: 0, removed: 0, waiting: 3 });
  expect(journalRows().filter(row => row.phase === "skipped")).toHaveLength(3);
  // Eleven minutes on, the processes are gone: all three go.
  const third = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 11 * MINUTE })))!;
  expect(third).toMatchObject({ examined: 3, removed: 3 });
  expect(names(w)).toEqual([]);
  expect(third.totals.removedRoots).toBe(4);
  expect(third.keptByReason).toEqual([]);
});

test.skipIf(process.platform !== "linux")("a real process whose cwd is inside a root keeps it until the process exits", async () => {
  const w = world();
  const used = make(w, "llv-stage-REALPS"), free = make(w, "llv-stage-NOPROC");
  const child = Bun.spawn(["sleep", "300"], { cwd: used, stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { child.kill(); });
  // The real /proc scan, narrowed to the one process this test started.
  const scan = (directories: readonly string[]): ProcessScan => {
    const all = scanProcesses("/proc", directories);
    return { ...all, processes: all.processes.filter(candidate => candidate.pid === child.pid) };
  };
  expect(scan([used]).processes).toHaveLength(1);
  const first = (await runUnregisteredScratchPass(w.store, ports({ scan })))!;
  expect(first).toMatchObject({ removed: 1 });
  expect(first.kept.live_reference).toBe(1);
  expect(fs.existsSync(used)).toBeTrue();
  expect(fs.existsSync(free)).toBeFalse();
  child.kill();
  await child.exited;
  const second = (await runUnregisteredScratchPass(w.store, ports({ scan, now: () => NOW + 11 * MINUTE })))!;
  expect(second).toMatchObject({ removed: 1, errors: 0 });
  expect(fs.existsSync(used)).toBeFalse();
});

test("a spent time budget stops a pass part-way and the next pass resumes", async () => {
  const w = world();
  for (let index = 0; index < 120; index++) make(w, `llv-stage-T${String(index).padStart(5, "0")}`, { bytes: 512 });
  const slow: UnregisteredScratchPorts["remove"] = async (directory) => { await new Promise(resolve => setTimeout(resolve, 5)); fs.rmSync(directory, { recursive: true }); };
  const first = (await withAttemptTempDeadline(sweepMonotonicNow() + 1000 + 150,
    () => runUnregisteredScratchPass(w.store, ports({ remove: slow, availableBytes: () => 30e9 }))))!;
  expect(first.deferred).not.toBeNull();
  expect(first.removed).toBeGreaterThan(0);
  expect(first.removed).toBeLessThan(120);
  expect(first.elapsedMs).toBeLessThan(2_000);
  expect(fs.readdirSync(w.scratch).length).toBe(120 - first.removed);
  const rest = (await runUnregisteredScratchPass(w.store, ports({ remove: slow, availableBytes: () => 30e9, now: () => NOW + MINUTE })))!;
  expect(rest.deferred).toBeNull();
  expect(fs.readdirSync(w.scratch)).toEqual([]);
});

test("a process cwd on procfs does not hold an unrelated root, while its open file in another root still does", async () => {
  const w = world();
  const unrelated = make(w, "llv-stage-GONEGO"), used = make(w, "llv-stage-INUSE1");
  const scan: ProcessScan = { ownNamespace: "fixture", processes: [
    holder(["/proc/2147483646/fdinfo"]), holder(["/proc/2147483646/fdinfo", path.join(used, "cache", "data")])] };
  const report = (await runUnregisteredScratchPass(w.store, ports({ scan: () => scan })))!;
  expect(report).toMatchObject({ removed: 1, errors: 0 });
  expect(fs.existsSync(unrelated)).toBeFalse();
  expect(fs.existsSync(used)).toBeTrue();
  expect(report.kept.live_reference).toBe(1);
  expect(report.kept.checkout_unreadable).toBeUndefined();
});

test("activity is the newest entry of the tree: 24 h exactly expires, a nested write keeps an old root", async () => {
  const w = world();
  const exact = make(w, "llv-stage-EXACT1", { age: 24 * HOUR }), almost = make(w, "llv-stage-ALMOST", { age: 24 * HOUR - 1000 });
  const nested = make(w, "llv-stage-NESTED", { age: 40 * HOUR });
  fs.utimesSync(path.join(nested, "cache", "data"), (NOW - 2 * HOUR) / 1000, (NOW - 2 * HOUR) / 1000);
  const report = (await runUnregisteredScratchPass(w.store, ports()))!;
  expect(fs.existsSync(exact)).toBeFalse();
  expect(fs.existsSync(almost)).toBeTrue();
  expect(fs.existsSync(nested)).toBeTrue();
  expect(report.kept.young).toBe(2);
  // Each kept root waits until its own 24 hours end (at least a minute), not a fixed hour.
  const waiting = remembered(w, ledger => ledger.waiting(NOW));
  expect(waiting.get("llv-stage-ALMOST")!.retryAt).toBe(NOW + MINUTE);
  expect(waiting.get("llv-stage-NESTED")!.retryAt).toBe(NOW - 2 * HOUR + 24 * HOUR + 1);
  const later = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 2 * MINUTE })))!;
  expect(later.removed).toBe(1);
  expect(fs.existsSync(almost)).toBeFalse();
});

test("a redirected scratch parent or a linked root never reaches backups, and a valid sibling is still removed", async () => {
  const w = world();
  const backups = statePath("backups");
  fs.mkdirSync(path.join(backups, "payload", "cache"), { recursive: true });
  fs.writeFileSync(path.join(backups, "payload", "cache", "keep-me"), "backup");
  setTimes(path.join(backups, "payload"), NOW - 90 * HOUR);
  // A root name that is a link into backups, beside a valid expired root and names this pass never owns.
  fs.symlinkSync(path.join(backups, "payload"), path.join(w.scratch, "llv-stage-LINKED"));
  const valid = make(w, "llv-stage-VALID1");
  const foreign = ["llv-stage-config-AbCdEf", "backups", "notes"].map(name => make(w, name));
  const linked = (await runUnregisteredScratchPass(w.store, ports()))!;
  expect(linked).toMatchObject({ removed: 1, scratch: "present" });
  expect(fs.existsSync(valid)).toBeFalse();
  expect(fs.lstatSync(path.join(w.scratch, "llv-stage-LINKED")).isSymbolicLink()).toBeTrue();
  expect(fs.readFileSync(path.join(backups, "payload", "cache", "keep-me"), "utf8")).toBe("backup");
  expect(linked.kept.not_directory).toBe(1);
  for (const directory of foreign) expect(fs.existsSync(directory)).toBeTrue();
  // The scratch parent itself moved into backups with a link left behind: the whole pass refuses.
  const moved = path.join(backups, "moved-scratch");
  fs.renameSync(w.scratch, moved);
  fs.symlinkSync(moved, w.scratch);
  const old = make({ ...w, scratch: moved } as World, "llv-stage-OLDONE");
  const refused = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 5 * MINUTE })))!;
  expect(refused).toMatchObject({ scratch: "refused", removed: 0, errors: 1 });
  expect(fs.existsSync(old)).toBeTrue();
  expect(fs.readFileSync(path.join(backups, "payload", "cache", "keep-me"), "utf8")).toBe("backup");
});

test("evidence, keep markers, Git checkouts, open lanes and recorded owners hold a root; a clean sibling goes", async () => {
  const w = world();
  const keepTop = make(w, "llv-stage-KEEPTP"), keepDeep = make(w, "llv-stage-KEEPDP"), git = make(w, "llv-stage-GITGIT");
  const evidence = make(w, "llv-stage-EVIDNC"), lane = make(w, "llv-stage-LANE01"), owned = make(w, "llv-stage-OWNED1"), clean = make(w, "llv-stage-CLEAN1");
  fs.writeFileSync(path.join(keepTop, ".delegatus-keep"), "");
  fs.writeFileSync(path.join(keepDeep, "cache", ".delegatus-keep"), "");
  fs.mkdirSync(path.join(git, "cache", ".git"));
  for (const directory of [keepTop, keepDeep, git]) setTimes(directory, NOW - 30 * HOUR);
  fs.writeFileSync(path.join(evidence, "cache", "shot.png"), "png");
  setTimes(evidence, NOW - 30 * HOUR);
  nameInReport(path.join(evidence, "cache", "shot.png"));
  // The picture index lives in the cache directory, outside the per-test state.
  cleanups.push(() => fs.rmSync(reportMediaRoot(), { recursive: true, force: true }));
  const report = (await runUnregisteredScratchPass(w.store, ports({
    lanes: () => directory => directory === lane, attributable: directory => directory === owned })))!;
  expect(report.removed).toBe(1);
  expect(names(w)).toEqual(["llv-stage-EVIDNC", "llv-stage-GITGIT", "llv-stage-KEEPDP", "llv-stage-KEEPTP", "llv-stage-LANE01", "llv-stage-OWNED1"]);
  expect(fs.existsSync(clean)).toBeFalse();
  expect(report.kept).toEqual({ keep_marker: 1, tree_keep_marker: 1, tree_git_boundary: 1, linked_evidence: 1, open_lane: 1, attributable_owner: 1 });
});

test("the shared lane predicate keeps a root an open lane works in", async () => {
  const w = world();
  const inside = make(w, "llv-stage-WORKER"), other = make(w, "llv-stage-IDLE01");
  closeAgentRegistryForTests();
  // The lane's repository and its derived worktree both sit inside the scratch root.
  const repo = path.join(inside, "repo");
  fs.mkdirSync(repo);
  setTimes(inside, NOW - 30 * HOUR);
  const closed = finishedLane(repo, "2031-03-01T00:00:00Z");
  closed.runs = [{ stageId: "build", attempts: [{
    n: 1, state: "passed", launchId: "fixture-launch", effectiveRole: closed.stages[0]!.effectiveRole,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: "2031-03-01T00:00:00Z", completedAt: "2031-03-01T00:00:00Z",
    input: null, activatedBy: null, output: null, verdict: null, error: null,
  }] }];
  const lane = { ...closed, ...pipelineIdentity("open-lane", closed.task, repo), id: "open-lane", state: "paused", pausedState: "running",
    closedAt: null } as const;
  savePipelines([lane]);
  cleanups.push(() => { savePipelines([]); closeAgentRegistryForTests(); });
  const report = (await runUnregisteredScratchPass(w.store, { ...ports(), lanes: undefined }))!;
  expect(report).toMatchObject({ removed: 1 });
  expect(fs.existsSync(inside)).toBeTrue();
  expect(fs.existsSync(other)).toBeFalse();
  expect(report.kept.open_lane).toBe(1);
});

test("roots the ledger owns stay with the ledger, while a root adopted without an owner is deleted and forgotten", async () => {
  const w = world();
  const adopted = make(w, "llv-stage-ADOPTD"), owned = path.join(w.scratch, "llv-stage-STAND1");
  fs.mkdirSync(owned, { mode: 0o700 });
  w.store.register({ directory: owned, pipelineId: null, launchId: "standalone-1", retainUntilClose: false, createdAt: NOW - 40 * HOUR });
  expect(w.store.adopt(NOW, w.scratch, 32).adopted).toBe(1);
  expect(w.store.owner(adopted)).toMatchObject({ pipelineId: null, launchId: "adopted" });
  setTimes(owned, NOW - 40 * HOUR); setTimes(adopted, NOW - 40 * HOUR);
  const report = (await runUnregisteredScratchPass(w.store, ports()))!;
  expect(report).toMatchObject({ found: 1, registered: 1, removed: 1 });
  expect(fs.existsSync(owned)).toBeTrue();
  expect(fs.existsSync(adopted)).toBeFalse();
  expect(w.store.owner(adopted)).toBeNull();
  expect(w.store.owner(owned)).not.toBeNull();
});

test("the ordinary pass removes a bounded number of roots, the low-space pass many, oldest first", async () => {
  const w = world();
  // Index 0 is the oldest: its tree was last written 30 h + 59 min ago, the last one 30 h ago.
  const fast: UnregisteredScratchPorts["remove"] = async (directory) => { fs.rmSync(directory, { recursive: true }); };
  const roots = Array.from({ length: 200 }, (_, index) => make(w, `llv-stage-R${String(index).padStart(5, "0")}`, { age: 30 * HOUR + (199 - index) * MINUTE }));
  expect(UNREGISTERED_ORDINARY_LIMITS.remove).toBe(16);
  const ordinary = (await runUnregisteredScratchPass(w.store, ports({ remove: fast })))!;
  expect(ordinary).toMatchObject({ removed: 16, trigger: null, limits: UNREGISTERED_ORDINARY_LIMITS });
  expect(roots.slice(0, 16).every(directory => !fs.existsSync(directory))).toBeTrue();
  expect(fs.existsSync(roots[16]!)).toBeTrue();
  expect(ordinary.deferred).toContain("per-pass bound");
  const pressure = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + MINUTE, availableBytes: () => UNREGISTERED_LOW_FREE_BYTES - 1, remove: fast })))!;
  expect(pressure).toMatchObject({ removed: UNREGISTERED_PRESSURE_LIMITS.remove, trigger: "free-space", limits: UNREGISTERED_PRESSURE_LIMITS });
  expect(roots.slice(0, 16 + 128).every(directory => !fs.existsSync(directory))).toBeTrue();
  expect(fs.existsSync(roots[16 + 128]!)).toBeTrue();
  expect(pressure.elapsedMs).toBeLessThan(UNREGISTERED_PRESSURE_LIMITS.budgetMs);
});

test("a thousand expired roots are all removed across low-space passes within their bounds", async () => {
  const w = world();
  for (let index = 0; index < 1000; index++) make(w, `llv-stage-M${String(index).padStart(5, "0")}`, { age: 25 * HOUR + index * MINUTE, bytes: 512 });
  const fast: UnregisteredScratchPorts["remove"] = async (directory) => { fs.rmSync(directory, { recursive: true }); };
  const passes: number[] = [];
  for (let pass = 0; pass < 40 && fs.readdirSync(w.scratch).length; pass++) {
    const report = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + pass * MINUTE, availableBytes: () => 30e9, remove: fast })))!;
    expect(report.trigger).toBe("free-space");
    expect(report.examined).toBeLessThanOrEqual(UNREGISTERED_PRESSURE_LIMITS.examine);
    expect(report.removed).toBeLessThanOrEqual(UNREGISTERED_PRESSURE_LIMITS.remove);
    expect(report.elapsedMs).toBeLessThan(UNREGISTERED_PRESSURE_LIMITS.budgetMs);
    expect(report.errors).toBe(0);
    passes.push(report.removed);
  }
  expect(fs.readdirSync(w.scratch)).toEqual([]);
  expect(passes).toEqual([128, 128, 128, 128, 128, 128, 128, 104]);
  expect(remembered(w, ledger => ledger.totals().removedRoots)).toBe(1000);
}, 120_000);

test("the free-space trigger fires below 50 GB and on a 10 GB loss in 20 minutes, from persisted readings", async () => {
  const decide = unregisteredScratchTrigger;
  expect(decide([], NOW, 60e9).trigger).toBeNull();
  expect(decide([], NOW, 50e9).trigger).toBeNull();
  expect(decide([], NOW, 49.9e9).trigger).toBe("free-space");
  expect(decide([], NOW, null)).toEqual({ trigger: null, lossBytes: 0 });
  const readings = [{ at: NOW - 15 * MINUTE, freeBytes: 200e9 }];
  expect(decide(readings, NOW, 189e9)).toEqual({ trigger: "loss-rate", lossBytes: 11e9 });
  expect(decide(readings, NOW, 190e9).trigger).toBeNull();
  expect(decide(readings, NOW, 191e9).trigger).toBeNull();
  expect(decide([{ at: NOW - 21 * MINUTE, freeBytes: 200e9 }], NOW, 150e9).trigger).toBeNull();

  const w = world();
  make(w, "llv-stage-WATCH1");
  const reports = [];
  for (const [minute, free] of [[0, 200e9], [10, 189e9], [11, 191e9], [40, 150e9]] as const) {
    w.restart();
    reports.push((await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + minute * MINUTE, availableBytes: () => free })))!);
  }
  expect(reports.map(report => report.trigger)).toEqual([null, "loss-rate", null, null]);
  expect(reports[1]).toMatchObject({ lossBytes: 11e9, limits: UNREGISTERED_PRESSURE_LIMITS });
  expect(reports[3]!.limits).toEqual(UNREGISTERED_ORDINARY_LIMITS);
  expect(remembered(w, ledger => ledger.samples().length)).toBeLessThanOrEqual(41);
  // An unreadable free-space observation never starts the larger pass and is reported.
  const failing = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 50 * MINUTE, availableBytes: () => { throw new Error("statfs failed"); } })))!;
  expect(failing).toMatchObject({ trigger: null, limits: UNREGISTERED_ORDINARY_LIMITS });
  expect(failing.spaceError).toContain("statfs failed");
});

test("a crash mid-delete leaves a tombstone and the next pass finishes it, journaling it as an interrupted removal", async () => {
  const w = world();
  const directory = make(w, "llv-stage-CRASH1");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "unregisteredScratch.fixture.ts"), "--crash-mid-delete", String(NOW)],
    { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(137);
  const left = names(w);
  expect(fs.existsSync(directory)).toBeFalse();
  expect(left).toHaveLength(1);
  expect(left[0]).toStartWith(`${UNREGISTERED_CLAIM_PREFIX}-`);
  expect(fs.existsSync(path.join(w.scratch, left[0]!, "cache", "data"))).toBeTrue();
  // The crashed pass journaled its intent and never an outcome.
  expect(journalRows().map(row => row.phase)).toEqual(["intent"]);
  const next = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + MINUTE })))!;
  expect(next).toMatchObject({ finishedInterrupted: 1, errors: 0 });
  expect(next.totals.removedRoots).toBe(1);
  expect(names(w)).toEqual([]);
  const rows = journalRows();
  expect(rows.map(row => row.phase)).toEqual(["intent", "intent", "removed"]);
  expect(rows[2]).toMatchObject({ reason: "interrupted-removal-finished", class: "attempt-temp" });
  expect(rows[2]!.identity).toBe(rows[0]!.identity);
  // Idempotent: a further pass finds nothing to do.
  const again = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 2 * MINUTE })))!;
  expect(again).toMatchObject({ found: 0, finishedInterrupted: 0, removed: 0 });
  // A claim tombstone this pass never recorded is the attempt ledger's, and is left alone. One it recorded
  // that is not the inode its name says is kept, never deleted.
  const uuid = "00000000-0000-0000-0000-000000000000";
  fs.mkdirSync(path.join(w.scratch, `${UNREGISTERED_CLAIM_PREFIX}-3-4-${uuid}`));
  fs.mkdirSync(path.join(w.scratch, `${UNREGISTERED_CLAIM_PREFIX}-1-2-${uuid}`));
  remembered(w, ledger => ledger.beginRemoval("1:2", "llv-stage-GONE01", NOW));
  const forged = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 3 * MINUTE })))!;
  expect(forged.finishedInterrupted).toBe(0);
  expect(forged.kept.path_not_admitted).toBe(1);
  expect(names(w)).toHaveLength(2);
});

test("a tree this user cannot remove is kept and counted, and finished when the block lifts", async () => {
  const w = world();
  const blocked = make(w, "llv-stage-LOCKED"), readOnly = make(w, "llv-stage-READON");
  // A read-only directory holding a file stops rm; the owner-write repair clears it.
  fs.chmodSync(path.join(readOnly, "cache"), 0o555);
  cleanups.push(() => { try { fs.chmodSync(path.join(readOnly, "cache"), 0o755); } catch { /* Already removed. */ } });
  const lockedStat = fs.lstatSync(blocked), lockedIdentity = `${lockedStat.dev}:${lockedStat.ino}`;
  let refusals = 0;
  // The first two removals of this one tree are refused after it moved to a tombstone.
  const refusing: UnregisteredScratchPorts["remove"] = async (directory, started, run, identity, cpu) => {
    if (identity !== lockedIdentity || refusals >= 2) return removeTreeWithinAttemptBudget(directory, started, run, identity, cpu);
    refusals++;
    const tombstone = path.join(w.scratch, `${UNREGISTERED_CLAIM_PREFIX}-${identity.replace(":", "-")}-00000000-0000-0000-0000-00000000000${refusals}`);
    fs.renameSync(directory, tombstone);
    throw Object.assign(new Error("permission denied"), { code: "EACCES", claimedDirectory: tombstone });
  };
  const first = (await runUnregisteredScratchPass(w.store, ports({ remove: refusing })))!;
  expect(first.removed).toBe(1);
  expect(fs.existsSync(readOnly)).toBeFalse();
  expect(first.kept.unremovable_permissions).toBe(1);
  expect(fs.existsSync(blocked)).toBeFalse();
  expect(names(w)).toHaveLength(1);
  expect(journalRows().some(row => row.phase === "refused" && row.code === "unremovable_permissions")).toBeTrue();
  // Within six hours the tombstone waits; afterwards its removal is retried and finishes.
  expect((await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + HOUR, remove: refusing })))!).toMatchObject({ waiting: 1, finishedInterrupted: 0 });
  const later = (await runUnregisteredScratchPass(w.store, ports({ now: () => NOW + 7 * HOUR, remove: refusing })))!;
  expect(later.finishedInterrupted).toBe(1);
  expect(names(w)).toEqual([]);
});

test("a failed intent write leaves the tree in place, and a dry run removes and journals nothing", async () => {
  const w = world();
  const directory = make(w, "llv-stage-JRNL01");
  fs.mkdirSync(statePath("disk-cleaner", "ordinary-2031-03-10.ndjson"), { recursive: true });
  const blocked = (await runUnregisteredScratchPass(w.store, ports()))!;
  expect(blocked).toMatchObject({ removed: 0, errors: 1 });
  expect(blocked.kept.journal_unavailable).toBe(1);
  expect(fs.existsSync(path.join(directory, "cache", "data"))).toBeTrue();
  fs.rmSync(statePath("disk-cleaner", "ordinary-2031-03-10.ndjson"), { recursive: true });
  const dry = (await runUnregisteredScratchPass(w.store, ports({ mode: "dry-run", now: () => NOW + 2 * HOUR })))!;
  expect(dry).toMatchObject({ mode: "dry-run", wouldRemove: 1, removed: 0, journal: null });
  expect(fs.existsSync(directory)).toBeTrue();
  expect(journalRows()).toEqual([]);
  expect(remembered(w, ledger => ledger.totals())).toEqual({ removedRoots: 0, removedBytes: 0, last: expect.anything() });
});

test("a new day's journal prunes the writer's own files older than thirty days", async () => {
  const w = world();
  const dir = statePath("disk-cleaner");
  fs.mkdirSync(dir, { recursive: true });
  // A Cleaner pass journal is named by its id; it is not this writer's file and must stay.
  const passJournal = `${["11111111", "2222", "4333", "8444", "555555555555"].join("-")}.ndjson`;
  for (const name of ["ordinary-2031-01-01.ndjson", "ordinary-2031-02-20.ndjson", "latest.json", passJournal]) fs.writeFileSync(path.join(dir, name), "{}\n");
  make(w, "llv-stage-PRUNE1");
  await runUnregisteredScratchPass(w.store, ports());
  expect(fs.readdirSync(dir).sort()).toEqual([passJournal, "latest.json", "ordinary-2031-02-20.ndjson", "ordinary-2031-03-10.ndjson"]);
});

test("the production tick runs the pass first, reports unregistered totals and the last pass, and survives a restart", async () => {
  const w = world();
  const real = Date.now();
  const roots = ["llv-stage-PROD01", "llv-stage-PROD02", "llv-stage-PROD03"].map(name => {
    const directory = make(w, name);
    setTimes(directory, real - 30 * HOUR);
    return directory;
  });
  const young = make(w, "llv-stage-YOUNG1");
  setTimes(young, real - HOUR);
  const env = { NODE_ENV: "test", LLV_TEMP_SWEEP: "on" };
  const report = (await runAttemptTempSweep({ scan: () => empty, references: async () => true, availableBytes: () => 40e9 }, env))!;
  expect(report.unregistered).toMatchObject({ removed: 3, trigger: "free-space", errors: 0, found: 4, scratch: "present" });
  for (const directory of roots) expect(fs.existsSync(directory)).toBeFalse();
  expect(fs.existsSync(young)).toBeTrue();
  const written = JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
  expect(written.unregistered.totals.removedRoots).toBe(3);
  expect(written.unregistered.last).toMatchObject({ removed: 3, trigger: "free-space", examined: 4 });
  expect(written.unregistered.keptByReason).toEqual([expect.objectContaining({ code: "young", count: 1 })]);
  expect(written.summary).toContain("Unregistered scratch: 4 roots without an owner");
  expect(written.summary).toContain("free space is below 50 GB");
  expect(written.summary).toContain("Removed in total 3 roots");
  expect(written.summary).toContain("Journal: disk-cleaner/ordinary-");
  // The next tick, in a fresh ledger connection, still reports the totals and the waiting root.
  w.restart();
  const next = (await runAttemptTempSweep({ scan: () => empty, references: async () => true, availableBytes: () => 400e9 }, env))!;
  expect(next.unregistered).toMatchObject({ removed: 0, examined: 0, waiting: 1, trigger: null });
  expect(next.unregistered!.totals.removedRoots).toBe(3);
  expect(next.unregistered!.last).toMatchObject({ removed: 3 });
});
