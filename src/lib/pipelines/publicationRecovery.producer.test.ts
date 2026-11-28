import { expect, test, fs, path, tickPipelines, savePipelines, pipelineRevision, rawPatchPipeline, entry } from "./engine.fixture";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";

isolatePublicationGit();

test.each(["unrecorded", "hooks-off", "foreign"] as const)(
  "ordinary retry refuses a %s inherited head before publishing its receipted output", async origin => {
    const twoWritableStages = [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "retry" },
      { id: "retry", kind: "run", role: { roleId: "builder" }, prompt: "Retry", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
    ];
    const f = await fixture(undefined, twoWritableStages);
    try {
      const accepted = await f.commit("first stage accepted output");
      await f.finish(1);
      await tickPipelines([], f.h.ports);
      expect(current()).toMatchObject({ lastPassedCommit: accepted, publishedCommit: accepted,
        cursor: { stageId: "retry", state: "running" } });
      const active = current();
      active.runs!.find(run => run.stageId === "retry")!.attempts[0]!.paneId = "ordinary-retry-pane";
      savePipelines([active]);
      await f.git(f.lane(), "reset", "--hard", current().baseRef);

      let divergent: string;
      if (origin === "foreign") {
        const foreign = path.join(f.root, "ordinary-retry-foreign");
        await f.git(f.lane(), "worktree", "add", "--detach", foreign, current().baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "foreign retry starting commit");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.git(f.lane(), "fetch", foreign, divergent);
        await f.git(f.lane(), "reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", `${origin} retry starting commit`];
        const result = await f.execute("git", origin === "hooks-off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane(), undefined);
        expect(result.code, result.stderr).toBe(0);
        divergent = await f.git(f.lane(), "rev-parse", "HEAD");
        if (origin === "unrecorded") {
          const attempt = current().runs!.find(run => run.stageId === "retry")!.attempts[0]!;
          fs.rmSync(path.join(stageGitReceiptDirectory(attempt.launchId!), "commits", divergent), { force: true });
        }
      }
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(accepted);
      await tickPipelines([f.h.finish("/codex/stage-2.jsonl", "fail", "retry this stage")], f.h.ports);
      expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await tickPipelines([], f.h.ports);
      expect(current().runs!.find(run => run.stageId === "retry")!.attempts[1]!.restartContext).toBeUndefined();
      await f.git(f.lane(), "merge", "--no-ff", "-m", "restore the accepted boundary", accepted);
      const output = await f.commit("receipted retry output");
      await tickPipelines([f.h.finish("/codex/stage-3.jsonl", "pass", "implemented")], f.h.ports);

      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(divergent);
      expect(current().lastPassedCommit).toBe(accepted);
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(accepted);
      expect(await f.git(f.lane(), "merge-base", "--is-ancestor", output, "HEAD")).toBe("");
    } finally { f.close(); }
  });

test.each([false, true])("a real refused pre-push admits one fresh decision attempt on the current head with refusal output (moved: %s)", async moved => {
  const f = await fixture();
  try {
    let head = await f.commit("implementation"); f.refuse(); await f.finish();
    if (moved) head = await f.commit("producer repair before decision");
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("NEW file.test.ts");
    const original = structuredClone(parked.runs[0]!.attempts[0]!);
    const request = { action: "resolve-decision" as const, clientRequestId: "repair-publication", answer: "Repair the failing test and run the checks again.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const actor = OPERATOR_PAUSE_RESUME_ACTOR;
    f.h.setConversationActive(false);
    const accepted = await rawPatchPipeline(parked.id, request, f.h.ports, actor);
    expect(accepted.error).toBeUndefined();
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, actor)).replayed).toBe(true);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    const { publicationRepairAbandonment, ...retained } = current().runs[0]!.attempts[0]!;
    expect(retained).toEqual(original);
    expect(publicationRepairAbandonment?.reason).toContain("gone or idle");
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.prompt).toContain("NEW file.test.ts");
    const repaired = await f.commit("repaired test"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test("a receipted producer commit after acceptance proceeds to review", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    expect(current().state).toBe("needs_decision");
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current().cursor).toMatchObject({ stageId: "build", state: "running" });
    expect(current().runs[0]!.attempts).toHaveLength(2);
    await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { f.close(); }
});

