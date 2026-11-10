import { FLOW_ARCHIVE } from "@/lib/flows/retirement";
import { registryLivenessRows, registryRowProjection, registryRowsMatching, type RegistryRowProjector } from "@/lib/agent/sqliteRegistryStore";
import { realExec } from "@/lib/workflows/provision";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  entryIsLive,
  identityAlive,
  livenessProbe,
  receiptIsLive,
  staleUndeliverableHeldDeliveryIds,
  type AccountLivenessOptions,
  type LivenessProbe,
} from "@/lib/agent/accountLiveness";
import { agentRegistry, type AgentRegistry, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { forEachCooperatively } from "@/lib/cooperative";
import { resolveFlowMergeIdentity } from "@/lib/flows/git";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import type { Flow, FlowMergeEvidence } from "@/lib/flows/types";
import {
  MIGRATION_INTENT_PROGRESS_TIMEOUT_MS,
  migrationIntentIsStale,
  ROLLED_BACK_MIGRATION_DELIVERY_REASON,
} from "@/lib/accounts/migration/intentLiveness";
import { procBackend } from "@/lib/proc";
import { readJsonCache, writeJsonDurably } from "@/lib/state/durableJson";
import { runtimeHostClient } from "@/lib/runtime/client";
import { reconcileDeadStructuredRegistryHostsOffLoop } from "@/lib/runtime/registry";
import { terminalizeStaleStructuredSpawns } from "@/lib/runtime/structuredSpawn";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { scanUserAuthoredMessagesCooperatively } from "@/lib/session/reader";
import type { FileEntry } from "@/lib/types";

import {
  evaluateReaper,
  runEvaluatedReaper,
  type HeadlessReviewerProcess,
  type ReaperAgentReport,
  type ReaperInput,
  type ReaperJournalRecord,
  type ReaperReport,
} from "./reaper";

/* Authorship proof budgets for one controller cycle (#287). */
const AUTHORSHIP_PATH_PASS_BYTES = 4 * 1024 * 1024;
const AUTHORSHIP_CYCLE_BUDGET_BYTES = 32 * 1024 * 1024;

const REPORT_FILE = () => statePath("reaper-report.json");
const STATE_FILE = () => statePath("reaper-state.json");
const JOURNAL_FILE = () => statePath("reaper-journal.ndjson");
const ROTATE_BYTES = 4 * 1024 * 1024;

interface ReaperState {
  version: 1;
  firstObservedAt: Record<string, string>;
  userAuthoredPaths: Record<string, true>;
  /* Path-scoped authorship freshness (issue #112). For every transcript the
     reaper has scanned to completion and found NOT owner-authored, the observed
     transcript mtime (seconds) at that scan. The board clears
     `authorshipUnverified` only when this per-path stamp is at least as fresh as
     the file's current mtime — a global "last cycle" timestamp would falsely
     certify a worker that exited before it was ever scanned, letting an
     unobserved user-authored transcript collapse. */
  scannedAt: Record<string, number>;
}

function readState(): ReaperState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<ReaperState>;
    if (parsed.version === 1 && parsed.firstObservedAt && typeof parsed.firstObservedAt === "object") {
      return {
        version: 1,
        firstObservedAt: parsed.firstObservedAt,
        userAuthoredPaths: parsed.userAuthoredPaths && typeof parsed.userAuthoredPaths === "object"
          ? parsed.userAuthoredPaths as Record<string, true>
          : {},
        scannedAt: parsed.scannedAt && typeof parsed.scannedAt === "object" && !Array.isArray(parsed.scannedAt)
          ? parsed.scannedAt as Record<string, number>
          : {},
      };
    }
  } catch { /* first run or invalid state */ }
  return { version: 1, firstObservedAt: {}, userAuthoredPaths: {}, scannedAt: {} };
}

function atomicWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

/** Rewrites the state file for this cycle. `firstObservedAt` tracked pane
    hosts; it is kept empty because a state file without it reads as invalid
    and would drop the authorship stamps beside it. */
function updateObservationState(): ReaperState {
  const previous = readState();
  const state = {
    version: 1 as const,
    firstObservedAt: {},
    userAuthoredPaths: previous.userAuthoredPaths,
    scannedAt: previous.scannedAt,
  };
  atomicWrite(STATE_FILE(), state);
  return state;
}

async function checkoutClean(flow: Flow): Promise<boolean | null> {
  const result = await realExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], flow.cwd, undefined, { timeoutMs: 2_000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().length === 0;
}

async function localBranchMerged(flow: Flow, reviewedHeadSha: string): Promise<boolean> {
  if (await checkoutClean(flow) !== true) return false;
  const head = await realExec("git", ["rev-parse", "HEAD"], flow.cwd, undefined, { timeoutMs: 2_000 });
  if (head.code !== 0 || head.stdout.trim() !== reviewedHeadSha) return false;
  for (const branch of ["origin/main", "origin/master", "main", "master"]) {
    const result = await realExec("git", ["merge-base", "--is-ancestor", reviewedHeadSha, branch], flow.cwd, undefined, { timeoutMs: 2_000 });
    if (result.code === 0) return true;
  }
  return false;
}

