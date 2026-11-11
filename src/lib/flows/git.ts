import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { githubRepositoryFromRemote } from "@/lib/projects/git";

export async function resolveFlowMergeIdentity(cwd: string, exec: ExecPort = realExec): Promise<{ repository: string; headRef: string; headSha: string } | null> {
  const remote = (await exec("git", ["remote", "get-url", "origin"], cwd, undefined, { timeoutMs: 2_000 }));
  const branch = (await exec("git", ["branch", "--show-current"], cwd, undefined, { timeoutMs: 2_000 }));
  const head = (await exec("git", ["rev-parse", "HEAD"], cwd, undefined, { timeoutMs: 2_000 }));
  if (remote.code !== 0 || branch.code !== 0 || head.code !== 0) return null;
  const repository = githubRepositoryFromRemote(remote.stdout);
  const headRef = branch.stdout.trim();
  const headSha = head.stdout.trim();
  return repository && headRef && /^[0-9a-f]{40}$/i.test(headSha) ? { repository, headRef, headSha } : null;
}

/** Repository identity a controller observes before it takes its mutation lease. */
export interface PreparedFlowGit {
  cwd: string;
  mergeIdentity: Awaited<ReturnType<typeof resolveFlowMergeIdentity>>;
}
