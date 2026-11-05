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
  const ownPath = path.resolve(lane.worktreeDir);
  const gitCommonDir = async (directory: string) => {
    const result = await git(["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (result.code !== 0) return null;
    try { return await fs.promises.realpath(result.stdout.trim()); } catch { return null; }
  };
  const git = async (args: string[]) => {
    assertCurrent();
    if (args[0] === "worktree" && args[1] === "add" && !missing())
      throw new Error(`${prefix}; a directory appeared during recovery; inspect it and retry the stage`);
    const remaining = deadline - performance.now();
    if (signal.aborted || remaining <= 0) throw new Error(`${prefix}; checkout recovery was interrupted; retry the stage`);
    const result = await exec("git", args, lane.repoDir, undefined, { signal, timeoutMs: Math.ceil(remaining) });
    assertCurrent();
    return result;
  };
  const verifyAppeared = async (head: string, ref: string, expectedCommonDir: string) => {
    if (missing()) return false;
    const appearedHead = await git(["-C", lane.worktreeDir, "rev-parse", "--verify", "HEAD"]);
    if (appearedHead.code !== 0 || appearedHead.stdout.trim() !== head || missing()) return false;
    const appearedBranch = await git(["-C", lane.worktreeDir, "symbolic-ref", "--quiet", "HEAD"]);
    if (appearedBranch.code !== 0 || appearedBranch.stdout.trim() !== ref || missing()) return false;
    const appearedCommonDir = await gitCommonDir(lane.worktreeDir);
    return appearedCommonDir === expectedCommonDir && !missing();
  };
  assertCurrent();
  const repositoryCommonDir = await gitCommonDir(lane.repoDir);
  if (!repositoryCommonDir) throw new Error(`${prefix}; repository identity could not be verified; restore repository access, then retry the stage`);
  if (!missing()) {
    const branchNow = await git(["rev-parse", "--verify", `refs/heads/${lane.branch}^{commit}`]);
    if (branchNow.code === 0 && await verifyAppeared(branchNow.stdout.trim(), `refs/heads/${lane.branch}`, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  const ref = `refs/heads/${lane.branch}`;
  const branch = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) {
    if (branch.code === 0 && await verifyAppeared(branch.stdout.trim(), ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (branch.code !== 0) throw new Error(`${prefix}; local branch ${lane.branch} cannot be read; restore the local branch in the repository, then retry the stage`);
  const head = branch.stdout.trim();
  const listing = await git(["worktree", "list", "--porcelain", "-z"]);
  if (!missing()) {
    if (await verifyAppeared(head, ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (listing.code !== 0) throw new Error(`${prefix}; registered worktrees cannot be read; restore repository access, then retry the stage`);
  const registrations = listing.stdout.split("\0\0").filter(Boolean).map(record => record.split("\0"));
  const directoryOf = (fields: string[]) => fields.find(field => field.startsWith("worktree "))?.slice(9);
  const holder = registrations.find(fields => fields.includes(`branch ${ref}`)
    && directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) !== ownPath);
  if (holder) throw new Error(`${prefix}; branch ${lane.branch} is held by ${directoryOf(holder)}; release the branch from that worktree or correct the lane directory, then retry the stage`);
  const registration = registrations.find(fields => directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) === ownPath);
  if (registration) {
    if (registration.some(field => field === "locked" || field.startsWith("locked ")))
      throw new Error(`${prefix}; its worktree registration is locked; resolve the lock and retry the stage`);
    // `worktree remove` recursively deletes the checkout. The path can reappear
    // after our last lstat and before Git starts, so prune stale metadata only:
    // Git never removes files from a worktree, including one recreated during
    // this command. Verify any reappeared checkout against the lane before
    // accepting it; a conflicting directory is left untouched and reported.
    const pruned = await git(["worktree", "prune", "--expire=now"]);
    if (!missing()) {
      if (await verifyAppeared(head, ref, repositoryCommonDir)) return;
      throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
    }
    if (pruned.code !== 0) throw new Error(`${prefix}; its stale worktree registration could not be released; repair that registration and retry the stage`);
  }
  const current = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) {
    if (current.code === 0 && current.stdout.trim() === head
      && await verifyAppeared(head, ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (current.code !== 0 || current.stdout.trim() !== head)
    throw new Error(`${prefix}; local branch ${lane.branch} changed during recovery; check the branch and retry the stage`);
  const added = await git(["worktree", "add", "--", lane.worktreeDir, lane.branch]);
  if (added.code !== 0) throw new Error(`${prefix}; checkout could not be restored; check directory permissions and release any conflicting branch registration, then retry the stage`);
  if (!await verifyAppeared(head, ref, repositoryCommonDir))
    throw new Error(`${prefix}; restored checkout could not be verified on branch ${lane.branch} in its repository; inspect the directory and retry the stage`);
}
