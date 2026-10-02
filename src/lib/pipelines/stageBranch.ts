import type { ExecPort } from "@/lib/workflows/provision";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import path from "node:path";

import { commitPipelineStage, reconcilePipelineStageHead, type PipelineGitResult, type ProvisionExecPort } from "./git";
import type { Pipeline, PipelineStageAttempt } from "./types";

export type StageBranchProtection = { branch: string; head: string; error: string | null };

/** Forge reads run before the controller mutation. Pin the observation to the
    local branch/head so a changed checkout cannot reuse its protection check. */
export async function observeStageBranchProtection(pipeline: Pipeline, exec: ExecPort, remoteExec: ProvisionExecPort): Promise<StageBranchProtection | null> {
  const attempt = pipeline.runs.find((run) => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1);
  if (attempt?.effectiveRole.access !== "read-write" || (pipeline.state !== "running" && pipeline.state !== "needs_decision")) return null;
  const checkedOut = exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
  const branch = attempt.branchAdoption?.branch ?? checkedOut.stdout.trim();
  const deliveryBranch = pipeline.delivery?.disposition === "owner" ? pipeline.delivery.target.branch.replace(/^refs\/heads\//, "") : null;
  if (typeof branch !== "string" || !branch || branch === pipeline.branch || branch === deliveryBranch) return null;
  const head = exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], pipeline.worktreeDir).stdout.trim();
  const observation: StageBranchProtection = { branch, head, error: null };
  if ([pipeline.baseBranch, "main", "master", "trunk", "develop"].includes(branch)) return observation;
  const remote = pipeline.delivery?.target.remote || "origin";
  const url = exec("git", ["remote", "get-url", remote], pipeline.worktreeDir);
  const resolvedRemote = url.code === 0 ? url.stdout.trim() : remote;
  const repository = githubRepositoryOfRemote(resolvedRemote);
  if (!repository) {
    // Local remotes have no forge branch-protection mechanism.
    if (/^(?:\/|\.\.?\/|file:\/\/)/.test(resolvedRemote)) return observation;
    if (url.code !== 0 && remote === "origin") {
      const remotes = exec("git", ["remote"], pipeline.worktreeDir);
      if (remotes.code === 0 && !remotes.stdout.trim()) return observation;
    }
    return { ...observation, error: "the remote forge's stage branch protection cannot be verified" };
  }
  const present = await remoteExec("timeout", ["--signal=KILL", "5s", "git", "ls-remote", "--heads", remote, `refs/heads/${branch}`], pipeline.worktreeDir);
  if (present.code !== 0) return { ...observation, error: "the stage branch's remote protection cannot be verified" };
  if (!present.stdout.trim()) return observation; // Unpublished local branch; no remote branch is adopted or modified.
  const protection = await remoteExec("timeout", ["--signal=KILL", "5s", "gh", "api", `repos/${repository}/branches/${encodeURIComponent(branch)}`, "--jq", ".protected"], pipeline.worktreeDir);
  if (protection.code !== 0 || !["true", "false"].includes(protection.stdout.trim())) return { ...observation, error: "the stage branch's forge protection cannot be verified" };
  return { ...observation, error: protection.stdout.trim() === "true" ? "the stage is on a protected forge branch" : null };
}

/** A writable attempt owns its dedicated checkout, but cannot borrow another
    lane's branch. Preserve the source ref and all accepted content. */
