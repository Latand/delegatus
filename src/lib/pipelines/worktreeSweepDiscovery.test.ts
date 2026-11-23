import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { WorktreeSweepDiscovery, type SweepInventory } from "./worktreeSweepDiscovery";
import { startWorktreeSweep, stopWorktreeSweep, sweepMergedWorktrees, WORKTREE_SWEEP_INTERVAL_MS, type WorktreeSweepPorts, type WorktreeSweepReport } from "./worktreeSweep";
import { WorktreeSweepCache, SWEEP_WATCH_DIRECTORIES } from "./worktreeSweepCache";

import { requestDiskPressureSweeps } from "../state/diskPressureSweeps";

const roots: string[] = [];
afterEach(() => { stopWorktreeSweep(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-discovery-")); roots.push(directory);
  const repo = path.join(directory, "repo");
  fs.mkdirSync(path.join(repo, ".git/worktrees"), { recursive: true });
  return { directory, repo };
}

test("500 worktrees finish in bounded slices with discovery once and kept verdicts waiting an hour", async () => {
  const { directory } = fixture();
  const repositories = Array.from({ length: 5 }, (_, n) => path.join(directory, `repository-${n}`));
  const pipelines = repositories.flatMap((repoDir, r) => {
    fs.mkdirSync(path.join(repoDir, ".git/worktrees"), { recursive: true });
    return Array.from({ length: 100 }, (_, n) => {
      const id = `${r}-${String(n).padStart(3, "0")}`, worktreeDir = path.join(directory, `lane-${id}`);
      fs.mkdirSync(worktreeDir);
      return { id, repoDir, worktreeDir, state: "closed" as const, branch: "lane", runs: [], closedAt: "2026-10-22T00:00:00Z" };
    });
  });
  let clock = 0, at = Date.parse("2026-10-22T00:30:00Z"), discoveries = 0;
  const visited = new Set<string>();
  const ports: WorktreeSweepPorts = { mode: "dry-run", pipelines, discovery: new WorktreeSweepDiscovery(),
    timeBudgetMs: 10, monotonicNow: () => clock, now: () => at,
    git: async (args, cwd) => {
      if (args[0] === "worktree") discoveries++;
      clock += 100; // Discovery alone exceeds an entire slice.
      return { code: 0, stderr: "", stdout: args[0] === "rev-parse" ? path.join(cwd, ".git")
        : args[0] === "worktree" ? [cwd, ...pipelines.filter(row => row.repoDir === cwd).map(row => row.worktreeDir)]
          .map(dir => `worktree ${dir}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane\0\0`).join("") : "" };
    },
    mergedPullRequests: () => [], conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }), recordResolution: () => false,
    phase: (phase, directory) => {
      if (phase !== "candidate" || !directory) return;
      expect(visited.has(directory)).toBeFalse(); visited.add(directory); clock += 5;
    },
  };
  let slices = 0;
  do {
    ports.previous = JSON.parse(JSON.stringify(await sweepMergedWorktrees(ports)));
    expect(ports.previous!.progress!.visited).toBeGreaterThanOrEqual(4);
    at += 5_000;
  } while (++slices < 125 && !ports.previous!.progress!.complete);
  expect(ports.previous!.progress!.complete).toBeTrue();
  expect(slices).toBe(125);
  expect(visited.size).toBe(500);
  expect(discoveries).toBe(5);
  expect(ports.previous!.keptCounts).toEqual({ retention: 500 });
  expect(ports.previous!.timings).toMatchObject({ slices: 125, worktreesPerSlice: 4, fullPassDurationMs: 620_000 });
  const original = ports.previous!;
  visited.clear();
  const warm = await sweepMergedWorktrees(ports);
  expect(warm.progress!.visited).toBe(0);
  expect([...warm.kept].sort((a, b) => a.path.localeCompare(b.path))).toEqual([...original.kept].sort((a, b) => a.path.localeCompare(b.path)));
  // A helper restart loses its inventory, while serialized verdicts still
  // defer unchanged rows. Once the interval ends every row becomes eligible.
  ports.discovery = new WorktreeSweepDiscovery();
  ports.previous = JSON.parse(JSON.stringify(warm));
  expect((await sweepMergedWorktrees(ports)).progress!.visited).toBe(0);
  at += WORKTREE_SWEEP_INTERVAL_MS;
  expect((await sweepMergedWorktrees(ports)).progress!.visited).toBe(4);
});

