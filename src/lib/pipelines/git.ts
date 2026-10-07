import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realExec, type ExecPort, type ExecResult } from "@/lib/workflows/provision";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import { networkFailureIsTransient } from "@/lib/git/transientFailure";
import { procBackend } from "@/lib/proc";
import { tryLockFenceExclusive } from "@/runtime-host/fenceLock";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { redactBounded, redactMonitorText } from "@/lib/monitor/redact";
import { deliveryJournal, deliveryOwnerError, findPipelineRecord, pipelineArtifactsDir, pipelineDeliveryLookup, withDeliveryMutationAsync } from "./store";

import type { Pipeline, PipelinePublicationFailure, PipelinePublicationResult } from "./types";
import { pathIsDeclaredOutput } from "./stageAccess";
import { CpuContainmentUnavailable, wrapWorkCommand } from "@/lib/runtime/cpuPlacement";
import { isCpuPressureDetail, machineCpuPressureGate, machineCpuPressurePollMs, waitForCpuPressure } from "@/lib/runtime/cpuPressure";
import { CONTROLLER_ARTIFACT_GIT_PATHS, CONTROLLER_ARTIFACT_PATHSPECS, protectExistingControllerArtifacts } from "./controllerArtifacts";

export type PreservedProvisionRef = { ref: string; sha: string; unpublishedCommits: number };
export type PipelineGitResult = ({ ok: true; sha: string; baseBranch?: string } | { ok: false; error: string }) & {
  preservedLocalRef?: PreservedProvisionRef;
  /** The controller must retry this committing attempt after collecting fresh evidence. */
  deferred?: true;
};
export type PipelineBaseResult = { ok: true; baseBranch: string; baseRef: string } | { ok: false; error: string };

function failure(step: string, result: ExecResult): { ok: false; error: string } {
  return { ok: false, error: `${step}: ${(result.stderr || result.stdout || "no output").trim()}` };
}

/** Acceptance must inspect the immutable objects Git actually pushes.
    Replacement refs and legacy grafts otherwise change the local view. */
export function pipelineLiteralGitEnv(env?: Partial<NodeJS.ProcessEnv>): Partial<NodeJS.ProcessEnv> {
  const count = Number(env?.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? "0");
  return {
    ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull,
    // Git emits graft deprecation advice even for this empty graft input.
    // A surviving push must not write that advice into its dead Viewer's pipe.
    // Append to inherited command configuration so unrelated hook settings survive.
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "advice.graftFileDeprecated",
    [`GIT_CONFIG_VALUE_${count}`]: "false",
  };
}

function withLiteralGitObjects(exec: ExecPort): ExecPort {
  return (command, args, cwd, env, options) => exec(command, args, cwd,
    pipelineLiteralGitEnv(env), options);
}

/** The cheap half of {@link resolvePipelineBase}: the branch-name shape, with
    no repository read and no network at all. Create runs this alone (#1799) so
    an invalid base branch is still refused before the record is admitted,
    while the fetch that used to run beside it happens in the controller. */
export function pipelineBaseBranchError(baseBranch: string | undefined): string | null {
  return validBaseBranch(baseBranch?.trim() || DEFAULT_PIPELINE_BASE_BRANCH) ? null : INVALID_BASE_BRANCH;
}

const INVALID_BASE_BRANCH = "the pipeline base branch is invalid";

/** The branch a pipeline resolves its base from when the caller named none. */
export const DEFAULT_PIPELINE_BASE_BRANCH = "main";

function validBaseBranch(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function validPipelineBranch(value: string): boolean {
  return validBaseBranch(value);
}

/* A single-branch fetch of a repository that is already cloned. Since #1799
   no request and no lease holder waits on it: the create call is answered
   before the base is resolved, and the controller fetches outside the registry
   mutation. The bound is what stops an unanswered connection from leaving a
   lane in `provisioning` for ever. */
const BASE_FETCH_TIMEOUT = "60s";

/** `--signal=KILL` takes `timeout` down with its command, so a real expiry
    usually ends on SIGKILL with no exit status at all (#1692). */
function killedAtBound(result: ExecResult): boolean {
  return result.code === 124 || result.code === 137 || result.signal === "SIGKILL";
}

/** Resolves the exact commit a pipeline starts from. Without `baseRef` this
    is the one remote read an internal pipeline makes: a bounded fetch of
    `origin/<base>`, so the worktree starts from the current base (#360). A
    remote that cannot answer parks the lane rather than starting from a stale
    ref. A pinned `baseRef` never touches the network.

    Since #1799 the fetching form runs only in the controller, outside the
    registry lease; a request path that still calls this passes a pinned
    `baseRef`. */
export async function resolvePipelineBase(
  repoDir: string,
  input: { baseBranch?: string; baseRef?: string },
  exec: ExecPort,
): Promise<PipelineBaseResult> {
  const baseBranch = input.baseBranch?.trim() || DEFAULT_PIPELINE_BASE_BRANCH;
  if (!validBaseBranch(baseBranch)) return { ok: false, error: INVALID_BASE_BRANCH };
  const requestedRef = input.baseRef?.trim();
  if (!requestedRef) {
    const fetch = (await exec(
      "timeout",
      ["--signal=KILL", BASE_FETCH_TIMEOUT, "git", "fetch", "--no-tags", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      repoDir,
    ));
    if (killedAtBound(fetch)) return { ok: false, error: `fetching origin/${baseBranch}: git fetch timed out after ${BASE_FETCH_TIMEOUT}` };
    if (fetch.code !== 0) return failure(`fetching origin/${baseBranch}`, fetch);
  }
  const ref = requestedRef || `origin/${baseBranch}`;
  const resolved = (await exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoDir));
  if (resolved.code !== 0) return failure(`resolving pipeline base ${ref}`, resolved);
  const baseRef = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(baseRef)) return { ok: false, error: `resolving pipeline base ${ref}: expected an exact commit SHA` };
  return { ok: true, baseBranch, baseRef };
}

export async function provisionPipelineWorktree(pipeline: Pipeline, exec: ExecPort): Promise<PipelineGitResult> {
  if (!pipeline.baseBranch || !/^[0-9a-f]{40}$/i.test(pipeline.baseRef)) {
    return { ok: false, error: "the pipeline base is unresolved" };
  }
  const add = (await exec("git", ["worktree", "add", "-b", pipeline.branch, pipeline.worktreeDir, pipeline.baseRef], pipeline.repoDir));
  if (add.code !== 0) {
    const probe = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], pipeline.worktreeDir));
    if (probe.code !== 0 || probe.stdout.trim() !== pipeline.branch) return failure("git worktree add", add);
  }
  const base = (await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir));
  if (base.code !== 0 || !base.stdout.trim()) return failure("resolving the pipeline base ref", base);
  if (base.stdout.trim() !== pipeline.baseRef) return { ok: false, error: "the pipeline worktree does not match its persisted base" };
  return { ok: true, sha: pipeline.baseRef, baseBranch: pipeline.baseBranch };
}

/** Git canonicalizes a worktree's parent path in its registration. */
function worktreePathMatches(registeredPath: string | undefined, lanePath: string): boolean {
  if (!registeredPath) return false;
  if (registeredPath === lanePath) return true;
  try { return fs.realpathSync(registeredPath) === fs.realpathSync(lanePath); }
  catch { return false; } // A missing path cannot prove this is the lane's checkout.
}

/** Provisioning uses the same bounded executor with a cancellation signal. */
export type ProvisionExecPort = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<ExecResult>;
export const realProvisionExec: ProvisionExecPort = async (command, args, cwd, signal) =>
  await realExec(command, args, cwd, undefined, { signal });

export async function resolvePipelineBaseAsync(
  repoDir: string,
  input: { baseBranch?: string; baseRef?: string },
  exec: ProvisionExecPort,
  signal?: AbortSignal,
): Promise<PipelineBaseResult> {
  const baseBranch = input.baseBranch?.trim() || DEFAULT_PIPELINE_BASE_BRANCH;
  if (!validBaseBranch(baseBranch)) return { ok: false, error: INVALID_BASE_BRANCH };
  const requestedRef = input.baseRef?.trim();
  if (!requestedRef) {
    const fetch = await exec("timeout",
      ["--signal=KILL", BASE_FETCH_TIMEOUT, "git", "fetch", "--no-tags", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], repoDir, signal);
    if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
    if (killedAtBound(fetch)) return { ok: false, error: `fetching origin/${baseBranch}: git fetch timed out after ${BASE_FETCH_TIMEOUT}` };
    if (fetch.code !== 0) return failure(`fetching origin/${baseBranch}`, fetch);
  }
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  const ref = requestedRef || `origin/${baseBranch}`;
  const resolved = await exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoDir, signal);
  if (resolved.code !== 0) return failure(`resolving pipeline base ${ref}`, resolved);
  const baseRef = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(baseRef)) return { ok: false, error: `resolving pipeline base ${ref}: expected an exact commit SHA` };
  return { ok: true, baseBranch, baseRef };
}

export async function provisionPipelineWorktreeAsync(pipeline: Pipeline, exec: ProvisionExecPort, signal?: AbortSignal): Promise<PipelineGitResult> {
  const preservation: { value?: PreservedProvisionRef } = {};
  const result = await provisionPipelineCheckout(pipeline, exec, preservation, signal);
  return preservation.value ? { ...result, preservedLocalRef: preservation.value } : result;
}