type PullRequestProbe = { number: number; mergedAt: string | null; headRefOid: string | null };

const MERGE_PROBE_TIMEOUT_MS = 5_000;
const MERGE_PROBE_CONCURRENCY = 4;

function probePullRequest(evidence: FlowMergeEvidence, timeoutMs = MERGE_PROBE_TIMEOUT_MS): Promise<PullRequestProbe | null> {
  if (!evidence.repository || !evidence.headRef) return Promise.resolve(null);
  const args = evidence.prNumber
    ? ["pr", "view", String(evidence.prNumber), "--repo", evidence.repository, "--json", "number,mergedAt,headRefOid"]
    : ["pr", "list", "--repo", evidence.repository, "--head", evidence.headRef, "--state", "all", "--json", "number,mergedAt,headRefOid", "--limit", "1"];
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (value: PullRequestProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= 1024 * 1024) stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || stdout.length > 1024 * 1024) return finish(null);
      try {
        const parsed = JSON.parse(stdout) as unknown;
        const item = (Array.isArray(parsed) ? parsed[0] : parsed) as { number?: unknown; mergedAt?: unknown; headRefOid?: unknown } | undefined;
        if (!item || !Number.isInteger(item.number)) return finish(null);
        const mergedAt = typeof item.mergedAt === "string" && item.mergedAt ? item.mergedAt : null;
        const headRefOid = typeof item.headRefOid === "string" && item.headRefOid ? item.headRefOid : null;
        if (mergedAt && (!evidence.headSha || headRefOid !== evidence.headSha)) return finish(null);
        finish({ number: item.number as number, mergedAt, headRefOid });
      } catch {
        finish(null);
      }
    });
  });
}

const MERGE_CHECK_INTERVAL_MS = 5 * 60_000;

function reviewedHeadSha(flow: Flow, evidence: FlowMergeEvidence | null): string | null {
  const reviewed = [...flow.rounds].reverse().find((round) => round.verdict === "APPROVE");
  if (reviewed?.reviewHeadSha) return reviewed.reviewHeadSha;
  return evidence?.source === "github-pr" && evidence.mergedAt ? evidence.headSha : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Everything about a flow EXCEPT its merge evidence, serialized: the evidence
    is what this pass is refreshing, so including it would make every flow look
    concurrently modified by the refresh itself. Dropping the key by filtering
    rather than by destructuring it into an unused binding keeps the same own
    enumerable keys in the same order — the serialization is unchanged. */
function flowTransitionRevision(flow: Flow): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(flow).filter(([key]) => key !== "mergeEvidence"),
  ));
}

function cloneMergeEvidence(evidence: FlowMergeEvidence | null | undefined): FlowMergeEvidence | null {
  return evidence ? { ...evidence } : null;
}

function persistRefreshedMergeEvidence(
  flows: Flow[],
  changedFlowIds: ReadonlySet<string>,
  initialRevisions: ReadonlyMap<string, string>,
  overrides: ReaperActuationOverrides,
): void {
  if (changedFlowIds.size === 0 || (overrides.loadFlows && !overrides.saveFlows)) return;
  const latest = overrides.loadFlows ? overrides.loadFlows() : overrides.saveFlows ? flows : loadFlows();
  let applied = false;
  for (const candidate of flows) {
    if (!changedFlowIds.has(candidate.id)) continue;
    const current = latest.find((flow) => flow.id === candidate.id);
    if (!current || flowTransitionRevision(current) !== initialRevisions.get(candidate.id)) continue;
    current.mergeEvidence = cloneMergeEvidence(candidate.mergeEvidence);
    applied = true;
  }
  if (applied) (overrides.saveFlows ?? saveFlows)(latest);
}

