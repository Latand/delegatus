import { sweepMonotonicNow } from "../runtime/attemptTempDeadline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker, stopWorktreeSweepWorker } from "./worktreeSweepWorker";
import { SWEEP_CACHE_TREES } from "./worktreeSweepCache";
import { runWorktreeSweep } from "./worktreeSweep";
import { readWorktreePage } from "./worktreeDrilldown";
import { sweepMemoryPressured, sweepPressureCheckpoint, WORKTREE_SWEEP_RSS_HIGH_WATER_BYTES } from "./sweepWalkAdmission";

const roots: string[] = [];
const workers: WorktreeSweepWorker[] = [];
const previous = process.env.SWEEP_TEST_ROOT;
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  await stopWorktreeSweepWorker();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SWEEP_TEST_ROOT; else process.env.SWEEP_TEST_ROOT = previous;
});
const workerClock = { now: sweepMonotonicNow, setTimeout, clearTimeout };
function fixture(flag?: string, timeoutMs = 10_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-worker-")); roots.push(root);
  fs.mkdirSync(path.join(root, "tree/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/nested/file"), "original");
  process.env.SWEEP_TEST_ROOT = root;
  const worker = launch(flag, timeoutMs);
  return { root, worker };
}
function launch(flag?: string, timeoutMs = 10_000) {
  const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: path.join(import.meta.dir,"worktreeSweep.fixture.ts"), args: flag ? [flag] : [] },timeoutMs, workerClock);
  workers.push(worker); return worker;
}
const counters = (report: unknown) => (report as {cacheStats:{allocationHits:number;allocationMisses:number}}).cacheStats;

function productionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-protocol-")); roots.push(root);
  const env = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
    LLV_STATE_DIR: path.join(root, "state"), TMPDIR: root,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_TEMP_SWEEP: "on" };
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.LLV_STATE_DIR]) fs.mkdirSync(directory);
  const preload = path.join(root, "preload.ts");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import path from "node:path";
    import { savePipelines, withPipelineMutation } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))};
    import { injectStateWriteFaultForTests, stateLeaseHoldsInFlight } from ${JSON.stringify(path.join(import.meta.dir, "../state/sqliteStateStore.ts"))};
    import { StateLockDeferredError } from ${JSON.stringify(path.join(import.meta.dir, "../state/lockWait.ts"))};
    const root = ${JSON.stringify(root)};
    fs.appendFileSync(path.join(root, "starts"), process.pid + "\\n");
    // Walk admission reads host memory before each request. Keep these
    // protocol tests independent of the operator's current pressure sample;
    // tests that exercise pressure inject the sample at the checkpoint.
    const realReadFileSync = fs.readFileSync.bind(fs);
    fs.readFileSync = (file, ...args) => {
      if (String(file) === "/proc/meminfo") return "MemTotal: 32768000 kB\\nMemAvailable: 12000000 kB\\nMemFree: 8000000 kB\\nBuffers: 1000000 kB\\nCached: 3000000 kB\\nSReclaimable: 500000 kB\\nShmem: 100000 kB\\nSwapTotal: 16000000 kB\\nSwapFree: 8000000 kB\\n";
      if (String(file) === "/proc/pressure/memory") return "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\\n";
      return realReadFileSync(file, ...args);
    };
    if (process.env.SWEEP_FIXTURE_HIGH_RSS === "1") process.memoryUsage.rss = () => 257 * 1024 ** 2;
    const stderr = console.error.bind(console);
    console.error = (...args) => {
      fs.appendFileSync(path.join(root, "diagnostics"), args.join(" ") + "\\n");
      stderr(...args);
    };
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = function(chunk, ...args) {
      fs.appendFileSync(path.join(root, "diagnostics"), String(chunk));
      return stderrWrite(chunk, ...args);
    };
    const write = process.stdout.write.bind(process.stdout);
    let first = true;
    process.stdout.write = function(chunk, ...args) {
      if (!first || !String(chunk).startsWith('{"report":')) return write(chunk, ...args);
      first = false;
      if (process.env.SWEEP_LEASE_CONTROL === "hold") {
        void withPipelineMutation(async () => {
          fs.writeFileSync(path.join(root, "held"), String(process.pid));
          await new Promise(() => setInterval(() => {}, 1000));
        });
      } else {
        if (process.env.SWEEP_LEASE_CONTROL !== "takeover") {
          injectStateWriteFaultForTests({ site: "release", collection: "pipelines", times: 1,
            error: new StateLockDeferredError("state.lease.release") });
        }
        savePipelines([]);
        fs.writeFileSync(path.join(root, "release-holds"), String(stateLeaseHoldsInFlight().length));
        // Hold the first real reply until the real abandoned-release timer has
        // run, so its diagnostic arrives while the parent still awaits JSON.
        void (async () => {
          const deadline = Date.now() + 10000;
          while (stateLeaseHoldsInFlight().length) {
            if (Date.now() > deadline) throw new Error("lease retry did not settle");
            await Bun.sleep(5);
          }
          if (process.env.SWEEP_LEASE_CONTROL !== "takeover") console.debug("sweep retry settled");
          fs.writeFileSync(path.join(root, "released"), "done");
          write(chunk, ...args);
        })();
      }
      return true;
    };
  `);
  const entry = path.join(import.meta.dir, "../worktreeSweep.worker.ts");
  return { root, env, command: [process.execPath, "--preload", preload, entry] };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(5);
  expect(fs.existsSync(file)).toBeTrue();
}
async function waitForText(file: string, expected: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(expected)) return;
    await Bun.sleep(5);
  }
  expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").toContain(expected);
}

test.skipIf(process.platform !== "linux")("MemAvailable and both PSI thresholds independently defer a walk", () => {
  const pressured = (available: number, some: number, full: number) => sweepMemoryPressured(file =>
    file.endsWith("meminfo") ? `MemTotal: 32768000 kB\nMemAvailable: ${available} kB\n`
      : `some avg10=${some}\nfull avg10=${full}\n`);
  expect(pressured(11_000_000, 9.99, 4.99)).toBeFalse();
  expect(pressured(7_000_000, 0, 0)).toBeTrue();
  expect(pressured(11_000_000, 10, 0)).toBeTrue();
  expect(pressured(11_000_000, 5, 5)).toBeTrue();
});

test("an admitted worktree checks its RSS high-water mark at the next traversal checkpoint", () => {
  const rss = spyOn(process.memoryUsage, "rss").mockReturnValue(WORKTREE_SWEEP_RSS_HIGH_WATER_BYTES);
  try {
    const checkpoint = sweepPressureCheckpoint(true, file => file.endsWith("meminfo")
      ? "MemTotal: 32768000 kB\nMemAvailable: 12000000 kB\n"
      : "some avg10=0\nfull avg10=0\n");
    expect(checkpoint(0)).toBeTrue();
    expect(rss).toHaveBeenCalledTimes(1);
  } finally { rss.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("production helper serializes walks across processes while volume reads stay available", async () => {
  const { root, env } = productionFixture();
  const admission = JSON.stringify(path.join(import.meta.dir, "sweepWalkAdmission.ts"));
  const holder = Bun.spawn([process.execPath, "-e", `
    import { withSweepWalk } from ${admission};
    import fs from "node:fs";
    const here = ${JSON.stringify(root)};
    await withSweepWalk(Number(process.hrtime.bigint()) / 1e6 + 15000, async () => {
      fs.readdirSync(here);
      fs.writeFileSync(here + "/walk-ready", "ready");
      await new Response(Bun.stdin.stream()).text();
    }, () => false);
  `], { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const holderError = new Response(holder.stderr).text();
  const preload = path.join(root, "pressure-preload.ts");
  fs.writeFileSync(preload, String.raw`
    import fs from "node:fs";
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (file === "/proc/meminfo") return "MemTotal: 32768000 kB\nMemAvailable: 16384000 kB\n";
      if (file === "/proc/pressure/memory") return fs.existsSync(${JSON.stringify(path.join(root, "pressured"))})
        ? "some avg10=12.00\nfull avg10=5.00\n" : "some avg10=0.00\nfull avg10=0.00\n";
      return read.call(this, file, ...args);
    };
  `);
  const entry = path.join(import.meta.dir, "../worktreeSweep.worker.ts");
  const child = Bun.spawn([process.execPath, "--preload", preload, entry], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const childError = new Response(child.stderr).text();
  const output = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  const query = async (kind: string) => {
    child.stdin.write(JSON.stringify({ kind, deadline: sweepMonotonicNow() + 10_000 }) + "\n");
    while (!pending.includes("\n")) {
      const chunk = await output.read();
      if (chunk.done) throw new Error(await childError);
      pending += chunk.value;
    }
    const end = pending.indexOf("\n"), frame = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    return frame;
  };
  try {
    await waitForFile(path.join(root, "walk-ready"));
    expect(await query("disk-pressure")).toMatchObject({ report: { volumes: expect.any(Array) } });
    expect(await query("attempt-temp")).toEqual({ deferred: "busy" });
    expect(fs.existsSync(path.join(env.LLV_STATE_DIR, "attempt-temp-report.json"))).toBeFalse();
    holder.stdin.end();
    expect(await holder.exited, await holderError).toBe(0);
    fs.writeFileSync(path.join(root, "pressured"), "present");
    expect(await query("attempt-temp")).toEqual({ deferred: "memory" });
    fs.rmSync(path.join(root, "pressured"));
    expect(await query("attempt-temp")).toMatchObject({ report: { checked: 0, removed: 0 } });
  } finally {
    if (holder.exitCode === null) { holder.kill(); await holder.exited; }
    child.stdin.end();
    await output.cancel();
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}, 30_000);

test("production helper returns attempt reports and survives its own abandoned lease retry diagnostic", async () => {
  const { root, env, command } = productionFixture();
  const previous = { ...process.env };
  Object.assign(process.env, env);
  const worker = new WorktreeSweepWorker({ executable: command[0], entry: command[1], args: command.slice(2) }, 20_000);
  workers.push(worker);
  try {
    expect(await worker.attemptTemp()).toMatchObject({ checked: 0, removed: 0 });
    expect(fs.readFileSync(path.join(root, "release-holds"), "utf8")).toBe("1");
    expect(fs.readFileSync(path.join(root, "released"), "utf8")).toBe("done");
    await waitForText(path.join(root, "diagnostics"), "[state lease] cleared abandoned pipelines");
    const settledDiagnostics = fs.readFileSync(path.join(root, "diagnostics"), "utf8");
    expect(settledDiagnostics).toContain("[state lease] cleared abandoned pipelines");
    expect(settledDiagnostics).toContain("sweep retry settled");
    expect(await worker.attemptTemp()).toMatchObject({ checked: 0, removed: 0 });
    const starts = fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n");
    expect(starts).toHaveLength(1);
    expect(() => process.kill(Number(starts[0]), 0)).not.toThrow();
  } finally {
    await worker.close();
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}, 30_000);

test("a helper at its RSS threshold is replaced before the next attempt request", async () => {
  const { root, env, command } = productionFixture();
  const saved = { ...process.env };
  const settings = { ...env, SWEEP_FIXTURE_HIGH_RSS: "1" };
  Object.assign(process.env, settings);
  const worker = new WorktreeSweepWorker({ executable: command[0], entry: command[1], args: command.slice(2) }, 20_000);
  try {
    expect(await worker.attemptTemp()).toMatchObject({ checked: 0 });
    expect(await worker.attemptTemp()).toMatchObject({ checked: 0 });
    const starts = fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n");
    expect(new Set(starts).size).toBe(2);
  } finally {
    await worker.close();
    for (const key of Object.keys(settings)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}, 30_000);

test("production maintenance keeps Docker dry and all ledger writes inside its fixture", async () => {
  const { root, env, command } = productionFixture(), calls = path.join(root, "docker-calls");
  fs.writeFileSync(path.join(root, "docker"), `#!/usr/bin/python3 -IB\nwith open(${JSON.stringify(calls)},'a') as f: f.write('unexpected call\\n')\nraise RuntimeError('unexpected Docker runner')\n`, { mode: 0o700 });
  const child = Bun.spawn(command, {
    env: { ...env, PATH: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    child.stdin.write(JSON.stringify({ kind: "maintenance", deadline: sweepMonotonicNow() + 20000 }) + "\n"); child.stdin.end();
    expect(await child.exited, await stderr).toBe(0);
    const frames = (await stdout).trim().split("\n").map(line => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ report: { checked: 0, removed: 0, errors: 0 } });
    expect(fs.existsSync(path.join(env.LLV_STATE_DIR, "temporary-data.sqlite"))).toBeTrue();
    expect(fs.existsSync(path.join(env.LLV_STATE_DIR, "docker-cache-retention.json"))).toBeFalse();
    expect(fs.existsSync(calls)).toBeFalse();
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
}, 30_000);

