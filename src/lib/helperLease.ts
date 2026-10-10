import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";

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

export type LeasedHelperOptions = {
  /** The helper reads a request on its standard input: write it to
      `leasedHelperInput(child)`, never to the lease. */
  input?: boolean;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "inherit";
  /** Also end the helper once this Viewer stops owning release traffic. A
      worker the candidate's own requests wait on keeps running until its
      Viewer exits instead. */
  followRelease?: boolean;
};

/* A process that owns no state directory still leases its helpers; they are
   then only unrecorded. */
function leaseStateDirectory(): string {
  try {
    return stateDir();
  } catch {
    return "";
  }
}

/**
 * Starts a non-agent helper that lives no longer than this Viewer process:
 * under bin/helper-lease.mjs, holding the guardian's stdin as its lease. The
 * guardian runs the helper in a process group of its own and ends that whole
 * group when the lease closes (the Viewer exited, however it exited), when
 * this Viewer stops owning release traffic, or when its own owner is gone; it
 * records itself for the launcher that stops this Viewer. The pipe is
 * close-on-exec, so no agent started later inherits the lease. The returned
 * child is the guardian, which exits with the helper's status; its stdout and
 * stderr are the helper's. Agents are never started this way: they outlive
 * their Viewer by design.
 */
export function spawnLeasedHelper(
  name: string,
  spec: LeasedHelperSpec,
  stateDirectory = leaseStateDirectory(),
  options: LeasedHelperOptions = {},
): ChildProcess {
  const port = process.env.PORT?.trim();
  const child = spawn(process.execPath, [helperLeaseEntry(), name, "--", spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: {
      ...spec.env,
      LLV_HELPER_LEASE_STATE: stateDirectory,
      ...(stateDirectory ? { LLV_HELPER_LEASE_TARGET: path.join(stateDirectory, "viewer-release.json") } : {}),
      ...(port && options.followRelease !== false ? { LLV_HELPER_LEASE_PORT: port } : {}),
      ...(options.input ? { LLV_HELPER_LEASE_INPUT: "3" } : {}),
    },
    stdio: ["pipe", options.stdout ?? "ignore", options.stderr ?? "ignore", ...(options.input ? ["pipe" as const] : [])],
  });
  child.stdin?.on("error", () => { /* the guardian's exit reports the failure */ });
  return child;
}

/** The helper's standard input, for a helper started with `input: true`. */
export function leasedHelperInput(child: ChildProcess): Writable {
  const input = child.stdio[3] as Writable | null | undefined;
  if (!input) throw new Error("this helper was started without an input pipe");
  return input;
}

/** Ends the helper's whole process group through its guardian, which then
    exits; a SIGKILL to the guardian would leave the group running. */
export function endLeasedHelper(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

/** Lets this process exit while a helper it does not wait for still runs; the
    helper then ends with it, by its lease. */
export function unrefLeasedHelper(child: ChildProcess): void {
  child.unref();
  for (const stream of child.stdio) (stream as unknown as { unref?: () => void } | null)?.unref?.();
}
