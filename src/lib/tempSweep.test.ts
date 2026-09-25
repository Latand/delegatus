import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  isOwnedTempName,
  recordTempSweep,
  scanProcesses,
  startTempSweep,
  stopTempSweep,
  sweepRoots,
  sweepStaleTempDirs,
  tempSweepMaxAgeMs,
  type ProcessScan,
} from "./tempSweep";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const made: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  /* Only the children this file started, by the handle it kept. */
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  stopTempSweep();
});

/** A temp root of the test's own, standing in for /var/tmp. */
function tempRoot(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-temp-sweep-test-")));
  made.push(directory);
  return directory;
}

/** A directory with a few entries, every modification time `ageMs` in the past. */
function aged(root: string, name: string, ageMs: number): string {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(directory, "node_modules", "pkg", "index.js"), "x".repeat(8192));
  fs.writeFileSync(path.join(directory, "file.txt"), "export");
  const when = new Date(Date.now() - ageMs);
  for (const entry of [path.join(directory, "file.txt"), path.join(directory, "node_modules", "pkg"), path.join(directory, "node_modules"), directory]) {
    fs.utimesSync(entry, when, when);
  }
  return directory;
}

async function started(child: ChildProcess): Promise<ChildProcess> {
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  /* The shell has to reach its `exec` before the fd or cwd exists. */
  await Bun.sleep(150);
  return child;
}

test("owned names are llv-* and three legacy test prefixes; shared roots and foreign names are not", () => {
  for (const name of ["llv-test-run-a1B2c3", "llv-registry-x", "llv-stage-abc", "llv-issue-1641-q", "pending-producer-a", "inflight-producer-b", "child-owner-c"]) {
    expect(isOwnedTempName(name)).toBeTrue();
  }
  for (const name of ["llv-spawn-sandbox", "llv-tmux-cwd", "llv-", "rv2191-png", "rev-state", "pulse-PKdhtXMmr18n", "playwright_chromiumdev_profile-x", "claude-1000", "tmux-1000", "systemd-private-x"]) {
    expect(isOwnedTempName(name)).toBeFalse();
  }
});

test("the threshold defaults to 24 h, reads hours from the environment, and 0 turns the sweep off", () => {
  expect(tempSweepMaxAgeMs({})).toBe(DAY);
  expect(tempSweepMaxAgeMs({ LLV_TEMP_SWEEP_MAX_AGE_HOURS: " " })).toBe(DAY);
  expect(tempSweepMaxAgeMs({ LLV_TEMP_SWEEP_MAX_AGE_HOURS: "6" })).toBe(6 * HOUR);
  expect(tempSweepMaxAgeMs({ LLV_TEMP_SWEEP_MAX_AGE_HOURS: "0" })).toBeNull();
  expect(tempSweepMaxAgeMs({ LLV_TEMP_SWEEP_MAX_AGE_HOURS: "soon" })).toBe(DAY);
});

test("a sweep removes old owned directories and keeps young, foreign, shared, in-use and worktree ones", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  const old = aged(root, "llv-test-run-old", 2 * DAY);
  const legacy = aged(root, "pending-producer-old", 3 * DAY);
  const young = aged(root, "llv-registry-young", 2 * HOUR);
  const foreign = aged(root, "rv2191-export", 5 * DAY);
  const shared = aged(root, "llv-spawn-sandbox", 5 * DAY);
  const cwdHeld = aged(root, "llv-cwd-held", 2 * DAY);
  const fdHeld = aged(root, "llv-fd-held", 2 * DAY);
  const envHeld = aged(root, "llv-stage-env-held", 2 * DAY);
  const worktree = aged(root, "llv-worktree", 2 * DAY);
  const linkTarget = aged(outside, "llv-link-target", 2 * DAY);
  fs.symlinkSync(linkTarget, path.join(root, "llv-link"));
  fs.writeFileSync(path.join(root, "llv-plain-file"), "not a directory");
  fs.utimesSync(root, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));

  /* Three idle holders: one sits in a directory, one keeps a file open, one
     only carries its scratch directory in TMPDIR, the way a stage agent whose
     shell is between commands does. */
  await started(spawn("sleep", ["30"], { cwd: cwdHeld, stdio: "ignore" }));
  await started(spawn("sh", ["-c", "exec 3<\"$1\"; exec sleep 30", "sh", path.join(fdHeld, "file.txt")], { stdio: "ignore" }));
  await started(spawn("sleep", ["30"], { env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: path.join(envHeld, "tmp") }, stdio: "ignore" }));

  const report = await sweepStaleTempDirs({
    maxAgeMs: DAY,
    roots: [{ path: root, via: "" }],
    worktrees: [worktree],
  });

  expect(report.removed.map((removal) => path.basename(removal.path)).sort()).toEqual(["llv-test-run-old", "pending-producer-old"]);
  expect(report.removed.every((removal) => removal.bytes > 0 && removal.ageHours >= 48)).toBeTrue();
  expect(report.removedBytes).toBe(report.removed.reduce((sum, removal) => sum + removal.bytes, 0));
  expect(fs.existsSync(old)).toBeFalse();
  expect(fs.existsSync(legacy)).toBeFalse();
  for (const kept of [young, foreign, shared, cwdHeld, fdHeld, envHeld, worktree, linkTarget, path.join(root, "llv-link"), path.join(root, "llv-plain-file")]) {
    expect(fs.existsSync(kept)).toBeTrue();
  }
  expect(report.kept).toEqual({ young: 1, inUse: 3, worktree: 1, deferred: 0 });
  expect(report.errors).toEqual([]);
});