test("production helper takeover of a killed helper lease emits only reply frames on stdout", async () => {
  const { root, env, command } = productionFixture();
  const holder = Bun.spawn(command, { env: { ...env, SWEEP_LEASE_CONTROL: "hold" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    holder.stdin.write(JSON.stringify({ kind: "attempt-temp", deadline: sweepMonotonicNow() + 20000 }) + "\n");
    await waitForFile(path.join(root, "held"));
    expect(Number(fs.readFileSync(path.join(root, "held"), "utf8"))).toBe(holder.pid);
    holder.kill("SIGKILL");
    await holder.exited;
    expect(() => process.kill(holder.pid, 0)).toThrow();
    const successor = Bun.spawn(command, { env: { ...env, SWEEP_LEASE_CONTROL: "takeover" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(successor.stdout).text();
    const stderr = new Response(successor.stderr).text();
    try {
      successor.stdin.write((JSON.stringify({ kind: "attempt-temp", deadline: sweepMonotonicNow() + 20000 }) + "\n").repeat(2));
      successor.stdin.end();
      expect(await successor.exited).toBe(0);
      const frames = (await stdout).trim().split("\n").map(line => JSON.parse(line));
      expect(frames).toHaveLength(2);
      for (const frame of frames) expect(frame.report).toMatchObject({ checked: 0, removed: 0 });
      expect(await stderr).not.toContain("cleared abandoned");
      expect(fs.readFileSync(path.join(root, "release-holds"), "utf8")).toBe("0");
      expect(fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      if (successor.exitCode === null) successor.kill();
      await successor.exited;
      await Promise.all([stdout, stderr]);
    }
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
    await Promise.all([new Response(holder.stdout).text(), new Response(holder.stderr).text()]);
  }
}, 30_000);

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

for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang", "--invalid-phase"]) test(`worker refuses ${flag} and its contained process ends`, async () => {
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

test("a drilldown publication failure still returns the production report and persists the worker cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-projection-failure-")); roots.push(root);
  const priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const target = path.join(root, "worktree-drilldown.sqlite");
  fs.mkdirSync(target);
  const marker = path.join(target, "keep");
  fs.writeFileSync(marker, "owned test obstruction");
  const worker = new WorktreeSweepWorker(); workers.push(worker);
  try {
    const report = await worker.run("dry-run");
    expect(report).not.toBeNull();
    expect(report!.errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "worktree-sweep-report.json"), "utf8"))).toEqual(report);
    expect(JSON.parse(fs.readFileSync(path.join(root, "worktree-sweep-cache.json"), "utf8")).version).toBe(1);
    expect(fs.readFileSync(marker, "utf8")).toBe("owned test obstruction");
    fs.unlinkSync(marker); fs.rmdirSync(target);
    await worker.run("dry-run");
    expect(readWorktreePage(null).at).toBeDefined();
  } finally {
    await worker.close();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  }
}, 30_000);