export async function refreshMergedFlowIds(flows: Flow[], overrides: ReaperActuationOverrides = {}): Promise<Set<string>> {
  if (FLOW_ARCHIVE.retired) return new Set();
  const now = (overrides.now ?? Date.now)();
  const merged = new Set<string>();
  const initialRevisions = new Map(flows.map((flow) => [flow.id, flowTransitionRevision(flow)]));
  const changedFlowIds = new Set<string>();
  const markChanged = (flow: Flow) => { changedFlowIds.add(flow.id); };
  const timeoutMs = overrides.mergeProbeTimeoutMs ?? MERGE_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, overrides.mergeProbeConcurrency ?? MERGE_PROBE_CONCURRENCY);
  await mapWithConcurrency(flows, concurrency, async (flow) => {
    let evidence = flow.mergeEvidence ?? null;
    const clean = await (overrides.checkoutClean ?? checkoutClean)(flow);
    if (clean === false || (clean === null && fs.existsSync(flow.cwd))) {
      if (evidence?.mergedAt || evidence?.source) {
        evidence.mergedAt = null;
        evidence.checkedAt = null;
        evidence.source = null;
        markChanged(flow);
      }
      return;
    }
    const reviewedSha = reviewedHeadSha(flow, evidence);
    if (!reviewedSha) return;
    const identity = await (overrides.resolveMergeIdentity ?? resolveFlowMergeIdentity)(flow.cwd);
    if (!identity && fs.existsSync(flow.cwd)) {
      if (evidence?.mergedAt || evidence?.source) {
        evidence.mergedAt = null;
        evidence.checkedAt = null;
        evidence.source = null;
        markChanged(flow);
      }
      return;
    }
    if (identity) {
      if (identity.headSha !== reviewedSha) {
        if (evidence?.mergedAt || evidence?.source) {
          evidence.mergedAt = null;
          evidence.checkedAt = null;
          evidence.source = null;
          markChanged(flow);
        }
        return;
      }
      if (!evidence || evidence.repository !== identity.repository || evidence.headRef !== identity.headRef || evidence.headSha !== reviewedSha) {
        evidence = { ...identity, headSha: reviewedSha, prNumber: null, mergedAt: null, checkedAt: null, source: null };
        flow.mergeEvidence = evidence;
        markChanged(flow);
      }
    } else if (evidence?.headSha !== reviewedSha) {
      evidence = evidence ? { ...evidence, headSha: reviewedSha, prNumber: null, mergedAt: null, checkedAt: null, source: null } : null;
      flow.mergeEvidence = evidence;
      markChanged(flow);
    }
    if (evidence?.mergedAt) {
      merged.add(flow.id);
      return;
    }
    const checkedAt = evidence?.checkedAt ? Date.parse(evidence.checkedAt) : Number.NaN;
    if (Number.isFinite(checkedAt) && now - checkedAt < MERGE_CHECK_INTERVAL_MS) return;
    let confirmed: FlowMergeEvidence | null = null;
    if (evidence?.repository && evidence.headRef) {
      const probe = overrides.probePullRequest
        ? Promise.resolve(overrides.probePullRequest(evidence))
        : probePullRequest(evidence, timeoutMs);
      const pullRequest = await withTimeout(probe, timeoutMs, null);
      if (pullRequest?.mergedAt && pullRequest.headRefOid === evidence.headSha) {
        confirmed = {
          ...evidence,
          prNumber: pullRequest.number,
          mergedAt: pullRequest.mergedAt,
          headSha: pullRequest.headRefOid ?? evidence.headSha,
          checkedAt: new Date(now).toISOString(),
          source: "github-pr",
        };
      } else {
        if (pullRequest) evidence.prNumber = pullRequest.number;
        evidence.checkedAt = new Date(now).toISOString();
        markChanged(flow);
      }
    }
    if (!confirmed && await (overrides.localBranchMerged ?? localBranchMerged)(flow, reviewedSha)) {
      confirmed = {
        repository: evidence?.repository ?? null,
        headRef: evidence?.headRef ?? null,
        headSha: reviewedSha,
        prNumber: evidence?.prNumber ?? null,
        mergedAt: new Date(now).toISOString(),
        checkedAt: new Date(now).toISOString(),
        source: "git-ancestor",
      };
    }
    if (confirmed) {
      flow.mergeEvidence = confirmed;
      merged.add(flow.id);
      markChanged(flow);
    }
  });
  persistRefreshedMergeEvidence(flows, changedFlowIds, initialRevisions, overrides);
  return merged;
}

function hasViewerWorkerLaunchPrompt(snapshot: ReturnType<AgentRegistry["snapshot"]>, pathname: string): boolean {
  return registryRowsMatching(snapshot, "receipts", "artifactPath", pathname).some((receipt) =>
    receipt.purpose === "launch"
    && receipt.artifactPath === pathname
    && receipt.launchProfile.role === "worker"
    && receipt.state === "completed");
}

function viewerFlowMessageAllowance(flows: Flow[], pathname: string): number {
  let count = 0;
  for (const flow of flows) {
    if (flow.kickoffDelivery?.path === pathname) count += 1;
    count += flow.rounds.filter((round) => round.relayDelivery?.path === pathname).length;
  }
  return count;
}

/* A HEADLESS reviewer is launched straight through the CLI (startHeadlessReview),
   not a Viewer spawn receipt, so its automated review instruction lands in the
   transcript as one user-role message that no launch/delivery allowance covers.
   Left uncounted, that single automated prompt would mark every finished headless
   reviewer owner-authored and pin it forever — the exact opposite of the
   immediate reviewer collapse #112 exists for. Grant the round's reviewer
   transcript one allowance for that startup prompt; a genuine owner message on
   top is the second and still trips the exemption.

   PANE reviewers are excluded: they launch through `spawnAgentWithPrompt`, whose
   completed worker receipt already grants the launch allowance via
   `hasViewerWorkerLaunchPrompt`. Adding a second allowance would let a pane
   reviewer carrying one automated prompt AND one genuine owner follow-up scan
   clean, collapsing an owner-touched card — a hard-constraint violation.

   The allowance is granted only with DETERMINISTIC launch provenance: the
   round's reviewer transcript basename must contain the round's own sessionId
   (claude pre-chooses it at spawn, codex reports it in the first event). A
   reviewerPath claimed by the same-CWD/latest-mtime heuristic
   (`maybeClaimReviewerPathByHeuristic`) can misattribute an owner-created
   transcript; discounting there would eat that owner's first genuine message.
   Absent/mismatched sessionId → no allowance → the automated prompt counts and
   the path stays protected (the safe side). */
