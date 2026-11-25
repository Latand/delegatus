import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import type { PipelineStageAttempt } from "./types";
import { bindMergerContract } from "./mergerContract.fixture";
import { git as batchGit } from "../../../scripts/merge-batch";
import { commitThenDie, fixture, nextFixture, START, NOW } from "./stageAttemptPush.fixture";

setDefaultTimeout(15_000);

test.each(["batch", "earlier producer", "pull ref only", "tracking ref"] as const)("merger contract native boundary: %s", async mode => {
  const f = await fixture(true);
  let contract: Awaited<ReturnType<typeof bindMergerContract>> | undefined;
  try {
    // Only main history is present locally. A PR fetch must not accidentally
    // inherit tracking proof from the fixture producer's branch push.
    await f.git(f.foreign, "checkout", "-b", "topic-13");
    await fs.writeFile(path.join(f.foreign, "feature.txt"), "reviewed PR\n");
    await f.git(f.foreign, "add", "feature.txt");
    await f.git(f.foreign, "commit", "-m", "reviewed PR");
    const pr = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", `${pr}:refs/pull/13/head`, `${pr}:refs/heads/topic-13`);
    await f.git(f.foreign, "checkout", "main");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    await f.git(f.foreign, "push", "origin", "main");
    if (mode === "earlier producer") await f.commit("earlier producing stage");
    const laneHead = await f.own("rev-parse", "HEAD");
    const scratch = path.join(f.root, "merger-scratch");
    await fs.mkdir(scratch);
    contract = await bindMergerContract(f.lane, `merger-native-${mode.replaceAll(" ", "-")}`, { ...f.env, TMPDIR: scratch });
    const env = { ...contract.env, LLV_SKIP_HOOKS: "1" };
    const git = (cwd: string, ...args: string[]) => batchGit(cwd, args, undefined, env);
    git(f.lane, "fetch", "origin", "main");
    const work = path.join(scratch, "checkout");
    const resolution = mode === "pull ref only" || mode === "tracking ref";
    if (resolution) {
      git(f.lane, "fetch", "origin", "refs/pull/13/head");
      expect(git(f.lane, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic-13")).toBe("");
      git(f.lane, "worktree", "add", "--detach", work, "FETCH_HEAD");
      git(work, "merge", "--no-commit", "--no-ff", "origin/main");
    } else {
      git(f.lane, "fetch", "origin", "refs/pull/13/head");
      git(f.lane, "worktree", "add", "-b", "merge-batch/fixture", work, "origin/main");
      git(work, "merge", "--squash", pr);
    }
    batchGit(work, ["commit", "-F", "-"], "Fixture batch resolution\n", env);
    const tip = git(work, "rev-parse", "HEAD");
    expect(await fs.access(path.join(contract.receipt, "commits", tip)).then(() => true, () => false)).toBe(true);
    if (mode === "tracking ref") git(work, "fetch", "origin", "+refs/heads/topic-13:refs/remotes/origin/topic-13");
    const ref = resolution ? "refs/heads/topic-13" : "refs/heads/merge-batch/fixture";
    const push = () => git(work, "push", resolution ? f.remote : "origin", `${tip}:${ref}`);
    const refused = mode === "earlier producer" || mode === "pull ref only";
    if (refused) {
      expect(push).toThrow("stage push refused");
      expect(await fs.readFile(path.join(contract.receipt, "refused"), "utf8")).toContain("stage push refused");
      expect(await contract.settle()).toMatchObject({ ok: false, error: expect.stringContaining("stage push refused") });
      expect(await f.git(f.remote, "for-each-ref", "--format=%(objectname)", ref)).toBe(resolution ? pr : "");
    } else {
      push();
      expect(await fs.readFile(path.join(contract.receipt, "pushes", tip), "utf8")).toBe(`${ref}\n${f.remote}\n`);
      expect(await fs.access(path.join(contract.receipt, "refused")).then(() => true, () => false)).toBe(false);
      expect(await contract.settle()).toBeNull();
      expect(await f.git(f.remote, "rev-parse", ref)).toBe(tip);
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(laneHead);
  } finally {
    if (contract) await fs.rm(contract.receipt, { recursive: true, force: true });
    await f.close();
  }
});

test.each(["commit", "push"] as const)("a superseded producer cannot %s; an explicit fix stage restores publication", async action => {
  const f = await fixture();
  const review = `stage-proof-review-${nextFixture}`, fix = `stage-proof-fix-${nextFixture}`;
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const reviewed = await f.commit("producer output ready for review");
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    // Each command is a fresh Git process using the old producer's environment.
    const command = action === "commit" ? ["commit", "--no-verify", "--allow-empty", "-m", "late producer output"]
      : ["push", "origin", "HEAD:refs/heads/pipeline/proof"];
    const denied = await realExec("git", command, f.lane, f.env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(reviewed);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
    // Opening a fix stage grants its own binding; the old one stays revoked.
    Object.assign(f.env, await prepareStageGitGuard(fix, f.lane, realExec, "2026-10-16T11:00:00.000Z", async () => {}));
    const fixed = await f.commit("fix requested by a new stage");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(fixed);
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await fs.rm(stageGitReceiptDirectory(fix), { recursive: true, force: true });
    await f.close();
  }
});

test("a restarted preparation cannot reclaim its superseded worktree binding", async () => {
  const f = await fixture();
  const review = `stage-proof-review-restart-${nextFixture}`;
  try {
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    const child = Bun.spawn([process.execPath, "--eval", `
      const {prepareStageGitGuard}=await import("./src/lib/git/stageAttemptGuard.ts");
      const {realExec}=await import("./src/lib/workflows/provision.ts");
      await prepareStageGitGuard(process.env.PROOF_LAUNCH,process.env.PROOF_LANE,realExec,process.env.PROOF_START, async () => {});
    `], { cwd: process.cwd(), env: { ...process.env, PROOF_LAUNCH: f.attempt.launchId!, PROOF_LANE: f.lane, PROOF_START: START }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("superseded by another attempt");
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["rev-parse --absolute-git-dir", "rev-parse HEAD"])("a successor admitted during %s keeps its worktree fence", async lookup => {
  const f = await fixture();
  const seam = lookup === "rev-parse HEAD" ? "head" : "git-directory";
  const delayed = `stage-proof-delayed-${seam}`, review = `stage-proof-racing-review-${seam}`;
  try {
    const activation = path.join(f.root, "active-launch");
    await fs.writeFile(activation, delayed);
    let successor: Record<string, string> = {};
    const exec: typeof realExec = async (...args) => {
      const result = await realExec(...args);
      if (args[0] === "git" && args[1].join(" ") === lookup) {
        await fs.writeFile(activation, review);
        successor = await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
      }
      return result;
    };
    await expect(prepareStageGitGuard(delayed, f.lane, exec, "2026-10-16T09:00:00.000Z", async () => {
      if (await fs.readFile(activation, "utf8") !== delayed) throw new Error("superseded by another attempt");
    }))
      .rejects.toThrow("superseded by another attempt");
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
    expect(await fs.access(owner + ".lock").then(() => true, () => false)).toBe(false);
    Object.assign(f.env, successor);
    const made = await f.commit("successor retains commit authority");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(made);
  } finally {
    await fs.rm(stageGitReceiptDirectory(delayed), { recursive: true, force: true });
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

// These probes intercept Git through a POSIX executable and use native symlinks.
test.skipIf(process.platform === "win32").each([
  ["commit", "absent"], ["push", "absent"],
  ["commit", "self"], ["push", "self"],
  ["commit", "chained"], ["push", "chained"],
] as const)("ownership is rechecked after guard work: %s / %s", async (action, forwarding) => {
  const f = await fixture();
  const review = `stage-proof-no-hook-${action}-${forwarding}`;
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (action === "push") await f.commit("producer output awaiting publication");
    const before = await f.own("rev-parse", "HEAD");
    const hook = action === "commit" ? "reference-transaction" : "pre-push";
    let chained: string | undefined;
    if (forwarding !== "absent") {
      const hooks = path.join(f.lane, ".githooks");
      await fs.mkdir(hooks);
      const target = path.join(hooks, hook);
      if (forwarding === "self") await fs.symlink(path.join(f.env.LLV_AGENT_GIT_GUARD_DIR!, hook), target);
      else {
        await fs.writeFile(target, "#!/bin/sh\nexit 91\n", { mode: 0o700 });
        chained = target;
      }
      await f.own("config", "core.hooksPath", hooks);
    }
    const originalGit = Bun.which("git", { PATH: process.env.PATH })!;
    const bin = path.join(f.root, "bin");
    await fs.mkdir(bin);
    const marker = path.join(f.root, "handoff");
    const successor = stageGitReceiptDirectory(review);
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    const script = path.join(f.root, "admit-successor.ts");
    await fs.writeFile(script, `
      const {prepareStageGitGuard} = await import(${JSON.stringify(path.resolve("src/lib/git/stageAttemptGuard.ts"))});
      const {realExec} = await import(${JSON.stringify(path.resolve("src/lib/workflows/provision.ts"))});
      await prepareStageGitGuard(process.env.PROOF_REVIEW, process.env.PROOF_LANE, realExec, ${JSON.stringify(NOW)}, async () => {});
    `);
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh
if { [ "$PROOF_ACTION" = commit ] && [ "$*" = "show -s --no-show-signature --format=%T %P $5" ]; } ||
   { [ "$PROOF_ACTION" = push ] && [ "$*" = "-C $PROOF_LANE remote get-url --push origin" ]; }; then
  if mkdir "$PROOF_MARKER" 2>/dev/null; then
    (cd "$PROOF_PROJECT" && "$PROOF_BUN" "$PROOF_SCRIPT") || exit 1
  fi
fi
exec "$PROOF_GIT" "$@"
`, { mode: 0o700 });
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}`, GIT_EXEC_PATH: bin, PROOF_GIT: originalGit,
      LLV_AGENT_GIT_CHAINED_HOOK: chained, PROOF_ACTION: action, PROOF_REVIEW: review, PROOF_LANE: f.lane, PROOF_MARKER: marker,
      PROOF_PROJECT: process.cwd(), PROOF_BUN: process.execPath, PROOF_SCRIPT: script };
    const args = action === "commit" ? ["commit", "--allow-empty", "-m", "superseded during guard work"]
      : ["push", "origin", "HEAD:refs/heads/pipeline/proof"];
    const denied = await realExec("git", args, f.lane, env);
    expect(await fs.readFile(owner, "utf8"), denied.stderr).toBe(successor);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(before);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["binding", "handoff"] as const)("disk exhaustion during the owner %s keeps the previous owner and permits a retry", async phase => {
  const f = await fixture();
  const review = `stage-proof-disk-${phase}-${nextFixture}`;
  const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
  const noSpace = () => { throw Object.assign(new Error("fixture disk is full"), { code: "ENOSPC" }); };
  const write = fs.writeFile, rename = fs.rename;
  const fault = phase === "binding"
    ? spyOn(fs, "writeFile").mockImplementation((...args) => String(args[0]) === path.join(stageGitReceiptDirectory(review), "owner") ? noSpace() : write(...args))
    : spyOn(fs, "rename").mockImplementation((...args) => String(args[1]) === owner ? noSpace() : rename(...args));
  try {
    await expect(prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}))
      .rejects.toMatchObject({ code: "ENOSPC" });
    expect(await fs.readFile(owner, "utf8")).toBe(f.receipt);
    expect(await fs.access(owner + ".lock").then(() => true, () => false)).toBe(false);
    fault.mockRestore();
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
  } finally {
    fault.mockRestore();
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["pre-push", "reference-transaction"] as const)("ownership is rechecked after a repository %s hook", async hook => {
  const f = await fixture();
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (hook === "pre-push") await f.commit("producer output awaiting publication");
    const before = await f.own("rev-parse", "HEAD");
    const hooks = path.join(f.root, "repository-hooks");
    await fs.mkdir(hooks);
    await f.own("config", "core.hooksPath", hooks);
    await fs.writeFile(path.join(hooks, hook), `#!/bin/sh
printf '%s\\n' "$@" > "$PROOF_ARGS"
cat > "$PROOF_INPUT"
if [ "${hook}" = pre-push ] || [ "$1" = prepared ]; then
  printf '%s' successor > "$PROOF_OWNER"
fi
`, { mode: 0o700 });
    const env = { ...f.env, PROOF_OWNER: await fs.readFile(path.join(f.receipt, "owner"), "utf8"),
      PROOF_INPUT: path.join(f.root, "input"), PROOF_ARGS: path.join(f.root, "args") };
    const args = hook === "pre-push" ? ["push", "origin", "HEAD:refs/heads/pipeline/proof"]
      : ["commit", "--allow-empty", "-m", "superseded inside repository hook"];
    const denied = await realExec("git", args, f.lane, env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(before);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
    if (hook === "pre-push") {
      expect(await fs.readFile(env.PROOF_ARGS, "utf8")).toBe(`origin\n${f.remote}\n`);
      expect(await fs.readFile(env.PROOF_INPUT, "utf8")).toBe(`HEAD ${before} refs/heads/pipeline/proof ${remoteBefore}\n`);
    }
  } finally { await f.close(); }
});

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

test.each(["none", "foreign", "unrecorded"] as const)("the custody-to-committer handoff fences a %s head change", async race => {
  const f = await fixture();
  try {
    await f.push();
    await fs.rm(path.join(f.receipt, "pushes", f.pipeline.baseRef));
    const proved = await f.commit("proved stage output");
    let head = proved;
    let verified = false;
    let raced = false;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if (command === "git" && args[0] === "rev-list" && args.includes("--max-count=128")) verified = true;
      if (race !== "none" && verified && !raced && command === "git" && args[0] === "status" && args[1] === "--porcelain") {
        raced = true;
        if (race === "foreign") {
          const foreign = path.join(f.root, "handoff-foreign");
          await f.own("worktree", "add", "--detach", foreign, head);
          await f.git(foreign, "commit", "--allow-empty", "-m", "foreign handoff output");
          head = await f.git(foreign, "rev-parse", "HEAD");
          await f.own("merge", "--ff-only", head);
        } else {
          head = await f.commit("unrecorded handoff output");
          await fs.rm(path.join(f.receipt, "commits", head));
        }
      }
      return result;
    };
    f.pipeline.repoDir = f.lane;
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);
    if (race === "none") expect(result).toEqual({ ok: true, sha: proved });
    else {
      expect(raced).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("settling the stage push:");
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally { await f.close(); }
});

test.each((["accepted", "accepted replacement", "published"] as const).flatMap(proof =>
  (["valid", "host death", "foreign suffix", "unrecorded suffix", "dropped history", "remote race", "head race"] as const).map(suffix => ({ proof, suffix }))))
("recorded ancestry survives a later attempt ($proof, $suffix)", async ({ proof, suffix }) => {
  const f = await fixture();
  const childLaunch = `stage-proof-recorded-ancestry-${nextFixture}`;
  let lostLaunch: string | null = null;
  try {
    const inherited = await f.commit("earlier passed output");
    await f.push();
    const parent = { ...f.attempt, n: 1, state: "passed", verdict: { status: "pass" },
      completedAt: "2026-10-16T09:30:00.000Z", agentPath: "/stage/earlier.jsonl" } as PipelineStageAttempt;
    // Controller-accepted output can lack a native agent creation receipt.
    await fs.rm(path.join(f.receipt, "commits", inherited));
    let accepted = inherited;
    if (proof !== "published") {
      accepted = await f.commit("later accepted output");
      f.pipeline.lastPassedCommit = accepted;
      await fs.rm(path.join(f.receipt, "commits", accepted));
      // A refused rewrite was the next launch's starting head. The repair
      // merges back the accepted head, including its published ancestors.
      await f.own("reset", "--hard", f.pipeline.baseRef);
      await f.commit("refused rewrite");
    } else f.pipeline.publishedCommit = inherited;
    let lost: PipelineStageAttempt | null = null;
    if (proof === "accepted replacement") {
      const launchId = `${childLaunch}-lost`;
      Object.assign(f.env, await prepareStageGitGuard(launchId, f.lane, realExec, "2026-10-16T09:45:00.000Z", async () => {}));
      lostLaunch = launchId;
      lost = { ...parent, n: 2, launchId, startedAt: "2026-10-16T09:45:00.000Z", completedAt: "2026-10-16T09:55:00.000Z",
        state: "failed", verdict: null, agentPath: "/stage/lost.jsonl", restartRecovery: { bootId: "lost-host", requestedAt: "2026-10-16T09:55:00.000Z",
          lastRecordAt: null, replacementAttempt: 3 } };
      await f.commit("lost attempt output");
    }
    const startedAt = "2026-10-16T10:00:00.000Z";
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, startedAt, async () => {}));
    const previous = lost ?? parent;
    const child = { ...f.attempt, n: lost ? 3 : 2, launchId: childLaunch, startedAt, state: "passed",
      agentPath: "/stage/later.jsonl", ...(proof !== "accepted" ? {
        restartContext: { previousAttempt: previous.n, transcriptPath: previous.agentPath, cause: "host-lost" },
      } : {}) } as PipelineStageAttempt;
    if (proof !== "published") await f.own("merge", "--no-ff", "-m", "restore accepted history", accepted);
    // A host that dies after the ref update skips post-commit; the receipt
    // its commit invocation wrote before the update proves it.
    let head = suffix === "host death" ? await commitThenDie(f, "later attempt output") : await f.commit("later attempt output");
    if (suffix === "unrecorded suffix") {
      // No receipt and no creation entry: the object is written outside a
      // commit command and HEAD reaches it by reset.
      const made = await realExec("git", ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "unrecorded suffix"], f.lane, f.env);
      expect(made.code, made.stderr).toBe(0);
      head = made.stdout.trim();
      await f.own("reset", "--hard", head);
    }
    if (suffix === "foreign suffix") {
      const foreign = path.join(f.root, "foreign-suffix");
      await f.own("worktree", "add", "--detach", foreign, head);
      await f.git(foreign, "commit", "--allow-empty", "-m", "unproved foreign suffix");
      head = await f.git(foreign, "rev-parse", "HEAD");
      await f.own("merge", "--ff-only", head);
    }
    if (suffix === "dropped history") {
      await f.own("reset", "--hard", f.pipeline.baseRef);
      head = await f.commit("dropped accepted history");
    }
    f.pipeline.repoDir = f.lane;
    f.pipeline.runs = [{ stageId: "build", attempts: lost ? [parent, lost, child] : [parent, child] }] as never;
    let raced = false;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if ((suffix === "remote race" || suffix === "head race") && !raced && command === "git" && args[0] === "rev-list") {
        raced = true;
        if (suffix === "remote race") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.pipeline.baseRef);
        else {
          const foreign = path.join(f.root, "raced-suffix");
          await f.own("worktree", "add", "--detach", foreign, head);
          await f.git(foreign, "commit", "--allow-empty", "-m", "raced foreign suffix");
          head = await f.git(foreign, "rev-parse", "HEAD");
          await f.own("merge", "--ff-only", head);
        }
      }
      return result;
    };
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, child, NOW);
    if (suffix === "valid" || suffix === "host death") {
      expect(result).toEqual({ ok: true, sha: head });
      expect(await f.own("merge-base", "--is-ancestor", inherited, "HEAD")).toBe("");
      expect(await f.own("ls-remote", "--refs", "origin", "refs/heads/pipeline/proof")).toBe(`${inherited}\trefs/heads/pipeline/proof`);
    } else {
      expect(result.ok).toBe(false);
      if (suffix === "remote race" || suffix === "head race") expect(raced).toBe(true);
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    if (lostLaunch) await fs.rm(stageGitReceiptDirectory(lostLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["another worktree", "hooks off", "missing receipt"] as const)(
  "a replacement cannot hide an unproved divergent starting prefix (%s)", async origin => {
    const f = await fixture();
    const lostLaunch = `stage-proof-divergent-lost-${nextFixture}`;
    const childLaunch = `stage-proof-divergent-child-${nextFixture}`;
    try {
      const accepted = await f.commit("accepted stage output");
      f.pipeline.lastPassedCommit = accepted;
      await fs.rm(path.join(f.receipt, "commits", accepted));
      await f.own("reset", "--hard", f.pipeline.baseRef);

      let divergent: string;
      if (origin === "another worktree") {
        const foreign = path.join(f.root, "divergent-worktree");
        await f.own("worktree", "add", "--detach", foreign, f.pipeline.baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "divergent prelaunch rewrite");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.own("fetch", foreign, divergent);
        await f.own("reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", "divergent prelaunch rewrite"];
        const made = await realExec("git", origin === "hooks off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane, origin === "hooks off" ? { ...f.env, PATH: process.env.PATH } : f.env);
        expect(made.code, made.stderr).toBe(0);
        divergent = await f.own("rev-parse", "HEAD");
        if (origin === "missing receipt") await fs.rm(path.join(f.receipt, "commits", divergent));
      }

      const lostStartedAt = "2026-10-16T09:30:00.000Z";
      Object.assign(f.env, await prepareStageGitGuard(lostLaunch, f.lane, realExec, lostStartedAt, async () => {}));
      const lost = { ...f.attempt, n: 1, launchId: lostLaunch, startedAt: lostStartedAt, completedAt: "2026-10-16T09:45:00.000Z",
        state: "failed", agentPath: "/stage/divergent-lost.jsonl", restartRecovery: { bootId: "lost-host",
          requestedAt: "2026-10-16T09:45:00.000Z", lastRecordAt: null, replacementAttempt: 2 } } as PipelineStageAttempt;
      const childStartedAt = "2026-10-16T10:00:00.000Z";
      Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, childStartedAt, async () => {}));
      const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: childStartedAt, completedAt: NOW,
        state: "passed", agentPath: "/stage/divergent-child.jsonl",
        restartContext: { previousAttempt: 1, transcriptPath: lost.agentPath, cause: "host-lost" } } as PipelineStageAttempt;
      await f.own("merge", "--no-ff", "-m", "restore accepted history", accepted);
      const head = await f.commit("replacement output");
      const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
      expect(pushed.code, pushed.stderr).toBe(0);
      f.pipeline.runs = [{ stageId: "build", attempts: [lost, child] }] as never;
      expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject({ ok: false });
      expect(await f.own("rev-parse", "HEAD")).toBe(head);
    } finally {
      await fs.rm(stageGitReceiptDirectory(lostLaunch), { recursive: true, force: true });
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      await f.close();
    }
  });

test.each(["another worktree", "hooks off", "missing receipt"] as const)(
  "an ordinary retry cannot publish an unproved starting prefix (%s)", async origin => {
    const f = await fixture();
    const childLaunch = `stage-proof-ordinary-retry-${nextFixture}`;
    try {
      const accepted = await f.commit("accepted output before retry");
      f.pipeline.lastPassedCommit = accepted;
      f.pipeline.publishedCommit = accepted;
      await f.push();
      await fs.rm(path.join(f.receipt, "commits", accepted));
      await f.own("reset", "--hard", f.pipeline.baseRef);

      let divergent: string;
      if (origin === "another worktree") {
        const foreign = path.join(f.root, "ordinary-retry-foreign");
        await f.own("worktree", "add", "--detach", foreign, f.pipeline.baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "ordinary retry foreign start");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.own("fetch", foreign, divergent);
        await f.own("reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", "ordinary retry divergent start"];
        const made = await realExec("git", origin === "hooks off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane, origin === "hooks off" ? { ...f.env, PATH: process.env.PATH } : f.env);
        expect(made.code, made.stderr).toBe(0);
        divergent = await f.own("rev-parse", "HEAD");
        if (origin === "missing receipt") await fs.rm(path.join(f.receipt, "commits", divergent));
      }

      Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
      await f.own("merge", "--no-ff", "-m", "restore the accepted boundary", accepted);
      const head = await f.commit("ordinary retry output");
      const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
      expect(pushed.code, pushed.stderr).toBe(0);
      const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
        agentPath: "/stage/ordinary-retry-parent.jsonl" } as PipelineStageAttempt;
      const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
        completedAt: NOW, state: "passed", agentPath: "/stage/ordinary-retry-child.jsonl" } as PipelineStageAttempt;
      f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

      expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject({ ok: false });
      expect(await f.own("ls-remote", "--refs", "origin", "refs/heads/pipeline/proof"))
        .toBe(`${head}\trefs/heads/pipeline/proof`);
    } finally {
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      await f.close();
    }
  });

test("an ordinary retry settles a recorded prefix from its failed predecessor", async () => {
  const f = await fixture();
  const childLaunch = `stage-proof-ordinary-recorded-retry-${nextFixture}`;
  try {
    const inherited = await f.commit("recorded predecessor output");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
      agentPath: "/stage/recorded-retry-parent.jsonl" } as PipelineStageAttempt;
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
      completedAt: NOW, state: "passed", agentPath: "/stage/recorded-retry-child.jsonl" } as PipelineStageAttempt;
    const head = await f.commit("ordinary retry continuation");
    await f.push();
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("merge-base", "--is-ancestor", inherited, "HEAD")).toBe("");
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test("an ordinary retry settles unpublished history receipted by an earlier passed attempt", async () => {
  const f = await fixture();
  const childLaunch = `stage-proof-passed-predecessor-retry-${nextFixture}`;
  try {
    const inherited = await f.commit("passed predecessor output");
    const parent = { ...f.attempt, n: 1, state: "passed", completedAt: "2026-10-16T09:30:00.000Z",
      verdict: { status: "pass", summary: "accepted by review" }, agentPath: "/stage/passed-predecessor.jsonl" } as PipelineStageAttempt;
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
      completedAt: NOW, state: "passed", agentPath: "/stage/passed-predecessor-retry.jsonl" } as PipelineStageAttempt;
    const head = await f.commit("retry output");
    await f.push();
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("merge-base", "--is-ancestor", inherited, head)).toBe("");
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test("four host-loss attempts preserve their receipt ancestry", async () => {
  const f = await fixture();
  const attempts: PipelineStageAttempt[] = [];
  const launches: string[] = [];
  try {
    for (let n = 1; n <= 4; n += 1) {
      const launchId = n === 1 ? f.attempt.launchId! : `stage-proof-chain-${nextFixture}-${n}`;
      const startedAt = n === 1 ? START : `2026-10-16T${String(8 + n).padStart(2, "0")}:00:00.000Z`;
      if (n > 1) {
        launches.push(launchId);
        Object.assign(f.env, await prepareStageGitGuard(launchId, f.lane, realExec, startedAt, async () => {}));
      }
      const attempt = { ...f.attempt, n, launchId, startedAt, completedAt: `2026-10-16T${String(8 + n).padStart(2, "0")}:30:00.000Z`,
        state: n === 4 ? "passed" : "failed", agentPath: `/stage/chain-${n}.jsonl`,
        ...(n === 1 ? {} : { restartContext: { previousAttempt: n - 1, transcriptPath: attempts[n - 2]!.agentPath, cause: "host-lost" } })
      } as PipelineStageAttempt;
      if (n < 4) attempt.restartRecovery = { bootId: `lost-host-${n}`, requestedAt: attempt.completedAt!, lastRecordAt: null,
        replacementAttempt: n + 1 };
      attempts.push(attempt);
      await f.commit(`attempt ${n} output`);
    }
    const head = await f.own("rev-parse", "HEAD");
    f.pipeline.runs = [{ stageId: "build", attempts }] as never;
    await f.push();
    expect(await settleStageAttemptPush(f.pipeline, attempts[3]!, realExec, NOW)).toEqual({ ok: true, sha: head });
  } finally {
    for (const launchId of launches) await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true });
    await f.close();
  }
});

// Issue #3158: an account usage guard failed a replacement whose launch had
// been refused for capacity, so it never reserved a launch, and replaced it.
// Pin both a short chain and the observed attempt-72 scale. Every skipped
// attempt must preserve lineage without authorizing unreceipted commits.
test.each([1, 70].flatMap(count =>
  (["settles", "forged transcript edge", "unreceipted commit"] as const).map(variant => [count, variant] as const),
))("a usage-guard chain through %i never-launched attempts: %s", async (refusedCount, variant) => {
  const f = await fixture();
  const childLaunch = `stage-proof-guard-chain-${nextFixture}`;
  try {
    await f.commit("first attempt output");
    const first = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:00:00.000Z",
      agentPath: "/stage/guard-1.jsonl", error: "the stage account reached its usage or paid-credit guard" } as PipelineStageAttempt;
    const refused = { ...f.attempt, n: 2, state: "failed", launchId: null, conversationId: null, agentPath: null, paneId: null,
      startedAt: "2026-10-16T09:05:00.000Z", completedAt: "2026-10-16T09:06:00.000Z",
      error: "the stage account reached its usage or paid-credit guard",
      restartContext: { previousAttempt: 1, transcriptPath: first.agentPath } } as PipelineStageAttempt;
    if (variant === "unreceipted commit") {
      // This writer lacks the launch guard entirely. A guard that still runs
      // with missing bindings is refused and diagnosed by the cases below.
      const outside: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0", PATH: process.env.PATH };
      delete outside.LLV_STAGE_GIT_RECEIPT;
      delete outside.LLV_STAGE_GIT_WORKTREE;
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "made while no attempt ran"], f.lane, outside);
      expect(made.code, made.stderr).toBe(0);
    }
    const foreign = await f.own("rev-parse", "HEAD");
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const refusedAttempts = Array.from({ length: refusedCount }, (_, index) => ({
      ...refused, n: index + 2,
      restartContext: index === 0 ? refused.restartContext : { previousAttempt: index + 1, transcriptPath: null },
      restartRecovery: { bootId: "guard-stop", requestedAt: refused.completedAt!, lastRecordAt: null,
        replacementAttempt: index + 3 },
    } as PipelineStageAttempt));
    const child = { ...f.attempt, n: refusedCount + 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z", completedAt: NOW,
      state: "passed", agentPath: "/stage/guard-3.jsonl",
      restartContext: { previousAttempt: refusedCount + 1, transcriptPath: variant === "forged transcript edge" ? first.agentPath : null } } as PipelineStageAttempt;
    const head = await f.commit("replacement output after the reset");
    f.pipeline.runs = [{ stageId: "build", attempts: [first, ...refusedAttempts, child] }] as never;
    await f.push();
    const result = await settleStageAttemptPush(f.pipeline, child, realExec, NOW);
    if (variant === "settles") expect(result).toEqual({ ok: true, sha: head });
    else if (variant === "forged transcript edge") expect(result).toMatchObject({ ok: false, error: expect.stringContaining("creation lineage is invalid") });
    else expect(result).toMatchObject({ ok: false, error: expect.stringContaining(foreign) });
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});