async function provisionPipelineCheckout(pipeline: Pipeline, exec: ProvisionExecPort,
  preservation: { value?: PreservedProvisionRef }, signal?: AbortSignal): Promise<PipelineGitResult> {
  if (!pipeline.baseBranch || !/^[0-9a-f]{40}$/i.test(pipeline.baseRef)) return { ok: false, error: "the pipeline base is unresolved" };
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  const legacy = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${pipeline.branch}`], pipeline.repoDir, signal);
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  const deliveryBranch = pipeline.delivery?.disposition === "owner"
    ? pipeline.delivery.target.branch.replace(/^refs\/heads\//, "") : pipeline.branch;
  // Preserve older lane refs. A delivery ref held by another worktree uses a
  // lane ref too; publication still fences and writes the delivery target.
  let branch = legacy.code === 0 ? pipeline.branch : deliveryBranch;
  if (!validPipelineBranch(branch)) return { ok: false, error: "the pipeline branch is invalid" };
  const localRef = await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], pipeline.repoDir, signal);
  const localSha = localRef.code === 0 ? localRef.stdout.trim() : null;
  const owner = pipeline.delivery ? pipelineDeliveryLookup({ ...pipeline.delivery.target, active: true }) : null;
  const sameOwner = owner?.id === pipeline.id && owner.createdAt === pipeline.createdAt
    && owner.worktreeDir === pipeline.worktreeDir && owner.repoDir === pipeline.repoDir
    && owner.delivery?.target.remote === pipeline.delivery?.target.remote
    && deliveryOwnerError(pipeline, owner) === null;
  const operation = sameOwner ? owner?.delivery?.operation : undefined;
  const resumesPublication = !!operation && operation.epoch === pipeline.delivery?.epoch
    && operation.sha === localSha && (operation.state === "pending" || operation.state === "running");
  let ownsCheckout = false;
  if (deliveryBranch !== pipeline.branch) {
    const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], pipeline.repoDir, signal);
    if (listing.code !== 0) return failure("checking ownership of the existing pipeline branch", listing);
    const entries = listing.stdout.split("\0\0").map((record) => record.split("\0"));
    ownsCheckout = entries.some((fields) => fields.includes(`branch refs/heads/${branch}`)
      && worktreePathMatches(fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length), pipeline.worktreeDir));
    if (legacy.code === 0 && !ownsCheckout && !resumesPublication) {
      const holder = entries.find((fields) => fields.includes(`branch refs/heads/${pipeline.branch}`));
      const holdingPath = holder?.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
      const location = holdingPath ? `; it is held by worktree ${holdingPath}` : " and has no registered lane worktree";
      return { ok: false, error: `pipeline branch ${pipeline.branch} already exists${location}; preserve it and choose a new pipeline branch/worktree or resume its owning lane` };
    }
  }
  const resumesLocal = (ownsCheckout && sameOwner) || resumesPublication;
  const holdsInitialPin = pipeline.baseRefPinned && localSha === pipeline.baseRef;
  const backupPrefix = `refs/backup/provision-unpublished/${pipeline.branch}/`;
  if (legacy.code === 0 && resumesLocal) {
    // A crash can leave a complete checkout before its outcome is persisted.
    // The ref itself carries the lane and count needed to replay its evidence.
    const backups = await exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", backupPrefix], pipeline.repoDir, signal);
    if (backups.code !== 0) return failure("recovering provisioning backup evidence", backups);
    for (const record of backups.stdout.trim().split("\n")) {
      const [ref, sha] = record.split(" ");
      const match = ref?.startsWith(backupPrefix) ? ref.slice(backupPrefix.length).match(/^([1-9][0-9]*)-([0-9a-f]{40})$/) : null;
      if (match && sha === match[2] && Number.isSafeInteger(Number(match[1]))) {
        preservation.value = { ref, sha, unpublishedCommits: Number(match[1]) };
        break;
      }
    }
  }
  let remoteSha: string | null = null;
  if (deliveryBranch !== pipeline.branch && pipeline.delivery?.target.remote) {
    const remote = pipeline.delivery.target.remote;
    const ref = pipeline.delivery.target.branch;
    const probe = await exec("git", ["ls-remote", "--heads", remote, ref], pipeline.repoDir, signal);
    if (probe.code !== 0) return failure("checking the delivery branch before checkout", probe);
    remoteSha = probe.stdout.trim().split(/\s+/)[0] || null;
    if (remoteSha && !/^[0-9a-f]{40}$/i.test(remoteSha)) return { ok: false, error: "the delivery branch has no exact commit SHA" };
    if (remoteSha && remoteSha !== localSha) {
      const fetched = await exec("git", ["fetch", "--no-tags", remote, ref], pipeline.repoDir, signal);
      if (fetched.code !== 0) return failure("fetching the delivery branch before checkout", fetched);
      const present = await exec("git", ["cat-file", "-e", `${remoteSha}^{commit}`], pipeline.repoDir, signal);
      if (present.code !== 0) return { ok: false, error: "the delivery branch moved during fetch; retry provisioning at its current head" };
      if (localSha) {
        const localContainsRemote = await exec("git", ["merge-base", "--is-ancestor", remoteSha, localSha], pipeline.repoDir, signal);
        const remoteContainsLocal = await exec("git", ["merge-base", "--is-ancestor", localSha, remoteSha], pipeline.repoDir, signal);
        if (resumesLocal && !holdsInitialPin && localContainsRemote.code !== 0 && remoteContainsLocal.code !== 0) {
          return { ok: false, error: `delivery branch ${branch} has divergent local and remote commits; merge or choose the preserved tip before starting the lane` };
        }
      }
    }
  }
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  const start = resumesLocal ? localSha ?? remoteSha ?? pipeline.baseRef
    : pipeline.baseRefPinned ? pipeline.baseRef : remoteSha ?? pipeline.baseRef;
  if (!resumesLocal && localSha && localSha !== start && deliveryBranch !== pipeline.branch) {
    const count = await exec("git", ["rev-list", "--count", `${remoteSha ?? pipeline.baseRef}..${localSha}`], pipeline.repoDir, signal);
    if (count.code !== 0) return failure("counting unpublished delivery commits", count);
    const unpublishedCommits = Number(count.stdout.trim());
    if (!Number.isSafeInteger(unpublishedCommits) || unpublishedCommits < 0) return { ok: false, error: "invalid unpublished delivery commit count" };
    if (unpublishedCommits > 0) {
      // Content-addressed and create-only: retries retain the same backup,
      // and no provisioning attempt can overwrite an earlier preserved tip.
      const ref = `${backupPrefix}${unpublishedCommits}-${localSha}`;
      const backup = await exec("git", ["update-ref", ref, localSha, "0".repeat(40)], pipeline.repoDir, signal);
      if (backup.code !== 0) {
        const existing = await exec("git", ["rev-parse", "--verify", ref], pipeline.repoDir, signal);
        if (existing.code !== 0 || existing.stdout.trim() !== localSha) return failure("preserving unpublished delivery commits", backup);
      }
      preservation.value = { ref, sha: localSha, unpublishedCommits };
    }
    // Keep the delivery ref and any holder untouched, even when it is free.
    branch = pipeline.branch;
  }
  const reuseLocal = localSha && (resumesLocal || localSha === start) && branch !== pipeline.branch;
  let expectedHead = start;
  const addArgs = (deliveryBranch === pipeline.branch ? localSha : legacy.code === 0 || reuseLocal)
    ? ["worktree", "add", pipeline.worktreeDir, branch]
    : ["worktree", "add", "-b", branch, pipeline.worktreeDir, start];
  let add = await exec("git", addArgs, pipeline.repoDir, signal);
  if (!signal?.aborted && add.code !== 0 && !add.signal && add.code !== null && !killedAtBound(add)) {
    const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], pipeline.repoDir, signal);
    if (listing.code !== 0) return failure("checking which worktree holds the pipeline branch", listing);
    const holder = listing.stdout.split("\0\0").map((record) => record.split("\0"))
      .find((fields) => fields.includes(`branch refs/heads/${branch}`)
        && !worktreePathMatches(fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length), pipeline.worktreeDir));
    if (holder) {
      const holdingPath = holder.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
      if (branch === pipeline.branch) {
        return { ok: false, error: `pipeline branch ${branch} is held by worktree ${holdingPath}; choose a new pipeline branch/worktree or resume its owning lane; the holding worktree was left untouched` };
      }
      branch = pipeline.branch;
      if (!validPipelineBranch(branch)) return { ok: false, error: "the pipeline branch is invalid" };
      add = await exec("git", ["worktree", "add", "-b", branch, pipeline.worktreeDir, start], pipeline.repoDir, signal);
      if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
      if (add.code !== 0) return { ok: false, error: `delivery branch ${deliveryBranch} is held by worktree ${holdingPath}; creating lane branch ${branch} failed; resolve the lane branch/path conflict and retry provisioning: ${(add.stderr || add.stdout).trim()}` };
    }
  }
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  if (killedAtBound(add)) return { ok: false, error: "git worktree add: checkout interrupted or timed out after 60s" };
  if (add.signal || add.code === null) return failure("git worktree add interrupted", add);
  let finishedInterruptedCheckout = false;
  if (add.code !== 0) {
    const probe = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], pipeline.worktreeDir, signal);
    if (probe.code !== 0 || probe.stdout.trim() !== branch) return failure("git worktree add", add);
    // Git writes the branch and HEAD before checkout finishes. A killed
    // checkout leaves its initialization lock, even when no files were written.
    const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], pipeline.worktreeDir, signal);
    if (listing.code !== 0) return failure("checking pipeline worktree initialization", listing);
    const entry = listing.stdout.split("\0\0").map((record) => record.split("\0"))
      .find((fields) => fields.includes(`branch refs/heads/${branch}`));
    if (!entry || entry.some((field) => field.startsWith("prunable"))) {
      return { ok: false, error: "the pipeline worktree has not finished initializing" };
    }
    if (entry.includes("locked initializing")) {
      const finished = await finishInterruptedCheckout(pipeline, branch, start, exec, signal);
      if (!finished.ok) return finished;
      finishedInterruptedCheckout = true;
    }
    // Preserve existing files; a retry may adopt only a complete tracked tree.
    // Untracked files do not affect completeness and remain untouched.
    const tracked = await exec("git", ["diff", "--quiet", "HEAD", "--"], pipeline.worktreeDir, signal);
    if (tracked.code === 1) return { ok: false, error: "the pipeline worktree has incomplete or modified tracked files" };
    if (tracked.code !== 0) return failure("checking pipeline worktree tracked files", tracked);
  }
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  if (resumesLocal && localSha && remoteSha && localSha !== remoteSha
    && !holdsInitialPin) {
    const remoteContainsLocal = await exec("git", ["merge-base", "--is-ancestor", localSha, remoteSha], pipeline.worktreeDir, signal);
    if (remoteContainsLocal.code === 0) {
      const merged = await exec("git", ["merge", "--ff-only", "--no-overwrite-ignore", remoteSha], pipeline.worktreeDir, signal);
      if (merged.code !== 0) return failure("fast-forwarding the delivery branch before production", merged);
      expectedHead = remoteSha;
    }
  }
  const base = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir, signal);
  if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
  if (base.code !== 0 || !base.stdout.trim()) return failure("resolving the pipeline base ref", base);
  if (deliveryBranch === pipeline.branch && base.stdout.trim() !== pipeline.baseRef) {
    return { ok: false, error: "the pipeline worktree does not match its persisted base" };
  }
  if (base.stdout.trim() !== expectedHead) {
    return { ok: false, error: "the pipeline worktree does not match its selected start commit" };
  }
  if (finishedInterruptedCheckout) {
    const unlock = await exec("git", ["worktree", "unlock", pipeline.worktreeDir], pipeline.repoDir, signal);
    if (unlock.code !== 0) return failure("unlocking the finished pipeline checkout", unlock);
  }
  return { ok: true, sha: base.stdout.trim(), baseBranch: pipeline.baseBranch };
}

/** What a retry says while a live Git process still initializes the worktree
    a previous attempt began. The controller retries it; nothing is touched. */
export const WORKTREE_INITIALIZATION_HELD = "the pipeline worktree is still being initialized by git process";

/** A live Git process working on this checkout: the add that created it
    names it in its argv, its checkout child carries it as GIT_WORK_TREE, and
    anything else runs inside it. Only Git writes a checkout's index. */
function liveGitOwner(worktreeDir: string): number | null {
  const inside = (candidate: string | null) => candidate === worktreeDir || Boolean(candidate?.startsWith(`${worktreeDir}${path.sep}`));
  for (const candidate of procBackend.listProcesses()) {
    if (!/^git(?:-|$)/.test(path.basename(candidate.argv[0] ?? ""))) continue;
    if (candidate.argv.includes(worktreeDir) || inside(candidate.cwd)
      || procBackend.readEnvVar(candidate.pid, "GIT_WORK_TREE") === worktreeDir) return candidate.pid;
  }
  return null;
}

/**
 * Finishes the checkout a killed `git worktree add` began (#2176).
 *
 * `git worktree add` locks the new entry `initializing`, writes the branch and
 * HEAD, runs `git reset --hard` to populate it, and unlocks. A child killed at
 * its bound stops between the second and the last step: the lock stays, the
 * index lock its checkout held stays, and every later attempt used to refuse
 * the entry for ever. With no Git process left on the checkout, doing the two
 * remaining steps is exactly what Git itself would have done. It runs only
 * while the checkout sits at the commit the add was creating, so no stage can
 * have run in it. It rebuilds the index and checks out only missing files;
 * checkout-index never overwrites a file that appeared after the safety scan.
 */
async function finishInterruptedCheckout(pipeline: Pipeline, branch: string, start: string, exec: ProvisionExecPort, signal?: AbortSignal): Promise<PipelineGitResult> {
  const owner = liveGitOwner(pipeline.worktreeDir);
  if (owner !== null) return { ok: false, error: `${WORKTREE_INITIALIZATION_HELD} ${owner}` };

  // A worktree path can be occupied by another clone that happens to have
  // the same branch and commit. Prove both the registration and repository
  // identity from the lane's owning repository before touching its lock/index.
  const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], pipeline.repoDir, signal);
  if (listing.code !== 0) return failure("checking the interrupted pipeline worktree registration", listing);
  const entry = listing.stdout.split("\0\0").map((record) => record.split("\0"))
    .find((fields) => fields.includes(`worktree ${pipeline.worktreeDir}`));
  if (!entry || !entry.includes(`branch refs/heads/${branch}`) || !entry.includes("locked initializing")) {
    return { ok: false, error: "the interrupted pipeline checkout is not registered to this lane; preserve it and inspect the repository before retrying" };
  }
  const registeredPath = entry.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
  try {
    if (!registeredPath || fs.realpathSync(registeredPath) !== fs.realpathSync(pipeline.worktreeDir)) {
      return { ok: false, error: "the interrupted pipeline checkout path does not match this lane; preserve it and inspect the repository before retrying" };
    }
  } catch {
    return { ok: false, error: "the interrupted pipeline checkout path does not match this lane; preserve it and inspect the repository before retrying" };
  }
  const commonDir = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], pipeline.worktreeDir, signal);
  const repoCommonDir = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], pipeline.repoDir, signal);
  if (commonDir.code !== 0 || repoCommonDir.code !== 0 || !commonDir.stdout.trim() || !repoCommonDir.stdout.trim()) {
    return failure("verifying the interrupted pipeline checkout repository", commonDir.code !== 0 ? commonDir : repoCommonDir);
  }
  try {
    if (fs.realpathSync(commonDir.stdout.trim()) !== fs.realpathSync(repoCommonDir.stdout.trim())) {
      return { ok: false, error: "the interrupted pipeline checkout belongs to a different repository; preserve it and retry after restoring this lane's worktree path" };
    }
  } catch {
    return { ok: false, error: "the interrupted pipeline checkout repository could not be verified; preserve it and inspect the worktree before retrying" };
  }

  const head = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir, signal);
  if (head.code !== 0) return failure("reading the interrupted pipeline checkout", head);
  if (head.stdout.trim() !== start) {
    return { ok: false, error: `the interrupted pipeline checkout is at ${head.stdout.trim()}, not its start commit ${start}; remove the worktree and retry-stage` };
  }
  // A checkout killed while Git is building its index can leave an empty
  // index, so use the selected start tree as the source of tracked paths.
  const tree = await exec("git", ["ls-tree", "-r", "--full-tree", "-z", "HEAD"], pipeline.worktreeDir, signal);
  if (tree.code !== 0) return failure("checking tracked paths in the interrupted pipeline checkout", tree);
  const trackedEntries = tree.stdout.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\t");
    const [mode = "", type = "", sha = ""] = entry.slice(0, separator).split(" ");
    const file = separator < 0 ? "" : entry.slice(separator + 1);
    return { mode, type, sha, file };
  });
  const collisions: string[] = [];
  const missingTrackedPaths: string[] = [];
  for (const trackedEntry of trackedEntries) {
    if (signal?.aborted) return { ok: false, error: "pipeline provisioning cancelled" };
    if (trackedEntry.type === "commit") continue; // --no-recurse-submodules leaves submodule contents alone.
    const parts = trackedEntry.file.split("/");
    let candidate = pipeline.worktreeDir;
    let fileInfo: fs.Stats | null = null;
    let blocked = false;
    for (let index = 0; index < parts.length; index += 1) {
      candidate = path.join(candidate, parts[index]!);
      try { fileInfo = fs.lstatSync(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { fileInfo = null; break; }
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") { blocked = true; break; }
        return { ok: false, error: `checking interrupted checkout path ${trackedEntry.file}: ${error instanceof Error ? error.message : "filesystem read failed"}` };
      }
      if (index < parts.length - 1 && (!fileInfo.isDirectory() || fileInfo.isSymbolicLink())) { blocked = true; break; }
      if (index === parts.length - 1 && fileInfo.isDirectory()) {
        const hasContent = (directory: string): boolean => fs.readdirSync(directory, { withFileTypes: true }).some((child) => {
          if (child.isDirectory() && !child.isSymbolicLink()) return hasContent(path.join(directory, child.name));
          return true;
        });
        try { blocked = hasContent(candidate); }
        catch (error) { return { ok: false, error: `checking interrupted checkout path ${trackedEntry.file}: ${error instanceof Error ? error.message : "filesystem read failed"}` }; }
      }
    }
    if (blocked) { collisions.push(trackedEntry.file); continue; }
    if (!fileInfo) {
      missingTrackedPaths.push(trackedEntry.file);
      continue; // A missing file is ordinary interrupted checkout state.
    }
    const isExpectedSymlink = trackedEntry.mode === "120000";
    if (fileInfo.isSymbolicLink() !== isExpectedSymlink) {
      return { ok: false, error: `the interrupted pipeline checkout contains a modified tracked path (${trackedEntry.file}); preserve it, move it aside, then retry-stage` };
    }
    if (trackedEntry.mode !== "120000" && trackedEntry.mode !== "160000") {
      const expectedExecutable = trackedEntry.mode === "100755";
      if (Boolean(fileInfo.mode & 0o111) !== expectedExecutable) {
        return { ok: false, error: `the interrupted pipeline checkout contains a modified tracked path (${trackedEntry.file}); preserve it, move it aside, then retry-stage` };
      }
    }
    let actualSha: string;
    if (isExpectedSymlink) {
      // A symlink blob stores the link text. Reading or hashing its path would
      // follow the target and may run content filters, so hash readlink bytes
      // using Git's blob object framing directly.
      let link: Buffer;
      try { link = fs.readlinkSync(candidate, { encoding: "buffer" }); }
      catch (error) { return { ok: false, error: `checking interrupted tracked path ${trackedEntry.file}: ${error instanceof Error ? error.message : "symlink read failed"}` }; }
      actualSha = crypto.createHash("sha1").update(`blob ${link.byteLength}\0`).update(link).digest("hex");
    } else {
      const actual = await exec("git", ["hash-object", `--path=${trackedEntry.file}`, "--", trackedEntry.file], pipeline.worktreeDir, signal);
      if (actual.code !== 0) return failure(`checking interrupted tracked path ${trackedEntry.file}`, actual);
      actualSha = actual.stdout.trim();
    }
    if (actualSha !== trackedEntry.sha) {
      return { ok: false, error: `the interrupted pipeline checkout contains a modified tracked path (${trackedEntry.file}); preserve it, move it aside, then retry-stage` };
    }
  }
  if (collisions.length > 0) {
    return { ok: false, error: `the interrupted pipeline checkout has untracked content blocking tracked paths (${collisions.slice(0, 3).join(", ")}); preserve it, move it aside, then retry-stage` };
  }
  const staged = await exec("git", ["diff", "--cached", "--quiet", "--diff-filter=ACMRT", "HEAD", "--"], pipeline.worktreeDir, signal);
  if (staged.code === 1) return { ok: false, error: "the interrupted pipeline checkout contains staged tracked changes; preserve them, move them aside, then retry-stage" };
  if (staged.code !== 0) return failure("checking staged changes in the interrupted pipeline checkout", staged);
  const stillOwned = liveGitOwner(pipeline.worktreeDir);
  if (stillOwned !== null) return { ok: false, error: `${WORKTREE_INITIALIZATION_HELD} ${stillOwned}` };
  const gitDir = await exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], pipeline.worktreeDir, signal);
  if (gitDir.code !== 0 || !gitDir.stdout.trim()) return failure("locating the interrupted pipeline checkout", gitDir);
  fs.rmSync(path.join(gitDir.stdout.trim(), "index.lock"), { force: true });
  const index = await exec("git", ["read-tree", "HEAD"], pipeline.worktreeDir, signal);
  if (index.code !== 0) return failure("rebuilding the interrupted pipeline checkout index", index);
  // Checkout only files proven missing. If one appears after the scan, Git
  // refuses to overwrite it; every already-present path stays untouched.
  if (missingTrackedPaths.length > 0) {
    const checkout = await exec("git", ["checkout-index", "--", ...missingTrackedPaths], pipeline.worktreeDir, signal);
    if (checkout.code !== 0) return failure("finishing the interrupted pipeline checkout", checkout);
  }
  return { ok: true, sha: start };
}

async function changedWorktreePaths(
  exec: ExecPort,
  cwd: string,
  declaredOutputs: readonly string[] = [],
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const tracked = (await exec("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], cwd));
  if (tracked.code !== 0) return failure("checking tracked stage output paths", tracked);
  const untracked = (await exec("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], cwd));
  if (untracked.code !== 0) return failure("checking untracked stage output paths", untracked);
  let ignoredOutputs = "";
  if (declaredOutputs.length > 0) {
    const ignored = (await exec(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...declaredOutputs, ...CONTROLLER_ARTIFACT_PATHSPECS],
      cwd,
    ));
    if (ignored.code !== 0) return failure("checking ignored declared stage output paths", ignored);
    // A directory declaration does not opt every ignored descendant into a
    // commit. Only a file named exactly by the stage may bypass .gitignore.
    ignoredOutputs = ignored.stdout.split("\0")
      .filter((candidate) => declaredOutputs.includes(candidate))
      .join("\0");
  }
  const paths = `${tracked.stdout}\0${untracked.stdout}\0${ignoredOutputs}`.split("\0").filter(Boolean);
  return { ok: true, paths: [...new Set(paths)] };
}

type StageCommitReceipt = { version: 1; id: string; parent: string; tree: string; paths: string[] };

/** The controller flushes ownership before Git writes. Recovery must prove the
    exact parent, tree, nonce and declared paths; a familiar commit title alone
    never grants a read-only stage permission to have created a commit. */
async function recoverStageCommit(
  receiptFile: string,
  parent: string,
  head: string,
  declaredOutputs: readonly string[],
  exec: ExecPort,
  cwd: string,
): Promise<PipelineGitResult | null> {
  let receipt: StageCommitReceipt;
  try {
    if (fs.statSync(receiptFile).size > 128 * 1024) throw new Error("oversized receipt");
    const value: unknown = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid receipt");
    receipt = value as StageCommitReceipt;
    if (receipt.version !== 1 || !/^[0-9a-f-]{36}$/.test(receipt.id)
      || receipt.parent !== parent || !/^[0-9a-f]{40}$/.test(receipt.tree)
      || !Array.isArray(receipt.paths) || receipt.paths.length === 0
      || !receipt.paths.every((file) => typeof file === "string" && pathIsDeclaredOutput(file, declaredOutputs))) {
      throw new Error("invalid receipt");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, error: "the stage commit ownership receipt could not be verified; preserve the checkout and receipt" };
  }
  const proof = await exec("git", ["show", "-s", "--format=%P%x00%T%x00%B", head], cwd);
  if (proof.code !== 0) return failure("verifying the owned stage commit", proof);
  const [parents, tree, body] = proof.stdout.split("\0");
  if (parents !== receipt.parent || tree !== receipt.tree
    || !body?.split("\n").includes(`Delegatus-Stage-Commit: ${receipt.id}`)) return null;
  const committed = await exec("git", ["diff", "--name-only", "--no-renames", "-z", parent, head, "--"], cwd);
  if (committed.code !== 0) return failure("verifying owned stage output paths", committed);
  const paths = committed.stdout.split("\0").filter(Boolean);
  if (paths.length !== new Set(receipt.paths).size
    || paths.some((file) => !receipt.paths.includes(file) || !pathIsDeclaredOutput(file, declaredOutputs))) return null;
  const remaining = await changedWorktreePaths(exec, cwd, declaredOutputs);
  if (!remaining.ok) return remaining;
  if (remaining.paths.length) return { ok: false, error: "the owned stage commit has newer worktree changes; preserve them before recovery" };
  const unstage = await unstageControllerArtifacts(exec, cwd);
  if (unstage) return unstage;
  return { ok: true, sha: head };
}

export async function commitPipelineStage(
  pipeline: Pipeline,
  stageId: string,
  allowCommit: boolean,
  exec: ExecPort,
  declaredOutputs: readonly string[] = [],
  protectedHead: string | null = allowCommit ? null : pipeline.lastPassedCommit,
  receiptFile?: string,
): Promise<PipelineGitResult> {
  const status = (await exec("git", ["status", "--porcelain", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], pipeline.worktreeDir));
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  const initialHead = (await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir));
  if (initialHead.code !== 0 || !initialHead.stdout.trim()) return failure("recording the passed stage commit", initialHead);
  if (protectedHead !== null && initialHead.stdout.trim() !== protectedHead) {
    if (!allowCommit && receiptFile && declaredOutputs.length) {
      const recovered = await recoverStageCommit(receiptFile, protectedHead, initialHead.stdout.trim(), declaredOutputs, exec, pipeline.worktreeDir);
      if (recovered) return recovered;
    }
    return { ok: false, error: `read-only stage ${stageId} created a commit` };
  }
  const sha = initialHead.stdout.trim();
  const settleWithoutCommit = async (): Promise<PipelineGitResult> => {
    const unstage = await unstageControllerArtifacts(exec, pipeline.worktreeDir);
    return unstage ?? { ok: true, sha };
  };
  let changedOutputPaths: string[] = [];
  if (!allowCommit) {
    if (declaredOutputs.length === 0) {
      if (!status.stdout.trim()) return settleWithoutCommit();
      return { ok: false, error: `read-only stage ${stageId} modified the pipeline worktree` };
    }
    const changed = (await changedWorktreePaths(exec, pipeline.worktreeDir, declaredOutputs));
    if (!changed.ok) return changed;
    const refused = changed.paths.filter((candidate) => !pathIsDeclaredOutput(candidate, declaredOutputs));
    if (refused.length > 0) {
      return { ok: false, error: `read-only stage ${stageId} modified undeclared worktree paths` };
    }
    if (changed.paths.length === 0) return settleWithoutCommit();
    changedOutputPaths = changed.paths;
  } else if (!status.stdout.trim()) {
    return settleWithoutCommit();
  }
  const add = (await exec(
    "git",
    ["add", ...(allowCommit ? ["-A", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS] : ["-f", "-A", "--", ...changedOutputPaths])],
    pipeline.worktreeDir,
  ));
  if (add.code !== 0) return failure("staging the passed stage", add);
  if (!allowCommit) {
    const staged = (await exec(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--", ...declaredOutputs],
      pipeline.worktreeDir,
    ));
    if (staged.code !== 0) return failure("verifying staged declared output paths", staged);
    const stagedPaths = new Set(staged.stdout.split("\0").filter(Boolean));
    const missing = changedOutputPaths.find((candidate) => !stagedPaths.has(candidate));
    if (missing) return { ok: false, error: `declared output ${missing} was not staged` };
  }
  const unstage = await unstageControllerArtifacts(exec, pipeline.worktreeDir);
  if (unstage) return unstage;
  let receipt: StageCommitReceipt | undefined;
  if (!allowCommit && receiptFile && protectedHead && /^[0-9a-f]{40}$/.test(protectedHead)) {
    const tree = await exec("git", ["write-tree"], pipeline.worktreeDir);
    if (tree.code !== 0 || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) return failure("recording the stage commit tree", tree);
    receipt = { version: 1, id: crypto.randomUUID(), parent: protectedHead, tree: tree.stdout.trim(), paths: changedOutputPaths };
    writeJsonDurably(receiptFile, receipt);
  }
  const commit = (await exec("git", ["commit", "-m", `pipeline(${pipeline.id}): complete ${stageId}`,
    ...(receipt ? ["-m", `Delegatus-Stage-Commit: ${receipt.id}`] : [])], pipeline.worktreeDir, controllerCommitIdentityEnv()));
  if (commit.code !== 0) return failure("committing the passed stage", commit);
  const head = (await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir));
  if (head.code !== 0 || !head.stdout.trim()) return failure("recording the passed stage commit", head);
  if (receipt && receiptFile) {
    return await recoverStageCommit(receiptFile, receipt.parent, head.stdout.trim(), declaredOutputs, exec, pipeline.worktreeDir)
      ?? { ok: false, error: "the stage commit differs from its durable ownership receipt; preserve the checkout and receipt" };
  }
  if (!allowCommit) {
    const committed = (await exec(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", initialHead.stdout.trim(), head.stdout.trim(), "--", ...declaredOutputs],
      pipeline.worktreeDir,
    ));
    if (committed.code !== 0) return failure("verifying committed declared output paths", committed);
    const committedPaths = new Set(committed.stdout.split("\0").filter(Boolean));
    const missing = changedOutputPaths.find((candidate) => !committedPaths.has(candidate));
    if (missing) return { ok: false, error: `declared output ${missing} was not committed` };
  }
  return { ok: true, sha: head.stdout.trim() };
}

async function unstageControllerArtifacts(exec: ExecPort, worktreeDir: string): Promise<PipelineGitResult | null> {
  try {
    await protectExistingControllerArtifacts(worktreeDir, exec);
  } catch (error) {
    return { ok: false, error: `protecting controller pipeline artifacts: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  const result = await exec(
    "git",
    ["reset", "--quiet", "HEAD", "--", ...CONTROLLER_ARTIFACT_GIT_PATHS],
    worktreeDir,
  );
  return result.code === 0 ? null : failure("unstaging controller pipeline artifacts", result);
}

