import { realExec } from "@/lib/workflows/provision";
import { githubRepositoryFromRemote } from "@/lib/projects/git";
export { githubRepositoryFromRemote, repositoryForProjectRoot, resetRepositoryCache } from "@/lib/projects/git";

import type { Flow } from "./types";

/** Base-ref resolution for a flow's review scope, isolated from the state machine. */

export async function resolveBaseRef(cwd: string, baseMode: Flow["baseMode"]): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const args =
    baseMode === "head"
      ? ["rev-parse", "HEAD"]
      : ["merge-base", "HEAD", (await defaultBranch(cwd)) ?? "origin/main"];
  const res = (await realExec("git", args, cwd, undefined, { timeoutMs: 2_000 }));
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "failed to resolve git base ref").trim() };
  }
  const sha = res.stdout.trim();
  return sha ? { ok: true, sha } : { ok: false, error: "git returned an empty base ref" };
}

async function defaultBranch(cwd: string): Promise<string | null> {
  const remote = (await realExec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd, undefined, { timeoutMs: 2_000 }));
  if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, "origin/");
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const res = (await realExec("git", ["rev-parse", "--verify", candidate], cwd, undefined, { timeoutMs: 2_000 }));
    if (res.code === 0) return candidate;
  }
  return null;
}

export async function resolveFlowMergeIdentity(cwd: string): Promise<{ repository: string; headRef: string; headSha: string } | null> {
  const remote = (await realExec("git", ["remote", "get-url", "origin"], cwd, undefined, { timeoutMs: 2_000 }));
  const branch = (await realExec("git", ["branch", "--show-current"], cwd, undefined, { timeoutMs: 2_000 }));
  const head = (await realExec("git", ["rev-parse", "HEAD"], cwd, undefined, { timeoutMs: 2_000 }));
  if (remote.code !== 0 || branch.code !== 0 || head.code !== 0) return null;
  const repository = githubRepositoryFromRemote(remote.stdout);
  const headRef = branch.stdout.trim();
  const headSha = head.stdout.trim();
  return repository && headRef && /^[0-9a-f]{40}$/i.test(headSha) ? { repository, headRef, headSha } : null;
}

export async function resolveCleanFlowHead(cwd: string): Promise<string | null> {
  const status = (await realExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd, undefined, { timeoutMs: 2_000 }));
  if (status.code !== 0 || status.stdout.trim()) return null;
  const head = (await realExec("git", ["rev-parse", "HEAD"], cwd, undefined, { timeoutMs: 2_000 }));
  const sha = head.stdout.trim();
  return head.code === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export async function resolveFlowRemoteHead(cwd: string, headRef: string): Promise<string | null> {
  const remote = (await realExec("git", ["ls-remote", "--heads", "origin", `refs/heads/${headRef}`], cwd, undefined, { timeoutMs: 5_000 }));
  if (remote.code !== 0) return null;
  const sha = remote.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}
