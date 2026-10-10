import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";

/* Where the process started: a caller may change directory later. */
const STARTED_IN = process.cwd();

/** The guardian program: beside the Viewer's working directory in a checkout,
    two levels up from a standalone server. */
export function helperLeaseEntry(cwd = process.cwd()): string {
  const override = process.env.LLV_HELPER_LEASE_ENTRY;
  if (override) return override;
  const candidates = [cwd, STARTED_IN].flatMap((root) => [
    path.join(root, "bin", "helper-lease.mjs"),
    path.join(root, "..", "..", "bin", "helper-lease.mjs"),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export type LeasedHelperSpec = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/**
 * Starts a non-agent helper that lives no longer than this Viewer process:
 * under bin/helper-lease.mjs, holding the guardian's stdin as its lease. The
 * guardian runs the helper in a process group of its own and ends that whole
 * group when the lease closes (the Viewer exited, however it exited), when
 * this Viewer stops owning release traffic, or when its own owner is gone; it
 * records itself for the launcher that stops this Viewer. The pipe is
 * close-on-exec, so no agent started later inherits the lease. The returned
 * child is the guardian, which exits with the helper's status. Agents are
 * never started this way: they outlive their Viewer by design.
 */
export function spawnLeasedHelper(name: string, spec: LeasedHelperSpec, stateDirectory = stateDir()): ChildProcess {
  const child = spawn(process.execPath, [helperLeaseEntry(), name, "--", spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: {
      ...spec.env,
      LLV_HELPER_LEASE_STATE: stateDirectory,
      LLV_HELPER_LEASE_TARGET: path.join(stateDirectory, "viewer-release.json"),
      ...(process.env.PORT?.trim() ? { LLV_HELPER_LEASE_PORT: process.env.PORT.trim() } : {}),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin?.on("error", () => { /* the guardian's exit reports the failure */ });
  return child;
}

/** Lets this process exit while a helper it does not wait for still runs; the
    helper then ends with it, by its lease. */
export function unrefLeasedHelper(child: ChildProcess): void {
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
}
