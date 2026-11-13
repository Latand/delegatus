import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { WorktreeSweepCache } from "./worktreeSweepCache";
import { scanProcesses, runTempSweepInHelper } from "../tempSweep";
import { diskVolumes, observeDiskPressure } from "../state/diskPressure";
import { allocatedBytes, sweepMergedWorktrees, type SweptPipeline } from "./worktreeSweep";
import { runAttemptTempSweep } from "../runtime/attemptTempProduction";
console.log = (...args) => console.error(...args);
const directory = process.env.SWEEP_TEST_ROOT!;
if (process.argv.includes("--slice")) {
  const root = path.join(directory, "repo");
  fs.mkdirSync(root, { recursive: true });
  const dirs = Array.from({ length: 8 }, (_, n) => path.join(directory, `lane-${n}`));
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(directory, "progress.json");
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const visited: string[] = [];
  const listing = [root, ...dirs].map(dir => `worktree ${dir}\0HEAD ${"a".repeat(40)}\0branch refs/heads/lane\0\0`).join("");
  const report = await sweepMergedWorktrees({ mode: "dry-run", pipelines: dirs.map((worktreeDir, n) => ({
    id: `lane-${n}`, repoDir: root, worktreeDir, branch: "lane", state: "closed", runs: [],
  } as unknown as SweptPipeline)), maxCandidates: 2, now: () => Date.parse("2026-10-22T00:00:00Z"),
    git: async args => ({ code: 0, stderr: "", stdout: args[0] === "rev-parse" ? path.join(root, ".git")
      : args[0] === "worktree" ? listing : "" }), previous,
    mergedPullRequests: () => [], conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }), recordResolution: () => false,
    phase: (phase, dir) => { if (phase === "candidate" && dir) visited.push(path.basename(dir)); },
  });
  fs.writeFileSync(file, JSON.stringify(report));
  process.stdout.write(JSON.stringify({ visited, progress: report.progress }) + "\n");
  process.exit(0);
}
const cache = new WorktreeSweepCache(path.join(directory, "cache.json"));
const tree = path.join(directory, "tree");
for await (const line of createInterface({ input: process.stdin })) {
  const { mode, kind, env } = JSON.parse(line);
  if (mode === "on" && process.argv.includes("--hold-worktree")) {
    fs.writeFileSync(path.join(directory, "busy-pid"), String(process.pid));
    while (!fs.existsSync(path.join(directory, "release-worktree"))) await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (mode === "on" || kind && kind !== "worktrees") {
    if (process.argv.includes("--hang")) { process.on("SIGTERM", () => {}); fs.writeFileSync(path.join(directory,"busy-pid"), String(process.pid)); while (true) {} }
    if (process.argv.includes("--exit")) process.exit(3);
    if (process.argv.includes("--invalid-phase")) { process.stdout.write(JSON.stringify({ phase: "unknown" }) + "\n"); continue; }
    if (process.argv.includes("--malformed")) { process.stdout.write("bad reply\n"); continue; }
    if (process.argv.includes("--wrong-kind")) {
      process.stdout.write(JSON.stringify({ report: !kind || kind === "worktrees"
        ? { at: "2026-10-18T00:00:00Z", volumes: [], consumers: [] } : { kept: [], removed: [], errors: [] } }) + "\n");
      continue;
    }
    if (process.argv.includes("--oversize")) { process.stdout.write("x".repeat(9 * 1024 * 1024)); continue; }
  }
  if (kind === "attempt-temp") {
    fs.appendFileSync(path.join(directory, "requests"), kind + "\n");
    if (process.argv.includes("--hold-attempt")) {
      fs.writeFileSync(path.join(directory, "attempt-busy"), String(process.pid));
      while (!fs.existsSync(path.join(directory, "release-attempt"))) await new Promise(resolve => setTimeout(resolve, 5));
    }
    process.stdout.write(JSON.stringify({ report: await runAttemptTempSweep({ scan: directories => scanProcesses("/proc", directories) }, { ...process.env, LLV_TEMP_SWEEP: "on" }) }) + "\n");
    continue;
  }
  if (kind === "temp" || kind === "disk-pressure") {
    fs.appendFileSync(path.join(directory, "requests"), kind + "\n");
    const proc = path.join(directory, "proc");
    const scan = fs.existsSync(proc) ? scanProcesses(proc) : { ownNamespace: null, processes: [] };
    const report = kind === "temp" ? await runTempSweepInHelper({ ...process.env,
      LLV_TEMP_SWEEP: env?.LLV_TEMP_SWEEP === "off" ? "off" : "dry-run", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" }, {
      roots: [{ path: directory, via: "" }], scan,
      now: () => Date.parse("2026-10-18T00:00:00Z"), mountPoints: () => [],
    }) : observeDiskPressure(diskVolumes(Array.from({ length: 932 }, (_, i) => ({ role: "worktrees", directory: path.join(directory, `tree-${i}`) }))), null, new Date().toISOString());
    process.stdout.write(JSON.stringify({ report }) + "\n");
    continue;
  }
  if (process.argv.includes("--phases")) process.stdout.write(["discovery", "candidate", "accounting"].map(phase => JSON.stringify({ phase })).join("\n") + "\n");
  // An unchanged warm pass uses the persisted allocation inventory. Expiry
  // and watcher events force another walk, never a cached removal decision.
  const bytes = await cache.allocation(tree, "kept", [], new Set(), () => allocatedBytes(tree));
  cache.persist();
  process.stdout.write(JSON.stringify({report:{at:"2026-10-18T00:00:00.000Z",mode,repositories:[],removed:[],removedBytes:0,trimmed:[],trimmedBytes:0,
    kept:[{path:tree,reason:"no-merged-pr",bytes}],keptCounts:{"no-merged-pr":1},keptBytes:{"no-merged-pr":bytes},errors:[],cacheStats:{...cache.stats}}})+"\n");
}
cache.close();
