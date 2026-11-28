import { isStoredPipeline } from "./store";
import { statePath } from "@/lib/configDir";
import { readCompactPipelineEvidence, pipelineStageAuthority, stateEvidenceVersion, type CompactEvidenceCache } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { performanceSpans } from "@/lib/performanceSpans";
import type { ExecPort } from "@/lib/workflows/provision";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import path from "node:path";

import { commitPipelineStage, reconcilePipelineStageHead, type PipelineGitResult, type ProvisionExecPort, type StageCommitControl } from "./git";
import type { Pipeline, PipelineStageAttempt } from "./types";

const pipelineTerminal = (pipeline: Pipeline) => pipeline.state === "completed" || pipeline.state === "closed";

export type StageBranchProtection = { branch: string; head: string; error: string | null };

type BranchAuthority = Pick<Pipeline, "id" | "worktreeDir" | "branch" | "delivery">;
type AuthorityObservation = NonNullable<ReturnType<typeof pipelineStageAuthority>>;
const OWNERSHIP_SITE = "pipelines.stage-ownership";
const deliveryBranchName = (pipeline: BranchAuthority) => pipeline.delivery?.target.branch.slice("refs/heads/".length);

function authorityKeys(owner: BranchAuthority, source?: string): string {
  const target = owner.delivery?.target;
  const branches = new Set([owner.branch, source, deliveryBranchName(owner)]);
  // A canonical Git directory can be reached through multiple stored repo
  // paths. Cover name matches until Git proves which repository owns them.
  return JSON.stringify([
    ["unknown"], ["lane", owner.id], ["worktree", owner.worktreeDir],
    ...[...branches].filter(branch => branch !== undefined).map(branch => ["branch-name", branch]),
    ...(target ? [["target", target.repository, target.branch]] : []),
  ].map(key => JSON.stringify(key)));
}

// The shared compact read validates retained records, including stores that
// predate scoped tracking. It is only needed when starting a new proof.
let branchAuthorityCache: CompactEvidenceCache<null> | undefined;
const MAX_BRANCH_AUTHORITY_ROWS = 32_768;
const authorityToken = (proof: AuthorityObservation) => `${proof.identity}:${proof.change?.revision ?? 0}`;

export class StageBranchOwnershipChange extends Error {
  constructor(phase: "preparation" | "settlement", writer: string) {
    super(`${phase === "preparation" ? "pipeline ownership" : "pipeline branch ownership"} changed during ${phase} by ${writer}`);
  }
}

