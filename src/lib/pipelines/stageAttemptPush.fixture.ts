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
let nextFixture = 0;
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
  const fixtureNumber = ++nextFixture;
  const launchId = `stage-proof-fixture-${fixtureNumber}`;
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
  return { fixtureNumber, root, repository, lane, remote, foreign, env, git, own, commit, push, settle, pipeline, attempt, receipt: stageGitReceiptDirectory(launchId),
    close: async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); } };
}
