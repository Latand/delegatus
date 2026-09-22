/* The update check (#2007): ls-remote (no objects), then, only when the tip
   differs, a fetch into refs/self-update/tip and a local delta. Nothing here
   moves HEAD, a branch or a working tree. The repository may be the
   checkout itself (checkout mode) or a bare repository the Viewer keeps for
   the check (managed mode). */
import { spawn } from "node:child_process";

import { changelogDelta, summarizeDelta } from "./changelog";
import { shortSha, type CheckFailureCode, type CommitLine, type Relation, type Revision, type UpdateDelta } from "./types";

export const TIP_REF = "refs/self-update/tip";
export const CANONICAL_REMOTE = "https://github.com/Latand/live-log-viewer-next.git";

export interface GitResult { code: number; stdout: string; stderr: string }

/** A check failure whose reason is ours to word; the client words it from
    `code`, and the message is for logs and API readers. */
export class CheckError extends Error {
  constructor(readonly code: CheckFailureCode, message: string) {
    super(message);
    this.name = "CheckError";
  }
}

/* Git never prompts: a remote that wants credentials fails the check instead
   of hanging it. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" };

export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...GIT_ENV } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) throw new Error(firstError(result.stderr) || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}

export function firstError(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.startsWith("fatal:")) ?? lines.find((line) => line.startsWith("error:")) ?? lines[0] ?? "";
}

async function showFile(cwd: string, rev: string, path: string): Promise<string | null> {
  const result = await runGit(["show", `${rev}:${path}`], cwd);
  return result.code === 0 ? result.stdout : null;
}

export async function readRevision(repo: string, rev: string): Promise<Revision> {
  const [line, pkg] = await Promise.all([
    git(repo, "log", "-1", "--format=%H%x09%cI", rev),
    showFile(repo, rev, "package.json"),
  ]);
  const [sha = "", date = ""] = line.trim().split("\t");
  let version = "";
  try { version = String((JSON.parse(pkg ?? "{}") as { version?: unknown }).version ?? ""); } catch { /* keeps "" */ }
  return { version, sha, short: shortSha(sha), date };
}

export async function lsRemote(repo: string, remote: string, branch: string): Promise<string> {
  const out = await git(repo, "ls-remote", remote, `refs/heads/${branch}`);
  const sha = out.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new CheckError("no-branch", `The remote has no branch ${branch}`);
  return sha;
}

/* The refspec is forced: a remote that was force-pushed (or a check against
   a different remote) must still move the local ref. */
export async function fetchTip(repo: string, remote: string, branch: string): Promise<void> {
  await git(repo, "fetch", "--no-tags", remote, `+refs/heads/${branch}:${TIP_REF}`);
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return (await runGit(["cat-file", "-e", `${sha}^{commit}`], repo)).code === 0;
}

/** Makes a commit readable: the branch tip is fetched first (it usually
    contains the commit), then the commit itself by SHA. */
export async function ensureCommit(repo: string, remote: string, branch: string, sha: string): Promise<void> {
  if (await hasCommit(repo, sha)) return;
  await fetchTip(repo, remote, branch);
  if (await hasCommit(repo, sha)) return;
  await git(repo, "fetch", "--no-tags", remote, sha);
}

async function count(repo: string, range: string): Promise<number> {
  return Number((await git(repo, "rev-list", "--count", range)).trim());
}

/* Merge commits are left out: a pull request's merge subject names its
   branch, and the commits it brings are listed on their own. Every SHA on
   the surface is spelled with 7 characters; %h would lengthen some. */
async function commitsBetween(repo: string, from: string, to: string): Promise<CommitLine[]> {
  const out = await git(repo, "log", "--no-merges", "--format=%H%x09%s", `${from}..${to}`);
  return out.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { short: shortSha(line), subject: line.slice(tab + 1) };
  });
}

export type CheckOutcome =
  | { ok: true; installed: Revision; available: Revision | null; relation: Relation; ahead: number; behind: number; delta: UpdateDelta | null }
  | { ok: false; error: string; code?: CheckFailureCode; installed: Revision | null };

/** installed: the revision the install runs or will run next; `HEAD` in a
    checkout that was never updated. `fetchInstalled` lets a bare check
    repository learn it from the remote first. */
export interface CheckInput { repo: string; remote: string; branch: string; installed?: string; fetchInstalled?: boolean }

export async function checkForUpdate({ repo, remote, branch, installed: installedRev = "HEAD", fetchInstalled = false }: CheckInput): Promise<CheckOutcome> {
  let installed: Revision | null = null;
  try {
    if (fetchInstalled) await ensureCommit(repo, remote, branch, installedRev);
    installed = await readRevision(repo, installedRev);
    const base = installed.sha;
    const tip = await lsRemote(repo, remote, branch);
    if (tip === base) return { ok: true, installed, available: null, relation: "equal", ahead: 0, behind: 0, delta: null };

    const fetched = await runGit(["rev-parse", "--verify", "--quiet", TIP_REF], repo);
    if (!await hasCommit(repo, tip) || fetched.stdout.trim() !== tip) await fetchTip(repo, remote, branch);

    const [ahead, behindAll] = await Promise.all([count(repo, `${tip}..${base}`), count(repo, `${base}..${tip}`)]);
    const relation: Relation = behindAll === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
    if (relation === "ahead") return { ok: true, installed, available: null, relation, ahead, behind: 0, delta: null };

    const [available, commits, oldLog, newLog] = await Promise.all([
      readRevision(repo, tip),
      commitsBetween(repo, base, tip),
      showFile(repo, base, "CHANGELOG.md"),
      showFile(repo, tip, "CHANGELOG.md"),
    ]);
    /* Counted as listed (no merges); a tip that only merges known work still
       counts its merges rather than reading "0 commits behind". */
    const behind = commits.length > 0 ? commits.length : behindAll;
    return {
      ok: true,
      installed,
      available,
      relation,
      ahead,
      behind,
      delta: { commits, summary: summarizeDelta(changelogDelta(oldLog, newLog), behind) },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof CheckError ? { code: error.code } : {}),
      installed,
    };
  }
}
