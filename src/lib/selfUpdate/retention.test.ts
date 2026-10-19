import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { retainReleases, type RetentionInputs, type RetentionPorts } from "./retention";
import { finishTreeTrash, removeTreeViaTrash, scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { LauncherRecord } from "./launcher";
import { runGit } from "./git";
import { RetentionWorker } from "./retentionWorker";

const DAY = 86_400_000;
const LOOP_PROBE_INTERVAL_MS = 10;
const missedLoopTimeMs = (workerTicks: number) => Math.max(0, workerTicks - 1) * LOOP_PROBE_INTERVAL_MS;
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const EMPTY: ProcessScan = { ownNamespace: "mnt:[fixture]", processes: [] };
function fixture(count = 8) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-test-"))); roots.push(root);
  const releases = path.join(root, "releases"); fs.mkdirSync(releases);
  const dirs: string[] = []; const shas: string[] = [];
  const now = Date.UTC(2030, 0, 1);
  for (let i = 0; i < count; i++) {
    const sha = (i + 1).toString(16).padStart(12, "0") + "a".repeat(28); shas.push(sha);
    const dir = path.join(releases, sha.slice(0, 12)); dirs.push(dir);
    for (const file of [".next/DELEGATUS_RELEASE_READY", ".next/BUILD_ID", ".next/cache/webpack/cache", ".next/cache/fetch-cache/runtime", ".next/cache/images/runtime", ".next/server/app.js", "node_modules/dep/index.js", "dist/server.js"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), file.endsWith("READY") ? sha : "fixture data");
    }
    for (const file of [dir, path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, new Date(now - (count - i + 2) * DAY), new Date(now - (count - i + 2) * DAY));
  }
  const processEntry = { state: "healthy" as const, pid: null, startIdentity: null, startedAt: null, revision: null, error: null, requestId: null };
  const record: LauncherRecord = { version: 1, checkout: root, releasesDir: releases, releasePointer: path.join(root, "release.json"), requestFile: path.join(root, "request.json"),
    launcher: { pid: 42, startIdentity: "fixture" }, web: { ...processEntry }, runtimeHost: { ...processEntry }, port: 0, socket: path.join(root, "host.sock"), updatedAt: "" };
  fs.writeFileSync(record.releasePointer, JSON.stringify({ dir: dirs[0], sha: shas[0] }));
  const commands: string[][] = [];
  const locked = new Set<string>();
  const git: NonNullable<RetentionPorts["git"]> = async (args, cwd) => {
    commands.push(args);
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, stderr: "", stdout: dirs.filter(dir => fs.existsSync(dir)).map(dir =>
      `worktree ${dir}\0HEAD ${shas[dirs.indexOf(dir)]}\0${locked.has(dir) ? "locked fixture\0" : ""}\0`).join("") };
    if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: shas[dirs.indexOf(cwd)]! };
    if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
    if (args[0] === "ls-files") return { code: 0, stderr: "", stdout: "H fixture.txt\0" };
    if (args[0] === "for-each-ref") return { code: 0, stderr: "", stdout: "refs/heads/main\n" };
    if (args[0] === "worktree" && args[1] === "remove") { fs.rmSync(args.at(-1)!, { recursive: true, force: true }); return { code: 0, stderr: "", stdout: "" }; }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  };
  const inputs: RetentionInputs = {};
  const ports: RetentionPorts = { git, scan: () => EMPTY, mountPoints: () => [], now: () => now, env: {},
    lockHead: () => () => {}, reportFile: path.join(root, "state/retention.json") };
  return { root, dirs, shas, record, inputs, ports, commands, locked, now, run: () => retainReleases(record, inputs, ports) };
}
const exists = fs.existsSync;

test("keep decisions over 87 releases use one inventory; destructive steps use fresh helper scans", async () => {
  const h = fixture(87);
  h.inputs.inFlight = [...h.dirs];
  let scans = 0;
  h.ports.scan = () => { scans++; return EMPTY; };
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(report.kept.map(row => row.dir)).toEqual(h.dirs);
  expect(scans).toBe(1);
});

test("the loop probe maps independently observed missed 10 ms turns to elapsed time", () => {
  expect(missedLoopTimeMs(1)).toBe(0);
  expect(missedLoopTimeMs(6)).toBe(50);
  expect(missedLoopTimeMs(7)).toBe(60);
});

