import os from "node:os";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalProject } from "@/lib/projects/aliases";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { fileBudgetFollowUp } from "@/lib/pipelines/budgetFollowUp";
import { realExec } from "@/lib/workflows/provision";

import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { ForgeAppWriteRefused, forgeAppWriter, forgeWriter, type ForgeAppWriter } from "./appWrite";
import { failEdgeExhaustion, terminalReviewBudgetSpent } from "@/lib/pipelines/failEdgeBudget";
import { withPipelineMutation } from "@/lib/pipelines/store";
import { openPipelinesOnTask } from "@/lib/pipelines/taskFinish";
import { PIPELINE_MERGE_LIVE_STATES, type Pipeline, type PipelineMerge, type PipelineMergeMethod, type PipelineStage } from "@/lib/pipelines/types";
import { mergeOnReviewSetting, type MergeOnReviewSetting } from "@/lib/projects/settings";
import { patchTask } from "@/lib/tasks/commands";
import { mutateTasks } from "@/lib/tasks/store";

import { forgeCacheView } from "./cache";
import { checkFailedReason, MERGE_REASONS } from "./mergeReasons";
import { pipelineRepository, pipelineWorkLinks } from "./resolve";
import { githubRepositoryOfRemote, type PullRequestState } from "./workLinks";

/*
 * "Merge when the review passes" (#2187 §4, docs/design/merge-policy-and-task-finishing.md).
 *
 * A completed lane of a project that turned the setting on, whose reviews
 * passed (§4.2), is queued here and merged through GitHub with `gh`, one lane
 * at a time per repository, once its PR's checks have arrived, settled and are
 * green (§4.3). Scheduled beside the forge sweep from the controller cycle and,
 * like it, run outside every pipeline lease: the `gh` calls happen with no
 * lock held, and each result is written under the pipeline lock against the
 * record read again inside it.
 *
 * Nothing here resolves a conflict, pushes, posts a comment or adds a trailer.
 * What cannot be settled by waiting blocks with one plain sentence and goes to
 * the operator (§4.6).
 */

export const MERGE_POLL_MS = 60_000;
/** The least time a head's checks must have had to register (§4.3). */
export const MERGE_SETTLE_MS = 3 * 60_000;
/** The most time a head may take to settle, from its first read. */
export const MERGE_WAIT_LIMIT_MS = 90 * 60_000;
/** `update-branch` calls per attempt; the next one blocks. */
export const MERGE_MAX_UPDATES = 3;
/** Reads in a row `gh` may fail before the merge blocks. */
export const MERGE_READ_FAILURE_LIMIT = 3;
const MERGE_SCHEDULE_DEBOUNCE_MS = 15_000;
const REPOSITORY_FACTS_TTL_MS = 30 * 60_000;
const GH_TIMEOUT_MS = 30_000;

const PR_FIELDS = "state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,mergeCommit,mergedAt";
export { MERGE_REASONS };

export interface AutoMergePorts {
  now: () => number;
  run: GithubRunner;
  /** Every write to GitHub (the branch update and the merge) goes through
      this. In a declared App repository it goes out as the Delegatus GitHub
      App, and one it cannot authenticate as the App throws and nothing is
      sent; in any other repository it is `run`. `run` itself only reads. */
  write: ForgeAppWriter;
  loadPipelines: () => readonly Pipeline[];
  /** Applies `change` to the live record under the pipeline lock and persists
      it when `change` answers true. False when the record is gone or unchanged. */
  mutate: (pipelineId: string, change: (pipeline: Pipeline) => boolean) => Promise<boolean>;
  setting: (project: string) => MergeOnReviewSetting;
  /** The one pull request the lane's own records join to it, else null. */
  pullRequestOf: (pipeline: Pipeline) => { repository: string; number: number } | null;
  /** What the forge cache last read for a pull request, for a merge the
      runner no longer polls (blocked or cancelled) that someone merged. */
  cachedState: (repository: string, number: number) => PullRequestState | null;
  /** Standalone merger custody; a busy merger holds this project’s queue. */
  mergerBusy?: (project: string) => boolean;
  log?: (message: string, error?: unknown) => void;
  /** Moves a board task to Done for the finish sweep (#2187 §5.3) and says
      what it found. Absent, the finish sweep does not run. */
  finishTask?: (taskId: string, pipelineId: string) => TaskFinishOutcome;
  fileFollowUp?: (pipeline: Pipeline, mergedHead: string) => { taskId: string; title: string };
}

export type TaskFinishOutcome = "moved" | "already-done" | "missing" | "refused";

/* ── Eligibility (§4.2) ─────────────────────────────────────────────────── */

/** A review stage: a legacy review loop, or a read-only run stage that owns
    a fail edge (§3.4). */
export function isReviewStage(pipeline: Pipeline, stage: PipelineStage): boolean {
  if (stage.kind === "review-loop") return true;
  if (stage.kind !== "run" || !stage.onFail) return false;
  const latest = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((attempt) => !attempt.historical).at(-1);
  /* Older creator plans used a writable `review` run stage with a fail edge.
     Its passed verdict is still the review gate; excluding it stranded
     completed lanes before they could acquire a merge record. */
  return /(?:^|[-_])review$/.test(stage.id) || (latest?.effectiveRole?.access ?? stage.effectiveRole?.access ?? stage.access ?? "read-write") === "read-only";
}

/**
 * Whether a completed lane's reviews passed: at least one review stage ran,
 * and every one that ran ended passed, was accepted by the operator (skipped,
 * or its unreviewed head accepted with `accept-head`), or spent its budget
 * with the fix of its last findings passed.
 */
