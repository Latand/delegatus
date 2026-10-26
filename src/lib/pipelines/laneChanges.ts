import fs from "node:fs";

import { diffFromGitFilePatch, REVIEW_DIFF_CAPS, type FileDiff } from "@/components/feed/diff";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { ExecOptions, ExecPort } from "@/lib/workflows/provision";
import { DEFAULT_PIPELINE_BASE_BRANCH, pipelineWorktreeChanges } from "./git";
import type { Pipeline } from "./types";

/* A lane's committed changes for the review sheet
   (docs/design/lane-diff-comments.md §1). The comparison follows the
   merge-base rule `publicationChangedPaths` uses in git.ts, which stays
   private and unchanged. Every git call runs in the repository checkout,
   since worktrees share its refs and the lane's worktree may be gone. */

export const LANE_CHANGE_LIMITS = { files: 200, uncommitted: 1_000 } as const;

const GIT_OPTIONS: ExecOptions = { timeoutMs: 10_000 };
const SHA_RE = /^[0-9a-f]{40}$/;

export type LaneChangeOp = "add" | "update" | "delete";
export type LaneChangeFile = { path: string; op: LaneChangeOp; added: number; removed: number; binary: boolean };

export type LaneRevisions = { base: string; head: string; baseSource: "merge-base" | "base-ref"; headSource: "branch" | "last-passed" };

export type LaneChangeSummary = LaneRevisions & {
  branch: string;
  baseBranch: string;
  files: LaneChangeFile[];
  /** Every changed file, listed or not. */
  total: number;
  truncated: boolean;
  /** Paths the worktree holds uncommitted; never in the list. */
  uncommitted: number;
};

export type LaneReviewTarget = { conversationId: string; stageId: string; attempt: number; stageName: string; engine: string };

export type LaneChangeError = { error: string; code: "head_unavailable" | "base_unavailable" | "git_failed" | "path_not_changed" };

type LanePipeline = Pick<Pipeline, "repoDir" | "worktreeDir" | "branch" | "baseBranch" | "baseRef" | "lastPassedCommit">;

async function commitOf(pipeline: LanePipeline, revision: string, exec: ExecPort): Promise<string | null> {
  const result = await exec("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], pipeline.repoDir, undefined, GIT_OPTIONS);
  const sha = result.stdout.trim();
  return result.code === 0 && SHA_RE.test(sha) ? sha : null;
}

/** Head is the branch tip, else the last passed commit once the branch is
    gone; base is the merge base with the fetched base branch, else baseRef. */
export async function resolveLaneRevisions(pipeline: LanePipeline, exec: ExecPort): Promise<LaneRevisions | LaneChangeError> {
  let head = pipeline.branch ? await commitOf(pipeline, `refs/heads/${pipeline.branch}`, exec) : null;
  let headSource: LaneRevisions["headSource"] = "branch";
  if (!head && SHA_RE.test(pipeline.lastPassedCommit ?? "")) {
    head = await commitOf(pipeline, pipeline.lastPassedCommit, exec);
    headSource = "last-passed";
  }
  if (!head) return { error: "the lane has no branch and no passed commit to compare", code: "head_unavailable" };
  const baseBranch = pipeline.baseBranch || DEFAULT_PIPELINE_BASE_BRANCH;
  const merged = await exec("git", ["merge-base", head, `refs/remotes/origin/${baseBranch}`], pipeline.repoDir, undefined, GIT_OPTIONS);
  const mergeBase = merged.stdout.trim();
  if (merged.code === 0 && SHA_RE.test(mergeBase)) return { base: mergeBase, head, baseSource: "merge-base", headSource };
  const base = pipeline.baseRef ? await commitOf(pipeline, pipeline.baseRef, exec) : null;
  if (!base) return { error: "the lane's base commit cannot be resolved", code: "base_unavailable" };
  return { base, head, baseSource: "base-ref", headSource };
}

const nulFields = (stdout: string): string[] | null => (!stdout || stdout.endsWith("\0") ? stdout.split("\0").slice(0, -1) : null);

/** Every file `base..head` changes, with its op and line counts, in git's order. */
export async function laneChangeFiles(pipeline: LanePipeline, base: string, head: string, exec: ExecPort): Promise<LaneChangeFile[] | null> {
  const common = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "-z"];
  const [numstat, status] = await Promise.all([
    exec("git", [...common, "--numstat", base, head], pipeline.repoDir, undefined, GIT_OPTIONS),
    exec("git", [...common, "--name-status", base, head], pipeline.repoDir, undefined, GIT_OPTIONS),
  ]);
  if (numstat.code !== 0 || status.code !== 0) return null;
  const counts = nulFields(numstat.stdout);
  const statuses = nulFields(status.stdout);
  if (!counts || !statuses || statuses.length % 2) return null;
  /* --numstat -z: `added\tremoved\tpath` per record; `-\t-` marks binary. */
  const stats = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const record of counts) {
    const match = record.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!match) return null;
    const binary = match[1] === "-" && match[2] === "-";
    stats.set(match[3], { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }
  const files: LaneChangeFile[] = [];
  for (let i = 0; i < statuses.length; i += 2) {
    const letter = statuses[i][0];
    const path = statuses[i + 1];
    const stat = stats.get(path) ?? { added: 0, removed: 0, binary: false };
    files.push({ path, op: letter === "A" ? "add" : letter === "D" ? "delete" : "update", ...stat });
  }
  return files;
}

