import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { WorktreeSweepCache } from "./worktreeSweepCache";
import { allocatedBytes } from "./worktreeSweep";
const directory = process.env.SWEEP_TEST_ROOT!;
const cache = new WorktreeSweepCache(path.join(directory, "cache.json"));
const tree = path.join(directory, "tree");
for await (const line of createInterface({ input: process.stdin })) {
  const { mode } = JSON.parse(line);
  if (mode === "on") {
    if (process.argv.includes("--hang")) { process.on("SIGTERM", () => {}); fs.writeFileSync(path.join(directory,"busy-pid"), String(process.pid)); while (true) {} }
    if (process.argv.includes("--exit")) process.exit(3);
    if (process.argv.includes("--malformed")) { process.stdout.write("bad reply\n"); continue; }
    if (process.argv.includes("--oversize")) { process.stdout.write("x".repeat(9 * 1024 * 1024)); continue; }
  }
  // An unchanged warm pass uses the persisted allocation inventory. Expiry
  // and watcher events force another walk, never a cached removal decision.
  const bytes = await cache.allocation(tree, "kept", [], new Set(), () => allocatedBytes(tree));
  cache.persist();
  process.stdout.write(JSON.stringify({report:{at:"2026-10-18T00:00:00.000Z",mode,repositories:[],removed:[],removedBytes:0,trimmed:[],trimmedBytes:0,
    kept:[{path:tree,reason:"no-merged-pr",bytes}],keptCounts:{"no-merged-pr":1},keptBytes:{"no-merged-pr":bytes},errors:[],cacheStats:{...cache.stats}}})+"\n");
}
cache.close();
