import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";

import {
  isOwnedTempName,
  recordTempSweep,
  runTempSweep,
  scanProcesses,
  startTempSweep,
  stopTempSweep,
  sweepRoots,
  sweepStaleTempDirs,
  tempSweepMaxAgeMs,
  tempSweepStatus,
  writableRoots,
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

test.each(["checkout", "bare"])("an owned stale temp tree preserves a %s repository inside dependencies", async kind => {
  const root = tempRoot();
  const directory = aged(root, "llv-private-dependencies", 2 * DAY);
  const repository = path.join(directory, "node_modules/pkg");
  if (kind === "checkout") {
    fs.mkdirSync(path.join(repository, ".git"));
    fs.writeFileSync(path.join(repository, ".git/HEAD"), "ref: refs/heads/private\n");
  } else {
    fs.mkdirSync(path.join(repository, "objects"));
    fs.writeFileSync(path.join(repository, "HEAD"), "ref: refs/heads/private\n");
  }
  const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY });
  expect(report.removed).toHaveLength(0);
  expect(report.held).toEqual([expect.objectContaining({ path: directory, reason: "git-checkout" })]);
  expect(fs.readFileSync(path.join(repository, "index.js"), "utf8")).toBe("x".repeat(8192));
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

test("a temp root mounted read-only is left out, while the host's is still read through an agent", async () => {
  const writable = tempRoot();
  const readOnly = tempRoot();
  const stale = path.join(readOnly, "llv-test-run-ro");
  fs.mkdirSync(stale);
  const old = (Date.now() - 2 * DAY) / 1000;
  fs.utimesSync(stale, old, old);
  const erofs = (root: string) => {
    if (root === readOnly) throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
  };
  const own = writableRoots([writable, readOnly], erofs);
  expect(own).toEqual([writable]);
  const scan: ProcessScan = { ownNamespace: "mnt:[1]", processes: [{ pid: 20, namespace: "mnt:[2]", stamped: true, paths: [] }] };
  expect(sweepRoots(scan, own, "/proc")).toEqual([
    { path: writable, via: "" },
    { path: "/tmp", via: "/proc/20/root", anchor: { pid: 20, namespace: "mnt:[2]" } },
    { path: "/var/tmp", via: "/proc/20/root", anchor: { pid: 20, namespace: "mnt:[2]" } },
  ]);
  /* The sweep over the roots kept never visits the read-only one. */
  const report = await sweepStaleTempDirs({ maxAgeMs: DAY, roots: [{ path: writable, via: "" }], scan: { ownNamespace: null, processes: [] }, worktrees: [] });
  expect(report.errors).toEqual([]);
  expect(fs.existsSync(stale)).toBeTrue();

  /* The default check reads the real permission bits (root ignores them). */
  if (process.getuid?.() !== 0) {
    fs.chmodSync(readOnly, 0o555);
    try {
      expect(writableRoots([writable, readOnly])).toEqual([writable]);
    } finally {
      fs.chmodSync(readOnly, 0o755);
    }
  }
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
    expect(tempSweepStatus()).toMatchObject({ removed: 1, removedBytes: 4096, heldCounts: {}, heldBytes: {} });
    const journal = fs.readFileSync(path.join(state, "temp-sweep-journal.ndjson"), "utf8").trim().split("\n");
    expect(journal.map((line) => JSON.parse(line).path)).toEqual(["/var/tmp/llv-test-run-a"]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("the resources temp summary names Git and inspection holds with bytes and no paths", () => {
  const state = tempRoot();
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  try {
    expect(tempSweepStatus()).toBeNull();
    recordTempSweep({
      at: "2026-10-06T10:00:00Z", maxAgeHours: 24, roots: ["/var/tmp"], removed: [], removedBytes: 0,
      kept: { young: 0, inUse: 0, worktree: 3, deferred: 0 }, errors: [],
      held: [
        { path: "/var/tmp/llv-repo", via: "", reason: "git-checkout", bytes: 4096 },
        { path: "/var/tmp/llv-repo-other", via: "/proc/42/root", reason: "git-checkout", bytes: 8192 },
        { path: "/var/tmp/llv-private", via: "", reason: "unreadable-tree", bytes: 1024 },
      ],
    });
    const summary = tempSweepStatus();
    expect(summary).toMatchObject({
      heldCounts: { "git-checkout": 2, "unreadable-tree": 1 },
      heldBytes: { "git-checkout": 12288, "unreadable-tree": 1024 },
    });
    expect(summary?.summary).toContain("held 3 for Git preservation or tree inspection");
    expect(JSON.stringify(summary)).not.toContain("/var/tmp");
    expect(JSON.stringify(summary)).not.toContain("/proc");
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

test.each(["merge-batch", "review-export", "attribution"])("a %s checkout inside an owned temp root stays for Git preservation checks", async role => {
  const root = tempRoot();
  const directory = aged(root, "llv-stage-role", 3 * DAY);
  const checkout = path.join(directory, role, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, ".git"), "gitdir: fixture repository metadata");
  fs.writeFileSync(path.join(checkout, "local-work.txt"), "unpublished work");
  const when = new Date(Date.now() - 3 * DAY);
  fs.utimesSync(path.join(directory, role), when, when); fs.utimesSync(directory, when, when);
  const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, worktrees: [], maxAgeMs: DAY });
  expect(report.removed).toHaveLength(0);
  expect(report.kept.worktree).toBe(1);
  expect(report.held).toEqual([expect.objectContaining({ path: directory, reason: "git-checkout", bytes: expect.any(Number) })]);
  expect(fs.readFileSync(path.join(checkout, "local-work.txt"), "utf8")).toBe("unpublished work");
});

test.each(["process", "activity", "parent-redirect", "replacement"])("temp cleanup retains %s acquired during measurement", async change => {
  const root = tempRoot();
  const external = tempRoot();
  const directory = aged(root, "llv-late-owner", 3 * DAY);
  const scan: ProcessScan = { ownNamespace: null, processes: [] };
  const original = fs.promises.readdir;
  let injected = false;
  const read = spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof fs.promises.readdir>) => {
    const entries = await original(...args);
    if (String(args[0]) === directory && !injected) {
      injected = true;
      if (change === "process") scan.processes.push({ pid: 456789, namespace: null, stamped: true, paths: [path.join(directory, "file.txt")] });
      else if (change === "activity") fs.writeFileSync(path.join(directory, "new.txt"), "new output");
      else if (change === "parent-redirect") {
        fs.renameSync(root, path.join(external, "original"));
        const target = aged(external, "llv-late-owner", 3 * DAY);
        fs.writeFileSync(path.join(target, "file.txt"), "external evidence");
        const old = new Date(Date.now() - 3 * DAY);
        fs.utimesSync(path.join(target, "file.txt"), old, old);
        fs.symlinkSync(external, root, "dir");
      } else {
        fs.renameSync(directory, path.join(external, "original"));
        aged(root, "llv-late-owner", 3 * DAY);
      }
    }
    return entries;
  }) as typeof fs.promises.readdir);
  try {
    const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan, maxAgeMs: DAY });
    expect(injected).toBeTrue();
    expect(report.removed).toEqual([]);
    expect(fs.existsSync(path.join(directory, "file.txt"))).toBeTrue();
    if (change === "process") expect(report.kept.inUse).toBe(1);
    if (change === "activity") {
      expect(report.kept.young).toBe(1);
      expect(fs.readFileSync(path.join(directory, "new.txt"), "utf8")).toBe("new output");
    }
    if (change === "parent-redirect") expect(fs.readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("external evidence");
  } finally { read.mockRestore(); }
});