function viewerReviewerLaunchAllowance(flows: Flow[], pathname: string): number {
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (round.reviewerPath !== pathname || !round.sessionId) continue;
      if (path.basename(pathname).includes(round.sessionId)) return 1;
    }
  }
  return 0;
}

/* A native subagent (a Claude `agent-*` session, or a Codex thread with a
   parent_thread_id) is spawned by its parent AGENT, not the owner, and its first
   turn is the parent's automated assignment — serialized as a user-role message
   with no Viewer receipt or flow delivery to cover it. Left uncounted, that one
   automated prompt marks every agent-spawned subtask owner-authored and pins it
   forever, so the spawned workers #112 targets never collapse. Provenance is
   deterministic from the scan entry (the `subagent` kind / native codex parent),
   so grant exactly one allowance for the assignment; a genuine owner message on
   top is the second and still trips the exemption. */
function viewerNativeSubagentAllowance(file: FileEntry | undefined): number {
  if (!file) return 0;
  if (file.root === "claude-projects" && file.kind === "subagent") return 1;
  if (file.root === "codex-sessions" && file.engine === "codex" && isNativeCodexSubagentTranscript(file.path, file.size)) return 1;
  return 0;
}

async function authorshipEvidence(
  snapshot: ReturnType<AgentRegistry["snapshot"]>,
  flows: Flow[],
  files: FileEntry[],
  priorUserAuthoredPaths: Readonly<Record<string, true>>,
  priorScannedAt: Record<string, number>,
): Promise<{
  userAuthoredPaths: Set<string>;
  unverifiedPaths: Set<string>;
  /* Path → observed transcript mtime (seconds) for every transcript scanned to
     completion and found NOT owner-authored. This is the path-scoped freshness
     the board needs to clear `authorshipUnverified` without falsely certifying
     an unscanned worker (issue #112). */
  verifiedCleanAt: Map<string, number>;
}> {
  /* Human authorship is sticky by contract. Re-reading a path after it has
     already crossed the owner-message threshold cannot change that verdict;
     it only burns through the full transcript again because authored paths do
     not receive a clean `scannedAt` stamp. Seed the current evidence from the
     durable map so every later controller cycle skips those files. */
  const userAuthoredPaths = new Set(Object.keys(priorUserAuthoredPaths));
  const unverifiedPaths = new Set<string>();
  const verifiedCleanAt = new Map<string, number>();
  /* Authorship scanning covers every quiet claude/codex transcript the scan
     sees: a finished headless reviewer is a detached process and an exited
     worker has no host at all, and without a clean stamp the board would pin
     them unverified forever (#112). A live file is skipped: it is board-exempt
     regardless and its mtime advances every write, so scanning it would churn
     without ever producing a usable stamp. */
  const fileByPath = new Map<string, FileEntry>();
  const targets = new Map<string, "claude" | "codex" | "copilot">();
  await forEachCooperatively(files, (file) => {
    fileByPath.set(file.path, file);
  });
  await forEachCooperatively(files, (file) => {
    if (file.engine !== "claude" && file.engine !== "codex" && file.engine !== "copilot") return;
    if (file.activity === "live") return;
    /* Already clean-stamped at or past the current mtime — no need to re-scan;
       the persisted stamp still stands (the caller keeps prior state entries). */
    const stamp = priorScannedAt[file.path];
    if (stamp !== undefined && stamp >= file.mtime) return;
    targets.set(file.path, file.engine);
  });
  /* Hard byte budgets (#287): one multi-gigabyte ownerless transcript may
     consume at most AUTHORSHIP_PATH_PASS_BYTES per controller cycle, and all
     authorship proofs together at most AUTHORSHIP_CYCLE_BUDGET_BYTES. An
     exhausted pass returns incomplete, the path stays protected as
     unverified, and the resumable checkpoint continues in the next cycle. */
  const authorshipReadBudget = { remaining: AUTHORSHIP_CYCLE_BUDGET_BYTES };
  await forEachCooperatively([...targets], async ([pathname, engine]) => {
    if (userAuthoredPaths.has(pathname) || unverifiedPaths.has(pathname)) return;
    const viewerMessageAllowance = (hasViewerWorkerLaunchPrompt(snapshot, pathname) ? 1 : 0)
      + viewerFlowMessageAllowance(flows, pathname)
      + viewerReviewerLaunchAllowance(flows, pathname)
      + viewerNativeSubagentAllowance(fileByPath.get(pathname));
    /* Stamp the mtime BEFORE reading: a transcript that grows during the scan
       ends up with a newer on-disk mtime than we record, so the board re-pins it
       as unverified until the next cycle rather than certifying content the
       reaper never saw. */
    let observedMtime: number | null = null;
    try {
      observedMtime = fs.statSync(pathname).mtimeMs / 1000;
    } catch {
      unverifiedPaths.add(pathname);
      return;
    }
    const scan = await scanUserAuthoredMessagesCooperatively(pathname, engine, viewerMessageAllowance + 1, {
      resume: true,
      maxBytes: AUTHORSHIP_PATH_PASS_BYTES,
      budget: authorshipReadBudget,
    });
    if (scan.count > viewerMessageAllowance) userAuthoredPaths.add(pathname);
    else if (!scan.complete) unverifiedPaths.add(pathname);
    else verifiedCleanAt.set(pathname, observedMtime);
  });
  return { userAuthoredPaths, unverifiedPaths, verifiedCleanAt };
}

