import fs from "node:fs/promises";
import path from "node:path";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import type { ExecPort } from "@/lib/workflows/provision";
import { pipelineLiteralGitEnv, type PipelineGitResult } from "./git";
import type { Pipeline, PipelineStageAttempt } from "./types";

class StagePushRemoteUnavailable extends Error {}

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

/** Runs only during the producing attempt's settlement, before a review can
 * name its head. Publication recovery never calls this adoption path. */
export async function settleStageAttemptPush(pipeline: Pipeline, attempt: PipelineStageAttempt, execute: ExecPort, now: string): Promise<PipelineGitResult | null> {
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
    // A start receipt from before complete hook coverage cannot distinguish a
    // missing legacy merge receipt from a current unproved commit. Only those
    // historical launches may use the identity-checked reflog recovery path.
    const allowLegacyNativeCreation = raw === null || start.commitReceiptVersion !== 1;
    const delivery = pipeline.delivery;
    if (!delivery || !delivery.active || delivery.disposition !== "owner" || delivery.ownerId !== pipeline.id
      || delivery.publish !== "enabled") return null;
    const remote = delivery.target.remote;
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
    if (head === start.head && candidates.length === 0 && !await hasCreatedCommits(directory)) return null;
    const tip = await remoteHead();
    const url = await exec("git", ["remote", "get-url", "--push", remote], pipeline.worktreeDir);
    const expectedUrl = url.code === 0 ? url.stdout.trim() : remote;
    for (const candidate of candidates) {
      const receipt = await smallFile(path.join(directory!, "pushes", candidate));
      if (receipt !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
      if (!tip || (await exec("git", ["merge-base", "--is-ancestor", candidate, tip], pipeline.worktreeDir)).code !== 0) {
        return refuse("the recorded push candidate was not confirmed on the delivery remote");
      }
    }
    let nativeCreated: Set<string> | undefined;
    // Older launches may have installed start.json before their hook set was
    // complete. Reflog entries recover those missing receipts only when the
    // commit carries the publication identity pinned into the producing agent.
    const publicationIdentity = agentPublicationIdentityEnv(process.env);
    const expectedName = publicationIdentity.GIT_AUTHOR_NAME;
    const expectedEmail = publicationIdentity.GIT_AUTHOR_EMAIL;
    const nativeCreation = async (sha: string): Promise<boolean> => {
      if (!allowLegacyNativeCreation) return false;
      if (!nativeCreated) {
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
    const verifiedBase = async (): Promise<string | null> => {
      if (baseTip !== undefined) return baseTip;
      const baseRef = `refs/heads/${pipeline.baseBranch}`;
      const found = await exec("git", ["ls-remote", "--refs", remote, baseRef], pipeline.worktreeDir, undefined, { timeoutMs: 5000 });
      if (found.code !== 0) throw new StagePushRemoteUnavailable();
      const [sha, name] = found.stdout.trim().split(/\s+/);
      if (!found.stdout.trim()) return baseTip = null;
      if (name !== baseRef || !/^[0-9a-f]{40}$/.test(sha) || found.stdout.trim().split("\n").length !== 1) throw new Error("base branch has no exact tip");
      const fetched = await exec("git", ["fetch", "--no-tags", remote, sha], pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
      if (fetched.code !== 0) throw new StagePushRemoteUnavailable();
      return baseTip = sha;
    };
    const verifiedSuffix = async (target: string): Promise<string | null> => {
      if (target === start.head) return null;
      let anchor = start.head;
      if ((await exec("git", ["merge-base", "--is-ancestor", anchor, target], pipeline.worktreeDir)).code !== 0) {
        // Local history rewrites still pass through the existing accepted-
        // content reconciliation in the stage committer. Prove their native
        // creation here; pushed adoption below retains its stricter ancestry.
        anchor = pipeline.baseRef;
        if ((await exec("git", ["merge-base", "--is-ancestor", anchor, target], pipeline.worktreeDir)).code !== 0)
          return `commit ${target} does not descend from the pipeline base`;
      }
      // Bound each read, not the number of commits a real stage may create.
      for (let offset = 0; ; offset += 128) {
        const log = await exec("git", ["rev-list", "--topo-order", "--max-count=128", `--skip=${offset}`, `${anchor}..${target}`], pipeline.worktreeDir);
        if (log.code !== 0) return `commit ${target} has unreadable ancestry`;
        const commits = log.stdout.trim().split("\n").filter(Boolean);
        if (offset === 0 && !commits.length) return `commit ${target} has no readable suffix evidence`;
        for (const sha of commits) {
          if (!/^[0-9a-f]{40}$/.test(sha)) return `commit ${target} has malformed ancestry evidence`;
          if (directory && await smallFile(path.join(directory, "commits", sha)) === "") continue;
          if (await nativeCreation(sha)) continue;
          // A stage merges current main to keep up. Its already published
          // ancestors belong to the base, so they need no stage receipt.
          const base = await verifiedBase();
          if (base && (await exec("git", ["merge-base", "--is-ancestor", sha, base], pipeline.worktreeDir)).code === 0) continue;
          return `commit ${sha} was not created in the attempt worktree during this attempt and is absent from the verified base branch`;
        }
        if (commits.length < 128) break;
      }
      return null;
    };
    if (!tip) {
      const error = await verifiedSuffix(head);
      return error ? refuse(error) : null;
    }
    const pushed = directory ? await smallFile(path.join(directory, "pushes", tip)) : null;
    if (pushed === null) {
      // A remote behind the attempt's start is normal before publication. The
      // lane's own ancestry cannot prove an imported remote commit belongs to
      // this attempt.
      const known = await exec("git", ["merge-base", "--is-ancestor", tip, start.head], pipeline.worktreeDir);
      if (known.code === 0) {
        const error = await verifiedSuffix(head);
        return error ? refuse(error) : null;
      }
      // A push can bypass pre-push (and legacy launches had no hook). Matching
      // tips still need creation proof for every commit before adoption.
      const error = await verifiedSuffix(tip);
      if (error) return refuse(error);
    }
    if (pushed !== null && pushed !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
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
    const fetched = await exec("git", ["fetch", "--no-tags", remote, ref], pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
    if (fetched.code !== 0) return refuse("the pushed commit could not be fetched");
    const ancestor = await exec("git", ["merge-base", "--is-ancestor", start.head, tip], pipeline.worktreeDir);
    if (ancestor.code !== 0) return refuse("the pushed head does not descend from the attempt's starting head");
    for (const accepted of new Set([pipeline.baseRef, pipeline.lastPassedCommit])) {
      if (!/^[0-9a-f]{40}$/.test(accepted)
        || (await exec("git", ["merge-base", "--is-ancestor", accepted, tip], pipeline.worktreeDir)).code !== 0) return refuse("the pushed head would drop accepted history");
    }
    const proofError = await verifiedSuffix(tip);
    if (proofError) return refuse(proofError);
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
    const final = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
    const clean = await exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
    if (final.code !== 0 || final.stdout.trim() !== tip || clean.code !== 0 || clean.stdout.trim()
      || await remoteHead() !== tip) return refuse("the adopted worktree or remote moved before acceptance");
    return { ok: true, sha: tip };
  } catch (error) {
    if (error instanceof StagePushRemoteUnavailable) return { ok: false, deferred: true,
      error: "stage push verification is waiting for the delivery remote" };
    return refuse("the attempt's Git evidence could not be verified");
  }
}
