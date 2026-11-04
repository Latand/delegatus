import fs from "node:fs";
import path from "node:path";
import type { ExecPort } from "@/lib/workflows/provision";
import type { Pipeline } from "./types";

/** Recover only an absent checkout from its local branch, preserving the tip
 * instead of resolving the lane's provisioning base again. */
export async function restoreMissingLaneWorktree(
  lane: Pick<Pipeline, "repoDir" | "worktreeDir" | "branch">,
  exec: ExecPort,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<void> {
  const prefix = `lane worktree is missing at ${lane.worktreeDir}`;
  const missing = () => !fs.lstatSync(lane.worktreeDir, { throwIfNoEntry: false });
  const deadline = performance.now() + 60_000;
  const git = async (args: string[]) => {
    assertCurrent();
    if (args[0] === "worktree" && (args[1] === "remove" || args[1] === "add") && !missing())
      throw new Error(`${prefix}; a directory appeared during recovery; inspect it and retry the stage`);
    const remaining = deadline - performance.now();
    if (signal.aborted || remaining <= 0) throw new Error(`${prefix}; checkout recovery was interrupted; retry the stage`);
    const result = await exec("git", args, lane.repoDir, undefined, { signal, timeoutMs: Math.ceil(remaining) });
    assertCurrent();
    return result;
  };
  assertCurrent();
  if (!missing()) return;
  const ref = `refs/heads/${lane.branch}`;
  const branch = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) return;
  if (branch.code !== 0) throw new Error(`${prefix}; local branch ${lane.branch} cannot be read; restore the local branch in the repository, then retry the stage`);
  const head = branch.stdout.trim();
  const listing = await git(["worktree", "list", "--porcelain", "-z"]);
  if (!missing()) return;
  if (listing.code !== 0) throw new Error(`${prefix}; registered worktrees cannot be read; restore repository access, then retry the stage`);
  const registrations = listing.stdout.split("\0\0").filter(Boolean).map(record => record.split("\0"));
  const directoryOf = (fields: string[]) => fields.find(field => field.startsWith("worktree "))?.slice(9);
  const ownPath = path.resolve(lane.worktreeDir);
  const holder = registrations.find(fields => fields.includes(`branch ${ref}`)
    && directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) !== ownPath);
  if (holder) throw new Error(`${prefix}; branch ${lane.branch} is held by ${directoryOf(holder)}; release the branch from that worktree or correct the lane directory, then retry the stage`);
  const registration = registrations.find(fields => directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) === ownPath);
  if (registration) {
    if (registration.some(field => field === "locked" || field.startsWith("locked ")))
      throw new Error(`${prefix}; its worktree registration is locked; resolve the lock and retry the stage`);
    // Git removes this one stale registration without deleting the branch.
    // No force or global prune: other registrations and present files stay.
    const removed = await git(["worktree", "remove", lane.worktreeDir]);
    if (!missing()) return;
    if (removed.code !== 0) throw new Error(`${prefix}; its stale worktree registration could not be released; repair that registration and retry the stage`);
  }
  const current = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) return;
  if (current.code !== 0 || current.stdout.trim() !== head)
    throw new Error(`${prefix}; local branch ${lane.branch} changed during recovery; check the branch and retry the stage`);
  const added = await git(["worktree", "add", "--", lane.worktreeDir, lane.branch]);
  if (added.code !== 0) throw new Error(`${prefix}; checkout could not be restored; check directory permissions and release any conflicting branch registration, then retry the stage`);
  const restored = await git(["-C", lane.worktreeDir, "rev-parse", "HEAD"]);
  if (restored.code !== 0 || restored.stdout.trim() !== head)
    throw new Error(`${prefix}; the branch changed while checking out; inspect the restored directory and retry the stage`);
  const checkedOut = await git(["-C", lane.worktreeDir, "symbolic-ref", "--quiet", "HEAD"]);
  if (checkedOut.code !== 0 || checkedOut.stdout.trim() !== ref)
    throw new Error(`${prefix}; the restored checkout is not on branch ${lane.branch}; inspect the directory and retry the stage`);
}
