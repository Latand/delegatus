import { expect, test, fs, path, tickPipelines, createPipelineFromRequest, savePipelines, pipelineRevision, rawPatchPipeline, entry } from "./engine.fixture";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { current, fixture, stages, isolatePublicationGit } from "./publicationRecovery.fixture";

isolatePublicationGit();

test("a passed replacement's custody refusal can be answered without resetting its checkout", async () => {
  const f = await fixture();
  try {
    const head = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    // Model a commit whose creation cannot be attributed to any launch.
    fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", head));
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "host-lost" });
    await f.finish(2);
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("not created in the attempt worktree");
    expect(parked.runs[0]!.attempts[1]!.verdict?.status).toBe("pass");
    f.h.setConversationActive(false);
    const request = { action: "resolve-decision" as const, clientRequestId: "answer-custody-refusal",
      answer: "Investigate the missing creation receipt while preserving the accepted history.",
      expectedStageId: "build", expectedAttempt: 2, expectedRevision: pipelineRevision(parked) };
    const result = await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts[1]!.report).toEqual(parked.runs[0]!.attempts[1]!.report);
    expect(current().runs[0]!.attempts[1]!.completedAt).toBe(current().decisionAnswers!.at(-1)!.at);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).replayed).toBe(true);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs[2]!.prompt).toContain("not created in the attempt worktree");
    await f.finish(3);
    // An answer starts repair work; it grants no creation proof of its own.
    expect(current().state).toBe("needs_decision");
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
  } finally { f.close(); }
});