test("a directory that is old but had a new entry written into it is still young", async () => {
  const root = tempRoot();
  const directory = aged(root, "llv-stage-busy", 3 * DAY);
  fs.writeFileSync(path.join(directory, "fresh.log"), "written just now");
  const when = new Date(Date.now() - 3 * DAY);
  fs.utimesSync(directory, when, when);
  const report = await sweepStaleTempDirs({ maxAgeMs: DAY, roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] } });
  expect(report.removed).toEqual([]);
  expect(report.kept.young).toBe(1);
});

test("a sweep stops at its removal budget and a directory another user owns is never a candidate", async () => {
  const root = tempRoot();
  for (const name of ["llv-a", "llv-b", "llv-c"]) aged(root, name, 2 * DAY);
  const scan: ProcessScan = { ownNamespace: null, processes: [] };
  const bounded = await sweepStaleTempDirs({ maxAgeMs: DAY, roots: [{ path: root, via: "" }], scan, maxRemovals: 2 });
  expect(bounded.removed).toHaveLength(2);
  expect(bounded.kept.deferred).toBe(1);

  const foreignOwner = await sweepStaleTempDirs({ maxAgeMs: DAY, roots: [{ path: root, via: "" }], scan, uid: (process.getuid?.() ?? 0) + 1 });
  expect(foreignOwner.removed).toEqual([]);
  expect(fs.readdirSync(root)).toHaveLength(1);
});

test("a root read through another namespace is skipped once that namespace is no longer the one recorded", async () => {
  const root = tempRoot();
  const directory = aged(root, "llv-registry-old", 2 * DAY);
  const report = await sweepStaleTempDirs({
    maxAgeMs: DAY,
    roots: [{ path: root, via: "", anchor: { pid: process.pid, namespace: "mnt:[0]" } }],
    scan: { ownNamespace: null, processes: [] },
  });
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(directory)).toBeTrue();
  expect(report.errors[0]).toContain("namespace");
});

test("the host temp roots are read through an agent process in another mount namespace, once per namespace", () => {
  const scan: ProcessScan = {
    ownNamespace: "mnt:[1]",
    processes: [
      { pid: 10, namespace: "mnt:[1]", stamped: true, paths: [] },
      { pid: 20, namespace: "mnt:[2]", stamped: true, paths: [] },
      { pid: 21, namespace: "mnt:[2]", stamped: true, paths: [] },
      { pid: 30, namespace: "mnt:[3]", stamped: false, paths: [] },
    ],
  };
  expect(sweepRoots(scan, ["/tmp", "/state/scratch"], "/proc")).toEqual([
    { path: "/tmp", via: "" },
    { path: "/state/scratch", via: "" },
    { path: "/tmp", via: "/proc/20/root", anchor: { pid: 20, namespace: "mnt:[2]" } },
    { path: "/var/tmp", via: "/proc/20/root", anchor: { pid: 20, namespace: "mnt:[2]" } },
  ]);
});

test("the process scan sees this process's namespace, working directory and TMPDIR", async () => {
  const held = tempRoot();
  const child = await started(spawn("sleep", ["30"], { cwd: held, env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: path.join(held, "tmp"), LLV_STRUCTURED_HOST: "stamp" }, stdio: "ignore" }));
  const scan = scanProcesses();
  if (!fs.existsSync("/proc/self/ns/mnt")) return;
  expect(scan.ownNamespace).toStartWith("mnt:");
  const seen = scan.processes.find((entry) => entry.pid === child.pid);
  expect(seen?.stamped).toBeTrue();
  expect(seen?.paths).toContain(held);
  expect(seen?.paths).toContain(path.join(held, "tmp"));
});

test("a sweep is recorded as its report and one journal line per removed directory", () => {
  const state = tempRoot();
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  try {
    recordTempSweep({
      at: "2026-09-25T00:00:00.000Z",
      maxAgeHours: 24,
      roots: ["/var/tmp"],
      removed: [{ path: "/var/tmp/llv-test-run-a", via: "", bytes: 4096, ageHours: 30 }],
      removedBytes: 4096,
      kept: { young: 0, inUse: 0, worktree: 0, deferred: 0 },
      errors: [],
    });
    expect(JSON.parse(fs.readFileSync(path.join(state, "temp-sweep-report.json"), "utf8")).removedBytes).toBe(4096);
    const journal = fs.readFileSync(path.join(state, "temp-sweep-journal.ndjson"), "utf8").trim().split("\n");
    expect(journal.map((line) => JSON.parse(line).path)).toEqual(["/var/tmp/llv-test-run-a"]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("the sweep clock starts once, waits for boot, and re-arms only after a sweep finishes", async () => {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const schedule = (callback: () => void, delayMs: number) => {
    scheduled.push({ callback, delayMs });
    return setTimeout(() => {}, 0);
  };
  let sweeps = 0;
  let finish: () => void = () => {};
  const sweep = () => { sweeps += 1; return new Promise<void>((resolve) => { finish = resolve; }); };
  startTempSweep({ schedule, sweep, firstDelayMs: 300_000, intervalMs: HOUR });
  startTempSweep({ schedule, sweep, firstDelayMs: 300_000, intervalMs: HOUR });
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([300_000]);
  scheduled[0]!.callback();
  expect(sweeps).toBe(1);
  expect(scheduled).toHaveLength(1);
  finish();
  await Bun.sleep(0);
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([300_000, HOUR]);
});