test.skipIf(process.platform !== "linux").each(["cwd", "file"])("production temp cleanup refreshes a real late %s holder", async holder => {
  const root = tempRoot();
  const directory = aged(root, "llv-late-live", 3 * DAY);
  const original = fs.promises.readdir;
  let injected = false;
  const read = spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof fs.promises.readdir>) => {
    const result = await original(...args);
    if (String(args[0]) === directory && !injected) {
      injected = true;
      if (holder === "cwd") await started(spawn("sleep", ["60"], { cwd: directory }));
      else await started(spawn("sh", ["-c", 'exec 3<"$1"; exec sleep 60', "fixture", path.join(directory, "file.txt")], { cwd: root }));
    }
    return result;
  }) as typeof fs.promises.readdir);
  try {
    const report = (await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" }, { roots: [{ path: root, via: "" }] }))!;
    expect(injected).toBeTrue();
    expect(report.removed).toEqual([]);
    expect(report.kept.inUse).toBe(1);
    expect(fs.readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("export");
  } finally { read.mockRestore(); }
});

test("an unreadable temp tree stays with an explicit inspection hold", async () => {
  const root = tempRoot();
  const directory = aged(root, "llv-unreadable", 3 * DAY);
  const original = fs.readdirSync;
  const read = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === directory) throw new Error("fixture access denied");
    return original(...args);
  }) as typeof fs.readdirSync);
  try {
    const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY });
    expect(report.removed).toEqual([]);
    expect(report.held).toEqual([expect.objectContaining({ path: directory, reason: "unreadable-tree" })]);
    expect(fs.existsSync(directory)).toBe(true);
  } finally { read.mockRestore(); }
});

test("an empty .git marker a cache writes is not a checkout, and its stale root goes", async () => {
  const root = tempRoot();
  const directory = aged(root, "llv-stage-cache", 3 * DAY);
  const cache = path.join(directory, "tmp/uvcache/sdists-v9");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, ".git"), "");
  const when = new Date(Date.now() - 3 * DAY);
  for (const entry of [cache, path.join(directory, "tmp/uvcache"), path.join(directory, "tmp"), directory]) fs.utimesSync(entry, when, when);
  const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, worktrees: [], maxAgeMs: DAY });
  expect(report.removed.map((removal) => path.basename(removal.path))).toEqual(["llv-stage-cache"]);
  expect(fs.existsSync(directory)).toBe(false);
});

