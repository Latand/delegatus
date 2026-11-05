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
  const ref = `refs/heads/${lane.branch}`;
  const directoryOf = (fields: string[]) => fields.find(field => field.startsWith("worktree "))?.slice(9);
  const inspectRegistrations = (output: string) => {
    const registrations = output.split("\0\0").filter(Boolean).map(record => record.split("\0"));
    const holder = registrations.find(fields => fields.includes(`branch ${ref}`)
      && directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) !== ownPath);
    if (holder) throw new Error(`${prefix}; branch ${lane.branch} is held by ${directoryOf(holder)}; release the branch from that worktree or correct the lane directory, then retry the stage`);
    const registration = registrations.find(fields => directoryOf(fields) !== undefined && path.resolve(directoryOf(fields)!) === ownPath);
    if (registration?.some(field => field === "locked" || field.startsWith("locked ")))
      throw new Error(`${prefix}; its worktree registration is locked; resolve the lock and retry the stage`);
    if (registration) {
      const registeredBranch = registration.find(field => field.startsWith("branch "))?.slice(7);
      if (registeredBranch !== ref) {
        const owner = registeredBranch ?? "detached HEAD";
        throw new Error(`${prefix}; its worktree registration belongs to ${owner}; restore its checkout or correct the lane directory, then retry the stage`);
      }
    }
    return registration;
  };
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
    const initial = fs.lstatSync(lane.worktreeDir, { throwIfNoEntry: false });
    if (!initial || initial.isSymbolicLink()) return false;
    const appearedHead = await git(["-C", lane.worktreeDir, "rev-parse", "--verify", "HEAD"]);
    if (appearedHead.code !== 0 || appearedHead.stdout.trim() !== head) return false;
    const afterHead = fs.lstatSync(lane.worktreeDir, { throwIfNoEntry: false });
    if (!afterHead || afterHead.isSymbolicLink() || afterHead.dev !== initial.dev || afterHead.ino !== initial.ino) return false;
    const appearedBranch = await git(["-C", lane.worktreeDir, "symbolic-ref", "--quiet", "HEAD"]);
    if (appearedBranch.code !== 0 || appearedBranch.stdout.trim() !== ref) return false;
    const appearedCommonDir = await gitCommonDir(lane.worktreeDir);
    if (appearedCommonDir !== expectedCommonDir) return false;
    const listing = await git(["worktree", "list", "--porcelain", "-z"]);
    if (listing.code !== 0) throw new Error(`${prefix}; registered worktrees cannot be read; restore repository access, then retry the stage`);
    // A matching HEAD and common git directory can belong to a peer checkout
    // reached through a symlink. Accept only the lane's own registered path,
    // after refreshing locks and branch holders at this successful return.
    const registration = inspectRegistrations(listing.stdout);
    if (!registration || directoryOf(registration) !== ownPath) return false;
    const final = fs.lstatSync(lane.worktreeDir, { throwIfNoEntry: false });
    if (!final || final.isSymbolicLink() || final.dev !== initial.dev || final.ino !== initial.ino) return false;
    return true;
  };
  assertCurrent();
  const repositoryCommonDir = await gitCommonDir(lane.repoDir);
  if (!repositoryCommonDir) throw new Error(`${prefix}; repository identity could not be verified; restore repository access, then retry the stage`);
  if (!missing()) {
    const branchNow = await git(["rev-parse", "--verify", `refs/heads/${lane.branch}^{commit}`]);
    if (branchNow.code === 0 && await verifyAppeared(branchNow.stdout.trim(), `refs/heads/${lane.branch}`, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  const branch = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) {
    if (branch.code === 0 && await verifyAppeared(branch.stdout.trim(), ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (branch.code !== 0) throw new Error(`${prefix}; local branch ${lane.branch} cannot be read; restore the local branch in the repository, then retry the stage`);
  const head = branch.stdout.trim();
  const current = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!missing()) {
    if (current.code === 0 && current.stdout.trim() === head
      && await verifyAppeared(head, ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (current.code !== 0 || current.stdout.trim() !== head)
    throw new Error(`${prefix}; local branch ${lane.branch} changed during recovery; check the branch and retry the stage`);
  // Read registration ownership after every ref read. No asynchronous work
  // may reuse this permission before add; a changed or unknown owner refuses.
  const listing = await git(["worktree", "list", "--porcelain", "-z"]);
  if (listing.code !== 0) throw new Error(`${prefix}; registered worktrees cannot be read; restore repository access, then retry the stage`);
  const registration = inspectRegistrations(listing.stdout);
  if (!missing()) {
    if (await verifyAppeared(head, ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  // One --force replaces only this missing path's stale registration. Git
  // retains other worktrees' indexes and refuses a lock (which needs two).
  // A directory appearing after our lstat is left to Git's nonempty-path guard.
  const added = await git(["worktree", "add", ...(registration ? ["--force"] : []), "--", lane.worktreeDir, lane.branch]);
  // --force also bypasses Git's branch-in-use check. Recheck collisions that
  // arose during add before accepting the checkout or dispatching the stage.
  const restoredListing = await git(["worktree", "list", "--porcelain", "-z"]);
  if (restoredListing.code !== 0) throw new Error(`${prefix}; registered worktrees cannot be read; restore repository access, then retry the stage`);
  inspectRegistrations(restoredListing.stdout);
  if (added.code !== 0 && !missing()) {
    if (await verifyAppeared(head, ref, repositoryCommonDir)) return;
    throw new Error(`${prefix}; a checkout appeared during recovery and could not be verified on ${lane.branch}; inspect it and retry the stage`);
  }
  if (added.code !== 0) throw new Error(`${prefix}; checkout could not be restored; check directory permissions and release any conflicting branch registration, then retry the stage`);
  if (!await verifyAppeared(head, ref, repositoryCommonDir))
    throw new Error(`${prefix}; restored checkout could not be verified on branch ${lane.branch} in its repository; inspect the directory and retry the stage`);
}