test("a restored full cache admits a new root within its persistent bound across real worker restarts",async()=>{
  const {root,worker}=fixture();
  fs.writeFileSync(path.join(root,"cache.json"),JSON.stringify({version:1,owner:"old-owner",rows:
    Array.from({length:SWEEP_CACHE_TREES},(_,i)=>[path.join(root,`past-${i}`),{key:"past-owner",at:1_000,candidates:[]}])}));
  await worker.run("dry-run");await worker.close();
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
  await launch().run("dry-run");
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
},30_000);


test("temp serializes with worktrees while disk observations coalesce on their own lease", async () => {
  const { root, worker } = fixture();
  const worktrees = worker.run("dry-run");
  const temp = worker.temp();
  expect(worker.temp()).toBe(temp);
  const disk = worker.diskPressure();
  expect(worker.diskPressure()).toBe(disk);
  expect((await worktrees).errors).toEqual([]);
  expect((await temp)?.removed).toEqual([]);
  expect((await disk).volumes.length).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(root, "requests"), "utf8").trim().split("\n").sort()).toEqual(["disk-pressure", "temp"]);
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


test("disk-pressure cache misses observe independently of a held sweep", async () => {
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
    expect("report" in result && result.report.volumes.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("disk-pressure\n");
  } finally {
    fs.writeFileSync(path.join(root, "release-worktree"), "release");
  }
  expect((await sweep).errors).toEqual([]);
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("disk-pressure\n");
}, 20_000);

