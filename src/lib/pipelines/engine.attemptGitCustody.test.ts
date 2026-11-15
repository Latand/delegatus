import "./engineEnvironment.fixture";
import { expect, spyOn, test, spawn, fs, path, accountManager, realExec, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, loadPipelines, savePipelines } from "./engine.fixture";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { detachedAttemptFixture } from "./engine.attemptGit.fixture";

test("attempt Git custody rechecks activation after preparing the native guard", async () => {
  const f = await detachedAttemptFixture("attempt-git-activation-recheck");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "guard-activation-registry.json"));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({ kind: "available", account: {
    engine: "codex", accountId: "guard-account", kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" },
  }}));
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockResolvedValue({ path: null } as never);
  let reservations = 0;
  let launchId: string | null = null;
  try {
    await expect(defaultPipelinePorts().spawnAgent(f.h.spawnInputs[0]!, r => {
      launchId = r.launchId;
      if (++reservations === 2) throw new Error("activation paused while Git guard was prepared");
    })).rejects.toThrow("activation paused while Git guard was prepared");
    expect(reservations).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(registry.spawnReceipt(launchId!)?.state).toBe("failed");
  } finally {
    resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
    savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("attempt Git custody retries an unavailable remote before accepting the stage", async () => {
  const f = await detachedAttemptFixture("attempt-git-unavailable");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    let available = false;
    const exec = f.h.ports.exec;
    f.h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "ls-remote" && !available
      ? { code: 128, stdout: "", stderr: "fixture remote unavailable" } : exec(command, args, ...rest);
    const waiting = await f.finish();
    expect(waiting.state).toBe("running");
    expect(waiting.cursor?.state).toBe("committing");
    expect(waiting.lastPassedCommit).toBe(f.base);
    expect(waiting.stateDetail).toContain("waiting for the delivery remote");
    available = true;
    await tickPipelines([], f.h.ports);
    const accepted = loadPipelines().find(p => p.id === f.id)!;
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody refuses a commit outside its owned scratch scope", async () => {
  const f = await detachedAttemptFixture("attempt-git-foreign-checkout");
  try {
    const scratch = path.join(f.root, "owned-scratch");
    fs.mkdirSync(scratch);
    f.env.TMPDIR = scratch;
    const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
    Object.assign(f.env, agentPublicationIdentityEnv(f.env));
    await f.commit();
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("stage push refused");
    expect((await f.finish()).lastPassedCommit).toBe(f.base);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody restores report provenance after an interrupted fast-forward", async () => {
  const f = await detachedAttemptFixture("attempt-git-report-replay");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    const stored = loadPipelines().find(p => p.id === f.id)!;
    const attempt = stored.runs[0]!.attempts[0]!;
    attempt.state = "committing";
    attempt.verdict = { status: "pass" };
    attempt.report!.provenance = { ...attempt.report!.provenance, state: "complete", head: f.base };
    stored.cursor!.state = "committing";
    savePipelines([stored]);
    // The Git effect survived; the controller's final row write did not.
    await f.git(f.worktree, "merge", "--ff-only", fixed);
    await tickPipelines([], f.h.ports);
    const accepted = loadPipelines().find(p => p.id === f.id)!;
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.runs[0]!.attempts[0]!.report?.provenance.head).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["outside", "mixed", "malformed"] as const)("attempt Git custody revalidates full proof after a fast-forward replay: %s", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-adopted-${shape}`);
  try {
    let candidate: string;
    if (shape === "outside") {
      const date = new Date(Date.parse(f.attempt.startedAt!) + 1000).toISOString();
      const result = await realExec("git", ["commit", "--allow-empty", "-m", "outside commit"], f.detached,
        { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      expect(result.code, result.stderr).toBe(0);
      candidate = (await f.git(f.detached, "rev-parse", "HEAD"));
    } else {
      candidate = await f.commit();
      if (shape === "mixed") {
        const date = new Date(Date.parse(f.attempt.startedAt!) + 2000).toISOString();
        const result = await realExec("git", ["commit", "--allow-empty", "-m", "outside ancestor"], f.detached,
          { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
        expect(result.code, result.stderr).toBe(0);
        candidate = (await f.git(f.detached, "rev-parse", "HEAD"));
      }
    }
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.worktree, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    if (shape === "malformed") fs.writeFileSync(path.join(f.receipt, "commits", candidate), "not an empty receipt");
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("settling the stage push");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(candidate);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["unchanged", "absent"] as const)("attempt Git custody refuses an unconfirmed recorded candidate on an %s remote branch", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-unconfirmed-${shape}`);
  try {
    const candidate = await f.commit();
    await f.git(f.origin, "update-ref", `refs/heads/${f.lane.branch}`, f.base);
    if (shape === "absent") await f.git(f.origin, "update-ref", "-d", `refs/heads/${f.lane.branch}`);
    // Model the hook's durable write before the repository hook or transport
    // refusal. Preserve that candidate while the delivery tip stays put.
    fs.mkdirSync(path.join(f.receipt, "pushes"), { recursive: true });
    fs.writeFileSync(path.join(f.receipt, "pushes", candidate), `refs/heads/${f.lane.branch}\n${f.origin}\n`);
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("recorded push candidate was not confirmed");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    if (shape === "unchanged") expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(f.base);
    else {
      const branch = await realExec("git", ["show-ref", "--verify", `refs/heads/${f.lane.branch}`], f.origin);
      expect(branch.code).not.toBe(0);
    }
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["outside", "mixed"] as const)("attempt Git custody refuses a no-receipt remote suffix containing %s commits", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-no-receipt-${shape}`);
  try {
    if (shape === "mixed") await f.commit();
    const date = new Date(Date.parse(f.attempt.startedAt!) + 2000).toISOString();
    const foreign = await realExec("git", ["commit", "--allow-empty", "-m", "outside commit"], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    expect(foreign.code, foreign.stderr).toBe(0);
    const candidate = await f.git(f.detached, "rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0" });
    expect(pushed.code, pushed.stderr).toBe(0);
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("settling the stage push");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(candidate);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody settles a proved local commit without a remote push", async () => {
  const f = await detachedAttemptFixture("attempt-git-unpublished-local");
  try {
    const candidate = await f.commit();
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(candidate);
    expect(accepted.cursor?.stageId).toBe("review");
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody refuses a later rejected candidate despite an earlier confirmed push", async () => {
  const f = await detachedAttemptFixture("attempt-git-rejected-later-candidate");
  try {
    const first = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const second = await f.commit("attempt fix two\n");
    const hook = path.join(f.origin, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const rejected = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(rejected.code).not.toBe(0);
    fs.rmSync(hook);
    const refused = await f.finish();
    expect(refused.state).toBe("needs_decision");
    expect(refused.stateDetail).toContain("recorded push candidate was not confirmed");
    expect(refused.lastPassedCommit).toBe(f.base);
    expect(refused.cursor?.stageId).toBe("build");
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(first);
    expect(second).not.toBe(first);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody settles the later candidate after a rejected push is retried", async () => {
  const f = await detachedAttemptFixture("attempt-git-retried-later-candidate");
  try {
    await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const second = await f.commit("attempt fix two\n");
    const hook = path.join(f.origin, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const rejected = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(rejected.code).not.toBe(0);
    fs.rmSync(hook);
    expect(await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`)).toBe("");
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(second);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});
