import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { WorktreeSweepCache } from "./worktreeSweepCache";
import { scanProcesses, runTempSweepInHelper } from "../tempSweep";
import { diskVolumes, observeDiskPressure } from "../state/diskPressure";
import { allocatedBytes } from "./worktreeSweep";
console.log = (...args) => console.error(...args);
const directory = process.env.SWEEP_TEST_ROOT!;
const cache = new WorktreeSweepCache(path.join(directory, "cache.json"));
const tree = path.join(directory, "tree");
for await (const line of createInterface({ input: process.stdin })) {
  const { mode, kind, env } = JSON.parse(line);
  if (mode === "on" || kind && kind !== "worktrees") {
    if (process.argv.includes("--hang")) { process.on("SIGTERM", () => {}); fs.writeFileSync(path.join(directory,"busy-pid"), String(process.pid)); while (true) {} }
    if (process.argv.includes("--exit")) process.exit(3);
    if (process.argv.includes("--malformed")) { process.stdout.write("bad reply\n"); continue; }
    if (process.argv.includes("--wrong-kind")) {
      process.stdout.write(JSON.stringify({ report: !kind || kind === "worktrees"
        ? { at: "2026-10-18T00:00:00Z", volumes: [], consumers: [] } : { kept: [], removed: [], errors: [] } }) + "\n");
      continue;
    }
    if (process.argv.includes("--oversize")) { process.stdout.write("x".repeat(9 * 1024 * 1024)); continue; }
  }
  if (kind === "temp" || kind === "disk-pressure") {
    fs.appendFileSync(path.join(directory, "requests"), kind + "\n");
    const proc = path.join(directory, "proc");
    const scan = fs.existsSync(proc) ? scanProcesses(proc) : { ownNamespace: null, processes: [] };
    const report = kind === "temp" ? await runTempSweepInHelper({ ...process.env,
      LLV_TEMP_SWEEP: env?.LLV_TEMP_SWEEP === "off" ? "off" : "dry-run", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" }, {
      roots: [{ path: directory, via: "" }], scan,
      now: () => Date.parse("2026-10-18T00:00:00Z"), mountPoints: () => [],
    }) : observeDiskPressure(diskVolumes(Array.from({ length: 932 }, (_, i) => ({ role: "worktrees", directory: path.join(directory, `tree-${i}`) }))), null, "2026-10-18T00:00:00Z");
    process.stdout.write(JSON.stringify({ report }) + "\n");
    continue;
  }
  // An unchanged warm pass uses the persisted allocation inventory. Expiry
  // and watcher events force another walk, never a cached removal decision.
  const bytes = await cache.allocation(tree, "kept", [], new Set(), () => allocatedBytes(tree));
  cache.persist();
  process.stdout.write(JSON.stringify({report:{at:"2026-10-18T00:00:00.000Z",mode,repositories:[],removed:[],removedBytes:0,trimmed:[],trimmedBytes:0,
    kept:[{path:tree,reason:"no-merged-pr",bytes}],keptCounts:{"no-merged-pr":1},keptBytes:{"no-merged-pr":bytes},errors:[],cacheStats:{...cache.stats}}})+"\n");
}
cache.close();