test.each(["active", "unknown", "busy", "queued", "revision", "actor", "changed during read", "unrelated park"] as const)
("a custody decision retains its %s fence", async fence => {
  const f = await fixture();
  try {
    const head = await f.commit("unrecorded output");
    const attempt = current().runs[0]!.attempts[0]!;
    fs.unlinkSync(path.join(stageGitReceiptDirectory(attempt.launchId!), "commits", head));
    await f.finish();
    expect(current().stateDetail).toContain("not created in the attempt worktree");
    f.h.setConversationActive(false);
    if (fence === "active") f.h.setConversationActive(true);
    if (fence === "unknown") f.h.setConversationActive(null);
    if (fence === "busy") f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
    if (fence === "queued") f.h.ports.conversationDeliveryOutstanding = () => true;
    if (fence === "changed during read") f.h.ports.conversationAgentActive = async () => {
      const moved = current(); moved.state = "paused"; savePipelines([moved]); return false;
    };
    if (fence === "unrelated park") {
      const moved = current(); moved.stateDetail = "another settlement refusal"; savePipelines([moved]);
    }
    const parked = current();
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `custody-fence-${fence}`,
      answer: "Investigate custody.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: fence === "revision" ? "0".repeat(64) : pipelineRevision(parked) }, f.h.ports,
    fence === "actor" ? { kind: "agent", role: "builder", conversationId: "conversation_other" } : OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(fence === "actor" ? 403 : 409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
  } finally { f.close(); }
});

test("a replacement inherits creation receipts for output adopted from the lost producer's scratch worktree", async () => {
  const f = await fixture();
  try {
    const scratch = path.join(f.root, "scratch-output");
    await f.git(f.lane(), "worktree", "add", "--detach", scratch, "HEAD");
    await f.agentGit(scratch, "commit", "--allow-empty", "-m", "lost producer scratch output");
    const lost = await f.git(scratch, "rev-parse", "HEAD");
    const old = current().runs[0]!.attempts[0]!;
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", lost))).toBe(true);
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000); f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports); await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    await f.git(f.lane(), "merge", "--ff-only", lost);
    const head = await f.commit("replacement completes scratch output"); await f.finish(2);
    expect(current().stateDetail).toBeNull();
    expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test("a decision repair after replacement keeps the accepted proof boundary", async () => {
  const f = await fixture();
  try {
    const first = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000); f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports); await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);

    const accepted = await f.commit("replacement implementation");
    f.refuse(); await f.finish(2);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(accepted).not.toBe(first);

    f.h.setConversationActive(false);
    await rawPatchPipeline(current().id, { action: "resolve-decision", clientRequestId: "replacement-publication-repair",
      answer: "Repair the publication failure and retry.", expectedStageId: "build", expectedAttempt: 2,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    fs.unlinkSync(path.join(f.hooks, "pre-push")); await tickPipelines([], f.h.ports);
    const repaired = await f.commit("decision repair output"); await f.finish(3);
    expect(current()).toMatchObject({ lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each(["foreign", "main-only", "rewritten", "forged-reflog"])("publication preserves an accepted head when the moved producer head is %s", async shape => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    let moved: string;
    if (shape === "rewritten") {
      await f.git(f.lane(), "commit", "--amend", "-m", "rewritten implementation");
      moved = await f.git(f.lane(), "rev-parse", "HEAD");
    } else if (shape === "main-only") {
      // A main fast-forward after a previously integrated accepted head must
      // not transfer a producer's pass to a head with no producer receipt.
      await f.git(f.repo, "merge", "--ff-only", accepted);
      await f.git(f.repo, "commit", "--allow-empty", "-m", "main after accepted");
      moved = await f.git(f.repo, "rev-parse", "HEAD");
      await f.git(f.repo, "push", "origin", "main");
      await f.git(f.lane(), "fetch", "origin", "main");
      await f.git(f.lane(), "merge", "--ff-only", moved);
    } else {
      const foreign = path.join(f.root, "foreign");
      await f.git(f.lane(), "worktree", "add", "--detach", foreign, accepted);
      await f.git(foreign, "commit", "--allow-empty", "-m", "foreign suffix");
      moved = await f.git(foreign, "rev-parse", "HEAD");
      const result = await f.execute("git", ["reset", "--hard", moved], f.lane(),
        { GIT_REFLOG_ACTION: shape === "forged-reflog" ? "commit" : undefined });
      expect(result.code).toBe(0);
    }
    expect(moved).not.toBe(accepted);
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(moved);
    // A manual retry of the unstarted repair retains the same custody gate.
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("a publication decision retains actor, revision, publisher and producer fences", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    const request = { action: "resolve-decision" as const, clientRequestId: "fenced-repair", answer: "Repair the refusal.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const before = structuredClone(parked);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports,
      { kind: "agent", role: "builder", conversationId: "conversation_other" })).status).toBe(403);
    expect((await rawPatchPipeline(parked.id, { ...request, expectedRevision: "0".repeat(64) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    f.h.setConversationActive(true);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).error).toContain("producer repair turn");
    f.h.setConversationActive(false);
    expect(current()).toEqual(before);
    const publishing = current(); publishing.delivery!.operation!.state = "running"; savePipelines([publishing]);
    const publisherRequest = { ...request, expectedRevision: pipelineRevision(current()) };
    expect((await rawPatchPipeline(parked.id, publisherRequest, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["unavailable", "unknown"] as const)("a publication decision stays parked when producer evidence is %s", async evidenceKind => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.durableTurnEvidence = async () => {
      if (evidenceKind === "unavailable") throw new Error("transcript read failed");
      return { turn: "unknown", message: null };
    };
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: `unknown-producer-${evidenceKind}`,
      answer: "Retry after repairing publication.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.status).toBe(409);
    expect(result.error).toContain("producer repair turn");
    expect(current()).toEqual(parked);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("terminal evidence for the repair turn permits a decision when activity is unavailable", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    const attempt = parked.runs[0]!.attempts[0]!;
    const requestedAt = f.h.ports.now();
    const responseAt = Date.parse(requestedAt) + 1;
    attempt.publicationRepair = { sha: parked.lastPassedCommit!, baseSha: parked.baseRef,
      operationId: parked.delivery!.operation!.id, stageId: "build", attempt: 1, refusedAt: requestedAt,
      detail: "pre-push refused", paths: [], messageTs: Date.parse(requestedAt) - 1,
      requestedAt, settledAt: requestedAt };
    savePipelines([parked]);
    f.h.ports.conversationAgentActive = async () => null;
    f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: "repair response", ts: responseAt }, lastRecordAt: responseAt });
    const result = await rawPatchPipeline(parked.id, { action: "resolve-decision", clientRequestId: "terminal-repair-evidence",
      answer: "Retry after the producer finished its repair turn.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally { f.close(); }
});

test("producer reads stay outside the shared mutation lease and stale decisions are refused", async () => {
  const f = await fixture();
  const previousWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    f.h.ports.conversationAgentActive = async () => { entered(); await held; return false; };
    process.env.LLV_PIPELINE_LOCK_WAIT_MS = "0";
    const request = { action: "resolve-decision" as const, clientRequestId: "held-producer-read",
      answer: "Retry after repairing publication.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(parked) };
    const decision = rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    await reading;

    const other = await createPipelineFromRequest({ task: "Unrelated lane mutation", repoDir: f.repo,
      baseRef: await f.git(f.repo, "rev-parse", "HEAD"), stages: stages as never }, f.h.ports);
    expect(other.error).toBeUndefined();
    const changed = await rawPatchPipeline(parked.id, { action: "pause" }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    expect(changed.error).toBeUndefined();
    release();
    const refused = await decision;
    expect(refused.code).toBe("STAGE_CHANGED");
    expect(current().runs[0]!.attempts).toHaveLength(1);
  } finally {
    release();
    if (previousWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousWait;
    f.close();
  }
});

test.each(["status", "branch", "head"])("a producer repair head raced at its final %s observation stays unpublished", async observation => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    const exec = f.h.ports.exec;
    let finalProof = false, raced = false;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (args[0] === "status" && args[1] === "--porcelain" && args.length === 2) finalProof = true;
      const matches = observation === "status" ? args[0] === "status" && args[1] === "--porcelain" && args.length === 2
        : observation === "branch" ? finalProof && args[0] === "branch" && args[1] === "--show-current"
        : finalProof && args[0] === "rev-parse" && args[1] === "HEAD";
      if (matches && !raced) {
        raced = true;
        await f.git(f.lane(), "reset", "--hard", accepted);
      }
      return exec(command, args, cwd, env, options);
    };
    await tickPipelines([], f.h.ports);
    expect(raced).toBe(true);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(current().state).toBe("needs_decision");
    expect(repaired).not.toBe(accepted);
  } finally { f.close(); }
});