export function mergeEligible(pipeline: Pipeline): boolean {
  if (pipeline.state !== "completed") return false;
  let reviewed = 0;
  for (const stage of pipeline.stages) {
    if (!isReviewStage(pipeline, stage)) continue;
    const latest = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((attempt) => !attempt.historical).at(-1);
    if (!latest) continue;
    reviewed += 1;
    if (latest.state === "passed" || latest.state === "skipped") continue;
    if (latest.verdict?.status === "fail" && terminalReviewBudgetSpent(latest, true)) continue;
    if ((pipeline.reviewAcceptances ?? []).some((acceptance) => acceptance.stageId === stage.id && acceptance.attempt === latest.n)) continue;
    const spent = pipeline.reviewBudgetSpent;
    if (spent?.stageId === stage.id && spent.attempt === latest.n) continue;
    if (latest.budgetSpent && stage.onFail && failEdgeExhaustion(stage.onFail) !== "park") {
      const fix = pipeline.runs.find((run) => run.stageId === stage.onFail!.to)?.attempts.find((attempt) => !attempt.historical
        && attempt.state === "passed"
        && attempt.activatedBy?.edge === "fail"
        && attempt.activatedBy.budgetSpent === true
        && attempt.activatedBy.stageId === stage.id
        && attempt.activatedBy.attempt === latest.n);
      if (fix) continue;
    }
    return false;
  }
  return reviewed > 0;
}

/** The lane's pull request (§4.2 rule 1): its delivery's, or the one the
    forge cache joins to it. No PR, several, or a comparison delivery: none. */
export function lanePullRequest(pipeline: Pipeline): { repository: string; number: number } | null {
  if (pipeline.delivery?.disposition === "comparison") return null;
  const deliveryPr = pipeline.delivery?.target.pr;
  if (deliveryPr) {
    const repository = githubRepositoryOfRemote(pipeline.delivery?.target.remote) ?? pipelineRepository(pipeline);
    return repository ? { repository, number: deliveryPr } : null;
  }
  const prs = pipelineWorkLinks(pipeline).links.filter((link) => link.kind === "pr");
  return prs.length === 1 ? { repository: prs[0]!.repository, number: prs[0]!.number } : null;
}

/* ── Reading GitHub ─────────────────────────────────────────────────────── */

export { rollupChecks } from "./checkRollup";
export type { CheckVerdict, ReadCheck, PullRequestView } from "./checkRollup";
import { rollupChecks, type PullRequestView, type ReadCheck } from "./checkRollup";

export function parsePullRequestView(raw: string): PullRequestView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const view = parsed as Record<string, unknown>;
  if (typeof view.state !== "string" || typeof view.headRefOid !== "string" || !view.headRefOid) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const commit = view.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    state: view.state,
    isDraft: view.isDraft === true,
    headRefOid: view.headRefOid,
    baseRefName: text(view.baseRefName) ?? "",
    mergeable: text(view.mergeable),
    mergeStateStatus: text(view.mergeStateStatus),
    reviewDecision: text(view.reviewDecision),
    mergeCommit: text(commit?.oid),
    mergedAt: text(view.mergedAt),
    checks: rollupChecks(view.statusCheckRollup),
  };
}

