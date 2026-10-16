import fs from "node:fs/promises";
import path from "node:path";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
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
  let inspected = 0;
  const candidates: string[] = [];
  for await (const entry of entries) {
    if (++inspected > 256) throw new Error("too many stage push receipts");
    if (!/^[0-9a-f]{40}$/.test(entry.name)) continue;
    const receipt = await smallFile(path.join(directory, "pushes", entry.name));
    if (receipt === null) throw new Error("stage push receipt disappeared");
    const [recordedRef, recordedUrl, trailing] = receipt.split("\n");
    if (!recordedRef || !recordedUrl || trailing !== "") throw new Error("stage push receipt is malformed");
    if (recordedRef === ref) candidates.push(entry.name);
  }
  return candidates;
}

export async function stageAttemptPushRefusal(launchId: string | null): Promise<string | null> {
  if (!launchId) return null;
  try { return (await smallFile(path.join(stageGitReceiptDirectory(launchId), "refused")))?.trim() ?? null; }
  catch { return "the stage Git refusal receipt cannot be read"; }
}

/** Runs only during the producing attempt's settlement, before a review can
 * name its head. Publication recovery never calls this adoption path. */
export async function settleStageAttemptPush(pipeline: Pipeline, attempt: PipelineStageAttempt, execute: ExecPort, now: string): Promise<PipelineGitResult | null> {
  if (!attempt.launchId) return null; // Older attempts have no attestation.
  const directory = stageGitReceiptDirectory(attempt.launchId);
  const refuse = (detail: string): PipelineGitResult => ({ ok: false, error: `settling the stage push: ${detail}; both tips are preserved` });
  const exec: ExecPort = (command, args, cwd, env, options) => execute(command, args, cwd, pipelineLiteralGitEnv(env), options);
  try {
    const refusal = await stageAttemptPushRefusal(attempt.launchId);
    if (refusal !== null) return refuse(refusal);
    const raw = await smallFile(path.join(directory, "start.json"));
    if (raw === null) {
      try { await fs.access(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      return refuse("the attempt's starting-head receipt is missing");
    }
    const start = JSON.parse(raw);
    if (start.launchId !== attempt.launchId || start.worktree !== pipeline.worktreeDir
      || typeof start.head !== "string" || !/^[0-9a-f]{40}$/.test(start.head)
      || !Number.isFinite(Date.parse(start.startedAt)) || !attempt.startedAt
      || !Number.isFinite(Date.parse(attempt.startedAt)) || !Number.isFinite(Date.parse(now))
      || Date.parse(start.startedAt) < Date.parse(attempt.startedAt) || Date.parse(start.startedAt) > Date.parse(now)) return refuse("the attempt's starting-head receipt is invalid");
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
    const tip = await remoteHead();
    const local = await exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
    if (local.code !== 0) return refuse("the lane head cannot be read");
    const head = local.stdout.trim();
    const candidates = await recordedPushesForRef(directory, ref);
    const url = await exec("git", ["remote", "get-url", "--push", remote], pipeline.worktreeDir);
    const expectedUrl = url.code === 0 ? url.stdout.trim() : remote;
    for (const candidate of candidates) {
      const receipt = await smallFile(path.join(directory, "pushes", candidate));
      if (receipt !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
      if (!tip || (await exec("git", ["merge-base", "--is-ancestor", candidate, tip], pipeline.worktreeDir)).code !== 0) {
        return refuse("the recorded push candidate was not confirmed on the delivery remote");
      }
    }
    const verifiedSuffix = async (target: string): Promise<boolean> => {
      if (target === start.head) return true;
      if ((await exec("git", ["merge-base", "--is-ancestor", start.head, target], pipeline.worktreeDir)).code !== 0) return false;
      const log = await exec("git", ["log", "--no-show-signature", "--no-notes", "--no-color", "--max-count=257", "--format=%H %ct", `${start.head}..${target}`], pipeline.worktreeDir);
      const commits = log.stdout.trim().split("\n");
      if (log.code !== 0 || commits.length > 256 || !log.stdout.trim()) return false;
      const from = Math.floor(Date.parse(start.startedAt) / 1000);
      const through = Math.floor(Date.parse(attempt.completedAt ?? now) / 1000);
      for (const line of commits) {
        const [sha, stamp] = line.split(" ");
        if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(stamp) || Number(stamp) < from || Number(stamp) > through
          || await smallFile(path.join(directory, "commits", sha)) !== "") return false;
      }
      return true;
    };
    if (!tip) {
      return await verifiedSuffix(head) ? null
        : refuse("the lane suffix contains a commit not proved to have been made during this attempt");
    }
    const pushed = await smallFile(path.join(directory, "pushes", tip));
    if (pushed === null) {
      // A remote behind the attempt's start is normal before publication. The
      // lane's own ancestry cannot prove an imported remote commit belongs to
      // this attempt.
      const known = await exec("git", ["merge-base", "--is-ancestor", tip, start.head], pipeline.worktreeDir);
      if (known.code !== 0) return refuse("the remote tip has no push receipt from this attempt; commit in the lane worktree and let Delegatus publish");
      return await verifiedSuffix(head) ? null
        : refuse("the lane suffix contains a commit not proved to have been made during this attempt");
    }
    if (pushed !== `${ref}\n${expectedUrl}\n`) return refuse("the push receipt names another delivery target");
    if (head !== start.head && head !== tip) return refuse("the lane moved away from the attempt's starting head");
    const fetched = await exec("git", ["fetch", "--no-tags", remote, ref], pipeline.worktreeDir, undefined, { timeoutMs: 10000 });
    if (fetched.code !== 0) return refuse("the pushed commit could not be fetched");
    const ancestor = await exec("git", ["merge-base", "--is-ancestor", start.head, tip], pipeline.worktreeDir);
    if (ancestor.code !== 0) return refuse("the pushed head does not descend from the attempt's starting head");
    for (const accepted of new Set([pipeline.baseRef, pipeline.lastPassedCommit])) {
      if (!/^[0-9a-f]{40}$/.test(accepted)
        || (await exec("git", ["merge-base", "--is-ancestor", accepted, tip], pipeline.worktreeDir)).code !== 0) return refuse("the pushed head would drop accepted history");
    }
    if (!await verifiedSuffix(tip)) return refuse("the pushed suffix exceeds the attempt proof bound or includes a commit not proved to have been made during this attempt");
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