test("the loop stays within 50 ms while counting 87 retained release trees", async () => {
  const h = fixture(87);
  h.inputs.inFlight = [...h.dirs];
  for (const dir of h.dirs) {
    const tree = path.join(dir, "node_modules/fixture");
    fs.mkdirSync(tree);
    for (let i = 0; i < 128; i++) fs.writeFileSync(path.join(tree, `${i}.js`), "fixture");
  }
  const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const ticks = new Int32Array(heartbeat);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const pulses = new Int32Array(workerData);
    setInterval(() => Atomics.add(pulses, 0, 1), 10);
    parentPort.postMessage("ready");
  `, { eval: true, workerData: heartbeat });
  let heartbeatError: unknown;
  worker.on("error", error => { heartbeatError = error; });
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTicks = 0;
  let maxBlockedMs = 0;
  let maxObservedGapMs = 0;
  let last = performance.now();
  let samples = 0;
  let nextSample: (() => void) | undefined;
  const sample = () => new Promise<void>(resolve => { nextSample = resolve; });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", value => value === "ready" ? resolve() : reject(new Error("loop probe heartbeat did not become ready")));
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`loop probe heartbeat exited before ready (${code})`)));
    });
    lastTicks = Atomics.load(ticks, 0);
    timer = setInterval(() => {
      const at = performance.now();
      maxObservedGapMs = Math.max(maxObservedGapMs, at - last);
      last = at;
      const currentTicks = Atomics.load(ticks, 0);
      maxBlockedMs = Math.max(maxBlockedMs, missedLoopTimeMs(currentTicks - lastTicks));
      lastTicks = currentTicks;
      samples++;
      const resolve = nextSample;
      nextSample = undefined;
      resolve?.();
    }, LOOP_PROBE_INTERVAL_MS);
    await sample();
    maxBlockedMs = 0;
    maxObservedGapMs = 0;
    const before = samples;
    const report = await h.run();
    const during = samples - before;
    // Observe the timer overdue at completion before deciding the pass was responsive.
    await sample();
    expect(report.errors).toEqual([]);
    expect(report.kept).toHaveLength(87);
    expect(report.kept.every(row => row.bytes > 0)).toBeTrue();
    expect(heartbeatError).toBeUndefined();
    console.info("[retention fixture]", JSON.stringify({ releases: 87, maxBlockedMs, maxObservedGapMs, timerSamplesDuringPass: during }));
    expect(maxBlockedMs).toBeLessThanOrEqual(50);
    expect(during).toBeGreaterThan(0);
  } finally {
    if (timer) clearInterval(timer);
    await worker.terminate();
  }
}, 30_000);

test("the first pass removes every unprotected old release and reclaims retained caches", async () => {
  const h = fixture(); const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.dir)).toEqual(h.dirs.slice(1, 5));
  expect(report.reclaimedCacheBytes).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(h.ports.reportFile!, "utf8"))).toEqual(report);
  expect(h.commands.some(args => args.includes("prune"))).toBeFalse();
});

test.each(["active", "web", "runtimeHost", "launcher", "apply-rollback", "auto-rollback", "running", "failed", "apply-target", "locked"])("%s release is never removed", async kind => {
  const h = fixture(); const dir = h.dirs[1]!;
  if (kind === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir }));
  if (kind === "web" || kind === "runtimeHost" || kind === "launcher") h.record[kind].revision = h.shas[1]!.slice(0, 16);
  if (kind.endsWith("rollback")) h.inputs.rollbackPointers = [JSON.stringify({ dir })];
  if (["running", "failed", "apply-target"].includes(kind)) h.inputs.inFlight = [dir];
  if (kind === "locked") h.locked.add(dir);
  const report = await h.run();
  expect(exists(dir)).toBeTrue();
  expect(report.removed.some(row => row.dir === dir)).toBeFalse();
  expect(report.kept.some(row => row.dir === dir)).toBeTrue();
});

test.each(["cwd", "argv", "env", "maps"])("a release named by a running process through %s is kept", async kind => {
  const h = fixture(4); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" }; const dir = h.dirs[1]!;
  if (kind === "maps") h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(dir, "mapped.so")] }] });
  else {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...(kind === "argv" ? [path.join(dir, "script.ts")] : [])], {
      cwd: kind === "cwd" ? dir : h.root,
      env: { PATH: process.env.PATH, NODE_ENV: "test", ...(kind === "env" ? { CUSTOM_VENDOR: `prefix:${dir}/vendor:suffix` } : {}) }, stdio: "ignore",
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
    h.ports.scan = () => { const scan = scanProcesses(); return { ...scan, processes: scan.processes.filter(proc => proc.pid === child.pid) }; };
  }
  const report = await h.run();
  expect(exists(dir)).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir, reason: "process" }));
}, 30_000);

test("the process scan is read again before each removal", async () => {
  const h = fixture(); let scans = 0;
  h.ports.scan = () => ++scans === 1 ? EMPTY : { ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [h.dirs[1]!] }] };
  const report = await h.run();
  expect(exists(h.dirs[1]!)).toBeTrue();
  expect(report.removed.some(row => row.dir === h.dirs[1])).toBeFalse();
});

test("a real process started during the final Git check protects its release", async () => {
  const h = fixture(4);
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = scanProcesses;
  const run = h.ports.git!;
  const target = h.dirs[1]!;
  let refChecks = 0;
  let started = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "for-each-ref" && args[2] === h.shas[1] && ++refChecks === 2) {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        cwd: target, env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR,
          LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL },
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
        child.once("exit", () => reject(new Error("holder exited before retention finished")));
      });
      started = true;
    }
    return result;
  };
  const report = await h.run();
  expect(started).toBeTrue();
  expect(report.errors).toEqual([]);
  expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: target, reason: "changed" }));
}, 30_000);

test("a process acquired after an earlier removal still protects a later release in the same pass", async () => {
  const h = fixture(5);
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = scanProcesses;
  const run = h.ports.git!;
  const first = h.dirs[1]!;
  const target = h.dirs[2]!;
  let started = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === first) {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        cwd: target, env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR,
          LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL },
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
        child.once("exit", () => reject(new Error("holder exited before retention finished")));
      });
      started = true;
    }
    return result;
  };
  const report = await h.run();
  expect(started).toBeTrue();
  expect(report.errors).toEqual([]);
  expect(report.removed.some(row => row.dir === first)).toBeTrue();
  expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(children.at(-1)!.exitCode).toBeNull();
  expect(children.at(-1)!.signalCode).toBeNull();
}, 30_000);

test("recent and newest-K releases are kept; K follows LLV_SELF_UPDATE_KEEP_RELEASES", async () => {
  const h = fixture(); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  fs.utimesSync(path.join(h.dirs[1]!, ".next/BUILD_ID"), new Date(h.now), new Date(h.now));
  const report = await h.run();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "recent" }));
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs.at(-1), reason: "newest" }));
  expect(report.removed).toHaveLength(5);
});

test.each(["pointer", "listing", "scan", "launcher"])("an unreadable %s removes nothing", async kind => {
  const h = fixture();
  if (kind === "pointer") fs.writeFileSync(h.record.releasePointer, "invalid");
  if (kind === "listing") h.ports.git = async () => ({ code: 1, stderr: "unavailable", stdout: "" });
  if (kind === "scan") h.ports.scan = () => ({ ownNamespace: null, processes: [] });
  if (kind === "launcher") h.ports.current = () => { throw new Error("cannot read launcher record"); };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed).toEqual([]);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test("only registered release worktrees and npm containers are candidates", async () => {
  const h = fixture();
  const extra = ["notes", "eeeeeeeeeeee", "npm-1.2.3"];
  for (const name of extra) fs.mkdirSync(path.join(h.record.releasesDir, name));
  const outside = path.join(h.root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.record.releasesDir, "ffffffffffff"));
  const report = await h.run();
  for (const name of extra) expect(exists(path.join(h.record.releasesDir, name))).toBeTrue();
  expect(exists(outside)).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: path.join(h.record.releasesDir, "eeeeeeeeeeee"), reason: "unregistered" }));
});

test("cache reclamation removes only .next/cache/webpack", async () => {
  const h = fixture(); await h.run();
  const dir = h.dirs[0]!;
  expect(exists(path.join(dir, ".next/cache/webpack"))).toBeFalse();
  for (const file of [".next/BUILD_ID", ".next/server/app.js", ".next/cache/fetch-cache/runtime", ".next/cache/images/runtime", "node_modules/dep/index.js", "dist/server.js"]) expect(exists(path.join(dir, file))).toBeTrue();
});

test("webpack cache reclamation preserves a dirty nested Git checkout", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache/webpack/operator-project");
  fs.mkdirSync(cache, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: cache, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(cache, "source.txt"), "committed source\n");
  git(["add", "source.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "source"]);
  fs.writeFileSync(path.join(cache, "source.txt"), "unique operator edits\n");
  fs.writeFileSync(path.join(cache, "untracked.txt"), "unique operator file\n");
  await h.run();
  expect(fs.readFileSync(path.join(cache, "source.txt"), "utf8")).toBe("unique operator edits\n");
  expect(fs.readFileSync(path.join(cache, "untracked.txt"), "utf8")).toBe("unique operator file\n");
});

test("webpack cache replay preserves a nested Git checkout from an older trash journal", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache/webpack");
  const nested = path.join(cache, "operator-project"); fs.mkdirSync(nested, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: nested, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]); fs.writeFileSync(path.join(nested, "source.txt"), "committed source\n");
  git(["add", "source.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "source"]);
  fs.writeFileSync(path.join(nested, "source.txt"), "unique edits\n");
  fs.writeFileSync(path.join(nested, "untracked.txt"), "unique file\n");
  const journal = path.join(path.dirname(h.ports.reportFile!), "cache-trash-legacy.json");
  await expect(removeTreeViaTrash(cache, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  const trash = JSON.parse(fs.readFileSync(journal, "utf8")).trash as string;
  const report = await h.run();
  expect(fs.existsSync(trash)).toBeTrue();
  expect(fs.readFileSync(path.join(trash, "operator-project/source.txt"), "utf8")).toBe("unique edits\n");
  expect(fs.readFileSync(path.join(trash, "operator-project/untracked.txt"), "utf8")).toBe("unique file\n");
  expect(report.errors).toEqual([]);
});

test.each(["missing", "mismatch"])("a release with a %s ready marker keeps its build cache", async kind => {
  const h = fixture(); const marker = path.join(h.dirs[0]!, ".next/DELEGATUS_RELEASE_READY");
  if (kind === "missing") fs.unlinkSync(marker); else fs.writeFileSync(marker, "different");
  await h.run(); expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack"))).toBeTrue();
});

test("a mount point under a release keeps it and its build cache", async () => {
  const h = fixture(); h.ports.mountPoints = dir => dir === h.dirs[1] ? [path.join(dir, "mounted")] : [];
  const report = await h.run();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "mount-boundary" }));
  expect(exists(path.join(h.dirs[1]!, ".next/cache/webpack"))).toBeTrue();
});

test("package containers follow the same protected set", async () => {
  const h = fixture(0); h.record.checkout = null;
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-1.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: path.join(dirs[0]!, "node_modules/delegatus-cli") }));
  h.inputs.rollbackPackage = path.join(dirs[1]!, "node_modules/delegatus-cli");
  const report = await h.run();
  expect(exists(dirs[0]!)).toBeTrue(); expect(exists(dirs[1]!)).toBeTrue();
  expect(report.removed.length).toBeGreaterThan(0);
});

function packageContainerFixture() {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 4 }, (_, i) => path.join(h.record.releasesDir, `npm-3.0.${i}`));
  for (const [i, dir] of dirs.entries()) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const date = new Date(h.now - (5 - i) * DAY);
    fs.utimesSync(dir, date, date); fs.utimesSync(path.join(dir, "package.json"), date, date);
  }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1]!;
  return { ...h, dirs, target: dirs[2]! };
}

function dirtyNestedRepository(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "committed bytes\n");
  git(["add", "tracked.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "unique modified bytes\n");
  fs.writeFileSync(path.join(directory, "untracked.txt"), "unique untracked bytes\n");
}

test("package retention preserves a dirty nested Git checkout", async () => {
  const h = packageContainerFixture();
  const nested = path.join(h.target, "workspace"); dirtyNestedRepository(nested);
  const report = await h.run();
  expect(fs.existsSync(nested)).toBeTrue();
  expect(fs.readFileSync(path.join(nested, "tracked.txt"), "utf8")).toBe("unique modified bytes\n");
  expect(fs.readFileSync(path.join(nested, "untracked.txt"), "utf8")).toBe("unique untracked bytes\n");
  expect(report.removed.some(row => row.dir === h.target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: "git-checkout" }));
});

test("package trash replay preserves a dirty nested Git checkout", async () => {
  const h = packageContainerFixture();
  const nested = path.join(h.target, "workspace"); dirtyNestedRepository(nested);
  const journal = path.join(path.dirname(h.ports.reportFile!), "package-trash-legacy.json");
  await expect(removeTreeViaTrash(h.target, { journal, held: () => false,
    remove: async () => { throw new Error("interrupted package removal"); } })).rejects.toThrow("interrupted package removal");
  const row = JSON.parse(fs.readFileSync(journal, "utf8")) as { trash: string };
  const report = await h.run();
  expect(fs.existsSync(row.trash)).toBeTrue();
  expect(fs.readFileSync(path.join(row.trash, "workspace/tracked.txt"), "utf8")).toBe("unique modified bytes\n");
  expect(fs.readFileSync(path.join(row.trash, "workspace/untracked.txt"), "utf8")).toBe("unique untracked bytes\n");
  expect(report.removed.some(entry => entry.dir === h.target)).toBeFalse();
});

test("one failed removal is reported and the next candidate is still reclaimed", async () => {
  const h = fixture(); const run = h.ports.git!;
  h.ports.git = async (args, cwd) => args[1] === "remove" && args.at(-1) === h.dirs[1]
    ? { code: 1, stdout: "", stderr: "fixture removal refused" } : run(args, cwd);
  const report = await h.run();
  expect(report.errors).toHaveLength(1);
  expect(exists(h.dirs[1]!)).toBeTrue(); expect(exists(h.dirs[2]!)).toBeFalse();
  expect(exists(path.join(h.dirs[1]!, ".next/DELEGATUS_RELEASE_READY"))).toBeFalse();
});

test("retention never prunes other registrations", async () => {
  const h = fixture(0); const checkout = path.join(h.root, "repo"); fs.mkdirSync(checkout);
  const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" }); expect(result.status).toBe(0); return result.stdout; };
  git(["init", "-q"]); git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  const pipeline = path.join(h.root, "pipeline"); git(["worktree", "add", "--detach", pipeline]);
  fs.renameSync(pipeline, pipeline + "-away"); h.record.checkout = checkout;
  fs.unlinkSync(h.record.releasePointer); h.ports.git = runGit;
  await h.run(); expect(git(["worktree", "list", "--porcelain"])).toContain(pipeline);
});

function realReleaseFixture() {
  const h = fixture(0); const checkout = path.join(h.root, "source"); fs.mkdirSync(checkout);
  const git = (args: string[], cwd = checkout) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(checkout, ".gitignore"), ".next/\n");
  fs.writeFileSync(path.join(checkout, "source.txt"), "first\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "first"]);
  const first = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(checkout, "next.txt"), "second\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "second"]);
  const second = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(checkout, "third.txt"), "third\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "third"]);
  const third = git(["rev-parse", "HEAD"]);
  const active = path.join(h.record.releasesDir, first.slice(0, 12));
  const candidate = path.join(h.record.releasesDir, second.slice(0, 12));
  const newest = path.join(h.record.releasesDir, third.slice(0, 12));
  git(["worktree", "add", "--detach", active, first]); git(["worktree", "add", "--detach", candidate, second]); git(["worktree", "add", "--detach", newest, third]);
  for (const [dir, sha, age] of [[active, first, 3], [candidate, second, 4], [newest, third, 2]] as const) {
    fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next/DELEGATUS_RELEASE_READY"), sha);
    fs.writeFileSync(path.join(dir, ".next/BUILD_ID"), "fixture");
    const date = new Date(h.now - age * DAY);
    for (const file of [dir, path.join(dir, ".next"), path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, date, date);
  }
  h.record.checkout = checkout;
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: active, sha: first }));
  h.ports.git = runGit;
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.mountPoints = () => [];
  return { ...h, active, candidate, newest, git };
}

test.each(["tracked-edit", "untracked-file", "unpublished-commit"])("release retention preserves %s", async kind => {
  const h = realReleaseFixture();
  if (kind === "tracked-edit") fs.writeFileSync(path.join(h.candidate, "source.txt"), "unique operator edit\n");
  if (kind === "untracked-file") fs.writeFileSync(path.join(h.candidate, "unique.txt"), "preserve me\n");
  if (kind === "unpublished-commit") {
    fs.writeFileSync(path.join(h.candidate, "private.txt"), "unpublished\n"); h.git(["add", "private.txt"], h.candidate);
    h.git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "unpublished"], h.candidate);
  }
  const old = new Date(h.now - 4 * DAY);
  for (const file of [h.candidate, path.join(h.candidate, ".next/DELEGATUS_RELEASE_READY"), path.join(h.candidate, ".next/BUILD_ID")]) fs.utimesSync(file, old, old);
  const report = await h.run();
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
  expect(fs.existsSync(h.candidate)).toBeTrue();
  if (kind === "tracked-edit") expect(fs.readFileSync(path.join(h.candidate, "source.txt"), "utf8")).toBe("unique operator edit\n");
  if (kind === "untracked-file") expect(fs.readFileSync(path.join(h.candidate, "unique.txt"), "utf8")).toBe("preserve me\n");
  if (kind === "unpublished-commit") expect(h.git(["status", "--porcelain"], h.candidate)).toBe("");
});

test("a late release edit is refused by Git's final removal guard", async () => {
  const h = realReleaseFixture(); let changed = false; const git = h.ports.git!;
  h.ports.git = async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === h.candidate) {
      changed = true; fs.writeFileSync(path.join(h.candidate, "source.txt"), "late operator edit\n");
    }
    return git(args, cwd);
  };
  const report = await h.run();
  expect(changed).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(fs.readFileSync(path.join(h.candidate, "source.txt"), "utf8")).toBe("late operator edit\n");
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test("an unpublished commit created during the last ref query protects its release", async () => {
  const h = realReleaseFixture(); h.ports.lockHead = undefined;
  const run = h.ports.git!; let committed = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (!committed && args[0] === "for-each-ref" && args[2] === h.git(["rev-parse", "HEAD"], h.candidate)) {
      committed = true;
      fs.writeFileSync(path.join(h.candidate, "late-commit.txt"), "unique commit\n");
      h.git(["add", "late-commit.txt"], h.candidate);
      h.git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "late local commit"], h.candidate);
    }
    return result;
  };
  const report = await h.run();
  expect(committed).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(fs.readFileSync(path.join(h.candidate, "late-commit.txt"), "utf8")).toBe("unique commit\n");
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test("a late .next symlink cannot redirect ready-marker deletion into an active release", async () => {
  const h = realReleaseFixture(); const run = h.ports.git!; let replaced = false; let finalHeadReads = 0;
  const activeMarker = path.join(h.active, ".next/DELEGATUS_RELEASE_READY");
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (!replaced && args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD" && cwd === h.candidate
      && ++finalHeadReads === 2) {
      replaced = true;
      fs.rmSync(path.join(h.candidate, ".next"), { recursive: true, force: true });
      fs.symlinkSync(path.join(h.active, ".next"), path.join(h.candidate, ".next"), "dir");
    }
    return result;
  };
  const report = await h.run();
  expect(replaced).toBeTrue();
  expect(fs.readFileSync(activeMarker, "utf8")).toBe(h.git(["rev-parse", "HEAD"], h.active));
  expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test.each(["active", "rollback", "process", "mount"] as const)("late %s protection acquired during the final ref check keeps the release", async kind => {
  const h = fixture(4); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const target = h.dirs[1]!; const sha = h.shas[1]!; const run = h.ports.git!; let acquired = false; let refChecks = 0; let mounted = false;
  h.ports.mountPoints = directory => mounted && directory === target ? [path.join(target, "mounted")] : [];
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "for-each-ref" && args[2] === sha && ++refChecks === 2) {
      acquired = true;
      if (kind === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
      if (kind === "rollback") h.inputs.rollbackPointers = [JSON.stringify({ dir: target })];
      if (kind === "process") h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [target] }] });
      if (kind === "mount") mounted = true;
    }
    return result;
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(fs.existsSync(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
});

test("a clean disposable release still expires", async () => {
  const h = realReleaseFixture(); const report = await h.run();
  expect(report.removed.map(row => row.dir)).toContain(h.candidate);
  expect(fs.existsSync(h.active)).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeFalse();
});

test("ten successive applies stay bounded by protected plus newest K", async () => {
  const h = fixture(0);
  for (let i = 0; i < 10; i++) {
    const sha = (i + 1).toString(16).padStart(12, "0") + "b".repeat(28);
    const dir = path.join(h.record.releasesDir, sha.slice(0, 12));
    h.dirs.push(dir); h.shas.push(sha); fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next/DELEGATUS_RELEASE_READY"), sha); fs.writeFileSync(path.join(dir, ".next/BUILD_ID"), "fixture");
    for (const file of [dir, path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, 1000 + i, 1000 + i);
    h.inputs.rollbackPointers = i ? [JSON.stringify({ dir: h.dirs[i - 1] })] : [];
    fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir }));
    const report = await h.run(); expect(report.errors).toEqual([]);
    expect(exists(dir)).toBeTrue(); if (i) expect(exists(h.dirs[i - 1]!)).toBeTrue();
    expect(h.dirs.filter(exists).length).toBeLessThanOrEqual(5);
  }
  expect(h.dirs.filter(exists).length).toBe(5);
});

test("a holder acquired after the cache rename restores webpack", async () => {
  const h = fixture(); const dir = h.dirs[0]!;
  h.ports.scan = () => {
    const trash = fs.readdirSync(path.join(dir, ".next/cache")).find(name => name.startsWith(".delegatus-trash-"));
    return trash ? { ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(dir, ".next/cache", trash, "cache")] }] } : EMPTY;
  };
  const report = await h.run(); expect(report.errors).toEqual([]);
  expect(exists(path.join(dir, ".next/cache/webpack/cache"))).toBeTrue();
});

test("an interrupted cache removal leaves a trash name and resumes next pass", async () => {
  const h = fixture(); h.ports.removeTree = async () => { throw new Error("interrupted"); };
  const report = await h.run(); expect(report.errors.length).toBeGreaterThan(0);
  expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack"))).toBeFalse();
  expect(fs.readdirSync(path.join(h.dirs[0]!, ".next/cache")).some(name => name.startsWith(".delegatus-trash-"))).toBeTrue();
  h.ports.removeTree = undefined; const resumed = await h.run(); expect(resumed.errors).toEqual([]);
  expect(fs.readdirSync(path.join(h.dirs[0]!, ".next/cache")).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  expect(exists(path.join(h.dirs[0]!, ".next/cache/fetch-cache/runtime"))).toBeTrue();
});

test("a cache symlink preserves the outside directory", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache");
  fs.renameSync(cache, cache + "-outside"); fs.symlinkSync(cache + "-outside", cache);
  await h.run(); expect(exists(path.join(cache + "-outside", "webpack/cache"))).toBeTrue();
});


test("a release completed during the final listing keeps its recent build", async () => {
  const h = fixture(); const run = h.ports.git!; let listings = 0;
  h.ports.git = async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list" && ++listings === 2)
      fs.utimesSync(path.join(h.dirs[1]!, ".next/BUILD_ID"), new Date(h.now), new Date(h.now));
    return run(args, cwd);
  };
  const report = await h.run();
  expect(report.removed.some(row => row.dir === h.dirs[1])).toBeFalse();
  expect(exists(h.dirs[1]!)).toBeTrue();
});


test("a process using an aliased argv path keeps the physical release", async () => {
  const h = fixture(); const alias = path.join(h.root, "release-alias"); fs.symlinkSync(h.dirs[1]!, alias);
  h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(alias, "future-script.ts")] }] });
  const report = await h.run(); expect(report.errors).toEqual([]);
  expect(exists(h.dirs[1]!)).toBeTrue();
});


test.each([false, true])("package trash resumes safely with a new active pointer=%s", async reactivated => {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-1.0.${i}`));
  for (const dir of dirs) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1);
  }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1];
  h.ports.removeTree = async () => { throw new Error("interrupted package removal"); };
  const interrupted = await h.run(); expect(interrupted.errors.length).toBeGreaterThan(0);
  const journals = fs.readdirSync(path.dirname(h.ports.reportFile!)).filter(name => name.startsWith("package-trash-"));
  expect(journals.length).toBeGreaterThan(0);
  const row = JSON.parse(fs.readFileSync(path.join(path.dirname(h.ports.reportFile!), journals[0]!), "utf8"));
  expect(exists(row.directory)).toBeFalse(); expect(exists(row.trash)).toBeTrue();
  if (reactivated) fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: row.directory }));
  h.ports.removeTree = undefined; const resumed = await h.run(); expect(resumed.errors).toEqual([]);
  expect(exists(row.trash)).toBe(reactivated);
  if (!reactivated) expect(exists(dirs[0]!)).toBeTrue();
  expect(exists(dirs[1]!)).toBeTrue();
  if (reactivated) expect(resumed.kept).toContainEqual(expect.objectContaining({ dir: row.directory, reason: "active" }));
  else expect(resumed.removed.some(removed => removed.dir === row.directory)).toBeTrue();
});

