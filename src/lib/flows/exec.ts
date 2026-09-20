import fs from "node:fs";
import path from "node:path";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import type { FlowEngine, RoleConfig, Round } from "./types";
import { outputPathFor, stderrPathFor, stdoutPathFor } from "@/lib/reviewHistory/artifacts";
import {
  DEFAULT_TIMEOUT_MS, headlessRuns as runs, pidAlive, processMatches, killTree,
  refreshRunIdentity, killOwnedRun, launchDetached, readOptional, reviewerCommand,
  scanEventStream, terminateHeadlessReviewerGroupAndWait,
  type HeadlessRunResult, type HeadlessCodexAccount, type HeadlessClaudeAccount, type HeadlessReviewRuntime,
} from "@/lib/agent/headless";

/** Temporary compatibility exports during flow retirement. */
export {
  runHeadlessCodexOnce, reviewerCommand, scanEventStream,
  terminateHeadlessReviewerGroup, terminateHeadlessReviewerGroupAndWait,
  type HeadlessRunResult, type HeadlessCodexAccount, type HeadlessClaudeAccount,
  type HeadlessReviewRuntime, type HeadlessCodexRunRequest, type BuiltHeadlessCommand,
} from "@/lib/agent/headless";

export interface HeadlessReviewLaunch {
  pid: number | null;
  identity: string | null;
  sessionId: string | null;
  reviewerPath: string | null;
}

function runKey(flowId: string, round: number): string {
  return `${flowId}:${round}`;
}

export function startHeadlessReview(
  flowId: string,
  round: number,
  role: RoleConfig,
  cwd: string,
  reviewRequest: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  codexAccount?: HeadlessCodexAccount | null,
  claudeAccount?: HeadlessClaudeAccount | null,
  runtime?: HeadlessReviewRuntime,
  spawnCapability?: string,
  sandbox: "bypass" | "read-only" = "bypass",
): HeadlessReviewLaunch {
  const key = runKey(flowId, round);
  const idle: HeadlessReviewLaunch = { pid: null, identity: null, sessionId: null, reviewerPath: null };
  if (runs.has(key)) return idle;
  const outputPath = outputPathFor(flowId, round);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  clearHeadlessReviewArtifacts(flowId, round);
  const built = reviewerCommand(role, reviewRequest, outputPath, cwd, codexAccount, claudeAccount, spawnCapability, { sandbox });
  let completionSignaled = false;
  const signalCompletion = () => {
    if (completionSignaled) return;
    completionSignaled = true;
    requestPipelineTick();
  };
  const launched = launchDetached({
    key,
    built,
    cwd,
    stdoutPath: stdoutPathFor(flowId, round),
    stderrPath: stderrPathFor(flowId, round),
    timeoutMs,
    runtime,
    onExit: signalCompletion,
  });
  if (!launched) return idle;
  return { pid: launched.pid, identity: launched.identity, sessionId: built.sessionId, reviewerPath: built.reviewerPath };
}

/** Removes attempt-scoped process output before a logical round is relaunched. */
export function clearHeadlessReviewArtifacts(flowId: string, round: number): void {
  for (const artifact of [outputPathFor(flowId, round), stdoutPathFor(flowId, round), stderrPathFor(flowId, round)]) {
    fs.rmSync(artifact, { force: true });
  }
}

/**
 * Reviewer run state derived from the round's persisted pid plus the on-disk
 * artifacts, with the in-memory record only sharpening the exit code. This is
 * the restart seam: after the viewer reboots the `runs` map is empty, but the
 * detached reviewer keeps running and this function still reports it
 * faithfully — running while the pid is alive, done once the last-message
 * artifact (codex) or captured stdout (claude) carries the verdict.
 *
 * Returns null only when nothing was ever observed for the round: no live
 * record, no persisted pid, no stdout artifact.
 */
