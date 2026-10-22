import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempState } from "./attemptTempRetention";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-22T12:00:00Z");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attempt-retention-")); roots.push(root);
  const filename = path.join(root, "owners.sqlite");
  const store = new AttemptTempStore(filename);
  const make = (name: string, age = 0, evidence = false) => {
    const directory = path.join(root, `llv-stage-${name}`); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
    store.register({ directory, pipelineId: "lane", launchId: name, retainUntilClose: evidence, createdAt: NOW - age });
    return directory;
  };
  const sweep = (state: AttemptTempState = "settled", options = {}) => sweepAttemptTemps(store, {
    now: () => NOW, state: async () => state, scan: () => ({ ownNamespace: null, processes: [] }), ...options,
  });
  return { root, filename, store, make, sweep };
}

test("a settled attempt removes its scratch without waiting for host release", async () => {
  const f = fixture(); const directory = f.make("settled");
  try { expect((await f.sweep()).removed).toBe(1); expect(fs.existsSync(directory)).toBeFalse(); }
  finally { f.store.close(); }
});

test("the capped sweep evicts old unowned roots oldest first within its tick budget", async () => {
  const f = fixture(); const newer = f.make("a-newer", 3 * 86400000); const older = f.make("z-older", 4 * 86400000);
  try {
    const report = await f.sweep("orphan", { maxRoots: 1, capBytes: 0, maxAgeMs: 86400000 });
    expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThanOrEqual(4096);
    expect(fs.existsSync(older)).toBeFalse(); expect(fs.existsSync(newer)).toBeTrue();
  } finally { f.store.close(); }
});

test.each(["live", "unknown"] as const)("%s ownership retains scratch", async state => {
  const f = fixture(); const directory = f.make(state);
  try { expect((await f.sweep(state)).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue(); }
  finally { f.store.close(); }
});

test("declared evidence survives settlement until lane close", async () => {
  const f = fixture(); const directory = f.make("evidence", 0, true);
  try {
    expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    expect((await f.sweep("closed", { now: () => NOW + 60000 })).removed).toBe(1);
  } finally { f.store.close(); }
});

test("a process holder retains a settled directory", async () => {
  const f = fixture(); const directory = f.make("held");
  try {
    const report = await f.sweep("settled", { scan: () => ({ ownNamespace: null, processes: [{ pid: 123, namespace: null, stamped: false, paths: [path.join(directory, "future")] }] }) });
    expect(report.removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
  } finally { f.store.close(); }
});

test.each([2, 3])("ownership revoked at authority read %i preserves the original tree", async revokeAt => {
  const f = fixture(); const directory = f.make("revoked"); let reads = 0;
  try {
    const report = await f.sweep("settled", { state: async () => ++reads >= revokeAt ? "live" : "settled" });
    expect(reads).toBe(revokeAt); expect(report.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test("replacement during an authority await preserves both identities", async () => {
  const f = fixture(); const directory = f.make("replaced"); let changed = false;
  try {
    const report = await f.sweep("settled", { state: async () => {
      if (!changed) { changed = true; fs.renameSync(directory, directory + "-saved"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "keep"), "replacement"); }
      return "settled";
    } });
    expect(report.removed).toBe(0); expect(fs.readFileSync(path.join(directory, "keep"), "utf8")).toBe("replacement");
    expect(fs.existsSync(directory + "-saved/data")).toBeTrue();
  } finally { f.store.close(); }
});

test("a symlink replacement cannot redirect cleanup", async () => {
  const f = fixture(); const directory = f.make("symlink");
  fs.renameSync(directory, directory + "-saved"); fs.symlinkSync(directory + "-saved", directory);
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(directory + "-saved/data")).toBeTrue(); }
  finally { f.store.close(); }
});

test("a tick budget and its fairness checkpoint survive real helper restarts", async () => {
  const f = fixture(); const a = f.make("first", 100); const b = f.make("second", 0);
  f.store.close();
  for (const removed of [a, b]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(NOW)], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ checked: 1, removed: 1 });
    expect(fs.existsSync(removed)).toBeFalse();
    if (removed === a) expect(fs.existsSync(b)).toBeTrue();
  }
});

