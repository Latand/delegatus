// Pre-S5 embedded-flow execution cases stay as history until S8 deletion.
// Supported run-reviewer cases and flows/retirement.test.ts remain active.
import { startAutoAndSettle } from "./engineEnvironment.fixture";
import { expect, spyOn, test, crypto, spawn, fs, os, path, activeDrain, DRAIN_LEASE_MS, initialAuto, writeAuto, initialCheck, SelfUpdateService, idleCheck, accountManager, realExec, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, newRound, tickFlow, saveFlows, createPipelineFromRequest, registerPipelineTick, loadPipelines, savePipelines, pipelineIdentity, pipelineRevision, patchPipeline, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, REMOTE_BRANCH, finishReported, realWorktreeLane, create, publishHarness, PUBLISH_STAGES } from "./engine.fixture";
import type { ServiceDeps, Snapshot } from "./engine.fixture";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { shortId } from "@/lib/shortIds";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";

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


test("a rebased builder reconciles accepted content and continues with fast-forward delivery", async () => {
  const fixture = await realWorktreeLane("rebase-reconcile", [
    { id: "brief", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Brief", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, repo, origin, worktree } = fixture;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, ".gitignore"), "accepted-rule\n");
    fs.writeFileSync(path.join(worktree, "brief.md"), "accepted brief\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const accepted = loadPipelines().find((item) => item.id === id)!.lastPassedCommit;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(accepted);
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(repo, "main.txt"), "new main\n");
    fs.writeFileSync(path.join(repo, "asset.bin"), crypto.randomBytes(1_200_000));
    (await git(repo, "add", "main.txt"));
    (await git(repo, "add", "asset.bin"));
    (await git(repo, "commit", "-m", "advance main"));
    (await git(repo, "push", "origin", "main"));
    (await git(worktree, "rebase", "origin/main"));
    fs.appendFileSync(path.join(worktree, ".gitignore"), "builder-rule\n");
    fs.appendFileSync(path.join(worktree, "brief.md"), "builder elaboration\n");
    fs.writeFileSync(path.join(worktree, "build.txt"), "builder content\n");
    (await git(worktree, "add", ".gitignore", "brief.md", "build.txt"));
    (await git(worktree, "commit", "-m", "build after rebase"));
    const rebased = (await git(worktree, "rev-parse", "HEAD"));
    const tree = (await git(worktree, "rev-parse", "HEAD^{tree}"));

    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);

    const current = loadPipelines().find((item) => item.id === id)!;
    expect(current.state).toBe("running");
    expect(current.cursor?.stageId).toBe("review");
    const reconciled = current.lastPassedCommit;
    expect((await git(worktree, "rev-parse", `${reconciled}^{tree}`))).toBe(tree);
    expect((await git(worktree, "rev-list", "--parents", "-n", "1", reconciled))).toBe(`${reconciled} ${rebased} ${accepted}`);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(reconciled);
    expect(current.publishedCommit).toBe(reconciled);
    for (let n = 0; n < 4 && h.spawnInputs.length < 3; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(3);
    await tickPipelines([h.finish("/codex/stage-3.jsonl", "pass")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.state).toBe("completed");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test.each(["fenced verdict", "reported plus fenced completion"])("a fixer preserves an explicit current blocker when another check passed on head (%s)", async (settlement) => {
  const fixture = await realWorktreeLane("fixer-current-blocker", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  try {
    const { h, git, worktree, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fix committed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "committed partial fix");
    const lane = loadPipelines()[0]!;
    if (settlement === "reported plus fenced completion") {
      lane.runs[0]!.attempts[0]!.report = {
        seq: 1,
        at: h.ports.now(),
        actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
        verdict: { status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] },
        summary: "Blocked: required integration tests failed on base and still fail on head. TypeScript passed on head.",
        provenance: { head: await git(worktree, "rev-parse", "HEAD"), branch: lane.branch, uncommitted: [], pullRequest: null, outputs: [] },
        calls: 1,
      };
      savePipelines([lane]);
    }
    h.setConversationActive(false);
    const summary = "Blocked: required integration tests failed on base and still fail on head. TypeScript passed on head.";
    const verdict = `\n\`\`\`json\n${JSON.stringify({ status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] })}\n\`\`\``;
    h.messages.set("/codex/stage-1.jsonl", { text: `${summary}${verdict}`, ts: Date.now() + 100_000_000 });
    if (settlement === "reported plus fenced completion") {
      const message = h.messages.get("/codex/stage-1.jsonl")!;
      h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: message.ts, message });
    }
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.cursor?.stageId).toBe("fix");
    expect(current.lastPassedCommit).toBe(base);
    expect(current.runs[0]!.attempts[0]!.output).toContain("Blocked: required integration tests");
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("a fenced fixer verdict keeps a blocker after the bounded relay output", async () => {
  const fixture = await realWorktreeLane("fixer-blocker-after-relay-limit", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review {{prev.output}}", next: null },
  ]);
  try {
    const { h, git, worktree, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fix committed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "committed partial fix");
    const summary = `${"Verification details recorded. ".repeat(1200)}Blocked: cannot run required integration checks.`;
    h.setConversationActive(false);
    h.messages.set("/codex/stage-1.jsonl", {
      text: `${summary}\n\`\`\`json\n${JSON.stringify({ status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] })}\n\`\`\``,
      ts: Date.now() + 100_000_000,
    });
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.cursor?.stageId).toBe("fix");
    expect(current.lastPassedCommit).toBe(base);
    expect(current.cursor?.stageId).not.toBe("review");
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("rewritten builder history parks with the dropped accepted commit and preserves delivery", async () => {
  const fixture = await realWorktreeLane("rebase-dropped", [
    { id: "brief", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Brief", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, repo, origin, worktree } = fixture;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "dropped.md"), "accepted content\n");
    (await git(worktree, "add", "dropped.md"));
    (await git(worktree, "commit", "-m", "accepted requirement"));
    const dropped = (await git(worktree, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(worktree, "kept.md"), "kept content\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const accepted = loadPipelines().find((item) => item.id === id)!.lastPassedCommit;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(repo, "main.txt"), "new main\n");
    (await git(repo, "add", "main.txt"));
    (await git(repo, "commit", "-m", "advance main"));
    (await git(repo, "push", "origin", "main"));
    (await git(worktree, "rebase", "--onto", "origin/main", dropped));
    const rewritten = (await git(worktree, "rev-parse", "HEAD"));

    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);

    const parked = loadPipelines().find((item) => item.id === id)!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("dropped accepted commits");
    expect(parked.stateDetail).toContain(shortId(dropped));
    expect(parked.stateDetail).not.toContain(`dropped accepted commits: ${accepted}`);
    expect(parked.lastPassedCommit).toBe(accepted);
    expect((await git(worktree, "rev-parse", "HEAD"))).toBe(rewritten);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(accepted);
    expect(h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("an owner publishes a review-fix commit before the passing review starts", async () => {
  const fixture = await realWorktreeLane("owner-review-fix", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null, onFail: { to: "review-fix", maxRounds: 2 } },
    { id: "review-fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
  ], undefined, false, true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "work.txt"), "build\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const built = (await git(worktree, "rev-parse", "HEAD"));
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(built);
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail")], h.ports);
    for (let n = 0; n < 4 && h.spawnInputs.length < 3; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(3);
    fs.writeFileSync(path.join(worktree, "work.txt"), "fixed\n");
    const offline = `${origin}.offline`;
    fs.renameSync(origin, offline);
    await tickPipelines([h.finish("/codex/stage-3.jsonl", "pass")], h.ports);
    const fixed = (await git(worktree, "rev-parse", "HEAD"));
    expect(fixed).not.toBe(built);
    expect(loadPipelines().find((item) => item.id === id)).toMatchObject({
      state: "running", cursor: { stageId: "review-fix", state: "committing" }, lastPassedCommit: fixed,
    });
    expect(h.spawnInputs).toHaveLength(3);
    fs.renameSync(offline, origin);
    await tickPipelines([], h.ports);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(fixed);
    for (let n = 0; n < 4 && h.spawnInputs.length < 4; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(4);
    await tickPipelines([h.finish("/codex/stage-4.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed).toMatchObject({ state: "completed", lastPassedCommit: fixed, publishedCommit: fixed });
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(completed.lastPassedCommit);
  } finally {
    savePipelines([]);
    if (fs.existsSync(`${fixture.origin}.offline`)) fs.renameSync(`${fixture.origin}.offline`, fixture.origin);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("an owner keeps a terminal read-only declared output local after publishing its builder head", async () => {
  const fixture = await realWorktreeLane("owner-review-output", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", outputs: ["review.md"], prompt: "Review", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "work.txt"), "build\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const built = (await git(origin, "rev-parse", `refs/heads/${branch}`));
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(worktree, "review.md"), "approved\n");
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed.state).toBe("completed");
    expect(completed.lastPassedCommit).not.toBe(built);
    expect(completed.publishedCommit).toBe(built);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(built);
    expect(completed.runs[1]!.attempts[0]!.outputBaseHead).toBe(built);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("skip carries a committed fix into review and completion without touching ignored work", async () => {
  const fixture = await realWorktreeLane("skip-keeps-fix", [
    { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ]);
  try {
    const { h, git, worktree, id, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "accepted fix\n");
    fs.writeFileSync(path.join(worktree, "sentinel.tmp"), "untouched\n");
    (await git(worktree, "add", "fix.txt"));
    (await git(worktree, "commit", "-m", "fix B"));
    const fixed = (await git(worktree, "rev-parse", "HEAD"));
    expect(fixed).not.toBe(base);
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.state).toBe("needs_decision");
    expect((await patchPipeline(id, { action: "skip-stage" }, h.ports)).error).toBeUndefined();
    expect(loadPipelines().find((item) => item.id === id)!).toMatchObject({
      lastPassedCommit: fixed, cursor: { stageId: "review", state: "pending" },
    });
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
    expect((await git(worktree, "rev-parse", "HEAD"))).toBe(fixed);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!).toMatchObject({ state: "completed", lastPassedCommit: fixed, cursor: null });
    expect(fs.readFileSync(path.join(worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("remote skip publishes the accepted head before its reviewer can start", async () => {
  const fixture = await realWorktreeLane("remote-skip", [
    { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  try {
    fs.writeFileSync(path.join(fixture.worktree, "fix.txt"), "accepted\n");
    (await fixture.git(fixture.worktree, "add", "fix.txt"));
    (await fixture.git(fixture.worktree, "commit", "-m", "accepted fix"));
    const accepted = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "needs_decision")], fixture.h.ports);
    expect((await patchPipeline(fixture.id, { action: "skip-stage" }, fixture.h.ports)).error).toBeUndefined();
    const waiting = loadPipelines().find((item) => item.id === fixture.id)!;
    expect(waiting).toMatchObject({ lastPassedCommit: accepted, cursor: { stageId: "fix", state: "committing" } });
    expect(waiting.runs[0]!.attempts[0]!.state).toBe("skipped");
    expect(fixture.h.spawnInputs).toHaveLength(1);
    expect(waiting.delivery!.operation!.state).toBe("pending");
    await tickPipelines([], fixture.h.ports);
    expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${waiting.branch}`))).toBe(accepted);
    expect(loadPipelines().find((item) => item.id === fixture.id)!.cursor?.stageId).toBe("review");
    await tickPipelines([], fixture.h.ports);
    expect(fixture.h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


for (const completion of ["pass", "skip"] as const) {
  test(`an unreachable remote keeps a ${completion} successor behind the accepted head`, async () => {
    const fixture = await realWorktreeLane(`remote-${completion}-outage`, [
      { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
    ], "remote-branch");
    const offline = `${fixture.origin}.offline`;
    try {
      fs.writeFileSync(path.join(fixture.worktree, "fix.txt"), "accepted\n");
      if (completion === "skip") {
        (await fixture.git(fixture.worktree, "add", "fix.txt"));
        (await fixture.git(fixture.worktree, "commit", "-m", "accepted fix"));
      }
      fixture.h.setConversationActive(false);
      fs.renameSync(fixture.origin, offline);
      await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", completion === "pass" ? "pass" : "needs_decision")], fixture.h.ports);
      if (completion === "skip") {
        expect((await patchPipeline(fixture.id, { action: "skip-stage" }, fixture.h.ports)).error).toBeUndefined();
      }
      await tickPipelines([], fixture.h.ports);
      const waiting = loadPipelines().find((item) => item.id === fixture.id)!;
      const accepted = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
      expect(waiting.lastPassedCommit).toBe(accepted);
      expect(waiting.publishedCommit).toBeNull();
      expect(waiting.cursor).toMatchObject({ stageId: "fix", state: "committing" });
      expect(fixture.h.spawnInputs).toHaveLength(1);
      fs.renameSync(offline, fixture.origin);
      await tickPipelines([], fixture.h.ports);
      await tickPipelines([], fixture.h.ports);
      expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${waiting.branch}`))).toBe(accepted);
      expect(fixture.h.spawnInputs).toHaveLength(2);
    } finally {
      savePipelines([]);
      if (fs.existsSync(offline)) fs.renameSync(offline, fixture.origin);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}


test("ordinary retry leaves dirty work for the next attempt", async () => {
  const fixture = await realWorktreeLane("retry-keeps-dirty", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ]);
  try {
    fs.writeFileSync(path.join(fixture.worktree, "draft.txt"), "unfinished\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "fail")], fixture.h.ports);
    expect((await patchPipeline(fixture.id, { action: "retry-stage" }, fixture.h.ports)).error).toBeUndefined();
    expect(fs.readFileSync(path.join(fixture.worktree, "draft.txt"), "utf8")).toBe("unfinished\n");
    await tickPipelines([], fixture.h.ports);
    expect(fixture.h.spawnInputs).toHaveLength(2);
    expect((await fixture.git(fixture.worktree, "rev-parse", "HEAD"))).toBe(fixture.base);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("a read-only architect pass commits its declared fix output through settlement", async () => {
  const fixture = await realWorktreeLane("architect-output", [
    { id: "fix", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["reports/fix.md"], prompt: "Write the fix", next: null },
  ]);
  try {
    fs.mkdirSync(path.join(fixture.worktree, "reports"));
    fs.writeFileSync(path.join(fixture.worktree, "reports", "fix.md"), "declared result\n");
    fs.writeFileSync(path.join(fixture.worktree, "sentinel.tmp"), "untouched\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "pass")], fixture.h.ports);
    const current = loadPipelines().find((item) => item.id === fixture.id)!;
    expect(current.state).toBe("completed");
    expect(current.lastPassedCommit).not.toBe(fixture.base);
    expect((await fixture.git(fixture.worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("reports/fix.md");
    expect(fs.readFileSync(path.join(fixture.worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("fallback verdict preserves the pre-output PR head through real settlement and merge", async () => {
  const fixture = await realWorktreeLane("fallback-output-merge", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "critique" },
    { id: "critique", kind: "run", role: { roleId: "reviewer" }, access: "read-only", outputs: ["report.md"], prompt: "Review", next: null, onFail: { to: "build", maxRounds: 2 } },
  ]);
  try {
    const { git, h, id, worktree } = fixture;
    const admitted = loadPipelines().find((item) => item.id === id)!;
    admitted.delivery = {
      target: { repository: "acme/widgets", remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${admitted.branch}`, pr: 11 },
      disposition: "owner", publish: "disabled", ownerId: id, epoch: 1, active: false, journal: [],
    };
    savePipelines([admitted]);
    fs.writeFileSync(path.join(worktree, "build.txt"), "accepted build\n");
    (await git(worktree, "add", "build.txt"));
    (await git(worktree, "commit", "-m", "accepted build"));
    const prHead = (await git(worktree, "rev-parse", "HEAD"));
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(worktree, "report.md"), "review passed\n");
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed.state).toBe("completed");
    expect(completed.lastPassedCommit).not.toBe(prHead);
    expect(completed.runs[1]!.attempts[0]!.report).toBeUndefined();
    expect(completed.runs[1]!.attempts[0]!.outputBaseHead).toBe(prHead);
    savePipelines([completed]);
    expect(loadPipelines().find((item) => item.id === id)!.runs[1]!.attempts[0]!.outputBaseHead).toBe(prHead);

    const { productionAutoMergePorts, MERGE_POLL_MS, MERGE_SETTLE_MS, MERGE_REASONS, lanePullRequest, mergeEligible, sweepAutoMerge } = await import("@/lib/forge/autoMerge");
    expect(mergeEligible(loadPipelines().find((item) => item.id === id)!)).toBe(true);
    expect(lanePullRequest(loadPipelines().find((item) => item.id === id)!)).toEqual({ repository: "acme/widgets", number: 11 });
    let clock = Date.parse(completed.closedAt!) + 1_000;
    let merged = false;
    const calls: string[][] = [];
    const ports = productionAutoMergePorts({
      now: () => clock,
      loadPipelines,
      setting: () => ({ enabled: true, changedAt: new Date(0).toISOString(), changedBy: "operator" }),
      cachedState: () => null,
      log: () => undefined,
      run: async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: prHead, baseRefName: "main",
          mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: completed.closedAt }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? new Date(clock).toISOString() : null,
        });
        if (args[0] === "api" && args[1] === "repos/acme/widgets/branches/main") return "[]";
        if (args[0] === "api" && args[1] === "repos/acme/widgets/pulls/11/reviews?per_page=100") return "";
        if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
        if (args[0] === "pr" && args[1] === "merge") { merged = true; return ""; }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    });
    /* The fake `gh` above stands in for the App write seam as well: no token is minted. */
    ports.write = (args) => ports.run(args);
    for (let poll = 0; poll < Math.ceil(MERGE_SETTLE_MS / MERGE_POLL_MS) + 3; poll += 1) {
      await sweepAutoMerge(ports);
      clock += MERGE_POLL_MS;
    }
    const settled = loadPipelines().find((item) => item.id === id)!;
    expect(settled.merge?.reason).not.toBe(MERGE_REASONS.headChanged);
    expect(settled.merge?.state).toBe("merged");
    expect(settled.merge?.chain).toEqual([prHead]);
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "merge")).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test.skip("a skipped legacy architect publishes its declared output to the review flow", async () => {
  const fixture = await realWorktreeLane("legacy-architect-skip-review", [
    { id: "architect", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["fix.txt"], prompt: "Write fix", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review fix", next: null },
  ], "remote-branch", true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    expect(loadPipelines().find((item) => item.id === id)!.stages[1]!.kind).toBe("review-loop");
    fs.writeFileSync(path.join(worktree, "fix.txt"), "accepted fix\n");
    fs.writeFileSync(path.join(worktree, "sentinel.tmp"), "untouched\n");
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision")], h.ports);
    expect((await patchPipeline(id, { action: "skip-stage" }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);
    const skipped = loadPipelines().find((item) => item.id === id)!;
    const accepted = (await git(worktree, "rev-parse", "HEAD"));
    expect(accepted).not.toBe(fixture.base);
    expect(skipped).toMatchObject({ lastPassedCommit: accepted, cursor: { stageId: "review" } });
    expect(skipped.runs[0]!.attempts[0]!.state).toBe("skipped");
    expect((await git(worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("fix.txt");
    expect((await git(origin, "rev-parse", `refs/heads/${skipped.branch}`))).toBe(accepted);
    await tickPipelines([], h.ports);
    const review = loadPipelines().find((item) => item.id === id)!;
    expect(review.state).toBe("running");
    expect(review.runs[1]!.attempts[0]).toMatchObject({ expectedReviewHeadSha: accepted, flowId: "flow-1" });
    expect(h.flowRequests).toHaveLength(1);
    expect(h.flowRequests[0]).toMatchObject({ implementerPath: "/codex/stage-1.jsonl", targetSha: accepted, headRef: skipped.branch, requireRemoteHead: true });
    expect(fs.readFileSync(path.join(worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


for (const publication of ["internal", "remote-branch"] as const) {
test.skip(`a legacy architect repair commits its declared output before ${publication} review`, async () => {
  const fixture = await realWorktreeLane(`architect-review-repair-${publication}`, [
    { id: "architect", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["report.md"], prompt: "Write report", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review report", next: null },
  ], publication === "remote-branch" ? publication : undefined);
  const offline = `${fixture.origin}.offline`;
  try {
    fs.writeFileSync(path.join(fixture.worktree, "report.md"), "first report\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "pass")], fixture.h.ports);
    await tickPipelines([], fixture.h.ports);
    const first = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    const flow = fixture.h.flows.get("flow-1")!;
    expect(flow).toBeDefined();
    const transcript = path.join(fixture.root, "architect-repair.jsonl");
    const sessionId = ["059f421e", "02e1", "73e0", "9b77", "bebde063f529"].join("-");
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: fixture.worktree } })}\n${JSON.stringify({
      timestamp: new Date(Date.now() + 1_000).toISOString(), type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "REVIEW_READY: repaired report" },
    })}\n`);
    const roles = { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "high" } };
    const firstRound = { ...newRound({ ...flow, roles, rounds: [] }, "marker", null), n: 1, startedAt: "2026-07-22T00:00:00Z", relayedAt: "2026-07-22T00:01:00Z" };
    Object.assign(flow, {
      template: "implement-review-loop",
      project: loadPipelines().find((item) => item.id === fixture.id)!.project,
      baseMode: "head",
      pausedState: null, stateDetail: null,
      cwd: fixture.worktree,
      implementerPath: transcript,
      requireRemoteHead: publication === "remote-branch",
      roles,
      mode: "auto", reviewerMode: "headless", state: "fixing", roundLimit: 5,
      createdAt: "2026-07-21T00:00:00Z",
      rounds: [firstRound],
    });
    saveFlows([flow]);
    fs.writeFileSync(path.join(fixture.worktree, "report.md"), "repaired report\n");
    fs.writeFileSync(path.join(fixture.worktree, "sentinel.tmp"), "keep me\n");
    const record = entry(transcript);
    record.size = fs.statSync(transcript).size;
    record.mtime = Date.now() / 1_000;
    if (publication === "remote-branch") fs.renameSync(fixture.origin, offline);
    expect(await tickFlow(flow, [record], new Map([[transcript, record]]), () => {})).toBe(true);
    const repaired = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    expect(repaired).not.toBe(first);
    if (publication === "remote-branch") {
      expect(flow.state).toBe("fixing");
      expect(flow.rounds).toHaveLength(1);
      fs.renameSync(offline, fixture.origin);
      saveFlows([flow]);
      expect(await tickFlow(flow, [record], new Map([[transcript, record]]), () => {})).toBe(true);
      expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${loadPipelines().find((item) => item.id === fixture.id)!.branch}`))).toBe(repaired);
    }
    expect(flow.state).toBe("spawning");
    expect(flow.rounds[1]!.reviewHeadSha).toBe(repaired);
    expect(loadPipelines().find((item) => item.id === fixture.id)!.lastPassedCommit).toBe(repaired);
    expect((await fixture.git(fixture.worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("report.md");
    expect(fs.readFileSync(path.join(fixture.worktree, "sentinel.tmp"), "utf8")).toBe("keep me\n");
  } finally {
    saveFlows([]);
    savePipelines([]);
    if (fs.existsSync(offline)) fs.renameSync(offline, fixture.origin);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
}


test("a new owner reviews the commit published after the producer turn ends", async () => {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-one-published-head-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const { realExec } = await import("@/lib/workflows/provision");
  const { realProvisionExec } = await import("./git");
  const git = async (cwd: string, ...args: string[]) => {
    const result = (await realExec("git", args, cwd));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repo);
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "init", "--initial-branch=main"));
    (await git(repo, "config", "user.name", "Fixture"));
    (await git(repo, "config", "user.email", "noreply@example.com"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    (await git(repo, "add", "base.txt"));
    (await git(repo, "commit", "-m", "base"));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "origin", "main"));
    const base = (await git(repo, "rev-parse", "HEAD"));

    const h = harness();
    h.ports.exec = realExec;
    h.ports.provisionExec = realProvisionExec;
    const created = await createPipelineFromRequest({
      task: "One published head", repoDir: repo, baseRef: base,
      publication: "remote-branch", delivery: { branch: "refs/heads/feature/shared" },
      stages: [
        { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
        { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
      ],
    }, h.ports);
    if (!created.pipeline) throw new Error(created.error);
    const id = created.pipeline.id;
    await tickPipelines([], h.ports);
    const lane = loadPipelines().find((item) => item.id === id)!;
    expect((await git(lane.worktreeDir, "branch", "--show-current"))).toBe("feature/shared");
    expect((await realExec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`], repo)).code).not.toBe(0);
    await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(lane.worktreeDir, "work.txt"), "producer work\n");
    const ready = h.finish("/codex/stage-1.jsonl", "pass");
    ready.activity = "live";
    h.setConversationActive(true);
    await tickPipelines([ready], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.cursor?.stageId).toBe("build");
    expect(h.spawnInputs).toHaveLength(1);

    ready.activity = "idle";
    h.setConversationActive(false);
    await tickPipelines([ready], h.ports);
    const committed = (await git(lane.worktreeDir, "rev-parse", "HEAD"));
    expect(committed).not.toBe(base);
    expect(h.spawnInputs).toHaveLength(1);
    for (let n = 0; n < 5 && h.spawnInputs.length === 1; n += 1) await tickPipelines([], h.ports);
    expect((await git(origin, "rev-parse", "refs/heads/feature/shared"))).toBe(committed);
    expect(loadPipelines().find((item) => item.id === id)!.lastPassedCommit).toBe(committed);
    expect(h.spawnInputs).toHaveLength(2);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});


for (const pin of ["automatic", "explicit", "legacy-draft", "legacy-unknown", "legacy-auto-retry", "crash-before-apply"] as const) {
  const pinned = pin === "explicit" || pin === "legacy-draft";
  test(`successor provisioning records its backup and respects the caller's base pin (${pin})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provision-published-"));
    const repo = path.join(root, "repo");
    const origin = path.join(root, "origin.git");
    const { realExec } = await import("@/lib/workflows/provision");
    const { realProvisionExec } = await import("./git");
    const git = async (cwd: string, ...args: string[]) => {
      const result = (await realExec("git", args, cwd));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      (await git(repo, "init", "--initial-branch=main"));
      (await git(repo, "config", "user.name", "Fixture"));
      (await git(repo, "config", "user.email", "noreply"));
      (await git(repo, "config", "commit.gpgSign", "false"));
      (await git(repo, "commit", "--allow-empty", "-m", "pinned base"));
      const base = (await git(repo, "rev-parse", "HEAD"));
      (await git(root, "init", "--bare", "--initial-branch=main", origin));
      (await git(repo, "remote", "add", "origin", origin));
      (await git(repo, "push", "origin", "main"));
      (await git(repo, "checkout", "-b", "feature/provision"));
      (await git(repo, "commit", "--allow-empty", "-m", "published head"));
      (await git(repo, "push", "origin", "feature/provision"));
      const published = (await git(repo, "rev-parse", "HEAD"));
      (await git(repo, "commit", "--allow-empty", "-m", "unpublished leftover"));
      const leftover = (await git(repo, "rev-parse", "HEAD"));
      const h = harness();
      h.ports.exec = realExec;
      h.ports.provisionExec = realProvisionExec;
      const created = await createPipelineFromRequest({
        task: "Published successor", repoDir: repo, ...(pinned ? { baseRef: base } : {}),
        ...(pin === "legacy-draft" ? { autoStart: false } : {}),
        delivery: { branch: "refs/heads/feature/provision" },
        stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null }],
      }, h.ports);
      if (!created.pipeline) throw new Error(created.error);
      if (pin === "legacy-draft") {
        const legacy = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
        delete legacy.baseRefPinned;
        savePipelines([legacy]);
        expect(await patchPipeline(legacy.id, { action: "start" }, h.ports)).toMatchObject({ pipeline: { state: "provisioning" } });
      }
      if (pin === "legacy-unknown" || pin === "legacy-auto-retry") {
        const legacy = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
        delete legacy.baseRefPinned;
        legacy.baseBranch = "main";
        legacy.baseRef = base;
        legacy.lastPassedCommit = base;
        legacy.stateDetail = pin === "legacy-auto-retry" ? "failed automatic checkout" : null;
        if (pin === "legacy-auto-retry") legacy.state = "needs_decision";
        savePipelines([legacy]);
        if (pin === "legacy-auto-retry") {
          expect(await patchPipeline(legacy.id, { action: "retry-stage" }, h.ports)).toMatchObject({ pipeline: { state: "provisioning" } });
        }
      }
      if (pin === "crash-before-apply") {
        const { provisionPipelineWorktreeAsync } = await import("./git");
        const interrupted = await provisionPipelineWorktreeAsync({ ...created.pipeline, baseBranch: "main", baseRef: base }, realProvisionExec);
        expect(interrupted).toMatchObject({ ok: true, sha: published, preservedLocalRef: { sha: leftover } });
        // The checkout exists, but the controller did not persist its outcome.
      }
      await tickPipelines([], h.ports);
      const lane = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
      expect(lane.state).toBe("running");
      expect((await git(lane.worktreeDir, "rev-parse", "HEAD"))).toBe(pinned ? base : published);
      expect((await git(repo, "rev-parse", "HEAD"))).toBe(leftover);
      const backup = (await git(repo, "for-each-ref", "--format=%(refname)", "refs/backup/provision-unpublished"));
      expect((await git(repo, "rev-parse", backup))).toBe(leftover);
      expect(lane.stateDetail).toContain(backup);
      expect(lane.delivery!.journal.some((entry) => entry.reason.includes(backup) && entry.reason.includes("1 unpublished commit"))).toBe(true);
      expect(loadPipelines().find((item) => item.id === lane.id)!.baseRefPinned ?? false).toBe(pinned);
    } finally {
      savePipelines([]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}


test("delivery creation clamps the second target lane and replays its original key before provisioning", async () => {
  const h = harness();
  const request = { task: "Delivery owner", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false,
    ...REMOTE_BRANCH, delivery: { branch: "refs/heads/shared-review", rejectedHead: "a".repeat(40), pr: 637 } };
  const first = await createPipelineFromRequest(request, h.ports, { creationRequest: { key: "delivery-first", digest: "first" } });
  const second = await createPipelineFromRequest({ ...request, task: "Comparison", delivery: { ...request.delivery, remote: "origin", rejectedHead: "b".repeat(40) } }, h.ports,
    { creationRequest: { key: "delivery-second", digest: "second" } });
  expect(first.pipeline?.delivery).toMatchObject({ disposition: "owner", active: true, epoch: 1 });
  expect(second.pipeline).toMatchObject({ publication: "internal", delivery: { disposition: "comparison", publish: "disabled", ownerId: first.pipeline!.id, epoch: 1 } });
  const replay = await createPipelineFromRequest(request, h.ports, { creationRequest: { key: "delivery-first", digest: "first" } });
  expect(replay.pipeline?.id).toBe(first.pipeline?.id);
  expect(loadPipelines()).toHaveLength(2);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
  const denied = await patchPipeline(second.pipeline!.id, { action: "publish", acceptedSha: ORIGIN_MAIN_SHA }, h.ports);
  expect(denied.error).toContain(first.pipeline!.id);
  expect(h.calls.some((call) => call.startsWith("git push"))).toBe(false);
  const takeover = await patchPipeline(second.pipeline!.id, { action: "takeover", expectedOwner: first.pipeline!.id, expectedEpoch: 1, reason: "comparison selected" }, h.ports,
    { kind: "agent", role: "builder", conversationId: "conversation_requester" });
  expect(takeover.pipeline!.publication).toBeUndefined();
  expect(takeover.pipeline).toMatchObject({ delivery: { disposition: "owner", active: true, epoch: 2 } });
  expect(takeover.pipeline?.delivery?.journal.at(-1)?.conversationId).toBe("conversation_requester");
  expect((await patchPipeline(first.pipeline!.id, { action: "publish", acceptedSha: ORIGIN_MAIN_SHA }, h.ports)).error).toContain(second.pipeline!.id);
});


test("legacy publication admission processes bounded batches before provisioning and never strands the next batch", async () => {
  const h = harness();
  const template = await create(h.ports, RUN_STAGES as never, REMOTE_BRANCH);
  const legacy = Array.from({ length: 17 }, (_, index) => {
    const record = structuredClone(template);
    record.id = `legacy-${index.toString().padStart(2, "0")}`;
    Object.assign(record, pipelineIdentity(record.id, record.task, record.repoDir));
    delete record.delivery;
    return record;
  });
  savePipelines(legacy);
  await tickPipelines([], h.ports);
  const first = loadPipelines();
  expect(first.filter((pipeline) => pipeline.delivery)).toHaveLength(16);
  expect(first.at(-1)).toMatchObject({ state: "provisioning" });
  expect(first.some((pipeline) => pipeline.state === "needs_decision")).toBe(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines().every((pipeline) => pipeline.delivery?.disposition === "owner")).toBe(true);
  expect(loadPipelines().some((pipeline) => pipeline.state === "needs_decision")).toBe(false);
});


test("a fail-park keeps delivery through retry and publishes the next pass without takeover", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.delivery).toMatchObject({ active: true, publish: "enabled", ownerId: pipeline.id, epoch: 1 });
  expect(parked.delivery!.journal.some((item) => item.kind === "release")).toBe(false);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", publishedCommit: box.passedSha,
    cursor: { stageId: "review", state: "pending" }, delivery: { active: true, epoch: 1 } });
  expect(box.remote()).toBe(box.passedSha);
});


test("held pending cursors let the real controller idle and release one successor", async () => {
  const { FlowPipelineController } = await import("./controller");
  const h = harness();
  let held = true;
  let cycles = 0;
  const heartbeats: import("./controller").FlowPipelineControllerHeartbeat[] = [];
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports);
  const controller = new FlowPipelineController({
    tickPipelines: (entries) => tickPipelines(entries, h.ports),
    tickFlows: async () => ({ changed: false }), scan: async () => ({ files: [], complete: true }),
    publishHeartbeat: (heartbeat) => {
      heartbeats.push(heartbeat);
      // Bound the old defect without leaving its microtask loop alive.
      if (heartbeat.state === "idle" && ++cycles === 12) held = false;
    },
  });
  const unregister = registerPipelineTick(() => controller.tick());
  try {
    await controller.tick();
    expect(controller.idle()).toBe(true);
    expect(cycles).toBe(1);
    expect(h.spawnInputs).toHaveLength(0);
    expect(heartbeats.at(-1)?.state).toBe("idle");
    held = false;
    await controller.tick();
    await controller.poll();
    expect(h.spawnInputs).toHaveLength(1);
    expect(controller.idle()).toBe(true);
  } finally { unregister(); }
});


test("automatic-update hold keeps a pending attempt and releases exactly one launch", async () => {
  const h = harness();
  let held = true;
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.cursor?.state).toBe("pending");
  const attempt = waiting.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("pending");
  expect(attempt.spawnCalls ?? 0).toBe(0);
  const detail = waiting.stateDetail;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toBe(detail);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(0);
  held = false;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.n).toBe(attempt.n);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});


test("CPU pressure holds a fresh stage start with a visible reason and releases exactly one launch", async () => {
  const h = harness();
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  let pressure: number | null = 45;
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => pressure, now: () => clock });
  const wakes: number[] = [];
  h.ports.cpuPressureHold = () => gate.check();
  h.ports.scheduleTick = (delayMs) => { wakes.push(delayMs); };
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const held = loadPipelines()[0]!;
  expect(held.cursor?.state).toBe("pending");
  expect(held.runs[0]!.attempts[0]!.spawnCalls ?? 0).toBe(0);
  expect(held.stateDetail).toBe("stage start held for CPU pressure since 2026-10-06T12:00:00.000Z (avg10 45% ≥ 30%)");
  expect(wakes).toContain(5_000);
  clock += 120_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toStartWith("stage start deferred by CPU pressure: held since 2026-10-06T12:00:00.000Z");
  // Below the release threshold the hold lasts ten seconds more.
  pressure = 4;
  await tickPipelines([], h.ports);
  clock += 9_000;
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(0);
  clock += 1_000;
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const released = loadPipelines()[0]!;
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
  expect(released.runs[0]!.attempts).toHaveLength(1);
  expect(released.stateDetail ?? "").not.toContain("CPU pressure");
  // A launched stage is never held again: pressure returns and nothing respawns.
  pressure = 80;
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});


test("a failed CPU pressure sample admits the stage start", async () => {
  const h = harness();
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { throw new Error("EACCES"); }, now: Date.now });
  h.ports.cpuPressureHold = () => gate.check();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail ?? "").not.toContain("CPU pressure");
});


test.skip("automatic drain holds a new embedded legacy review stage and releases once", async () => {
  const h = harness();
  let held = false;
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "review-loop", reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" }, prompt: "Review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setConversationActive(false);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  held = true;
  for (let i = 0; i < 3; i++) await tickPipelines([], h.ports);
  expect(h.flowRequests).toHaveLength(0);
  expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "review", state: "pending" });
  held = false;
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.flowRequests).toHaveLength(1);
});


test.each([false, true])("automatic drain holds reserved custody with dead owner=%s and resumes its identity", async (deadOwner) => {
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  const h = harness();
  let held = false;
  let reserveOnly = true;
  h.ports.drainHold = () => held || (reserveOnly && !!loadPipelines()[0]?.runs[0]?.attempts[0]?.activation) ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  try {
    await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const before = loadPipelines()[0]!;
    const reserved = before.runs[0]!.attempts[0]!.activation!;
    expect(reserved.phase).toBe("reserved");
    if (deadOwner) {
      reserved.owner = { pid: 2_147_483_647, startIdentity: "gone", bootEpoch: "gone" };
      savePipelines([before]);
    }
    held = true;
    await engineModule.drainStageActivations(h.ports);
    const after = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!;
    expect(after.id).toBe(reserved.id);
    expect(after.owner).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(0);
    const { probeQuiet } = await import("@/lib/selfUpdate/quiet");
    expect((await probeQuiet({ busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot,
      { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: loadPipelines, presence: () => [] }, Date.now(), true)).quiet).toBe(true);
    held = false;
    reserveOnly = false;
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeUndefined();
  } finally {
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
});


test("reserved activation rechecks update admission after waiting for the mutation lease", async () => {
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  const h = harness();
  let reserveOnly = true;
  let held = false;
  let scanned!: () => void;
  h.ports.drainHold = () => {
    scanned?.();
    return held || (reserveOnly && !!loadPipelines()[0]?.runs[0]?.attempts[0]?.activation)
      ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: 0, persistent: true } : null;
  };
  let release!: () => void;
  let locking: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  try {
    await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const before = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!);
    reserveOnly = false;
    const { withPipelineMutation } = await import("./store");
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    locking = withPipelineMutation(async () => { entered(); await gate; });
    await acquired;
    const scanning = new Promise<void>(resolve => { scanned = resolve; });
    draining = engineModule.drainStageActivations(h.ports);
    await scanning;
    held = true;
    release(); await locking; await draining;
    expect(h.spawnInputs).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toEqual(before);
    held = false;
    await engineModule.drainStageActivations(h.ports);
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(h.spawnInputs[0]!.clientAttemptId).toBe(before.activation!.clientAttemptId);
  } finally {
    release?.(); await locking; await draining;
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
});


test("pipeline account admission retains reserved custody without parking or consuming a new launch key", async () => {
  const h = harness();
  const drain = await import("@/lib/selfUpdate/drain");
  const mutation = await import("@/lib/accounts/accountMutation");
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "legacy-held-admission.json"));
  setAgentRegistryForTests(registry);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "account-a", kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }}));
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockResolvedValue({ path: null } as never);
  const provision = await import("@/lib/workflows/provision");
  const execute = provision.realExec;
  const gitHead = spyOn(provision, "realExec").mockImplementation((command, args, ...rest) =>
    command === "git" && args.join(" ") === "rev-parse HEAD"
      ? { code: 0, stdout: ORIGIN_MAIN_SHA, stderr: "" } : execute(command, args, ...rest));
  const ports = defaultPipelinePorts();
  const keys: string[] = [];
  h.ports.drainHold = ports.drainHold;
  h.ports.spawnAgent = (input, reserve) => { keys.push(input.clientAttemptId); return ports.spawnAgent(input, reserve); };
  let resume!: () => void, entered!: () => void, queued!: () => void;
  const acquired = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { resume = r; });
  const waiting = new Promise<void>(r => { queued = r; });
  const nativeLock = mutation.withAccountMutationLockAsync;
  let locking: Promise<void> | undefined;
  let ticking: ReturnType<typeof tickPipelines> | undefined;
  let lock: ReturnType<typeof spyOn<typeof mutation, "withAccountMutationLockAsync">> | undefined;
  try {
    await create(h.ports); await tickPipelines([], h.ports);
    locking = nativeLock(async () => { entered(); await gate; }); await acquired;
    lock = spyOn(mutation, "withAccountMutationLockAsync").mockImplementation((...args) => { queued(); return nativeLock(...args); });
    ticking = tickPipelines([], h.ports); await waiting;
    drain.writeDrain(drain.drainFile(), { id: "legacy-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    resume(); await locking; await ticking;
    expect(spawn).not.toHaveBeenCalled();
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(0);
    // Async Git now always drains a reserved activation outside the mutation
    // lease. The refused dispatch retains its counted key for exact replay.
    expect(loadPipelines()[0]!).toMatchObject({ state: "running", cursor: { state: "spawning" } });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ state: "spawning", spawnCalls: 1, activation: { phase: "reserved", replay: true } });
    drain.releaseDrain(drain.drainFile(), "legacy-admission");
    await tickPipelines([], h.ports);
    expect(spawn).toHaveBeenCalledTimes(1);
    const launched = spawn.mock.calls[0]![0];
    expect(launched.account.env.LLV_STAGE_GIT_WORKTREE).toBe(launched.spec.cwd);
    const receipt = launched.account.env.LLV_STAGE_GIT_RECEIPT!;
    expect(JSON.parse(fs.readFileSync(path.join(receipt, "start.json"), "utf8"))).toMatchObject({
      launchId: launched.receipt.launchId, head: ORIGIN_MAIN_SHA, worktree: launched.spec.cwd,
    });
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(1);
  } finally {
    resume?.(); await locking; await ticking;
    lock?.mockRestore(); resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); gitHead.mockRestore();
    drain.releaseDrain(drain.drainFile(), "legacy-admission"); setAgentRegistryForTests(null);
  }
});


test.each(["early", "drain-switch-off"] as const)("managed %s admission holds actual pipeline launches across recovery until terminal status", async (admission) => {
  const h = harness();
  savePipelines([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-pipeline-custody-"));
  const target = "a".repeat(40);
  const old = "b".repeat(40);
  let now = Date.parse("2026-01-01T00:00:00Z");
  let turns = admission === "early" ? 0 : 1;
  let requests = 0;
  let status: import("@/lib/runtime/contracts").ViewerDeploymentStatus | null = null;
  const rev = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  writeAuto(path.join(dir, "auto.json"), { ...initialAuto(), enabled: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), installed: rev(old), available: rev(target),
    check: { ...idleCheck(), state: "update-available", relation: "behind" } }, update: null }));
  const deps = { dir, now: () => now, env: {}, remote: "https://github.com/example/project", branch: "main", pollMinutes: 15,
    mode: async () => ({ mode: "managed", record: null, reason: null }), releaseTarget: () => ({ revision: old }),
    check: async () => ({ ok: true, installed: rev(old), available: rev(target), relation: "behind", ahead: 0, behind: 1, delta: null }),
    prepareCheckRepo: async () => dir, targetOnBranch: async () => true, describe: async (_repo: string, sha: string) => rev(sha),
    hostHealth: async () => ({ pid: 102, generation: { revision: old } }), web: { pid: 101, port: null, startedAt: "", revision: old },
    green: { read: async () => ({ state: "green" }) }, quiet: { runtimeSnapshot: async () => ({ sessions: turns ? [{ turn: "running", host: "hosted" }] : [] }), pipelines: loadPipelines, presence: () => [], memoryAvailableMb: () => 8192 },
    requestDeployment: async (body: import("@/lib/runtime/contracts").ViewerDeploymentRequest) => {
      requests++;
      status = { deploymentId: "deployment-test", idempotencyKey: body.idempotencyKey, requestedRevision: target, revision: target,
        phase: "admitted", terminal: false, candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
        owner: { pid: 102, startIdentity: null }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), revisionNumber: 1 };
      return { state: "accepted", deploymentId: "deployment-test", revision: target, replayed: false };
    },
    readDeployment: async () => status, findDeploymentByIdempotencyKey: async () => status,
  } as unknown as ServiceDeps;
  let service = new SelfUpdateService(deps);
  h.ports.drainHold = () => activeDrain(path.join(dir, "auto-drain.json"), now);
  try {
    await service.autoTick();
    if (admission === "drain-switch-off") { turns = 0; await service.autoTick(); }
    now += 60_000;
    await service.autoTick();
    expect(requests).toBe(1);
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
    if (admission === "drain-switch-off") await service.setAuto(false);
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    service.stop();
    now += DRAIN_LEASE_MS + 1;
    service = new SelfUpdateService(deps);
    await startAutoAndSettle(service);
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    expect(requests).toBe(1);
    status = { ...status!, phase: "rolled-back", terminal: true, revisionNumber: 2 };
    // A terminal receipt with mixed serving revisions still owns the drain.
    deps.web.revision = target;
    await service.refreshManaged();
    await service.snapshot();
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.ports.drainHold()).not.toBeNull();
    expect(h.spawnInputs).toHaveLength(0);
    deps.web.revision = old;
    await service.snapshot();
    expect(h.ports.drainHold()).toBeNull();
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
  } finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test("attempt Git custody adopts a proved detached push before review", async () => {
  const f = await detachedAttemptFixture("attempt-git-detached");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.base);
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.runs[0]!.attempts[0]!.report?.provenance.head).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(fixed);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(fixed);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test("attempt Git custody refuses an unproved detached push and fails the stage clearly", async () => {
  const f = await detachedAttemptFixture("attempt-git-unproved");
  try {
    // Same machine author and timestamp, created without this attempt's hooks.
    const r = await realExec("git", ["commit", "--allow-empty", "-m", "foreign"], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0" });
    expect(r.code).toBe(0);
    const foreignHead = await f.run("rev-parse", "HEAD");
    const refused = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("not created in the attempt worktree");
    expect(await f.git(f.origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${f.lane.branch}`)).toBe("");
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("stage push refused");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.base);
    const parked = loadPipelines().find(pipeline => pipeline.id === f.id)!;
    f.h.setConversationActive(true);
    const active = await engineModule.patchPipeline(f.id, { action: "resolve-decision", clientRequestId: "native-custody-active-producer",
      answer: "Repair the missing creation evidence and rerun the stage.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(active.status).toBe(409);
    expect(loadPipelines().find(pipeline => pipeline.id === f.id)!.runs[0]!.attempts).toHaveLength(1);
    f.h.setConversationActive(false);
    const resumed = await engineModule.patchPipeline(f.id, { action: "resolve-decision", clientRequestId: "native-custody-repair",
      answer: "Repair the missing creation evidence and rerun the stage.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(resumed.error).toBeUndefined();
    expect(loadPipelines().find(pipeline => pipeline.id === f.id)!.runs[0]!.attempts).toHaveLength(2);
    expect(loadPipelines().find(pipeline => pipeline.id === f.id)!.lastPassedCommit).toBe(f.base);
    expect(loadPipelines().find(pipeline => pipeline.id === f.id)!.publishedCommit).toBeNull();

    for (let n = 0; n < 4 && f.h.spawnInputs.length < 2; n += 1) await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    const repair = loadPipelines().find(pipeline => pipeline.id === f.id)!.runs[0]!.attempts[1]!;
    expect(repair).toMatchObject({ n: 2, state: "running", decisionAnswerId: "native-custody-repair" });
    const guard = await prepareStageGitGuard(repair.launchId!, f.worktree, realExec, repair.startedAt!);
    Object.assign(f.env, guard, agentPublicationIdentityEnv({ ...f.env, ...guard }));
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.base);
    fs.writeFileSync(path.join(f.worktree, "repair.txt"), "valid custody repair output\n");
    await f.git(f.worktree, "add", "repair.txt");
    await f.git(f.worktree, "commit", "-m", "valid custody repair output");
    const repaired = await f.git(f.worktree, "rev-parse", "HEAD");
    expect(fs.readFileSync(path.join(stageGitReceiptDirectory(repair.launchId!), "commits", repaired), "utf8")).toBe("");
    const foreignImported = await realExec("git", ["merge-base", "--is-ancestor", foreignHead, repaired], f.worktree, f.env);
    expect(foreignImported.code).not.toBe(0);
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_2" }, f.h.ports)).toMatchObject({ report: { verdict: { status: "pass" } } });
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Fresh repair is complete.")], f.h.ports);
    await tickPipelines([], f.h.ports);
    const accepted = loadPipelines().find(pipeline => pipeline.id === f.id)!;
    expect(accepted.lastPassedCommit).toBe(repaired);
    expect(accepted.cursor?.stageId).toBe("review");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(repaired);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(repaired);
    expect(await f.run("rev-parse", "HEAD")).toBe(foreignHead);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


for (const shape of ["foreign", "wrong-attempt", "missing-start", "malformed", "oversized", "mixed", "non-descendant", "remote-race", "remote-after-merge", "local-race", "pause", "claim-race", "dirty", "released"] as const) {
  test(`attempt Git custody preserves the fences for ${shape}`, async () => {
    const f = await detachedAttemptFixture(`attempt-git-${shape}`);
    try {
      if (shape === "non-descendant") await f.run("checkout", "--orphan", "unrelated");
      if (shape === "mixed") await f.git(f.detached, "commit", "--allow-empty", "-m", "unproved ancestor");
      const fixed = await f.commit();
      // An adversarial writer may bypass its hooks. Settlement still needs all
      // of the receipts, ancestry and window evidence before changing HEAD.
      await f.git(f.detached, "push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
      fs.mkdirSync(path.join(f.receipt, "pushes"), { recursive: true });
      fs.writeFileSync(path.join(f.receipt, "pushes", fixed), `refs/heads/${f.lane.branch}\n${f.origin}\n`);
      if (shape === "wrong-attempt") {
        const file = path.join(f.receipt, "start.json");
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), launchId: "another-attempt" }));
      }
      if (shape === "missing-start") fs.rmSync(path.join(f.receipt, "start.json"));
      if (shape === "malformed" || shape === "oversized") fs.writeFileSync(path.join(f.receipt, "start.json"), shape === "malformed" ? "{" : "x".repeat(8193));
      if (shape === "foreign") fs.rmSync(path.join(f.receipt, "commits", fixed), { force: true });
      if (shape === "dirty") fs.writeFileSync(path.join(f.worktree, "unsaved.txt"), "unsaved\n");
      if (shape === "released") {
        const stored = loadPipelines().find(p => p.id === f.id)!;
        stored.delivery!.active = false;
        savePipelines([stored]);
      }
      let reads = 0;
      let raced: string | null = null;
      const exec = f.h.ports.exec;
      if (["remote-race", "remote-after-merge", "local-race", "pause", "claim-race"].includes(shape)) f.h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "ls-remote" && ++reads === (shape === "remote-after-merge" ? 3 : 2)) {
          if (shape === "pause" || shape === "claim-race") {
            raced = shape;
            const stored = loadPipelines().find(p => p.id === f.id)!;
            if (shape === "pause") { stored.state = "paused"; stored.pausedState = "running"; savePipelines([stored]); }
            else savePipelines([stored, { ...structuredClone(stored), id: "racing-owner", state: "running", delivery: undefined }]);
            return exec(command, args, ...rest);
          }
          await f.git(f.detached, "commit", "--allow-empty", "-m", "racing work");
          raced = await f.git(f.detached, "rev-parse", "HEAD");
          if (shape === "remote-race" || shape === "remote-after-merge") await f.git(f.detached, "push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
          else await f.git(f.worktree, "commit", "--allow-empty", "-m", "lane raced");
        }
        return exec(command, args, ...rest);
      };
      const failed = await f.finish();
      if (["remote-race", "remote-after-merge", "local-race", "pause", "claim-race"].includes(shape)) expect(raced).not.toBeNull();
      expect(failed.state).toBe(shape === "pause" ? "paused" : "needs_decision");
      expect(failed.lastPassedCommit).toBe(f.base);
      expect(failed.cursor?.stageId).toBe("build");
      if (!["released", "pause", "claim-race"].includes(shape)) expect(failed.stateDetail).toContain("settling the stage push");
      if (shape !== "local-race") expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(shape === "remote-after-merge" ? fixed : f.base);
      expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(raced && (shape === "remote-race" || shape === "remote-after-merge") ? raced : fixed);
      if (shape === "dirty") expect(fs.readFileSync(path.join(f.worktree, "unsaved.txt"), "utf8")).toBe("unsaved\n");
    } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}



test("attempt Git custody replays its durable proof in a new controller process", async () => {
  const f = await detachedAttemptFixture("attempt-git-restart");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const script = `
      const { commitAndAdoptStageBranch } = await import("./src/lib/pipelines/stageBranch");
      const { realExec } = await import("./src/lib/workflows/provision");
      const p = JSON.parse(process.env.CUSTODY_FIXTURE);
      const a = p.runs[0].attempts[0];
      const result = await commitAndAdoptStageBranch(p, "build", realExec, () => [p], undefined,
        () => {}, null, undefined, undefined, a, new Date(Date.parse(a.startedAt) + 60000).toISOString());
      process.stdout.write(JSON.stringify(result));
    `;
    const replay = await realExec(process.execPath, ["-e", script], process.cwd(),
      { CUSTODY_FIXTURE: JSON.stringify(f.lane), LLV_STRUCTURED_HOSTS: "0" }, { timeoutMs: 30000 });
    expect(replay.code, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, sha: fixed });
    expect((await f.finish()).lastPassedCommit).toBe(fixed);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});
