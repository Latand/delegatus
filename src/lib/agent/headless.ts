import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "@/lib/agent/cli";
import { claudeManagedEnvironment, claudeSettingsPath } from "@/lib/accounts/claude";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { applyClaudeSpawnPolicy, fenceViewerSpawnPrompt } from "@/lib/agent/spawnPolicy";
import { procBackend } from "@/lib/proc";
import { STATE_OWNER_ENV } from "@/lib/stateOwnership";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { RuntimeRoleConfig as RoleConfig } from "./runtimeConfig";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface HeadlessRunResult {
  status: "running" | "done" | "failed" | "timeout" | "lost";
  stdout: string;
  stderr: string;
  finalOutput: string;
  /** Session/thread id parsed from the run's `--json` event stream. */
  sessionId: string | null;
  /** Refreshed process start identity, persisted by the engine once /proc is ready. */
  processIdentity: string | null;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HeadlessCodexAccount {
  home: string;
  managed: boolean;
}
export interface HeadlessClaudeAccount { home: string; projectsDir: string; managed: boolean; }
export interface HeadlessReviewRuntime {
  command?: string;
  /** Test seam for the brief spawn-to-/proc visibility race. */
  processIdentity?: (pid: number) => string | null;
}

/* The reviewer runs detached with file-backed stdio, so it survives a viewer
   restart. This in-memory record only adds what disk cannot know: the exact
   exit code and the in-process timeout timer. Everything in
   headlessReviewStatus must stay derivable from the round + artifacts alone. */
export interface LiveRun {
  child: ChildProcess;
  identity: string | null;
  identityOf: (pid: number) => string | null;
  startedAt: number;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  terminationStarted: boolean;
  timer: NodeJS.Timeout;
}

export const headlessRuns = new Map<string, LiveRun>();

function reviewerEnvironment(base: NodeJS.ProcessEnv, spawnCapability?: string): NodeJS.ProcessEnv {
  const env = withoutWakatimeCredential(base);
  delete env.LLV_TOKEN;
  /* A headless reviewer is no owner of the operator's state. The Viewer's own
     claim (the image sets it for the whole container) used to ride along, so a
     reviewer's `NODE_ENV=test bun -e` fixture resolved the live task store and
     minted two placeholder tasks there. The Viewer MCP server claims its own
     owner at its entry point, so nothing the reviewer needs is lost. */
  delete env[STATE_OWNER_ENV];
  if (spawnCapability) env.LLV_SPAWN_CAPABILITY = spawnCapability;
  return env;
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processMatches(pid: number | null | undefined, identity: string | null | undefined): pid is number {
  return Boolean(pid && identity && pidAlive(pid) && procBackend.processIdentity(pid) === identity);
}

interface HeadlessProcessGroupRuntime {
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
}

interface HeadlessProcessGroupWaitRuntime extends HeadlessProcessGroupRuntime {
  processGroupAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
}

const defaultProcessGroupRuntime: HeadlessProcessGroupRuntime = {
  pidAlive,
  processIdentity: (pid) => procBackend.processIdentity(pid),
  signalProcess: (pid, signal) => { process.kill(pid, signal); },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
};

const defaultProcessGroupWaitRuntime: HeadlessProcessGroupWaitRuntime = {
  ...defaultProcessGroupRuntime,
  processGroupAlive: (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  wait: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Preserves the owned process-group id through the TERM-to-KILL grace period. */
export function terminateHeadlessReviewerGroup(
  pid: number,
  identity: string | null,
  options: {
    ownedByLiveHandle?: boolean;
    leaderExited?: boolean;
    graceMs?: number;
    fallbackLeader?: (signal: NodeJS.Signals) => void;
    runtime?: Partial<HeadlessProcessGroupRuntime>;
  } = {},
): void {
  const runtime = { ...defaultProcessGroupRuntime, ...options.runtime };
  const owned = options.ownedByLiveHandle === true
    || Boolean(identity && runtime.pidAlive(pid) && runtime.processIdentity(pid) === identity);
  if (!owned) return;
  try {
    runtime.signalProcess(-pid, "SIGTERM");
  } catch {
    if (!options.leaderExited) {
      try { (options.fallbackLeader ?? ((signal) => runtime.signalProcess(pid, signal)))("SIGTERM"); }
      catch { /* group leader has exited */ }
    }
  }
  const timer = runtime.setTimeout(() => {
    try { runtime.signalProcess(-pid, "SIGKILL"); }
    catch { /* process group has exited */ }
  }, options.graceMs ?? 3_000);
  timer.unref?.();
}

/** Stops an owned reviewer group and resolves only after the whole group is
    gone. The bounded KILL phase lets callers safely mutate its worktree. */
export async function terminateHeadlessReviewerGroupAndWait(
  pid: number,
  identity: string | null,
  options: {
    ownedByLiveHandle?: boolean;
    leaderExited?: boolean;
    graceMs?: number;
    killWaitMs?: number;
    pollMs?: number;
    fallbackLeader?: (signal: NodeJS.Signals) => void;
    runtime?: Partial<HeadlessProcessGroupWaitRuntime>;
  } = {},
): Promise<boolean> {
  const runtime = { ...defaultProcessGroupWaitRuntime, ...options.runtime };
  const owned = options.ownedByLiveHandle === true
    || Boolean(identity && runtime.pidAlive(pid) && runtime.processIdentity(pid) === identity);
  if (!owned) return !runtime.processGroupAlive(pid);

  const signal = (value: NodeJS.Signals): void => {
    try {
      runtime.signalProcess(-pid, value);
    } catch {
      if (!options.leaderExited) {
        try { (options.fallbackLeader ?? ((fallback) => runtime.signalProcess(pid, fallback)))(value); }
        catch { /* process group has exited */ }
      }
    }
  };
  const waitUntilGone = async (timeoutMs: number): Promise<boolean> => {
    const pollMs = Math.max(1, options.pollMs ?? 25);
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!runtime.processGroupAlive(pid)) return true;
      await runtime.wait(pollMs);
    }
    return !runtime.processGroupAlive(pid);
  };

  signal("SIGTERM");
  if (await waitUntilGone(options.graceMs ?? 3_000)) return true;
  signal("SIGKILL");
  return await waitUntilGone(options.killWaitMs ?? 1_000);
}

/** SIGTERM the reviewer's process group (detached spawn = group leader),
    escalating to SIGKILL; falls back to the single pid when no group exists. */
export function killTree(pid: number, identity: string | null, escalateMs = 3_000): void {
  terminateHeadlessReviewerGroup(pid, identity, { graceMs: escalateMs });
}

export function refreshRunIdentity(run: LiveRun, pid: number): string | null {
  if (run.identity) return run.identity;
  run.identity = run.identityOf(pid);
  return run.identity;
}

/** A live ChildProcess handle proves ownership during the short interval
    before Linux exposes a stable process start identity. */
export function killOwnedRun(run: LiveRun): void {
  const pid = run.child.pid;
  if (!pid || run.terminationStarted) return;
  run.terminationStarted = true;
  terminateHeadlessReviewerGroup(pid, null, {
    ownedByLiveHandle: true,
    leaderExited: run.exit !== null,
    fallbackLeader: (signal) => { run.child.kill(signal); },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEYS = new Set(["session_id", "sessionId", "thread_id", "threadId", "rollout_id"]);

/** Depth-limited walk for a session/thread id key anywhere in a parsed event. */
function findSessionId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEYS.has(key) && typeof item === "string" && UUID_RE.test(item)) return item;
    const nested = findSessionId(item, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Agent-message text from a `--json` event, across known event shapes. */
function agentMessageOf(event: Record<string, unknown>): string | null {
  const item = event.item as Record<string, unknown> | undefined;
  if (item && (item.type === "agent_message" || item.item_type === "agent_message") && typeof item.text === "string") {
    return item.text;
  }
  const msg = event.msg as Record<string, unknown> | undefined;
  if (msg?.type === "agent_message" && typeof msg.message === "string") return msg.message;
  return null;
}

/** Session id + last agent message from a captured `--json` stdout stream. */
export function scanEventStream(stdout: string): { sessionId: string | null; lastAgentMessage: string } {
  let sessionId: string | null = null;
  let lastAgentMessage = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (!sessionId) sessionId = findSessionId(event);
      const message = agentMessageOf(event);
      if (message) lastAgentMessage = message;
    } catch {
      /* partial or non-JSON line — ignore */
    }
  }
  return { sessionId, lastAgentMessage };
}

export interface BuiltHeadlessCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string | null;
  outputPath: string | null;
  sessionId: string | null;
  reviewerPath: string | null;
}

export function reviewerCommand(
  role: RoleConfig,
  reviewRequest: string,
  outputPath: string,
  cwd: string,
  codexAccount?: HeadlessCodexAccount | null,
  claudeAccount?: HeadlessClaudeAccount | null,
  spawnCapability?: string,
  /* Reviewers need approval-free command access; one-shot summarizers read
     nothing but their prompt and run outside any repository. */
  options: { sandbox?: "bypass" | "read-only" } = {},
): BuiltHeadlessCommand {
  if (role.engine === "claude") {
    const sessionId = crypto.randomUUID();
    /* Headless reviewers need approval-free command access for tests, builds,
       linters, and local diagnostics. The read-only rule lives in the prompt. */
    const args = [
      "-p",
      reviewRequest,
      ...(options.sandbox === "read-only"
        ? ["--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit"]
        : ["--dangerously-skip-permissions"]),
      "--session-id",
      sessionId,
    ];
    if (role.model) args.push("--model", role.model);
    if (role.effort) args.push("--effort", role.effort);
    const settings = claudeAccount
      ? applyClaudeSpawnPolicy(claudeAccount.home, {
        baseSettingsPath: claudeAccount.managed ? claudeSettingsPath() : null,
        profileId: `headless-${sessionId}`,
      }).settingsPath
      : null;
    if (settings) args.push("--settings", settings);
    const baseEnv = claudeAccount?.managed ? claudeManagedEnvironment(claudeAccount.home) : process.env;
    return { command: resolveBinary("claude"), args, env: reviewerEnvironment(baseEnv, spawnCapability), stdin: null, outputPath: null, sessionId, reviewerPath: claudeTranscriptPath(cwd, sessionId, claudeAccount?.projectsDir) };
  }
  /* --json turns stdout into a JSONL event stream whose first events carry
     the session/thread id — a structured contract instead of parsing the
     human banner. The verdict itself still arrives via --output-last-message. */
  const args = ["--disable", "multi_agent", "exec", "--ignore-user-config", "-", "--json", "--output-last-message", outputPath,
    ...(options.sandbox === "read-only" ? ["-s", "read-only", "--skip-git-repo-check"] : ["--dangerously-bypass-approvals-and-sandbox"])];
  if (codexAccount?.managed) args.unshift("-c", "cli_auth_credentials_store=file");
  if (role.model) args.push("-m", role.model);
  if (role.effort) args.push("-c", `model_reasoning_effort=${role.effort}`);
  return {
    command: resolveBinary("codex"),
    args,
    env: reviewerEnvironment(
      codexAccount?.home
        ? { ...withoutWakatimeCredential(process.env), CODEX_HOME: codexAccount.home }
        : process.env,
      spawnCapability,
    ),
    stdin: fenceViewerSpawnPrompt("codex", reviewRequest),
    outputPath,
    sessionId: null,
    reviewerPath: null,
  };
}

/**
 * Detached + file-backed stdio: the child must not die with the viewer. A plain
 * child shares the dev server's process group, so Ctrl+C on the server delivers
 * SIGINT to it too; detached makes it a group leader and the log files replace
 * the pipes we can no longer hold. The timeout kills the whole group, and the
 * `runs` map keeps exactly what disk cannot know — the exit code and the timer.
 *
 * Returns null when `key` already has a live run, which is the caller's
 * duplicate-launch guard.
 */
export function launchDetached(input: {
  key: string;
  built: BuiltHeadlessCommand;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  runtime?: HeadlessReviewRuntime;
  onTimeout?: () => void;
  onExit: (run: LiveRun) => void;
}): { pid: number | null; identity: string | null } | null {
  if (headlessRuns.has(input.key)) return null;
  const stdoutFd = fs.openSync(input.stdoutPath, "w");
  const stderrFd = fs.openSync(input.stderrPath, "w");
  let child: ChildProcess;
  try {
    child = spawn(input.runtime?.command ?? input.built.command, input.built.args, {
      cwd: input.cwd,
      env: input.built.env,
      detached: true,
      stdio: [input.built.stdin === null ? "ignore" : "pipe", stdoutFd, stderrFd],
    });
    if (input.built.stdin !== null && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input.built.stdin, "utf8");
    }
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();
  const identityOf = input.runtime?.processIdentity ?? procBackend.processIdentity;
  const identity = child.pid ? identityOf(child.pid) : null;
  const run: LiveRun = {
    child,
    identity,
    identityOf,
    startedAt: Date.now(),
    exit: null,
    terminationStarted: false,
    timer: setTimeout(() => {
      input.onTimeout?.();
      killOwnedRun(run);
    }, input.timeoutMs),
  };
  run.timer.unref();
  headlessRuns.set(input.key, run);
  child.on("error", () => {
    clearTimeout(run.timer);
    run.exit = { code: null, signal: null };
    killOwnedRun(run);
    input.onExit(run);
  });
  child.on("close", (code, signal) => {
    clearTimeout(run.timer);
    run.exit = { code, signal };
    killOwnedRun(run);
    input.onExit(run);
  });
  return { pid: child.pid ?? null, identity };
}

export interface HeadlessCodexRunRequest {
  /** `runs` map key; a duplicate while a run is live resolves `failed`. */
  key: string;
  /** The child's working directory, created if it does not exist. */
  cwd: string;
  ["prompt"]: string;
  model: string | null;
  effort: string | null;
  account: HeadlessCodexAccount | null;
  /** stdout.log, stderr.txt and last-message.md are written here. */
  artifactDir: string;
  timeoutMs: number;
  sandbox: "bypass" | "read-only";
  runtime?: HeadlessReviewRuntime;
}

/**
 * One bounded Codex turn for a caller that wants the answer rather than a
 * flow round: same command shape, same detached process group, same timeout
 * kill, resolved when the child exits. There is no restart seam on purpose —
 * a request that dies with the server has nobody to hand the output to, and
 * the detached child finishes its own turn and exits.
 */
export async function runHeadlessCodexOnce(request: HeadlessCodexRunRequest): Promise<HeadlessRunResult> {
  const outputPath = path.join(request.artifactDir, "last-message.md");
  const stdoutPath = path.join(request.artifactDir, "stdout.log");
  const stderrPath = path.join(request.artifactDir, "stderr.txt");
  fs.mkdirSync(request.artifactDir, { recursive: true });
  fs.mkdirSync(request.cwd, { recursive: true });
  for (const artifact of [outputPath, stdoutPath, stderrPath]) fs.rmSync(artifact, { force: true });
  const built = reviewerCommand(
    { engine: "codex", model: request.model, effort: request.effort },
    request["prompt"],
    outputPath,
    request.cwd,
    request.account,
    null,
    undefined,
    { sandbox: request.sandbox },
  );
  let timedOut = false;
  return await new Promise<HeadlessRunResult>((resolve) => {
    const settle = (run: LiveRun): void => {
      headlessRuns.delete(request.key);
      const stdout = readOptional(stdoutPath);
      const stderr = readOptional(stderrPath);
      const artifactOutput = readOptional(outputPath).trim();
      const scanned = scanEventStream(stdout);
      const finalOutput = artifactOutput || scanned.lastAgentMessage;
      const exit = run.exit;
      /* THE EXIT OUTRANKS THE ARTIFACT. Codex writes `last-message.md` when
         its turn completes, but a child that wrote it and then died — hung
         until the timer killed its group, exited non-zero, or was signalled —
         did NOT finish: the artifact is whatever it had flushed at the moment
         it went away. Reading that as `done` hands the caller a half-written
         answer and — for the orchestrator handoff digest (issue #1067) —
         silently denies it the deterministic fallback it is entitled to. So a
         clean exit is REQUIRED for `done`, and a timeout keeps its own reason
         because the caller distinguishes the two. */
      const exitedCleanly = exit !== null && exit.code === 0 && exit.signal === null;
      const status: HeadlessRunResult["status"] = timedOut
        ? "timeout"
        : exitedCleanly && (artifactOutput || scanned.lastAgentMessage)
          ? "done"
          : "failed";
      resolve({
        status,
        stdout,
        stderr,
        finalOutput,
        sessionId: scanned.sessionId,
        processIdentity: run.identity,
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
      });
    };
    const launched = launchDetached({
      key: request.key,
      built,
      cwd: request.cwd,
      stdoutPath,
      stderrPath,
      timeoutMs: request.timeoutMs,
      runtime: request.runtime,
      onTimeout: () => { timedOut = true; },
      onExit: settle,
    });
    if (!launched) {
      resolve({ status: "failed", stdout: "", stderr: "", finalOutput: "", sessionId: null, processIdentity: null, code: null, signal: null });
    }
  });
}

export function readOptional(filePath: string | null): string {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
