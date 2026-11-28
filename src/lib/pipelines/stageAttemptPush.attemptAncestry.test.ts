import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import type { PipelineStageAttempt } from "./types";
import { START, NOW, nextFixture, fixture, commitThenDie } from "./stageAttemptPush.fixture";

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