/** GitHub's own words from a failed `gh` call, one line, bounded. */
export function githubMessage(error: unknown): string {
  const detail = error as { stderr?: unknown; message?: unknown } | null | undefined;
  const raw = `${typeof detail?.stderr === "string" ? detail.stderr : ""}\n${typeof detail?.message === "string" ? detail.message : ""}`;
  const line = raw.split("\n").map((part) => part.replace(/^gh:\s*/, "").trim()).find((part) => part && !/^Command failed/.test(part)) ?? "no answer";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

type RepositoryFacts = { method: PipelineMergeMethod; required: Map<string, { contexts: string[]; readAt: number }>; readAt: number };

const factsHost = globalThis as typeof globalThis & { __llvAutoMergeFacts?: Map<string, RepositoryFacts> };
const repositoryFacts = () => (factsHost.__llvAutoMergeFacts ??= new Map());

/** The merge method the repository allows, read once per repository:
    squash, else a merge commit, else rebase. */
async function mergeMethod(repository: string, ports: AutoMergePorts): Promise<PipelineMergeMethod> {
  const cached = repositoryFacts().get(repository);
  if (cached && ports.now() - cached.readAt < REPOSITORY_FACTS_TTL_MS) return cached.method;
  const raw = await ports.run(["repo", "view", repository, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
  const allowed = JSON.parse(raw) as { squashMergeAllowed?: unknown; mergeCommitAllowed?: unknown; rebaseMergeAllowed?: unknown };
  const method: PipelineMergeMethod = allowed.squashMergeAllowed !== false ? "squash" : allowed.mergeCommitAllowed !== false ? "merge" : "rebase";
  repositoryFacts().set(repository, { method, required: cached?.required ?? new Map(), readAt: ports.now() });
  return method;
}

/** The base branch's required contexts, read once per repository and base.
    An unprotected branch answers none. */
async function requiredContexts(repository: string, base: string, ports: AutoMergePorts): Promise<string[]> {
  const facts = repositoryFacts().get(repository);
  const cached = facts?.required.get(base);
  if (cached && ports.now() - cached.readAt < REPOSITORY_FACTS_TTL_MS) return cached.contexts;
  const raw = await ports.run(["api", `repos/${repository}/branches/${base}`, "--jq", ".protection.required_status_checks.contexts"]);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw.trim() || "null");
  } catch {
    parsed = null;
  }
  const contexts = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  const entry = facts ?? { method: "squash" as const, required: new Map(), readAt: -Infinity };
  entry.required.set(base, { contexts, readAt: ports.now() });
  repositoryFacts().set(repository, entry);
  return contexts;
}

export function resetAutoMergeForTests(): void {
  repositoryFacts().clear();
  scheduleHost.__llvAutoMergeRunning = null;
  scheduleHost.__llvAutoMergeStartedAt = undefined;
}

/* ── One step of one lane ───────────────────────────────────────────────── */

const iso = (ms: number) => new Date(ms).toISOString();

function newMerge(pipeline: Pipeline, pr: { repository: string; number: number }, setting: MergeOnReviewSetting, now: number): PipelineMerge {
  return {
    state: "queued",
    by: null,
    repository: pr.repository,
    prNumber: pr.number,
    policyChangedAt: setting.changedAt ?? iso(now),
    reviewedHead: pipeline.lastPassedCommit,
    chain: [pipeline.lastPassedCommit],
    updates: [],
    seenChecks: [],
    head: null,
    headSeenAt: null,
    lastChecks: null,
    readAt: null,
    nextReadAt: null,
    readFailures: 0,
    requestedAt: pipeline.closedAt ?? iso(now),
    mergedHead: null,
    mergeCommit: null,
    method: null,
    mergedAt: null,
    attempts: 0,
    reason: null,
    blockedAt: null,
    updatedAt: iso(now),
  };
}

/** The PR head before a terminal read-only stage's declared output was
 * committed locally. New attempts record it at commit time; older reports
 * captured it before the controller commit. */
function headBeforeLocalOutput(pipeline: Pipeline): string | null {
  if (pipeline.delivery?.publish !== "disabled") return null;
  const final = pipeline.stages.find((stage) => stage.next === null && stage.kind === "run" && stage.outputs?.length);
  if (!final) return null;
  const attempt = pipeline.runs.find((run) => run.stageId === final.id)?.attempts.filter((item) => !item.historical).at(-1);
  if (attempt?.state !== "passed" || attempt.effectiveRole.access !== "read-only") return null;
  const elapsed = Date.parse(pipeline.closedAt ?? "") - Date.parse(attempt.completedAt ?? "");
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 5_000) return null;
  const baseHead = attempt.outputBaseHead ?? attempt.report?.provenance.head;
  if (pipeline.publishedCommit && pipeline.publishedCommit !== baseHead) return null;
  return typeof baseHead === "string" && /^[0-9a-f]{40}$/i.test(baseHead) && baseHead !== pipeline.lastPassedCommit ? baseHead : null;
}

/** Return the exact head the latest successful review judged. Older records
 * may omit the SHA; only those records may use the terminal-head timestamp
 * heuristic. Explicit review evidence always outranks timing. */
function reviewedHead(pipeline: Pipeline): string | null {
  const attempts = pipeline.runs
    .filter((run) => pipeline.stages.some((stage) => stage.id === run.stageId && isReviewStage(pipeline, stage)))
    .flatMap((run, runIndex) => run.attempts
      .map((attempt, attemptIndex) => ({ attempt, runIndex, attemptIndex }))
      .filter(({ attempt }) => !attempt.historical && attempt.state === "passed"));
  const latest = attempts.toSorted((left, right) => {
    const completion = (item: typeof left) => {
      const completedAt = Date.parse(item.attempt.completedAt ?? "");
      if (Number.isFinite(completedAt)) return completedAt;
      const reportAt = Date.parse(item.attempt.report?.at ?? "");
      if (Number.isFinite(reportAt)) return reportAt;
      return typeof item.attempt.report?.seq === "number" ? item.attempt.report.seq : Number.NEGATIVE_INFINITY;
    };
    return completion(left) - completion(right)
      || left.runIndex - right.runIndex
      || left.attemptIndex - right.attemptIndex;
  }).at(-1)?.attempt;
  if (!latest) return null;
  const explicitHead = latest.reviewHeadSha ?? latest.outputBaseHead ?? latest.report?.provenance.head;
  if (typeof explicitHead === "string" && /^[0-9a-f]{40}$/i.test(explicitHead)) return explicitHead;
  const terminalHeadWasReviewed = latest.completedAt && pipeline.closedAt
    && Math.abs(Date.parse(pipeline.closedAt) - Date.parse(latest.completedAt)) <= 5_000;
  return terminalHeadWasReviewed ? pipeline.lastPassedCommit : null;
}

/** A behind diagnostic requires Git to prove the PR head is an ancestor of
 * the exact head a successful review judged. SHA mentions in reports do not
 * prove ancestry: rejected attempts can be divergent retries. */
async function prHeadBehindReviewedHead(pipeline: Pipeline, prHead: string): Promise<string | null> {
  const head = reviewedHead(pipeline);
  if (!head || prHead === head) return null;
  if (pipeline.repoDir && /^[0-9a-f]{40}$/i.test(prHead) && /^[0-9a-f]{40}$/i.test(head)) {
    const ancestor = await realExec("git", ["merge-base", "--is-ancestor", prHead, head], pipeline.repoDir, undefined, { timeoutMs: 5_000 });
    return ancestor.code === 0 ? head : null;
  }
  return null;
}

type Step =
  | { kind: "wait"; state: "checking" | "waiting-checks" | "updating"; reason: string | null }
  | { kind: "block"; reason: string }
  | { kind: "merged"; by: "auto-merge" | "outside" }
  | { kind: "update" }
  | { kind: "merge" };

/**
 * What one read of the PR means for the merge (§4.3, §4.4), decided from the
 * record and the read alone. It updates the record's check bookkeeping in
 * place (the head clock, the names seen) and answers the next move.
 */