export function headlessReviewStatus(
  flowId: string,
  round: number,
  persisted: Pick<Round, "reviewerPid" | "reviewerIdentity" | "spawnStartedAt">,
  engine: FlowEngine,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): HeadlessRunResult | null {
  const run = runs.get(runKey(flowId, round));
  const stdout = readOptional(stdoutPathFor(flowId, round));
  const pid = run?.child.pid ?? persisted.reviewerPid ?? null;
  if (run && pid && !run.identity && pidAlive(pid)) refreshRunIdentity(run, pid);
  const identity = run?.identity ?? persisted.reviewerIdentity ?? null;
  const stderr = readOptional(stderrPathFor(flowId, round));
  const scanned = scanEventStream(stdout);
  const outputPath = engine === "codex" ? outputPathFor(flowId, round) : null;
  const artifactOutput = readOptional(outputPath).trim();
  if (!run && pid === null && !stdout && !stderr && !artifactOutput && !persisted.spawnStartedAt) return null;
  const startedAt = run?.startedAt ?? Date.parse(persisted.spawnStartedAt ?? "");
  const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const finalOutput = artifactOutput || scanned.lastAgentMessage || (engine === "claude" ? stdout.trim() : "");
  /* Codex writes --output-last-message only when the turn completes. Launch
     cleanup removes stale copies before every attempt, so a populated artifact
     is conclusive even when restart recovery cannot prove pid ownership. */
  if (artifactOutput) {
    return { status: "done", stdout, stderr, finalOutput, sessionId: scanned.sessionId, processIdentity: identity, code: run?.exit?.code ?? null, signal: run?.exit?.signal ?? null };
  }
  /* A restart loses the ChildProcess handle. When the pid is still live and its
     start identity was never checkpointed, ownership cannot be reconstructed
     safely: the pid may belong to the reviewer or may have been reused. Park
     this round before interim stdout can make it look completed and retryable. */
  if (!run && pid !== null && !identity && pidAlive(pid)) {
    return { status: "lost", stdout, stderr, finalOutput, sessionId: scanned.sessionId, processIdentity: null, code: null, signal: null };
  }
  /* The in-memory ChildProcess handle is authoritative until its close/error
     event. A null identity here is a transient /proc race, so it cannot turn a
     running reviewer into a completed no-verdict attempt. */
  const alive = run ? run.exit === null && pidAlive(pid) : processMatches(pid, identity);
  if (alive) {
    /* Re-arm the timeout across restarts: the in-memory timer died with the
       old process, so the reconstruction path enforces the budget itself. */
    if (!run && elapsed >= timeoutMs && pid) killTree(pid, identity);
    return { status: "running", stdout, stderr, finalOutput: "", sessionId: scanned.sessionId, processIdentity: identity, code: null, signal: null };
  }
  /* A persisted launch with no owned process handle can still belong to a live
     reviewer whose pid checkpoint was lost. Only a completed last-message
     artifact proves Codex exited; interim stdout must never authorize retry. */
  if (!run && pid === null && !artifactOutput) {
    return { status: "lost", stdout, stderr, finalOutput, sessionId: scanned.sessionId, processIdentity: identity, code: null, signal: null };
  }
  const exit = run?.exit ?? null;
  const timedOut = !finalOutput && elapsed >= timeoutMs;
  const status: HeadlessRunResult["status"] =
    exit?.code === 0 || finalOutput ? "done" : timedOut ? "timeout" : "failed";
  return { status, stdout, stderr, finalOutput, sessionId: scanned.sessionId, processIdentity: identity, code: exit?.code ?? null, signal: exit?.signal ?? null };
}

export function forgetHeadlessReview(
  flowId: string,
  round: number,
  persisted: Pick<Round, "reviewerPid" | "reviewerIdentity"> = { reviewerPid: null, reviewerIdentity: null },
): void {
  const key = runKey(flowId, round);
  const run = runs.get(key);
  runs.delete(key);
  const pid = run?.child.pid ?? persisted.reviewerPid ?? null;
  const identity = run?.identity ?? persisted.reviewerIdentity ?? null;
  if (run) clearTimeout(run.timer);
  if (run) {
    killOwnedRun(run);
    return;
  }
  if (pid) {
    killTree(pid, identity);
    return;
  }
}

/** Removes a headless run only after its process group has been observed dead. */
export async function stopHeadlessReviewAndWait(
  flowId: string,
  round: number,
  persisted: Pick<Round, "reviewerPid" | "reviewerIdentity"> = { reviewerPid: null, reviewerIdentity: null },
): Promise<boolean> {
  const key = runKey(flowId, round);
  const run = runs.get(key);
  const pid = run?.child.pid ?? persisted.reviewerPid ?? null;
  const identity = run?.identity ?? persisted.reviewerIdentity ?? null;
  if (!pid) {
    runs.delete(key);
    return true;
  }
  if (run) {
    clearTimeout(run.timer);
    run.terminationStarted = true;
  }
  const stopped = await terminateHeadlessReviewerGroupAndWait(pid, identity, {
    ownedByLiveHandle: Boolean(run),
    leaderExited: run?.exit !== null,
    fallbackLeader: run ? (signal) => { run.child.kill(signal); } : undefined,
  });
  if (stopped) runs.delete(key);
  return stopped;
}
