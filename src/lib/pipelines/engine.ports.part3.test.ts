import "./engineEnvironment.fixture";
import { expect, spyOn, test, crypto, spawn, fs, path, accountManager, realExec, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, loadPipelines, savePipelines, pipelineIdentity, finishReported, realWorktreeLane } from "./engine.fixture";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";

async function detachedAttemptFixture(name: string) {
  const f = await realWorktreeLane(name, [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  const lane = loadPipelines().find(p => p.id === f.id)!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.launchId = `launch-${lane.id}`;
  savePipelines([lane]);
  const receipt = path.join(process.env.LLV_STATE_DIR!, "pipeline-git-attempts",
    crypto.createHash("sha256").update(attempt.launchId!).digest("hex"));
  fs.mkdirSync(receipt, { recursive: true });
  fs.writeFileSync(path.join(receipt, "base"), f.base);
  fs.writeFileSync(path.join(receipt, "start.json"), JSON.stringify({ launchId: attempt.launchId,
    worktree: f.worktree, head: f.base, startedAt: attempt.startedAt }));
  const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
  const source = { ...process.env, HOME: f.root, LLV_STAGE_GIT_RECEIPT: receipt, LLV_STAGE_GIT_WORKTREE: f.worktree };
  const env: NodeJS.ProcessEnv = { ...source, ...agentPublicationIdentityEnv(source),
    GIT_AUTHOR_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString(),
    GIT_COMMITTER_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString() };
  const detached = path.join(f.root, "detached");
  await f.git(f.worktree, "worktree", "add", "--detach", detached, f.base);
  const run = async (...args: string[]) => {
    const r = await realExec("git", args, detached, env);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = async (content = "attempt fix\n") => {
    fs.writeFileSync(path.join(detached, "fix.txt"), content);
    await run("add", "fix.txt");
    await run("commit", "-m", "attempt fix");
    return await run("rev-parse", "HEAD");
  };
  const finish = async () => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", "Fixed")], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  return { ...f, lane, attempt, receipt, env, detached, run, commit, finish };
}



test.each([256, 257])("attempt Git custody accepts every proved suffix commit (%i)", async (count) => {
  const f = await detachedAttemptFixture(`attempt-git-bound-${count}`);
  try {
    for (let n = 0; n < count; n++) await f.run("commit", "--allow-empty", "-m", `attempt change ${n}`);
    const fixed = await f.run("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const settled = await f.finish();
    expect(settled.lastPassedCommit).toBe(fixed);
    expect(settled.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 120_000);



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



for (const stallMs of [0, 27_000]) test(`refresh completion advances its parent through the controller after a ${stallMs}ms stall`, async () => {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `${stallMs === 0 ? "10000000" : "20000000"}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const fixture = await realWorktreeLane("refresh-controller", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Refresh", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review resolution", next: null, onFail: { to: "build", maxRounds: 1 } },
  ]).finally(() => ids.mockRestore());
  try {
    const { h, id, worktree, git, base } = fixture;
    fs.writeFileSync(path.join(worktree, "resolution.txt"), "both sides preserved\n");
    await git(worktree, "add", "resolution.txt");
    await git(worktree, "commit", "-m", "Preserve the refresh resolution");
    const head = await git(worktree, "rev-parse", "HEAD");
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    const child = loadPipelines().find(lane => lane.id === id)!;
    child.delivery = { target: { repository: child.project, remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${child.branch}`, pr: 11 },
      disposition: "owner", publish: "disabled", ownerId: id, epoch: 2, active: false, journal: [] };
    child.refreshOf = { pipelineId: "original", base };
    const parent = structuredClone(child);
    Object.assign(parent, { id: "original", state: "completed", cursor: null, closedAt: h.ports.now(), lastPassedCommit: base });
    Object.assign(parent, pipelineIdentity(parent.id, parent.task, parent.repoDir));
    delete parent.refreshOf;
    parent.runs.forEach(run => run.attempts.forEach(attempt => { attempt.state = "passed"; }));
    parent.delivery!.active = false;
    parent.delivery!.ownerId = parent.id;
    const { mergeAdmission, productionAutoMergePorts, sweepAutoMerge, resetAutoMergeForTests, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
    const { FlowPipelineController } = await import("./controller");
    resetAutoMergeForTests();
    let clock = Date.parse(h.ports.now());
    const setting = () => ({ enabled: true, changedAt: new Date(0).toISOString(), changedBy: "operator" as const });
    const admitted = mergeAdmission(parent, clock, { setting, pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }) });
    if (!("merge" in admitted)) throw new Error(admitted.reason);
    parent.merge = admitted.merge;
    parent.merge.state = "refreshing";
    parent.merge.refresh = { attempt: 0, base, head: base, key: "controller-refresh", digest: "c".repeat(64), requestedAt: new Date(clock).toISOString(), pipelineId: id };
    const { isStoredPipeline } = await import("./store");
    expect({ parent: isStoredPipeline(parent), child: isStoredPipeline(child) }).toEqual({ parent: true, child: true });
    savePipelines([parent, child]);
    let merged = false, pending = false;
    const writes: string[][] = [];
    const ports = productionAutoMergePorts({ now: () => clock, loadPipelines, setting, cachedState: () => null, log: () => undefined,
      run: async args => {
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: pending ? "IN_PROGRESS" : "COMPLETED", conclusion: pending ? "" : "SUCCESS" }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? new Date(clock).toISOString() : null,
        });
        if (args[0] === "api" && args[1]?.includes("/reviews")) return "";
        if (args[0] === "api" && args[1]?.includes("/branches/")) return '["ci"]';
        if (args[0] === "repo") return '{"squashMergeAllowed":true}';
        throw new Error(`unexpected forge read ${args.join(" ")}`);
      },
      write: async args => { writes.push(args); merged = true; return ""; },
    });
    let events = [h.finish("/codex/stage-2.jsonl", "pass")];
    let sweep = Promise.resolve();
    const controller = new FlowPipelineController({ now: () => clock, monotonicNow: () => 0,
      tickPipelines: async () => {
        const entries = events; events = [];
        const result = await tickPipelines(entries, h.ports);
        // Model a Viewer stall after completion was persisted, before the global sweep.
        if (entries.length) clock += stallMs;
        return result;
      },
      tickFlows: async () => ({ changed: false }),
      sweepAutoMerge: () => { sweep = sweepAutoMerge(ports); },
    }, { maxPasses: 1 });
    const tick = async () => { await controller.tick(); await sweep; };
    pending = true;
    await tick();
    expect(loadPipelines().find(lane => lane.id === id)?.state).toBe("completed");
    await tick();
    expect(loadPipelines().find(lane => lane.id === "original")?.merge?.state).toBe("waiting-checks");
    expect(writes).toHaveLength(0);
    pending = false;
    for (let poll = 0; poll < 7; poll++) { clock += MERGE_POLL_MS; await tick(); }
    expect(loadPipelines().find(lane => lane.id === "original")?.merge).toMatchObject({ state: "merged", mergedHead: head });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(head);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