function appendJournal(record: ReaperJournalRecord): void {
  const filename = JOURNAL_FILE();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(filename).size > ROTATE_BYTES) fs.renameSync(filename, `${filename}.1`);
  } catch { /* first write */ }
  fs.appendFileSync(filename, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function makeInput(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  now: number,
  overrides: ReaperActuationOverrides = {},
): Promise<ReaperInput> {
  const flows = (overrides.loadFlows ?? loadFlows)();
  /* The refresh persists merge evidence on the flows it confirms. */
  await refreshMergedFlowIds(flows, overrides);
  const authorship = await authorshipEvidence(
    registry.readOnlySnapshot(),
    flows,
    files,
    state.userAuthoredPaths,
    state.scannedAt,
  );
  let stateChanged = false;
  for (const pathname of authorship.userAuthoredPaths) {
    if (state.userAuthoredPaths[pathname]) continue;
    state.userAuthoredPaths[pathname] = true;
    stateChanged = true;
  }
  for (const [pathname, observedMtime] of authorship.verifiedCleanAt) {
    if (state.scannedAt[pathname] === observedMtime) continue;
    state.scannedAt[pathname] = observedMtime;
    stateChanged = true;
  }
  if (stateChanged) atomicWrite(STATE_FILE(), state);
  return {
    now,
    reviewerProcesses: observeHeadlessReviewers(flows, overrides),
    flows,
    enabled: process.env.LLV_REAPER_ENABLED === "1",
  };
}

function observeHeadlessReviewers(flows: Flow[], overrides: ReaperActuationOverrides): HeadlessReviewerProcess[] {
  const pidAlive = overrides.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const processIdentity = overrides.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const processes: HeadlessReviewerProcess[] = [];
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      const pid = round.reviewerPid ?? null;
      const identity = round.reviewerIdentity ?? null;
      if (!pid || !identity || !pidAlive(pid) || processIdentity(pid) !== identity) continue;
      processes.push({ flowId: flow.id, round: round.n, pid, identity, path: round.reviewerPath });
    }
  }
  return processes;
}

interface HeadlessReviewerKillDeps {
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  maxVerifyAttempts: number;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

export async function killHeadlessReviewerIfMatches(
  expected: { pid: number; identity: string },
  overrides: Partial<HeadlessReviewerKillDeps> = {},
): Promise<boolean> {
  const deps: HeadlessReviewerKillDeps = {
    pidAlive: (pid) => procBackend.pidAlive(pid),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    signal: signalProcessGroup,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxVerifyAttempts: 20,
    ...overrides,
  };
  const gone = () => !deps.pidAlive(expected.pid) || deps.processIdentity(expected.pid) !== expected.identity;
  if (gone()) return false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      deps.signal(expected.pid, signal);
    } catch {
      if (gone()) return true;
      return false;
    }
    for (let attempt = 0; attempt < deps.maxVerifyAttempts; attempt += 1) {
      if (gone()) return true;
      if (attempt + 1 < deps.maxVerifyAttempts) await deps.sleep(25);
    }
  }
  return false;
}

async function actuateCandidate(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  agent: ReaperAgentReport,
  overrides: ReaperActuationOverrides = {},
): Promise<boolean> {
  if (agent.targetKind !== "process" || !agent.flowId || agent.round === null || !agent.processIdentity) return false;
  const current = evaluateReaper(await makeInput(registry, files, state, (overrides.now ?? Date.now)(), overrides));
  const candidate = current.agents.find((item) => item.targetKind === "process"
    && item.flowId === agent.flowId
    && item.round === agent.round
    && item.agentPid === agent.agentPid
    && item.processIdentity === agent.processIdentity);
  if (!candidate?.eligible) return false;
  return (overrides.killProcess ?? killHeadlessReviewerIfMatches)({ pid: agent.agentPid, identity: agent.processIdentity });
}

