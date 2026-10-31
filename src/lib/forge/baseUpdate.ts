import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

/*
 * The merge queue's mechanical base update (docs/design/merge-queue-refresh-capacity.md §5).
 * A PR that is only behind its base gets the merge of the published base into
 * its published head, made by the merge runner itself under the Delegatus
 * machine identity, and pushed to the PR branch as a fast-forward. Git writes
 * objects only: the checkout, its index and its branch refs stay untouched.
 * A textual conflict is answered as such and goes to a refresh lane.
 */

export type BaseUpdateRequest = {
  repoDir: string;
  /** The delivery remote: a configured remote name or a URL. */
  remote: string;
  /** The PR head (first parent) and the base tip (second parent). */
  head: string;
  base: string;
  /** The update's recorded `requestedAt`; its whole seconds pin both commit dates. */
  at: string;
};
export type BaseUpdatePlan = { kind: "commit"; commit: string } | { kind: "conflict" } | { kind: "current" };
export type BaseUpdatePush = { repoDir: string; remote: string; branch: string; commit: string };

const SHA = /^[0-9a-f]{40}$/i;
const GIT_TIMEOUT_MS = 60_000;

/** Git's own words; the merge runner counts it as a failed read. */
export class BaseUpdateError extends Error {
  constructor(step: string, readonly stderr: string) {
    super(`git ${step} failed for the base update`);
  }
}

function refused(step: string, result: { code: number | null; stderr: string }): Error {
  return new BaseUpdateError(step, result.stderr || `git ${step} exited ${result.code}`);
}

/** The merge commit for `request`, or why there is none. The same request
 * recreates the same commit: tree, parents, identity, dates and message are
 * all fixed by it. */
export async function planBaseUpdate(request: BaseUpdateRequest, exec: ExecPort = realExec): Promise<BaseUpdatePlan> {
  const seconds = Math.floor(Date.parse(request.at) / 1000);
  if (!SHA.test(request.head) || !SHA.test(request.base) || !Number.isFinite(seconds)) throw new Error("base update needs two commit ids and a time");
  const git = (args: string[], env: Partial<NodeJS.ProcessEnv> = {}) =>
    exec("git", args, request.repoDir, { GIT_NO_REPLACE_OBJECTS: "1", ...env }, { timeoutMs: GIT_TIMEOUT_MS });
  const missing: string[] = [];
  for (const sha of [request.head, request.base]) {
    if ((await git(["cat-file", "-e", `${sha}^{commit}`])).code !== 0) missing.push(sha);
  }
  if (missing.length) {
    const fetched = await git(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", request.remote, ...missing]);
    if (fetched.code !== 0) throw refused("fetch", fetched);
  }
  if ((await git(["merge-base", "--is-ancestor", request.base, request.head])).code === 0) return { kind: "current" };
  const merged = await git(["merge-tree", "--write-tree", "--no-messages", request.head, request.base]);
  if (merged.code === 1) return { kind: "conflict" };
  const tree = merged.stdout.trim().split("\n")[0] ?? "";
  if (merged.code !== 0 || !SHA.test(tree)) throw refused("merge-tree", merged);
  const date = `@${seconds} +0000`;
  const made = await git(["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", request.head, "-p", request.base,
    "-m", `Merge ${request.base} into ${request.head}`],
  { ...controllerCommitIdentityEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const commit = made.stdout.trim();
  if (made.code !== 0 || !SHA.test(commit)) throw refused("commit-tree", made);
  return { kind: "commit", commit };
}

/** A plain push: git refuses anything but a fast-forward. Repository hooks
 * are skipped because the commit publishes no new text (the merge of two
 * published commits, fixed words and two ids, the machine identity); the
 * required checks on the pushed head gate the merge. A declared App
 * repository receives it as the Delegatus GitHub App. */
export async function pushBaseUpdate(request: BaseUpdatePush, exec: ExecPort = realExec): Promise<void> {
  if (!SHA.test(request.commit) || !request.branch) throw new Error("base update push needs a commit and a branch");
  const branch = request.branch.startsWith("refs/") ? request.branch : `refs/heads/${request.branch}`;
  const pushed = await exec("git", ["push", "--no-verify", request.remote, `${request.commit}:${branch}`], request.repoDir,
    engineForgeWriteEnv(), { timeoutMs: GIT_TIMEOUT_MS });
  if (pushed.code !== 0) throw refused("push", pushed);
}