test("unowned roots younger than the configured age stay even over cap", async () => {
  const f = fixture(); const directory = f.make("young", 86400000 - 1);
  try { expect((await f.sweep("orphan", { capBytes: 0, maxAgeMs: 86400000 })).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue(); }
  finally { f.store.close(); }
});

test("dry run records the decision without removing or spending the ledger", async () => {
  const f = fixture(); const directory = f.make("dry-run");
  try {
    expect((await f.sweep("settled", { mode: "dry-run" })).removed).toBe(1); expect(fs.existsSync(directory)).toBeTrue();
    expect((await f.sweep("settled", { now: () => NOW + 60000 })).removed).toBe(1);
  } finally { f.store.close(); }
});

test("disposable test repositories retire but linked worktrees remain for their owner", async () => {
  const f = fixture(); const disposable = f.make("fixture"); const linked = f.make("linked");
  fs.mkdirSync(path.join(disposable, ".git")); fs.writeFileSync(path.join(disposable, ".git/HEAD"), "fixture");
  fs.writeFileSync(path.join(linked, ".git"), "gitdir: retained-metadata");
  try {
    expect((await f.sweep()).removed).toBe(1); expect(fs.existsSync(disposable)).toBeFalse();
    expect(fs.readFileSync(path.join(linked, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test("a failed removal is recovered from its durable intent on the next tick", async () => {
  const { spyOn } = await import("bun:test");
  const f = fixture(); const directory = f.make("interrupted");
  const remove = fs.promises.rm;
  const refused = spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    if (String(target).includes(`.delegatus-trash-${path.basename(directory)}-`)) throw new Error("fixture removal refused");
    return remove(target, options);
  });
  try { expect((await f.sweep()).errors).toBe(1); }
  finally { refused.mockRestore(); }
  try {
    const report = await f.sweep("settled", { now: () => NOW + 60000 });
    expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0); expect(report.held).toBe(0);
    expect(fs.readdirSync(f.root).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  } finally { f.store.close(); }
});

test("a live checkout link retains another attempt root while the consumer is idle", async () => {
  const f = fixture(); const directory = f.make("dependency");
  const checkout = path.join(f.root, "consumer"); fs.mkdirSync(checkout); fs.mkdirSync(path.join(checkout, ".git"));
  fs.symlinkSync(directory, path.join(checkout, "node_modules"), "dir");
  try {
    expect((await f.sweep("settled", { scan: () => ({ ownNamespace: null, processes: [{ pid: 321, namespace: null, stamped: true, paths: [checkout] }] }) })).removed).toBe(0);
    expect(fs.existsSync(path.join(checkout, "node_modules/data"))).toBeTrue();
  } finally { f.store.close(); }
});

test.each([2, 4, 6])("authority changes after native observations at read %i retain scratch", async revokeAt => {
  const f = fixture(); const directory = f.make("late-authority"); let reads = 0;
  try {
    expect((await f.sweep("settled", { state: async () => ++reads >= revokeAt ? "live" : "settled" })).removed).toBe(0);
    expect(fs.existsSync(path.join(directory, "data"))).toBeTrue();
  } finally { f.store.close(); }
});


test("a quarantine replacement during asynchronous validation is preserved", async () => {
  const { removeTreeViaTrash } = await import("@/lib/tempSweep");
  const f = fixture(); const directory = f.make("quarantine-replacement");
  let replacement = "", saved = "";
  try {
    expect(await removeTreeViaTrash(directory, {
      journal: path.join(f.root, "intent.json"), disposable: true,
      held: async trash => {
        await Promise.resolve();
        saved = trash + "-saved"; fs.renameSync(trash, saved);
        replacement = trash; fs.mkdirSync(trash); fs.writeFileSync(path.join(trash, "keep"), "replacement");
        return false;
      },
    })).toBeFalse();
    expect(fs.existsSync(path.join(directory, "keep")) || fs.existsSync(path.join(replacement, "keep"))).toBeTrue();
    expect(fs.readFileSync(path.join(saved, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});


test.skipIf(process.platform !== "linux")("a real held file lock retains scratch until its owner exits", async () => {
  const { scanProcesses } = await import("@/lib/tempSweep");
  const f = fixture(); const directory = f.make("locked");
  const child = Bun.spawn(["flock", "--exclusive", path.join(directory, "held.lock"), process.execPath,
    path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--hold"], {
    env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  // Observe only this fixture's kernel references. Unrelated test runs on the
  // shared test machine can retire their own checkout during a /proc scan.
  const ownedScan = () => {
    const scan = scanProcesses();
    return { ...scan, processes: scan.processes.filter(process => process.pid === child.pid) };
  };
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    expect((await f.sweep("settled", { scan: ownedScan })).removed).toBe(0);
    expect(fs.existsSync(directory)).toBeTrue();
    child.stdin.end(); expect(await child.exited).toBe(0);
    expect((await f.sweep("settled", { now: () => NOW + 60000, scan: ownedScan })).removed).toBe(1);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited; f.store.close();
  }
}, 30000);


test("a disposable clone that owns linked worktrees stays with the preservation owner", async () => {
  const f = fixture(); const directory = f.make("linked-parent");
  fs.mkdirSync(path.join(directory, ".git/worktrees/consumer"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".git/worktrees/consumer/gitdir"), "external-checkout/.git");
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(path.join(directory, "data"))).toBeTrue(); }
  finally { f.store.close(); }
});


test("an empty Git marker outside a disposable cache retains its attempt root", async () => {
  const f = fixture(); const directory = f.make("damaged-git");
  fs.writeFileSync(path.join(directory, ".git"), "");
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(path.join(directory, "data"))).toBeTrue(); }
  finally { f.store.close(); }
});


test("retirement reports its counts before inspecting the next root", async () => {
  const f = fixture(); const first = f.make("first", 100); f.make("second");
  let removed = 0;
  try {
    const report = await f.sweep("settled", { state: async (owner: { launchId: string }) => {
      if (owner.launchId === "second") { expect(removed).toBe(1); throw new Error("fixture observation refused"); }
      return "settled";
    }, onRetired: (count: number, bytes: number) => {
      removed += count; expect(bytes).toBeGreaterThanOrEqual(4096); expect(fs.existsSync(first)).toBeFalse();
    } });
    expect(report).toMatchObject({ removed: 1, errors: 1 }); expect(removed).toBe(1);
  } finally { f.store.close(); }
});


test("new arrivals cannot starve a due owner across helper restarts", async () => {
  const f = fixture(); const old = f.make("old", 1000); f.store.close();
  const run = async (now: number, state = "settled") => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(now), state],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); return JSON.parse(stdout);
  };
  expect(await run(NOW, "live")).toMatchObject({ checked: 1, removed: 0 });
  const store = new AttemptTempStore(f.filename);
  const arrival = path.join(f.root, "llv-stage-arrival"); fs.mkdirSync(arrival);
  try { store.register({ directory: arrival, pipelineId: "lane", launchId: "arrival", retainUntilClose: false, createdAt: NOW + 60000 }); }
  finally { store.close(); }
  expect(await run(NOW + 60000)).toMatchObject({ checked: 1, removed: 1 });
  expect(fs.existsSync(old)).toBeFalse(); expect(fs.existsSync(arrival)).toBeTrue();
}, 30000);