export function decideMerge(merge: PipelineMerge, view: PullRequestView, required: readonly string[], now: number): Step {
  if (view.state === "MERGED") return { kind: "merged", by: merge.state === "merging" ? "auto-merge" : "outside" };
  if (view.state === "CLOSED") return { kind: "block", reason: MERGE_REASONS.closed };
  if (view.isDraft || view.mergeStateStatus === "DRAFT") return { kind: "block", reason: MERGE_REASONS.draft };
  const tip = merge.chain.at(-1) ?? null;
  if (view.headRefOid !== tip) return { kind: "block", reason: MERGE_REASONS.headChanged };
  if (merge.head !== view.headRefOid) {
    merge.head = view.headRefOid;
    merge.headSeenAt = iso(now);
    merge.lastChecks = null;
  }
  const names = view.checks.map((check) => check.name);
  const previous = merge.lastChecks;
  merge.lastChecks = names;
  merge.seenChecks = [...new Set([...merge.seenChecks, ...names])].sort();
  if (view.mergeStateStatus === "DIRTY" || view.mergeable === "CONFLICTING") return { kind: "block", reason: MERGE_REASONS.conflict };
  const red = view.checks.find((check) => check.verdict === "red");
  if (red) return { kind: "block", reason: checkFailedReason(red.name) };
  const outstanding = merge.updates.some((update) => update.head === null);
  const age = now - Date.parse(merge.headSeenAt ?? iso(now));
  if (outstanding) {
    /* The update was accepted and its commit has not reached the PR yet. */
    return age >= MERGE_WAIT_LIMIT_MS ? { kind: "block", reason: MERGE_REASONS.checksTimeout } : { kind: "wait", state: "updating", reason: null };
  }
  if (view.mergeStateStatus === "BEHIND") {
    /* Each retry-merge grants the same number of updates again. */
    return merge.updates.length >= MERGE_MAX_UPDATES * (merge.attempts + 1) ? { kind: "block", reason: MERGE_REASONS.mainMoving } : { kind: "update" };
  }
  const present = new Set(names);
  const missing = [...new Set([...required, ...merge.seenChecks])].filter((name) => !present.has(name));
  const grew = previous !== null && names.some((name) => !previous.includes(name));
  const pending = view.checks.some((check) => check.verdict !== "green");
  const settled = names.length > 0 && missing.length === 0 && age >= MERGE_SETTLE_MS && previous !== null && !grew && !pending;
  if (!settled) {
    if (names.length === 0 && age >= MERGE_SETTLE_MS) return { kind: "block", reason: MERGE_REASONS.noChecks };
    if (age >= MERGE_WAIT_LIMIT_MS) return { kind: "block", reason: MERGE_REASONS.checksTimeout };
    return { kind: "wait", state: "waiting-checks", reason: missing.length ? `waiting for ${missing.join(", ")}` : null };
  }
  if ((view.mergeStateStatus === "CLEAN" || view.mergeStateStatus === "HAS_HOOKS") && view.mergeable === "MERGEABLE") return { kind: "merge" };
  if (view.mergeStateStatus === "BLOCKED") {
    const review = view.reviewDecision === "REVIEW_REQUIRED" || view.reviewDecision === "CHANGES_REQUESTED";
    return { kind: "block", reason: review ? MERGE_REASONS.reviewRequired : MERGE_REASONS.protection };
  }
  /* UNKNOWN, a null or UNKNOWN `mergeable`, UNSTABLE: GitHub is still
     computing; read again, inside the same bound. */
  if (age >= MERGE_WAIT_LIMIT_MS) return { kind: "block", reason: MERGE_REASONS.checksTimeout };
  return { kind: "wait", state: "checking", reason: null };
}

function block(merge: PipelineMerge, reason: string, now: number): void {
  merge.state = "blocked";
  merge.reason = reason;
  merge.blockedAt = iso(now);
  merge.nextReadAt = null;
}

/** Write `change` against the record read again under the lock, only while
    it is still the merge the runner read. */
async function commit(ports: AutoMergePorts, read: Pipeline, change: (merge: PipelineMerge, live: Pipeline) => void): Promise<boolean> {
  const readAt = read.merge!.updatedAt;
  return ports.mutate(read.id, (live) => {
    if (live.state !== "completed" || !live.merge || live.merge.updatedAt !== readAt) return false;
    change(live.merge, live);
    live.merge.updatedAt = iso(ports.now());
    return true;
  });
}

/** Admits the commit an outstanding `update-branch` produced to the chain:
    two parents, the first the chain's tip, committed by GitHub (`web-flow`).
    A web-UI edit is `web-flow` too, with one parent. */
async function admitUpdateHead(merge: PipelineMerge, head: string, ports: AutoMergePorts): Promise<boolean> {
  const outstanding = merge.updates.findLast((update) => update.head === null);
  if (!outstanding) return false;
  const raw = await ports.run(["api", `repos/${merge.repository}/commits/${head}`, "--jq", "{parents: [.parents[].sha], committer: .committer.login}"]);
  const commit = JSON.parse(raw) as { parents?: unknown; committer?: unknown };
  const parents = Array.isArray(commit.parents) ? commit.parents : [];
  if (parents.length !== 2 || parents[0] !== merge.chain.at(-1) || commit.committer !== "web-flow") return false;
  merge.chain = [...merge.chain, head];
  outstanding.head = head;
  return true;
}

