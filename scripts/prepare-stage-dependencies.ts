import { prepareLockedDependencies } from "../src/lib/pipelines/lockedDependencies";
import { spawnSync } from "node:child_process";

// Also runs after a merge, before the stage can interpret compiler diagnostics.
try {
  const prepared = await prepareLockedDependencies(process.cwd());
  // Merge-batch also checks older or generic subjects. Only Delegatus linked
  // worktrees use the fenced shared store; retain the original frozen install
  // for every unmanaged subject, including subjects predating this helper.
  if (!prepared && process.argv.includes("--install-if-unmanaged")) {
    // Private installs may share artifacts, but their writable files need their
    // own inodes: Bun's Linux hardlink backend also shares chmod and writes.
    const result = spawnSync("bun", ["install", "--frozen-lockfile", "--backend=copyfile"], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`dependency installation failed (${result.status ?? "interrupted"})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "stage environment: dependency preparation failed");
  process.exitCode = 1;
}