export type PipelineWorktreeChanges =
  | { ok: true; paths: string[]; truncated: boolean }
  | { ok: false; error: string };

/** Lists the uncommitted paths a pipeline worktree still holds. Closing a
    pipeline (#670) must never discard stage work, so the close only reads this
    — it reports what it left behind instead of resetting or cleaning. */
export async function pipelineWorktreeChanges(
  pipeline: Pick<Pipeline, "worktreeDir">,
  exec: ExecPort,
  limit = 20,
): Promise<PipelineWorktreeChanges> {
  const status = (await exec("git", ["status", "--porcelain", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], pipeline.worktreeDir));
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  const paths = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    /* Porcelain v1 lines are `XY <path>`; a rename carries `<old> -> <new>`. */
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(" -> ").at(-1)!.trim())
    .filter((entry) => entry.length > 0);
  return { ok: true, paths: paths.slice(0, limit), truncated: paths.length > limit };
}

/** Controlled attributes prove containment independently of repository merge
    drivers. Shadow all merge attributes in a private bare repository that can
    read the lane's objects but writes only its own temporary proof objects. */
async function compareStageTrees(pipeline: Pipeline, head: string, accepted: string, exec: ExecPort,
  options: { parents?: string[]; resolvedTree?: string; resolvedCommit?: string; candidate?: string } = {}): Promise<ExecResult & { resolutionPaths?: string[]; resolutionPreserved?: boolean }> {
  const objects = (await exec("git", ["rev-parse", "--git-path", "objects"], pipeline.worktreeDir));
  if (objects.code !== 0) return objects;
  let proof: string | undefined;
  try {
    proof = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-tree-proof-"));
    fs.mkdirSync(path.join(proof, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(proof, "refs"));
    fs.mkdirSync(path.join(proof, "info"));
    fs.writeFileSync(path.join(proof, "HEAD"), "ref: refs/heads/proof\n");
    fs.writeFileSync(path.join(proof, "config"), "[core]\n\tbare = true\n");
    fs.writeFileSync(path.join(proof, "objects", "info", "alternates"), `${JSON.stringify(path.resolve(pipeline.worktreeDir, objects.stdout.trim()))}\n`);
    fs.writeFileSync(path.join(proof, "info", "attributes"), "* merge=text\n");
    const env = {
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    };
    const compare = async (left: string, right: string) => (await exec("git", [`--git-dir=${proof}`, "merge-tree", "--write-tree", "--name-only", "-z", "--no-messages",
      left, right], pipeline.worktreeDir, env));
    let left = head, right = accepted;
    let result = (await compare(left, right));
    const conflicts = new Set<string>();
    const collectConflicts = () => {
      if (result.code === 1) result.stdout.split("\0").slice(1).filter(Boolean).forEach((file) => conflicts.add(file));
    };
    collectConflicts();
    for (const parent of options.parents ?? []) {
      if (result.code !== 0 && result.code !== 1) return result;
      // Intermediate commits and trees remain entirely inside the proof repo.
      const checkpoint = (await exec("git", [`--git-dir=${proof}`, "commit-tree", result.stdout.split("\0")[0].trim(),
        "-p", left, "-p", right, "-m", "accepted merge proof"], pipeline.worktreeDir, { ...env, ...controllerCommitIdentityEnv() }));
      if (checkpoint.code !== 0) return checkpoint;
      left = checkpoint.stdout.trim();
      right = parent;
      result = (await compare(left, right));
      collectConflicts();
    }
    if (options.resolvedTree && (result.code === 0 || result.code === 1)) {
      const changed = (await exec("git", [`--git-dir=${proof}`, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z",
        "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", result.stdout.split("\0")[0].trim(), options.resolvedTree], pipeline.worktreeDir, env));
      if (changed.code !== 0) return changed;
      const resolutionPaths = [...new Set([...conflicts, ...changed.stdout.split("\0").filter(Boolean)])];
      let resolutionPreserved = false;
      if (resolutionPaths.length && options.candidate && options.resolvedCommit) {
        const automaticTree = result.stdout.split("\0")[0].trim();
        const diff = ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none"];
        let comparable = true;
        for (const file of conflicts) {
          const delta = (await exec("git", [`--git-dir=${proof}`, "--literal-pathspecs", ...diff,
            automaticTree, options.resolvedCommit, "--", file], pipeline.worktreeDir, env));
          if (delta.code !== 0 && delta.code !== 1) return delta;
          // A binary/conflict choice can equal Git's provisional tree. It
          // needs exact evidence, since that tree encodes no resolution delta.
          if (delta.code === 0) {
            const exact = (await exec("git", [`--git-dir=${proof}`, "--literal-pathspecs", ...diff,
              options.candidate, options.resolvedCommit, "--", file], pipeline.worktreeDir, env));
            if (exact.code !== 0 && exact.code !== 1) return exact;
            if (exact.code === 1) { comparable = false; break; }
          }
        }
        if (comparable) {
          const base = (await exec("git", [`--git-dir=${proof}`, "commit-tree", automaticTree, "-p", left, "-p", right,
            "-m", "accepted resolution baseline"], pipeline.worktreeDir, { ...env, ...controllerCommitIdentityEnv() }));
          if (base.code !== 0) return base;
          const candidateTree = (await exec("git", [`--git-dir=${proof}`, "rev-parse", `${options.candidate}^{tree}`], pipeline.worktreeDir, env));
          if (candidateTree.code !== 0) return candidateTree;
          const resolvedTree = (await exec("git", [`--git-dir=${proof}`, "rev-parse", `${options.resolvedCommit}^{tree}`], pipeline.worktreeDir, env));
          if (resolvedTree.code !== 0) return resolvedTree;
          // Graft both trees onto the private baseline. This also works with
          // Git 2.39, whose merge-tree has no explicit merge-base option.
          const candidateProof = (await exec("git", [`--git-dir=${proof}`, "commit-tree", candidateTree.stdout.trim(), "-p", base.stdout.trim(),
            "-m", "candidate resolution proof"], pipeline.worktreeDir, { ...env, ...controllerCommitIdentityEnv() }));
          if (candidateProof.code !== 0) return candidateProof;
          const resolvedProof = (await exec("git", [`--git-dir=${proof}`, "commit-tree", resolvedTree.stdout.trim(), "-p", base.stdout.trim(),
            "-m", "accepted resolution proof"], pipeline.worktreeDir, { ...env, ...controllerCommitIdentityEnv() }));
          if (resolvedProof.code !== 0) return resolvedProof;
          const contained = (await compare(candidateProof.stdout.trim(), resolvedProof.stdout.trim()));
          if (contained.code !== 0 && contained.code !== 1) return contained;
          resolutionPreserved = contained.code === 0 && contained.stdout.split("\0")[0].trim() === candidateTree.stdout.trim();
        }
      }
      return { ...result, code: conflicts.size ? 1 : result.code, resolutionPaths, resolutionPreserved };
    }
    return result;
  } catch (error) {
    return { code: 128, stdout: "", stderr: `isolating the accepted content comparison: ${String(error)}` };
  } finally {
    if (proof) fs.rmSync(proof, { recursive: true, force: true });
  }
}

/** Transfer a pass only across clean main integrations. Ancestry alone also
    admits new lane work. Reconstruct every non-main merge with controlled
    attributes, so an amended merge or a custom driver cannot hide that work. */
export async function verifyPassedHeadIntegration(pipeline: Pipeline, passed: string, accepted: string, exec: ExecPort): Promise<
  { ok: true; passedSha: string; acceptedSha: string; mainSha: string } | { ok: false; error: string }
> {
  const literalExec = withLiteralGitObjects(exec);
  const refuse = (reason: string) => ({ ok: false as const, error: `${reason}; a fresh review is required before accepting this head` });
  const ancestor = await literalExec("git", ["merge-base", "--is-ancestor", passed, accepted], pipeline.worktreeDir);
  if (ancestor.code !== 0) return refuse(ancestor.code === 1
    ? "the previously passed commit is not an ancestor of acceptedSha"
    : "could not verify the previously passed commit is an ancestor of acceptedSha");
  const baseBranch = pipeline.baseBranch || DEFAULT_PIPELINE_BASE_BRANCH;
  if (!validBaseBranch(baseBranch)) return refuse("could not verify the configured main branch");
  const main = await literalExec("git", ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`], pipeline.worktreeDir);
  const mainSha = main.stdout.trim();
  if (main.code !== 0 || !/^[0-9a-f]{40}$/i.test(mainSha)) return refuse(`could not verify origin/${baseBranch}`);
  const introduced = await literalExec("git", ["rev-list", "--parents", accepted, `^${passed}`, `^${mainSha}`], pipeline.worktreeDir);
  if (introduced.code !== 0) return refuse("could not enumerate changes after the passed head");
  for (const line of introduced.stdout.trim().split("\n").filter(Boolean)) {
    const [commit, firstParent, mainParent, ...extra] = line.split(" ");
    if (extra.length || ![commit, firstParent, mainParent].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha))) {
      return refuse("acceptedSha contains additional lane work beyond clean main merges");
    }
    const fromMain = await literalExec("git", ["merge-base", "--is-ancestor", mainParent, mainSha], pipeline.worktreeDir);
    if (fromMain.code !== 0) return refuse("acceptedSha contains a merge from outside the configured main branch");
    const automatic = await compareStageTrees(pipeline, firstParent, mainParent, literalExec);
    if (automatic.code !== 0) return refuse("acceptedSha contains a merge that cannot be proven clean");
    const tree = await literalExec("git", ["rev-parse", `${commit}^{tree}`], pipeline.worktreeDir);
    if (tree.code !== 0 || tree.stdout.trim() !== automatic.stdout.split("\0")[0].trim()) {
      return refuse("acceptedSha contains additional content or resolutions in a main merge");
    }
  }
  return { ok: true, passedSha: passed, acceptedSha: accepted, mainSha };
}

/** `git cherry` strips whitespace before comparing patch IDs. Keep its fast
    history scan, then require the changed file paths, modes, hunk section and
    exact added / removed lines and context to agree before treating a
    whitespace-insensitive match as retained. Line positions are omitted so a
    replay still matches after surrounding lines move on a newer base. */
interface ExactCommitPatch {
  signature: string;
  paths: string[];
  locations: Array<{ path: string; start: number }>;
}

async function exactCommitPatch(pipeline: Pipeline, commit: string, exec: ExecPort): Promise<ExactCommitPatch | null | { error: string }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-patch-"));
  const patchPath = path.join(scratch, "patch.diff");
  try {
    // Keep arbitrarily large binary patches off the executor's bounded stdout
    // buffer. The comparison needs the full patch, so read Git's file output
    // only after Git has completed successfully.
    const patch = (await exec("git", ["diff-tree", "--root", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--ignore-submodules=none", "--binary", "--full-index", "--unified=3", `--output=${patchPath}`, commit], pipeline.worktreeDir));
    if (patch.code !== 0) return { error: failure("reading accepted replay patch", patch).error };
    const names = (await exec("git", ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit], pipeline.worktreeDir));
    if (names.code !== 0) return { error: failure("reading accepted replay paths", names).error };
    const paths = names.stdout.split("\0").filter(Boolean);
    const evidence: string[] = [];
    const locations: ExactCommitPatch["locations"] = [];
    let fileIndex = -1;
    let binary = false;
    let inHunk = false;
    for (const line of fs.readFileSync(patchPath, "utf8").split("\n")) {
      if (line.startsWith("diff --git ")) {
        fileIndex++;
        evidence.push(line);
        binary = false;
        inHunk = false;
      } else if (binary) {
        evidence.push(line);
      } else if (/^(?:old mode|new mode|new file mode|deleted file mode|GIT binary patch|literal |delta )/.test(line)) {
        evidence.push(line);
        binary = line === "GIT binary patch";
      } else if (line.startsWith("@@")) {
        // Keep Git's function/section label (the text after the closing @@) to
        // distinguish different areas of a file; retain old-side coordinates separately.
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
        if (!hunk || !paths[fileIndex]) return { error: "reading accepted replay hunk location: malformed Git patch" };
        locations.push({ path: paths[fileIndex], start: Number(hunk[1]) });
        evidence.push(`@@${hunk[5]}`);
        inHunk = true;
      } else if (inHunk && ((line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
        || line.startsWith("\\ No newline"))) {
        evidence.push(line);
      }
    }
    return evidence.length ? { signature: evidence.join("\n"), paths, locations } : null;
  } catch (error) {
    return { error: `reading accepted replay patch: ${String(error)}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Map a replay hunk's parent-side line to the accepted commit's parent.
    Changes before the hunk shift its coordinate; a change overlapping the
    hunk start makes the location unprovable and must fail closed. */
export async function mapReplayPatchLocation(
  pipeline: Pipeline,
  acceptedCommit: string,
  replayCommit: string,
  location: ExactCommitPatch["locations"][number],
  exec: ExecPort,
): Promise<number | null | { error: string }> {
  const acceptedParent = (await exec("git", ["rev-parse", `${acceptedCommit}^`], pipeline.worktreeDir));
  if (acceptedParent.code !== 0) return { error: failure("reading accepted patch parent", acceptedParent).error };
  const replayParent = (await exec("git", ["rev-parse", `${replayCommit}^`], pipeline.worktreeDir));
  if (replayParent.code !== 0) return { error: failure("reading replay patch parent", replayParent).error };
  const diff = (await exec("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0",
    acceptedParent.stdout.trim(), replayParent.stdout.trim(), "--", location.path], pipeline.worktreeDir));
  if (diff.code !== 0) return { error: failure("mapping replay hunk location", diff).error };
  let delta = 0;
  for (const line of diff.stdout.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const oldCount = Number(hunk[2] ?? 1);
    const newStart = Number(hunk[3]);
    const newCount = Number(hunk[4] ?? 1);
    if (newCount > 0 && location.start >= newStart && location.start < newStart + newCount) return null;
    if (location.start >= newStart + newCount) delta += oldCount - newCount;
    else if (location.start >= newStart) return null;
  }
  return location.start + delta;
}

/** Retained patch history admits subsequent builder edits just as ordinary
    ancestry does. Merge commits have no cherry patch-id; unique merge content
    therefore needs the controlled tree proof. Record the builder's unchanged
    tree with both parents, then CAS the ref. Delivery still owns publication. */
export async function reconcilePipelineStageHead(pipeline: Pipeline, head: string, exec: ExecPort,
  destination?: { branch: string; head: string; prepared: (sha: string) => void | Promise<void> }): Promise<PipelineGitResult> {
  const accepted = pipeline.lastPassedCommit;
  if (!/^[0-9a-f]{40}$/i.test(head) || !/^[0-9a-f]{40}$/i.test(accepted)) {
    return { ok: false, error: "reconciling stage history requires exact commit SHAs" };
  }
  const local = (await currentPipelineBranchHead(pipeline, exec));
  if (!local.ok) return local;
  if (local.sha !== head) return { ok: false, error: "the stage head moved before history reconciliation" };
  const branch = (await exec("git", ["symbolic-ref", "HEAD"], pipeline.worktreeDir));
  if (branch.code !== 0) return failure("pinning the reconciliation branch", branch);
  const ref = branch.stdout.trim();
  const tree = (await exec("git", ["rev-parse", `${head}^{tree}`], pipeline.worktreeDir));
  if (tree.code !== 0) return failure("reading the stage tree", tree);
  const cherry = (await exec("git", ["-c", "diff.ignoreSubmodules=none", "cherry", head, accepted], pipeline.worktreeDir));
  if (cherry.code !== 0) return failure("checking accepted patch history", cherry);
  const cherryLines = cherry.stdout.split("\n").filter((line) => line.startsWith("+ ") || line.startsWith("- "));
  const retainedByCherry = cherryLines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  const replayedPatches: Array<{ commit: string; patch: ExactCommitPatch }> = [];
  const acceptedPatches = new Map<string, ExactCommitPatch>();
  for (const acceptedCommit of retainedByCherry) {
    const patch = (await exactCommitPatch(pipeline, acceptedCommit, exec));
    if (patch && "error" in patch) return { ok: false, error: patch.error };
    if (patch) acceptedPatches.set(acceptedCommit, patch);
  }
  if (retainedByCherry.length) {
    const candidates = (await exec("git", ["rev-list", "--no-merges", `${accepted}..${head}`], pipeline.worktreeDir));
    if (candidates.code !== 0) return failure("checking replayed commit patches", candidates);
    for (const candidate of candidates.stdout.split("\n").filter(Boolean)) {
      // Main-only commits can contain large unrelated assets. Read their small
      // path list first and avoid constructing a full patch unless it could
      // contain one of the accepted changes.
      const names = (await exec("git", ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", candidate], pipeline.worktreeDir));
      if (names.code !== 0) return failure("reading replay candidate paths", names);
      const candidatePaths = new Set(names.stdout.split("\0").filter(Boolean));
      if (![...acceptedPatches.values()].some((patch) => patch.paths.some((file) => candidatePaths.has(file)))) continue;
      const patch = (await exactCommitPatch(pipeline, candidate, exec));
      if (patch && "error" in patch) return { ok: false, error: patch.error };
      if (patch) replayedPatches.push({ commit: candidate, patch });
    }
  }
  const dropped = cherryLines.filter((line) => line.startsWith("+ ")).map((line) => line.slice(2).trim());
  for (const acceptedCommit of retainedByCherry) {
    const acceptedPatch = acceptedPatches.get(acceptedCommit);
    // An empty commit has no patch to preserve. Its SHA need not block a
    // content-based rebase reconciliation.
    if (!acceptedPatch) continue;
    let matched = -1;
    for (let index = 0; index < replayedPatches.length; index++) {
      const replay = replayedPatches[index];
      if (replay.patch.signature !== acceptedPatch.signature
        || replay.patch.locations.length !== acceptedPatch.locations.length) continue;
      let sameLocation = true;
      for (let hunk = 0; hunk < replay.patch.locations.length; hunk++) {
        const replayLocation = replay.patch.locations[hunk];
        if (replayLocation.path !== acceptedPatch.locations[hunk].path) {
          sameLocation = false;
          break;
        }
        const mapped = (await mapReplayPatchLocation(pipeline, acceptedCommit, replay.commit, replayLocation, exec));
        if (mapped && typeof mapped === "object") return { ok: false, error: mapped.error };
        if (mapped === null || mapped !== acceptedPatch.locations[hunk].start) {
          sameLocation = false;
          break;
        }
      }
      if (sameLocation) {
        matched = index;
        break;
      }
    }
    if (matched === -1) dropped.push(acceptedCommit);
    else replayedPatches.splice(matched, 1);
  }
  const merges = (await exec("git", ["rev-list", "--min-parents=2", "--parents", `${head}..${accepted}`], pipeline.worktreeDir));
  if (merges.code !== 0) return failure("checking accepted merge history", merges);
  let replayedCheckpoints: string[] | undefined;
  const droppedMerges: string[] = [];
  for (const line of merges.stdout.trim().split("\n").filter(Boolean)) {
    const [merge, firstParent, ...otherParents] = line.split(" ");
    const trees = (await exec("git", ["rev-parse", `${merge}^{tree}`], pipeline.worktreeDir));
    if (trees.code !== 0) return failure("checking accepted merge content", trees);
    const mergeTree = trees.stdout.trim().split("\n")[0];
    // Compare against all automatically merged parents: a first-parent-only
    // baseline misses resolutions that exclude side-parent changes.
    const reconstructed = (await compareStageTrees(pipeline, firstParent, otherParents[0], exec,
      { parents: otherParents.slice(1), resolvedTree: mergeTree, resolvedCommit: accepted, candidate: head }));
    if (reconstructed.code !== 0 && reconstructed.code !== 1) return failure("reconstructing accepted merge content", reconstructed);
    const resolutionPaths = reconstructed.resolutionPaths;
    if (!resolutionPaths || resolutionPaths.some((file) => file.includes("\uFFFD"))) {
      return { ok: false, error: "accepted merge resolution paths could not be proven" };
    }
    if (resolutionPaths.length === 0 || reconstructed.resolutionPreserved) continue;
    if (!replayedCheckpoints) {
      const candidates = (await exec("git", ["rev-list", `${accepted}..${head}`], pipeline.worktreeDir));
      if (candidates.code !== 0) return failure("checking replayed merge history", candidates);
      replayedCheckpoints = candidates.stdout.trim().split("\n").filter((sha) => sha && sha !== head);
    }
    // Unique resolutions may survive in linear or merged history before later
    // builder edits. A checkpoint must already contain the parents' patches;
    // an older main revision can coincidentally match a later resolution.
    let preserved = false;
    for (const replay of [head, ...replayedCheckpoints]) {
      const compared = (await exec("git", ["--literal-pathspecs", "diff", "--quiet", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none",
        replay, accepted, "--", ...resolutionPaths], pipeline.worktreeDir));
      if (compared.code !== 0 && compared.code !== 1) return failure("comparing replayed merge resolutions", compared);
      if (compared.code === 0) {
        if (replay !== head) {
          const parents = (await exec("git", ["-c", "diff.ignoreSubmodules=none", "cherry", replay, merge], pipeline.worktreeDir));
          if (parents.code !== 0) return failure("checking resolution checkpoint ancestry", parents);
          if (parents.stdout.split("\n").some((line) => line.startsWith("+ "))) continue;
        }
        preserved = true;
        break;
      }
    }
    if (!preserved) droppedMerges.push(merge);
  }
  let missing = droppedMerges.length > 0;
  if (dropped.length > 0) {
    // Squashed patches may still be preserved in the final tree. Unique merge
    // resolutions were checked separately, including exclusions and conflicts.
    const merged = (await compareStageTrees(pipeline, head, accepted, exec));
    if (merged.code !== 0 && merged.code !== 1) return failure("comparing accepted stage content", merged);
    missing ||= merged.code !== 0 || merged.stdout.split("\0")[0].trim() !== tree.stdout.trim();
  }
  if (missing) {
    return { ok: false, error: `stage head ${head} does not preserve accepted head ${accepted}; dropped accepted commits: ${[...dropped, ...droppedMerges].join(", ")}; accepted content is missing or conflicts with the stage tree` };
  }
  const commit = (await exec("git", ["commit-tree", tree.stdout.trim(), "-p", head, "-p", accepted,
    "-m", `pipeline(${pipeline.id}): reconcile rebased stage`], pipeline.worktreeDir, controllerCommitIdentityEnv()));
  if (commit.code !== 0) return failure("recording the stage reconciliation merge", commit);
  const sha = commit.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, error: "reconciliation did not produce an exact commit SHA" };
  const current = (await currentPipelineBranchHead(pipeline, exec));
  if (!current.ok) return current;
  if (current.sha !== head) return { ok: false, error: "the stage head moved during history reconciliation" };
  const currentBranch = (await exec("git", ["symbolic-ref", "HEAD"], pipeline.worktreeDir));
  if (currentBranch.code !== 0 || currentBranch.stdout.trim() !== ref) {
    return { ok: false, error: "the stage branch moved during history reconciliation" };
  }
  // Branch adoption preserves the stage's own ref. Its caller owns and fences
  // the destination, and durably records this merge before changing that ref.
  await destination?.prepared(sha);
  const update = await exec("git", ["update-ref", "-m", "pipeline: reconcile rebased stage", destination ? `refs/heads/${destination.branch}` : ref, sha, destination?.head ?? head], pipeline.worktreeDir);
  if (update.code !== 0) return failure("fencing the stage reconciliation merge", update);
  return { ok: true, sha };
}

export async function resetPipelineStage(pipeline: Pipeline, exec: ExecPort): Promise<PipelineGitResult> {
  if (!pipeline.lastPassedCommit) return { ok: false, error: "the pipeline has no passed-stage commit" };
  const reset = (await exec("git", ["reset", "--hard", pipeline.lastPassedCommit], pipeline.worktreeDir));
  if (reset.code !== 0) return failure("resetting the pipeline stage", reset);
  const clean = (await exec("git", ["clean", "-fd"], pipeline.worktreeDir));
  if (clean.code !== 0) return failure("cleaning the pipeline stage", clean);
  return { ok: true, sha: pipeline.lastPassedCommit };
}

/** Returns the clean checked-out SHA only when this worktree still owns its
    persisted branch. Review evidence must name this exact revision. */
export async function currentPipelineBranchHead(pipeline: Pipeline, exec: ExecPort): Promise<PipelineGitResult> {
  const literalExec = withLiteralGitObjects(exec);
  if (!validPipelineBranch(pipeline.branch)) return { ok: false, error: "the pipeline branch is invalid" };
  const status = (await literalExec("git", ["status", "--porcelain", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], pipeline.worktreeDir));
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  if (status.stdout.trim()) return { ok: false, error: "the pipeline worktree has uncommitted changes; choose whether to commit or discard them before retrying review" };
  const branch = (await literalExec("git", ["branch", "--show-current"], pipeline.worktreeDir));
  if (branch.code !== 0) return failure("checking the pipeline branch", branch);
  const checkedOut = branch.stdout.trim();
  const deliveryBranch = pipeline.delivery?.disposition === "owner"
    ? pipeline.delivery.target.branch.replace(/^refs\/heads\//, "") : null;
  if (checkedOut !== pipeline.branch && checkedOut !== deliveryBranch) {
    return { ok: false, error: "the pipeline worktree is not checked out on its pipeline or delivery branch" };
  }
  const head = (await literalExec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir));
  if (head.code !== 0) return failure("resolving the pipeline branch HEAD", head);
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, error: "resolving the pipeline branch HEAD: expected an exact commit SHA" };
  return { ok: true, sha };
}

export type PipelineRemoteHeadResult =
  | { ok: true; sha: string }
  | { ok: false; error: string; transient: boolean };

/** Reads the authoritative remote pipeline branch without relying on a stale
    tracking ref. Approval fences use this alongside the clean local HEAD. The
    read is time-bounded like the publication read: an unbounded `ls-remote`
    waited out a two-minute SSH connect timeout while holding the pipeline
    mutation (#1692). */
export async function currentPipelineRemoteBranchHead(pipeline: Pipeline, exec: ExecPort): Promise<PipelineRemoteHeadResult> {
  if (!validPipelineBranch(pipeline.branch)) return { ok: false, error: "the pipeline branch is invalid", transient: false };
  const remote = (await readRemotePipelineBranch(pipeline, exec, "checking the remote pipeline branch"));
  if (!remote.ok) return { ok: false, error: remote.error, transient: networkFailureIsTransient(remote.error) };
  if (!/^[0-9a-f]{40}$/i.test(remote.sha)) return { ok: false, error: "the remote pipeline branch has no exact commit SHA", transient: false };
  return { ok: true, sha: remote.sha };
}

export type PipelinePublishResult = PipelinePublicationResult;

/** A captured stream can end before PEM's footer. Consume an opened block
    through EOF before the shared redactor and before any output bounding. */
function redactPublicationText(text: string): string {
  return redactMonitorText(text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted-private-key]"));
}

function redactPublicationOutput(stdout: string, stderr: string): string {
  const streams = [stdout, stderr];
  const openers = streams.map((stream) => stream.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/));
  // Captured streams have no shared ordering. Even a complete armor block
  // can have its body on the other stream. Once a key opens, only its own
  // prefix is proven safe; the footer cannot prove the other bytes safe.
  // With openers on both streams, either prefix can contain the other key's
  // body. No captured prefix is safe to retain in that case.
  if (openers.every((index) => index !== -1)) return "[redacted-private-key]";
  if (openers.some((index) => index !== -1)) return streams.map((stream, i) => openers[i] === -1 ? ""
    : redactPublicationText(`${stream.slice(0, openers[i])}[redacted-private-key]`)).join("\n").trim();
  return redactPublicationText(`${stdout}\n${stderr}`).trim();
}

function publicationFailureDetail(failure: PipelinePublicationFailure): string {
  const status = failure.code === null ? `signal ${failure.signal ?? "unknown"}` : `exit ${failure.code}`;
  return redactPublicationText(`${failure.step}: ${status} (${failure.durationMs} ms)\n${failure.outputTail || "no output"}`);
}

/** The last phase the hook announced with its own `pre-push: <phase>` marker. */
export function publicationFailurePhase(failure: PipelinePublicationFailure): string | null {
  return failure.outputTail.split("\n").map((line) => line.trim())
    .filter((line) => /^pre-push: [^;:]{1,60}$/.test(line)).at(-1)?.slice("pre-push: ".length) ?? null;
}

/** What stopped a publication, in one line a person can act on. The hook's
    phase markers name the phase; `(fail)` lines name tests. */
export function publicationFailureCause(failure: PipelinePublicationFailure): string {
  const status = failure.code === null ? `signal ${failure.signal ?? "unknown"}` : `exit ${failure.code}`;
  if (failure.step === "preparing publication dependencies") return `installing the worktree's dependencies failed (bun install --frozen-lockfile, ${status})`;
  const lines = failure.outputTail.split("\n").map((line) => line.trim());
  const phase = publicationFailurePhase(failure);
  const failed = [...new Set(lines.filter((line) => line.startsWith("(fail) ")).map((line) => line.slice(7).replace(/ \[[\d.]+m?s\]$/, "")))];
  const tests = failed.length ? `, ${failed.length} failing test${failed.length === 1 ? "" : "s"}, first: ${failed[0]!.slice(0, 120)}` : "";
  if (phase) return `the repository's pre-push hook failed in its "${phase}" phase (${status}${tests})`;
  const last = lines.filter(Boolean).at(-1);
  return `git push was refused (${status}${tests})${last ? `: ${last.slice(0, 160)}` : ""}`;
}

/** What a publication's push may take, its repository hook included. */
const PUBLICATION_PUSH_TIMEOUT_MS = 900_000;
/** Left after the hook's deadline for git to send the pack. */
const PUBLICATION_PACK_MARGIN_MS = 60_000;

/** The hook's line for a decisive check its push budget stopped before a
    verdict (NO_VERDICT_PREFIX in scripts/local-gate.ts): the push was
    interrupted, it was not refused. */
const HOOK_NO_VERDICT = /^pre-push: no verdict within the push budget of (\d+) s:/m;
export function hookBudgetStopMs(output: string): number | null {
  const match = HOOK_NO_VERDICT.exec(output);
  return match ? Number(match[1]) * 1000 : null;
}

/** A push that was stopped before it reached the remote, in one line: what
    ended it and which phase the hook had announced. Evidence is absent when
    the Viewer itself died with the push. */
export function publicationInterruptionCause(failure?: PipelinePublicationFailure): string {
  const phase = failure ? publicationFailurePhase(failure) : null;
  if (failure?.hookBudgetMs) {
    return `the pre-push hook's ${Math.round(failure.hookBudgetMs / 60_000)}-minute budget ran out${phase ? ` while its "${phase}" phase was still running` : ""}; it stopped without a verdict and the push did not reach the remote`;
  }
  const ended = failure?.timedOutMs ? `the push ran past its ${Math.round(failure.timedOutMs / 60_000)}-minute limit`
    : failure?.signal ? `the push was ended by ${failure.signal}` : "the push was interrupted";
  return `${ended}${phase ? ` in the hook's "${phase}" phase` : ""} and did not reach the remote`;
}

/** A repository hook is the project's own gate and runs as it would from a
    person's shell. The Viewer's private settings (its interface language, its
    launcher handoff, its token, its state owner) are no part of that: a test
    the hook runs reads them and fails for a reason no branch can fix. Gate
    slot and privacy settings are the hook's own inputs and stay, and so does
    a publication identity or commit guard handed to this process. Anything
    else a publication command needs (forge credentials, say) is spread over
    this result, so the Viewer's settings are removed first. */
export function pipelinePublicationHookEnv(source: NodeJS.ProcessEnv = process.env): Partial<NodeJS.ProcessEnv> {
  const env: Partial<NodeJS.ProcessEnv> = {};
  for (const key of Object.keys(source)) {
    if (key === "NODE_ENV" || key === "NEXT_PHASE" || key === "NEXT_RUNTIME" || /^__NEXT_/.test(key)
      || (/^(?:LLV|DELEGATUS)_/.test(key) && !/^(?:LLV_(?:GATE|PRIVACY)_|(?:LLV|DELEGATUS)_PUBLICATION_|LLV_AGENT_GIT_GUARD_DIR$|(?:LLV|DELEGATUS)_(?:AGENT_CPU$|CPU_PRESSURE|WORK_(?:SCOPE_)?CPU_QUOTA$))/.test(key))) env[key] = undefined;
  }
  return env;
}

/** Tracked files the accepted head changes against the base branch as this
    worktree last fetched it. Null when the comparison cannot be made. */
async function publicationChangedFiles(pipeline: Pipeline, acceptedSha: string, exec: ExecPort): Promise<number | null> {
  const base = await exec("git", ["merge-base", acceptedSha, `refs/remotes/origin/${pipeline.baseBranch || DEFAULT_PIPELINE_BASE_BRANCH}`], pipeline.worktreeDir);
  const from = base.code === 0 && /^[0-9a-f]{40}$/i.test(base.stdout.trim()) ? base.stdout.trim() : null;
  if (!from) return null;
  const diff = await exec("git", ["diff", "--no-renames", "--name-only", from, acceptedSha], pipeline.worktreeDir);
  return diff.code === 0 ? diff.stdout.split("\n").filter(Boolean).length : null;
}

const REMOTE_READ_TIMEOUT = "5s";

/** The lock's mtime records publication progress across Viewer restarts. The
    existing fetch and two remote-read budgets bound a silent operation. */
export function pipelinePublicationInFlight(pipeline: Pipeline): PipelinePublishResult {
  const delivery = pipeline.delivery!;
  const operation = delivery.operation!;
  if (operation.epoch !== delivery.epoch) return { ok: false, error: "publication owner or epoch changed" };
  let progressAt = Date.parse(pipeline.createdAt);
  try {
    const stat = fs.statSync(operation.executor!.lock);
    if (`${stat.dev}:${stat.ino}` === operation.executor?.lockIdentity) progressAt = stat.mtimeMs;
  } catch { /* A missing lock supplies no progress evidence. */ }
  const age = Math.max(0, Date.now() - progressAt);
  const bound = (parseInt(BASE_FETCH_TIMEOUT) + 2 * parseInt(REMOTE_READ_TIMEOUT)) * 1_000;
  if (!Number.isFinite(age) || age > bound) return { ok: false,
    error: `publication ${operation.id} has no progress for ${Number.isFinite(age) ? `${Math.floor(age / 1_000)}s` : "an unknown age"}; reconcile through takeover with expectedOwner ${delivery.ownerId} and expectedEpoch ${delivery.epoch} once the publisher exits` };
  return { ok: true, sha: operation.sha, remote: "unreachable",
    detail: `publishing the passed stage, in progress since ${new Date(progressAt).toISOString()} (operation ${operation.id})` };
}

/** A publication tick gets one bounded remote read. The engine tick is already
    the retry loop, so retrying or sleeping inside this synchronous adapter only
    multiplies event-loop stalls. `timeout` exists in both the runtime image and
    the Linux host namespace used by agent shims. */
async function readRemotePipelineBranch(
  pipeline: Pipeline,
  exec: ExecPort,
  step: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if (pipeline.delivery && !pipeline.delivery.target.remote) return { ok: true, sha: "" };
  const result = (await exec(
    "timeout",
    ["--signal=KILL", REMOTE_READ_TIMEOUT, "git", "ls-remote", "--heads", pipeline.delivery?.target.remote || "origin", pipeline.delivery?.target.branch || `refs/heads/${pipeline.branch}`],
    pipeline.worktreeDir,
  ));
  if (result.code === 0) return { ok: true, sha: result.stdout.trim().split(/\s+/)[0] ?? "" };
  if (killedAtBound(result)) {
    return { ok: false, error: `${step}: git remote read timed out after ${REMOTE_READ_TIMEOUT}` };
  }
  return failure(step, result);
}

export interface PipelinePublishRequest {
  /** The immutable revision the pipeline accepted. This exact object is what
      gets pushed and what the publication is revalidated against. */
  acceptedSha: string;
  /** What the caller last recorded as published; a match short-circuits the
      whole probe. */
  publishedSha?: string | null;
}

/** Acquire a kernel lock on the parent's open file description BEFORE any
    publisher child exists. Descriptor 3 is inherited explicitly by each Git
    child, so parent death cannot open a pre-lock launch window. */
export function assertInheritedPipelineLockSupport(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") throw new Error("Pipeline Git requires inherited kernel locks; run Delegatus under WSL 2 on Windows");
}

export async function acquirePublicationFileLock(lock: string): Promise<number | null> {
  assertInheritedPipelineLockSupport();
  let descriptor: number;
  try { descriptor = fs.openSync(lock, "a", 0o600); }
  catch (error) { throw new Error(`Pipeline publication lock could not be opened: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`); }
  try {
    const held = tryLockFenceExclusive({ fd: descriptor, filename: lock });
    if (held) {
      // POSIX locks follow the inherited open file description. Closing the
      // parent's descriptor leaves any still-owned child holding the fence.
      return descriptor;
    }
  } catch {
    fs.closeSync(descriptor);
    throw new Error("Pipeline kernel locking is unavailable in this runtime");
  }
  fs.closeSync(descriptor);
  return null;
}

export function releasePublicationFileLock(descriptor: number): void {
  fs.closeSync(descriptor);
}

function publicationLockIdentity(descriptor: number): string {
  const stat = fs.fstatSync(descriptor);
  return `${stat.dev}:${stat.ino}`;
}

async function withPublicationFileLock<T>(lock: string, operation: () => Promise<T>, expectedIdentity: string): Promise<{ locked: true; value: T } | { locked: false }> {
  const descriptor = await acquirePublicationFileLock(lock);
  if (descriptor === null) return { locked: false };
  try {
    if (publicationLockIdentity(descriptor) !== expectedIdentity) return { locked: false };
    return { locked: true, value: await operation() };
  }
  finally { releasePublicationFileLock(descriptor); }
}

export function pipelinePublicationFence(pipeline: Pipeline): string {
  const attempt = pipeline.runs.find((run) => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1);
  const delivery = pipeline.delivery;
  return crypto.createHash("sha256").update(JSON.stringify({ state: pipeline.state, closed: pipeline.closedAt, hidden: pipeline.hiddenAt,
    control: pipeline.controlGeneration,
    cursor: pipeline.cursor, stages: pipeline.stages, head: pipeline.lastPassedCommit,
    branch: pipeline.branch, worktree: pipeline.worktreeDir,
    attempt: attempt ? { n: attempt.n, state: attempt.state, launch: attempt.launchId, conversation: attempt.conversationId } : null,
    delivery: delivery ? { target: delivery.target, epoch: delivery.epoch, owner: delivery.ownerId,
      active: delivery.active, disposition: delivery.disposition, publish: delivery.publish, operation: delivery.operation?.id } : null })).digest("hex");
}

/**
 * Publishes the accepted pipeline revision so the review layer can fence on the
 * exact revision it reviews. The orchestrator owns this step: a builder that
 * commits a usable head without pushing it must still hand off
 * deterministically, and every review round fences on `origin/<branch>`
 * (captureReviewHead), so a branch nobody published strands the handoff.
 *
 * The accepted SHA is an input, never re-derived here, and the push source is
 * that immutable object rather than `refs/heads/<branch>`. A branch ref is a
 * moving target: between capturing the head and running the push, a concurrent
 * stage can advance it, and pushing the ref would publish a commit the pipeline
 * never accepted — leaving review fenced on a different target than the one
 * that passed. Pushing `<sha>:refs/heads/<branch>` makes that unrepresentable,
 * and the fast-forward and confirmation checks compare against the same
 * immutable SHA, so a mid-flight advance can only fail the publication, never
 * redirect it.
 *
 * A repo with no `origin` reports `unavailable` — there is nothing to publish
 * to, which is a different fact from a failed publication and never a stall on
 * its own.
 */
const PUBLICATION_INSTALL_SUBJECT = "publication install";

export async function publishPipelineBranch(pipeline: Pipeline, exec: ExecPort, request: PipelinePublishRequest): Promise<PipelinePublishResult> {
  const operationId = crypto.randomUUID();
  const lock = path.join(pipelineArtifactsDir(pipeline.id), "publication.lock");
  let descriptor: number | null;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    descriptor = await acquirePublicationFileLock(lock);
  } catch (error) {
    const result = { ok: false as const, error: error instanceof Error ? error.message : "Pipeline locking unavailable" };
    const queued = pipeline.delivery?.operation;
    if (queued?.state === "pending") await withDeliveryMutationAsync((tx) => {
      const current = tx.get(pipeline.id);
      const delivery = current?.delivery;
      if (!current || !delivery || delivery.epoch !== pipeline.delivery!.epoch
        || delivery.operation?.id !== queued.id || delivery.operation.state !== "pending"
        || delivery.operation.sha !== request.acceptedSha) return;
      // Nothing could execute before locking. Record that known refusal on
      // this admission without replacing a newer reservation or lane detail.
      delivery.operation = { ...delivery.operation, state: "settled", result };
      if (current.stateDetail === "publication accepted; remote verification pending") current.stateDetail = result.error;
      deliveryJournal(current, "recovery", `publication refused before execution: ${result.error}`);
      tx.put(current);
    });
    return result;
  }
  if (descriptor === null) {
    const current = findPipelineRecord(pipeline.id);
    const error = deliveryOwnerError(current ?? pipeline, current);
    if (error) return { ok: false, error };
    if (pipeline.delivery?.epoch !== current?.delivery?.epoch) return { ok: false, error: "publication owner or epoch changed" };
    if (current?.delivery?.operation?.state === "running") return pipelinePublicationInFlight(current);
    return { ok: false, error: `publisher ${pipeline.delivery?.ownerId ?? pipeline.id} is still in flight or kernel locking is unavailable` };
  }
  const lockIdentity = publicationLockIdentity(descriptor);
  let descriptorOpen = true;
  let reserved = false;
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const reservation = await withDeliveryMutationAsync((tx) => {
      const current = tx.get(pipeline.id);
      const owner = current?.delivery ? tx.pipelineLookup({ ...current.delivery.target, active: true }) : null;
      const error = deliveryOwnerError(current ?? pipeline, owner);
      if (error || !current?.delivery) {
        if (current?.delivery) { deliveryJournal(current, "denied", error!); tx.put(current); }
        return { error: error ?? "delivery claim is missing" };
      }
      if (pipeline.delivery && pipeline.delivery.epoch !== current.delivery.epoch) return { error: "delivery epoch changed; reload the owner before publishing" };
      const previous = current.delivery.operation;
      if (pipeline.delivery?.operation?.state === "pending" && previous?.id !== pipeline.delivery.operation.id) {
        return { error: `publisher ${current.id} at epoch ${current.delivery.epoch} has a newer reservation; reload before publishing` };
      }
      if (previous?.state === "running") return { waiting: pipelinePublicationInFlight(current) };
      if (previous?.state === "pending" && ((previous.fence && previous.fence !== pipelinePublicationFence(current))
        || (!previous.fence && current.state === "paused"))) {
        const error = "publication admission superseded before execution";
        current.delivery.operation = { ...previous, state: "settled", result: { ok: false, error } };
        deliveryJournal(current, "recovery", error); tx.put(current);
        return { error };
      }
      if (current.state === "closed" || current.closedAt || current.hiddenAt) {
        const error = "publication superseded by lane closure";
        if (previous?.state === "pending") current.delivery.operation = { ...previous, state: "settled", result: { ok: false, error } };
        deliveryJournal(current, "recovery", error); tx.put(current);
        return { error };
      }
      current.delivery.operation = { id: operationId, epoch: current.delivery.epoch, sha: request.acceptedSha,
        ...(previous?.state === "pending" ? { requestKey: previous.requestKey, ...(previous.passedStage ? { passedStage: true } : {}) } : {}), state: "running",
      executor: { pid: process.pid, identity: procBackend.processIdentity(process.pid), lock, lockIdentity } };
      fs.futimesSync(descriptor, new Date(), new Date());
      tx.put(current);
      return { pipeline: current, operationId: current.delivery.operation.id };
    });
    if (reservation.waiting) return reservation.waiting;
    if (!reservation.pipeline) return { ok: false, error: reservation.error! };
    reserved = true;
    const fence = pipelinePublicationFence(reservation.pipeline);
    const abort = new AbortController();
    let writeStarted = false;
    const matches = (current: Pipeline | null) => current !== null && pipelinePublicationFence(current) === fence;
    const revalidate = () => { if (!matches(findPipelineRecord(pipeline.id))) abort.abort(); };
    const superseded = (): PipelinePublishResult => writeStarted
      ? { ok: true, sha: request.acceptedSha, remote: "unreachable", uncertain: true,
        detail: "publication superseded after a remote write began; reconcile its outcome" }
      : { ok: false, error: "publication superseded before a remote write" };
    let progressAt = performance.now();
    watch = setInterval(() => {
      revalidate();
      // A live controller can be waiting on a long repository hook. Keep its
      // lock progress fresh; a dead controller stops touching it immediately.
      if (!abort.signal.aborted && performance.now() - progressAt >= 1000) {
        try { fs.futimesSync(descriptor, new Date(), new Date()); progressAt = performance.now(); }
        catch { abort.abort(); }
      }
    }, 50);
    let failureEvidence: PipelinePublicationFailure | undefined;
    const showInstallHold = (reason: string | null, replaced: { detail: string | null } | null) => withDeliveryMutationAsync((tx) => {
      const current = tx.get(pipeline.id);
      if (!current || !matches(current)) return;
      if (reason) current.stateDetail = reason;
      else if (replaced && isCpuPressureDetail(current.stateDetail, PUBLICATION_INSTALL_SUBJECT)) current.stateDetail = replaced.detail;
      else return;
      tx.put(current);
    });
    const waitForPublicationInstall = async (): Promise<boolean> => {
      let shown: Promise<void> = Promise.resolve();
      let replaced: { detail: string | null } | null = null;
      const admitted = await waitForCpuPressure(machineCpuPressureGate(), { subject: PUBLICATION_INSTALL_SUBJECT, signal: abort.signal,
        pollMs: machineCpuPressurePollMs(),
        onReason: (reason) => {
          replaced ??= { detail: findPipelineRecord(pipeline.id)?.stateDetail ?? null };
          shown = shown.then(() => showInstallHold(reason, null));
        } });
      await shown;
      // The detail the hold replaced comes back: settlement reads it.
      if (replaced) await showInstallHold(null, replaced);
      return admitted && !abort.signal.aborted;
    };
    // Git and network work deliberately run after boundedPatch released its lease.
    // Each real Git child inherits this kernel lock. If the Viewer dies, the
    // lock stays held until that child is gone; takeover must prove it is free.
    const fencedExec: ExecPort = async (command, args, cwd, env, options) => {
      revalidate();
      if (abort.signal.aborted) return { code: null, stdout: "", stderr: "publication superseded" };
      fs.futimesSync(descriptor, new Date(), new Date());
      const preparingDependencies = command === "bun" && args[0] === "install";
      // The push runs the repository's pre-push gates; both leave the
      // production service for a work scope. Its PID, group and the inherited
      // lock descriptor stay this command's.
      let launch = { command, args };
      if ((command === "git" && args[0] === "push") || preparingDependencies) {
        try { launch = wrapWorkCommand(command, args, { label: preparingDependencies ? "publish-install" : "publish-push" }); }
        catch (error) {
          if (!(error instanceof CpuContainmentUnavailable)) throw error;
          failureEvidence = { step: preparingDependencies ? "preparing publication dependencies" : "publishing the pipeline branch",
            code: 1, signal: null, durationMs: 0, outputTail: error.message };
          return { code: 1, stdout: "", stderr: error.message };
        }
      }
      // Preparing dependencies is heavy work that starts only when CPU
      // pressure allows; the push is held by nothing, its gates take slots
      // through gate-slot.sh. The lane shows the reason while it waits, and a
      // close or takeover aborts the wait before any child exists.
      if (preparingDependencies && !await waitForPublicationInstall()) return { code: null, stdout: "", stderr: "publication superseded" };
      if (command === "git" && args[0] === "push") writeStarted = true;
      const started = performance.now();
      const executed = await exec(launch.command, launch.args, cwd, pipelineLiteralGitEnv(env), { ...options, signal: abort.signal, inheritFd: descriptor });
      if (executed.code !== 0 && ((command === "git" && args[0] === "push") || preparingDependencies)) {
        // Redact the whole output before taking its tail; clipping first can
        // remove the prefix that identifies a secret to the shared redactor.
        const output = redactPublicationOutput(executed.stdout, executed.stderr);
        const tail = output.slice(-4000);
        const phases = [...new Set(output.split("\n").filter((line) => line.startsWith("pre-push: ")))]
          .slice(-16).filter((line) => !tail.includes(line)).map((line) => line.slice(0, 160)).join("\n");
        // Long test diagnostics must not erase the hook's phase markers.
        const timedOut = executed.code === null ? /^command timed out after (\d+)ms/.exec(executed.stderr) : null;
        const hookBudgetMs = preparingDependencies ? null : hookBudgetStopMs(output);
        const outputTail = phases ? `${phases}\n…\n${output.slice(-(4000 - phases.length - 3))}` : tail;
        failureEvidence = { step: preparingDependencies ? "preparing publication dependencies" : "publishing the pipeline branch",
          code: executed.code, signal: executed.signal ?? null,
          durationMs: Math.max(0, Math.round(performance.now() - started)), outputTail,
          ...(timedOut ? { timedOutMs: Number(timedOut[1]) } : {}), ...(hookBudgetMs ? { hookBudgetMs } : {}) };
      }
      return executed;
    };
    let result: PipelinePublishResult;
    try {
      result = (await executePipelinePublication(reservation.pipeline, fencedExec, { acceptedSha: request.acceptedSha,
        publishedSha: request.publishedSha === reservation.pipeline.publishedCommit ? request.publishedSha : null }));
      // A refusal of a head that changes nothing cannot be the stage's doing.
      if (failureEvidence && !result.ok) {
        const changed = await publicationChangedFiles(reservation.pipeline, request.acceptedSha, fencedExec);
        if (changed !== null) failureEvidence = { ...failureEvidence, changedFiles: changed };
      }
    }
    catch (error) { result = writeStarted
      ? { ok: true, sha: request.acceptedSha, remote: "unreachable", detail: `publication outcome uncertain: ${String(error)}`, uncertain: true }
      : { ok: false, error: `publication failed before a remote write: ${String(error)}` }; }
    revalidate();
    if (abort.signal.aborted) result = superseded();
    if (!result.ok) result = { ...result, error: redactBounded(redactPublicationText(result.error), 4500) };
    else if (result.remote === "unreachable") result = { ...result, detail: redactBounded(redactPublicationText(result.detail), 4500) };
    if (failureEvidence && (!result.ok || result.remote === "unreachable")) {
      const detail = publicationFailureDetail(failureEvidence);
      result = result.ok ? { ...result, failure: failureEvidence, detail }
        : { ...result, failure: failureEvidence, error: detail };
      // A hook that stopped at its budget judged nothing: retried like a push
      // its time limit killed, never parked as the stage's own refusal.
      if (!result.ok && failureEvidence.hookBudgetMs) result = { ...result, outcome: "not-landed" };
    }
    clearInterval(watch); watch = undefined;
    // Retain the actual child outcome before trying the kernel fence again.
    // Another inherited holder can delay settlement without erasing evidence.
    await withDeliveryMutationAsync((tx) => {
      const current = tx.get(pipeline.id);
      if (current?.delivery?.operation?.id === reservation.operationId
        && current.delivery.epoch === reservation.pipeline.delivery!.epoch && current.delivery.operation.executor) {
        current.delivery.operation.executor.result = result;
        current.delivery.operation.executor.finished = true;
        tx.put(current);
      }
    });
    releasePublicationFileLock(descriptor);
    descriptorOpen = false;
    // Reacquisition proves that no orphan child retained the inherited lock.
    const completed = await withPublicationFileLock(lock, () => withDeliveryMutationAsync<PipelinePublishResult>((tx) => {
      const current = tx.get(pipeline.id);
      const delivery = current?.delivery;
      if (!current || !delivery || delivery.operation?.id !== reservation.operationId
        || delivery.epoch !== reservation.pipeline.delivery!.epoch) return { ok: false, error: "publication reservation changed; reconcile the remote before retrying" };
      if (!matches(current)) result = superseded();
      // A lost reply after push must keep fencing takeover.
      if (delivery.operation.executor) delivery.operation.executor.finished = true;
      if (result.ok && result.remote === "unreachable" && result.uncertain) {
        deliveryJournal(current, "recovery", result.detail);
        tx.put(current); return result;
      }
      delivery.operation = { ...delivery.operation, state: "settled", result };
      const awaitingPass = delivery.operation.passedStage && current.cursor?.state === "committing"
        && current.runs.find((run) => run.stageId === current.cursor?.stageId)?.attempts.at(-1)?.verdict?.status === "pass";
      if (matches(current) && (current.stateDetail === "publication accepted; remote verification pending" || awaitingPass)) current.stateDetail = result.ok
        ? result.remote === "published" ? null : "publication checked; remote is unavailable"
        : result.error;
      deliveryJournal(current, "recovery", result.ok ? `publication verified: ${result.remote}` : `publication refused: ${result.error}`);
      if (result.ok && result.remote === "published") current.publishedCommit = result.sha;
      tx.put(current);
      return result;
    }), lockIdentity);
    if (completed.locked) return completed.value;
    await withDeliveryMutationAsync((tx) => {
      const current = tx.get(pipeline.id);
      if (current?.delivery?.operation?.id === reservation.operationId && current.delivery.operation.executor) {
        current.delivery.operation.executor.finished = true;
        tx.put(current);
      }
    });
    return { ok: true, sha: request.acceptedSha, remote: "unreachable", uncertain: true,
      detail: "publisher child quiescence could not be established; the reservation remains in flight" };
  } catch (error) {
    // After reservation, even a store lease refusal cannot prove non-execution.
    if (!reserved) throw error;
    return { ok: true, sha: request.acceptedSha, remote: "unreachable", uncertain: true,
      detail: redactBounded(redactPublicationText(`publication settlement is unconfirmed; reconcile the reserved operation: ${String(error)}`), 4500) };
  } finally { if (watch) clearInterval(watch); if (descriptorOpen) releasePublicationFileLock(descriptor); }
}