export interface ReaperActuationOverrides {
  loadFlows?: typeof loadFlows;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  killProcess?: typeof killHeadlessReviewerIfMatches;
  resolveMergeIdentity?: (cwd: string) => Awaited<ReturnType<typeof resolveFlowMergeIdentity>> | ReturnType<typeof resolveFlowMergeIdentity>;
  probePullRequest?: (evidence: FlowMergeEvidence) => PullRequestProbe | null | Promise<PullRequestProbe | null>;
  localBranchMerged?: (flow: Flow, sha: string) => boolean | Promise<boolean>;
  checkoutClean?: (flow: Flow) => boolean | null | Promise<boolean | null>;
  mergeProbeTimeoutMs?: number;
  mergeProbeConcurrency?: number;
  saveFlows?: typeof saveFlows;
  now?: () => number;
  runtimeClient?: typeof runtimeHostClient;
  terminalizeStaleSpawns?: typeof terminalizeStaleStructuredSpawns;
}

/** Generalizes the issue #652 terminal convergence path. It retains the
    settled-migration predicate for uncertain attempts and also stops an intent
    whose progress bound expired or whose requested delivery lost its source
    owner. Every affected reservation becomes a durable failed record with an
    actionable cancellation reason. */
function migrationSourceHasLiveOwner(
  snapshot: RegistryFile,
  conversation: RegistryConversation,
  probe: LivenessProbe,
): boolean {
  const migration = conversation.migration;
  if (!migration) return false;
  const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId);
  if (!source) return false;
  if (identityAlive(source.host?.tmuxHost?.agent, probe)) return true;
  if (Object.values(snapshot.entries).some((entry) =>
    entry.key.engine === conversation.engine
    && entry.artifactPath === source.path
    && entryIsLive(entry, probe))) return true;
  return registryRowsMatching(snapshot, "receipts", "conversationId", conversation.id).some((receipt) =>
    receipt.engine === conversation.engine
    && receipt.conversationId === conversation.id
    && receiptIsLive(snapshot, receipt, probe));
}

/* The hygiene pass needs two identity fields of every conversation and held
   delivery. Read through a projection, an archived row is parsed once for the
   life of the store; enumerating the rows themselves parsed the whole archive
   again for every migration intent on every pass. */
const MIGRATION_OWNERSHIP: RegistryRowProjector<"conversations", { id: RegistryConversation["id"]; intentId: string } | null> = {
  id: "reaper-migration-ownership-v1", collection: "conversations",
  project: conversation => conversation.migration ? { id: conversation.id, intentId: conversation.migration.intentId } : null,
};
const UNSETTLED_DELIVERIES: RegistryRowProjector<"heldDeliveries", { id: string; conversationId: string } | null> = {
  id: "reaper-unsettled-deliveries-v1", collection: "heldDeliveries",
  project: delivery => ["held", "assigned", "delivery-uncertain"].includes(delivery.state)
    ? { id: delivery.id, conversationId: delivery.conversationId } : null,
};

/** One reading of who owns what, shared by every intent of a hygiene pass. */
function migrationHygieneIndex(snapshot: RegistryFile): {
  ownedBy: (intentId: string) => RegistryConversation[];
  unsettledDeliveryIds: (conversationIds: ReadonlySet<string>) => string[];
} {
  const ownedIds = new Map<string, RegistryConversation["id"][]>();
  for (const [, owned] of registryRowProjection(snapshot, MIGRATION_OWNERSHIP)) {
    if (!owned) continue;
    const ids = ownedIds.get(owned.intentId);
    if (ids) ids.push(owned.id); else ownedIds.set(owned.intentId, [owned.id]);
  }
  const unsettled = registryRowProjection(snapshot, UNSETTLED_DELIVERIES)
    .flatMap(([, delivery]) => delivery ? [delivery] : []);
  return {
    ownedBy: (intentId) => (ownedIds.get(intentId) ?? [])
      .flatMap((id) => { const conversation = snapshot.conversations[id]; return conversation ? [conversation] : []; }),
    unsettledDeliveryIds: (conversationIds) => conversationIds.size
      ? unsettled.filter((delivery) => conversationIds.has(delivery.conversationId)).map((delivery) => delivery.id) : [],
  };
}

/**
 * The hygiene the inventory sidecar runs over accepted sends. Every write
 * waits for the registry lock off the loop (docs/design/
 * delivery-progress-and-drain.md, C4): the sidecar drains held sends too, so
 * a wait here would hold its own lanes. A write the lock refused leaves its
 * row for the next cycle; a refused ending skips its conversation's rollback,
 * so the pair stays together.
 */
