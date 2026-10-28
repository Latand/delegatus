import { proactiveResultReview } from "@/lib/tasks/proactiveLane";
import { assertProactivePipelineExecution, proactivePipelineExecutionError } from "@/lib/tasks/proactiveExecution";
import { openRevertPr, readPostMergeChecks, sweepPostMerge } from "./postMerge";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { yieldToRuntime } from "@/lib/cooperative";
import { withControllerPipelineScope } from "@/lib/pipelines/controllerScope";
import os from "node:os";
import { refreshAdmission, refreshRequest, refreshReservation, refreshTupleKey, refreshWasRequested, type RefreshLineage, type RefreshOptions } from "./autoRefresh";
import { realExec } from "@/lib/workflows/provision";

import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { ForgeAppWriteRefused, forgeAppWriter, forgeWriter, type ForgeAppWriter } from "./appWrite";
import { failEdgeExhaustion } from "@/lib/pipelines/failEdgeBudget";
import { loadArchivedPipelinesForOwnership, loadPipelinesForList, loadPipelinesForListAsync, pipelineDeliveryLookup, withPipelineMutation } from "@/lib/pipelines/store";
import { openPipelinesOnTask } from "@/lib/pipelines/taskFinish";
import { PIPELINE_MERGE_LIVE_STATES, type Pipeline, type PipelineMerge, type PipelineMergeMethod, type PipelineStage } from "@/lib/pipelines/types";
import { mergeOnReviewSetting, type MergeOnReviewSetting } from "@/lib/projects/settings";
import { patchTask } from "@/lib/tasks/commands";
import { loadTasksForList, mutateTasks, taskSelectionSource } from "@/lib/tasks/store";

import { forgeCacheView } from "./cache";
import { checkFailedReason, MERGE_REASONS } from "./mergeReasons";
import { lanePullRequest, pipelineRepository } from "./resolve";
import { type PullRequestState } from "./workLinks";
import { readBatchLanding } from "./batchLanding";

/*
 * "Merge when the review passes" (#2187 §4, docs/design/merge-policy-and-task-finishing.md).
 *
 * A completed lane of a project that turned the setting on, whose reviews
 * passed (§4.2), is queued here and merged through GitHub with `gh`, one lane
 * at a time per repository, once its PR's required checks have arrived, settled
 * and are green, with no reported failure (§4.3). Scheduled beside the forge
 * sweep from the controller cycle and, like it, run outside every pipeline
 * lease: the `gh` calls happen with no lock held, and each result is written
 * under the pipeline lock against the record read again inside it.
 *
 * A conflict, BEHIND base, or red check on an outdated base starts visible
 * refresh work (docs/design/auto-refresh-conflicting-prs.md).
 * The refresh stage resolves it and publishes through the pipeline gate.
 * What cannot be settled by waiting blocks with one plain sentence and goes to
 * the operator (§4.6).
 */

export const MERGE_POLL_MS = 60_000;
/** The least time a head's checks must have had to register (§4.3). */
export const MERGE_SETTLE_MS = 3 * 60_000;
/** The most time a head may take to settle, from its first read. */
export const MERGE_WAIT_LIMIT_MS = 90 * 60_000;
/** Reads in a row `gh` may fail before the merge blocks. */
export const MERGE_READ_FAILURE_LIMIT = 3;
const MERGE_SCHEDULE_DEBOUNCE_MS = 15_000;
const REPOSITORY_FACTS_TTL_MS = 30 * 60_000;
const GH_TIMEOUT_MS = 30_000;

const PR_FIELDS = "state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,mergeCommit,mergedAt";
export { MERGE_REASONS };

export interface AutoMergePorts {
  now: () => number;
  /** Concurrent PR refresh/check slots per repository, clamped to one or two. */
  refreshConcurrency?: number;
  run: GithubRunner;
  /** Every GitHub merge goes through this. In a declared App repository it
      goes out as the Delegatus GitHub App, and one it cannot authenticate as the App throws and nothing is
      sent; in any other repository it is `run`. `run` itself only reads. */
  write: ForgeAppWriter;
  loadPipelines: () => readonly Pipeline[];
  /** Indexed ancestry reads for refreshes whose originals have archived. */
  loadRefreshAncestors?: (ids: readonly string[]) => readonly Pipeline[];
  /** Indexed immutable creation receipts, including closed and archived children. */
  loadRefreshByKey?: (key: string) => Pipeline | null;
  /** Fill the shared immutable view cooperatively before synchronous lookups. */
  prepareRead?: () => Promise<void>;
  /** Applies `change` to the live record under the pipeline lock and persists
      it when `change` answers true. False when the record is gone or unchanged. */
  mutate: (pipelineId: string, change: (pipeline: Pipeline) => boolean) => Promise<boolean>;
  setting: (project: string) => MergeOnReviewSetting;
  /** The one pull request the lane's own records join to it, else null. */
  pullRequestOf: (pipeline: Pipeline) => { repository: string; number: number } | null;
  /** What the forge cache last read for a pull request, for a merge the
      runner no longer polls (blocked or cancelled) that someone merged. */
  cachedState: (repository: string, number: number) => PullRequestState | null;
  /** A decision form published by this lane's terminal passed attempt. */
  hasPublishedPrototype?: (pipeline: Pipeline) => boolean;
  startRefresh?: (request: ReturnType<typeof refreshRequest>, options: RefreshOptions) => Promise<{ pipeline?: Pipeline; error?: string }>;
  activeSeat?: (project: string) => Promise<RefreshLineage | null>;
  log?: (message: string, error?: unknown) => void;
  /** Moves a board task to Done for the finish sweep (#2187 §5.3) and says
      what it found. Absent, the finish sweep does not run. */
  finishTask?: (taskId: string, pipelineId: string) => TaskFinishOutcome;
}

export type TaskFinishOutcome = "moved" | "already-done" | "missing" | "refused";

/* ── Eligibility (§4.2) ─────────────────────────────────────────────────── */

/** A review stage: a legacy review loop, or a read-only run stage that owns
    a fail edge (§3.4). */
export function isReviewStage(pipeline: Pipeline, stage: PipelineStage): boolean {
  if (pipeline.proactiveTaskIds?.length) return pipeline.stages[0]?.id !== stage.id && proactiveResultReview(stage);
  if (stage.kind === "review-loop") return true;
  if (stage.kind !== "run" || !stage.onFail) return false;
  const latest = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((attempt) => !attempt.historical).at(-1);
  /* Older creator plans used a writable `review` run stage with a fail edge.
     Its passed verdict is still the review gate; excluding it stranded
     completed lanes before they could acquire a merge record. */
  return /(?:^|[-_])review$/.test(stage.id) || (latest?.effectiveRole?.access ?? stage.effectiveRole?.access ?? stage.access ?? "read-write") === "read-only";
}

/** An explicit exception covers the final implementation only when its pass
 * suffix cannot write another implementation head. */