async function stepLane(read: Pipeline, ports: AutoMergePorts): Promise<void> {
  const now = ports.now();
  const merge = structuredClone(read.merge!);
  const setting = ports.setting(read.project);
  let view: PullRequestView | null = null;
  let required: string[] = [];
  try {
    view = parsePullRequestView(await ports.run(["pr", "view", String(merge.prNumber), "--repo", merge.repository, "--json", PR_FIELDS]));
    if (!view) throw new Error("gh returned no parsable pull request");
    /* The final declared-output commit may be local only. Admit exactly the
       head the read-only stage reported before that commit, including when a
       previously blocked merge is retried. A PR that has the output commit
       keeps the usual chain; every other head still blocks. */
    if (view.state === "OPEN" && merge.updates.length === 0 && merge.chain.length === 1
      && merge.chain[0] === read.lastPassedCommit && view.headRefOid === headBeforeLocalOutput(read)) {
      merge.chain = [view.headRefOid];
    }
    const behindReviewedHead = view.state === "OPEN" && view.headRefOid !== merge.chain.at(-1)
      ? (await prHeadBehindReviewedHead(read, view.headRefOid))
      : null;
    if (behindReviewedHead) {
      await commit(ports, read, (live) => block(live, `PR head is behind the reviewed head ${behindReviewedHead}`, now));
      return;
    }
    /* A head outside the chain is admitted only as the commit of our own
       update; anything else stays outside, and decideMerge blocks on it. */
    if (view.state === "OPEN" && !merge.chain.includes(view.headRefOid)) await admitUpdateHead(merge, view.headRefOid, ports);
    if (view.state === "OPEN") required = await requiredContexts(merge.repository, view.baseRefName || "main", ports);
  } catch (error) {
    const failures = (merge.readFailures ?? 0) + 1;
    ports.log?.(`[auto merge] ${read.id}: read failed (${failures})`, error);
    await commit(ports, read, (live) => {
      live.readFailures = failures;
      live.readAt = iso(now);
      if (failures >= MERGE_READ_FAILURE_LIMIT) block(live, MERGE_REASONS.unreachable, now);
      else live.nextReadAt = iso(now + MERGE_POLL_MS);
    });
    return;
  }
  const step = decideMerge(merge, view, required, now);
  const bookkeeping = (live: PipelineMerge) => {
    live.chain = merge.chain;
    live.updates = merge.updates;
    live.head = merge.head;
    live.headSeenAt = merge.headSeenAt;
    live.lastChecks = merge.lastChecks;
    live.seenChecks = merge.seenChecks;
    live.readAt = iso(now);
    live.readFailures = 0;
  };
  if (step.kind === "merged") {
    await commit(ports, read, (live) => {
      bookkeeping(live);
      live.state = "merged";
      live.by = step.by;
      live.mergedHead = view!.headRefOid;
      live.mergeCommit = view!.mergeCommit;
      live.mergedAt = view!.mergedAt ?? iso(now);
      live.reason = null;
      live.nextReadAt = null;
    });
    return;
  }
  if (step.kind === "block") {
    await commit(ports, read, (live) => { bookkeeping(live); block(live, step.reason, now); });
    return;
  }
  if (step.kind === "wait") {
    await commit(ports, read, (live) => {
      bookkeeping(live);
      live.state = step.state;
      live.reason = step.reason;
      live.nextReadAt = iso(now + MERGE_POLL_MS);
    });
    return;
  }
  /* A move on GitHub: the setting is read again first (§4.1), and the move
     is recorded before it is made, so a crash leaves a record that says so. */
  if (!setting.enabled) {
    await commit(ports, read, (live) => { bookkeeping(live); live.state = "cancelled"; live.reason = MERGE_REASONS.settingOff; live.nextReadAt = null; });
    return;
  }
  if (step.kind === "update") {
    const tip = merge.chain.at(-1)!;
    const recorded = await commit(ports, read, (live) => {
      bookkeeping(live);
      live.updates = [...merge.updates, { requestedAt: iso(now), head: null }];
      live.state = "updating";
      live.reason = null;
      /* The wait restarts from zero on the head the update produces. */
      live.head = null;
      live.headSeenAt = null;
      live.lastChecks = null;
      live.nextReadAt = iso(now + MERGE_POLL_MS);
    });
    if (!recorded) return;
    try {
      await ports.write(["api", "-X", "PUT", `repos/${merge.repository}/pulls/${merge.prNumber}/update-branch`, "-f", `expected_head_sha=${tip}`], merge.repository);
    } catch (error) {
      const message = githubMessage(error);
      const current = ports.loadPipelines().find((pipeline) => pipeline.id === read.id);
      if (current?.merge) {
        const reason = error instanceof ForgeAppWriteRefused ? error.message
          : /expected head sha/i.test(message) ? MERGE_REASONS.headChanged : `GitHub refused to update the branch: ${message}`;
        await commit(ports, current, (live) => block(live, reason, ports.now()));
      }
    }
    return;
  }
  const method = await mergeMethod(merge.repository, ports).catch(() => "squash" as const);
  const recorded = await commit(ports, read, (live) => {
    bookkeeping(live);
    live.state = "merging";
    live.method = method;
    live.reason = null;
    live.nextReadAt = iso(now + MERGE_POLL_MS);
  });
  if (!recorded) return;
  let failure: string | null = null;
  try {
    /* `--match-head-commit`: GitHub refuses if the head moved since the read.
       The branch stays; worktree cleanup owns lane branches. */
    await ports.write(["pr", "merge", String(merge.prNumber), "--repo", merge.repository, `--${method}`, "--match-head-commit", view.headRefOid], merge.repository);
  } catch (error) {
    /* No App credential: the refusal is the whole reason, in its own words. */
    failure = error instanceof ForgeAppWriteRefused ? error.message : `GitHub refused the merge: ${githubMessage(error)}`;
  }
  let after: PullRequestView | null = null;
  try {
    after = parsePullRequestView(await ports.run(["pr", "view", String(merge.prNumber), "--repo", merge.repository, "--json", PR_FIELDS]));
  } catch {
    after = null;
  }
  const current = ports.loadPipelines().find((pipeline) => pipeline.id === read.id);
  if (!current?.merge) return;
  await commit(ports, current, (live) => {
    if (after?.state === "MERGED" || (!failure && !after)) {
      live.state = "merged";
      live.by = "auto-merge";
      live.mergedHead = after?.headRefOid ?? view!.headRefOid;
      live.mergeCommit = after?.mergeCommit ?? null;
      live.mergedAt = after?.mergedAt ?? iso(ports.now());
      live.reason = null;
      live.nextReadAt = null;
      return;
    }
    if (failure) block(live, failure, ports.now());
    /* Otherwise the merge was accepted and the PR does not read merged yet:
       the next read in `merging` settles it. */
  });
}