for (const change of ["membership", "head", "ref", "lock", "inputs", "during-read", "oversize", "failed"] as const)
  test(`discovery invalidates on ${change}`, async () => {
    const { repo } = fixture();
    const registration = path.join(repo, ".git/worktrees/first"); fs.mkdirSync(registration);
    fs.writeFileSync(path.join(registration, "HEAD"), "initial");
    const cache = new WorktreeSweepDiscovery(change === "oversize" ? 0 : 100);
    let calls = 0;
    const load = async (observe: (roots: readonly string[]) => void): Promise<SweepInventory> => {
      observe([repo]); calls++;
      if (change === "during-read") fs.writeFileSync(path.join(registration, "HEAD"), `changed-${calls}`);
      return [{ root: repo, failed: change === "failed", listed: [{ path: repo, head: null, branch: null, locked: false, prunable: false, bare: false }] }];
    };
    await cache.read([repo], false, load);
    await cache.read([repo], true, load);
    if (change === "oversize" || change === "during-read" || change === "failed") { expect(calls).toBe(2); return; }
    expect(calls).toBe(1);
    if (change === "membership") fs.mkdirSync(path.join(repo, ".git/worktrees/second"));
    if (change === "ref") {
      fs.mkdirSync(path.join(repo, ".git/refs/heads"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git/refs/heads/lane"), "changed");
    }
    if (change === "head") fs.writeFileSync(path.join(registration, "HEAD"), "different head");
    if (change === "lock") fs.writeFileSync(path.join(registration, "locked"), "held");
    await cache.read(change === "inputs" ? [repo, path.join(repo, "new")] : [repo], true, load);
    expect(calls).toBe(2);
  });

test("candidate caches watch only checkout roots and release every observer", () => {
  const { directory } = fixture();
  let live = 0;
  const watch = ((_file: string, _options: unknown, _callback: unknown) => {
    live++;
    return { on() {}, close() { live--; } };
  }) as unknown as typeof fs.watch;
  const cache = new WorktreeSweepCache(path.join(directory, "cache.json"), Date.now, watch);
  try {
    for (let n = 0; n < 600; n++) {
      const checkout = path.join(directory, `tree-${n}`);
      fs.mkdirSync(path.join(checkout, "node_modules/deep/cache"), { recursive: true });
      cache.candidates(checkout, "fixed", () => []);
      expect(live).toBeLessThanOrEqual(SWEEP_WATCH_DIRECTORIES);
    }
    expect(live).toBe(SWEEP_WATCH_DIRECTORIES);
  } finally { cache.close(); }
  expect(live).toBe(0);
});

test("protected project roots without kept rows drain once per pass", async () => {
  const { directory, repo } = fixture();
  const projects = Array.from({ length: 30 }, (_, n) => path.join(directory, `project-${n}`));
  for (const project of projects) fs.mkdirSync(project);
  const ports: WorktreeSweepPorts = { mode: "on", pipelines: [], repositories: [repo, ...projects],
    maxCandidates: 4, discovery: new WorktreeSweepDiscovery(), now: () => Date.parse("2026-10-22T00:30:00Z"),
    git: async args => ({ code: 0, stderr: "", stdout: args[0] === "rev-parse" ? path.join(repo, ".git")
      : args[0] === "worktree" ? [repo, ...projects]
        .map(dir => `worktree ${dir}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane\0\0`).join("") : "" }),
    mergedPullRequests: () => [], conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }), recordResolution: () => false,
  };
  for (let slice = 0; slice < 8; slice++) ports.previous = JSON.parse(JSON.stringify(await sweepMergedWorktrees(ports)));
  expect(ports.previous!.progress!.complete).toBeTrue();
  expect(ports.previous!.progress!.pass!.visited).toBe(30);
  expect(ports.previous!.removed).toEqual([]);
  for (const project of projects) expect(fs.existsSync(project)).toBeTrue();
});