function reviewHasReadOnlySuffix(pipeline: Pipeline, stage: PipelineStage): boolean {
  const seen = new Set([stage.id]);
  let next = stage.next;
  while (next !== null) {
    if (seen.has(next)) return false;
    seen.add(next);
    const successor = pipeline.stages.find(row => row.id === next);
    if (!successor || successor.kind !== "run" || successor.effectiveRole.access !== "read-only") return false;
    next = successor.next;
  }
  return true;
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
  let implementedHeadCovered = !pipeline.proactiveTaskIds?.length;
  for (const stage of pipeline.stages) {
    if (!isReviewStage(pipeline, stage)) continue;
    const latest = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((attempt) => !attempt.historical).at(-1);
    if (!latest) continue;
    reviewed += 1;
    if (latest.state === "passed") {
      // Proactive grants never infer head coverage from completion timestamps.
      const head = latest.reviewHeadSha ?? latest.outputBaseHead ?? latest.report?.provenance.head;
      const integration = latest.publicationIntegration;
      if (head && (head === pipeline.lastPassedCommit || head === headBeforeLocalOutput(pipeline)
        || integration?.passedSha === head && integration.acceptedSha === pipeline.lastPassedCommit)) implementedHeadCovered = true;
      continue;
    }
    const acceptance = (pipeline.reviewAcceptances ?? []).find(row => row.stageId === stage.id && row.attempt === latest.n);
    if (latest.state === "skipped" || acceptance) {
      if (reviewHasReadOnlySuffix(pipeline, stage)
        && (latest.state === "skipped" || acceptance?.currentHead === pipeline.lastPassedCommit)) implementedHeadCovered = true;
      continue;
    }
    if (stage.next !== null && latest.budgetSpent && stage.onFail && failEdgeExhaustion(stage.onFail) !== "park") {
      const fix = pipeline.runs.find((run) => run.stageId === stage.onFail!.to)?.attempts.find((attempt) => !attempt.historical
        && attempt.state === "passed"
        && attempt.activatedBy?.edge === "fail"
        && attempt.activatedBy.budgetSpent === true
        && attempt.activatedBy.stageId === stage.id
        && attempt.activatedBy.attempt === latest.n);
      if (fix) {
        if (reviewHasReadOnlySuffix(pipeline, stage)) implementedHeadCovered = true;
        continue;
      }
    }
    return false;
  }
  return reviewed > 0 && implementedHeadCovered;
}

export { lanePullRequest };

/* ── Reading GitHub ─────────────────────────────────────────────────────── */

export { rollupChecks } from "./checkRollup";
export type { CheckVerdict, ReadCheck } from "./checkRollup";
import { rollupChecks, type PullRequestView as CheckView } from "./checkRollup";

type PullRequestReview = { reviewer: string | null; isBot: boolean; state: string };
export type PullRequestView = CheckView & { reviews?: PullRequestReview[] };

/** The paginated list-reviews endpoint returns chronological reviews. `--jq`
 * emits one compact JSON record per review, including across page boundaries;
 * this works on older gh versions too and keeps review bodies out of stdout.
 * An unreadable history is a read failure, not evidence of no requests. */
function parseReviews(raw: string): PullRequestReview[] {
  return raw.split("\n").filter((line) => line.trim()).map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("gh returned an invalid review");
    const review = entry as { reviewer?: unknown; isBot?: unknown; state?: unknown };
    if (typeof review.state !== "string" || !["CHANGES_REQUESTED", "APPROVED", "DISMISSED", "COMMENTED", "PENDING"].includes(review.state)) throw new Error("gh returned an invalid review state");
    const reviewer = typeof review.reviewer === "string" && review.reviewer ? review.reviewer.toLowerCase() : null;
    return { reviewer, isBot: review.isBot === true || reviewer?.endsWith("[bot]") === true, state: review.state };
  });
}

function changesRequested(view: PullRequestView): boolean {
  const latest = new Map<string, PullRequestReview>();
  for (const [index, review] of (view.reviews ?? []).entries()) {
    // A comment or a pending re-review does not withdraw a submitted verdict.
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    // An unavailable author cannot prove that another review cleared theirs.
    latest.set(review.reviewer ?? `unknown:${index}`, review);
  }
  const requests = [...latest.values()].filter((review) => review.state === "CHANGES_REQUESTED");
  if (requests.some((review) => !review.isBot)) return true;
  // Respect the aggregate unless the history proves the requests are all bots.
  return view.reviewDecision === "CHANGES_REQUESTED" && !requests.some((review) => review.isBot);
}

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

/** Required contexts from classic protection and active branch rulesets.
    Only successful, validated reads may populate the cache. */
async function requiredContexts(repository: string, base: string, ports: AutoMergePorts): Promise<string[]> {
  const facts = repositoryFacts().get(repository);
  const cached = facts?.required.get(base);
  if (cached && ports.now() - cached.readAt < REPOSITORY_FACTS_TTL_MS) return cached.contexts;
  const branch = encodeURIComponent(base);
  const raw = await ports.run(["api", `repos/${repository}/branches/${branch}`, "--jq",
    "[.protection.required_status_checks | (.contexts[]?, .checks[]?.context)]"]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item)) {
    throw new Error("gh returned invalid classic required checks");
  }
  // This endpoint returns active rules, including inherited rulesets; do not
  // enumerate repository rulesets (which would miss inherited requirements).
  // Keep each page intact (including an empty array) on gh 2.45, which has
  // --paginate and --jq but no --slurp. Validate every page before caching.
  const rulesRaw = await ports.run(["api", `repos/${repository}/rules/branches/${branch}`, "--paginate", "--jq", "@json"]);
  const pages = rulesRaw.split("\n").filter((line) => line.trim()).map((line): unknown => JSON.parse(line));
  if (pages.length === 0) throw new Error("gh returned invalid branch rules");
  const contexts = new Set<string>(parsed);
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error("gh returned invalid branch rules page");
    for (const rule of page) {
      if (!rule || typeof rule !== "object" || typeof rule.type !== "string") throw new Error("gh returned invalid branch rule");
      if (rule.type !== "required_status_checks") continue;
      const checks: unknown = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) throw new Error("gh returned invalid ruleset required checks");
      for (const check of checks) {
        if (!check || typeof check.context !== "string" || !check.context) throw new Error("gh returned invalid ruleset context");
        contexts.add(check.context);
      }
    }
  }
  const names = [...contexts];
  const entry = facts ?? { method: "squash" as const, required: new Map(), readAt: -Infinity };
  entry.required.set(base, { contexts: names, readAt: ports.now() });
  repositoryFacts().set(repository, entry);
  return names;
}

export function resetAutoMergeForTests(): void {
  repositoryFacts().clear();
  admissionReasons.clear();
  laneReasons.clear();
  scheduleHost.__llvAutoMergeRunning = null;
  scheduleHost.__llvPostMergeRunning = null;
  scheduleHost.__llvAutoMergeStartedAt = undefined;
}

/* ── One step of one lane ───────────────────────────────────────────────── */

const iso = (ms: number) => new Date(ms).toISOString();