test("memory readings coalesce on the disk reader's lease while a worktree sweep runs apart", async () => {
  const { root, worker } = fixture();
  const first = worker.memory();
  expect(worker.memory()).toBe(first);
  const disk = worker.diskPressure();
  expect(await first).toEqual({ ram: { usedBytes: 1, totalBytes: 2 }, swap: { usedBytes: 0, totalBytes: 0 }, tmp: null });
  expect((await disk).volumes.length).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("memory\ndisk-pressure\n");
}, 30_000);

for (const kind of ["temp", "disk-pressure", "memory"] as const) {
  for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang"]) test(`${kind} refuses ${flag} under the shared lease`, async () => {
    const { root, worker } = fixture(flag, 2_000);
    await worker.run("dry-run");
    await expect(kind === "temp" ? worker.temp() : kind === "memory" ? worker.memory() : worker.diskPressure()).rejects.toThrow();
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
    const { readMemoryReadingOffThread } = await import("./worktreeSweepWorker");
    const memory = await readMemoryReadingOffThread();
    expect(memory!.ram.totalBytes).toBeGreaterThan(0);
    expect(memory).toHaveProperty("tmp");
    expect(probe).not.toHaveBeenCalled();
    expect(processScans).toBe(0);
  } finally { scan.mockRestore(); probe.mockRestore(); }
}, 30_000);


test("the worker accepts coalesced phase frames before its bounded report", async () => {
  const { worker } = fixture("--phases");
  const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
  const { spyOn } = await import("bun:test");
  const operations = spyOn(viewerLoopMonitor, "run");
  try {
    expect((await worker.run("dry-run")).errors).toEqual([]);
    const names = operations.mock.calls.map(call => call[0]);
    expect(names).toContain("worktrees.discovery");
    expect(names).toContain("worktrees.candidate");
    expect(names).toContain("worktrees.accounting");
  } finally { operations.mockRestore(); }
});
test("attempt retirement coalesces through the owned worker", async () => {
  const { root, worker } = fixture();
  const request = worker.attemptTemp();
  expect(worker.attemptTemp()).toBe(request);
  expect(await request).toMatchObject({ checked: 0, removed: 0, removedBytes: 0 });
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("attempt-temp\n");
});