export async function terminalizeStaleUndeliverableHeldDeliveries(
  registry: AgentRegistry,
  now: number = Date.now(),
  liveness: AccountLivenessOptions = {},
): Promise<string[]> {
  const snapshot = registry.readOnlySnapshot();
  const offLoop = async <T>(label: string, id: string | null, write: () => T): Promise<{ value: T } | null> => {
    const operationId = id ? snapshot.heldDeliveries[id]?.command.operationId ?? null : null;
    const written = await registry.deliveryWrite({ label, operationId }, write);
    return written.acquired ? { value: written.value } : null;
  };
  const probe = livenessProbe({ ...liveness, now: () => now });
  const terminalized = new Set<string>();
  for (const id of staleUndeliverableHeldDeliveryIds(snapshot, { ...liveness, now: () => now })) {
    const expected = snapshot.heldDeliveries[id]!;
    const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeStaleUndeliverableHeldDelivery(
      expected, { ...liveness, now: () => now },
    ));
    if (settled?.value?.state === "failed") terminalized.add(id);
  }
  const index = migrationHygieneIndex(snapshot);
  for (const intent of Object.values(snapshot.migrationIntents)) {
    const owned = index.ownedBy(intent.id);
    const ids = index.unsettledDeliveryIds(new Set(owned.map((conversation) => conversation.id)));
    /* A rolled-back migration owns only deliveries whose latest admission was
       inside its drain window (#972). A resend can reuse an older reservation,
       so `createdAt` alone does not prove ownership. */
    const rolledBackConversationIds = new Set<RegistryConversation["id"]>();
    for (const conversation of owned) {
      if (conversation.migration?.phase !== "rolled-back") continue;
      rolledBackConversationIds.add(conversation.id);
    }
    let activeIds: string[] = [];
    for (const id of ids) {
      const delivery = snapshot.heldDeliveries[id];
      if (!delivery || !rolledBackConversationIds.has(delivery.conversationId)) {
        activeIds.push(id);
        continue;
      }
      const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeRolledBackMigrationDelivery(
        id,
        intent.id,
        ROLLED_BACK_MIGRATION_DELIVERY_REASON,
      ));
      if (!settled?.value) {
        activeIds.push(id);
        continue;
      }
      terminalized.add(id);
    }
    /* Once its intent is settled and its owned deliveries are terminal, the
       rolled-back block is spent residue: clearing it here disarms every later
       hygiene pass that would otherwise keep matching this conversation. A
       still-draining intent keeps the block so the drain's own bookkeeping
       (progress accounting, per-conversation opt-out) stays intact; the
       atomic ownership fence above already protects new messages meanwhile. */
    if (intent.state !== "draining") {
      for (const conversationId of rolledBackConversationIds) {
        await offLoop("migration.rollback", null, () => registry.clearRolledBackConversationMigration(conversationId, intent.id));
      }
      continue;
    }
    const deliveryConversationIds = new Set(activeIds.map((id) =>
      snapshot.heldDeliveries[id]?.conversationId).filter((id): id is RegistryConversation["id"] => Boolean(id)));
    const noProgress = migrationIntentIsStale(snapshot, intent, now);
    if (!noProgress) {
      for (const conversation of owned) {
        if (conversation.migration?.phase !== "requested"
          || !deliveryConversationIds.has(conversation.id)
          || migrationSourceHasLiveOwner(snapshot, conversation, probe)) continue;
        const reason = `delivery cancelled because source conversation ${conversation.id} has no live owner; send again to authorize a fresh delivery`;
        let refused = false;
        for (const id of activeIds) {
          if (snapshot.heldDeliveries[id]?.conversationId !== conversation.id) continue;
          const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeHeldDelivery(id, reason));
          if (!settled) { refused = true; continue; }
          if (settled.value.state === "failed") terminalized.add(id);
        }
        if (refused) continue;
        const revision = conversation.migration.revision;
        await offLoop("migration.rollback", null, () => registry.rollbackConversationMigration(conversation.id, revision));
        activeIds = activeIds.filter((id) => snapshot.heldDeliveries[id]?.conversationId !== conversation.id);
      }
    }
    if (!noProgress) continue;
    const reason =
      `delivery cancelled because its owning account migration made no progress for ${MIGRATION_INTENT_PROGRESS_TIMEOUT_MS}ms; send again to authorize a fresh delivery`;
    if (!await offLoop("migration.stop", null, () => registry.setMigrationIntentState(intent.id, "stopped", intent.revision, reason))) continue;
    const settledSnapshot = registry.readOnlySnapshot();
    for (const id of activeIds) {
      if (settledSnapshot.heldDeliveries[id]?.state === "failed") terminalized.add(id);
    }
  }
  return [...terminalized];
}

/**
 * A registry row written while agents ran in terminal panes can still name a
 * pane as its host. The pane census that used to clear such rows is gone, so
 * the recorded agent process decides: a row whose agent no longer runs under
 * its recorded start identity becomes unhosted. No terminal multiplexer is
 * asked; a row whose process is still alive is left as it is.
 */