export function stageBranchOwnershipReader(owner: BranchAuthority, source?: string) {
  const filename = statePath("state.sqlite");
  const keys = authorityKeys(owner, source);
  let version: string | undefined;
  let observation: AuthorityObservation | null = null;
  let proof: AuthorityObservation | undefined;
  let pending: Promise<string> | undefined;
  let changedBy: string | undefined;
  const observe = () => {
    try {
      const nextVersion = stateEvidenceVersion(filename);
      if (version !== nextVersion) {
        observation = nextVersion === "missing" ? null : pipelineStageAuthority(filename, keys);
        // This version precedes the indexed read. A concurrent commit can
        // cause a later recheck, but cannot make a stale observation current.
        version = nextVersion;
      }
    } catch {
      version = undefined;
      observation = null;
    }
    return observation;
  };
  const attribute = (before: AuthorityObservation | null, after: AuthorityObservation | null) => {
    const change = after?.change;
    if (before && after && before.identity === after.identity && change && change.revision > (before.change?.revision ?? 0)) {
      const fields = change.fields ? ` of ${change.fields}` : "";
      changedBy = `pipeline ${change.lane_id.slice(0, 120)} (${change.operation}${fields})`;
    } else {
      changedBy = undefined;
    }
  };
  const failure = (phase: "preparation" | "settlement") => changedBy
    ? new StageBranchOwnershipChange(phase, changedBy)
    : new Error(`pipeline ownership changed during ${phase}; the ownership evidence is unavailable`);
  const current = () => {
    if (!proof) return false;
    const after = observe();
    if (!after || authorityToken(proof) !== authorityToken(after)) {
      attribute(proof, after);
      return false;
    }
    proof = after;
    return true;
  };
  const read = (): Promise<string> => {
    // Once initialized, callers compare the token with their starting proof.
    // Read scoped clocks directly so disjoint writes never restart hydration.
    if (proof) {
      current();
      if (observation) return Promise.resolve(authorityToken(observation));
      return Promise.reject(failure("settlement"));
    }
    if (pending) return pending;
    pending = waitForStateLock(OWNERSHIP_SITE, async () => {
      const before = observe();
      const next = await readCompactPipelineEvidence(filename, branchAuthorityCache, (record, collection) => {
        if (collection === "pipelines" && !isStoredPipeline(record)) throw new Error("pipeline ownership is unreadable");
        return null;
      });
      if (next && next.rows.size <= MAX_BRANCH_AUTHORITY_ROWS
        && (branchAuthorityCache?.identity !== next.identity || (branchAuthorityCache.sourceRevision ?? -1) <= (next.sourceRevision ?? -1)))
        branchAuthorityCache = next;
      else if (next && next.rows.size > MAX_BRANCH_AUTHORITY_ROWS) branchAuthorityCache = undefined;
      const after = observe();
      if (next && before && after && next.identity === before.identity && authorityToken(before) === authorityToken(after)) {
        proof = after;
        return authorityToken(proof);
      }
      attribute(before, after);
      throw failure("preparation");
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return { read, current, failure };
}

/** Forge reads run before the controller mutation. Pin the observation to the
    local branch/head so a changed checkout cannot reuse its protection check. */
export async function observeStageBranchProtection(pipeline: Pipeline, exec: ExecPort, remoteExec: ProvisionExecPort): Promise<StageBranchProtection | null> {
  const attempt = pipeline.runs.find((run) => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1);
  if (attempt?.effectiveRole.access !== "read-write" || (pipeline.state !== "running" && pipeline.state !== "needs_decision")) return null;
  const checkedOut = (await exec("git", ["branch", "--show-current"], pipeline.worktreeDir));
  const branch = attempt.branchAdoption?.branch ?? checkedOut.stdout.trim();
  const deliveryBranch = pipeline.delivery?.disposition === "owner" ? pipeline.delivery.target.branch.replace(/^refs\/heads\//, "") : null;
  if (typeof branch !== "string" || !branch || branch === pipeline.branch || branch === deliveryBranch) return null;
  const head = (await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], pipeline.worktreeDir)).stdout.trim();
  const observation: StageBranchProtection = { branch, head, error: null };
  if ([pipeline.baseBranch, "main", "master", "trunk", "develop"].includes(branch)) return observation;
  const remote = pipeline.delivery?.target.remote || "origin";
  const url = (await exec("git", ["remote", "get-url", remote], pipeline.worktreeDir));
  const resolvedRemote = url.code === 0 ? url.stdout.trim() : remote;
  const repository = githubRepositoryOfRemote(resolvedRemote);
  if (!repository) {
    // Local remotes have no forge branch-protection mechanism.
    if (/^(?:\/|\.\.?\/|file:\/\/)/.test(resolvedRemote)) return observation;
    if (url.code !== 0 && remote === "origin") {
      const remotes = (await exec("git", ["remote"], pipeline.worktreeDir));
      if (remotes.code === 0 && !remotes.stdout.trim()) return observation;
    }
    return { ...observation, error: "the remote forge's stage branch protection cannot be verified" };
  }
  const present = await remoteExec("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], pipeline.worktreeDir, undefined, { timeoutMs: 5_000 });
  if (present.code !== 0) return { ...observation, error: "the stage branch's remote protection cannot be verified" };
  if (!present.stdout.trim()) return observation; // Unpublished local branch; no remote branch is adopted or modified.
  const protection = await remoteExec("gh", ["api", `repos/${repository}/branches/${encodeURIComponent(branch)}`, "--jq", ".protected"], pipeline.worktreeDir, undefined, { timeoutMs: 5_000 });
  if (protection.code !== 0 || !["true", "false"].includes(protection.stdout.trim())) return { ...observation, error: "the stage branch's forge protection cannot be verified" };
  return { ...observation, error: protection.stdout.trim() === "true" ? "the stage is on a protected forge branch" : null };
}

/** A writable attempt owns its dedicated checkout, but cannot borrow another
    lane's branch. Preserve the source ref and all accepted content. */
export async function commitAndAdoptStageBranch(
  pipeline: Pipeline,
  stageId: string,
  exec: ExecPort,
  pipelines: () => readonly Pipeline[],
  adoption: PipelineStageAttempt["branchAdoption"],
  recordAdoption: (intent: NonNullable<PipelineStageAttempt["branchAdoption"]>) => void | Promise<void>,
  protection: StageBranchProtection | null | undefined,
  receiptFile?: string,
  control?: StageCommitControl,
  attempt?: PipelineStageAttempt,
  now?: string,
): Promise<PipelineGitResult> {
  const initialRows = pipelines();
  const execute = exec;
  const cwd = pipeline.worktreeDir;
  const branch = (await execute("git", ["branch", "--show-current"], cwd));
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
  const names = new Set([pipeline.branch, source, ...(deliveryBranch ? [deliveryBranch] : [])]);
  const deliveryTarget = pipeline.delivery?.target;
  const exactCollision = (other: Pipeline) => other.worktreeDir === cwd
    || Boolean(deliveryTarget && other.delivery?.target.repository === deliveryTarget.repository && other.delivery.target.branch === deliveryTarget.branch);
  const candidates = (rows: readonly Pipeline[]) => rows.filter(other => {
    const deliveryName = deliveryBranchName(other);
    return other.id !== pipeline.id && (exactCollision(other) || names.has(other.branch)
      || (deliveryName !== undefined && names.has(deliveryName)));
  });
  const stageBranchOwnershipFence = (rows: readonly Pipeline[]) => performanceSpans.sync("controller.ownership", () => JSON.stringify(rows.map(other => [
    other.id, other.repoDir, other.worktreeDir, other.branch, other.delivery?.target, other.delivery?.active,
    other.delivery?.ownerId, other.delivery?.epoch, other.delivery?.publish, other.delivery?.disposition, pipelineTerminal(other),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  const commonDirectories = async (candidate: Pipeline): Promise<{ directories: Set<string>; unresolved: boolean }> => {
    const directories = new Set<string>();
    let unresolved = false;
    for (const directory of new Set([candidate.repoDir, candidate.worktreeDir])) {
      const result = await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], directory);
      if (result.code === 0 && result.stdout.trim()) directories.add(path.resolve(result.stdout.trim()));
      else unresolved = true;
    }
    return { directories, unresolved };
  };
  // The durable proof uses stored coordinates. Git also checks potential
  // holders of the actual source and destination refs across path aliases.
  let pipelineIdentity: Awaited<ReturnType<typeof commonDirectories>> | undefined;
  const colliding = async (peers: readonly Pipeline[]) => {
    const others: Pipeline[] = [];
    for (const other of peers) {
      if (exactCollision(other) || other.repoDir === pipeline.repoDir
        || (deliveryTarget && other.delivery?.target.repository === deliveryTarget.repository)) {
        others.push(other);
        continue;
      }
      pipelineIdentity ??= await commonDirectories(pipeline);
      const otherIdentity = await commonDirectories(other);
      // A removed checkout can still have a claim on this exact ref.
      if (pipelineIdentity.unresolved || otherIdentity.unresolved
        || [...pipelineIdentity.directories].some(directory => otherIdentity.directories.has(directory))) others.push(other);
    }
    return others;
  };
  const initialPeers = candidates(initialRows);
  let potential = stageBranchOwnershipFence(initialPeers);
  const others = await colliding(initialPeers);
  const ownership = stageBranchOwnershipFence(others);
  exec = async (command, args, directory, env, options) => {
    const peers = candidates(pipelines());
    const next = stageBranchOwnershipFence(peers);
    if (next !== potential) {
      const resolved = await colliding(peers);
      if (stageBranchOwnershipFence(resolved) !== ownership || stageBranchOwnershipFence(candidates(pipelines())) !== next) {
        return { code: null, stdout: "", stderr: "pipeline branch ownership changed during stage adoption" };
      }
      potential = next;
    }
    return execute(command, args, directory, env, options);
  };
  // A finished lane whose delivery claim was released keeps its branch name,
  // and a successor delivering to that pull request branch must not lose it.
  const ownerOf = (name: string) => others.find((other) => other.delivery?.active
    ? other.branch === name || other.delivery.target.branch === `refs/heads/${name}`
    : other.branch === name && !pipelineTerminal(other));
  const sourceOwner = ownerOf(source);
  if (sourceOwner) return refused(`another pipeline owns the stage branch (pipeline ${sourceOwner.id})`);
  let custodyHead: string | null = null;
  if (!adoption && attempt && now && (source === pipeline.branch || source === deliveryBranch)) {
    const pushed = await performanceSpans.wait("pipeline.attempt-push-proof", async () => {
      const head = await exec("git", ["rev-parse", "HEAD"], cwd);
      if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return { ok: false as const,
        error: "settling the stage push: the lane head cannot be read; both tips are preserved" };
      custodyHead = head.stdout.trim();
      return settleStageAttemptPush(pipeline, attempt, exec, now);
    });
    if (pushed) {
      if (!pushed.ok && pushed.deferred) pipeline.stateDetail = pushed.error;
      if (pushed.ok && attempt.report) attempt.report.provenance = { ...attempt.report.provenance, head: pushed.sha };
      return pushed;
    }
  }
  // The proof and ordinary committer share one parent. Its existing head guard
  // also applies to clean worktrees, which otherwise accept a late foreign tip.
  const commitOwned = async (): Promise<PipelineGitResult> => {
    const result = await commitPipelineStage(pipeline, stageId, true, exec, undefined, custodyHead, receiptFile, control);
    if (!result.ok && custodyHead !== null && result.error === `read-only stage ${stageId} created a commit`) {
      return { ...result, error: "settling the stage push: the lane head raced the attempt proof; both tips are preserved" };
    }
    return result;
  };
  if (!adoption && source === pipeline.branch) return commitOwned();
  if (!adoption && source === deliveryBranch) {
    if (!pipeline.delivery?.active || pipeline.delivery.publish !== "enabled" || pipeline.delivery.ownerId !== pipeline.id) return refused("the delivery branch claim was released");
    return commitOwned();
  }
  if (!source) return refused("the stage left a detached head");
  if (adoption && checkedOut !== source && checkedOut !== adoption.target) return refused("the checkout moved away from its recorded adoption");
  const defaultBranch = (await exec("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd));
  if ([pipeline.baseBranch, "main", "master", "trunk", "develop", defaultBranch.stdout.trim().replace(/^refs\/remotes\/origin\//, "")].includes(source)) {
    return refused("the stage is on a protected base branch");
  }
  const head = (await exec("git", ["rev-parse", "--verify", `refs/heads/${source}`], cwd));
  const laneTip = (await exec("git", ["rev-parse", "--verify", `refs/heads/${pipeline.branch}`], cwd));
  const destination = adoption?.target ?? (laneTip.code === 0 ? pipeline.branch : deliveryBranch);
  if (!destination || (destination !== pipeline.branch && destination !== deliveryBranch)) return refused("there is no owned adoption destination");
  const destinationOwner = ownerOf(destination);
  if (destinationOwner) return refused(`another pipeline owns the adoption destination (pipeline ${destinationOwner.id})`);
  if (destination === deliveryBranch && destination !== pipeline.branch
    && (!pipeline.delivery?.active || pipeline.delivery.publish !== "enabled" || pipeline.delivery.ownerId !== pipeline.id))
    return refused("the adoption destination's delivery claim was released");
  const target = destination === pipeline.branch ? laneTip : (await exec("git", ["rev-parse", "--verify", `refs/heads/${destination}`], cwd));
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
  const based = (await exec("git", ["merge-base", "--is-ancestor", pipeline.baseRef, sha], cwd));
  if (based.code !== 0) return refused(`the stage head does not descend from the pipeline base; ${based.stderr.trim()}`);
  // Validate before the controller commits: a protected or foreign branch must
  // never receive even an automatic stage commit.
  const changes = adoption ? (await exec("git", ["status", "--porcelain"], cwd)) : null;
  if (changes && (changes.code !== 0 || changes.stdout.trim())) return refused("the recorded adoption worktree is no longer clean");
  let committed = adoption ? { ok: true as const, sha: adoption.adoptedHead ?? adoption.head } : (await commitPipelineStage(pipeline, stageId, true, exec, undefined, undefined, receiptFile, control));
  if (!committed.ok) return committed;
  const stillOnSource = (await exec("git", ["branch", "--show-current"], cwd));
  const retained = (await exec("git", ["merge-base", "--is-ancestor", sha, committed.sha], cwd));
  if (stillOnSource.code !== 0 || stillOnSource.stdout.trim() !== checkedOut || retained.code !== 0) {
    return refused("the stage branch or history moved during its commit");
  }
  if (!adoption) {
    const stageHead = committed.sha;
    const fastForward = (await exec("git", ["merge-base", "--is-ancestor", targetSha, stageHead], cwd));
    const retainsAccepted = (await exec("git", ["merge-base", "--is-ancestor", pipeline.lastPassedCommit, stageHead], cwd));
    if (fastForward.code !== 0 && fastForward.code !== 1) return refused("the destination ancestry cannot be verified");
    if (retainsAccepted.code !== 0 && retainsAccepted.code !== 1) return refused("the accepted ancestry cannot be verified");
    if (fastForward.code === 1 || retainsAccepted.code === 1) {
      if ((await exec("git", ["merge-base", "--is-ancestor", targetSha, pipeline.lastPassedCommit], cwd)).code !== 0) return refused("the destination advanced independently of this stage");
      const listing = (await exec("git", ["worktree", "list", "--porcelain"], cwd));
      if (listing.code !== 0 || listing.stdout.split("\n").includes(`branch refs/heads/${destination}`)) return refused("the adoption destination is held by another worktree");
      // Use the existing accepted-content proof on the stage's tree, then CAS
      // only the lane's destination. The source branch and its PR keep their tip.
      committed = (await reconcilePipelineStageHead({ ...pipeline, branch: source }, stageHead, exec, {
        branch: destination, head: targetSha,
        prepared: (adoptedHead) => recordAdoption({ branch: source, head: stageHead, target: destination, adoptedHead }),
      }));
      if (!committed.ok) return committed;
    } else (await recordAdoption({ branch: source, head: stageHead, target: destination }));
  }
  for (const ancestor of new Set([pipeline.lastPassedCommit, targetSha])) {
    if ((await exec("git", ["merge-base", "--is-ancestor", ancestor, committed.sha], cwd)).code !== 0) return refused("the adoption would drop an accepted or destination tip");
  }
  const switched = (await exec("git", ["switch", "--no-overwrite-ignore", destination], cwd));
  if (switched.code !== 0) return refused(`returning to the pipeline branch: ${switched.stderr.trim()}`);
  // Git checks the current destination tip again. A concurrent advance cannot
  // be overwritten, and a branch checked out elsewhere cannot be switched to.
  const advanced = (await exec("git", ["merge", "--ff-only", "--no-overwrite-ignore", committed.sha], cwd));
  if (advanced.code !== 0) {
    // Keep retry on the stage's branch. Otherwise the next committing tick
    // could mistake the unchanged destination tip for the stage's work.
    const restored = (await exec("git", ["switch", "--no-overwrite-ignore", source], cwd));
    return refused(`fast-forwarding the pipeline branch: ${advanced.stderr.trim()}${restored.code === 0 ? "" : `; restoring the stage branch: ${restored.stderr.trim()}`}`);
  }
  const finalHead = (await exec("git", ["rev-parse", "HEAD"], cwd));
  const finalBranch = (await exec("git", ["branch", "--show-current"], cwd));
  if (finalHead.code !== 0 || finalHead.stdout.trim() !== committed.sha || finalBranch.code !== 0 || finalBranch.stdout.trim() !== destination) {
    return refused("the adopted checkout moved before acceptance");
  }
  return committed;
}