/* ── The sweep ──────────────────────────────────────────────────────────── */

/**
 * One pass: queue the lanes that just became eligible, cancel what only waits
 * under a setting turned off, note merges someone else made, and take one step
 * on the head of each repository's queue whose next read is due.
 */
function mergerOwns(pipeline: Pipeline, pr: { repository: string; number: number }, ports: AutoMergePorts): boolean {
  if (ports.mergerBusy?.(pipeline.project)) return true;
  return ports.loadPipelines().some(candidate => candidate.id !== pipeline.id
    && canonicalProject(candidate.project) === canonicalProject(pipeline.project)
    && !["completed", "closed", "draft"].includes(candidate.state)
    && candidate.stages.some(stage => stage.role?.roleId === "merger"
      && String(stage.role.params?.prs ?? "").split(",").some(pair => Number(pair.trim().split("@")[0]) === pr.number)));
}

/** Cached merge state prompts a fresh read before recording outside evidence. */
async function recordOutsideMerge(pipeline: Pipeline, pr: { repository: string; number: number }, ports: AutoMergePorts): Promise<void> {
  try {
    const view = parsePullRequestView(await ports.run(["pr", "view", String(pr.number), "--repo", pr.repository, "--json", PR_FIELDS]));
    if (view?.state !== "MERGED") return;
    await ports.mutate(pipeline.id, live => {
      if (!["completed", "closed"].includes(live.state) || live.merge?.mergedHead) return false;
      const currentPr = live.merge ? { repository: live.merge.repository, number: live.merge.prNumber } : ports.pullRequestOf(live);
      if (currentPr?.repository !== pr.repository || currentPr.number !== pr.number) return false;
      const merge = live.merge ?? newMerge(live, pr, ports.setting(live.project), ports.now());
      merge.state = "merged";
      merge.by ??= "outside";
      merge.mergedHead = view.headRefOid;
      merge.mergeCommit = view.mergeCommit;
      merge.mergedAt = view.mergedAt ?? iso(ports.now());
      merge.reason = null;
      merge.nextReadAt = null;
      merge.updatedAt = iso(ports.now());
      live.merge = merge;
      return true;
    });
  } catch (error) {
    ports.log?.(`[auto merge] ${pipeline.id}: outside merge confirmation failed`, error);
  }
}

export async function sweepAutoMerge(ports: AutoMergePorts): Promise<void> {
  const now = ports.now();
  for (const pipeline of ports.loadPipelines()) {
    if (pipeline.state !== "completed" || pipeline.hiddenAt) continue;
    const setting = ports.setting(pipeline.project);
    const merge = pipeline.merge;
    const pr = merge ? { repository: merge.repository, number: merge.prNumber } : ports.pullRequestOf(pipeline);
    if (pr && !merge?.mergedHead && (merge?.state === "merged" || ports.cachedState(pr.repository, pr.number) === "merged")) {
      await recordOutsideMerge(pipeline, pr, ports);
      continue;
    }
    if (!merge) {
      /* Only lanes that complete after the setting went on (§4.1). */
      if (!setting.enabled || !setting.changedAt || !(Date.parse(pipeline.closedAt ?? "") >= Date.parse(setting.changedAt))) continue;
      if (!pipeline.lastPassedCommit || !mergeEligible(pipeline)) continue;
      const pr = ports.pullRequestOf(pipeline);
      if (!pr || mergerOwns(pipeline, pr, ports)) continue;
      await ports.mutate(pipeline.id, (live) => {
        if (live.state !== "completed" || live.merge) return false;
        live.merge = newMerge(live, pr, setting, now);
        return true;
      });
      continue;
    }
    if (PIPELINE_MERGE_LIVE_STATES.has(merge.state) && merge.state !== "merging" && !setting.enabled) {
      await commit(ports, pipeline, (live) => { live.state = "cancelled"; live.reason = MERGE_REASONS.settingOff; live.nextReadAt = null; });
      continue;
    }
  }
  /* One lane at a time per repository, in completion order (§4.4 rule 5). */
  const queues = new Map<string, Pipeline[]>();
  for (const pipeline of ports.loadPipelines()) {
    const merge = pipeline.merge;
    if (pipeline.state !== "completed" || !merge || !PIPELINE_MERGE_LIVE_STATES.has(merge.state)) continue;
    const queue = queues.get(merge.repository) ?? [];
    queue.push(pipeline);
    queues.set(merge.repository, queue);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => a.merge!.requestedAt.localeCompare(b.merge!.requestedAt) || a.id.localeCompare(b.id));
    const head = queue[0]!;
    if (mergerOwns(head, { repository: head.merge!.repository, number: head.merge!.prNumber }, ports)) continue;
    const due = Date.parse(head.merge!.nextReadAt ?? "");
    if (Number.isFinite(due) && due > now) continue;
    try {
      await stepLane(head, ports);
    } catch (error) {
      ports.log?.(`[auto merge] ${head.id}: step failed`, error);
    }
  }
}