export async function retireDeadPaneHostRows(
  registry: Pick<AgentRegistry, "transcriptHostReconciliationRows" | "deliveryWrite" | "markUnhosted">,
  processIdentity: (pid: number) => string | null = (pid) => procBackend.processIdentity(pid),
  pidAlive: (pid: number) => boolean = (pid) => procBackend.pidAlive(pid),
): Promise<number> {
  const agentGone = (entry: { host: { agent: { pid: number; startIdentity: string | null } } | null }) => {
    const agent = entry.host?.agent;
    if (!agent) return false;
    return agent.startIdentity === null ? !pidAlive(agent.pid) : processIdentity(agent.pid) !== agent.startIdentity;
  };
  const dead = registry.transcriptHostReconciliationRows([], []).hostedEntries.filter(([, entry]) => agentGone(entry));
  if (dead.length === 0) return 0;
  const written = await registry.deliveryWrite({ label: "registry.markUnhosted" }, () => {
    let retired = 0;
    const current = new Map(registry.transcriptHostReconciliationRows([], []).hostedEntries);
    for (const [id] of dead) {
      const entry = current.get(id);
      if (!entry || !agentGone(entry)) continue;
      registry.markUnhosted(entry.key);
      retired += 1;
    }
    return retired;
  });
  return written.acquired ? written.value : 0;
}

export async function runReaperCycle(options: {
  registry?: AgentRegistry;
  files: FileEntry[];
  now?: number;
  actuation?: ReaperActuationOverrides;
}): Promise<ReaperReport> {
  const registry = options.registry ?? agentRegistry();
  const now = options.now ?? Date.now();
  /* Stale undeliverable held-delivery convergence (#652): a delivery-uncertain
     attempt whose owning migration has settled and whose conversation has no
     live host/receipt can never resolve, yet it keeps counting as an owed turn
     and blocks account removal forever. The reaper cycle terminalizes exactly
     what `conversationIsLive` has already stopped counting as live, so the
     registry stops carrying it as owed. Registry hygiene, never a process kill,
     so it runs regardless of `LLV_REAPER_ENABLED`; failure never blocks the
     reaper. */
  try {
    await terminalizeStaleUndeliverableHeldDeliveries(registry, now, {});
  } catch (error) {
    console.error("[reaper] stale undeliverable held-delivery convergence failed", error);
  }
  /* Durable launch/delivery convergence (#653/#922): reconcile either ordering
     of a terminal launch and its never-attempted initial delivery, including
     historical migration cancellations and promote-race assignments. Ambiguous
     attempted deliveries remain untouched. Pure registry mutation, independent
     of the runtime client, byte-stable when there is nothing to do. */
  try {
    /* Off the loop; refused, the next cycle converges it (C4). */
    if (registry.failedSpawnDeliveryCandidates()) {
      await registry.deliveryWrite({ label: "delivery.hygiene" }, () => registry.terminalizeFailedSpawnDeliveriesNow());
    }
  } catch (error) {
    console.error("[reaper] failed-spawn held-delivery convergence failed", error);
  }
  /* Completed structured conversations can retain a live Viewer writer claim
     after their recorded engine child exits without cleanup. Revalidate only
     those recorded PIDs and available start identities, then clear dead rows
     without signalling any process so ordinary recovery can claim them again. */
  try {
    await reconcileDeadStructuredRegistryHostsOffLoop(registry);
  } catch (error) {
    console.error("[reaper] dead structured-host ownership convergence failed", error);
  }
  try {
    await retireDeadPaneHostRows(registry);
  } catch (error) {
    console.error("[reaper] dead pane-host row convergence failed", error);
  }
  /* Stale launch convergence (#334/#926): the reaper cycle is the while-running
     seam that turns dead-evidence pending receipts terminal and actuates due
     queued pins. Structured receipts wait for their required client. The pass
     is bounded and idempotent; its failure never blocks the reaper. */
  try {
    const inventorySidecar = process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER === "1";
    const hasSpawnWork = !inventorySidecar || registry.openSpawnReceipts().length > 0
      // A starting entry is never archived, so the liveness rows hold every one.
      || registryLivenessRows(registry.readOnlySnapshot()).entries.some(entry => entry.status === "starting");
    if (hasSpawnWork) {
      const runtimeClientForSpawns = (options.actuation?.runtimeClient ?? runtimeHostClient)();
      await (options.actuation?.terminalizeStaleSpawns ?? terminalizeStaleStructuredSpawns)(registry, runtimeClientForSpawns, {
        // The sidecar never activates the serving release, including after a
        // restart. Its pending launches still converge without owner backfill.
        repairFailures: !inventorySidecar,
      });
    }
  } catch (error) {
    console.error("[reaper] stale structured spawn convergence failed", error);
  }
  try {
    await registry.deliveryWrite({ label: "registry.archive" }, () => registry.archiveInactiveRows());
  } catch (error) {
    console.error("[reaper] registry archive convergence failed",error);
  }
  const state = updateObservationState();
  const report = evaluateReaper(await makeInput(registry, options.files, state, now, options.actuation));
  const completed = await runEvaluatedReaper(report, {
    actuate: (agent) => actuateCandidate(registry, options.files, state, agent, options.actuation),
    journal: appendJournal,
  });
  writeJsonDurably(REPORT_FILE(), completed);
  return completed;
}

export function readReaperReport(): ReaperReport | null {
  const parsed = readJsonCache(REPORT_FILE()) as ReaperReport | undefined;
  return parsed && typeof parsed === "object" && Array.isArray(parsed.agents) ? parsed : null;
}
