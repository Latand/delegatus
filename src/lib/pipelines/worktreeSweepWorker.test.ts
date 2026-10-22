import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker, stopWorktreeSweepWorker } from "./worktreeSweepWorker";
import { SWEEP_CACHE_TREES } from "./worktreeSweepCache";
import { runWorktreeSweep } from "./worktreeSweep";

const roots: string[] = [];
const workers: WorktreeSweepWorker[] = [];
const previous = process.env.SWEEP_TEST_ROOT;
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  await stopWorktreeSweepWorker();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SWEEP_TEST_ROOT; else process.env.SWEEP_TEST_ROOT = previous;
});
function fixture(flag?: string, timeoutMs = 10_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-worker-")); roots.push(root);
  fs.mkdirSync(path.join(root, "tree/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/nested/file"), "original");
  process.env.SWEEP_TEST_ROOT = root;
  const worker = launch(flag, timeoutMs);
  return { root, worker };
}
function launch(flag?: string, timeoutMs = 10_000) {
  const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: path.join(import.meta.dir,"worktreeSweep.fixture.ts"), args: flag ? [flag] : [] },timeoutMs);
  workers.push(worker); return worker;
}
const counters = (report: unknown) => (report as {cacheStats:{allocationHits:number;allocationMisses:number}}).cacheStats;

test("real worker reuses unchanged inventories, invalidates deep writes, and revalidates after owner restart", async () => {
  const { root, worker } = fixture();
  const first = await worker.run("dry-run");
  const second = await worker.run("dry-run");
  expect(counters(first)).toMatchObject({allocationHits:0,allocationMisses:1});
  expect(counters(second)).toMatchObject({allocationHits:1,allocationMisses:1});
  const file = path.join(root,"tree/nested/file");
  fs.writeFileSync(file, "changed".repeat(8192));
  const deadline = Date.now() + 10_000;
  let changed;
  do {
    changed = await worker.run("dry-run");
    if (counters(changed).allocationMisses > 1) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  expect(counters(changed).allocationMisses).toBeGreaterThan(1);
  expect(changed!.kept[0].bytes).toBeGreaterThan(first.kept[0].bytes!);
  await worker.close();
  fs.writeFileSync(file, "offline".repeat(16384));
  const restarted = await launch().run("dry-run");
  expect(counters(restarted).allocationMisses).toBe(1);
  expect(restarted.kept[0].bytes).toBeGreaterThan(changed!.kept[0].bytes!);
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).version).toBe(1);
},30_000);

for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang"]) test(`worker refuses ${flag} and its contained process ends`, async () => {
  const { root, worker } = fixture(flag, 2_000);
  await worker.run("dry-run"); // explicit readiness before inducing failure
  await expect(worker.run("on")).rejects.toThrow();
  if (flag === "--hang") {
    const pid = Number(fs.readFileSync(path.join(root,"busy-pid"),"utf8"));
    expect(() => process.kill(pid,0)).toThrow();
  }
  expect(fs.readFileSync(path.join(root,"tree/nested/file"),"utf8")).toBe("original");
  // The failed worker has closed before replacement may start.
  expect((await worker.run("dry-run")).errors).toEqual([]);
},20_000);

test("production entry runs off thread against isolated empty state", async () => {
  const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: "dry-run" });
  expect(report?.errors).toEqual([]);
  expect(report?.removed).toEqual([]);
},30_000);


test("a restored full cache admits a new root within its persistent bound across real worker restarts",async()=>{
  const {root,worker}=fixture();
  fs.writeFileSync(path.join(root,"cache.json"),JSON.stringify({version:1,owner:"old-owner",rows:
    Array.from({length:SWEEP_CACHE_TREES},(_,i)=>[path.join(root,`past-${i}`),{key:"past-owner",at:1_000,candidates:[]}])}));
  await worker.run("dry-run");await worker.close();
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
  await launch().run("dry-run");
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
},30_000);


test("temp and disk observations share the lease, coalesce polls, and serialize with worktrees", async () => {
  const { root, worker } = fixture();
  const worktrees = worker.run("dry-run");
  const temp = worker.temp();
  expect(worker.temp()).toBe(temp);
  const disk = worker.diskPressure();
  expect(worker.diskPressure()).toBe(disk);
  expect((await worktrees).errors).toEqual([]);
  expect((await temp)?.removed).toEqual([]);
  await expect(disk).rejects.toThrow("stale while the sweep helper is busy");
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("temp\n");
  expect(await worker.temp({ NODE_ENV: "test", LLV_TEMP_SWEEP: "off" })).toBeNull();
  await worker.close();
  expect((await launch().diskPressure()).volumes.length).toBeGreaterThan(0);
}, 30_000);


