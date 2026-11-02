import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The merge runner's base update against real Git: a local bare remote, a
   publishing clone and the project checkout the runner works in. No network. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-base-update-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { BaseUpdateError, planBaseUpdate, pushBaseUpdate } = await import("./baseUpdate");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const AT = "2026-10-31T11:00:00.750Z";
const AT_SECONDS = Math.floor(Date.parse(AT) / 1000);
const author = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: AT, GIT_COMMITTER_DATE: AT } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(cwd: string, file: string, text: string): string {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, ...author, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** A remote with main and one topic branch; the checkout cloned before either moved. */
function fixture(name: string, topicFile: string, mainFile: string) {
  const dir = path.join(root, name);
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const repoDir = path.join(dir, "checkout");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "clone", "-q", remote, work);
  git(work, "symbolic-ref", "HEAD", "refs/heads/main");
  commitFile(work, "shared.txt", "one\ntwo\nthree\n");
  git(work, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, repoDir);
  git(work, "checkout", "-q", "-b", "topic");
  const head = commitFile(work, topicFile, "topic side\n");
  git(work, "push", "-q", "origin", "topic");
  git(work, "checkout", "-q", "main");
  const base = commitFile(work, mainFile, "main side\n");
  git(work, "push", "-q", "origin", "main");
  return { remote, repoDir, head, base };
}

const snapshot = (repoDir: string) => ({
  head: git(repoDir, "rev-parse", "HEAD"),
  refs: git(repoDir, "for-each-ref", "--format=%(refname) %(objectname)"),
  status: git(repoDir, "status", "--porcelain", "--untracked-files=all"),
  fetchHead: fs.existsSync(path.join(repoDir, ".git", "FETCH_HEAD")),
});

test("a clean base update is the machine's exact merge, recreated identically and pushed as a fast-forward", async () => {
  const { remote, repoDir, head, base } = fixture("clean", "topic.txt", "main.txt");
  const before = snapshot(repoDir);
  const request = { repoDir, remote: "origin", head, base, at: AT };
  const plan = await planBaseUpdate(request);
  if (plan.kind !== "commit") throw new Error(`expected a commit, got ${plan.kind}`);
  expect(snapshot(repoDir)).toEqual(before);
  expect(git(repoDir, "rev-list", "--parents", "-n", "1", plan.commit)).toBe(`${plan.commit} ${head} ${base}`);
  expect(git(repoDir, "rev-parse", `${plan.commit}^{tree}`)).toBe(git(repoDir, "merge-tree", "--write-tree", head, base));
  expect(git(repoDir, "log", "-1", "--format=%an|%ae|%cn|%ce|%at|%ct|%s", plan.commit))
    .toBe(`Delegatus|noreply@delegatus.invalid|Delegatus|noreply@delegatus.invalid|${AT_SECONDS}|${AT_SECONDS}|Merge ${base} into ${head}`);
  expect(await planBaseUpdate(request)).toEqual(plan);
  expect(await planBaseUpdate({ ...request, at: "2026-10-31T11:00:01.000Z" })).not.toEqual(plan);

  await pushBaseUpdate({ repoDir, remote: "origin", branch: "refs/heads/topic", commit: plan.commit });
  expect(git(remote, "rev-parse", "refs/heads/topic")).toBe(plan.commit);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(base);
  // Git records the pushed tip in the remote-tracking ref; nothing else moves.
  expect(snapshot(repoDir)).toEqual({ ...before,
    refs: [...before.refs.split("\n"), `refs/remotes/origin/topic ${plan.commit}`].sort().join("\n") });
  // The pushed head already contains the base.
  expect(await planBaseUpdate({ ...request, head: plan.commit })).toEqual({ kind: "current" });
});

test("a textual conflict answers conflict and pushes nothing", async () => {
  const { remote, repoDir, head, base } = fixture("conflict", "shared.txt", "shared.txt");
  const before = snapshot(repoDir);
  expect(await planBaseUpdate({ repoDir, remote: "origin", head, base, at: AT })).toEqual({ kind: "conflict" });
  expect(git(remote, "rev-parse", "refs/heads/topic")).toBe(head);
  expect(snapshot(repoDir)).toEqual(before);
});

test("a push that is not a fast-forward is refused with git's words and changes nothing", async () => {
  const { remote, repoDir, head, base } = fixture("diverged", "topic.txt", "main.txt");
  const plan = await planBaseUpdate({ repoDir, remote: "origin", head, base, at: AT });
  if (plan.kind !== "commit") throw new Error(`expected a commit, got ${plan.kind}`);
  // Someone else pushed to the PR branch after the update was planned.
  const other = path.join(root, "diverged", "other");
  git(root, "clone", "-q", "-b", "topic", remote, other);
  const moved = commitFile(other, "late.txt", "late\n");
  git(other, "push", "-q", "origin", "topic");
  const refusal = await pushBaseUpdate({ repoDir, remote: "origin", branch: "refs/heads/topic", commit: plan.commit }).catch(error => error);
  expect(refusal).toBeInstanceOf(BaseUpdateError);
  expect((refusal as InstanceType<typeof BaseUpdateError>).stderr).toMatch(/rejected|non-fast-forward|fetch first/);
  expect(git(remote, "rev-parse", "refs/heads/topic")).toBe(moved);
});

test("an unreachable commit or remote fails the plan instead of answering", async () => {
  const { repoDir, head } = fixture("missing", "topic.txt", "main.txt");
  await expect(planBaseUpdate({ repoDir, remote: "origin", head, base: "e".repeat(40), at: AT })).rejects.toBeInstanceOf(BaseUpdateError);
  await expect(planBaseUpdate({ repoDir, remote: "origin", head: "not-a-sha", base: head, at: AT })).rejects.toThrow("two commit ids");
});