function newMerge(pipeline: Pipeline, pr: { repository: string; number: number | null }, setting: MergeOnReviewSetting, now: number): PipelineMerge {
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

/** A terminal declared-output commit can remain local. The same proof admits
 * its preceding PR head before either open-PR checks or closed-PR receipts. */
function admitLocalOutputHead(pipeline: Pipeline, merge: PipelineMerge, head: string): void {
  if (merge.updates.length === 0 && merge.chain.length === 1
    && merge.chain[0] === pipeline.lastPassedCommit && head === headBeforeLocalOutput(pipeline)) {
    merge.chain = [head];
  }
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
  | { kind: "refresh" }
  | { kind: "merge" };

/**
 * What one read of the PR means for the merge (§4.3, §4.4), decided from the
 * record and the read alone. It updates the record's check bookkeeping in
 * place (the head clock, the names seen) and answers the next move.
 */
export function decideMerge(merge: PipelineMerge, view: PullRequestView, required: readonly string[], now: number): Step {
  if (view.state === "MERGED") return { kind: "merged", by: merge.state === "merging" || merge.effectUncertain ? "auto-merge" : "outside" };
  if (view.state === "CLOSED") return { kind: "block", reason: MERGE_REASONS.closed };
  if (changesRequested(view)) return { kind: "block", reason: MERGE_REASONS.changesRequested };
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
    if (age >= MERGE_WAIT_LIMIT_MS) return { kind: "block", reason: MERGE_REASONS.checksTimeout };
    return { kind: "refresh" };
  }
  const present = new Set(names);
  const requiredNames = new Set(required);
  // Only required contexts hold the merge while checks register or run.
  const missing = [...new Set([...required, ...merge.seenChecks])].filter((name) => requiredNames.has(name) && !present.has(name));
  const grew = previous !== null && names.some((name) => !previous.includes(name));
  const pending = view.checks.some((check) => requiredNames.has(check.name) && check.verdict !== "green");
  const settled = names.length > 0 && missing.length === 0 && age >= MERGE_SETTLE_MS && previous !== null && !grew && !pending;
  if (!settled) {
    if (names.length === 0 && missing.length === 0 && age >= MERGE_SETTLE_MS) return { kind: "block", reason: MERGE_REASONS.noChecks };
    if (age >= MERGE_WAIT_LIMIT_MS) return { kind: "block", reason: MERGE_REASONS.checksTimeout };
    const waiting = [...new Set([...missing, ...view.checks
      .filter(check => requiredNames.has(check.name) && check.verdict !== "green")
      .map(check => check.name)])];
    return { kind: "wait", state: "waiting-checks", reason: waiting.length ? `waiting for ${waiting.join(", ")}` : "waiting for checks to settle" };
  }
  // UNSTABLE is mergeable once required contexts pass and reported failures are ruled out above.
  if ((view.mergeStateStatus === "CLEAN" || view.mergeStateStatus === "HAS_HOOKS" || view.mergeStateStatus === "UNSTABLE") && view.mergeable === "MERGEABLE") return { kind: "merge" };
  if (view.mergeStateStatus === "BLOCKED") {
    const review = view.reviewDecision === "REVIEW_REQUIRED";
    return { kind: "block", reason: review ? MERGE_REASONS.reviewRequired : MERGE_REASONS.protection };
  }
  /* UNKNOWN, a null or UNKNOWN `mergeable`: GitHub is still
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
  let status: string | undefined;
  const changed = await ports.mutate(read.id, (live) => {
    if ((live.state !== "completed" && !read.merge!.effectUncertain) || !live.merge || live.merge.updatedAt !== readAt || live.merge.state !== read.merge!.state || live.merge.attempts !== read.merge!.attempts) return false;
    change(live.merge, live);
    live.merge.updatedAt = iso(Math.max(ports.now(), Date.parse(readAt) + 1));
    status = mergeStatus(live.merge, Boolean(live.hiddenAt));
    return true;
  });
  if (changed && status) laneStatus(ports, read.id, status);
  else if (!changed) laneStatus(ports, read.id, "skipped: merge record changed before commit");
  return changed;
}

/** Queued work from an older release and a changed record after a forge await
    must meet the current review bar before merging. */
async function commitReviewed(ports: AutoMergePorts, read: Pipeline, change: (merge: PipelineMerge) => void): Promise<boolean> {
  let admitted = false;
  const changed = await commit(ports, read, (merge, live) => {
    if (!mergeEligible(live)) { block(merge, "lane has not met the review merge bar", ports.now()); return; }
    change(merge);
    admitted = true;
  });
  return changed && admitted;
}

/** Reconciles a retained update issued by an older runner into its chain:
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

/** A checkout base may be the PR branch itself on a successor lane. Only
 * forge evidence supplies the branch an automatic refresh may merge from. */
async function refreshBaseBranch(read: Pipeline, forgeBase: string, ports: AutoMergePorts): Promise<string> {
  const base = forgeBase || (await ports.run(["repo", "view", read.merge!.repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim();
  if (!base || base.replace(/^refs\/heads\//, "") === read.delivery?.target.branch.replace(/^refs\/heads\//, ""))
    throw new Error("gh returned no refresh source distinct from the delivery branch");
  return base;
}

async function stepLane(read: Pipeline, ports: AutoMergePorts, mayMerge = true, capacityReason: string | null = null, queueReason: string | null = null): Promise<void> {
  const now = ports.now();
  const merge = structuredClone(read.merge!);
  const setting = ports.setting(read.project);
  if (!merge.effectUncertain && merge.state !== "merging" && !mergeEligible(read)) {
    await commit(ports, read, live => block(live, "lane has not met the review merge bar", now));
    return;
  }
  if (merge.prNumber === null) {
    /* A retry resolves the PR before any GitHub command can name it. */
    const pr = ports.pullRequestOf(read);
    await commit(ports, read, (live) => {
      if (!pr) { block(live, MERGE_REASONS.noPr, now); return; }
      live.repository = pr.repository;
      live.prNumber = pr.number;
      live.reason = null;
    });
    return;
  }
  let view: PullRequestView | null = null;
  let required: string[] = [];
  let decision: Step;
  try {
    view = parsePullRequestView(await ports.run(["pr", "view", String(merge.prNumber), "--repo", merge.repository, "--json", PR_FIELDS]));
    if (!view) throw new Error("gh returned no parsable pull request");
    if (view.state === "OPEN" || view.state === "CLOSED") admitLocalOutputHead(read, merge, view.headRefOid);
    if (view.state === "CLOSED" && merge.chain.includes(view.headRefOid)) {
      const landed = await readBatchLanding(merge.repository, merge.prNumber, view.baseRefName || read.baseBranch, { head: view.headRefOid, repoDir: read.repoDir }, ports.run);
      if (landed) view = { ...view, state: "MERGED", mergeCommit: landed.commit, mergedAt: landed.mergedAt };
    }
    if (merge.effectUncertain && view.state !== "MERGED" && view.state !== "CLOSED") {
      await commit(ports, read, live => {
        live.state = "blocked";
        live.reason = "The merge outcome is unconfirmed; waiting for its actual receipt";
        live.nextReadAt = iso(now + MERGE_POLL_MS);
      });
      return;
    }
    const behindReviewedHead = view.state === "OPEN" && view.headRefOid !== merge.chain.at(-1)
      ? (await prHeadBehindReviewedHead(read, view.headRefOid))
      : null;
    if (behindReviewedHead) {
      await commit(ports, read, (live) => block(live, `PR head is behind the reviewed head ${behindReviewedHead}`, now));
      return;
    }
    /* Only a retained legacy update can admit an unreviewed chain extension.
       New base refreshes own their reviewed head in a successor lane. */
    if (view.state === "OPEN" && !merge.chain.includes(view.headRefOid)) await admitUpdateHead(merge, view.headRefOid, ports);
    if (view.state === "OPEN") {
      view.reviews = parseReviews(await ports.run(["api", `repos/${merge.repository}/pulls/${merge.prNumber}/reviews?per_page=100`, "--paginate", "--jq", ".[] | {reviewer: .user.login, isBot: (.user.type == \"Bot\"), state} | @json"]));
      required = await requiredContexts(merge.repository, view.baseRefName || "main", ports);
    }
    decision = decideMerge(merge, view, required, now);
    const red = view.checks.find(check => check.verdict === "red");
    const failedCheck = decision.kind === "block" && red && decision.reason === checkFailedReason(red.name);
    const needsRefresh = failedCheck || decision.kind === "refresh" || (decision.kind === "block" && decision.reason === MERGE_REASONS.conflict);
    const refreshRefusal = decision.kind === "refresh"
      ? "Delegatus could not start the refresh: the PR is behind its base and has no eligible delivery refresh"
      : decision.kind === "block" ? decision.reason : MERGE_REASONS.conflict;
    if (needsRefresh && ports.startRefresh
      && refreshAdmission(read, ports.loadPipelines(), ports.setting(read.project))) {
      const baseBranch = await refreshBaseBranch(read, view.baseRefName, ports);
      const base = (await ports.run(["api", `repos/${merge.repository}/branches/${encodeURIComponent(baseBranch)}`, "--jq", ".commit.sha"])).trim();
      if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error("gh returned no base tip");
      // Compare immutable SHAs: soft protection need not report BEHIND.
      const mergeBase = failedCheck
        ? (await ports.run(["api", `repos/${merge.repository}/compare/${base}...${view.headRefOid}`, "--jq", ".merge_base_commit.sha"])).trim()
        : null;
      if (failedCheck && !/^[0-9a-f]{40}$/i.test(mergeBase!)) throw new Error("gh returned no merge base");
      // A refresh that already tried this base leaves a real red check blocked
      // with its original reason, even if its builder did not merge the base.
      if (!failedCheck || (mergeBase !== base && read.refreshOf?.base !== base)) {
        if (!refreshAdmission(read, ports.loadPipelines(), ports.setting(read.project))) {
          await commit(ports, read, (live) => block(live, refreshRefusal, now));
          return;
        }
        if (read.refreshOf?.base === base) {
          await commit(ports, read, (live) => block(live, MERGE_REASONS.refreshSameBase, now));
          return;
        }
        if (capacityReason) {
          const reason = `${decision.kind === "refresh" ? "PR is behind its base" : refreshRefusal}; ${capacityReason}`;
          decision = mergeWaitExpired(merge, now)
            ? { kind: "block", reason }
            : { kind: "wait", state: "checking", reason };
        } else {
          const reserved = await commit(ports, read, (live, current) => {
            const pipelines = ports.loadPipelines();
            if (!refreshAdmission(current, pipelines, ports.setting(current.project))) { block(live, refreshRefusal, now); return; }
            if (refreshWasRequested(current, pipelines, base, view!.headRefOid)
              || ports.loadRefreshByKey?.(refreshTupleKey(current, base, view!.headRefOid))) {
              block(live, failedCheck ? refreshRefusal : MERGE_REASONS.refreshSameBase, now);
              return;
            }
            live.state = "refreshing";
            live.reason = null;
            live.nextReadAt = null;
            live.refresh = refreshReservation(read, base, view!.headRefOid, now, baseBranch);
            live.readFailures = 0;
          });
          if (reserved) {
            const current = ports.loadPipelines().find((lane) => lane.id === read.id);
            if (current?.merge?.state === "refreshing") await startRefresh(current, ports);
          }
          return;
        }
      }
    }
    if (decision.kind === "refresh") decision = { kind: "block", reason: refreshRefusal };
  } catch (error) {
    const failures = (merge.readFailures ?? 0) + 1;
    ports.log?.(`[auto merge] ${read.id}: read failed (${failures})`, error);
    await commit(ports, read, (live) => {
      live.readFailures = failures;
      live.readAt = iso(now);
      if (live.effectUncertain) {
        live.state = "blocked";
        live.reason = "The merge outcome is unconfirmed; its receipt is unreadable";
        live.nextReadAt = iso(now + MERGE_POLL_MS);
      }
      else if (mergeWaitExpired(live, now)) block(live, MERGE_REASONS.checksTimeout, now);
      else if (failures >= MERGE_READ_FAILURE_LIMIT) block(live, MERGE_REASONS.unreachable, now);
      else live.nextReadAt = iso(now + MERGE_POLL_MS);
    });
    return;
  }
  const step = decision!;
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
      delete live.effectUncertain;
      bookkeeping(live);
      live.state = "merged";
      live.by = step.by;
      if (step.by === "auto-merge") live.postMergeWatch = true;
      live.mergedHead = view!.headRefOid;
      live.mergeCommit = view!.mergeCommit;
      live.mergedAt = view!.mergedAt ?? iso(now);
      live.reason = null;
      live.blockedAt = null;
      live.nextReadAt = null;
    });
    return;
  }
  if (step.kind === "block") {
    await commit(ports, read, (live) => {
      if (view?.state === "CLOSED") delete live.effectUncertain;
      bookkeeping(live); block(live, step.reason, now);
    });
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
  if (!mayMerge) {
    await commit(ports, read, (live) => {
      bookkeeping(live);
      live.state = "queued";
      live.reason = queueReason ?? capacityReason;
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
  const method = await mergeMethod(merge.repository, ports).catch(() => "squash" as const);
  const recorded = await commitReviewed(ports, read, (live) => {
    bookkeeping(live);
    live.state = "merging";
    if (read.proactiveTaskIds?.length) live.effectUncertain = true;
    live.method = method;
    live.reason = null;
    live.nextReadAt = iso(now + MERGE_POLL_MS);
  });
  if (!recorded) return;
  let failure: string | null = null;
  let dispatched = false;
  try {
    /* `--match-head-commit`: GitHub refuses if the head moved since the read.
       The branch stays; worktree cleanup owns lane branches. */
    const beforeDispatch = () => {
      const current = ports.loadPipelines().find(lane => lane.id === read.id);
      if (read.proactiveTaskIds?.length && (!current || !mergeEligible(current)
        || current.merge?.reviewedHead !== current.lastPassedCommit)) {
        throw new Error("proactive merge requires result-review evidence for its implemented head");
      }
      assertProactivePipelineExecution(current ?? read, "effect");
    };
    beforeDispatch();
    await ports.write(["pr", "merge", String(merge.prNumber), "--repo", merge.repository, `--${method}`, "--match-head-commit", view.headRefOid], merge.repository,
      () => { beforeDispatch(); dispatched = true; });
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
    if (after?.state === "MERGED") {
      delete live.effectUncertain;
      live.state = "merged";
      live.by = "auto-merge";
      live.postMergeWatch = true;
      live.mergedHead = after?.headRefOid ?? view!.headRefOid;
      live.mergeCommit = after?.mergeCommit ?? null;
      live.mergedAt = after?.mergedAt ?? iso(ports.now());
      live.reason = null;
      live.nextReadAt = null;
      return;
    }
    if (live.effectUncertain && after?.state === "CLOSED") {
      delete live.effectUncertain;
      block(live, MERGE_REASONS.closed, ports.now());
      return;
    }
    if (live.effectUncertain && !dispatched) delete live.effectUncertain;
    if (live.effectUncertain) {
      live.state = "blocked";
      live.reason = failure ?? "The merge outcome is unconfirmed; waiting for its actual receipt";
      live.nextReadAt = iso(ports.now() + MERGE_POLL_MS);
      return;
    }
    if (failure) block(live, failure, ports.now());
    /* Otherwise the merge was accepted and the PR does not read merged yet:
       the next read in `merging` settles it. */
  });
}

/** Create without the lock, then attach the answer to this reservation only. */
async function startRefresh(read: Pipeline, ports: AutoMergePorts): Promise<void> {
  if (!ports.startRefresh || !read.merge?.refresh || read.merge.refresh.pipelineId) return;
  const reservation = read.merge.refresh;
  try {
    if (!ports.setting(read.project).enabled) return;
    const lineage = await ports.activeSeat?.(read.project) ?? {
      srcPath: read.srcPath, srcConversationId: read.srcConversationId, srcDeputyConversationId: read.srcDeputyConversationId ?? undefined,
    };
    // Old reservations did not save the branch name. Read the forge base,
    // never a successor's checkout base, before replaying their creation.
    let legacyBase: string | undefined;
    if (!reservation.baseBranch) {
      const view = parsePullRequestView(await ports.run(["pr", "view", String(read.merge.prNumber), "--repo", read.merge.repository, "--json", PR_FIELDS]));
      if (!view) throw new Error("gh returned no PR base branch");
      legacyBase = await refreshBaseBranch(read, view.baseRefName, ports);
    }
    const current = ports.loadPipelines().find((lane) => lane.id === read.id);
    if (!ports.setting(read.project).enabled || current?.merge?.state !== "refreshing"
      || current.merge.refresh?.key !== reservation.key || current.merge.refresh.pipelineId) return;
    const result = await ports.startRefresh(refreshRequest(read, legacyBase), {
      creationRequest: { key: reservation.key, digest: reservation.digest },
      refreshOf: { pipelineId: read.id, base: reservation.base, lineage },
    });
    // A replay may race another sweep; write only while this reservation waits.
    await commit(ports, read, (live) => {
      if (result.pipeline) { live.refresh!.pipelineId = result.pipeline.id; live.readFailures = 0; }
      else block(live, `Delegatus could not start the refresh: ${result.error ?? "no lane returned"}`, ports.now());
    });
  } catch (error) {
    await commit(ports, read, (live) => {
      live.readFailures = (live.readFailures ?? 0) + 1;
      if (live.readFailures >= MERGE_READ_FAILURE_LIMIT) block(live, `Delegatus could not start the refresh: ${githubMessage(error)}`, ports.now());
    });
  }
}

/* ── The sweep ──────────────────────────────────────────────────────────── */

type MergeAdmissionPorts = Pick<AutoMergePorts, "setting" | "pullRequestOf" | "hasPublishedPrototype">;

/** Shared by the sweep and retry-merge. Call again against the live lane under
 * its write lock: a pre-lock observation grants no admission authority. */
export function mergeAdmission(pipeline: Pipeline, now: number, ports: MergeAdmissionPorts = {
  setting: mergeOnReviewSetting, pullRequestOf: lanePullRequest, hasPublishedPrototype,
}): { merge: PipelineMerge } | { reason: string } {
  const proactiveError = proactivePipelineExecutionError(pipeline);
  if (proactiveError) return { reason: proactiveError };
  if (pipeline.state !== "completed") return { reason: "only a completed pipeline can queue its merge" };
  if (pipeline.hiddenAt) return { reason: "lane is hidden" };
  if (pipeline.merge) return { reason: "lane already has a merge record" };
  const setting = ports.setting(pipeline.project);
  if (!setting.enabled) return { reason: 'the project\'s "merge when the review passes" setting is off' };
  if (!setting.changedAt || !(Date.parse(pipeline.closedAt ?? "") >= Date.parse(setting.changedAt)))
    return { reason: "lane did not complete after the merge setting was enabled" };
  if (!pipeline.lastPassedCommit) return { reason: "lane has no passed commit" };
  if (!mergeEligible(pipeline)) return { reason: "lane has not met the review merge bar" };
  const pr = ports.pullRequestOf(pipeline);
  if (!pr && laneNeedsNoPr(pipeline, ports)) return { reason: "no pull request is required" };
  if (!pr && pipeline.delivery?.disposition === "comparison") return { reason: "comparison lane does not own publication" };
  const repository = pr?.repository ?? pipelineRepository(pipeline);
  if (!repository) return { reason: "lane has no resolved repository" };
  const merge = newMerge(pipeline, { repository, number: pr?.number ?? null }, setting, now);
  if (!pr) block(merge, MERGE_REASONS.noPr, now);
  return { merge };
}

// One owner across compiled bundles and fresh scheduler ports. A pass evicts
// lanes that left the hot collection, reopened, or acquired a merge record;
// retained reasons can never outnumber completed hot lanes without a merge.
const admissionHost = globalThis as typeof globalThis & { __llvAutoMergeAdmissionReasons?: Map<string, string> };
const admissionReasons = admissionHost.__llvAutoMergeAdmissionReasons ??= new Map<string, string>();
function notAdmitted(ports: AutoMergePorts, id: string, reason: string): void {
  if (admissionReasons.get(id) === reason) return;
  admissionReasons.set(id, reason);
  ports.log?.(`[auto merge] ${id}: not admitted: ${reason}`);
}

// One bounded reason per retained completed lane with a merge record; evicted
// when the lane leaves that collection. Shared by recreated scheduler ports.
const laneHost = globalThis as typeof globalThis & { __llvAutoMergeLaneReasons?: Map<string, string> };
const laneReasons = laneHost.__llvAutoMergeLaneReasons ??= new Map<string, string>();
function laneStatus(ports: AutoMergePorts, id: string, reason: string): void {
  const bounded = reason.replace(/[\r\n]+/g, " ").slice(0, 400);
  if (laneReasons.get(id) === bounded) return;
  laneReasons.set(id, bounded);
  ports.log?.(`[auto merge] ${id}: ${bounded}`);
}

function mergeStatus(merge: PipelineMerge, hidden = false): string {
  return `${hidden ? "skipped: lane is hidden; " : ""}${merge.state}${merge.reason ? `: ${merge.reason}` : ""}`;
}

/** Followers outside the read window still expose their FIFO blocker. Keep
 * their check clock untouched and avoid writing the same explanation again. */
async function retainQueueReason(ports: AutoMergePorts, read: Pipeline, reason: string): Promise<void> {
  if (read.merge?.state !== "queued" || read.merge.reason === reason) return;
  await commit(ports, read, live => { live.reason = reason; });
}

function mergeWaitExpired(merge: PipelineMerge, now: number): boolean {
  return now - Date.parse(merge.headSeenAt ?? "") >= MERGE_WAIT_LIMIT_MS;
}

/** A sweep may visit retained lanes, but never drains them in one loop turn. */
async function* mergeRows<T>(rows: Iterable<T>) {
  let started = performance.now(), count = 0;
  for (const row of rows) {
    if (++count > 8 || performance.now() - started >= 8) {
      await yieldToRuntime();
      started = performance.now(); count = 1;
    }
    yield row;
  }
}

/**
 * One pass: queue every eligible lane still missing a record, cancel what only waits
 * under a setting turned off, note merges someone else made, and take one step
 * on the head of each repository's queue whose next read is due.
 */
export async function sweepAutoMerge(ports: AutoMergePorts): Promise<void> {
  return withViewerOperation("forge.auto-merge", async () => {
  await ports.prepareRead?.();
  const now = ports.now();
  const pipelines = performanceSpans.sync("forge.auto-merge.read", ports.loadPipelines);
  const pending = new Set<string>();
  const retained = new Set<string>();
  // Keep at most eight due receipts. Persisted due times rotate older work to
  // the front across sweeps and restarts without an in-memory scan cursor.
  const receipts: Array<{ pipeline: Pipeline; due: number }> = [];
  for await (const pipeline of mergeRows(pipelines)) {
    performanceSpans.sync("forge.auto-merge.prune", () => {
      if (pipeline.state === "completed" && !pipeline.merge) pending.add(pipeline.id);
      if (pipeline.state === "completed" && pipeline.merge) retained.add(pipeline.id);
      if (pipeline.merge?.effectUncertain) {
        const parsed = Date.parse(pipeline.merge.nextReadAt ?? "");
        const due = Number.isFinite(parsed) ? parsed : -Infinity;
        if (due <= now) {
          receipts.push({ pipeline, due });
          receipts.sort((a, b) => a.due - b.due || a.pipeline.id.localeCompare(b.pipeline.id));
          if (receipts.length > 8) receipts.pop();
        }
      }
    });
  }
  for await (const id of mergeRows(admissionReasons.keys())) {
    performanceSpans.sync("forge.auto-merge.prune", () => { if (!pending.has(id)) admissionReasons.delete(id); });
  }
  for await (const id of mergeRows(laneReasons.keys())) {
    performanceSpans.sync("forge.auto-merge.prune", () => { if (!retained.has(id)) laneReasons.delete(id); });
  }
  for (const { pipeline } of receipts) await stepLane(pipeline, ports, false);
  for await (const pipeline of mergeRows(pipelines)) {
    // Custody survives lane closure and visibility changes; this path only reads.
    if (pipeline.merge?.effectUncertain) continue;
    const { completed, hidden } = performanceSpans.sync("forge.auto-merge.admit", () => ({
      completed: pipeline.state === "completed", hidden: Boolean(pipeline.hiddenAt),
    }), 1);
    if (!completed) continue;
    if (hidden) {
      if (!pipeline.merge) notAdmitted(ports, pipeline.id, "lane is hidden");
      else laneStatus(ports, pipeline.id, mergeStatus(pipeline.merge, true));
      if (!pipeline.merge?.refresh?.pipelineId) continue;
    }
    const setting = ports.setting(pipeline.project);
    const merge = pipeline.merge;
    if (merge && (!PIPELINE_MERGE_LIVE_STATES.has(merge.state) || merge.refresh?.pipelineId)) {
      laneStatus(ports, pipeline.id, mergeStatus(merge));
    }
    const linkedPr = ports.pullRequestOf(pipeline);
    if (!linkedPr && !merge?.prNumber && laneNeedsNoPr(pipeline, ports)) {
      if (!merge) notAdmitted(ports, pipeline.id, "no pull request is required");
      // Retire an old false stop as well as refusing admission for new lanes.
      if (merge && merge.reason === MERGE_REASONS.noPr) await ports.mutate(pipeline.id, (live) => {
        if (live.state !== "completed" || live.merge?.updatedAt !== merge.updatedAt || live.merge.prNumber
          || ports.pullRequestOf(live) || !laneNeedsNoPr(live, ports)) return false;
        delete live.merge;
        return true;
      });
      continue;
    }
    if (!merge) {
      const admission = mergeAdmission(pipeline, now, ports);
      if ("reason" in admission) {
        notAdmitted(ports, pipeline.id, admission.reason);
        continue;
      }
      let reason = "lane was missing or unavailable at admission";
      try {
        const admitted = await ports.mutate(pipeline.id, (live) => {
          const current = mergeAdmission(live, ports.now(), ports);
          if ("reason" in current) { reason = current.reason; return false; }
          live.merge = current.merge;
          if (live.merge.reason) ports.log?.(`[auto merge] ${pipeline.id}: admission blocked: ${live.merge.reason}`);
          return true;
        });
        if (!admitted) notAdmitted(ports, pipeline.id, reason);
        else admissionReasons.delete(pipeline.id);
      } catch (error) {
        ports.log?.(`[auto merge] ${pipeline.id}: admission failed; will retry next sweep`, error);
      }
      continue;
    }
    if ((PIPELINE_MERGE_LIVE_STATES.has(merge.state) || merge.state === "refreshing") && merge.state !== "merging" && !setting.enabled) {
      await commit(ports, pipeline, (live) => { live.state = "cancelled"; live.reason = MERGE_REASONS.settingOff; live.nextReadAt = null; });
      continue;
    }
    if (merge.state !== "merged" && merge.state !== "cancelled" && (merge.state === "refreshing" || merge.refresh?.pipelineId)) {
      const refreshed = ports.loadPipelines().find((lane) => lane.id === merge.refresh?.pipelineId);
      const cached = merge.prNumber ? ports.cachedState(merge.repository, merge.prNumber) : null;
      if (refreshed?.merge?.state === "merged" || cached === "merged") {
        await commit(ports, pipeline, (live) => {
          live.state = "merged";
          live.by = refreshed?.merge?.by ?? "outside";
          live.mergedAt = refreshed?.merge?.mergedAt ?? iso(now);
          live.mergedHead = refreshed?.merge?.mergedHead ?? null;
          live.mergeCommit = refreshed?.merge?.mergeCommit ?? null;
          live.reason = null;
        });
      } else if (cached === "closed") {
        const due = Date.parse(merge.nextReadAt ?? "");
        if (!Number.isFinite(due) || due <= now) await reconcileBatchLanding(pipeline, { repository: merge.repository, number: merge.prNumber! }, ports, true);
      } else if (refreshed?.state === "completed" && !refreshed.merge
        && refreshed.refreshOf?.pipelineId === pipeline.id && refreshed.refreshOf.base === merge.refresh?.base) {
        // A refused successor cannot carry the queue slot. An eligible lane
        // still awaiting admission keeps it; a failed admission write retries.
        const admission = mergeAdmission(refreshed, now, ports);
        if ("reason" in admission && (merge.state !== "blocked" || merge.reason !== `Refresh was not admitted: ${admission.reason}`)) {
          await commit(ports, pipeline, (live) => {
            const current = ports.loadPipelines().find(lane => lane.id === refreshed.id);
            if (current?.state !== "completed" || current.merge
              || current.refreshOf?.pipelineId !== pipeline.id || current.refreshOf.base !== live.refresh?.base) return;
            const latest = mergeAdmission(current, ports.now(), ports);
            if ("reason" in latest) block(live, `Refresh was not admitted: ${latest.reason}`, ports.now());
          });
        }
      } else if (refreshed?.state === "completed" && mergeEligible(refreshed) && refreshed.merge
        && refreshed.refreshOf?.pipelineId === pipeline.id && refreshed.refreshOf.base === merge.refresh?.base
        && refreshed.merge.repository === merge.repository && refreshed.merge.prNumber === merge.prNumber) {
        // The successor owns the refreshed head and its check clock. Reflect its
        // progress on the original lane without putting both in the merge queue.
        const progress = refreshed.merge;
        if (merge.state !== progress.state || merge.reason !== progress.reason || merge.readAt !== progress.readAt) {
          await commit(ports, pipeline, (live) => {
            const current = ports.loadPipelines().find(lane => lane.id === refreshed.id);
            if (current?.state !== "completed" || current.lastPassedCommit !== refreshed.lastPassedCommit
              || current.merge?.updatedAt !== progress.updatedAt || !mergeEligible(current)
              || current.refreshOf?.pipelineId !== pipeline.id || current.refreshOf.base !== merge.refresh?.base
              || !ports.setting(pipeline.project).enabled) return;
            live.state = progress.state;
            live.reason = progress.reason;
            live.blockedAt = progress.blockedAt;
            live.readAt = progress.readAt;
            live.nextReadAt = progress.nextReadAt;
          });
        }
      } else if (refreshed?.state === "needs_decision") {
        await commit(ports, pipeline, (live) => block(live, refreshed.stateDetail || "Refresh needs a decision", now));
      } else if (refreshed?.state === "closed") {
        await commit(ports, pipeline, (live) => block(live, MERGE_REASONS.refreshClosed, now));
      }
      continue;
    }
    if (hidden) continue;
    const pr = merge.prNumber === null ? ports.pullRequestOf(pipeline) : { repository: merge.repository, number: merge.prNumber };
    const cached = pr ? ports.cachedState(pr.repository, pr.number) : null;
    if ((merge.state === "blocked" || merge.state === "cancelled") && pr && cached !== "merged"
      && (merge.reason === MERGE_REASONS.closed || cached === "closed")) {
      const due = Date.parse(merge.nextReadAt ?? "");
      if (!Number.isFinite(due) || due <= now) await reconcileBatchLanding(pipeline, pr, ports);
      continue;
    }
    if ((merge.state === "blocked" || merge.state === "cancelled") && pr && cached === "merged") {
      await commit(ports, pipeline, (live) => {
        live.repository = pr.repository;
        live.prNumber = pr.number;
        live.state = "merged";
        live.by = "outside";
        live.reason = null;
        live.blockedAt = null;
        live.mergedAt = iso(now);
      });
    }
  }
  // A refresh and all its successors occupy the original PR's queue slot.
  // Keep the original completion order even when its current carrier is newer.
  const rows = performanceSpans.sync("forge.auto-merge.read", ports.loadPipelines);
  const byId = new Map<string, Pipeline>();
  for await (const pipeline of mergeRows(rows)) byId.set(pipeline.id, pipeline);
  // Resolve only referenced ancestors. Their queue timestamps survive archival;
  // archived records supply order, never fresh merge or refresh authority.
  let ancestry = rows;
  const lookedUp = new Set<string>();
  while (ports.loadRefreshAncestors) {
    const missing = new Set<string>();
    for await (const pipeline of mergeRows(ancestry)) {
      const id = pipeline.refreshOf?.pipelineId;
      if (id && !byId.has(id) && !lookedUp.has(id)) missing.add(id);
    }
    if (!missing.size) break;
    for (const id of missing) lookedUp.add(id);
    ancestry = ports.loadRefreshAncestors([...missing]);
    for await (const pipeline of mergeRows(ancestry)) byId.set(pipeline.id, pipeline);
  }
  const origin = (row: Pipeline): Pipeline => {
    const seen = new Set<string>();
    while (row.refreshOf && !seen.has(row.id)) {
      seen.add(row.id);
      const parent = byId.get(row.refreshOf.pipelineId);
      if (!parent) break;
      row = parent;
    }
    return row;
  };
  type QueueEntry = { pipeline: Pipeline; activeRefresh: boolean };
  const queues = new Map<string, Map<string, QueueEntry>>();
  const activeRefreshes = new Map<string, string[]>();
  for await (const pipeline of mergeRows(rows)) {
    performanceSpans.sync("forge.auto-merge.queue", () => {
      const merge = pipeline.merge;
      if (merge?.effectUncertain) return;
      const activeRefresh = Boolean(pipeline.refreshOf) && pipeline.state !== "completed"
        && pipeline.state !== "closed" && pipeline.state !== "needs_decision";
      if (!activeRefresh && (pipeline.state !== "completed" || !merge
        || (!PIPELINE_MERGE_LIVE_STATES.has(merge.state) && merge.state !== "refreshing"))) return;
      const pr = activeRefresh ? ports.pullRequestOf(pipeline) : null;
      const parentMerge = pipeline.refreshOf ? byId.get(pipeline.refreshOf.pipelineId)?.merge : null;
      const repository = pr?.repository ?? merge?.repository ?? parentMerge?.repository;
      if (!repository) return;
      const number = pr?.number ?? merge?.prNumber ?? parentMerge?.prNumber;
      const queue = queues.get(repository) ?? new Map<string, QueueEntry>();
      queues.set(repository, queue);
      const key = number == null ? pipeline.id : String(number);
      const held = queue.get(key);
      if (activeRefresh) {
        const refreshing = activeRefreshes.get(repository) ?? [];
        refreshing.push(pipeline.id);
        activeRefreshes.set(repository, refreshing);
      }
      if (!held || activeRefresh || (!held.activeRefresh && held.pipeline.merge?.refresh?.pipelineId && !merge?.refresh?.pipelineId)) {
        queue.set(key, { pipeline, activeRefresh });
      }
    }, 1);
  }
  const limit = Math.max(1, Math.min(2, Math.floor(ports.refreshConcurrency ?? 1) || 1));
  for await (const [repository, queue] of mergeRows(queues)) {
    const ordered = [...queue.values()].sort(({ pipeline: left }, { pipeline: right }) => {
      const a = origin(left), b = origin(right);
      return (a.merge?.requestedAt ?? a.closedAt ?? "").localeCompare(b.merge?.requestedAt ?? b.closedAt ?? "")
        || a.id.localeCompare(b.id);
    });
    const refreshing = activeRefreshes.get(repository) ?? [];
    const capacityReason = `waiting for repository capacity held by refresh ${refreshing.slice(0, 2).join(", ")}`;
    const first = ordered[0]!.pipeline;
    const firstPr = first.merge?.prNumber ?? ports.pullRequestOf(first)?.number;
    const queueReason = `queued behind ${firstPr == null ? `pipeline ${first.id}` : `PR #${firstPr} (pipeline ${first.id})`}`
      + (refreshing.length >= limit ? `; ${capacityReason}` : "");
    for await (const { pipeline, activeRefresh } of mergeRows(ordered.slice(limit))) {
      if (!activeRefresh && !pipeline.hiddenAt) await retainQueueReason(ports, pipeline, queueReason);
    }
    let available = Math.max(0, limit - refreshing.length);
    for (const [index, { pipeline: head, activeRefresh }] of ordered.slice(0, limit).entries()) {
      if (activeRefresh) {
        // Creation may have committed before its answer was lost. Replaying
        // that exact durable key repairs the parent's link without a new slot.
        const parent = byId.get(head.refreshOf!.pipelineId);
        const reservation = parent?.merge?.refresh;
        if (parent?.state === "completed" && parent.merge?.state === "refreshing" && reservation && !reservation.pipelineId
          && reservation.base === head.refreshOf!.base && head.creationRequest?.key === reservation.key
          && head.creationRequest.digest === reservation.digest) await startRefresh(parent, ports);
        continue;
      }
      // Capacity gates new work. Completed carriers still need their bounded
      // reads to reconcile external merges and release expired check holds.
      const hasCapacity = available > 0;
      if (hasCapacity) available -= 1;
      if (head.merge!.state === "refreshing" || head.merge!.refresh?.pipelineId) {
        if (hasCapacity && !head.merge!.refresh?.pipelineId) await startRefresh(head, ports);
        continue;
      }
      const due = performanceSpans.sync("forge.auto-merge.queue", () => Date.parse(head.merge!.nextReadAt ?? ""), 1);
      if (Number.isFinite(due) && due > now && !mergeWaitExpired(head.merge!, now)) {
        if (index > 0 && !head.hiddenAt) await retainQueueReason(ports, head, queueReason);
        if (!head.hiddenAt) laneStatus(ports, head.id, mergeStatus(head.merge!));
        continue;
      }
      try {
        await stepLane(head, ports, index === 0 && hasCapacity,
          hasCapacity ? null : capacityReason, index > 0 ? queueReason : null);
      } catch (error) {
        ports.log?.(`[auto merge] ${head.id}: step failed`, error);
        if (mergeWaitExpired(head.merge!, ports.now())) {
          await commit(ports, head, live => block(live, MERGE_REASONS.checksTimeout, ports.now()));
        }
      }
    }
  }
  });
}

/** Closed PRs stay CLOSED in the forge cache after a batch lands. Recheck
 * receipts on a poll interval, preserving a genuine stop and doing no writes
 * to GitHub even if the PR has since reopened. */
async function reconcileBatchLanding(read: Pipeline, pr: { repository: string; number: number }, ports: AutoMergePorts, stopClosedRefresh = false): Promise<void> {
  const now = ports.now();
  const merge = { ...read.merge!, chain: [...read.merge!.chain] };
  let view: PullRequestView | null = null;
  try {
    view = parsePullRequestView(await ports.run(["pr", "view", String(pr.number), "--repo", pr.repository, "--json", PR_FIELDS]));
    if (!view) throw new Error("gh returned no parsable pull request");
    if (view.state === "CLOSED") admitLocalOutputHead(read, merge, view.headRefOid);
    if (view.state === "CLOSED" && merge.chain.includes(view.headRefOid)) {
      const landed = await readBatchLanding(pr.repository, pr.number, view.baseRefName || read.baseBranch, { head: view.headRefOid, repoDir: read.repoDir }, ports.run);
      if (landed) view = { ...view, state: "MERGED", mergeCommit: landed.commit, mergedAt: landed.mergedAt };
    }
  } catch (error) {
    view = null;
    ports.log?.(`[auto merge] ${read.id}: landing read failed`, error);
  }
  await commit(ports, read, (live) => {
    live.readAt = iso(now);
    live.nextReadAt = iso(now + MERGE_POLL_MS);
    if (stopClosedRefresh && view?.state === "CLOSED") block(live, MERGE_REASONS.closed, now);
    if (view?.state !== "MERGED") return;
    live.chain = merge.chain;
    live.repository = pr.repository;
    live.prNumber = pr.number;
    live.state = "merged";
    live.by = "outside";
    live.mergedHead = view.headRefOid;
    live.mergeCommit = view.mergeCommit;
    live.mergedAt = view.mergedAt ?? iso(now);
    live.reason = null;
    live.blockedAt = null;
    live.nextReadAt = null;
    live.readFailures = 0;
  });
}

/* ── A pipeline that finishes its task (#2187 §5) ───────────────────────── */

/** Exact base/head equality proves a lane has nothing to merge. Legacy
    symbolic or missing bases provide no such evidence. */
function laneHasNoCommits(pipeline: Pipeline): boolean {
  return /^[0-9a-f]{40}$/i.test(pipeline.baseRef ?? "") && pipeline.lastPassedCommit === pipeline.baseRef;
}

function laneNeedsNoPr(pipeline: Pipeline, ports: Pick<AutoMergePorts, "hasPublishedPrototype">): boolean {
  if (laneHasNoCommits(pipeline)) return true;
  const attempts = pipeline.runs.flatMap((run) => run.attempts
    .filter((attempt) => !attempt.historical && attempt.state !== "pending" && attempt.state !== "skipped")
    .map((attempt) => ({ attempt, readOnly: pipeline.stages.some((stage) => stage.id === run.stageId && stage.kind === "run")
      && attempt.effectiveRole.access === "read-only" })));
  // Read-only outputs are committed by the controller. Those commits do not
  // turn a research or design lane into an implementation awaiting a PR.
  if (attempts.length && attempts.every((entry) => entry.readOnly)) return true;
  // outputBaseHead is observed at settlement, after the preceding writers.
  // A stage report alone precedes settlement and cannot prove no later commit.
  const writers = attempts.filter((entry) => !entry.readOnly);
  if (/^[0-9a-f]{40}$/i.test(pipeline.baseRef ?? "") && attempts.some(({ attempt: output, readOnly }) => readOnly
    && output.state === "passed" && output.outputBaseHead === pipeline.baseRef
    && writers.every(({ attempt: writer }) => Date.parse(writer.completedAt ?? "") < Date.parse(output.completedAt ?? "")))) return true;
  return ports.hasPublishedPrototype?.(pipeline) === true;
}

function hasPublishedPrototype(pipeline: Pipeline): boolean {
  if (!pipeline.taskIds.length) return false;
  const terminal = pipeline.stages.filter((stage) => stage.next === null).flatMap((stage) => {
    const attempt = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((item) => !item.historical).at(-1);
    return attempt?.state === "passed" && attempt.report?.provenance.head === pipeline.lastPassedCommit
      ? [{ stageId: stage.id, attempt: attempt.n }] : [];
  });
  if (!terminal.length) return false;
  const source = taskSelectionSource();
  const tasks = source ? pipeline.taskIds.map((id) => source.read(id)) : loadTasksForList().filter((task) => pipeline.taskIds.includes(task.id));
  return tasks.some((task) => task?.prototypeReviews?.some((round) => round.source.pipelineId === pipeline.id
    && terminal.some((end) => end.stageId === round.source.stageId && end.attempt === round.source.attempt)));
}

/**
 * Whether a marked lane has finished its tasks (§5.2): it completed, and when
 * its project merges automatically, its pull request merged, by the runner
 * or by anyone. Unchanged lanes, read-only outputs and published prototypes
 * can finish without a PR. The setting is read now.
 */
export function laneFinishedForTasks(pipeline: Pipeline, ports: Pick<AutoMergePorts, "setting" | "pullRequestOf" | "cachedState" | "hasPublishedPrototype">): boolean {
  if (pipeline.state !== "completed") return false;
  if (!ports.setting(pipeline.project).enabled) return true;
  if (pipeline.merge?.state === "merged") return true;
  const pr = ports.pullRequestOf(pipeline)
    ?? (pipeline.merge?.prNumber ? { repository: pipeline.merge.repository, number: pipeline.merge.prNumber } : null);
  if (!pr) return laneNeedsNoPr(pipeline, ports);
  return ports.cachedState(pr.repository, pr.number) === "merged";
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
  return withViewerOperation("forge.auto-merge", async () => {
  if (!ports.finishTask) return;
  await ports.prepareRead?.();
  const pipelines = performanceSpans.sync("forge.auto-merge.read", ports.loadPipelines);
  const now = ports.now();
  for await (const pipeline of mergeRows(pipelines)) {
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
  });
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

const scheduleHost = globalThis as typeof globalThis & { __llvAutoMergeRunning?: Promise<unknown> | null; __llvPostMergeRunning?: Promise<unknown> | null; __llvAutoMergeStartedAt?: number };

export function productionAutoMergePorts(overrides: Partial<AutoMergePorts> & Pick<AutoMergePorts, "loadPipelines">): AutoMergePorts {
  const run = overrides.run ?? githubRunner(os.tmpdir(), GH_TIMEOUT_MS);
  return {
    now: Date.now,
    loadRefreshAncestors: loadArchivedPipelinesForOwnership,
    loadRefreshByKey: key => pipelineDeliveryLookup({ requestKey: key }),
    refreshConcurrency: Number(process.env.LLV_MERGE_REFRESH_CONCURRENCY ?? 1),
    run,
    write: forgeWriter(run, forgeAppWriter(os.tmpdir(), GH_TIMEOUT_MS)),
    prepareRead: overrides.loadPipelines === loadPipelinesForList ? async () => { await loadPipelinesForListAsync(); } : undefined,
    mutate: async (pipelineId, change) => {
      const changed = await withControllerPipelineScope([pipelineId], () => withPipelineMutation(async (pipelines, persist) => {
      const pipeline = pipelines.find((candidate) => candidate.id === pipelineId);
      if (!pipeline || !performanceSpans.sync("forge.auto-merge.step", () => change(pipeline))) return false;
      await persist();
      return true;
      }));
      // Promise continuations can otherwise take every due lane's lease before
      // the loop gets a timer opportunity. No lease spans this yield.
      await yieldToRuntime();
      return changed;
    },
    setting: mergeOnReviewSetting,
    pullRequestOf: lanePullRequest,
    cachedState: (repository, number) => forgeCacheView().repository(repository)?.pr(number)?.state ?? null,
    hasPublishedPrototype,
    finishTask: finishBoardTask,
    startRefresh: async (request, options) => (await import("@/lib/pipelines/engine")).createPipelineFromRequest(request, undefined, options),
    activeSeat: async (project) => {
      const seat = (await import("@/lib/orchestrator/seats")).orchestratorSeatFor(project).active;
      return seat ? { srcPath: seat.path, srcConversationId: seat.conversationId } : null;
    },
    log: (message, error) => console.error(message, error ?? ""),
    ...overrides,
  };
}

/** Fire-and-forget: one ordinary merge sweep, with recovery owned per merge.
 * The controller calls this beside the forge sweep; failures are logged. */
export function scheduleAutoMerge(overrides: Partial<AutoMergePorts> & Pick<AutoMergePorts, "loadPipelines">): void {
  const ports = productionAutoMergePorts(overrides);
  // Recovery has per-merge ownership and durable polling reservations. Start
  // it on every tick, even while ordinary merge reads or task finishes wait.
  const recovery = sweepPostMerge({
    ...ports,
    read: async (lane, ref) => readPostMergeChecks(lane, ref, await requiredContexts(lane.merge!.repository, "main", ports), ports.run),
    create: async (request, creationRequest, lineage) => {
      const project = ports.loadPipelines().find(lane => lane.repoDir === request.repoDir)?.project;
      const creatorLineage = (project ? await ports.activeSeat?.(project) : null) ?? lineage;
      const result = await (await import("@/lib/pipelines/engine")).createPipelineFromRequest(request, undefined, { creationRequest, creatorLineage });
      if (!result.pipeline) throw new Error(result.error ?? "Recovery pipeline creation failed");
      return { id: result.pipeline.id };
    },
    revert: (lane, key, reconcileOnly, claim) => openRevertPr(lane, key, reconcileOnly, ports.run, ports.write, claim),
    resolveMergeCommit: async lane => {
      const sha = (await ports.run(["pr", "view", String(lane.merge!.prNumber), "--repo", lane.merge!.repository, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"])).trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    },
    closeRevert: async (lane, number) => {
      const state = await ports.run(["pr", "view", String(number), "--repo", lane.merge!.repository, "--json", "state", "--jq", ".state"]);
      if (state.trim() === "OPEN") await ports.write(["pr", "close", String(number), "--repo", lane.merge!.repository], lane.merge!.repository);
    },
  })
    .catch((error) => ports.log?.("[post merge] sweep failed", error))
    .finally(() => { if (scheduleHost.__llvPostMergeRunning === recovery) scheduleHost.__llvPostMergeRunning = null; });
  scheduleHost.__llvPostMergeRunning = recovery;
  if (scheduleHost.__llvAutoMergeRunning) return;
  const now = ports.now();
  if (now - (scheduleHost.__llvAutoMergeStartedAt ?? -Infinity) < MERGE_SCHEDULE_DEBOUNCE_MS) return;
  scheduleHost.__llvAutoMergeStartedAt = now;
  /* The finish sweep runs after the merge step, so a merge this pass made
     finishes its task in the same pass. */
  const run = sweepAutoMerge(ports)
    .catch((error) => ports.log?.("[auto merge] sweep failed", error))
    .then(() => sweepTaskFinishes(ports))
    .catch((error) => ports.log?.("[task finish] sweep failed", error))
    .finally(() => { scheduleHost.__llvAutoMergeRunning = null; });
  scheduleHost.__llvAutoMergeRunning = run;
}

/** A `retry-merge` or a setting change asks for the next cycle's sweep now. */
export function nudgeAutoMerge(): void {
  scheduleHost.__llvAutoMergeStartedAt = undefined;
}
