import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import type { PipelineStageAttempt } from "./types";
import { START, NOW, nextFixture, fixture, commitThenDie } from "./stageAttemptPush.fixture";

test.each(["before", "after"] as const)("PR-base successor settles a merge of main advanced %s lane creation", async timing => {
  const f = await fixture(false, true, { mainBeforeCreation: timing === "before" });
  try {
    // A successor's explicit base branch can be its PR branch. Main remains
    // independent of that branch, even when main moved before provisioning.
    f.pipeline.delivery!.target.pr = 1;
    if (timing === "after") {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "main after lane creation");
      await f.git(f.foreign, "push", "origin", "main");
    }
    const main = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    // Reproduce the controller's stale cache as well as the PR-base mismatch.
    await f.own("update-ref", "refs/remotes/origin/main", await f.own("rev-parse", `${main}^`));
    f.pipeline.repoDir = f.lane;
    expect(await commitAndAdoptStageBranch(f.pipeline, "build", realExec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally { await f.close(); }
});

test("a pushed stage head is proved before controller staging can sweep scratch files or name an ignored artifact directory (#2631)", async () => {
  const f = await fixture();
  try {
    f.pipeline.repoDir = f.lane;
    await fs.writeFile(path.join(f.lane, ".gitignore"), ".artifacts/\n");
    await fs.mkdir(path.join(f.lane, ".artifacts"));
    await fs.writeFile(path.join(f.lane, ".artifacts", "kept.txt"), "tracked despite the directory ignore\n");
    await f.own("add", ".gitignore");
    await f.own("add", "-f", ".artifacts/kept.txt");
    await f.own("commit", "-m", "stage result");
    const head = await f.own("rev-parse", "HEAD");
    await f.push();
    await fs.writeFile(path.join(f.lane, "stage.log"), "scratch output\n");
    const calls: string[][] = [];
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      calls.push([command, ...args]);
      return realExec(command, args, cwd, env, options);
    };

    const settled = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);

    expect(calls.some(([command, action]) => command === "git" && action === "add")).toBe(false);
    expect(settled).toEqual({ ok: false,
      error: "settling the stage push: adoption requires a clean owned lane branch; both tips are preserved" });
    expect(await f.own("diff", "--cached", "--name-only")).toBe("");
    expect(await fs.readFile(path.join(f.lane, "stage.log"), "utf8")).toBe("scratch output\n");
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(head);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor refuses a foreign merge parent during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign branch work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", f.foreign, "HEAD");
    await f.own("update-ref", "refs/remotes/origin/main", foreign);
    await f.own("merge", "--no-ff", "-m", "own merge of foreign work", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    if (mode === "pushed") await f.push();
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${foreign} was not created`) });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor rejects redirected-origin ancestry during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    // The lane's origin alias is editable. Keep delivery pointed at the
    // original bare remote, and merge the foreign main through the alias.
    await f.own("remote", "set-url", "origin", f.foreign);
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "merge redirected origin main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    const originalTip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (mode === "pushed") {
      const pushed = await f.own("push", f.remote, "HEAD:refs/heads/pipeline/proof");
      expect(pushed).toBe("");
    }
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${foreign} was not created`) });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
    if (mode !== "pushed") expect(tip).toBe(originalTip);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor rejects main ancestry redirected by a URL-shaped push alias during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    const foreignUrl = "file://" + f.foreign;
    await f.own("config", "remote." + foreignUrl + ".url", f.remote);
    await f.own("config", "remote." + foreignUrl + ".pushurl", f.foreign);
    f.pipeline.delivery!.target.remote = foreignUrl;

    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", f.foreign, "main");
    await f.own("merge", "--no-ff", "-m", "merge foreign main", "FETCH_HEAD");
    const head = await f.own("rev-parse", "HEAD");

    if (mode === "pushed") {
      await f.own("push", f.remote, "HEAD:" + f.pipeline.delivery!.target.branch);
      await fs.writeFile(path.join(f.receipt, "pushes", head),
        f.pipeline.delivery!.target.branch + "\n" + f.foreign + "\n");
    }
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("commit " + foreign + " was not created") });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    if (mode === "pushed") expect(await f.git(f.remote, "rev-parse", f.pipeline.delivery!.target.branch)).toBe(head);
  } finally { await f.close(); }
});

