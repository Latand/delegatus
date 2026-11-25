import { expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { pipelineIdentity } from "./store";
import type { Pipeline, PipelineStageAttempt } from "./types";

export const START = "2026-10-16T08:00:00.000Z", NOW = "2026-10-16T12:00:00.000Z";
export let nextFixture = 0;
export async function fixture(legacy = false, successor = false, prBase?: { mainBeforeCreation?: boolean }, identity?: { id: string; task: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-proof-"));
  const repository = path.join(root, "lane"), remote = path.join(root, "remote.git"), foreign = path.join(root, "foreign");
  const owned = identity ? pipelineIdentity(identity.id, identity.task, repository) : { worktreeDir: repository, branch: "pipeline/proof" };
  const lane = owned.worktreeDir;
  const baseEnv = { ...process.env, ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
    HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-git-config"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_DATE: "2026-10-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T09:00:00Z" };
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realExec("git", args, cwd, cwd === lane ? env : baseEnv);
    expect(r.code, r.stderr).toBe(0); return r.stdout.trim();
  };
  await fs.mkdir(repository);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "Fixture");
  await git(repository, "config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git(repository, "config", "commit.gpgSign", "false");
  // These historical machine-identity cases model a privacy-bound project.
  await fs.mkdir(path.join(repository, "scripts"));
  await fs.writeFile(path.join(repository, "package.json"), JSON.stringify({ scripts: { "privacy:check": "bun scripts/privacy-publication-gate.ts" } }));
  await fs.writeFile(path.join(repository, "scripts/privacy-known-value-fingerprints.json"), "{}");
  await git(repository, "add", "package.json", "scripts");
  await git(repository, "commit", "--allow-empty", "-m", "base");
  let base = await git(repository, "rev-parse", "HEAD");
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "origin", "main");
  if (successor) {
    await git(repository, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await git(repository, "commit", "--allow-empty", "-m", "reviewed successor base");
    base = await git(repository, "rev-parse", "HEAD");
  }
  if (identity) await git(repository, "worktree", "add", "-b", owned.branch, lane);
  else await git(lane, "checkout", "-b", owned.branch);
  await git(root, "clone", remote, foreign);
  await git(foreign, "config", "user.name", "Fixture");
  await git(foreign, "config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git(foreign, "config", "commit.gpgSign", "false");
  if (prBase) await git(lane, "push", "origin", "HEAD:refs/heads/pipeline/proof");
  if (prBase?.mainBeforeCreation) {
    await git(foreign, "commit", "--allow-empty", "-m", "main before lane creation");
    await git(foreign, "push", "origin", "main");
  }
  const launchId = `stage-proof-fixture-${++nextFixture}`;
  const attempt = { launchId, startedAt: START, completedAt: null } as PipelineStageAttempt;
  const pipeline = { id: identity?.id ?? "proof", repoDir: repository, worktreeDir: lane, branch: owned.branch, baseBranch: prBase ? "pipeline/proof" : "main", baseRef: base, lastPassedCommit: base,
    delivery: { active: true, disposition: "owner", ownerId: identity?.id ?? "proof", publish: "enabled",
      target: { remote, repository: projectIdentityFromRemote(remote, lane)!.project, branch: "refs/heads/pipeline/proof" } } } as Pipeline;
  if (!legacy) {
    Object.assign(env, await prepareStageGitGuard(launchId, lane, realExec, START, async () => {}));
  }
  Object.assign(env, agentPublicationIdentityEnv({ ...env, HOME: root }));
  const own = async (...args: string[]) => await git(lane, ...args);
  const commit = async (label: string) => { await own("commit", "--allow-empty", "-m", label); return own("rev-parse", "HEAD"); };
  const push = async () => own("push", "origin", "HEAD:refs/heads/pipeline/proof");
  const settle = () => settleStageAttemptPush(pipeline, attempt, realExec, NOW);
  return { root, repository, lane, remote, foreign, env, git, own, commit, push, settle, pipeline, attempt, receipt: stageGitReceiptDirectory(launchId),
    close: async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); } };
}

// Agents committed with `git -c core.hooksPath=.githooks` to "keep hooks on".
// A command-line hooks path beats the guard's GIT_CONFIG_COUNT entry, so the
// guard's receipt hooks never run, while the repository's own hooks still do.
export async function repositoryHooks(f: Awaited<ReturnType<typeof fixture>>, referenceTransaction?: string) {
  const hooks = path.join(f.root, "repository-hooks");
  await fs.mkdir(hooks, { recursive: true });
  if (referenceTransaction) await fs.writeFile(path.join(hooks, "reference-transaction"), referenceTransaction, { mode: 0o700 });
  await f.own("config", "core.hooksPath", hooks);
  return async (args: string[], env: Record<string, string> = {}) =>
    await realExec("git", ["-c", `core.hooksPath=${hooks}`, ...args], f.lane, { ...f.env, ...env });
}

/** Run one Git command inside its own process group and kill the whole group
 * from the reference-transaction hook once a branch moved, before post-commit
 * or post-merge runs: the same cut an OOM kill of the agent's scope makes. The
 * launch's guard hooks run and forward to the repository's own. */
export async function dieAfterRefUpdate(f: Awaited<ReturnType<typeof fixture>>, args: string[]): Promise<string> {
  await repositoryHooks(f, "#!/bin/sh\ninput=$(cat)\n[ \"$1\" = committed ] && [ -n \"${STAGE_PROOF_DIE:-}\" ] "
    + "&& printf '%s\\n' \"$input\" | grep -q ' refs/heads/' && kill -KILL 0\nexit 0\n");
  const { spawn } = await import("node:child_process");
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn("git", args, { cwd: f.lane, detached: true, stdio: "ignore",
      env: { ...f.env, STAGE_PROOF_DIE: "1" } as NodeJS.ProcessEnv });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  expect(status.signal).toBe("SIGKILL");
  await f.own("config", "--unset", "core.hooksPath");
  // The kill also skipped Git's own cleanup of the merge state.
  if ((await realExec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], f.lane, f.env)).code === 0) await f.own("merge", "--quit");
  return await f.own("rev-parse", "HEAD");
}

export async function commitThenDie(f: Awaited<ReturnType<typeof fixture>>, message: string): Promise<string> {
  const head = await dieAfterRefUpdate(f, ["commit", "--allow-empty", "-m", message]);
  expect(await f.own("log", "-1", "--format=%s", head)).toBe(message);
  return head;
}