test.each(["active", "rollback", "in-flight"])("package activation after rename preserves the %s container", async protection => {
  const h = fixture(0); h.record.checkout = null;
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-2.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1];
  const target = dirs[2]!; let acquired = false;
  h.ports.scan = () => {
    const renamed = fs.readdirSync(h.record.releasesDir).find(name => name.startsWith(".delegatus-trash-npm-2.0.2-"));
    if (renamed && !acquired) {
      acquired = true;
      if (protection === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
      if (protection === "rollback") h.inputs.rollbackPackage = target;
      if (protection === "in-flight") h.inputs.inFlight = [target];
    }
    return EMPTY;
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(exists(target)).toBeTrue();
  expect(exists(path.join(target, "package.json"))).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: target, reason: protection }));
});


test("a mount appearing above webpack during the HEAD read keeps the cache", async () => {
  const h = fixture(); const run = h.ports.git!; let mounted = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "rev-parse" && cwd === h.dirs[0]) mounted = true;
    return result;
  };
  h.ports.mountPoints = dir => mounted && dir === h.dirs[0] ? [path.join(dir, ".next")] : [];
  await h.run(); expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack/cache"))).toBeTrue();
});

// Fail before any mutation: an uncertain inspection must stop the whole pass.
test.each(["scan-error", "scan-partial", "bytes-error", "helper-timeout"])("retention fails closed on %s", async failure => {
  const h = fixture();
  h.ports.scan = undefined;
  Object.assign(h.ports, { inspection: {
    scan: async () => {
      if (failure === "scan-error") throw new Error("scan unavailable");
      if (failure === "scan-partial") return { ...EMPTY, complete: false };
      return { ...EMPTY, complete: true };
    },
    bytes: async () => { throw new Error(failure === "helper-timeout" ? "helper deadline" : "bytes unavailable"); },
    close: async () => {},
  } });
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed).toEqual([]);
  expect(report.reclaimedCacheBytes).toBe(0);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test("a failed fresh safety scan aborts remaining candidates", async () => {
  const h = fixture(); let scans = 0;
  h.ports.scan = () => { if (++scans > 1) throw new Error("safety scan failed"); return EMPTY; };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(scans).toBe(2);
  expect(report.removed).toEqual([]);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test.each(["exit", "hang", "malformed", "truncated", "oversize", "partial", "wrong-kind"])("a real %s helper removes nothing and leaves no helper behind", async failure => {
  const h = fixture(); h.ports.scan = undefined;
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, failure] }, 2_000);
  h.ports.inspection = worker;
  try {
    await worker.bytes(h.root); // ready, then fail the inventory request
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8"));
    const report = await h.run();
    expect(report.errors.length).toBeGreaterThan(0); expect(report.removed).toEqual([]);
    expect(report.reclaimedCacheBytes).toBe(0);
    for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 15_000);

test.each(["hold", "throw", "write", "allow"])("trash removal awaits its safety observation and revalidates: %s", async outcome => {
  const h = fixture(); const target = path.join(h.root, "disposable"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "file"), "original");
  const journal = path.join(h.root, "trash.json"); let resume!: () => void; let entered!: (trash: string) => void;
  const ready = new Promise<string>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { resume = resolve; });
  const removal = removeTreeViaTrash(target, { journal, held: async trash => {
    entered(trash); await proceed;
    if (outcome === "throw") throw new Error("inspection unavailable");
    return outcome === "hold";
  } });
  const trash = await ready;
  if (outcome === "write") fs.writeFileSync(path.join(trash, "late"), "preserve");
  resume();
  if (outcome === "throw") await expect(removal).rejects.toThrow("inspection unavailable");
  else expect(await removal).toBe(outcome === "allow");
  expect(exists(target)).toBe(outcome !== "allow");
  if (outcome === "write") expect(fs.readFileSync(path.join(target, "late"), "utf8")).toBe("preserve");
});

