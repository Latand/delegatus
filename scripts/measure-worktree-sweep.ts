/** Repeatable synthetic sweep on an isolated copy. SWEEP_FIXTURE is owned by
 * the caller; --in-process also works with the pre-worker revision's source.
 * No Git commands, registry reads, network calls or removals reach real state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { sweepMergedWorktrees, type SweptPipeline, type WorktreeSweepPorts } from "../src/lib/pipelines/worktreeSweep";

/** Small candidate payloads isolate registration and observer overhead. */
if (process.argv.includes("--phases")) {
  const { WorktreeSweepCache } = await import("../src/lib/pipelines/worktreeSweepCache");
  const { WorktreeSweepWorker } = await import("../src/lib/pipelines/worktreeSweepWorker");
  const fixture = process.env.SWEEP_FIXTURE;
  if (!fixture || !process.env.LLV_STATE_DIR || process.env.NODE_ENV !== "test" || process.env.LLV_STATE_OWNER)
    throw new Error("isolated test environment required");
  fs.mkdirSync(fixture, { recursive: true });
  const roots = Array.from({ length: 33 }, (_, i) => path.join(fixture, `repo-${i}`));
  const pipelines = roots.flatMap((repoDir, r) => {
    fs.mkdirSync(path.join(repoDir, ".git/worktrees"), { recursive: true });
    return Array.from({ length: 15 }, (_, n) => {
      const id = `${r}-${String(n).padStart(3, "0")}`, worktreeDir = path.join(fixture, `lane-${id}`);
      fs.mkdirSync(worktreeDir, { recursive: true });
      return { id, repoDir, worktreeDir, branch: "lane", state: "closed" as const, runs: [], closedAt: "2026-10-22T00:00:00Z" };
    });
  });
  let discoveryMs = 0, calls = 0, candidates = 0, slices = 0;
  const times: number[] = [];
  const cache = new WorktreeSweepCache(path.join(fixture, "cache.json"));
  const discovery = fs.existsSync(path.join(import.meta.dir, "../src/lib/pipelines/worktreeSweepDiscovery.ts"))
    ? new (await import("../src/lib/pipelines/worktreeSweepDiscovery")).WorktreeSweepDiscovery() : undefined;
  const ports: WorktreeSweepPorts = { mode: "dry-run", cache, discovery, pipelines, timeBudgetMs: 2, maxCandidates: 16,
    now: () => Date.parse("2026-10-22T00:30:00Z"),
    scan: () => ({ ownNamespace: null, processes: [] }), conversationCwds: () => [], recordResolution: () => false, mergedPullRequests: () => [],
    git: async (args, cwd) => {
      const start = performance.now();
      let stdout = "";
      if (args[0] === "rev-parse" || args[0] === "worktree") {
        calls++;
        await Bun.sleep(1);
        stdout = args[0] === "rev-parse" ? path.join(cwd, ".git")
          : [cwd, ...pipelines.filter(p => p.repoDir === cwd).map(p => p.worktreeDir)]
            .map(dir => `worktree ${dir}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane\0\0`).join("");
        discoveryMs += performance.now() - start;
      }
      return { code: 0, stdout, stderr: "" };
    },
    phase: phase => {
      if (phase !== "candidate") return;
      candidates++;
      const until = performance.now() + 1;
      while (performance.now() < until) { /* Fixed simulated check work. */ }
    },
  };
  const started = performance.now();
  while (slices < 160) {
    const start = performance.now();
    ports.previous = await sweepMergedWorktrees(ports);
    times.push(performance.now() - start);
    slices++;
    if (ports.previous.progress?.complete) break;
  }
  console.log(JSON.stringify({ phase: "sweep", slices, calls, candidates, discoveryMs, elapsedMs: performance.now() - started,
    firstSliceMs: times[0], lastVisited: ports.previous?.progress?.visited, pending: ports.previous?.progress?.pending.length,
    complete: ports.previous?.progress?.complete }));
  process.env.SWEEP_TEST_ROOT = fixture;
  const worker = new WorktreeSweepWorker({ executable: process.execPath,
    entry: path.join(import.meta.dir, "../src/lib/pipelines/worktreeSweep.fixture.ts"), args: ["--hold-worktree"] }, 10_000);
  const held = worker.run("on");
  try {
    const deadline = performance.now() + 5_000;
    while (!fs.existsSync(path.join(fixture, "busy-pid"))) {
      if (performance.now() >= deadline) throw new Error("fixture did not acknowledge hold");
      await Bun.sleep(5);
    }
    const pressureAt = performance.now();
    try {
      await worker.diskPressure();
      console.log(JSON.stringify({ phase: "pressure", ms: performance.now() - pressureAt, outcome: "observed" }));
    } catch (error) {
      console.log(JSON.stringify({ phase: "pressure", ms: performance.now() - pressureAt, outcome: String(error) }));
    }
  } finally {
    fs.writeFileSync(path.join(fixture, "release-worktree"), "go");
    await held;
    await worker.close();
    cache.close();
  }
  Bun.gc(true);
  const before = process.memoryUsage();
  let live = 0, peak = 0;
  const watch = ((...args: Parameters<typeof fs.watch>) => {
    const watcher = Reflect.apply(fs.watch, fs, args);
    live++; peak = Math.max(peak, live);
    const close = watcher.close.bind(watcher);
    let closed = false;
    watcher.close = () => { if (!closed) { closed = true; live--; } close(); };
    return watcher;
  }) as typeof fs.watch;
  const inventory = new WorktreeSweepCache(path.join(fixture, "inventory.json"), Date.now, watch);
  const memoryStart = performance.now();
  try {
    for (const pipeline of pipelines) {
      for (let n = 0; n < 70; n++) fs.mkdirSync(path.join(pipeline.worktreeDir, `cache-${n}`), { recursive: true });
      inventory.candidates(pipeline.worktreeDir, "fixed", () => []);
    }
    inventory.persist();
    Bun.gc(true);
    console.log(JSON.stringify({ phase: "memory", before, after: process.memoryUsage(), live, peak,
      elapsedMs: performance.now() - memoryStart, cacheBytes: fs.statSync(path.join(fixture, "inventory.json")).size,
      reportBytes: JSON.stringify(ports.previous).length }));
  } finally { inventory.close(); }
  process.exit(0);
}
const base = process.env.SWEEP_FIXTURE;
if (!base) throw new Error("SWEEP_FIXTURE must name an isolated fixture directory");
const repo = path.join(base, "repo");
const count = 930;
fs.mkdirSync(repo, { recursive: true });
let listed = `worktree ${repo}\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`;
const pipelines: SweptPipeline[] = [];
for (let i = 0; i < count; i++) {
  const id = String(i).padStart(4, "0");
  const tree = path.join(base, `repo-pipeline-${id}`);
  if (!fs.existsSync(tree)) {
    fs.mkdirSync(path.join(tree, "node_modules/dep"), { recursive: true });
    for (let j = 0; j < 100; j++) fs.writeFileSync(path.join(tree, "node_modules/dep", `${j}.js`), "x".repeat(256));
    fs.writeFileSync(path.join(tree, "source.ts"), "export {};\n");
  }
  listed += `worktree ${tree}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane-${id}\0\0`;
  pipelines.push({ id, state: "completed", repoDir: repo, worktreeDir: tree, branch: `lane-${id}`, runs: [] });
}
const ports = {
  mode: "dry-run" as const, pipelines,
  git: async (args: string[]) => ({ code: 0, stdout: args[0] === "rev-parse" ? path.join(repo, ".git")
    : args[0] === "worktree" ? listed : args[0] === "remote" ? "https://github.com/example/widgets.git" : "", stderr: "" }),
  mergedPullRequests: () => [], conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }),
  recordResolution: () => true, now: () => Date.parse("2026-10-18T00:00:00Z"),
};
if (process.argv.includes("--worker")) {
  const { WorktreeSweepCache } = await import("../src/lib/pipelines/worktreeSweepCache");
  const cache = new WorktreeSweepCache(path.join(process.env.LLV_STATE_DIR!, "benchmark-cache.json"));
  for await (const line of createInterface({ input: process.stdin })) {
    if (JSON.parse(line).mode !== "dry-run") throw new Error("benchmark only accepts dry-run requests");
    const report = await sweepMergedWorktrees({ ...ports, cache });
    cache.persist();
    process.stdout.write(JSON.stringify({ report: { ...report, cacheStats: { ...cache.stats } } }) + "\n");
  }
  cache.close();
} else {
  const inProcess = process.argv.includes("--in-process");
  const worker = inProcess ? null : new (await import("../src/lib/pipelines/worktreeSweepWorker")).WorktreeSweepWorker({
    executable: process.execPath, entry: import.meta.path, args: ["--worker"],
  });
  try {
    for (let run = 0; run < 3; run++) {
      const loadBefore = os.loadavg();
      let last = performance.now(), maxGap = 0, ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
      }, 1);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        const started = performance.now(), cpu = process.cpuUsage();
        const report = worker ? await worker.run("dry-run") : await sweepMergedWorktrees(ports);
        await new Promise(resolve => setTimeout(resolve, 5));
        console.log(JSON.stringify({ at: new Date().toISOString(), run, trees: count, filesPerTree: 101,
          elapsedMs: performance.now() - started, maxLoopGapMs: maxGap, ticks, cpu: process.cpuUsage(cpu),
          loadBefore, loadAfter: os.loadavg(), bun: process.versions.bun, cpus: os.availableParallelism(),
          kept: report.kept.length, trimmed: report.trimmed.length, errors: report.errors.length, keptBytes: report.keptBytes,
          cacheStats: (report as typeof report & { cacheStats?: unknown }).cacheStats }));
      } finally { clearInterval(timer); }
    }
  } finally { await worker?.close(); }
}