test.each(["local", "repair"] as const)("PR-base successor rejects URL-named fetch alias ancestry during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    const trustedUrl = "file://" + f.remote;
    const foreignUrl = "file://" + f.foreign;
    f.pipeline.delivery!.target.remote = trustedUrl;
    await f.own("config", "remote." + trustedUrl + ".url", foreignUrl);
    await f.own("config", "remote." + trustedUrl + ".pushurl", trustedUrl);

    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    await f.own("fetch", foreignUrl, "main");
    await f.own("merge", "--no-ff", "-m", "merge foreign main", "FETCH_HEAD");
    const head = await f.own("rev-parse", "HEAD");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("delivery fetch URL does not match the persisted repository") });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(f.pipeline.baseRef);
  } finally { await f.close(); }
});

test.each(["pushed", "repair"] as const)("PR-base successor verifies current origin main during %s settlement", async mode => {
  const f = await fixture(false, true, { mainBeforeCreation: true });
  try {
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    if (mode === "pushed") await f.push();
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined)).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test.each(["lookup timeout", "fetch timeout", "missing main", "malformed tip"] as const)("PR-base successor preserves tips on %s", async fault => {
  const f = await fixture(false, true, { mainBeforeCreation: true });
  try {
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    let reads = 0, fetches = 0;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      if (command === "git" && args.join(" ") === `ls-remote --refs ${f.remote} refs/heads/main`) {
        reads++;
        expect(options?.timeoutMs).toBe(5000);
        if (fault === "lookup timeout") return { code: 124, stdout: "", stderr: "fixture timeout" };
        if (fault === "missing main") return { code: 0, stdout: "", stderr: "" };
        if (fault === "malformed tip") return { code: 0, stdout: `${head}\trefs/heads/other\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "fetch" && args[2] === f.remote) {
        fetches++;
        expect(options?.timeoutMs).toBe(10000);
        if (fault === "fetch timeout") return { code: 124, stdout: "", stderr: "fixture timeout" };
      }
      return realExec(command, args, cwd, env, options);
    };
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, exec, NOW);
    expect(result?.ok).toBe(false);
    if (fault.endsWith("timeout")) expect(result).toMatchObject({ deferred: true });
    expect(reads).toBe(1);
    expect(fetches).toBe(fault === "fetch timeout" ? 1 : 0);
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

for (const divergent of [false, true]) test(`successor settlement preserves an older delivery tip (divergent: ${divergent})`, async () => {
  const f = await fixture(false, true);
  try {
    const head = await f.commit("passed successor output");
    if (divergent) {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign delivery output");
      await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    }
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    f.pipeline.repoDir = f.lane;
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", realExec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);
    if (divergent) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("settling the stage push:");
    } else {
      expect(await f.own("merge-base", "--is-ancestor", tip, f.pipeline.baseRef)).toBe("");
      expect(result).toEqual({ ok: true, sha: head });
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

test("B: a controller-created replacement link proves a completed parent without restartRecovery", async () => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const inherited = await f.commit("completed parent output");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/parent.jsonl" } as PipelineStageAttempt;
    childLaunch = `stage-proof-generic-replacement-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START, async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/child.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("replacement output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();
    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(inherited).not.toBe(head);
  } finally { if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true }); await f.close(); }
});

// A predecessor's own commit whose host died before post-commit is proved by
// the receipt its commit invocation wrote before moving the branch; one it
// reached by reset, or made with the launch hooks overridden, stays unproved.
test.each(["own commit, receipt lost", "own hooks-off commit", "imported commit"] as const)("review safety: manual silent retry preserves predecessor commit custody (%s)", async predecessor => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/silent.jsonl" } as PipelineStageAttempt;
    if (predecessor === "own commit, receipt lost") {
      await commitThenDie(f, "unreceipted predecessor");
    } else if (predecessor === "own hooks-off commit") {
      const made = await realExec("git", ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "unreceipted predecessor"],
        f.lane, { ...f.env, PATH: process.env.PATH });
      expect(made.code, made.stderr).toBe(0);
    } else {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "unreceipted predecessor");
      await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
      await f.own("fetch", "origin", "pipeline/proof");
      await f.own("reset", "--hard", "FETCH_HEAD");
    }
    const inherited = await f.own("rev-parse", "HEAD");

    childLaunch = `stage-proof-manual-silent-retry-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START, async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/manual-retry.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("manual retry output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();

    const expected = predecessor === "own commit, receipt lost" ? { ok: true, sha: head }
      : { ok: false, error: expect.stringContaining(`commit ${inherited} was not created in the attempt worktree`) };
    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject(expected);
    const unlinked = structuredClone(f.pipeline);
    delete unlinked.runs![0]!.attempts[1]!.restartContext;
    expect(await settleStageAttemptPush(unlinked, unlinked.runs![0]!.attempts[1]!, realExec, NOW)).toMatchObject(expected);
  } finally {
    if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});
