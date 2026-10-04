import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { pidAlive } from "@/lib/scanner/process";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";

import { setupExitPath, setupStderrPath, setupStdoutPath } from "./store";
import type { Workflow } from "./types";

/**
 * Git/gh/setup actions of a workflow, over an injectable exec port so the
 * state machine tests never touch a real repo (the flows/exec.ts pattern).
 * Only the long-running setup command escapes the port: it runs detached with
 * file-backed artifacts, mirroring headless reviewers, so a viewer restart
 * never loses it.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the process when it had no exit status. */
  signal?: NodeJS.Signals | null;
}

/** Optional environment overrides apply to this child command only. */
export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Latin-1 keeps Git's arbitrary path bytes intact for safety validation. */
  stdoutEncoding?: "utf8" | "latin1";
  /** Publication children retain their owner's kernel lock across a restart. */
  inheritFd?: number;
}

export type ExecPort = (command: string, args: string[], cwd: string, env?: Partial<NodeJS.ProcessEnv>, options?: ExecOptions) => ExecResult | Promise<ExecResult>;

/** Bounded execution shared by Viewer Git and forge calls. Cancellation waits
    for close, including transport children, before ownership can be released. */
export const realExec: ExecPort = (command, args, cwd, env, options = {}) => new Promise((resolve) => {
  if (options.signal?.aborted) { resolve({ code: null, stdout: "", stderr: "command cancelled" }); return; }
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let stopped: string | null = null;
  const child = spawn(command, args, {
    cwd, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", ...(options.inheritFd === undefined ? [] : [options.inheritFd])],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    if (child.pid) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += String(error); }
    }
  };
  const abort = () => stop("command cancelled");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => stop(`command timed out after ${timeoutMs}ms`), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const append = (chunk: string, stream: "stdout" | "stderr") => {
    bytes += Buffer.byteLength(chunk, stream === "stdout" ? options.stdoutEncoding ?? "utf8" : "utf8");
    if (bytes > (options.maxOutputBytes ?? 8 * 1024 * 1024)) { stop("command output exceeded its byte limit"); return; }
    if (stream === "stdout") stdout += chunk;
    else stderr += chunk;
  };
  child.stdout?.setEncoding(options.stdoutEncoding ?? "utf8").on("data", (chunk: string) => append(chunk, "stdout"));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => append(chunk, "stderr"));
  child.on("error", (error) => { stopped ??= error.message; });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve({ code: stopped ? null : code, stdout, stderr: stopped ? `${stopped}${stderr ? `: ${stderr}` : ""}` : stderr, signal });
  });
});

export type ProvisionResult = { ok: true; baseBranch: string; baseRef: string } | { ok: false; error: string };

function failure(step: string, res: ExecResult): { ok: false; error: string } {
  const detail = (res.stderr || res.stdout || "no output").trim();
  return { ok: false, error: `${step}: ${detail}` };
}

/**
 * Creates the sibling worktree on the wf/ branch (W3) and captures the PR/
 * merge target: the repo's current branch and the sha the branch starts at.
 * A retry after an interrupted run adopts an already-created worktree instead
 * of failing on "already exists".
 */
export async function provisionWorktree(wf: Workflow, exec: ExecPort): Promise<ProvisionResult> {
  const head = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], wf.repoDir));
  if (head.code !== 0) return failure("resolving the repo branch", head);
  const baseBranch = head.stdout.trim();
  if (!baseBranch || baseBranch === "HEAD") {
    return { ok: false, error: "the repo checkout is detached; a workflow needs a branch to target" };
  }
  const add = (await exec("git", ["worktree", "add", "-b", wf.branch, wf.worktreeDir, "HEAD"], wf.repoDir));
  if (add.code !== 0) {
    /* The worktree may already exist from a run interrupted mid-provisioning;
       adopt it when its checkout answers, otherwise surface the add error. */
    const probe = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], wf.worktreeDir));
    if (probe.code !== 0 || probe.stdout.trim() !== wf.branch) return failure("git worktree add", add);
  }
  const base = (await exec("git", ["rev-parse", "HEAD"], wf.worktreeDir));
  if (base.code !== 0) return failure("resolving the workflow base ref", base);
  const baseRef = base.stdout.trim();
  if (!baseRef) return { ok: false, error: "git returned an empty base ref" };
  return { ok: true, baseBranch, baseRef };
}

/**
 * Launches the template's setup command detached in the worktree. Stdout and
 * stderr stream to artifact files; the exit code lands in its own file via a
 * shell trailer, so setupStatus stays answerable after a viewer restart when
 * only the persisted pid and the artifacts remain.
 */
