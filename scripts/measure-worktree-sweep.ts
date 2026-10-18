/** Repeatable synthetic sweep on an isolated copy. SWEEP_FIXTURE is owned by
 * the caller; --in-process also works with the pre-worker revision's source.
 * No Git commands, registry reads, network calls or removals reach real state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { sweepMergedWorktrees, type SweptPipeline } from "../src/lib/pipelines/worktreeSweep";

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