test("a changing owner cannot starve pending peers under an exhausted slice clock", async () => {
  const { directory, repo } = fixture();
  const pipelines = Array.from({ length: 24 }, (_, n) => {
    const worktreeDir = path.join(directory, `lane-${String(n).padStart(2, "0")}`); fs.mkdirSync(worktreeDir);
    return { id: String(n), repoDir: repo, worktreeDir, state: "closed" as "closed" | "running", branch: "lane", runs: [], closedAt: "2026-10-22T00:00:00Z" };
  });
  const visited = new Set<string>();
  let clock = 0;
  const ports: WorktreeSweepPorts = { mode: "dry-run", pipelines, discovery: new WorktreeSweepDiscovery(),
    timeBudgetMs: 1, monotonicNow: () => clock, now: () => Date.parse("2026-10-22T00:30:00Z"),
    git: async args => ({ code: 0, stderr: "", stdout: args[0] === "rev-parse" ? path.join(repo, ".git")
      : args[0] === "worktree" ? [repo, ...pipelines.map(row => row.worktreeDir)]
        .map(dir => `worktree ${dir}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane\0\0`).join("") : "" }),
    mergedPullRequests: () => [], conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }), recordResolution: () => false,
    phase: (phase, directory) => { if (phase === "candidate" && directory) { visited.add(directory); clock += 2; } },
  };
  for (let slice = 0; slice < 12 && visited.size < pipelines.length; slice++) {
    pipelines[0]!.state = slice % 2 ? "closed" : "running";
    ports.previous = JSON.parse(JSON.stringify(await sweepMergedWorktrees(ports)));
  }
  expect(visited.size).toBe(24);
});

test("zero-freed pressure backoff survives a scheduler process restart", () => {
  const { directory } = fixture();
  for (const phase of ["complete", "restart"]) {
    const child = spawnSync(process.execPath, [path.join(import.meta.dir, "worktreeSweep.fixture.ts"), "--pressure", phase], {
      env: { ...process.env, SWEEP_TEST_ROOT: directory, LLV_STATE_DIR: path.join(directory, "state") }, encoding: "utf8", timeout: 20_000,
    });
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.beforeInterval).not.toContain(0);
    expect(result.afterInterval.at(-1)).toBe(0);
  }
});

for (const freedBytes of [0, 1]) test(`pressure preserves continuation and aggregates earlier slices with ${freedBytes} freed bytes`, async () => {
  const callbacks: Array<() => void> = [], delays: number[] = [];
  let slices = 0;
  startWorktreeSweep({ env: {}, previous: null, firstDelayMs: 100, now: () => 1_000_000, intervalMs: 60_000,
    schedule: (callback, delay) => { callbacks.push(callback); delays.push(delay); return { unref() {} } as ReturnType<typeof setTimeout>; },
    sweep: async () => ({ progress: { complete: ++slices === 2, visited: 4 }, removedBytes: 0, trimmedBytes: 0,
      timings: { freedBytes } } as WorktreeSweepReport),
  });
  callbacks[0]!(); await new Promise(resolve => setImmediate(resolve));
  requestDiskPressureSweeps();
  expect(delays).toEqual([100, 5000]);
  callbacks[1]!(); await new Promise(resolve => setImmediate(resolve));
  requestDiskPressureSweeps(); requestDiskPressureSweeps();
  expect(delays).toEqual(freedBytes ? [100, 5000, 60_000, 0] : [100, 5000, 60_000]);
});