export function commitAndAdoptStageBranch(
  pipeline: Pipeline,
  stageId: string,
  exec: ExecPort,
  pipelines: () => readonly Pipeline[],
  adoption: PipelineStageAttempt["branchAdoption"],
  recordAdoption: (intent: NonNullable<PipelineStageAttempt["branchAdoption"]>) => void,
  protection: StageBranchProtection | null | undefined,
): PipelineGitResult {
  const cwd = pipeline.worktreeDir;
  const branch = exec("git", ["branch", "--show-current"], cwd);
  if (branch.code !== 0) return { ok: false, error: `checking the stage branch: ${branch.stderr.trim()}` };
  const checkedOut = branch.stdout.trim();
  if (adoption && (typeof adoption.branch !== "string" || typeof adoption.target !== "string"
    || typeof adoption.head !== "string" || !/^[0-9a-f]{40}$/i.test(adoption.head)
    || (adoption.adoptedHead !== undefined && (typeof adoption.adoptedHead !== "string" || !/^[0-9a-f]{40}$/i.test(adoption.adoptedHead))))) {
    return { ok: false, error: "adopting the stage branch: the recorded adoption is invalid" };
  }
  const source = adoption?.branch ?? checkedOut;
  const deliveryBranch = pipeline.delivery?.disposition === "owner"
    ? pipeline.delivery.target.branch.replace(/^refs\/heads\//, "") : null;
  const refused = (reason: string): PipelineGitResult => ({ ok: false, error: `adopting the stage branch: ${reason}` });
  const commonDirectory = (repoDir: string): string | null => {
    const result = exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoDir);
    return result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : null;
  };
  const pipelineCommonDir = commonDirectory(pipeline.repoDir);
  const others = pipelines().filter((other) => {
    if (other.id === pipeline.id) return false;
    if (other.repoDir === pipeline.repoDir || (pipeline.delivery
      && other.delivery?.target.repository === pipeline.delivery.target.repository)) return true;
    return pipelineCommonDir !== null && commonDirectory(other.repoDir) === pipelineCommonDir;
  });
  const ownedByOther = (name: string) => others.some((other) => other.branch === name
    || (other.delivery?.active && other.delivery.target.branch === `refs/heads/${name}`));
  if (ownedByOther(source)) return refused("another pipeline owns the stage branch");
  if (!adoption && source === pipeline.branch) return commitPipelineStage(pipeline, stageId, true, exec);
  if (!adoption && source === deliveryBranch) {
    if (!pipeline.delivery?.active || pipeline.delivery.publish !== "enabled" || pipeline.delivery.ownerId !== pipeline.id) return refused("the delivery branch claim was released");
    return commitPipelineStage(pipeline, stageId, true, exec);
  }
  if (!source) return refused("the stage left a detached head");
  if (adoption && checkedOut !== source && checkedOut !== adoption.target) return refused("the checkout moved away from its recorded adoption");
  const defaultBranch = exec("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if ([pipeline.baseBranch, "main", "master", "trunk", "develop", defaultBranch.stdout.trim().replace(/^refs\/remotes\/origin\//, "")].includes(source)) {
    return refused("the stage is on a protected base branch");
  }
  const head = exec("git", ["rev-parse", "--verify", `refs/heads/${source}`], cwd);
  const laneTip = exec("git", ["rev-parse", "--verify", `refs/heads/${pipeline.branch}`], cwd);
  const destination = adoption?.target ?? (laneTip.code === 0 ? pipeline.branch : deliveryBranch);
  if (!destination || (destination !== pipeline.branch && destination !== deliveryBranch)) return refused("there is no owned adoption destination");
  if (ownedByOther(destination) || (destination === deliveryBranch && destination !== pipeline.branch
    && (!pipeline.delivery?.active || pipeline.delivery.publish !== "enabled" || pipeline.delivery.ownerId !== pipeline.id))) {
    return refused("another pipeline owns the adoption destination or its delivery claim was released");
  }
  const target = destination === pipeline.branch ? laneTip : exec("git", ["rev-parse", "--verify", `refs/heads/${destination}`], cwd);
  if (head.code !== 0 || target.code !== 0) return refused("the stage or pipeline branch tip cannot be resolved");
  const sha = head.stdout.trim();
  const targetSha = target.stdout.trim();
  if (!protection || protection.branch !== source || protection.head !== sha) {
    return { ok: false, deferred: true, error: "the stage branch protection observation is missing or stale; retrying settlement after a fresh observation" };
  }
  if (protection.error) return refused(protection.error);
  if (![pipeline.baseRef, pipeline.lastPassedCommit, sha, targetSha].every((value) => /^[0-9a-f]{40}$/i.test(value))) {
    return refused("adoption requires exact base, accepted and branch commit SHAs");
  }
  if (adoption && sha !== adoption.head) return refused("the recorded stage branch head moved before adoption finished");
  const based = exec("git", ["merge-base", "--is-ancestor", pipeline.baseRef, sha], cwd);
  if (based.code !== 0) return refused(`the stage head does not descend from the pipeline base; ${based.stderr.trim()}`);
  // Validate before the controller commits: a protected or foreign branch must
  // never receive even an automatic stage commit.
  const changes = adoption ? exec("git", ["status", "--porcelain"], cwd) : null;
  if (changes && (changes.code !== 0 || changes.stdout.trim())) return refused("the recorded adoption worktree is no longer clean");
  let committed = adoption ? { ok: true as const, sha: adoption.adoptedHead ?? adoption.head } : commitPipelineStage(pipeline, stageId, true, exec);
  if (!committed.ok) return committed;
  const stillOnSource = exec("git", ["branch", "--show-current"], cwd);
  const retained = exec("git", ["merge-base", "--is-ancestor", sha, committed.sha], cwd);
  if (stillOnSource.code !== 0 || stillOnSource.stdout.trim() !== checkedOut || retained.code !== 0) {
    return refused("the stage branch or history moved during its commit");
  }
  if (!adoption) {
    const stageHead = committed.sha;
    const fastForward = exec("git", ["merge-base", "--is-ancestor", targetSha, stageHead], cwd);
    const retainsAccepted = exec("git", ["merge-base", "--is-ancestor", pipeline.lastPassedCommit, stageHead], cwd);
    if (fastForward.code !== 0 && fastForward.code !== 1) return refused("the destination ancestry cannot be verified");
    if (retainsAccepted.code !== 0 && retainsAccepted.code !== 1) return refused("the accepted ancestry cannot be verified");
    if (fastForward.code === 1 || retainsAccepted.code === 1) {
      if (exec("git", ["merge-base", "--is-ancestor", targetSha, pipeline.lastPassedCommit], cwd).code !== 0) return refused("the destination advanced independently of this stage");
      const listing = exec("git", ["worktree", "list", "--porcelain"], cwd);
      if (listing.code !== 0 || listing.stdout.split("\n").includes(`branch refs/heads/${destination}`)) return refused("the adoption destination is held by another worktree");
      // Use the existing accepted-content proof on the stage's tree, then CAS
      // only the lane's destination. The source branch and its PR keep their tip.
      committed = reconcilePipelineStageHead({ ...pipeline, branch: source }, stageHead, exec, {
        branch: destination, head: targetSha,
        prepared: (adoptedHead) => recordAdoption({ branch: source, head: stageHead, target: destination, adoptedHead }),
      });
      if (!committed.ok) return committed;
    } else recordAdoption({ branch: source, head: stageHead, target: destination });
  }
  for (const ancestor of new Set([pipeline.lastPassedCommit, targetSha])) {
    if (exec("git", ["merge-base", "--is-ancestor", ancestor, committed.sha], cwd).code !== 0) return refused("the adoption would drop an accepted or destination tip");
  }
  const switched = exec("git", ["switch", "--no-overwrite-ignore", destination], cwd);
  if (switched.code !== 0) return refused(`returning to the pipeline branch: ${switched.stderr.trim()}`);
  // Git checks the current destination tip again. A concurrent advance cannot
  // be overwritten, and a branch checked out elsewhere cannot be switched to.
  const advanced = exec("git", ["merge", "--ff-only", "--no-overwrite-ignore", committed.sha], cwd);
  if (advanced.code !== 0) {
    // Keep retry on the stage's branch. Otherwise the next committing tick
    // could mistake the unchanged destination tip for the stage's work.
    const restored = exec("git", ["switch", "--no-overwrite-ignore", source], cwd);
    return refused(`fast-forwarding the pipeline branch: ${advanced.stderr.trim()}${restored.code === 0 ? "" : `; restoring the stage branch: ${restored.stderr.trim()}`}`);
  }
  const finalHead = exec("git", ["rev-parse", "HEAD"], cwd);
  const finalBranch = exec("git", ["branch", "--show-current"], cwd);
  if (finalHead.code !== 0 || finalHead.stdout.trim() !== committed.sha || finalBranch.code !== 0 || finalBranch.stdout.trim() !== destination) {
    return refused("the adopted checkout moved before acceptance");
  }
  return committed;
}