/* ── A pipeline that finishes its task (#2187 §5) ───────────────────────── */

/**
 * Whether a marked lane has finished its tasks (§5.2): it completed, and when
 * its project merges automatically and the lane has a pull request, that pull
 * request merged, by the runner or by anyone. The setting is read now.
 */
export function laneFinishedForTasks(pipeline: Pipeline, ports: Pick<AutoMergePorts, "setting" | "pullRequestOf" | "cachedState">): boolean {
  if (pipeline.state !== "completed") return false;
  if (!ports.setting(pipeline.project).enabled) return true;
  const pr = ports.pullRequestOf(pipeline);
  if (!pr) return true;
  return pipeline.merge?.state === "merged" || ports.cachedState(pr.repository, pr.number) === "merged";
}

/** The marked tasks a pipeline has not finished yet. */
function unfinishedMarkedTasks(pipeline: Pipeline): string[] {
  const finished = new Set((pipeline.taskFinishes ?? []).map((finish) => finish.taskId));
  return (pipeline.finishesTaskIds ?? []).filter((taskId) => pipeline.taskIds.includes(taskId) && !finished.has(taskId));
}

const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * One pass of the finish sweep (§5.3). For each task a finished marked lane
 * names: with no other open pipeline on it, the task moves to Done and the
 * finish is recorded once, so a task reopened afterwards stays open; with some
 * open, nothing moves and the lane records which ones the move waits on. The
 * task is written first and the record second, each under its own lock and
 * never both at once: a crash between them leaves a Done task the next pass
 * only records.
 */
export async function sweepTaskFinishes(ports: AutoMergePorts): Promise<void> {
  if (!ports.finishTask) return;
  const pipelines = ports.loadPipelines();
  const now = ports.now();
  for (const pipeline of pipelines) {
    const marked = unfinishedMarkedTasks(pipeline);
    const finished = marked.length > 0 && laneFinishedForTasks(pipeline, ports);
    /* A wait whose lane no longer finishes the task (unmarked, reopened
       lane, closed) says nothing true any more. */
    const staleWaits = (pipeline.taskFinishWaits ?? []).filter((wait) => !finished || !marked.includes(wait.taskId));
    if (staleWaits.length) {
      await ports.mutate(pipeline.id, (live) => {
        const liveMarked = unfinishedMarkedTasks(live);
        const keep = (live.taskFinishWaits ?? []).filter((wait) => finished && liveMarked.includes(wait.taskId));
        if (keep.length === (live.taskFinishWaits ?? []).length) return false;
        if (keep.length) live.taskFinishWaits = keep;
        else delete live.taskFinishWaits;
        return true;
      });
    }
    if (!finished) continue;
    for (const taskId of marked) {
      const open = openPipelinesOnTask(pipelines, taskId, pipeline.id);
      if (open.length) {
        await ports.mutate(pipeline.id, (live) => {
          if (!unfinishedMarkedTasks(live).includes(taskId)) return false;
          const waits = live.taskFinishWaits ?? [];
          const current = waits.find((wait) => wait.taskId === taskId);
          if (current && sameList(current.open, open)) return false;
          live.taskFinishWaits = [...waits.filter((wait) => wait.taskId !== taskId), { taskId, since: current?.since ?? iso(now), open }];
          return true;
        });
        continue;
      }
      const outcome = ports.finishTask(taskId, pipeline.id);
      if (outcome === "missing" || outcome === "refused") {
        if (outcome === "refused") ports.log?.(`[task finish] ${pipeline.id}: task ${taskId} could not be moved to Done`);
        continue;
      }
      await ports.mutate(pipeline.id, (live) => {
        if ((live.taskFinishes ?? []).some((finish) => finish.taskId === taskId)) return false;
        live.taskFinishes = [...(live.taskFinishes ?? []), { taskId, at: iso(ports.now()), outcome }];
        const waits = (live.taskFinishWaits ?? []).filter((wait) => wait.taskId !== taskId);
        if (waits.length) live.taskFinishWaits = waits;
        else delete live.taskFinishWaits;
        return true;
      });
    }
  }
}

