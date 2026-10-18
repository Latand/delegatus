import { createInterface } from "node:readline";
import { statePath } from "./configDir";
import { waitForStateLock } from "./state/lockWait";
import { WorktreeSweepCache } from "./pipelines/worktreeSweepCache";
import { productionWorktreeSweepPorts, runWorktreeSweep, type WorktreeSweepMode } from "./pipelines/worktreeSweep";

// stdout is a bounded response protocol; application diagnostics keep their origin.
console.log = (...args) => console.error(...args);
const cache = new WorktreeSweepCache(statePath("worktree-sweep-cache.json"));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    if (line.length > 128) throw new Error("worktree sweep request exceeded its bound");
    const { mode } = JSON.parse(line) as { mode: WorktreeSweepMode };
    if (mode !== "on" && mode !== "dry-run") throw new Error("invalid worktree sweep mode");
    const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: mode }, async mode => {
      const ports = await waitForStateLock("worktrees.sweep.inputs", () => productionWorktreeSweepPorts(mode));
      return { ...ports, cache };
    });
    cache.persist();
    process.stdout.write(JSON.stringify({ report }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
}
cache.close();