/** Explicit recovery reads the remote only after proving the previous executor
    and all its fenced Git children can no longer write. No age-based election. */
export async function reconcilePipelinePublication(id: string, expectedEpoch: number, exec: ExecPort, conversationId: string | null): Promise<string | null> {
  const pipeline = findPipelineRecord(id);
  const operation = pipeline?.delivery?.operation;
  if (!pipeline?.delivery || pipeline.delivery.epoch !== expectedEpoch) return "publication owner or epoch changed";
  if (operation?.state !== "running") return null;
  const executor = operation.executor;
  if (!executor?.lockIdentity) return "publisher quiescence is unknown; no executor lock identity was recorded";
  // The parent takes this lock before recording the operation and holds it
  // through its final Git command. A free lock therefore proves quiescence
  // even when a live Viewer could not persist its finished marker.
  const reconciled = await withPublicationFileLock(executor.lock, async () => {
    const remote = (await readRemotePipelineBranch(pipeline, exec, "reconciling the interrupted publisher"));
    if (!remote.ok) return redactBounded(redactPublicationText(remote.error), 4500);
    return withDeliveryMutationAsync((tx) => {
      const current = tx.get(id);
      if (!current?.delivery || current.delivery.epoch !== expectedEpoch || current.delivery.operation?.id !== operation.id
        || current.delivery.operation.state !== "running" || current.delivery.operation.epoch !== expectedEpoch
        || current.delivery.operation.sha !== operation.sha) return "publication changed while reconciling";
      // The publisher can persist its outcome between the initial record read
      // and quiescence. Use the fenced transaction's latest durable evidence.
      const retained = current.delivery.operation.executor?.result;
      const failure = retained?.failure ? { ...retained.failure,
        outputTail: redactPublicationText(retained.failure.outputTail).slice(-4000) } : undefined;
      const result: PipelinePublishResult = remote.sha === operation.sha
        ? { ok: true, sha: operation.sha, remote: "published" }
        : retained
          ? { ok: false, error: failure ? publicationFailureDetail(failure)
            : retained.ok ? "publication did not leave its accepted head on the remote; the executor completed without confirmation"
              : redactBounded(redactPublicationText(retained.error), 4500),
            ...(failure ? { failure } : {}) }
          : { ok: false, error: "interrupted publication did not leave its accepted head on the remote" };
      if (!result.ok && (!retained || (retained.ok && retained.uncertain))) result.outcome = "not-landed";
      const attempt = current.runs.find((run) => run.stageId === current.cursor?.stageId)?.attempts.at(-1);
      // Older engines parked the accepted attempt itself. Preserve its pass
      // before replacing the legacy display prefix, and upgrade the operation
      // so subsequent recovery uses durable identity rather than diagnostics.
      if (current.state === "needs_decision" && current.cursor?.state === "committing"
        && current.lastPassedCommit === operation.sha && current.delivery.ownerId === id
        && !deliveryOwnerError(current, tx.pipelineLookup({ ...current.delivery.target, active: true }))
        && (current.delivery.operation.passedStage === true || (current.delivery.operation.passedStage === undefined
          && current.stateDetail?.startsWith("publishing the passed stage:") === true))
        && (attempt?.state === "needs_decision" || attempt?.state === "passed") && attempt.verdict?.status === "pass") {
        attempt.state = "passed";
        current.delivery.operation.passedStage = true;
      }
      current.delivery.operation = { ...current.delivery.operation, state: "settled", result };
      if (result.ok) current.publishedCommit = operation.sha;
      else if ((current.state === "needs_decision" || current.state === "running") && current.cursor?.state === "committing"
        && current.lastPassedCommit === operation.sha) current.stateDetail = result.error;
      deliveryJournal(current, "recovery", "publisher quiescent; remote reconciled", conversationId);
      tx.put(current);
      return null;
    });
  }, executor.lockIdentity);
  return reconciled.locked ? reconciled.value : "publisher child is still in flight or its lock could not be checked";
}

