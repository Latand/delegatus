/* The update check: ls-remote (no objects), then, only when the tip differs,
   a fetch into refs/self-update/tip and a local delta. Nothing here moves HEAD,
   a branch or the working tree. */
import { changelogDelta, summarizeDelta } from "./changelog";
import type { CommitLine, Revision, UpdateDelta } from "./state";

export const TIP_REF = "refs/self-update/tip";

export interface GitResult { code: number; stdout: string; stderr: string }

/* Git never prompts: a remote that wants credentials fails the check instead
   of hanging it. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" };

export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) throw new Error(firstError(result.stderr) || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}

function firstError(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.startsWith("fatal:")) ?? lines.find((line) => line.startsWith("error:")) ?? lines[0] ?? "";
}

async function showFile(cwd: string, rev: string, path: string): Promise<string | null> {
  const result = await runGit(["show", `${rev}:${path}`], cwd);
  return result.code === 0 ? result.stdout : null;
}

export async function readRevision(checkout: string, rev: string): Promise<Revision> {
  const [line, pkg] = await Promise.all([
    git(checkout, "log", "-1", "--format=%H%x09%h%x09%cI", rev),
    showFile(checkout, rev, "package.json"),
  ]);
  const [sha = "", , date = ""] = line.trim().split("\t");
  let version = "unknown";
  try { version = String(JSON.parse(pkg ?? "{}").version ?? "unknown"); } catch { /* keeps "unknown" */ }
  return { version, sha, short: sha.slice(0, 7), date };
}

export async function lsRemote(checkout: string, remote: string, branch: string): Promise<string> {
  const out = await git(checkout, "ls-remote", remote, `refs/heads/${branch}`);
  const sha = out.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`The remote has no branch ${branch}`);
  return sha;
}

export async function fetchTip(checkout: string, remote: string, branch: string): Promise<void> {
  await git(checkout, "fetch", "--no-tags", remote, `refs/heads/${branch}:${TIP_REF}`);
}

async function count(checkout: string, range: string): Promise<number> {
  return Number((await git(checkout, "rev-list", "--count", range)).trim());
}

async function commitsBetween(checkout: string, from: string, to: string): Promise<CommitLine[]> {
  const out = await git(checkout, "log", "--format=%h%x09%s", `${from}..${to}`);
  return out.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { short: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

export type Relation = "equal" | "behind" | "ahead" | "diverged";

export type CheckOutcome =
  | { ok: true; running: Revision; available: Revision | null; relation: Relation; ahead: number; behind: number; delta: UpdateDelta | null }
  | { ok: false; error: string; running: Revision | null };

export interface CheckInput { checkout: string; remote: string; branch: string }

export async function checkForUpdate({ checkout, remote, branch }: CheckInput): Promise<CheckOutcome> {
  let running: Revision | null = null;
  try {
    running = await readRevision(checkout, "HEAD");
    const tip = await lsRemote(checkout, remote, branch);
    if (tip === running.sha) return { ok: true, running, available: null, relation: "equal", ahead: 0, behind: 0, delta: null };

    const known = await runGit(["cat-file", "-e", `${tip}^{commit}`], checkout);
    const fetched = await runGit(["rev-parse", "--verify", "--quiet", TIP_REF], checkout);
    if (known.code !== 0 || fetched.stdout.trim() !== tip) await fetchTip(checkout, remote, branch);

    const [ahead, behind] = await Promise.all([count(checkout, `${tip}..HEAD`), count(checkout, `HEAD..${tip}`)]);
    const relation: Relation = behind === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
    if (relation === "ahead") return { ok: true, running, available: null, relation, ahead, behind, delta: null };

    const [available, commits, oldLog, newLog] = await Promise.all([
      readRevision(checkout, tip),
      commitsBetween(checkout, "HEAD", tip),
      showFile(checkout, "HEAD", "CHANGELOG.md"),
      showFile(checkout, tip, "CHANGELOG.md"),
    ]);
    const changelog = changelogDelta(oldLog, newLog);
    return {
      ok: true,
      running,
      available,
      relation,
      ahead,
      behind,
      delta: { commits, changelog, summary: summarizeDelta(changelog, commits.length) },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), running };
  }
}