export function startSetup(wf: Workflow): { pid: number | null; error?: string } {
  const setup = wf.template.setup;
  if (!setup) return { pid: null, error: "workflow has no setup command" };
  const exitPath = setupExitPath(wf.id);
  fs.mkdirSync(path.dirname(exitPath), { recursive: true });
  fs.rmSync(exitPath, { force: true });
  const stdoutFd = fs.openSync(setupStdoutPath(wf.id), "w");
  const stderrFd = fs.openSync(setupStderrPath(wf.id), "w");
  try {
    /* The command runs in a nested shell fed through the environment: its own
       `exit` cannot skip the trailer that records the code, and the command
       text never gets interpolated into the wrapper script. */
    const child = spawn("sh", ["-c", `sh -c "$LLV_SETUP_CMD"; printf '%s' "$?" > "$LLV_SETUP_EXIT"`], {
      cwd: wf.worktreeDir,
      env: { ...withoutUnsupportedApiCredentials(process.env), LLV_SETUP_CMD: setup, LLV_SETUP_EXIT: exitPath },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
    return { pid: child.pid ?? null };
  } catch (error) {
    return { pid: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

export interface SetupStatus {
  status: "running" | "done" | "failed";
  detail: string;
}

/** Grace after launch during which a setup that is neither exited nor observably
    alive is read as still starting, not interrupted. Two races live in this
    window and both widen under load: a fresh pid can sit between spawn and
    `/proc` visibility, and a just-exited pid can precede its exit-code trailer
    landing. The launch artifact (setup-stdout.log, created the moment the
    process starts) anchors the clock — a genuinely interrupted setup, e.g. one
    seen only after a viewer restart, has a far older artifact and still fails. */
const SETUP_SETTLE_MS = 3_000;

function readOptional(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Age of a file in ms, or null when it is missing/unreadable. */
function fileAgeMs(filePath: string, now: number): number | null {
  try {
    return now - fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/** Setup state from the exit-code artifact first, the pid second — the same
    restart seam headless reviewers use. `now` is injectable for the settle test. */
export function setupStatus(wf: Workflow, now: number = Date.now()): SetupStatus {
  const exitRaw = readOptional(setupExitPath(wf.id)).trim();
  if (exitRaw !== "") {
    if (exitRaw === "0") return { status: "done", detail: "" };
    const stderrTail = readOptional(setupStderrPath(wf.id)).trim().split("\n").slice(-3).join("\n");
    return { status: "failed", detail: `setup exited with code ${exitRaw}${stderrTail ? `: ${stderrTail}` : ""}` };
  }
  if (wf.setupPid != null && pidAlive(wf.setupPid)) return { status: "running", detail: "" };
  /* No exit code and the pid is not observably alive. Right after launch this is
     a spawn/exit race, not a real interruption — keep reporting "running" until
     the launch artifact ages past the settle window. */
  const launchAge = fileAgeMs(setupStdoutPath(wf.id), now);
  if (launchAge !== null && launchAge < SETUP_SETTLE_MS) return { status: "running", detail: "" };
  return { status: "failed", detail: "setup was interrupted before it finished" };
}

export type FinishResult = { ok: true; prUrl: string | null } | { ok: false; error: string; recoveryRequired?: boolean };

/** First line of the task as the PR title, in the repo's usual short form. */
export function prTitle(wf: Workflow): string {
  const line = wf.task.split("\n").map((part) => part.trim()).find(Boolean) ?? wf.name;
  return line.length > 72 ? line.slice(0, 69) + "…" : line;
}

function extractPrUrl(text: string): string | null {
  return text.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
}

/** Push the wf/ branch and open the PR against the captured base branch (W7). */
export async function finishPr(wf: Workflow, body: string, exec: ExecPort): Promise<FinishResult> {
  /* Both writes go out as the Delegatus GitHub App or are refused. */
  const forge = engineForgeWriteEnv();
  const push = (await exec("git", ["push", "-u", "origin", wf.branch], wf.worktreeDir, forge));
  if (push.code !== 0) return failure("git push", push);
  const create = (await exec(
    "gh",
    ["pr", "create", "--title", prTitle(wf), "--body", body, "--base", wf.baseBranch, "--head", wf.branch],
    wf.worktreeDir,
    forge,
  ));
  if (create.code === 0) return { ok: true, prUrl: extractPrUrl(create.stdout) };
  /* A retry after a half-finished round lands here: the PR already exists, so
     recover its URL instead of parking the workflow. */
  if (/already exists/i.test(create.stderr)) {
    const view = (await exec("gh", ["pr", "view", wf.branch, "--json", "url", "--jq", ".url"], wf.worktreeDir));
    if (view.code === 0 && view.stdout.trim()) return { ok: true, prUrl: view.stdout.trim() };
  }
  return failure("gh pr create", create);
}

/** Merge the wf/ branch into the base branch locally, without pushing (W7). */
export async function finishMerge(wf: Workflow, exec: ExecPort, cleanupExec: ExecPort = exec): Promise<FinishResult> {
  const head = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], wf.repoDir));
  if (head.code !== 0) return failure("resolving the repo branch", head);
  const current = head.stdout.trim();
  if (current !== wf.baseBranch) {
    return { ok: false, error: `the repo checkout is on ${current}; check out ${wf.baseBranch} before merging` };
  }
  const before = await exec("git", ["rev-parse", "HEAD"], wf.repoDir);
  const dirty = await exec("git", ["status", "--porcelain"], wf.repoDir);
  const existingMerge = await exec("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], wf.repoDir);
  if (before.code !== 0 || dirty.code !== 0 || dirty.stdout.trim() || existingMerge.code !== 1) {
    return { ok: false, error: "the repo checkout is dirty or already merging; inspect it before finishing this workflow" };
  }
  const originalHead = before.stdout.trim();
  const target = await exec("git", ["rev-parse", `${wf.branch}^{commit}`], wf.repoDir);
  if (target.code !== 0 || !/^[0-9a-f]{40}$/i.test(target.stdout.trim())) {
    return { ok: false, error: "resolving the workflow branch head failed; inspect the repo before retrying" };
  }
  const expected = await exec("git", ["merge-tree", "--write-tree", originalHead, target.stdout.trim()], wf.repoDir);
  const expectedTree = expected.code === 0 ? expected.stdout.trim().split("\n")[0] : "";
  if (!/^[0-9a-f]{40}$/i.test(expectedTree)) {
    return { ok: false, error: "the workflow merge could not be previewed safely; inspect the repo before retrying" };
  }
  const merge = (await exec("git", ["merge", "--no-ff", wf.branch, "-m", `Merge ${wf.branch}: ${prTitle(wf)}`], wf.repoDir, controllerCommitIdentityEnv()));
  if (merge.code !== 0) {
    /* A merge can fail after populating the index. Even a fresh ownership
       snapshot cannot make `merge --abort` safe: an operator can stage a
       tracked edit between the snapshot and Git's destructive reset. Leave
       any state Git produced intact and ask for explicit recovery. */
    const [headAfter, mergeHead, status] = await Promise.all([
      cleanupExec("git", ["rev-parse", "HEAD"], wf.repoDir, undefined, { timeoutMs: 5_000 }),
      cleanupExec("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], wf.repoDir, undefined, { timeoutMs: 5_000 }),
      cleanupExec("git", ["status", "--porcelain"], wf.repoDir, undefined, { timeoutMs: 5_000 }),
    ]);
    const safelyUnchanged = headAfter.code === 0 && headAfter.stdout.trim() === originalHead
      && mergeHead.code === 1 && status.code === 0 && !status.stdout.trim();
    if (!safelyUnchanged) {
      return {
        ok: false,
        error: "git merge failed with repository changes or merge state still present; repository recovery is required before retrying",
        recoveryRequired: true,
      };
    }
    return failure("git merge", merge);
  }
  return { ok: true, prUrl: null };
}

export async function runFinish(wf: Workflow, prBody: string, exec: ExecPort, cleanupExec: ExecPort = exec): Promise<FinishResult> {
  /* Review rounds cover uncommitted changes too, while push and merge only
     carry commits — finishing a dirty worktree would publish less than what
     was approved. Park until every approved change is committed. */
  const status = (await exec("git", ["status", "--porcelain"], wf.worktreeDir));
  if (status.code !== 0) return failure("checking the worktree state", status);
  const dirty = status.stdout.split("\n").filter((line) => line.trim());
  if (dirty.length) {
    const names = dirty.slice(0, 3).map((line) => line.slice(3).trim() || line.trim());
    const more = dirty.length > names.length ? `, +${dirty.length - names.length} more` : "";
    return {
      ok: false,
      error: `the worktree has uncommitted changes (${names.join(", ")}${more}) — commit them, then retry the finish`,
    };
  }
  return wf.template.finish === "merge" ? (await finishMerge(wf, exec, cleanupExec)) : (await finishPr(wf, prBody, exec));
}