export async function laneChangeSummary(pipeline: LanePipeline, exec: ExecPort): Promise<LaneChangeSummary | LaneChangeError> {
  return withViewerOperation("pipelines.laneChanges", async () => {
    const revisions = await resolveLaneRevisions(pipeline, exec);
    if ("error" in revisions) return revisions;
    const files = await laneChangeFiles(pipeline, revisions.base, revisions.head, exec);
    if (!files) return { error: "git could not list the lane's changes", code: "git_failed" };
    let uncommitted = 0;
    if (pipeline.worktreeDir && fs.existsSync(pipeline.worktreeDir)) {
      const changes = await pipelineWorktreeChanges(pipeline, exec, LANE_CHANGE_LIMITS.uncommitted);
      if (changes.ok) uncommitted = changes.paths.length;
    }
    return {
      ...revisions,
      branch: pipeline.branch,
      baseBranch: pipeline.baseBranch || DEFAULT_PIPELINE_BASE_BRANCH,
      files: files.slice(0, LANE_CHANGE_LIMITS.files),
      total: files.length,
      truncated: files.length > LANE_CHANGE_LIMITS.files,
      uncommitted,
    };
  });
}

/** One file's diff over exactly this pair. A path the pair does not change is
    refused before git sees it, and git reads it as a literal path. */
export async function laneFileDiff(pipeline: LanePipeline, base: string, head: string, path: string, exec: ExecPort, listed?: readonly LaneChangeFile[]): Promise<FileDiff | LaneChangeError> {
  return withViewerOperation("pipelines.laneChanges", async () => {
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) return { error: "base and head must be full commit ids", code: "git_failed" };
    const files = listed ?? await laneChangeFiles(pipeline, base, head, exec);
    if (!files) return { error: "git could not list the lane's changes", code: "git_failed" };
    const file = files.find((entry) => entry.path === path);
    if (!file) return { error: "this path is not changed between base and head", code: "path_not_changed" };
    const patch = await exec("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "-U3", base, head, "--", path], pipeline.repoDir, undefined, GIT_OPTIONS);
    if (patch.code !== 0) return { error: "git could not read the file's diff", code: "git_failed" };
    const diff = diffFromGitFilePatch(path, file.op, patch.stdout, REVIEW_DIFF_CAPS);
    /* numstat's counts are the whole file's, before any cap. */
    return file.binary ? { ...diff, binary: true, hunks: [] } : { ...diff, added: file.added, removed: file.removed };
  });
}

/**
 * The agent a review goes to: the newest non-historical attempt that may write
 * to the branch and has a conversation. Unlike `stagePullRequestProducer`, a
 * writer still running counts, because it is exactly the agent to tell.
 */
export function laneReviewTarget(pipeline: Pick<Pipeline, "runs" | "stages">): LaneReviewTarget | null {
  const attempts = pipeline.runs.flatMap((run) => run.attempts.map((attempt) => ({ run, attempt })))
    .filter(({ attempt }) => !attempt.historical && attempt.effectiveRole?.access !== "read-only" && attempt.conversationId)
    .sort((a, b) => (b.attempt.startedAt ?? "").localeCompare(a.attempt.startedAt ?? ""));
  const chosen = attempts[0];
  if (!chosen) return null;
  return {
    conversationId: chosen.attempt.conversationId!,
    stageId: chosen.run.stageId,
    attempt: chosen.attempt.n,
    stageName: chosen.run.stageId,
    engine: chosen.attempt.effectiveRole?.engine ?? "",
  };
}