/** Files retained findings once the lane's delivery has finished. */
export async function sweepBudgetFollowUps(ports: AutoMergePorts): Promise<void> {
  if (!ports.fileFollowUp) return;
  const pipelines = ports.loadPipelines();
  for (const pipeline of pipelines) {
    const spent = pipeline.reviewBudgetSpent;
    if (!spent || spent.followUp || !(laneFinishedForTasks(pipeline, ports) || pipeline.state === "closed")) continue;
    // Legacy follow-ups were started as lanes on the same task. Their brief
    // explicitly names the source lane; unrelated work on that task is ignored.
    const existing = pipelines.find(candidate => candidate.id !== pipeline.id
      && canonicalProject(candidate.project) === canonicalProject(pipeline.project)
      && candidate.taskIds.some(id => pipeline.taskIds.includes(id))
      && /follow[- ]up/i.test(candidate.task) && candidate.spec?.includes(pipeline.id));
    let delivery = pipeline;
    if (!existing) {
      // Confirm a known outside merge here too: closed and hidden lanes never
      // enter auto-merge's queue, and disabling the setting loses no evidence.
      const pr = pipeline.merge ? { repository: pipeline.merge.repository, number: pipeline.merge.prNumber } : ports.pullRequestOf?.(pipeline);
      const knownMerged = pipeline.merge?.state === "merged" || Boolean(pr && ports.cachedState?.(pr.repository, pr.number) === "merged");
      const requiresMergedHead = knownMerged || Boolean(pr && pipeline.state === "completed" && ports.setting(pipeline.project).enabled);
      if (requiresMergedHead && (pipeline.merge?.state !== "merged" || !pipeline.merge.mergedHead)) {
        if (!knownMerged || !pr) continue;
        await recordOutsideMerge(pipeline, pr, ports);
        const confirmed = ports.loadPipelines().find(candidate => candidate.id === pipeline.id);
        if (!confirmed || confirmed.merge?.state !== "merged" || !confirmed.merge.mergedHead
          || confirmed.reviewBudgetSpent?.followUp || confirmed.reviewBudgetSpent?.stageId !== spent.stageId
          || confirmed.reviewBudgetSpent.attempt !== spent.attempt) continue;
        delivery = confirmed;
      }
    }
    const followUp = existing
      ? { taskId: existing.taskIds.find(id => pipeline.taskIds.includes(id))!, title: existing.task.split("\n")[0]! }
      : ports.fileFollowUp(delivery, delivery.merge?.mergedHead ?? delivery.lastPassedCommit);
    await ports.mutate(pipeline.id, live => {
      const current = live.reviewBudgetSpent;
      if (!current || current.followUp || current.stageId !== spent.stageId || current.attempt !== spent.attempt) return false;
      current.followUp = { ...followUp, at: iso(ports.now()) };
      live.stateDetail = `budget spent: ${current.findings} findings → follow-up «${followUp.title}» (${followUp.taskId.slice(0, 8)})`;
      return true;
    });
  }
}

/** The production move: the task's own store, under its own lock. */
export function finishBoardTask(taskId: string): TaskFinishOutcome {
  return mutateTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return { tasks: undefined, result: "missing" as const };
    if (task.status === "done") return { tasks: undefined, result: "already-done" as const };
    const moved = patchTask(tasks, taskId, { status: "done" });
    return moved.ok ? { tasks: moved.tasks, result: "moved" as const } : { tasks: undefined, result: "refused" as const };
  });
}

/* ── Scheduling from the controller cycle ───────────────────────────────── */

const scheduleHost = globalThis as typeof globalThis & { __llvAutoMergeRunning?: Promise<unknown> | null; __llvAutoMergeStartedAt?: number };

export function productionAutoMergePorts(overrides: Partial<AutoMergePorts> & Pick<AutoMergePorts, "loadPipelines">): AutoMergePorts {
  const run = overrides.run ?? githubRunner(os.tmpdir(), GH_TIMEOUT_MS);
  let mergerProjects: Set<string> | undefined;
  return {
    now: Date.now,
    run,
    write: forgeWriter(run, forgeAppWriter(os.tmpdir(), GH_TIMEOUT_MS)),
    mutate: (pipelineId, change) => withPipelineMutation((pipelines, persist) => {
      const pipeline = pipelines.find((candidate) => candidate.id === pipelineId);
      if (!pipeline || !change(pipeline)) return false;
      persist();
      return true;
    }),
    setting: mergeOnReviewSetting,
    pullRequestOf: lanePullRequest,
    cachedState: (repository, number) => forgeCacheView().repository(repository)?.pr(number)?.state ?? null,
    mergerBusy: project => {
      if (!mergerProjects) {
        mergerProjects = new Set();
        for (const conversation of Object.values(agentRegistry().readOnlySnapshot().conversations)) {
          if (conversation.agentRole !== "merger" || conversation.supersededBy || conversation.turn.state !== "busy") continue;
          const generation = conversation.generations.at(-1);
          const owned = conversationProjectKey(conversation.projectOwnership, generation?.launchProfile);
          if (owned) mergerProjects.add(canonicalProject(owned));
        }
      }
      return mergerProjects.has(canonicalProject(project));
    },
    finishTask: finishBoardTask,
    fileFollowUp: fileBudgetFollowUp,
    log: (message, error) => console.error(message, error ?? ""),
    ...overrides,
  };
}

/** Fire-and-forget, one run at a time, errors logged and never thrown: the
    controller calls this at the end of every cycle, beside the forge sweep. */
export function scheduleAutoMerge(overrides: Partial<AutoMergePorts> & Pick<AutoMergePorts, "loadPipelines">): void {
  if (scheduleHost.__llvAutoMergeRunning) return;
  const now = (overrides.now ?? Date.now)();
  if (now - (scheduleHost.__llvAutoMergeStartedAt ?? -Infinity) < MERGE_SCHEDULE_DEBOUNCE_MS) return;
  scheduleHost.__llvAutoMergeStartedAt = now;
  const ports = productionAutoMergePorts(overrides);
  /* The finish sweep runs after the merge step, so a merge this pass made
     finishes its task in the same pass. */
  const run = sweepAutoMerge(ports)
    .catch((error) => ports.log?.("[auto merge] sweep failed", error))
    .then(() => sweepTaskFinishes(ports))
    .catch((error) => ports.log?.("[task finish] sweep failed", error))
    .then(() => sweepBudgetFollowUps(ports))
    .catch((error) => ports.log?.("[budget follow-up] sweep failed", error))
    .finally(() => { scheduleHost.__llvAutoMergeRunning = null; });
  scheduleHost.__llvAutoMergeRunning = run;
}

/** A `retry-merge` or a setting change asks for the next cycle's sweep now. */
export function nudgeAutoMerge(): void {
  scheduleHost.__llvAutoMergeStartedAt = undefined;
}