test("temporary data maintenance coalesces and carries its deadline through the owned worker", async () => {
  const { root, worker } = fixture(); const before = sweepMonotonicNow(), request = worker.maintenance();
  expect(worker.maintenance()).toBe(request); expect(await request).toMatchObject({ checked: 0, removed: 0 });
  expect(Number(fs.readFileSync(path.join(root, "maintenance-deadline"), "utf8"))).toBeGreaterThan(before);
  expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("maintenance\n");
});

test("an attempt tick finishes on its own lease while a worktree pass remains held", async () => {
  const { root, worker } = fixture("--hold-worktree", 10_000);
  await worker.run("dry-run");
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, (_event, file) => {
      if (String(file) === "busy-pid") { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("fixture did not acknowledge hold")); }, 5_000);
  });
  const worktree = worker.run("on");
  await ready;
  try {
    expect(await worker.attemptTemp()).toMatchObject({ checked: 0, removed: 0 });
    expect(fs.existsSync(path.join(root, "release-worktree"))).toBeFalse();
    expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("attempt-temp\n");
  } finally { fs.writeFileSync(path.join(root, "release-worktree"), "release"); await worktree; }
  expect(await worker.attemptTemp()).toMatchObject({ checked: 0, removed: 0 });
}, 20_000);

for (const flag of ["--malformed", "--wrong-kind", "--exit", "--oversize", "--hang"]) test(`attempt retirement refuses ${flag} and reaps its helper`, async () => {
  const { worker } = fixture(flag, 2000);
  await worker.run("dry-run");
  await expect(worker.attemptTemp()).rejects.toThrow();
  expect((await worker.run("dry-run"))!.errors).toEqual([]);
}, 20000);

test("a stale disk reading refreshes independently while an attempt tick is held", async () => {
  const { root, worker } = fixture("--hold-attempt");
  const observed = await worker.diskPressure();
  const tick = worker.attemptTemp();
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(root, "attempt-busy")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(fs.existsSync(path.join(root, "attempt-busy"))).toBeTrue();
    const base = Date.parse(observed.at);
    const clock = spyOn(Date, "now");
    try {
      clock.mockImplementation(() => base + 45_000);
      expect((await worker.diskPressure()).volumes.length).toBeGreaterThan(0);
      clock.mockImplementation(() => base + 95_000);
      expect((await worker.diskPressure()).volumes.length).toBeGreaterThan(0);
    } finally { clock.mockRestore(); }
    expect(fs.readFileSync(path.join(root, "requests"), "utf8")).toBe("disk-pressure\nattempt-temp\ndisk-pressure\ndisk-pressure\n");
  } finally { fs.writeFileSync(path.join(root, "release-attempt"), "release"); }
  expect(await tick).toMatchObject({ checked: 0, removed: 0 });
}, 20_000);


test("a full pass releases its helper heap before idle and queued work gets a new lease", async () => {
  const { root, worker } = fixture("--complete-pass");
  const first = worker.run("dry-run");
  const queued = worker.temp({ NODE_ENV: "test", LLV_TEMP_SWEEP: "off" });
  expect((await first).progress?.complete).toBeTrue();
  const retired = Number(fs.readFileSync(path.join(root, "pass-pids"), "utf8").trim());
  expect(() => process.kill(retired, 0)).toThrow();
  expect(await queued).toBeNull();
  const second = await worker.run("dry-run");
  expect(counters(second).allocationHits).toBe(0);
  const pids = fs.readFileSync(path.join(root, "pass-pids"), "utf8").trim().split("\n").map(Number);
  expect(pids).toHaveLength(2);
  expect(pids[0]).not.toBe(pids[1]);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);
