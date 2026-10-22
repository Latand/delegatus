import fs from "node:fs/promises";
import path from "node:path";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { rollupChecksWithIdentity } from "@/lib/forge/checkRollup";
import type { ExecPort } from "@/lib/workflows/provision";
import { DEFAULT_PIPELINE_BASE_BRANCH, pipelineLiteralGitEnv, verifyPassedHeadIntegration, type PipelineGitResult } from "./git";
import type { Pipeline, PipelineStageAttempt } from "./types";

class StagePushRemoteUnavailable extends Error {}
class StageIntegrationChecksPending extends Error {}

/** A missing creation receipt is excused only for a published, tested clean
 * integration. Read the forge for this exact head and origin's default branch;
 * an unverified tracking ref, a report or an old green PR cannot authorize it. */
async function integrationOrigin(pipeline: Pipeline, main: string, deliveryUrl: string, exec: ExecPort): Promise<string | null> {
  const origin = await exec("git", ["remote", "get-url", "origin"], pipeline.worktreeDir);
  const repository = githubRepositoryOfRemote(origin.stdout.trim());
  if (origin.code !== 0 || !repository || repository !== githubRepositoryOfRemote(deliveryUrl)) return null;
  const defaultBranch = await exec("git", ["ls-remote", "--symref", "origin", "HEAD"], pipeline.worktreeDir, undefined, { timeoutMs: 5000 });
  if (defaultBranch.code !== 0) throw new StagePushRemoteUnavailable();
  const lines = defaultBranch.stdout.trim().split("\n");
  if (lines.length !== 2 || lines[0] !== `ref: refs/heads/${pipeline.baseBranch}\tHEAD`
    || lines[1] !== `${main}\tHEAD`) return null;
  return repository;
}