async function executePipelinePublication(pipeline: Pipeline, exec: ExecPort, request: PipelinePublishRequest): Promise<PipelinePublishResult> {
  const acceptedSha = request.acceptedSha;
  if (!/^[0-9a-f]{40}$/i.test(acceptedSha)) {
    return { ok: false, error: `the accepted pipeline revision is not an exact commit SHA: ${acceptedSha || "absent"}` };
  }
  const local = (await currentPipelineBranchHead(pipeline, exec));
  if (!local.ok) return local;
  /* The worktree must still hold the accepted revision when publication starts.
     A head that has moved on is not this publication's business to push. */
  if (local.sha !== acceptedSha) {
    return { ok: false, error: `the pipeline worktree is at ${local.sha}, not the accepted revision ${acceptedSha}; nothing was published` };
  }
  if (request.publishedSha && request.publishedSha === acceptedSha) return { ok: true, sha: acceptedSha, remote: "published" };

  const origin = pipeline.delivery
    ? { code: 0, stdout: pipeline.delivery.target.remote, stderr: "" }
    : (await exec("git", ["remote", "get-url", "origin"], pipeline.worktreeDir));
  if (origin.code !== 0 || !origin.stdout.trim()) return { ok: true, sha: acceptedSha, remote: "unavailable" };

  const probe = (await readRemotePipelineBranch(pipeline, exec, "checking the remote pipeline branch"));
  if (!probe.ok) return { ok: true, sha: acceptedSha, remote: "unreachable", detail: probe.error };
  const remoteSha = probe.sha;
  if (remoteSha === acceptedSha) return { ok: true, sha: acceptedSha, remote: "published" };
  if (remoteSha) {
    if (!/^[0-9a-f]{40}$/i.test(remoteSha)) return { ok: false, error: "the remote pipeline branch has no exact commit SHA" };
    /* A revision pushed from another checkout is not in this worktree's object
       database, and `merge-base` cannot reason about a commit it does not have
       — it fails outright, which would report a transient git error where the
       truth is a divergence. Fetch it first, and only when it is genuinely
       unknown, so an ordinary fast-forward still costs no extra round trip. */
    const known = (await exec("git", ["cat-file", "-e", `${remoteSha}^{commit}`], pipeline.worktreeDir));
    if (known.code !== 0) {
      const fetched = (await exec(
        "git",
        ["fetch", "--no-tags", pipeline.delivery?.target.remote || "origin", pipeline.delivery?.target.branch || `refs/heads/${pipeline.branch}`],
        pipeline.worktreeDir,
      ));
      if (fetched.code !== 0) return failure("fetching the remote pipeline branch", fetched);
    }
    /* Only a fast-forward is ever published. A remote revision the ACCEPTED
       revision does not contain is someone else's repair; overwriting it would
       discard work, so the pipeline parks and lets the operator choose. */
    const remoteIsAncestor = (await exec("git", ["merge-base", "--is-ancestor", remoteSha, acceptedSha], pipeline.worktreeDir));
    if (remoteIsAncestor.code === 1) {
      return { ok: false, error: "the local and remote pipeline branches diverged; fetch and merge the remote commits into this worktree, then retry publication; both tips are preserved" };
    }
    if (remoteIsAncestor.code !== 0) return failure("comparing local and remote pipeline revisions", remoteIsAncestor);
  }

  // Read-only stages can pass without dependencies. Prepare a Bun worktree before
  // its full repository hook runs, keeping privacy and every other gate active.
  // Frozen installation cannot upgrade the accepted lockfile. The same bounded,
  // fenced executor retains setup failures and cancels them on supersession.
  // Verify even an existing installation: an interrupted install may have
  // left node_modules incomplete, or a merged lockfile may have moved on.
  if (fs.existsSync(path.join(pipeline.worktreeDir, "package.json"))
    && ["bun.lock", "bun.lockb"].some((file) => fs.existsSync(path.join(pipeline.worktreeDir, file)))) {
    const installed = await exec("bun", ["install", "--frozen-lockfile"], pipeline.worktreeDir, pipelinePublicationHookEnv(), { timeoutMs: 180_000 });
    if (installed.code !== 0) return failure("preparing publication dependencies", installed);
    // Lifecycle scripts must not change the accepted head or tracked work.
    const prepared = await currentPipelineBranchHead(pipeline, exec);
    if (!prepared.ok) return prepared;
    if (prepared.sha !== acceptedSha) return { ok: false, error: "dependency preparation changed the accepted pipeline revision; nothing was published" };
  }
  // Full repository hooks exceed the generic command budget. Publication
  // remains finite and the ownership watcher can cancel it throughout.
  /* A push to a declared App repository goes out as the Delegatus GitHub App
     or is refused; any other push is the one it always was. The App's
     variables are spread over the hook environment, which removes the
     Viewer's own settings first. */
  /* The hook is handed the moment it must be done by, a minute before this
     limit for git to send the pack, so it ends with its own verdict or with
     a named missing one instead of being killed (scripts/local-gate.ts). */
  const pushEnv = { ...pipelinePublicationHookEnv(), ...engineForgeWriteEnv(),
    LLV_GATE_PUSH_DEADLINE: String(Date.now() + PUBLICATION_PUSH_TIMEOUT_MS - PUBLICATION_PACK_MARGIN_MS) };
  const push = (await exec("git", ["push", pipeline.delivery?.target.remote || "origin", `${acceptedSha}:${pipeline.delivery?.target.branch || `refs/heads/${pipeline.branch}`}`], pipeline.worktreeDir, pushEnv, { timeoutMs: PUBLICATION_PUSH_TIMEOUT_MS }));
  if (push.code === null) return { ok: true, sha: acceptedSha, remote: "unreachable", uncertain: true, detail: "remote write was interrupted; reconcile its outcome" };
  if (push.code !== 0) return failure("publishing the pipeline branch", push);
  const confirm = (await readRemotePipelineBranch(pipeline, exec, "confirming the published pipeline branch"));
  if (!confirm.ok) return { ok: true, sha: acceptedSha, remote: "unreachable", detail: confirm.error, uncertain: true };
  const publishedHead = confirm.sha;
  if (publishedHead !== acceptedSha) {
    return { ok: false, error: `publishing the pipeline branch did not land: origin/${pipeline.branch} is ${publishedHead || "absent"}, expected ${acceptedSha}` };
  }
  return { ok: true, sha: acceptedSha, remote: "published" };
}