test.each(["hold", "throw", "write", "allow"])("trash replay awaits its safety observation and revalidates: %s", async outcome => {
  const h = fixture(); const target = path.join(h.root, "disposable"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "file"), "original");
  const journal = path.join(h.root, "trash.json");
  await expect(removeTreeViaTrash(target, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  let resume!: () => void; let entered!: (trash: string) => void;
  const ready = new Promise<string>(resolve => { entered = resolve; }); const proceed = new Promise<void>(resolve => { resume = resolve; });
  const replay = finishTreeTrash(journal, async trash => {
    entered(trash); await proceed;
    if (outcome === "throw") throw new Error("inspection unavailable");
    return outcome === "hold";
  });
  const trash = await ready;
  if (outcome === "write") fs.writeFileSync(path.join(trash, "late"), "preserve");
  resume();
  if (outcome === "throw") await expect(replay).rejects.toThrow("inspection unavailable");
  else expect(await replay).toBe(outcome === "allow");
  expect(exists(trash)).toBe(outcome !== "allow");
  if (outcome === "write") expect(fs.readFileSync(path.join(trash, "late"), "utf8")).toBe("preserve");
});

test.each(["throw", "partial"])("a %s safety scan after package rename restores the release and aborts the pass", async failure => {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 4 }, (_, i) => path.join(h.record.releasesDir, `npm-3.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] }));
  let failed = false;
  h.ports.scan = () => {
    if (fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))) {
      failed = true;
      if (failure === "throw") throw new Error("safety scan unavailable after rename");
      return { ...EMPTY, complete: false };
    }
    return EMPTY;
  };
  const report = await h.run();
  expect(failed).toBeTrue(); expect(report.errors.length).toBeGreaterThan(0); expect(report.removed).toEqual([]);
  for (const dir of dirs) expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe("{}");
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
});

test.each(["active", "rollback", "serving", "in-flight"])("fresh %s authority is read after awaiting the helper safety scan", async protection => {
  const h = fixture(4); const target = h.dirs[1]!;
  h.inputs.inFlight = [h.dirs[0]!]; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" }; h.ports.scan = undefined;
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs });
  let scans = 0; let acquired = false;
  h.ports.inspection = {
    scan: async () => {
      await Promise.resolve();
      if (++scans === 2) {
        acquired = true;
        if (protection === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
        if (protection === "rollback") h.inputs.rollbackPointers = [JSON.stringify({ dir: target })];
        if (protection === "serving") h.record.web.revision = h.shas[1]!;
        if (protection === "in-flight") h.inputs.inFlight = [h.dirs[0]!, target];
      }
      return { ...EMPTY, complete: true };
    }, bytes: async () => 0, close: async () => {},
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(report.errors).toEqual([]); expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
});

test.skipIf(process.platform !== "linux")("the leased helper rescans before later removals after an earlier release disappears", async () => {
  const h = fixture(5); const target = h.dirs[2]!; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = undefined; h.inputs.inFlight = [h.dirs[0]!];
  const proc = path.join(h.root, "proc"); fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, "inspect"] });
  h.ports.inspection = worker;
  const run = h.ports.git!; let acquired = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === h.dirs[1]) {
      acquired = true;
      const base = path.join(proc, "123"); fs.mkdirSync(path.join(base, "ns"), { recursive: true }); fs.mkdirSync(path.join(base, "fd"));
      fs.symlinkSync("mnt:[fixture]", path.join(base, "ns/mnt"));
      fs.writeFileSync(path.join(base, "stat"), "123 (fixture) S " + "0 ".repeat(20));
      for (const link of ["cwd", "root", "exe"]) fs.symlinkSync(target, path.join(base, link));
      for (const file of ["cmdline", "environ", "maps"]) fs.writeFileSync(path.join(base, file), "");
    }
    return result;
  };
  try {
    await worker.bytes(h.root);
    const report = await h.run();
    expect(acquired).toBeTrue(); expect(report.errors).toEqual([]);
    expect(report.removed.some(row => row.dir === h.dirs[1])).toBeTrue();
    expect(report.removed.some(row => row.dir === target)).toBeFalse(); expect(exists(target)).toBeTrue();
    expect(fs.readFileSync(path.join(h.root, "requests"), "utf8").split("\n").filter(kind => kind === "scan").length).toBeGreaterThan(2);
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 30_000);

test("an inspection failure after a completed removal stops all remaining destructive work", async () => {
  const h = fixture(5); h.inputs.inFlight = [h.dirs[0]!]; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const run = h.ports.git!; let removed = false;
  h.ports.scan = () => { if (removed) throw new Error("later safety scan unavailable"); return EMPTY; };
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove") removed = true;
    return result;
  };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed.map(row => row.dir)).toEqual([h.dirs[1]!]);
  for (const dir of [h.dirs[0]!, ...h.dirs.slice(2)]) expect(exists(dir)).toBeTrue();
});

test.skipIf(process.platform !== "linux")("87 keep decisions request exactly one inventory from the leased helper", async () => {
  const h = fixture(87); h.inputs.inFlight = [...h.dirs]; h.ports.scan = undefined;
  const proc = path.join(h.root, "proc"); fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true }); fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, "inspect"] }); h.ports.inspection = worker;
  try {
    await worker.bytes(h.root);
    const report = await h.run();
    expect(report.errors).toEqual([]); expect(report.removed).toEqual([]); expect(report.kept.map(row => row.dir)).toEqual(h.dirs);
    expect(fs.readFileSync(path.join(h.root, "requests"), "utf8").split("\n").filter(kind => kind === "scan")).toHaveLength(1);
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 30_000);