test("fresh disk pressure returns while a worktree sweep holds the leased helper", async () => {
  const { root, worker } = fixture("--hold-worktree", 10_000);
  const shared = globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker };
  shared.__delegatusWorktreeSweepWorker = worker;
  const { readDiskPressure } = await import("../state/diskPressure");
  const initial = await readDiskPressure();
  const readyPath = path.join(root, "busy-pid");
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, (_event, file) => {
      if (String(file) !== path.basename(readyPath)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("worktree sweep did not acknowledge the hold"));
    }, 5_000);
  });
  const sweep = worker.run("on");
  try {
    await ready;
    const readDir = fs.readdirSync;
    let processScans = 0;
    const scan = spyOn(fs, "readdirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
      if (String(directory) === "/proc") { processScans++; throw new Error("process scan on caller"); }
      return Reflect.apply(readDir, fs, [directory, ...args]);
    }) as typeof readDir);
    const probe = spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("volume probe on caller"); });
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = await Promise.race([
        readDiskPressure().then(report => ({ report })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fresh disk read waited behind sweep")), 1_000); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      expect(bounded.report.at).toBe(initial.at);
      expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("disk-pressure\n");
      expect(probe).not.toHaveBeenCalled();
      expect(processScans).toBe(0);
    } finally { scan.mockRestore(); probe.mockRestore(); }
  } finally {
    fs.writeFileSync(path.join(root, "release-worktree"), "release");
  }
  expect((await sweep).errors).toEqual([]);
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("disk-pressure\n");
}, 20_000);


test("disk-pressure cache misses fail promptly instead of joining a held sweep", async () => {
  const { root, worker } = fixture("--hold-worktree", 10_000);
  const shared = globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker };
  shared.__delegatusWorktreeSweepWorker = worker;
  const { readDiskPressure } = await import("../state/diskPressure");
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, (_event, file) => {
      if (String(file) !== "busy-pid") return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("worktree sweep did not acknowledge the hold"));
    }, 5_000);
  });
  const sweep = worker.run("on");
  try {
    await ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      readDiskPressure().then(
        report => ({ report }),
        error => ({ error }),
      ),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("disk cache miss waited behind sweep")), 1_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    expect("error" in result && result.error.message).toContain("stale while the sweep helper is busy");
    expect(fs.existsSync(path.join(root, "requests"))).toBe(false);
  } finally {
    fs.writeFileSync(path.join(root, "release-worktree"), "release");
  }
  expect((await sweep).errors).toEqual([]);
  expect(fs.existsSync(path.join(root, "requests"))).toBe(false);
}, 20_000);

for (const kind of ["temp", "disk-pressure"] as const) {
  for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang"]) test(`${kind} refuses ${flag} under the shared lease`, async () => {
    const { root, worker } = fixture(flag, 2_000);
    await worker.run("dry-run");
    await expect(kind === "temp" ? worker.temp() : worker.diskPressure()).rejects.toThrow();
    if (flag === "--hang") expect(() => process.kill(Number(fs.readFileSync(path.join(root, "busy-pid"), "utf8")), 0)).toThrow();
    expect(fs.readFileSync(path.join(root, "tree/nested/file"), "utf8")).toBe("original");
    expect((await worker.run("dry-run")).errors).toEqual([]);
  }, 20_000);
}

test("stop cancels queued temp and disk jobs without starting a replacement helper", async () => {
  const { root, worker } = fixture("--hang", 2_000);
  await worker.run("dry-run");
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, (_event, file) => {
      if (String(file) !== "busy-pid") return;
      clearTimeout(timer); watcher.close(); resolve();
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("worker did not enter the busy fixture")); }, 10_000);
  });
  const active = worker.run("on");
  const activeResult = Promise.allSettled([active]);
  await ready;
  const temp = worker.temp();
  const disk = worker.diskPressure();
  const results = Promise.allSettled([temp, disk]);
  await worker.close();
  expect((await activeResult)[0].status).toBe("rejected");
  expect((await results).every(result => result.status === "rejected")).toBe(true);
  expect(fs.existsSync(path.join(root, "requests"))).toBe(false);
}, 20_000);

test("production readers never scan processes or probe volumes on the calling loop", async () => {
  const { runTempSweep } = await import("../tempSweep");
  const { readDiskPressure } = await import("../state/diskPressure");
  const read = fs.readdirSync;
  let processScans = 0;
  const scan = spyOn(fs, "readdirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
    if (String(directory) === "/proc") { processScans++; throw new Error("process scan on caller"); }
    return Reflect.apply(read, fs, [directory, ...args]);
  }) as typeof read);
  const probe = spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("volume probe on caller"); });
  try {
    expect(await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP: "off" })).toBeNull();
    const pressure = await readDiskPressure();
    expect(pressure.volumes.length).toBeGreaterThan(0);
    expect((await readDiskPressure()).at).toBe(pressure.at);
    expect(probe).not.toHaveBeenCalled();
    expect(processScans).toBe(0);
  } finally { scan.mockRestore(); probe.mockRestore(); }
}, 30_000);

test("attempt retirement coalesces through the owned worker", async () => {
  const { root, worker } = fixture();
  const request = worker.attemptTemp();
  expect(worker.attemptTemp()).toBe(request);
  expect(await request).toMatchObject({ checked: 0, removed: 0, removedBytes: 0 });
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("attempt-temp\n");
});

for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang"]) test(`attempt retirement refuses ${flag} and reaps its helper`, async () => {
  const { worker } = fixture(flag, 2000);
  await worker.run("dry-run");
  await expect(worker.attemptTemp()).rejects.toThrow();
  expect((await worker.run("dry-run"))!.errors).toEqual([]);
}, 20000);