/**
 * Resolves the exact revision a retried reviewer will receive. A remote repair
 * fast-forwards the shared worktree; a local repair stays intact; divergence
 * parks for an operator and preserves both repair tips.
 */
export async function synchronizePipelineRetryHead(pipeline: Pipeline, exec: ExecPort): Promise<PipelineGitResult> {
  const local = (await currentPipelineBranchHead(pipeline, exec));
  if (!local.ok) return local;
  if (pipeline.delivery && !pipeline.delivery.target.remote) return local;

  const remoteProbe = (await exec("git", ["ls-remote", "--heads", pipeline.delivery?.target.remote || "origin", pipeline.delivery?.target.branch || `refs/heads/${pipeline.branch}`], pipeline.worktreeDir));
  if (remoteProbe.code !== 0) return failure("checking the remote pipeline branch", remoteProbe);
  if (!remoteProbe.stdout.trim()) return local;

  const fetch = (await exec(
    "git",
    ["fetch", "--no-tags", pipeline.delivery?.target.remote || "origin", pipeline.delivery?.target.branch || `refs/heads/${pipeline.branch}`],
    pipeline.worktreeDir,
  ));
  if (fetch.code !== 0) return failure("fetching the remote pipeline branch", fetch);
  const remoteSha = remoteProbe.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(remoteSha)) return { ok: false, error: "resolving the remote pipeline branch: expected an exact commit SHA" };
  const present = (await exec("git", ["cat-file", "-e", `${remoteSha}^{commit}`], pipeline.worktreeDir));
  if (present.code !== 0) return { ok: false, error: "the remote pipeline branch moved during fetch; retry review at its current head" };
  if (remoteSha === local.sha) return local;

  const localIsAncestor = (await exec("git", ["merge-base", "--is-ancestor", local.sha, remoteSha], pipeline.worktreeDir));
  if (localIsAncestor.code === 0) {
    const merge = (await exec("git", ["merge", "--ff-only", "--no-overwrite-ignore", remoteSha], pipeline.worktreeDir));
    if (merge.code !== 0) return failure("fast-forwarding the pipeline worktree to its remote repair", merge);
    return { ok: true, sha: remoteSha };
  }
  if (localIsAncestor.code !== 1) return failure("comparing local and remote pipeline revisions", localIsAncestor);

  const remoteIsAncestor = (await exec("git", ["merge-base", "--is-ancestor", remoteSha, local.sha], pipeline.worktreeDir));
  if (remoteIsAncestor.code === 0) return local;
  if (remoteIsAncestor.code !== 1) return failure("comparing local and remote pipeline revisions", remoteIsAncestor);
  return { ok: false, error: "the local and remote pipeline branches diverged; fetch and merge the remote commits into this worktree before retrying review; both tips are preserved" };
}