test.each(["gitdir", "unrecognized metadata", ""])("damaged Git metadata %j keeps a role checkout and its source", async marker => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Sweep Test", "-c", "user.email=sweep@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "input.txt"), "preserved input");
  git(["add", "."]); git(["commit", "-qm", "initial"]);
  const role = path.join(root, "llv-review-export");
  const checkout = path.join(role, "checkout");
  git(["worktree", "add", "-q", "-b", "topic/export", checkout]);
  const source = path.join(checkout, "unique-source.ts");
  fs.writeFileSync(source, "export const privateWork = 42;\n");
  fs.writeFileSync(path.join(checkout, ".git"), marker);
  const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY, now: () => Date.now() + 8 * DAY });
  expect(report.removed).toEqual([]);
  expect(report.held).toEqual([expect.objectContaining({ path: role, reason: "git-checkout" })]);
  expect(fs.readFileSync(source, "utf8")).toBe("export const privateWork = 42;\n");
});

test("a bare repository missing HEAD retains its unpublished objects and ref", async () => {
  const root = tempRoot();
  const bare = path.join(root, "llv-bare-export");
  fs.mkdirSync(bare);
  const git = (args: string[], input?: string) => execFileSync("git", ["-c", "user.name=Sweep Test", "-c", "user.email=sweep@example.invalid", ...args], { cwd: bare, encoding: "utf8", input }).trim();
  git(["init", "--bare", "-q"]);
  const blob = git(["hash-object", "-w", "--stdin"], "unpublished source\n");
  const tree = git(["mktree"], `100644 blob ${blob}\tunique-source.txt\n`);
  const tip = git(["commit-tree", tree, "-m", "unpublished work"]);
  git(["update-ref", "refs/heads/private", tip]);
  fs.unlinkSync(path.join(bare, "HEAD"));
  const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY, now: () => Date.now() + 8 * DAY });
  expect(report.removed).toEqual([]);
  expect(report.held).toEqual([expect.objectContaining({ path: bare, reason: "git-checkout" })]);
  expect(fs.existsSync(path.join(bare, "objects", blob.slice(0, 2), blob.slice(2)))).toBe(true);
  expect(fs.readFileSync(path.join(bare, "refs/heads/private"), "utf8").trim()).toBe(tip);
});

test.skipIf(process.platform !== "linux")("temp holds count one physical checkout through namespace aliases once", async () => {
  const root = tempRoot();
  const directory = aged(root, "llv-aliased-export", 3 * DAY);
  fs.writeFileSync(path.join(directory, ".git"), "gitdir: retained repository metadata");
  fs.writeFileSync(path.join(directory, "unique.log"), Buffer.alloc(256 * 1024, 1));
  const options = { scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY, now: () => Date.now() + 8 * DAY };
  const single = await sweepStaleTempDirs({ ...options, roots: [{ path: root, via: "" }] });
  const report = await sweepStaleTempDirs({ ...options, roots: [{ path: root, via: "" }, { path: root, via: "/proc/self/root" }] });
  expect(report.held).toHaveLength(1);
  expect(report.kept.worktree).toBe(1);
  expect(tempSweepStatus(report)?.heldBytes).toEqual(tempSweepStatus(single)?.heldBytes);
  expect(fs.existsSync(directory)).toBe(true);
});

test("overlapping temp roots partition retained allocations", async () => {
  const root = tempRoot();
  const parent = aged(root, "llv-outer-export", 3 * DAY);
  const jobs = path.join(parent, "jobs");
  fs.mkdirSync(jobs);
  const child = aged(jobs, "llv-inner-export", 3 * DAY);
  for (const directory of [parent, child]) fs.writeFileSync(path.join(directory, ".git"), "gitdir: retained metadata");
  fs.writeFileSync(path.join(child, "unique.log"), Buffer.alloc(256 * 1024, 1));
  const options = { scan: { ownNamespace: null, processes: [] }, maxAgeMs: DAY, now: () => Date.now() + 8 * DAY };
  const single = await sweepStaleTempDirs({ ...options, roots: [{ path: root, via: "" }] });
  const report = await sweepStaleTempDirs({ ...options, roots: [{ path: root, via: "" }, { path: jobs, via: "" }] });
  expect(report.held).toHaveLength(2);
  expect(report.held?.find(row => row.path === child)?.bytes).toBeGreaterThanOrEqual(256 * 1024);
  expect(tempSweepStatus(report)?.heldBytes).toEqual(tempSweepStatus(single)?.heldBytes);
  expect(fs.existsSync(child)).toBe(true);
});