test("a fresh attempt can finish after the controller accepted and committed dirty producer output", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "implementation output\n");
    f.refuse(); await f.finish();
    const accepted = await f.git(f.lane(), "rev-parse", "HEAD");
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(current().runs[0]!.attempts[0]!.launchId!), "commits", accepted))).toBe(false);
    expect(current().state).toBe("needs_decision");
    f.h.setConversationActive(false);
    await rawPatchPipeline(current().id, { action: "resolve-decision", clientRequestId: "dirty-output-retry",
      answer: "Run the stage again.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    const repaired = await f.commit("fresh attempt repair"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each([
  { proof: "proved", writes: true }, { proof: "proved", writes: false },
  { proof: "unrecorded", writes: true }, { proof: "hooks-off", writes: false }, { proof: "foreign", writes: false },
])("a replacement checks the lost attempt's $proof commits (replacement writes: $writes)", async ({ proof, writes }) => {
  const f = await fixture();
  try {
    let first: string;
    if (proof === "foreign") {
      const foreign = path.join(f.root, "foreign-output");
      await f.git(f.lane(), "worktree", "add", "--detach", foreign, "HEAD");
      await f.git(foreign, "commit", "--allow-empty", "-m", "foreign output");
      first = await f.git(foreign, "rev-parse", "HEAD");
      await f.git(f.lane(), "merge", "--ff-only", first);
    } else if (proof === "hooks-off") {
      const made = await f.execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "unproved output"], f.lane());
      expect(made.code, made.stderr).toBe(0);
      first = await f.git(f.lane(), "rev-parse", "HEAD");
    } else first = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    if (proof === "unrecorded") fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", first));
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", first))).toBe(proof === "proved");
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
    expect(current().worktreeDir).toBe(f.lane());
    const head = writes ? await f.commit("replacement output") : first;
    await f.finish(2);
    if (proof === "proved") {
      expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
    } else {
      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(first);
      expect(current().publishedCommit).toBeNull();
    }
  } finally { f.close(); }
});

for (const proof of ["proved", "unrecorded", "hooks-off", "foreign"] as const) {
  test(`a replacement validates the already-published ${proof} prefix against attempt custody`, async () => {
    const f = await fixture();
    try {
      let prefix: string;
      if (proof === "foreign") {
        const foreign = path.join(f.root, "published-foreign-prefix");
        await f.git(f.lane(), "worktree", "add", "--detach", foreign, "HEAD");
        await f.git(foreign, "commit", "--allow-empty", "-m", "published foreign prefix");
        prefix = await f.git(foreign, "rev-parse", "HEAD");
        await f.git(f.lane(), "merge", "--ff-only", prefix);
      } else if (proof === "hooks-off") {
        const made = await f.execute("git", ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "published hooks-off prefix"], f.lane());
        expect(made.code, made.stderr).toBe(0);
        prefix = await f.git(f.lane(), "rev-parse", "HEAD");
      } else prefix = await f.commit(`published ${proof} prefix`);

      const old = current().runs[0]!.attempts[0]!;
      if (proof === "unrecorded") fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", prefix));
      if (proof === "proved") await f.agentGit(f.lane(), "push", "origin", `HEAD:${current().delivery!.target.branch}`);
      else {
        const pushed = await f.execute("git", ["-c", "core.hooksPath=", "push", "origin", `HEAD:${current().delivery!.target.branch}`], f.lane());
        expect(pushed.code, pushed.stderr).toBe(0);
      }
      expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(prefix);

      f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
      f.h.advanceWallClock(600_000);
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      await tickPipelines([entry(old.agentPath!)], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
      const head = await f.commit("replacement suffix after published prefix");
      await f.finish(2);
      if (proof === "proved") {
        expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
      } else {
        expect(current().state).toBe("needs_decision");
        expect(current().stateDetail).toContain(prefix);
        expect(current().publishedCommit).toBeNull();
      }
    } finally { f.close(); }
  });
}

for (const proof of ["unrecorded", "hooks-off", "foreign"] as const) {
  test(`a replacement refuses an unaccepted ${proof} prefix already in its predecessor's starting head`, async () => {
    const f = await fixture(proof);
    try {
      const old = current().runs[0]!.attempts[0]!;
      const prefix = await f.git(f.lane(), "rev-parse", "HEAD");
      expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", prefix))).toBe(false);
      f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
      f.h.advanceWallClock(600_000);
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      await tickPipelines([entry(old.agentPath!)], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
      const suffix = await f.commit("replacement suffix after unaccepted starting prefix");
      await f.finish(2);
      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(prefix);
      expect(current().publishedCommit).toBeNull();
      expect(current().lastPassedCommit).not.toBe(suffix);
    } finally { f.close(); }
  });
}