async function publishedIntegrationGreen(pipeline: Pipeline, target: string, main: string, deliveryUrl: string, exec: ExecPort): Promise<boolean> {
  const repository = await integrationOrigin(pipeline, main, deliveryUrl, exec);
  if (!repository) return false;
  const read = async (args: string[]): Promise<unknown> => {
    const result = await exec("gh", args, pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
    if (result.code !== 0) throw new StageIntegrationChecksPending("the published integration's checks are unavailable");
    return JSON.parse(result.stdout);
  };
  const view = await read(["pr", "view", String(pipeline.delivery!.target.pr ?? pipeline.delivery!.target.branch.replace(/^refs\/heads\//, "")),
    "--repo", repository, "--json", "state,isDraft,headRefOid,baseRefName,statusCheckRollup"]) as Record<string, unknown>;
  if (!view || view.state !== "OPEN" || view.isDraft !== false || view.headRefOid !== target || view.baseRefName !== pipeline.baseBranch) return false;
  if (!Array.isArray(view.statusCheckRollup) || view.statusCheckRollup.some(entry => !entry || typeof entry !== "object"
    || !(typeof entry.name === "string" || typeof entry.context === "string"))) return false;
  const [owner, name] = repository.split("/");
  const query = `query($owner: String!, $name: String!, $oid: GitObjectID!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup {
            contexts(first: 100, after: $endCursor) {
              nodes {
                __typename
                ... on CheckRun {
                  name status conclusion startedAt
                  checkSuite { app { databaseId } workflowRun { workflow { name } } }
                }
                ... on StatusContext { context state createdAt }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  }`;
  // gh pr view exports workflowName but omits the CheckRun app. Query the
  // exact head with GraphQL for both app and workflow provenance instead.
  const entries: Record<string, unknown>[] = [];
  const pageInfoQuery = "{nodes: .data.repository.object.statusCheckRollup.contexts.nodes, pageInfo: .data.repository.object.statusCheckRollup.contexts.pageInfo}";
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const args = ["api", "graphql", "--jq", pageInfoQuery,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `oid=${target}`];
    if (cursor !== null) args.push("-F", `endCursor=${cursor}`);
    args.push("-f", `query=${query}`);
    const page = await read(args);
    if (!page || typeof page !== "object" || Array.isArray(page)) throw new StageIntegrationChecksPending("the published integration's checks are malformed");
    const body = page as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
    if (!Array.isArray(body.nodes) || body.nodes.some(node => !node || typeof node !== "object" || Array.isArray(node))
      || !body.pageInfo || typeof body.pageInfo.hasNextPage !== "boolean"
      || (body.pageInfo.hasNextPage && (typeof body.pageInfo.endCursor !== "string" || !body.pageInfo.endCursor
        || seenCursors.has(body.pageInfo.endCursor)))) {
      throw new StageIntegrationChecksPending("the published integration's checks are malformed");
    }
    entries.push(...body.nodes as Record<string, unknown>[]);
    if (!body.pageInfo.hasNextPage) break;
    cursor = body.pageInfo.endCursor as string;
    seenCursors.add(cursor);
    if (pageNumber === 49) throw new StageIntegrationChecksPending("the published integration has too many check pages");
  }
  if (entries.some(entry => entry.__typename === "CheckRun"
    ? typeof entry.name !== "string" || !entry.name || typeof entry.status !== "string"
      || (entry.conclusion !== null && typeof entry.conclusion !== "string")
    : entry.__typename === "StatusContext"
      ? typeof entry.context !== "string" || !entry.context || typeof entry.state !== "string"
      : true)) throw new StageIntegrationChecksPending("the published integration's checks are malformed");
  const checks = rollupChecksWithIdentity(entries.map(entry => {
    if (entry.__typename === "StatusContext") return { ...entry, startedAt: entry.createdAt };
    const suite = entry.checkSuite && typeof entry.checkSuite === "object" ? entry.checkSuite as Record<string, unknown> : {};
    const app = suite.app && typeof suite.app === "object" ? suite.app as Record<string, unknown> : null;
    return { ...entry, app: app ? { ...app, id: app.databaseId } : undefined };
  }));
  if (!checks.length) throw new StageIntegrationChecksPending("the published integration is waiting for checks to register");
  if (checks.some(check => check.verdict === "red")) return false;
  const protection = await read(["api", `repos/${repository}/branches/${encodeURIComponent(pipeline.baseBranch)}`]) as {
    protected?: unknown; protection?: { required_status_checks?: { contexts?: unknown; checks?: unknown } };
  };
  if (!protection || typeof protection.protected !== "boolean"
    || (protection.protected && (!protection.protection || typeof protection.protection !== "object" || Array.isArray(protection.protection)))) return false;
  const required = protection.protection?.required_status_checks;
  if (required != null && (typeof required !== "object" || Array.isArray(required))) return false;
  const contexts = required?.contexts === undefined ? [] : required.contexts;
  const configured = required?.checks === undefined ? [] : required.checks;
  if (!Array.isArray(contexts) || !contexts.every(name => typeof name === "string")
    || !Array.isArray(configured) || !configured.every(check => check && typeof check === "object" && typeof check.context === "string"
      && (check.app_id === null || (typeof check.app_id === "number" && Number.isSafeInteger(check.app_id))))) return false;
  const requiredSatisfied = (name: string, appId?: number | null) => checks.some(check => check.name === name && check.verdict === "green"
    && (appId == null || (check.source === "check" && check.appId === appId)));
  if (checks.some(check => check.verdict !== "green")
    || contexts.some(name => !requiredSatisfied(name))
    || configured.some(check => !requiredSatisfied(check.context, check.app_id === -1 ? null : check.app_id as number | null))) {
    throw new StageIntegrationChecksPending("the published integration is waiting for green checks");
  }
  return true;
}

async function smallFile(file: string): Promise<string | null> {
  try {
    const fd = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error("stage Git receipt exceeds its bound");
      return buffer.toString("utf8", 0, bytesRead);
    } finally { await fd.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function recordedPushesForRef(directory: string, ref: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.opendir>>;
  try { entries = await fs.opendir(path.join(directory, "pushes")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const candidates: string[] = [];
  for await (const entry of entries) {
    if (!/^[0-9a-f]{40}$/.test(entry.name)) continue;
    const receipt = await smallFile(path.join(directory, "pushes", entry.name));
    if (receipt === null) throw new Error("stage push receipt disappeared");
    const [recordedRef, recordedUrl, trailing] = receipt.split("\n");
    if (!recordedRef || !recordedUrl || trailing !== "") throw new Error("stage push receipt is malformed");
    if (recordedRef === ref) candidates.push(entry.name);
  }
  return candidates;
}

async function hasCreatedCommits(directory: string | null): Promise<boolean> {
  if (!directory) return false;
  try {
    const entries = await fs.opendir(path.join(directory, "commits"));
    for await (const entry of entries) if (/^[0-9a-f]{40}$/.test(entry.name)) return true;
    return false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function stageAttemptPushRefusal(launchId: string | null): Promise<string | null> {
  if (!launchId) return null;
  try { return (await smallFile(path.join(stageGitReceiptDirectory(launchId), "refused")))?.trim() ?? null; }
  catch { return "the stage Git refusal receipt cannot be read"; }
}

/** Prove the producing attempt's commits before review. Ordinary settlement
 * may adopt its proved push. Repair mode only verifies a local descendant of
 * the accepted head; it never adopts a remote tip or writes Git history. */
export async function settleStageAttemptPush(pipeline: Pipeline, attempt: PipelineStageAttempt, execute: ExecPort, now: string,
  repair?: { acceptedHead: string }): Promise<PipelineGitResult | null> {
  const directory = attempt.launchId ? stageGitReceiptDirectory(attempt.launchId) : null;
  const refuse = (detail: string): PipelineGitResult => ({ ok: false, error: `settling the stage push: ${detail}; both tips are preserved` });
  const exec: ExecPort = (command, args, cwd, env, options) => execute(command, args, cwd, pipelineLiteralGitEnv(env), options);
  try {
    const refusal = await stageAttemptPushRefusal(attempt.launchId);
    if (refusal !== null) return refuse(refusal);
    const raw = directory ? await smallFile(path.join(directory, "start.json")) : null;
    if (raw === null && directory) {
      try { await fs.access(directory); return refuse("the attempt's starting-head receipt is missing"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Only launches predating start receipts use reflog recovery. Once a launch
    // receipt exists, its commit receipts are authoritative; reflog actions and
    // timestamps are caller-controlled metadata and cannot fill a missing one.
    const start = raw === null ? { launchId: attempt.launchId, worktree: pipeline.worktreeDir,
      head: pipeline.lastPassedCommit, startedAt: attempt.startedAt } : JSON.parse(raw);
    if (start.launchId !== attempt.launchId || start.worktree !== pipeline.worktreeDir
      || typeof start.head !== "string" || !/^[0-9a-f]{40}$/.test(start.head)
      || !Number.isFinite(Date.parse(start.startedAt)) || !attempt.startedAt
      || !Number.isFinite(Date.parse(attempt.startedAt)) || !Number.isFinite(Date.parse(now))
      || Date.parse(start.startedAt) < Date.parse(attempt.startedAt) || Date.parse(start.startedAt) > Date.parse(now)) return refuse("the attempt's starting-head receipt is invalid");
    const delivery = pipeline.delivery;
    if (!delivery || !delivery.active || delivery.disposition !== "owner" || delivery.ownerId !== pipeline.id
      || delivery.publish !== "enabled") return null;
    // Only durable same-stage replacement/decision edges carry creation proof.
    // A later start is a boundary to verify, never evidence of who made its prefix.
    const directories = directory ? [directory] : [];
    let anchor = start.head;
    let lineageCursor = start.head;
    const replacementStarts = new Set<string>();
    const run = pipeline.runs?.find(run => run.attempts.some(item => item.launchId === attempt.launchId));
    const attempts = new Map(run?.attempts.map(item => [item.n, item]));
    let child = attempt;
    let acceptedProofBoundary: string | null = null;
    for (const prior of run?.attempts ?? []) {
      if (prior.n >= attempt.n || !prior.launchId || !prior.startedAt) continue;
      const priorDirectory = stageGitReceiptDirectory(prior.launchId);
      if (directories.includes(priorDirectory) || await stageAttemptPushRefusal(prior.launchId) !== null) continue;
      const priorRaw = await smallFile(path.join(priorDirectory, "start.json"));
      if (priorRaw === null) continue;
      const priorStart = JSON.parse(priorRaw);
      if (priorStart.launchId !== prior.launchId || priorStart.worktree !== pipeline.worktreeDir
        || !/^[0-9a-f]{40}$/.test(priorStart.head ?? "")
        || !Number.isFinite(Date.parse(priorStart.startedAt)) || !Number.isFinite(Date.parse(prior.startedAt))
        || Date.parse(priorStart.startedAt) < Date.parse(prior.startedAt) || Date.parse(priorStart.startedAt) > Date.parse(now)) continue;
      directories.push(priorDirectory);
      replacementStarts.add(priorStart.head);
    }
    for (;;) {
      const decision = child.decisionAnswerId ? pipeline.decisionAnswers?.find(answer => answer.clientRequestId === child.decisionAnswerId
        && answer.stageId === run?.stageId && answer.nextAttempt === child.n
        && attempts.get(answer.attempt)?.verdict?.status === "pass") : undefined;
      const parentN = child.restartContext?.previousAttempt ?? decision?.attempt;
      if (parentN === undefined) break;
      const parent = attempts.get(parentN);
      if (!parent || parent.n >= child.n || !parent.launchId || !parent.completedAt
        || (!decision && (child.restartContext?.previousAttempt !== parent.n
          || child.restartContext.transcriptPath !== parent.agentPath
          || (parent.restartRecovery?.replacementAttempt !== undefined && parent.restartRecovery.replacementAttempt !== child.n))))
        return refuse("the replacement's creation lineage is invalid");
      const parentDirectory = stageGitReceiptDirectory(parent.launchId);
      const parentRaw = await smallFile(path.join(parentDirectory, "start.json"));
      const parentStart = parentRaw ? JSON.parse(parentRaw) : null;
      const parentRefusal = await stageAttemptPushRefusal(parent.launchId);
      if (!parentStart || parentStart.launchId !== parent.launchId || parentStart.worktree !== pipeline.worktreeDir
        || !/^[0-9a-f]{40}$/.test(parentStart.head ?? "") || !parent.startedAt
        || !Number.isFinite(Date.parse(parentStart.startedAt)) || !Number.isFinite(Date.parse(parent.startedAt))
        || Date.parse(parentStart.startedAt) < Date.parse(parent.startedAt) || Date.parse(parentStart.startedAt) > Date.parse(now)
        || (parentRefusal !== null && !(decision && parent.verdict?.status === "pass"))) return refuse("the replaced attempt's creation receipts are unavailable or invalid");
      if ((await exec("git", ["merge-base", "--is-ancestor", parentStart.head, lineageCursor], pipeline.worktreeDir)).code !== 0)
        return refuse("the replacement dropped its starting history");
      lineageCursor = parentStart.head;
      replacementStarts.add(parentStart.head);
      directories.push(parentDirectory);
      const acceptedBoundaries = [pipeline.lastPassedCommit, pipeline.publishedCommit]
        .filter((sha): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha));
      for (const boundary of acceptedBoundaries) {
        if ((await exec("git", ["merge-base", "--is-ancestor", boundary, parentStart.head], pipeline.worktreeDir)).code === 0) {
          acceptedProofBoundary = boundary;
          break;
        }
      }
      anchor = acceptedProofBoundary ?? parentStart.head;
      child = parent;
    }
    const remote = delivery.target.remote;
    if (!remote) return null;
    const ref = delivery.target.branch;
    const remoteHead = async (): Promise<string | null> => {
      const r = await exec("git", ["ls-remote", "--refs", remote, ref], pipeline.worktreeDir, undefined, { timeoutMs: 5000 });
      if (r.code !== 0) throw new StagePushRemoteUnavailable();
      if (!r.stdout.trim()) return null;
      const lines = r.stdout.trim().split("\n");
      const [sha, name] = lines[0].split(/\s+/);
      if (lines.length !== 1 || name !== ref || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("the delivery branch has no exact tip");
      return sha;
    };
    const local = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
    if (local.code !== 0) return refuse("the lane head cannot be read");
    const head = local.stdout.trim();
    const candidates = directory ? await recordedPushesForRef(directory, ref) : [];
    // No agent commit or push exists to adopt. Let the ordinary stage
    // committer preserve dirty output even while publication is offline.
    if (!repair && directories.length <= 1 && head === start.head && candidates.length === 0 && !await hasCreatedCommits(directory)) {
      const status = await exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
      if (status.code !== 0 || status.stdout.trim()) return null;
      // A scratch push can leave a clean checkout at the original head. Read
      // its remote before deciding that this stage produced nothing.
    }
    const tip = repair ? null : await remoteHead();
    const url = await exec("git", ["remote", "get-url", "--push", remote], pipeline.worktreeDir);
    const expectedUrl = url.code === 0 ? url.stdout.trim() : remote;
    if (tip && tip !== start.head) {
      const fetched = await exec("git", ["fetch", "--no-tags", remote, ref], pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
      if (fetched.code !== 0) throw new StagePushRemoteUnavailable();
    }
    for (const candidate of repair ? [] : candidates) {
      const receipt = await smallFile(path.join(directory!, "pushes", candidate));
      if (receipt !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
      if (!tip || (await exec("git", ["merge-base", "--is-ancestor", candidate, tip], pipeline.worktreeDir)).code !== 0) {
        return refuse("the recorded push candidate was not confirmed on the delivery remote");
      }
    }
    // Only accepted or durably published history, or a delivery tip whose
    // commits are independently verified, may bypass repeated receipt checks.
    const publishedPrefix = tip && (await exec("git", ["merge-base", "--is-ancestor", tip, start.head], pipeline.worktreeDir)).code === 0 ? tip : null;
    const historyPrefixes = new Set([pipeline.lastPassedCommit, pipeline.publishedCommit]
      .filter((sha): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)));
    let nativeCreated: Set<string> | undefined;
    const nativeCreation = async (sha: string): Promise<boolean> => {
      // Every existing start receipt, including a versionless one, requires
      // independent commit receipts. Shared identity and reflog text add none.
      if (raw !== null) return false;
      if (!nativeCreated) {
        const publicationIdentity = agentPublicationIdentityEnv(process.env);
        const expectedName = publicationIdentity.GIT_AUTHOR_NAME;
        const expectedEmail = publicationIdentity.GIT_AUTHOR_EMAIL;
        nativeCreated = new Set();
        const from = Math.floor(Date.parse(attempt.startedAt!) / 1000);
        const through = Math.floor(Date.parse(attempt.completedAt ?? now) / 1000);
        for (let offset = 0; ; offset += 128) {
          const reflog = await exec("git", ["reflog", "show", "--date=unix", "--format=%H%x00%gD%x00%gs",
            "--max-count=128", `--skip=${offset}`, `--since=${attempt.startedAt}`, `--until=${attempt.completedAt ?? now}`, "HEAD"], pipeline.worktreeDir);
          if (reflog.code !== 0) throw new Error("native worktree creation evidence is unavailable");
          const rows = reflog.stdout.trimEnd().split("\n").filter(Boolean);
          const candidates: string[] = [];
          for (const row of rows) {
            const [made, selector, action] = row.split("\0");
            const stamp = selector?.match(/@\{(\d+)\}$/)?.[1];
            if (!stamp || Number(stamp) < from || Number(stamp) > through || !/^[0-9a-f]{40}$/.test(made ?? "")) continue;
            if (/^(?:commit(?: \(initial\)| \(amend\))?|cherry-pick|am|rebase \((?:pick|reword|squash|fixup)\)): /.test(action ?? "")
              || /^merge .*: Merge made by /.test(action ?? "")) candidates.push(made);
          }
          if (candidates.length && expectedName && expectedEmail) {
            const identities = await exec("git", ["log", "--no-walk", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", ...candidates], pipeline.worktreeDir);
            if (identities.code !== 0) throw new Error("native worktree creation identity is unavailable");
            for (const identity of identities.stdout.trimEnd().split("\n")) {
              const [made, author, authorEmail, committer, committerEmail] = identity.split("\0");
              if (made && author === expectedName && authorEmail === expectedEmail
                && committer === expectedName && committerEmail === expectedEmail) nativeCreated.add(made);
            }
          }
          if (rows.length < 128) break;
        }
      }
      return nativeCreated.has(sha);
    };
    let baseTip: string | null | undefined;
    let integrationBase: string | null = null;
    const verifiedBase = async (): Promise<string | null> => {
      if (baseTip !== undefined) return baseTip;
      // The provisioning base may be the PR branch being published. It
      // cannot attest its own imported commits. Read origin's main directly;
      // neither the lane's pinned base nor a movable tracking ref proves it.
      const baseRef = `refs/heads/${DEFAULT_PIPELINE_BASE_BRANCH}`;
      const found = await exec("git", ["ls-remote", "--refs", "origin", baseRef], pipeline.worktreeDir, undefined, { timeoutMs: 5000 });
      if (found.code !== 0) throw new StagePushRemoteUnavailable();
      const [sha, name] = found.stdout.trim().split(/\s+/);
      if (!found.stdout.trim()) return baseTip = null;
      if (name !== baseRef || !/^[0-9a-f]{40}$/.test(sha) || found.stdout.trim().split("\n").length !== 1) throw new Error("base branch has no exact tip");
      const fetched = await exec("git", ["fetch", "--no-tags", "origin", sha], pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
      if (fetched.code !== 0) throw new StagePushRemoteUnavailable();
      return baseTip = sha;
    };
    const verifiedSuffix = async (target: string, from = repair?.acceptedHead ?? anchor): Promise<string | null> => {
      if (target === from) return null;
      if (target === tip && integrationBase !== null) return null;
      // A successor can start beyond its delivery branch. That older tip is
      // already accepted history; only the attempt's new suffix needs proof.
      if (target === publishedPrefix && (await exec("git", ["merge-base", "--is-ancestor", target, pipeline.lastPassedCommit], pipeline.worktreeDir)).code === 0) return null;
      let suffixAnchor = from;
      if ((await exec("git", ["merge-base", "--is-ancestor", suffixAnchor, target], pipeline.worktreeDir)).code !== 0) {
        if (repair || directories.length > 1) {
          for (const prefix of historyPrefixes) {
            if ((await exec("git", ["merge-base", "--is-ancestor", target, prefix], pipeline.worktreeDir)).code === 0) return null;
          }
          return `commit ${target} dropped accepted replacement history`;
        }
        // Local history rewrites still pass through the existing accepted-
        // content reconciliation in the stage committer. Prove their native
        // creation here; pushed adoption below retains its stricter ancestry.
        suffixAnchor = pipeline.baseRef;
        if ((await exec("git", ["merge-base", "--is-ancestor", suffixAnchor, target], pipeline.worktreeDir)).code !== 0)
          return `commit ${target} does not descend from the pipeline base`;
      }
      // Bound each read, not the number of commits a real stage may create.
      for (let offset = 0; ; offset += 128) {
        const log = await exec("git", ["rev-list", "--topo-order", "--max-count=128", `--skip=${offset}`, `${suffixAnchor}..${target}`,
          ...[...historyPrefixes].map(sha => `^${sha}`)], pipeline.worktreeDir);
        if (log.code !== 0) return `commit ${target} has unreadable ancestry`;
        const commits = log.stdout.trim().split("\n").filter(Boolean);
        if (offset === 0 && !commits.length) {
          for (const prefix of historyPrefixes) {
            if ((await exec("git", ["merge-base", "--is-ancestor", target, prefix], pipeline.worktreeDir)).code === 0) return null;
          }
          return `commit ${target} has no readable suffix evidence`;
        }
        for (const sha of commits) {
          if (!/^[0-9a-f]{40}$/.test(sha)) return `commit ${target} has malformed ancestry evidence`;
          let created = false;
          for (const receipts of directories) {
            if (await smallFile(path.join(receipts, "commits", sha)) === "") { created = true; break; }
          }
          if (created) continue;
          if (await nativeCreation(sha)) continue;
          // A stage merges current main to keep up. Its already published
          // ancestors belong to the base, so they need no stage receipt.
          const base = await verifiedBase();
          if (base && (await exec("git", ["merge-base", "--is-ancestor", sha, base], pipeline.worktreeDir)).code === 0) continue;
          if (!repair && directories.length === 1 && target === tip && base) {
            const integration = await verifyPassedHeadIntegration(pipeline, from, target, exec, base);
            if (integration.ok && await publishedIntegrationGreen(pipeline, target, base, expectedUrl, exec)) {
              integrationBase = base;
              return null;
            }
          }
          return `commit ${sha} was not created in the attempt worktree during this attempt and is absent from the verified base branch`;
        }
        if (commits.length < 128) break;
      }
      return null;
    };
    if (attempt.n > 1 || directories.length > 1) {
      // A retry can inherit history without a restartContext edge. Prove the
      // current start and each replacement start independently so a later
      // merge cannot hide an unaccepted prefix.
      for (const prefix of new Set([start.head, ...replacementStarts])) {
        const error = await verifiedSuffix(prefix, pipeline.baseRef);
        if (error) return refuse(error);
      }
    }
    if (publishedPrefix) {
      const error = await verifiedSuffix(publishedPrefix);
      if (error) return refuse(error);
      historyPrefixes.add(publishedPrefix);
    }
    if (repair || directories.length > 1) {
      // Replacements retain the head they were launched on, even when a
      // rewritten commit has a new receipt under the replacement's identity.
      if ((await exec("git", ["merge-base", "--is-ancestor", start.head, head], pipeline.worktreeDir)).code !== 0)
        return refuse(`commit ${head} dropped the attempt's starting history`);
    }
    if (repair) {
      if (!directory || await smallFile(path.join(directory, "commits", head)) !== "") return refuse(`commit ${head} has no producer creation receipt`);
      const error = await verifiedSuffix(head);
      if (error) return refuse(error);
      const status = await exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
      const branch = await exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
      const current = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
      if (status.code !== 0 || status.stdout.trim() || branch.code !== 0
        || ![pipeline.branch, ref.replace(/^refs\/heads\//, "")].includes(branch.stdout.trim())
        || current.code !== 0 || current.stdout.trim() !== head) return refuse("the producer repair requires a stable clean owned branch");
      return { ok: true, sha: head };
    }
    if (!tip) {
      const error = await verifiedSuffix(head);
      return error ? refuse(error) : null;
    }
    const pushed = directory ? await smallFile(path.join(directory, "pushes", tip)) : null;
    if (pushed === null) {
      // A remote behind the attempt's start is normal before publication. The
      // lane's own ancestry cannot prove an imported remote commit belongs to
      // this attempt.
      // A push can bypass pre-push (and legacy launches had no hook). Matching
      // tips still need creation proof for every commit before adoption.
      const error = await verifiedSuffix(tip);
      if (error) return refuse(error);
    }
    if (pushed !== null && pushed !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
    if (publishedPrefix) {
      const error = await verifiedSuffix(head);
      if (error) return refuse(error);
      if (await remoteHead() !== tip) return refuse("the remote tip raced the attempt proof");
      const current = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
      if (current.code !== 0 || current.stdout.trim() !== head) return refuse("the lane head raced the attempt proof");
      return null;
    }
    if (head !== start.head && head !== tip) {
      if ((await exec("git", ["merge-base", "--is-ancestor", tip, head], pipeline.worktreeDir)).code !== 0)
        return refuse(`commit ${head} moved away from the proved remote tip ${tip}`);
      const error = await verifiedSuffix(head);
      if (error) return refuse(error);
      if (await remoteHead() !== tip) return refuse("the remote tip raced the attempt proof");
      const current = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
      if (current.code !== 0 || current.stdout.trim() !== head) return refuse("the lane head raced the attempt proof");
      return null; // The ordinary committer publishes the proved local suffix.
    }
    const ancestor = await exec("git", ["merge-base", "--is-ancestor", start.head, tip], pipeline.worktreeDir);
    if (ancestor.code !== 0) return refuse("the pushed head does not descend from the attempt's starting head");
    for (const accepted of new Set([pipeline.baseRef, pipeline.lastPassedCommit])) {
      if (!/^[0-9a-f]{40}$/.test(accepted)
        || (await exec("git", ["merge-base", "--is-ancestor", accepted, tip], pipeline.worktreeDir)).code !== 0) return refuse("the pushed head would drop accepted history");
    }
    const proofError = await verifiedSuffix(tip);
    if (proofError) return refuse(proofError);
    if (integrationBase && !await integrationOrigin(pipeline, integrationBase, expectedUrl, exec)) return refuse("origin's default branch raced the integration proof");
    const status = await exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
    const branch = await exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
    if (status.code !== 0 || status.stdout.trim() || branch.code !== 0
      || ![pipeline.branch, ref.replace(/^refs\/heads\//, "")].includes(branch.stdout.trim())) return refuse("adoption requires a clean owned lane branch");
    if (await remoteHead() !== tip) return refuse("the remote tip raced the attempt proof");
    const current = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
    if (current.code !== 0 || current.stdout.trim() !== head) return refuse("the lane head raced the attempt proof");
    if (head !== tip) {
      const merged = await exec("git", ["merge", "--ff-only", "--no-overwrite-ignore", tip], pipeline.worktreeDir);
      if (merged.code !== 0) return refuse("the proved push could not fast-forward the lane");
    }
    if (await remoteHead() !== tip
      || (integrationBase && !await integrationOrigin(pipeline, integrationBase, expectedUrl, exec))) return refuse("the adopted remote moved before acceptance");
    const final = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
    const clean = await exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
    const finalBranch = await exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
    if (final.code !== 0 || final.stdout.trim() !== tip || clean.code !== 0 || clean.stdout.trim()
      || finalBranch.code !== 0 || finalBranch.stdout.trim() !== branch.stdout.trim()) return refuse("the adopted worktree moved before acceptance");
    return { ok: true, sha: tip };
  } catch (error) {
    if (error instanceof StageIntegrationChecksPending) return { ok: false, deferred: true, error: error.message };
    if (error instanceof StagePushRemoteUnavailable) return { ok: false, deferred: true,
      error: "stage push verification is waiting for the delivery remote" };
    return refuse("the attempt's Git evidence could not be verified");
  }
}
