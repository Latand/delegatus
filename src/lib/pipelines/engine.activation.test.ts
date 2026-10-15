import { expect, spyOn, test, spawn, spawnSync, fs, os, path, Database, selectProjectAccount, CONTROLLER_ARTIFACT_GIT_PATHS, engineModule, defaultPipelinePorts, reconcileEmbeddedReviewFlows, tickPipelines, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, durableStageTurnEvidence, edgeRoundsUsed, patchPipeline, closeAndDrain, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, REMOTE_BRANCH, create, exhaustVerdictRecovery, provisionRetryClock, STAGE_HEAD, PASS_TEXT, runningStructuredStage, SSH_CONNECT_TIMEOUT, approvedReviewAwaitingRemote, networkDown, NO_CODE_TEST_STAGES, persistedCommittingReview, PROVIDER_LIMIT_NOTICE, LIMITED_ACCOUNT, SPARE_ACCOUNT, LIMITED_ACCOUNT_LABEL, stageTranscript, limitInterruptedTranscript, codexUsageLimitTranscript, readFixtures, stampPipelinePrompt, severedToolTranscript, truncatedMidTurnTranscript, usageLimitPorts, usageLimitStage } from "./engine.fixture";
import type { AgentRegistryType, DurableQuotaObservation, PipelinePorts } from "./engine.fixture";


test("a later exact-head approval replaces a stale startup pause and completes after controller restart (#526)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.pausedState = "reviewing";
  flow.stateDetail = "paused by user";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "needs_decision",
    error: "review flow paused in reviewing: paused by user",
  });

  flow.rounds.push({
    n: 1,
    reviewHeadSha: ORIGIN_MAIN_SHA,
    launchId: "review-launch",
    sessionId: "review-session",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "approved";
  flow.stateDetail = null;

  /* A fresh controller process sees only durable pipeline + flow state. */
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.stateDetail).toBeNull();
  expect(completed.runs[1]!.attempts).toHaveLength(1);
  expect(completed.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "passed",
    error: null,
    reviewHeadSha: ORIGIN_MAIN_SHA,
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });

  /* The first post-completion tick settles the terminal host reap (#574);
     from there the record is stable. */
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  expect(loadPipelines()[0]!.terminalReap?.settledAt).toBeTruthy();
  const afterCompletion = JSON.stringify(loadPipelines()[0]);
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterCompletion);
});

test("a later approval stays parked when its reviewed head differs from the current pipeline head (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.stateDetail = "transient controller restart";
  await tickPipelines([], h.ports);
  flow.rounds.push({ n: 1, reviewHeadSha: "f".repeat(40) } as never);
  flow.state = "approved";
  flow.stateDetail = null;

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("approved review flow head mismatch");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: "f".repeat(40),
    error: expect.stringContaining(`current pipeline head is ${ORIGIN_MAIN_SHA}`),
  });
  expect((await tickPipelines([], h.ports)).changed).toBe(false);
  expect(loadPipelines()[0]!.stateDetail).toBe(parked.stateDetail);
});

test("issue 533: approval parks when the reviewed repair is absent from the remote pipeline branch", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const repairHead = "5".repeat(40);
  const staleRemoteHead = "d".repeat(40);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewHeadSha: repairHead } as never);
  flow.state = "approved";
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${repairHead}\n`, stderr: "" };
    }
    /* The approval's remote read is time-bounded (#1692). */
    if (command === "timeout" && args.includes("ls-remote")) {
      return { code: 0, stdout: `${staleRemoteHead}\trefs/heads/${pipeline.branch}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`remote pipeline head is ${staleRemoteHead}`);
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    expectedReviewHeadSha: repairHead,
    reviewHeadSha: repairHead,
    state: "needs_decision",
  });
});

test("an approval whose remote head read times out retries on its own and settles the reviewed head without touching the flow (#1692)", async () => {
  const h = harness();
  const { control, effects, baseline } = await approvedReviewAwaitingRemote(h);

  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.stateDetail).toStartWith("approved review flow waiting for the remote pipeline head: checking the remote pipeline branch: ssh: connect to host example.invalid port 22: Connection timed out");
  expect(waiting.stateDetail).toContain("; retry at ");
  expect(waiting.runs[1]!.attempts[0]).toMatchObject({ state: "reviewing", error: null, remoteHeadWait: { rounds: 1 } });
  expect(control.reads).toBe(1);

  /* Not yet due: no second read. */
  await tickPipelines([], h.ports);
  expect(control.reads).toBe(1);
  expect(loadPipelines()[0]!.state).toBe("running");

  h.advanceWallClock(60_000);
  control.remote = { code: 0, stdout: `${ORIGIN_MAIN_SHA}\trefs/heads/${waiting.branch}\n`, stderr: "" };
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.stateDetail).toBeNull();
  expect(completed.runs[1]!.attempts).toHaveLength(1);
  expect(completed.runs[1]!.attempts[0]).toMatchObject({ state: "passed", error: null, flowId: "flow-1", reviewHeadSha: ORIGIN_MAIN_SHA });
  expect(completed.runs[1]!.attempts[0]!.remoteHeadWait).toBeUndefined();
  expect(completed.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
  expect(effects()).toEqual(baseline);
});

test("a remote that comes back at a different head after a timeout parks on the mismatch and approves nothing (#1692)", async () => {
  const h = harness();
  const { control, effects, baseline } = await approvedReviewAwaitingRemote(h);
  const divergedRemote = "d".repeat(40);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  h.advanceWallClock(60_000);
  control.remote = { code: 0, stdout: `${divergedRemote}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(`approved review flow head mismatch: reviewed ${ORIGIN_MAIN_SHA}, remote pipeline head is ${divergedRemote}`);
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", verdict: null, completedAt: null });
  expect(effects()).toEqual(baseline);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toBe(parked.stateDetail);
});

test("a remote that refuses the login parks at once, with no automatic retry (#1692)", async () => {
  const h = harness();
  const { control, effects, baseline } = await approvedReviewAwaitingRemote(h);
  control.remote = { code: 128, stdout: "", stderr: "git@example.invalid: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists." };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toStartWith("approved review flow could not verify the remote pipeline head: checking the remote pipeline branch: git@example.invalid: Permission denied (publickey).");
  expect(parked.runs[1]!.attempts[0]!.remoteHeadWait).toBeUndefined();
  expect(control.reads).toBe(1);

  h.advanceWallClock(60 * 60_000);
  control.remote = { code: 0, stdout: `${ORIGIN_MAIN_SHA}\trefs/heads/${parked.branch}\n`, stderr: "" };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(control.reads).toBe(1);
  expect(effects()).toEqual(baseline);
});

test("a remote that never answers parks after a bounded wait that counts its retries, and stays parked (#1692)", async () => {
  const h = harness();
  const { control, effects, baseline } = await approvedReviewAwaitingRemote(h);

  for (let tick = 0; tick < 40 && loadPipelines()[0]!.state === "running"; tick += 1) {
    await tickPipelines([], h.ports);
    h.advanceWallClock(61_000);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/^approved review flow could not verify the remote pipeline head after \d+ automatic retries over \d+s: checking the remote pipeline branch: ssh: connect to host example\.invalid port 22: Connection timed out/);
  const reads = control.reads;
  expect(reads).toBeGreaterThan(2);
  expect(reads).toBeLessThanOrEqual(15);

  control.remote = { code: 0, stdout: `${ORIGIN_MAIN_SHA}\trefs/heads/${parked.branch}\n`, stderr: "" };
  h.advanceWallClock(60 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toBe(parked.stateDetail);
  expect(control.reads).toBe(reads);
  expect(effects()).toEqual(baseline);
});

test("an internal pipeline runs every stage and settles its approved review with the network unreachable (#1692)", async () => {
  const h = harness();
  const pipeline = await create(h.ports, NO_CODE_TEST_STAGES as never);
  expect(pipeline.publication).toBe("internal");

  /* The one remote read an internal lane makes is its base fetch, and since
     #1799 the controller makes it — so the network goes down after the lane is
     provisioned, which is where "nothing is read from a remote WHILE the
     pipeline runs" has always begun. */
  await tickPipelines([], h.ports);
  const { remoteCalls } = networkDown(h);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  const reviewing = loadPipelines()[0]!;
  expect(reviewing.state).toBe("running");
  expect(reviewing.runs.map((run) => run.attempts[0]?.state)).toEqual(["passed", "passed", "reviewing"]);
  expect(h.flowRequests).toHaveLength(1);
  expect(h.flowRequests[0]!.requireRemoteHead).toBeUndefined();
  expect(h.flowRequests[0]!.targetSha).toBe(ORIGIN_MAIN_SHA);

  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, verdict: "APPROVE", reviewHeadSha: ORIGIN_MAIN_SHA, reviewerPath: "/codex/reviewer.jsonl", reviewerConversationId: "conversation_reviewer" } as never);
  flow.state = "approved";
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.stateDetail).toBeNull();
  expect(completed.runs[2]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" }, reviewHeadSha: ORIGIN_MAIN_SHA, error: null });
  expect(completed.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
  /* Nothing claims a publication that never happened. */
  expect(completed.publishedCommit).toBeNull();
  expect(remoteCalls).toEqual([]);
});

test("an internal approval of a revision the worktree no longer holds settles nothing and a retry reviews the new head (#1692)", async () => {
  const h = harness();
  const { effects, baseline } = await approvedReviewAwaitingRemote(h, {});
  const { remoteCalls } = networkDown(h);
  const changedHead = "e".repeat(40);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${changedHead}\n`, stderr: "" };
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(`approved review flow head mismatch: reviewed ${ORIGIN_MAIN_SHA}, current pipeline head is ${changedHead}`);
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", verdict: null, completedAt: null });
  expect(effects()).toEqual(baseline);

  /* The way on is a new review of the head the worktree now holds, still
     without the network. The approved round's reviewer launch completed. */
  h.ports.spawnReceipt = (launchId) => launchId === "review-launch"
    ? { state: "completed", launchId, conversationId: "conversation_reviewer", sessionId: "review-session", "transcript": "/codex/reviewer.jsonl", paneId: null }
    : null;
  const retried = await patchPipeline(parked.id, { action: "retry-stage" }, h.ports);
  expect(retried.error).toBeUndefined();
  expect(loadPipelines()[0]).toMatchObject({ state: "running", lastPassedCommit: changedHead });
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const rereview = loadPipelines()[0]!;
  expect(rereview.runs[1]!.attempts).toHaveLength(2);
  expect(rereview.runs[1]!.attempts[1]).toMatchObject({ expectedReviewHeadSha: changedHead });
  expect(h.flowRequests.at(-1)!.targetSha).toBe(changedHead);
  expect(remoteCalls).toEqual([]);
});

test("an internal pipeline an older build parked on the remote head check completes on its local identity with the network down (#1692)", async () => {
  const h = harness();
  const { effects, baseline } = await approvedReviewAwaitingRemote(h, {});
  /* The record as production left it: review ingress had published the head,
     then the approval's remote read timed out and parked the stage. */
  const legacy = `approved review flow could not verify the remote pipeline head: checking the remote pipeline branch: ${SSH_CONNECT_TIMEOUT}`;
  const stored = loadPipelines()[0]!;
  stored.publishedCommit = ORIGIN_MAIN_SHA;
  stored.state = "needs_decision";
  stored.stateDetail = legacy;
  Object.assign(stored.runs[1]!.attempts[0]!, { state: "needs_decision", error: legacy, reviewHeadSha: ORIGIN_MAIN_SHA, expectedReviewHeadSha: ORIGIN_MAIN_SHA });
  savePipelines([stored]);
  const { remoteCalls } = networkDown(h);

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs[1]!.attempts).toHaveLength(1);
  expect(completed.runs[1]!.attempts[0]).toMatchObject({ state: "passed", flowId: "flow-1", reviewHeadSha: ORIGIN_MAIN_SHA, error: null });
  expect(completed.publishedCommit).toBe(ORIGIN_MAIN_SHA);
  expect(remoteCalls).toEqual([]);
  expect(effects()).toEqual(baseline);
});

test("an internal terminal pass an older build left waiting on publication closes without the network (#1692)", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", prompt: "build", next: null }] as never, REMOTE_BRANCH);
  /* The base fetch is the controller's since #1799; the publication attempts
     this test counts are everything after it. */
  await tickPipelines([], h.ports);
  const { remoteCalls } = networkDown(h);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.stateDetail).toStartWith("passed but unpublished: ");
  const publishAttempts = remoteCalls.length;
  expect(publishAttempts).toBeGreaterThan(0);

  /* An explicitly internal lane can settle a previously waiting pass locally. */
  waiting.publication = "internal";
  savePipelines([waiting]);
  await tickPipelines([], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs[0]!.attempts[0]).toMatchObject({ state: "passed", error: null });
  expect(remoteCalls).toHaveLength(publishAttempts);
});

test("an internal pipeline pinned to a baseRef is created and provisioned with the network unreachable (#1692)", async () => {
  const h = harness();
  const { remoteCalls } = networkDown(h);
  const { scheduled, advance } = provisionRetryClock(h);
  savePipelines([]);

  const created = await createPipelineFromRequest({ task: "Pinned offline", repoDir: "/repo", baseRef: ORIGIN_MAIN_SHA, stages: RUN_STAGES as never }, h.ports);
  expect(created.pipeline).toMatchObject({ state: "provisioning", baseRef: ORIGIN_MAIN_SHA });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: ORIGIN_MAIN_SHA, lastPassedCommit: ORIGIN_MAIN_SHA });
  expect(remoteCalls).toEqual([]);

  /* Without a pin the base is the CONTROLLER's to resolve (#1799), so the
     create itself still touches no remote; the remote that cannot answer is
     asked again on a bounded backoff (#2220), and then parks the admitted
     lane rather than letting it guess a base. */
  savePipelines([]);
  const unpinned = await createPipelineFromRequest({ task: "Unpinned offline", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  expect(unpinned.pipeline).toMatchObject({ state: "provisioning", baseBranch: "main", baseRef: "" });
  expect(remoteCalls).toEqual([]);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "provisioning", baseRef: "" });
  expect(loadPipelines()[0]!.stateDetail).toStartWith("provisioning deferred: the network connection failed (fetching origin/main: ssh: connect to host example.invalid port 22: Connection timed out");
  for (let pass = 0; pass < 20 && loadPipelines()[0]!.state === "provisioning"; pass += 1) {
    advance(scheduled.at(-1)!);
    await tickPipelines([], h.ports);
  }

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("fetching origin/main: ssh: connect to host example.invalid port 22: Connection timed out");
  expect(parked.baseRef).toBe("");
  expect(new Set(remoteCalls)).toEqual(new Set(["timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main"]));
  expect(remoteCalls).toHaveLength(scheduled.length + 1);
});

test("pipeline creation accepts the two publication policies and refuses anything else (#1692)", async () => {
  const h = harness();
  expect((await create(h.ports, RUN_STAGES as never, REMOTE_BRANCH)).publication).toBe("remote-branch");
  expect((await create(h.ports, RUN_STAGES as never, { publication: "internal" })).publication).toBe("internal");
  savePipelines([]);
  const refused = await createPipelineFromRequest({ task: "Ship", repoDir: "/repo", stages: RUN_STAGES as never, publication: "github" as never }, h.ports);
  expect(refused.status).toBe(400);
  expect(refused.violations).toContainEqual(expect.objectContaining({ field: "publication", message: "publication must be internal or remote-branch" }));
});

test("an approval parks when the clean head advances during final settlement (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA } as never);
  flow.state = "approved";
  const newerHead = "e".repeat(40);
  let headReads = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      headReads += 1;
      return { code: 0, stdout: `${headReads === 1 ? ORIGIN_MAIN_SHA : newerHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(headReads).toBe(2);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`settled ${newerHead}`),
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(parked.cursor?.stageId).toBe("review");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: ORIGIN_MAIN_SHA,
  });
});

test("REQUEST_CHANGES recovery keeps the bound reviewer in the review slot and lets the flow relay continue (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.stateDetail = "relay controller unavailable";
  await tickPipelines([], h.ports);
  flow.rounds.push({
    n: 1,
    verdict: "REQUEST_CHANGES",
    reviewHeadSha: ORIGIN_MAIN_SHA,
    launchId: "review-launch",
    sessionId: "review-session",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "relay_pending";
  flow.stateDetail = null;

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  const relaying = loadPipelines()[0]!;
  expect(relaying.state).toBe("running");
  expect(relaying.stateDetail).toBeNull();
  expect(relaying.runs[1]!.attempts).toHaveLength(1);
  expect(relaying.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "reviewing",
    error: null,
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });
});

test("issue 532: a four-round embedded flow authoritatively repairs its stale parent once", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  const heads = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  flow.rounds = heads.map((reviewHeadSha, index) => ({
    n: index + 1,
    reviewerPath: `/codex/reviewer-${index + 1}.jsonl`,
    reviewerConversationId: `conversation_reviewer_${index + 1}`,
    reviewHeadSha,
    verdict: index < 3 ? "REQUEST_CHANGES" : null,
    reviewedAt: index < 3 ? `2026-07-22T00:0${index}:00.000Z` : null,
    relayedAt: index < 3 ? `2026-07-22T00:0${index}:30.000Z` : null,
  } as never));
  flow.state = "reviewing";

  const parent = loadPipelines()[0]!;
  const reviewAttempt = parent.runs[1]!.attempts[0]!;
  reviewAttempt.agentPath = "/codex/reviewer-2.jsonl";
  reviewAttempt.conversationId = "conversation_reviewer_2";
  reviewAttempt.expectedReviewHeadSha = heads[1]!;
  reviewAttempt.reviewHeadSha = heads[1]!;

  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:04:00.000Z")).toBe(true);
  expect(reviewAttempt).toMatchObject({
    agentPath: "/codex/reviewer-4.jsonl",
    conversationId: "conversation_reviewer_4",
    expectedReviewHeadSha: heads[3],
    reviewHeadSha: heads[3],
    reviewFlowSync: {
      roundCount: 4,
      implementerHeadSha: heads[3],
      reviewerHeadSha: heads[3],
      verdict: null,
      relayState: "reviewing",
      terminalState: null,
      synchronizedAt: "2026-07-22T00:04:00.000Z",
    },
  });
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:05:00.000Z")).toBe(false);

  flow.revision = 2;
  flow.rounds[3]!.reviewerPath = "/codex/reviewer-new.jsonl";
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:05:30.000Z")).toBe(true);
  const equalTimestampStaleFlow = structuredClone(flow);
  equalTimestampStaleFlow.revision = 1;
  equalTimestampStaleFlow.rounds[3]!.reviewerPath = "/codex/reviewer-old.jsonl";
  expect(reconcileEmbeddedReviewFlows([parent], [equalTimestampStaleFlow], "2026-07-22T00:05:31.000Z")).toBe(false);
  expect(reviewAttempt.agentPath).toBe("/codex/reviewer-new.jsonl");

  /* Model the partial-write crash: flows.json advances with a delayed final
     marker while pipelines.json still contains generation four. A fresh
     controller has no scan entries or runtime host and must converge once. */
  savePipelines([parent]);
  const finalHead = "5".repeat(40);
  flow.rounds.push({
    n: 5,
    reviewerPath: "/codex/reviewer-5.jsonl",
    reviewerConversationId: "conversation_reviewer_5",
    reviewHeadSha: finalHead,
    verdict: null,
    startedAt: "2026-07-22T00:06:00.000Z",
  } as never);
  flow.revision = 3;
  expect((await tickPipelines([], h.ports)).changed).toBe(true);
  const recovered = loadPipelines()[0]!.runs[1]!.attempts[0]!;
  expect(recovered).toMatchObject({
    agentPath: "/codex/reviewer-5.jsonl",
    expectedReviewHeadSha: finalHead,
    reviewHeadSha: finalHead,
    reviewFlowSync: { roundCount: 5, relayState: "reviewing" },
  });
  expect((await tickPipelines([], h.ports)).changed).toBe(false);

  const staleFlow = structuredClone(flow);
  staleFlow.rounds = staleFlow.rounds.slice(0, 4);
  expect(reconcileEmbeddedReviewFlows([loadPipelines()[0]!], [staleFlow], "2026-07-22T00:07:00.000Z")).toBe(false);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]).toMatchObject({
    agentPath: "/codex/reviewer-5.jsonl",
    expectedReviewHeadSha: finalHead,
    reviewHeadSha: finalHead,
    reviewFlowSync: { roundCount: 5 },
  });
});

test("issue 532: projection rebinds one flow-first partial write and refuses ambiguous candidates", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);

  const parent = loadPipelines()[0]!;
  const attempt = parent.runs[1]!.attempts[0]!;
  const flow = h.flows.get("flow-1")!;
  attempt.flowId = null;
  attempt.agentPath = null;
  attempt.conversationId = null;

  /* No scan entries and no runtime host: the files read owns recovery. */
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T01:00:00.000Z")).toBe(true);
  expect(attempt).toMatchObject({ flowId: flow.id, reviewFlowSync: { roundCount: 0 } });
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T01:01:00.000Z")).toBe(false);

  attempt.flowId = null;
  attempt.reviewFlowSync = undefined;
  const duplicate = { ...structuredClone(flow), id: "flow-duplicate" };
  expect(reconcileEmbeddedReviewFlows([parent], [flow, duplicate], "2026-07-22T01:02:00.000Z")).toBe(false);
  expect(attempt.flowId).toBeNull();
});

for (const terminalState of ["done_comment", "needs_decision"] as const) {
  test(`a later ${terminalState} outcome replaces stale startup evidence once across restart ticks (#526)`, async () => {
    const h = harness();
    await create(h.ports, [
      { id: "build", kind: "run", prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

    const flow = h.flows.get("flow-1")!;
    flow.state = "paused";
    flow.pausedState = "spawning";
    flow.stateDetail = "startup transport unavailable";
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.error)
      .toBe("review flow paused in spawning: startup transport unavailable");

    flow.rounds.push({
      n: 1,
      verdict: terminalState === "done_comment" ? "COMMENT" : null,
      reviewHeadSha: ORIGIN_MAIN_SHA,
      reviewerPath: "/codex/reviewer.jsonl",
      reviewerConversationId: "conversation_reviewer",
    } as never);
    flow.state = terminalState;
    flow.stateDetail = terminalState === "done_comment" ? "reviewer left a comment" : "reviewer relay failed";

    await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
    const reconciled = loadPipelines()[0]!;
    const expectedError = `review loop ended in ${terminalState}: ${flow.stateDetail}`;
    expect(reconciled).toMatchObject({ state: "needs_decision", stateDetail: expectedError });
    expect(reconciled.runs[1]!.attempts).toHaveLength(1);
    expect(reconciled.runs[1]!.attempts[0]).toMatchObject({
      flowId: "flow-1",
      state: "needs_decision",
      error: expectedError,
      reviewHeadSha: ORIGIN_MAIN_SHA,
      agentPath: "/codex/reviewer.jsonl",
      conversationId: "conversation_reviewer",
    });

    expect((await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports)).changed).toBe(false);
    expect(loadPipelines()[0]!.runs[1]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.stateDetail).toBe(expectedError);
  });
}

test("a restarted committing review completes once when its clean head still matches (#526)", async () => {
  const h = await persistedCommittingReview();

  await tickPipelines([], h.ports);
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs[1]!.attempts[0]).toMatchObject({ state: "passed", reviewHeadSha: ORIGIN_MAIN_SHA });

  /* The first post-completion tick settles the terminal host reap (#574);
     from there the record is stable and further ticks change nothing. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.terminalReap?.settledAt).toBeTruthy();
  const afterCompletion = JSON.stringify(loadPipelines()[0]);
  expect((await tickPipelines([], h.ports)).changed).toBe(false);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterCompletion);
});

test("a restarted committing review parks when the branch head drifted after approval (#526)", async () => {
  const h = await persistedCommittingReview();
  const driftedHead = "d".repeat(40);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${driftedHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`current pipeline head is ${driftedHead}`),
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", reviewHeadSha: ORIGIN_MAIN_SHA });
  expect(h.calls.some((call) => call.startsWith("git commit"))).toBe(false);
});

test("a restarted committing review parks when the clean head advances during final settlement (#526)", async () => {
  const h = await persistedCommittingReview();
  const newerHead = "c".repeat(40);
  let headReads = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      headReads += 1;
      return { code: 0, stdout: `${headReads === 1 ? ORIGIN_MAIN_SHA : newerHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(headReads).toBe(2);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`settled ${newerHead}`),
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(parked.cursor?.stageId).toBe("review");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: ORIGIN_MAIN_SHA,
  });
});

test("a restarted committing review parks without committing post-review changes (#526)", async () => {
  const h = await persistedCommittingReview();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: " M post-review.txt\n", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining("uncommitted changes"),
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", reviewHeadSha: ORIGIN_MAIN_SHA });
  expect(h.calls.some((call) => call.startsWith("git add") || call.startsWith("git commit"))).toBe(false);
});

test("retrying a paused review with a live reviewer never mutates its checkout (#522)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const repairHead = "e".repeat(40);
  let localHead = ORIGIN_MAIN_SHA;
  let repaired = false;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    /* The repair only exists on the remote once it has actually landed there;
       before that origin simply carries what the pipeline published. */
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repaired ? repairHead : localHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repaired ? repairHead : localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
      localHead = repairHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewerPane: { paneId: "%reviewer", windowName: "reviewer" } } as never);
  flow.state = "reviewing";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  flow.state = "paused";
  flow.stateDetail = "reviewer paused";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  repaired = true;
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toMatchObject({ status: 409, error: expect.stringContaining("still be running") });
  expect(localHead).toBe(ORIGIN_MAIN_SHA);
  expect(h.calls).not.toContain(`git merge --ff-only refs/remotes/origin/${pipeline.branch}`);
  expect(h.calls).not.toContain("flow-close:flow-1");
});

test("retry parks without synchronizing when reviewer termination cannot be verified (#522)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const repairHead = "f".repeat(40);
  let localHead = ORIGIN_MAIN_SHA;
  let repaired = false;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    /* The repair only exists on the remote once it has actually landed there;
       before that origin simply carries what the pipeline published. */
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repaired ? repairHead : localHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repaired ? repairHead : localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
      localHead = repairHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.ports.closeFlow = async () => ({ error: "reviewer process group did not terminate", status: 409 });

  repaired = true;
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(localHead).toBe(ORIGIN_MAIN_SHA);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const skipped = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(skipped).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBeFalse();
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  /* The close carries its host-teardown report (#670) even when the flow refuses
     to close, so nothing it already stopped is swallowed by the rejection. */
  expect(closed.error).toBeUndefined();
  /* A reviewer that would not die leaves through the same report a surviving
     stage host does, not only through the prose error (#670). */
  expect(closed.close).toMatchObject({
    stopped: [],
    stillRunning: [{ stageId: "review", attempt: 1, error: "reviewer process group did not terminate" }],
  });
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", hiddenAt: null, stateDetail: expect.stringContaining("reviewer process group did not terminate") });
});

test("failed stages park and retry without discarding checkout work", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.cursor).toEqual({ stageId: "plan", state: "pending", input: null, activatedBy: null });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "failed", verdict: { status: "fail" } });
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
});

test("issue 533: receipt retry validates the current stage and failed launch identity", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const parked = loadPipelines()[0]!;
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.launchId).toBeString();
  const launchId = attempt.launchId!;
  h.ports.spawnReceipt = (candidate) => candidate === launchId ? {
    state: "failed", launchId, conversationId: attempt.conversationId!, sessionId: attempt.sessionId,
    "transcript": attempt.agentPath, paneId: attempt.paneId,
  } : null;

  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "build",
    launchId,
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("stage") });
  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId: "launch-stale-history",
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("launch") });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  expect((await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId,
  }, h.ports)).pipeline?.state).toBe("running");
  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId,
  }, h.ports)).toMatchObject({ status: 409 });
});

test("issue 533: a matching receipt that settles late cannot spawn a retry", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.launchId).toBeString();
  const launchId = attempt.launchId!;
  attempt.state = "needs_decision";
  attempt.sessionId = null;
  attempt.agentPath = null;
  attempt.paneId = null;
  attempt.error = "stage spawn cannot recover from receipt state failed";
  parked.state = "needs_decision";
  parked.stateDetail = attempt.error;
  savePipelines([parked]);
  const spawnCount = h.calls.filter((call) => call.startsWith("spawn:")).length;
  h.ports.spawnReceipt = (candidate) => candidate === launchId ? {
    state: "completed",
    launchId,
    conversationId: attempt.conversationId!,
    sessionId: "late-success",
    "transcript": "/codex/stage-1.jsonl",
    paneId: null,
  } : null;

  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("settled") });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(spawnCount);
  const afterTick = loadPipelines()[0]!;
  expect(afterTick).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(afterTick.runs[0]!.attempts).toEqual([
    expect.objectContaining({
      state: "running",
      launchId,
      conversationId: attempt.conversationId,
      sessionId: "late-success",
      agentPath: "/codex/stage-1.jsonl",
      error: null,
    }),
  ]);
});

test("issue 533: a cross-process late recovery loses atomically to a claimed retry", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const registryPath = path.join(process.env.LLV_STATE_DIR!, `retry-race-${pipeline.id}.json`);
  const retryRegistry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const competingRegistry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const begun = retryRegistry.beginSpawnRequest({
    engine: "codex",
    cwd: pipeline.worktreeDir,
    transport: "structured",
    accountId: "work",
    launchProfile: { title: "Recover claimed pipeline retry" },
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const key = { engine: "codex" as const, sessionId: `retry-race-${pipeline.id}` };
  const artifactPath = path.join(pipeline.worktreeDir, "late-original.jsonl");
  retryRegistry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath, cwd: pipeline.worktreeDir, accountId: "work", status: "dead",
    host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  retryRegistry.failStructuredSpawn(begun.receipt.launchId, "host loss confirmed");
  const persisted = loadPipelines()[0]!;
  const attempt = persisted.runs[0]!.attempts[0]!;
  attempt.launchId = begun.receipt.launchId;
  attempt.conversationId = begun.receipt.conversationId;
  attempt.sessionId = key.sessionId;
  attempt.agentPath = artifactPath;
  attempt.paneId = null;
  savePipelines([persisted]);
  h.ports.spawnReceipt = (launchId) => {
    const receipt = retryRegistry.readOnlySnapshot().receipts[launchId];
    return receipt ? {
      state: receipt.state, launchId, conversationId: receipt.conversationId,
      sessionId: receipt.key?.sessionId ?? null, "transcript": receipt.artifactPath, paneId: null,
    } : null;
  };
  let lateRecovery: ReturnType<AgentRegistryType["recoverStructuredSpawnFromEvidence"]> | null = null;
  h.ports.claimSpawnRetry = (launchId, claimId) => {
    const claim = retryRegistry.claimFailedSpawnForRetry(launchId, claimId);
    lateRecovery = competingRegistry.recoverStructuredSpawnFromEvidence(launchId, {
      key, artifactPath, cwd: pipeline.worktreeDir, accountId: "work",
      launchProfile: begun.receipt.launchProfile, status: "live", host: null, structuredHost: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    return claim.kind;
  };
  const spawnCount = h.calls.filter((call) => call.startsWith("spawn:")).length;

  expect((await patchPipeline(pipeline.id, {
    action: "retry-stage",
  }, h.ports)).pipeline?.state).toBe("running");
  expect(lateRecovery).toMatchObject({ kind: "conflict" });
  expect(competingRegistry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    retryClaim: { claimId: expect.any(String) },
  });
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(spawnCount + 1);
});

test("a stage retry supersedes the prior attempt's conversation and numbers its round (#383)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_1:parent=/codex/creator.jsonl:supersedes=none`);

  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  /* Attempt 2 chains onto attempt 1's conversation; the durable membership
     carries the round so decks number chained recoveries. */
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_2:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`);
  expect(h.calls).toContain(`membership:pipeline:${pipeline.id}:plan:2:architect:0:round=2`);

  /* A second failure and retry chains again from attempt 2, never re-naming
     attempt 1 — chains stay linear across repeated recovery. */
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "still blocked")], h.ports);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_3:parent=/codex/creator.jsonl:supersedes=conversation_stage_2`);
});

test("issue 533: retry replays the pipeline launch contract from durable stage state", async () => {
  const h = harness();
  const launches: Array<Parameters<PipelinePorts["spawnAgent"]>[0]> = [];
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    launches.push(structuredClone(input));
    return spawn(input, onReserved);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const firstAttempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(firstAttempt.launchId).toBeString();
  h.ports.spawnReceipt = (candidate) => candidate === firstAttempt.launchId ? {
    state: "failed", launchId: firstAttempt.launchId!, conversationId: firstAttempt.conversationId!,
    sessionId: firstAttempt.sessionId, "transcript": firstAttempt.agentPath, paneId: firstAttempt.paneId,
  } : null;
  expect((await patchPipeline(pipeline.id, { action: "takeover", expectedOwner: pipeline.id, expectedEpoch: 1, reason: "resume the original publication lane" }, h.ports)).pipeline?.delivery?.active).toBe(true);
  await patchPipeline(pipeline.id, {
    action: "retry-stage", stageId: "plan", launchId: firstAttempt.launchId!,
  }, h.ports);
  await tickPipelines([], h.ports);

  const [first, retry] = launches;
  expect(retry).toMatchObject({
    role: first!.role,
    cwd: first!.cwd,
    "prompt": first!.prompt,
    parentPath: first!.parentPath,
    creatorConversationId: first!.creatorConversationId,
    membership: {
      kind: "pipeline", containerId: pipeline.id, role: first!.membership.role,
      stageId: "plan", stageOrder: 0, parentConversationId: null,
    },
    supersedes: "conversation_stage_1",
  });
  expect(retry!.membership.slot).toBe("plan:2");
  expect(retry!.membership.round).toBe(2);
});

test("a retried attempt whose predecessor never reserved a conversation records nothing (#383)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  h.ports.spawnAgent = async (input, onReserved) => {
    h.calls.push(`spawn:${input.clientAttemptId}:supersedes=${input.supersedes ?? "none"}`);
    if (input.clientAttemptId.endsWith("_1")) throw new Error("spawn transport unavailable");
    await onReserved({ launchId: "launch-late", conversationId: "conversation_stage_late" });
    return { launchId: "launch-late", conversationId: "conversation_stage_late", sessionId: "session-late", transcript: "/codex/stage-late.jsonl", paneId: "%9" };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_2:supersedes=none`);
});

test("skip-stage advances from the current clean head without cleaning", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const result = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(result.pipeline?.cursor?.stageId).toBe("build");
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
});

test("a corrupt SQLite pipeline row skips the tick without escalating", async () => {
  const h = harness();
  await create(h.ports);
  const database = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { strict: true });
  database.exec("BEGIN IMMEDIATE");
  const revision = database.query<{ revision: number }, []>(
    "SELECT revision FROM state_collections WHERE collection = 'pipelines'",
  ).get()!.revision + 1;
  const key = database.query<{ row_key: string }, []>(
    "SELECT row_key FROM state_rows WHERE collection = 'pipelines' LIMIT 1",
  ).get()!.row_key;
  database.query("UPDATE state_rows SET value_json = '{}', row_revision = ? WHERE collection = 'pipelines' AND row_key = ?")
    .run(revision, key);
  database.query("UPDATE state_collections SET revision = ? WHERE collection = 'pipelines'").run(revision);
  database.query("INSERT INTO state_changes(collection, revision, row_key, operation) VALUES ('pipelines', ?, ?, 'upsert')")
    .run(revision, key);
  database.exec("COMMIT");
  database.close();
  expect(await tickPipelines([], h.ports)).toEqual({ pipelines: [], changed: false });
  savePipelines([]);
});

test("retry preserves dirty work and skip requires a clean accepted head after verdict exhaustion (#879)", async () => {
  const exhaust = async (h: ReturnType<typeof harness>) => {
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.messages.set("/codex/stage-1.jsonl", { text: "narrative without a JSON verdict", ts: 2_000_000 });
    const entries = [entry("/codex/stage-1.jsonl")];
    await tickPipelines(entries, h.ports);
    await exhaustVerdictRecovery(h, entries);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    return pipeline;
  };

  for (const action of ["retry-stage", "skip-stage"] as const) {
    const clean = harness();
    const cleanPipeline = await exhaust(clean);
    clean.setPaneAlive(false);

    const recovered = await patchPipeline(cleanPipeline.id, { action }, clean.ports);

    expect(recovered.error).toBeUndefined();
    expect(clean.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);

    const dirty = harness();
    const dirtyPipeline = await exhaust(dirty);
    const baseExec = dirty.ports.exec;
    dirty.ports.exec = (command, args, cwd) => command === "git" && args[0] === "status"
      ? { code: 0, stdout: " M src/lib/example.ts\n", stderr: "" }
      : baseExec(command, args, cwd);

    const refused = await patchPipeline(dirtyPipeline.id, { action }, dirty.ports);

    if (action === "retry-stage") expect(refused.error).toBeUndefined();
    else {
      expect(refused.status).toBe(409);
      expect(refused.error).toContain("commit the stage's work or retry it");
    }
    expect(dirty.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);

    const publishedAhead = harness();
    const publishedAheadPipeline = await exhaust(publishedAhead);
    const publishedAheadHead = "a".repeat(40);
    const publishedAheadExec = publishedAhead.ports.exec;
    publishedAhead.ports.exec = (command, rawArgs, cwd) => {
      /* The bounded remote read runs `git` under `timeout`, so the probe has to
         look past that wrapper exactly as the harness's own exec does. */
      const args = command === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: `${publishedAheadHead}\n`, stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${publishedAheadHead}\trefs/heads/${publishedAheadPipeline.branch}\n`, stderr: "" };
      }
      return publishedAheadExec(command, rawArgs, cwd);
    };

    const ahead = await patchPipeline(publishedAheadPipeline.id, { action }, publishedAhead.ports);

    if (action === "retry-stage") {
      expect(ahead.error).toBeUndefined();
      expect(publishedAhead.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
    } else {
      /* The skip accepts the current descendant without moving the checkout. */
      expect(ahead.error).toBeUndefined();
      expect(loadPipelines()[0]!.lastPassedCommit).toBe(publishedAheadHead);
      expect(publishedAhead.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
    }
  }
});

test("retry and skip recover a completed pane-hosted semantic contradiction", async () => {
  for (const action of ["retry-stage", "skip-stage"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.messages.set("/codex/stage-1.jsonl", {
      text: [
        "VERDICT: REQUEST_CHANGES",
        "",
        "```json",
        '{"status":"pass"}',
        "```",
      ].join("\n"),
      ts: 5_000_000,
    });
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

    const parkedAttempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(parkedAttempt).toMatchObject({
      state: "needs_decision",
      paneId: "%1",
      verdict: null,
      error: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    });
    expect(parkedAttempt.completedAt).toBeTruthy();

    const recovered = await patchPipeline(pipeline.id, { action }, h.ports);
    expect(recovered.error).toBeUndefined();
    expect(recovered.pipeline?.state).toBe("running");
    expect(recovered.pipeline?.cursor).toEqual({
      stageId: action === "retry-stage" ? "plan" : "build",
      state: "pending",
      input: action === "retry-stage" ? null : "Skipped by operator.",
      activatedBy: action === "retry-stage" ? null : { stageId: "plan", attempt: 1, edge: "pass" },
      /* The hand that put the cursor there, for the attempt it launches. */
      launchedBy: { actor: { kind: "operator" }, at: expect.any(String) },
    });
  }
});

test("closing a mid-run or parked pipeline persists a record that loads back", async () => {
  const h = harness();
  /* No host and no live pane behind these stages: the close has nothing to stop
     and records the closed pipeline. A live pane is covered separately (#670). */
  h.setPaneAlive(false);
  const running = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor).not.toBeNull();
  const closed = await closeAndDrain(running.id, { action: "close" }, h.ports);
  expect(closed.pipeline?.state).toBe("closed");
  expect(closed.pipeline?.cursor).toBeNull();
  expect(loadPipelines()[0]!.state).toBe("closed");

  /* The second spawn in this harness lands in stage-2.jsonl. */
  const parked = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "blocked")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  await closeAndDrain(parked.id, { action: "close" }, h.ports);
  expect(loadPipelines()[0]!).toMatchObject({ state: "closed", cursor: null });
});

test("closing a running pipeline terminates its stage host and reports the stop (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:1:conversation_stage_1");
  expect(closed.error).toBeUndefined();
  expect(closed.close).toMatchObject({
    stopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1", agentPath: "/codex/stage-1.jsonl" }],
    alreadyStopped: [],
    stillRunning: [],
  });
  expect(loadPipelines()[0]).toMatchObject({
    state: "closed",
    cursor: null,
    stateDetail: "closed; stopped 1 stage host",
  });
});

test("closing probes every host the pipeline launched, settled rounds included (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* A settled round's attempt state says nothing about its host: the passed
     round below is still resident, and a close that trusted the state machine
     would leave it burning quota. */
  const stored = loadPipelines();
  const buildRun = stored[0]!.runs.find((run) => run.stageId === "build")!;
  const template = stored[0]!.runs[0]!.attempts[0]!;
  buildRun.attempts.push(
    { ...structuredClone(template), n: 1, state: "passed", verdict: { status: "pass" }, conversationId: "conversation_stage_settled", agentPath: "/codex/stage-settled.jsonl", completedAt: h.ports.now() },
    { ...structuredClone(template), n: 2, state: "running", conversationId: "conversation_stage_2", agentPath: "/codex/stage-2.jsonl" },
  );
  savePipelines(stored);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_settled", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:build:1:conversation_stage_settled");
  expect(closed.close?.stopped.map((item) => `${item.stageId}:${item.attempt}`)).toEqual(["plan:1", "build:1", "build:2"]);
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 3 stage hosts");
});

test("a parked stage whose host is still resident is stopped, not read as terminal (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* park() writes needs_decision while the agent process is still there — the
     7.5-hour orphans of #670 were exactly this shape. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const parked = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(parked.state).toBe("needs_decision");
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:1:conversation_stage_1");
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }]);
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: "closed; stopped 1 stage host" });
});

test("a parked stage with no resident host still reports nothing was running (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("needs_decision");

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close).toMatchObject({
    stopped: [],
    alreadyStopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }],
    stillRunning: [],
  });
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("closing a pipeline whose host is already gone reports that nothing was running (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close).toMatchObject({
    stopped: [],
    alreadyStopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }],
    unconfirmed: [],
    stillRunning: [],
  });
  /* "closed, nothing was running" carries no stop claim of any kind. */
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("an accepted but unconfirmed kill never counts as a clean stop (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", {
    outcome: "unconfirmed",
    operationId: "kill-op-1",
    detail: "kill accepted as queued but termination was not confirmed",
  });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  /* A queued receipt is the normal first answer, so this still closes — but it
     records no stop and names the operation that may have left a survivor. */
  expect(closed.error).toBeUndefined();
  expect(closed.close).toMatchObject({
    stopped: [],
    stillRunning: [],
    unconfirmed: [{ stageId: "plan", attempt: 1, operationId: "kill-op-1" }],
  });
  expect(loadPipelines()[0]!.stateDetail).toBe(
    "closed; kill accepted as queued but termination was not confirmed for stage plan attempt 1 (conversation_stage_1) (operation kill-op-1)",
  );
  /* The possible survivor stays addressable: the lane is not hidden, and the
     durable record names the operation to chase. */
  const parked = loadPipelines()[0]!;
  expect(parked.hiddenAt).toBeNull();
  expect(parked.unconfirmedHosts).toMatchObject([{ stageId: "plan", attempt: 1, operationId: "kill-op-1" }]);

  /* Closing again once the kill is confirmed settles the lane and hides it. */
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  const settled = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(settled.close?.unconfirmed).toEqual([]);
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(loadPipelines()[0]!.hiddenAt).toBe(loadPipelines()[0]!.closedAt);
});

test("a teardown that runs out of budget reports the hosts it never probed (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines();
  const buildRun = stored[0]!.runs.find((run) => run.stageId === "build")!;
  const template = stored[0]!.runs[0]!.attempts[0]!;
  buildRun.attempts.push({ ...structuredClone(template), n: 1, state: "running", conversationId: "conversation_stage_2", agentPath: "/codex/stage-2.jsonl", paneId: "%2" });
  savePipelines(stored);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });
  /* The clock jumps past the drain budget after the first host. Remaining
     targets retain their pending custody for the next controller pass. */
  let reading = 0;
  h.setMonotonicClock(() => (reading += 60_000));

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  /* The unprobed host stays named and visible until the next drain pass. */
  expect(closed.close?.pending).toMatchObject([{ stageId: "build", attempt: 1 }]);
  expect(h.calls).not.toContain("stop-host:build:1:conversation_stage_2");
  const record = loadPipelines()[0]!;
  expect(record.hiddenAt).toBeNull();
  expect(record.closeReport?.status).toBe("pending");
  h.setMonotonicClock(() => 0);
  await engineModule.drainStageActivations(h.ports);
  expect(loadPipelines()[0]!.closeReport?.stopped).toHaveLength(2);
});

test("an unconfirmed host record retires once its host is demonstrably gone (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", {
    outcome: "unconfirmed",
    operationId: "kill-op-1",
    detail: "kill accepted as queued but termination was not confirmed",
  });
  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);

  /* Still resident: the lane keeps its record and stays on the board. */
  h.setHostsResident(true);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ hiddenAt: null });
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);

  /* Gone: the record retires and the closed lane hides like any other. */
  h.setHostsResident(false);
  await tickPipelines([], h.ports);
  const settled = loadPipelines()[0]!;
  expect(settled.unconfirmedHosts).toBeUndefined();
  expect(settled.hiddenAt).toBe(settled.closedAt);
  /* The probe never kills anything — it only reads. */
  expect(h.calls.filter((call) => call.startsWith("stop-host:")).length).toBe(1);
});

test("an adopted stage child is stopped and counted, never silently left running (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The build agent spawned a helper through the viewer; adoptAttempt seats it
     on the stage run as historical and running, with its own live host. */
  const stored = loadPipelines();
  const run = stored[0]!.runs[0]!;
  run.attempts.push({
    ...structuredClone(run.attempts[0]!),
    n: 2,
    historical: true,
    state: "running",
    conversationId: "conversation_helper",
    agentPath: "/codex/helper.jsonl",
    paneId: "%9",
  });
  savePipelines(stored);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_helper", { outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:2:conversation_helper");
  expect(closed.close?.stopped).toMatchObject([
    { attempt: 1, conversationId: "conversation_stage_1" },
    { attempt: 2, conversationId: "conversation_helper", adopted: true },
  ]);
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 stage host; stopped 1 adopted agent");
});

test("a completed two-stage pipeline reaps its final stage host too (#1728)", async () => {
  const h = harness();
  await create(h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  /* The plan host is reaped while build runs, and that clean round settles
     the reap before the final stage has produced anything. */
  await tickPipelines([], h.ports);
  expect(h.calls).toContain("stop-host:plan:1:conversation_stage_1");
  expect(loadPipelines()[0]!.terminalReap?.settledAt).toEqual(expect.any(String));

  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("completed");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(h.calls.filter((call) => call.startsWith("stop-host:"))).toEqual([
    "stop-host:plan:1:conversation_stage_1",
    "stop-host:build:1:conversation_stage_2",
  ]);
  const completed = loadPipelines()[0]!;
  expect(completed.terminalReap).toMatchObject({ stopped: 2, settledAttempts: ["plan:1", "build:1"] });
  expect(completed.terminalReap!.settledAt).toEqual(expect.any(String));
});

test("an adopted child that cannot be stopped keeps the lane visible (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines();
  const run = stored[0]!.runs[0]!;
  run.attempts.push({
    ...structuredClone(run.attempts[0]!),
    n: 2,
    historical: true,
    state: "running",
    conversationId: "conversation_helper",
    agentPath: "/codex/helper.jsonl",
    paneId: null,
  });
  savePipelines(stored);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_helper", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(refused.error).toBeUndefined();
  expect(refused.pipeline?.stateDetail).toContain("adopted agent of stage plan attempt 2");
  expect(loadPipelines()[0]!.state).toBe("closed");
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
});

test("an unidentifiable pane can be dismissed by the operator once judged (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(true);
  h.setPaneStop({
    outcome: "unknown",
    detail: "pane %1 now runs codex in window other and cannot be identified as this stage's agent",
  });

  const pinned = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(pinned.close?.unconfirmed).toHaveLength(1);
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
  /* The detail names what the pane actually shows, so the operator can find it. */
  expect(loadPipelines()[0]!.stateDetail).toContain("now runs codex in window other");

  /* Their judgement is the way out: the lane stops claiming a host it could
     never identify, and leaves the board. */
  const dismissed = await closeAndDrain(pipeline.id, { action: "close", acknowledgeHosts: true }, h.ports);

  expect(dismissed.error).toBeUndefined();
  expect(dismissed.close?.acknowledged).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1" }]);
  expect(dismissed.close?.unconfirmed).toEqual([]);
  const settled = loadPipelines()[0]!;
  expect(settled.unconfirmedHosts).toBeUndefined();
  expect(settled.hiddenAt).toBe(settled.closedAt);
  expect(settled.stateDetail).toContain("dismissed 1 unconfirmed host");
});

test("an acknowledgement never dismisses a host that is provably still running (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await closeAndDrain(pipeline.id, { action: "close", acknowledgeHosts: true }, h.ports);

  expect(refused.error).toBeUndefined();
  expect(refused.close?.acknowledged).toEqual([]);
  expect(loadPipelines()[0]!.state).toBe("closed");
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
});

test("closing mid-review counts the reviewer it stopped (#670)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  /* A headless reviewer is a child process with no registry entry, so the host
     teardown cannot see it — closeFlow is what stops it. */
  h.ports.closeFlow = async (id) => {
    h.calls.push(`flow-close:${id}`);
    return { flow: h.flows.get(id), stoppedReviewer: { round: 1 } };
  };

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.reviewers).toMatchObject([{ stageId: "review", flowId: "flow-1", round: 1 }]);
  /* The lane must not report "closed, nothing was running" after killing one. */
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 review round");
});

test("a worktree removed after a merge closes tidily, with no error text (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    /* What realExec answers for a missing cwd. It must never be reached. */
    if (command === "git" && args[0] === "status") return { code: 1, stdout: "", stderr: "spawnSync git ENOENT" };
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setWorktreePresent(false);

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close?.worktree).toBeNull();
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("a settled attempt with an idle CLI in its pane does not block the close (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* A verdict means the turn ended, so what is left in the pane is an idle CLI —
     the exemption orphanAgentPane applies to a retry. The pane stays alive here. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const settled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(settled.verdict).toMatchObject({ status: "pass" });
  expect(settled.paneId).toBe("%1");

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("a pane the teardown can identify as this stage's is stopped, not refused (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The registry has no resident host but the pane's recorded identity still
     matches, so the orphan is stopped instead of handed back to the operator. */
  h.setPaneAlive(true);
  h.setPaneStop({ outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(h.calls).toContain("stop-pane:plan:1:%1");
  expect(h.killedPanes).toEqual(["%1"]);
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1" }]);
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: "closed; stopped 1 stage host" });
});

test("close terminalizes a running attempt after confirmed host and pane absence (#1047, #988)", async () => {
  for (const absent of ["structured-host", "pane"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const stored = loadPipelines()[0]!;
    const attempt = stored.runs[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ state: "running", completedAt: null });
    if (absent === "structured-host") attempt.paneId = null;
    else h.setPaneStop({ outcome: "not-running" });
    savePipelines([stored]);

    const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(closed.error).toBeUndefined();
    expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      state: "failed",
      completedAt: expect.any(String),
    });
  }
});

test("a pane that cannot be identified is reported, never killed (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(true);
  h.setPaneStop({ outcome: "unknown", detail: "pane %1 runs an agent that cannot be identified as this stage's" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  /* Unidentifiable is neither a stop nor a silent pass: nothing was signalled,
     and the lane stays visible with the pane named. */
  expect(h.killedPanes).toEqual([]);
  expect(closed.close?.stopped).toEqual([]);
  expect(closed.close?.unconfirmed).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1", operationId: null }]);
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
  expect(loadPipelines()[0]!.stateDetail).toContain("cannot be identified");
});

test("an unreadable worktree is reported instead of closing as if nothing was left (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const baseExec = h.ports.exec;
  let failStatus = false;
  h.ports.exec = (command, args, cwd) => {
    if (failStatus && command === "git" && args[0] === "status") {
      return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  failStatus = true;

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.worktree).toMatchObject({ uncommitted: [], error: "checking the pipeline worktree: fatal: not a git repository" });
  /* An unreadable worktree must not look like a verified-clean one. */
  expect(loadPipelines()[0]!.stateDetail).toBe(
    `closed; could not read the worktree at ${loadPipelines()[0]!.worktreeDir}: checking the pipeline worktree: fatal: not a git repository`,
  );
});

test("a stage host that cannot be stopped stays visible after close (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(refused.error).toBeUndefined();
  expect(refused.pipeline?.stateDetail).toBe(
    "closed; could not stop stage plan attempt 1 (conversation_stage_1): structured host ownership is unavailable",
  );
  expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", conversationId: "conversation_stage_1" }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).toBe("closed");
  expect(stored.hiddenAt).toBeNull();
  expect(stored.closedAt).not.toBeNull();
  expect(stored.stateDetail).toContain("structured host ownership is unavailable");
});

test("terminal transcript prose without a valid fenced verdict cannot dismiss a resident host (#1047, #988)", async () => {
  for (const text of [
    "Review completed with no findings.",
    "Review completed.\n\n```json\n{\"status\":\"pass\",\"findings\":\"none\",\"confidence\":0.9}\n```",
  ]) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.setHostsResident(true);
    h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "terminal",
      message: { text, ts: 5_000_000 },
    });

    const refused = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(refused.error).toBeUndefined();
    expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(loadPipelines()[0]).toMatchObject({ state: "closed", hiddenAt: null });
  }
});

test("close terminalizes host-unavailable attempts from durable evidence and records the failure (#1047, #988)", async () => {
  for (const evidence of ["registry-absent", "terminal-transcript"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const stored = loadPipelines()[0]!;
    const attempt = stored.runs[0]!.attempts[0]!;
    attempt.state = "needs_decision";
    attempt.error = "operator decision was resolved after the work merged";
    stored.state = "needs_decision";
    stored.stateDetail = attempt.error;
    savePipelines([stored]);
    const stopError = evidence === "registry-absent"
      ? "structured host termination is unavailable"
      : "structured host termination target is unavailable";
    h.setStageHost("conversation_stage_1", { outcome: "failed", error: stopError });

    if (evidence === "terminal-transcript") {
      h.setHostsResident(true);
      h.durableTurns.set("/codex/stage-1.jsonl", {
        turn: "terminal",
        message: {
          text: "Completed review.\n\n```json\n{\"status\":\"needs_decision\",\"findings\":[],\"confidence\":0.9}\n```",
          ts: 5_000_000,
        },
      });
    }

    const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(closed.error).toBeUndefined();
    expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(closed.close?.notes).toMatchObject([{ stageId: "plan", attempt: 1, detail: expect.stringContaining(stopError) }]);
    const terminal = loadPipelines()[0]!;
    expect(terminal.state).toBe("closed");
    expect(terminal.runs[0]!.attempts[0]!.completedAt).toBeTruthy();
    expect(terminal.stateDetail).toContain(stopError);
  }
});

test("a re-hosted Codex continuation settles once and activates the next stage exactly once (#1589)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  /* Through the real projection over the real fixture, so the assertion fails
     for the reason the incident had rather than for a hand-shaped map entry. */
  readFixtures(h, { "/codex/stage-1.jsonl": severedToolTranscript("issue-1589-severed-tool") });

  await tickPipelines([], h.ports);

  const settled = loadPipelines()[0]!;
  expect(settled.runs[0]!.attempts).toHaveLength(1);
  expect(settled.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
  });
  /* No recovery misses were spent, so nothing asked the operator anything. */
  expect(settled.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
  expect(settled).toMatchObject({ state: "running", stateDetail: null });
  expect(settled.cursor).toMatchObject({ stageId: "build", state: "pending" });
  expect(settled.lastPassedCommit).toBe(STAGE_HEAD);

  await tickPipelines([], h.ports);

  const advanced = loadPipelines()[0]!;
  expect(advanced.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);

  /* A third tick is the exactly-once check: no second settlement, no second
     attempt on either stage, no second spawn. */
  await tickPipelines([], h.ports);

  const stable = loadPipelines()[0]!;
  expect(stable.runs[0]!.attempts).toHaveLength(1);
  expect(stable.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(stable).toMatchObject({ state: "running", stateDetail: null });
});

test("a truncated mid-turn window cannot settle a structured stage on its trailing message (#1589)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  readFixtures(h, { "/codex/stage-1.jsonl": truncatedMidTurnTranscript("issue-1589-truncated-mid-turn") });

  /* The scan does have the transcript and its trailing message parses as a
     verdict; only the busy turn projection stands between them and a
     settlement over work that is still running. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  expect(current.runs[1]!.attempts).toHaveLength(0);
  expect(current.cursor?.stageId).toBe("plan");
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});

test("a usage-limit terminal transcript waits for its source reset while checking other accounts (#1371)", async () => {
  const h = harness();
  const currentReset = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const earlierReset = Math.floor(Date.parse("2026-09-02T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("running-usage-limit", currentReset) });
  usageLimitPorts(h, {
    kind: "exhausted",
    resetsAt: earlierReset,
    allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT],
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  const detail = expect.stringContaining(new Date(currentReset * 1_000).toISOString());
  expect(parked).toMatchObject({ state: "running", stateDetail: detail });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "running", error: null, providerWait: { resetsAt: currentReset } });
});

test("an unpinned usage-limited stage respawns on another allowed account (#1371)", async () => {
  const h = harness();
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("failover-usage-limit", resetsAt) });
  usageLimitPorts(h, {
    kind: "available",
    account: {
      engine: "codex",
      accountId: SPARE_ACCOUNT,
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  });

  await tickPipelines([], h.ports);
  const retrying = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  expect(retrying.stateDetail).toContain("relaunching after codex usage limit");
  expect(retrying.runs[0]!.attempts).toHaveLength(2);
  expect(retrying.runs[0]!.attempts[0]).toMatchObject({ state: "failed" });
  expect(retrying.runs[0]!.attempts[1]).toMatchObject({ state: "pending" });

  await tickPipelines([], h.ports);

  const failedOver = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  expect(h.spawnInputs[1]).toMatchObject({ requestedAccountId: SPARE_ACCOUNT, unavailableAccountIds: [LIMITED_ACCOUNT] });
  expect(failedOver.runs[0]!.attempts[1]).toMatchObject({ state: "running", accountId: SPARE_ACCOUNT });
});

test("a Claude session limit preserves dirty work, stage identity and review rounds through controller recovery", async () => {
  const h = harness();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-limit-work-"));
  let repo = "";
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  try {
    const pipeline = await create(h.ports, [
      { ...usageLimitStage()[0], engine: "claude", model: "fable", next: "review" },
      { id: "review", kind: "run", engine: "claude", model: "fable", access: "read-only", prompt: "Review", next: null, onFail: { to: "build", maxRounds: 3 } },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail")], h.ports);
    await tickPipelines([], h.ports);
    const before = loadPipelines().find((item) => item.id === pipeline.id)!;
    before.repoDir = path.join(root, "repo");
    repo = path.join(root, `repo-pipeline-${pipeline.id}`);
    before.worktreeDir = repo;
    const limited = before.runs.find((run) => run.stageId === "build")!.attempts[1]!;
    limited.paneId = null;
    savePipelines([before]);
    const roundCount = edgeRoundsUsed(before, { from: "build", to: "review", kind: "pass" });
    expect(roundCount).toBe(1);

    fs.mkdirSync(repo);
    (await git("init", "-q"));
    fs.writeFileSync(path.join(repo, "work.txt"), "before\n");
    (await git("add", "work.txt"));
    (await git("-c", "user.name=Test", "-c", "user.email=fixture", "commit", "-qm", "baseline"));
    fs.writeFileSync(path.join(repo, "work.txt"), "unfinished Claude edit\n");
    const dirtyDiff = (await git("diff", "--", "work.txt"));
    expect(dirtyDiff).toContain("unfinished Claude edit");
    readFixtures(h, { "/codex/stage-3.jsonl": limitInterruptedTranscript("claude-controller-session-limit", "You've hit your session limit · resets 2:30pm (Europe/Kyiv)") });
    usageLimitPorts(h, { kind: "available", account: {
      engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
    } });
    const reseats: string[] = [];
    const continuations: string[] = [];
    h.ports.requestConversationReseat = async (_id, target) => { reseats.push(target); };
    h.ports.resumeSeveredTurn = async input => { continuations.push(input.clientMessageId); return true; };
    h.ports.accountForTranscript = () => ({ accountId: LIMITED_ACCOUNT, label: LIMITED_ACCOUNT_LABEL });
    await tickPipelines([], h.ports);
    const switching = loadPipelines().find(item => item.id === pipeline.id)!;
    expect(switching.cursor).toMatchObject({ stageId: "build", state: "pending" });
    expect(switching.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(3);
    expect(switching.runs.find(run => run.stageId === "build")!.attempts[1]).toMatchObject({
      state: "failed", conversationId: limited.conversationId,
      usageLimitedAccounts: [{ accountId: LIMITED_ACCOUNT, engine: "claude", resetsAt: Date.parse("2026-08-27T11:30:00Z") / 1_000 }],
    });
    expect(switching.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(1);
    expect(edgeRoundsUsed(switching, { from: "build", to: "review", kind: "pass" })).toBe(roundCount);
    expect(await git("diff", "--", "work.txt")).toBe(dirtyDiff);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const resumed = loadPipelines().find(item => item.id === pipeline.id)!;
    expect(resumed.id).toBe(pipeline.id);
    expect(resumed.branch).toBe(pipeline.branch);
    expect(resumed.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(3);
    expect(resumed.runs.find(run => run.stageId === "build")!.attempts[2]).toMatchObject({
      state: "running", accountId: SPARE_ACCOUNT,
      usageLimitedAccounts: switching.runs.find(run => run.stageId === "build")!.attempts[1]!.usageLimitedAccounts,
    });
    expect(h.spawnInputs).toHaveLength(4);
    expect(h.spawnInputs[3]!.requestedAccountId).toBe(SPARE_ACCOUNT);
    expect(reseats).toEqual([]);
    expect(continuations).toEqual([]);
    expect(edgeRoundsUsed(resumed, { from: "build", to: "review", kind: "pass" })).toBe(roundCount);
    expect(await git("diff", "--", "work.txt")).toBe(dirtyDiff);
    expect(h.calls.filter((call) => /\b(?:reset|clean)\b/.test(call))
      .every((call) => call === `git reset --quiet HEAD -- ${CONTROLLER_ARTIFACT_GIT_PATHS.join(" ")}`)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude stage waits without a free allowed account and launches on the spare when capacity returns", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines().find((item) => item.id === pipeline.id)!;
  const attempt = running.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([running]);
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("claude-no-capacity") });
  usageLimitPorts(h, { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });

  await tickPipelines([], h.ports);
  const parked = loadPipelines().find((item) => item.id === pipeline.id)!;
  expect(parked).toMatchObject({ state: "running", stateDetail: expect.stringContaining("waiting for claude session limit") });
  expect(parked.runs[0]!.attempts).toHaveLength(1);
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ conversationId: attempt.conversationId, state: "running" });

  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed",
    home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  } });
  const reseats: string[] = [];
  const continuations: string[] = [];
  h.ports.requestConversationReseat = async (conversationId, accountId) => { reseats.push(`${conversationId}:${accountId}`); };
  h.ports.resumeSeveredTurn = async (input) => { continuations.push(input.clientMessageId); return true; };

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const resumed = loadPipelines().find(item => item.id === pipeline.id)!;
  expect(resumed.state).toBe("running");
  expect(resumed.runs[0]!.attempts).toHaveLength(2);
  expect(resumed.runs[0]!.attempts[1]).toMatchObject({ state: "running", accountId: SPARE_ACCOUNT });
  expect(resumed.runs[0]!.attempts[1]!.conversationId).not.toBe(attempt.conversationId);
  expect(reseats).toEqual([]);
  expect(continuations).toEqual([]);
});

test("a Claude stage retains the source account's confirmed reset when no allowed account is free", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines().find((item) => item.id === pipeline.id)!;
  const attempt = running.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([running]);
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("claude-known-reset") });

  const now = Date.now();
  const resetsAt = Math.floor(now / 1_000) + 15 * 60;
  const observation: DurableQuotaObservation = {
    engine: "claude", accountId: LIMITED_ACCOUNT, authenticated: true,
    authCheckedAt: new Date(now - 1_000).toISOString(),
    limits: { session: { usedPercent: 100, resetsAt }, weekly: null, plan: "max", capturedAt: Math.floor(now / 1_000) },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: new Date(now - 1_000).toISOString(), bootId: "known-reset",
  };
  const selection = (unavailableIds: string[] = []) => selectProjectAccount({
    project: pipeline.project, engine: "claude", model: "fable",
    accounts: [{ id: LIMITED_ACCOUNT, authPresent: true }, { id: SPARE_ACCOUNT, authPresent: true }],
    observations: [observation],
    bindings: [{ engine: "claude", accountId: LIMITED_ACCOUNT, project: pipeline.project, createdAt: new Date(now).toISOString() }],
    unavailableIds, now,
  });
  expect(selection()).toMatchObject({ kind: "exhausted", resetsAt });
  h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  h.ports.accountLabel = () => LIMITED_ACCOUNT_LABEL;
  h.ports.resolveProjectSpawn = (_engine, request) => {
    const selected = selection(request.unavailableIds ?? []);
    return selected.kind === "available"
      ? { kind: "unavailable", allowedAccountIds: [LIMITED_ACCOUNT] }
      : selected;
  };
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "known-reset-registry.json"));
  registry.recordQuotaObservation(observation);
  setAgentRegistryForTests(registry);
  try {
    h.ports.claudeAccountReset = defaultPipelinePorts().claudeAccountReset;
  } finally {
    setAgentRegistryForTests(null);
  }
  expect(h.ports.claudeAccountReset?.(LIMITED_ACCOUNT, "fable")).toBe(resetsAt);

  await tickPipelines([], h.ports);
  const parked = loadPipelines().find((item) => item.id === pipeline.id)!;
  expect(parked).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining("waiting for claude session limit"),
  });
  expect(parked.runs[0]!.attempts[0]!.usageLimitedAccounts).toMatchObject([
    { accountId: LIMITED_ACCOUNT, resetsAt },
  ]);

  const dateNow = spyOn(Date, "now").mockImplementation(() => (resetsAt + 61) * 1_000);
  try {
    h.ports.now = () => new Date(Date.now()).toISOString();
    h.ports.resumeSeveredTurn = async () => true;
    await tickPipelines([], h.ports);
    const resumed = loadPipelines().find((item) => item.id === pipeline.id)!;
    expect(resumed.state).toBe("running");
    expect(resumed.runs[0]!.attempts).toHaveLength(1);
    expect(resumed.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: attempt.conversationId });
  } finally {
    dateNow.mockRestore();
  }
});

test("a removed waiting account stays stopped and starts a linked attempt when allowed capacity returns", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines().find((item) => item.id === pipeline.id)!;
  const attempt = running.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([running]);
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("claude-source-reset") });
  usageLimitPorts(h, { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT] });
  let recovered = false;
  let allowed = [LIMITED_ACCOUNT];
  h.ports.allowedAccountIds = () => allowed;
  h.ports.claudeAccountRecovered = () => recovered;
  h.ports.resolveProjectSpawn = () => recovered && allowed.includes(LIMITED_ACCOUNT)
    ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed",
      home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
    : { kind: "exhausted", resetsAt: null, allowedAccountIds: allowed };
  const continuations: string[] = [];
  const cohorts: Array<string | undefined> = [];
  h.ports.resumeSeveredTurn = async (input) => { continuations.push(input.conversationId); cohorts.push(input.cohortAt); return true; };

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  recovered = true;
  allowed = [SPARE_ACCOUNT];
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  allowed = [LIMITED_ACCOUNT];
  await tickPipelines([], h.ports);
  const resumed = loadPipelines()[0]!;
  expect(resumed.state).toBe("running");
  expect(resumed.runs[0]!.attempts).toHaveLength(2);
  expect(resumed.runs[0]!.attempts[0]).toMatchObject({ conversationId: attempt.conversationId, state: "failed",
    suspension: { stoppedAt: expect.any(String) } });
  expect(resumed.runs[0]!.attempts[1]).toMatchObject({ accountId: LIMITED_ACCOUNT,
    restartContext: { previousAttempt: 1, transcriptPath: attempt.agentPath }, input: attempt.input });
  expect(resumed.worktreeDir).toBe(running.worktreeDir);
  expect(continuations).toEqual([]);
  expect(cohorts).toEqual([]);
});

test("a Claude account without a known new reset stays excluded within the native cut chain", async () => {
  const h = harness();
  await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([lane]);
  readFixtures(h, {
    "/codex/stage-1.jsonl": limitInterruptedTranscript("claude-limited-a"),
    "/codex/stage-2.jsonl": stageTranscript("claude-limited-b", [{ type: "assistant", timestamp: "2026-08-27T09:50:00.000Z", isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: PROVIDER_LIMIT_NOTICE }] } }]),
  });
  h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  h.ports.claudeAccountRecovered = () => true;
  h.ports.resolveProjectSpawn = (_engine, input) => {
    const available = [SPARE_ACCOUNT, LIMITED_ACCOUNT].find(id => !input.unavailableIds?.includes(id));
    return available ? { kind: "available", account: { engine: "claude", accountId: available, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const fresh = loadPipelines()[0]!;
  fresh.runs[0]!.attempts[1]!.paneId = null;
  savePipelines([fresh]);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.providerWait?.stageRetry).toBeDefined();
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
});


test("separate Claude limit turns on one account receive separate registry deliveries", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  const source = limitInterruptedTranscript("claude-repeat-limit-1");
  const fixtures = { "/codex/stage-1.jsonl": source };
  readFixtures(h, fixtures);
  usageLimitPorts(h, { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT] });
  h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  let recovered = false;
  h.ports.claudeAccountRecovered = () => recovered;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "claude-repeat-limit-registry.json"));
  registry.reconcileConversations([{ engine: "claude", path: source, accountId: LIMITED_ACCOUNT,
    launchProfile: emptyLaunchProfile({ cwd: pipeline.worktreeDir, project: pipeline.project, model: "fable", effort: "high" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-08-27T09:41:00.000Z" },
    observedAt: "2026-08-27T09:41:01.000Z" }]);
  const conversation = registry.conversationForPath(source)!;
  const deliveries: string[] = [];
  h.ports.resumeSeveredTurn = async (input) => {
    const receipt = registry.holdDelivery(conversation.id, input.text, input.clientMessageId);
    deliveries.push(receipt.id);
    registry.recordDeliveryOutcome(receipt.id, "delivered");
    return true;
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  recovered = true;
  await tickPipelines([], h.ports);
  expect(deliveries).toHaveLength(1);
  await tickPipelines([], h.ports);
  expect(deliveries.at(-1)).toBe(deliveries[0]);

  recovered = false;
  fs.appendFileSync(source, [
    { type: "user", uuid: "repeat-limit-controller", promptSource: "sdk", timestamp: "2026-08-27T09:42:00.000Z", message: { role: "user", content: "continue" } },
    { type: "assistant", timestamp: "2026-08-27T09:50:00.000Z", isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: PROVIDER_LIMIT_NOTICE }] } },
  ].map(record => JSON.stringify(record) + "\n").join(""));
  await stampPipelinePrompt(source, "repeat-limit-controller", "continue");
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  recovered = true;
  await tickPipelines([], h.ports);
  expect(new Set(deliveries).size).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test("an explicitly pinned Claude stage waits despite another free account and resumes on its own", async () => {
  const h = harness();
  await create(h.ports, [{ ...usageLimitStage(LIMITED_ACCOUNT)[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("claude-pinned-limit") });
  usageLimitPorts(h, { kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed",
    home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  let recovered = false;
  h.ports.claudeAccountRecovered = () => recovered;
  const reseats: string[] = [];
  const continuations: string[] = [];
  h.ports.requestConversationReseat = async (_id, target) => { reseats.push(target); };
  h.ports.resumeSeveredTurn = async (input) => { continuations.push(input.conversationId); return true; };

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(reseats).toEqual([]);
  recovered = true;
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(reseats).toEqual([]);
  expect(continuations.length).toBeGreaterThan(0);
  expect(new Set(continuations)).toEqual(new Set([running.runs[0]!.attempts[0]!.conversationId!]));
});

test("a recorded Claude limit launches a fresh target registry conversation and settles there", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const sourcePath = limitInterruptedTranscript("claude-real-source");
  const targetPath = stageTranscript("claude-real-fresh-target", [
    { type: "user", timestamp: "2026-08-27T09:42:00.000Z", message: { role: "user", content: "run the same stage in its worktree" } },
    { type: "assistant", timestamp: "2026-08-27T09:43:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] } },
  ]);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "claude-limit-fresh-registry.json"));
  const launchProfile = emptyLaunchProfile({ cwd: pipeline.worktreeDir, project: pipeline.project, model: "fable", effort: "high" });
  registry.reconcileConversations([{ engine: "claude", path: sourcePath, accountId: LIMITED_ACCOUNT, launchProfile,
    turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-08-27T09:41:00.000Z" }, observedAt: "2026-08-27T09:41:01.000Z" }]);
  const source = registry.conversationForPath(sourcePath)!;
  const running = loadPipelines()[0]!;
  Object.assign(running.runs[0]!.attempts[0]!, { conversationId: source.id, agentPath: sourcePath, accountId: LIMITED_ACCOUNT, paneId: null });
  savePipelines([running]);
  h.ports.pathForConversation = id => registry.conversation(id as typeof source.id)?.generations.at(-1)?.path ?? null;
  h.ports.accountForTranscript = (_engine, pathname) => {
    const generation = registry.conversationForPath(pathname)?.generations.find(item => item.path === pathname);
    return generation?.accountId ? { accountId: generation.accountId, label: "account" } : null;
  };
  h.ports.durableTurnEvidence = durableStageTurnEvidence;
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    expect(input.requestedAccountId).toBe(SPARE_ACCOUNT);
    const launched = await baseSpawn(input, async () => {});
    registry.reconcileConversations([{ engine: "claude", path: targetPath, accountId: input.requestedAccountId!, launchProfile,
      turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-08-27T09:43:00.000Z" }, observedAt: "2026-08-27T09:43:01.000Z" }]);
    const target = registry.conversationForPath(targetPath)!;
    await reserved({ launchId: launched.launchId, conversationId: target.id, accountId: SPARE_ACCOUNT });
    return { ...launched, conversationId: target.id, transcript: targetPath, accountId: SPARE_ACCOUNT, paneId: null };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const settled = loadPipelines()[0]!;
  expect(settled.runs[0]!.attempts).toHaveLength(2);
  expect(settled.runs[0]!.attempts[1]).toMatchObject({ agentPath: targetPath, accountId: SPARE_ACCOUNT, verdict: { status: "pass" } });
  expect(settled.runs[0]!.attempts[1]!.conversationId).not.toBe(source.id);
  expect(registry.conversation(source.id)!.generations).toHaveLength(1);
  expect(registry.conversation(source.id)!.migration).toBeNull();
  expect(registry.pendingDeliveries(source.id)).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(2);
});


test("a failed Claude migration retains its original operation while the stage launches fresh", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { advanceConversationMigration } = await import("@/lib/accounts/migration/coordinator");
  const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const sourcePath = limitInterruptedTranscript("claude-failed-migration");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "claude-failed-migration-registry.json"));
  registry.reconcileConversations([{
    engine: "claude", path: sourcePath, accountId: LIMITED_ACCOUNT,
    launchProfile: emptyLaunchProfile({ cwd: pipeline.worktreeDir, project: pipeline.project, model: "fable", effort: "high" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-08-27T09:41:00.000Z" },
    observedAt: "2026-08-27T09:41:01.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.setEngineRouting("claude", "account-previously-limited");
  const running = loadPipelines()[0]!;
  Object.assign(running.runs[0]!.attempts[0]!, {
    conversationId: conversation.id, agentPath: sourcePath, accountId: LIMITED_ACCOUNT, paneId: null,
  });
  savePipelines([running]);
  setAgentRegistryForTests(registry);
  try {
    const defaults = defaultPipelinePorts();
    h.ports.requestConversationReseat = defaults.requestConversationReseat;
    h.ports.conversationMigration = defaults.conversationMigration;
    h.ports.durableTurnEvidence = durableStageTurnEvidence;
    h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
      engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
    } });
    h.ports.accountForTranscript = () => ({ accountId: LIMITED_ACCOUNT, label: LIMITED_ACCOUNT_LABEL });
    h.ports.pathForConversation = (id) => id === conversation.id ? sourcePath : null;
    h.ports.resumeSeveredTurn = async (input) => (await enqueueStructuredMessage({
      path: input.transcriptPath, conversationId: input.conversationId,
      clientMessageId: input.clientMessageId, text: input.text,
    }, {
      enabled: () => true, client: () => null, registry: () => registry,
      requestMigrationTick: () => {}, kick: async () => {},
    }))?.ok === true;

    registry.requestConversationReseat(conversation.id, SPARE_ACCOUNT);
    const first = registry.conversation(conversation.id)!.migration!;
    expect(first).toMatchObject({ phase: "requested", targetId: SPARE_ACCOUNT });
    const failed = await advanceConversationMigration(conversation.id, registry, {
      virtualSource: true,
      async create() { throw new Error("provider temporarily unavailable"); },
      async verify() {},
    });
    expect(failed.migration).toMatchObject({ phase: "failed-recoverable", operationId: first.operationId });

    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(registry.conversation(conversation.id)!.migration).toMatchObject({
      phase: "failed-recoverable", operationId: first.operationId, targetId: SPARE_ACCOUNT,
    });
    expect(registry.pendingDeliveries(conversation.id)).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ accountId: SPARE_ACCOUNT, state: "running" });
    expect(h.spawnInputs[1]!.unavailableAccountIds).not.toContain(SPARE_ACCOUNT);

  } finally {
    setAgentRegistryForTests(null);
  }
});

test("a delivered Claude limit continuation releases later dead-host recovery", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const h = harness();
  const pipeline = await create(h.ports, [{ ...usageLimitStage()[0], engine: "claude", model: "fable" }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const sourcePath = limitInterruptedTranscript("claude-delivered-then-dead");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "claude-delivered-then-dead-registry.json"));
  registry.reconcileConversations([{
    engine: "claude", path: sourcePath, accountId: LIMITED_ACCOUNT,
    launchProfile: emptyLaunchProfile({ cwd: pipeline.worktreeDir, project: pipeline.project, model: "fable", effort: "high" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-08-27T09:41:00.000Z" },
    observedAt: "2026-08-27T09:41:01.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  const running = loadPipelines()[0]!;
  Object.assign(running.runs[0]!.attempts[0]!, {
    conversationId: conversation.id, agentPath: sourcePath, accountId: LIMITED_ACCOUNT, paneId: null,
  });
  savePipelines([running]);
  readFixtures(h, { [sourcePath]: sourcePath });
  usageLimitPorts(h, { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT] });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");

  h.ports.claudeAccountRecovered = () => true;
  h.ports.resumeSeveredTurn = async (input) => {
    const receipt = registry.holdDelivery(conversation.id, input.text, input.clientMessageId);
    registry.recordDeliveryOutcome(receipt.id, "delivered");
    return true;
  };
  setAgentRegistryForTests(registry);
  try {
    h.ports.conversationDeliveryCompleted = defaultPipelinePorts().conversationDeliveryCompleted;
  } finally {
    setAgentRegistryForTests(null);
  }
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  h.ports.durableTurnEvidence = async () => null;
  h.ports.conversationHostUnavailableSince = async () => new Date(1).toISOString();
  await tickPipelines([], h.ports);
  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered.state).toBe("running");
  expect(recovered.runs[0]!.attempts).toHaveLength(2);
  expect(recovered.stateDetail).not.toContain("Claude limit: continuing");
  expect(h.calls.some((call) => call.startsWith("stop-host:build:1:"))).toBe(true);
});

test("a failover attempt edited to another engine launches there with none of the old engine's limits (graph slice 1)", async () => {
  const h = harness();
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("failover-engine-override", resetsAt) });
  usageLimitPorts(h, {
    kind: "available",
    account: {
      engine: "codex",
      accountId: SPARE_ACCOUNT,
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  });
  await tickPipelines([], h.ports);
  const retrying = loadPipelines()[0]!.runs[0]!.attempts[1]!;
  expect(retrying).toMatchObject({ state: "pending", usageLimitedAccounts: [{ accountId: LIMITED_ACCOUNT, engine: "codex", resetsAt }] });
  expect(retrying.definition).toBeUndefined();

  const edited = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" } }, h.ports);
  expect(edited.graphEdit).toMatchObject({ effect: "applied", appliesFromAttempt: 2 });

  /* The Claude account shares the limited Codex account's id and never hit a limit. */
  const checks: Array<{ engine: string; unavailableIds: string[] }> = [];
  Object.assign(h.ports, {
    resolveProjectSpawn: (engine: "claude" | "codex", request: { unavailableIds?: string[] }) => {
      checks.push({ engine, unavailableIds: [...(request.unavailableIds ?? [])] });
      return { kind: "unavailable", allowedAccountIds: [LIMITED_ACCOUNT] };
    },
  });
  await tickPipelines([], h.ports);

  const launched = loadPipelines()[0]!;
  expect(checks).toEqual([]);
  expect(launched.state).toBe("running");
  expect(launched.runs[0]!.attempts[1]).toMatchObject({ state: "running", accountId: LIMITED_ACCOUNT });
  expect(launched.runs[0]!.attempts[1]!.effectiveRole.engine).toBe("claude");
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.role.engine).toBe("claude");
  expect(h.spawnInputs[1]!.unavailableAccountIds).toEqual([]);
});

test("a usage limit hit after the stage moved to another engine retries there without checking the old engine (graph slice 1)", async () => {
  const h = harness();
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const edited = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" } }, h.ports);
  expect(edited.graphEdit).toMatchObject({ effect: "pending-next-attempt", appliesFromAttempt: 2 });

  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("limit-after-engine-override", resetsAt) });
  const checks: string[] = [];
  usageLimitPorts(h, { kind: "exhausted", resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  Object.assign(h.ports, {
    resolveProjectSpawn: (engine: "claude" | "codex") => {
      checks.push(engine);
      return { kind: "exhausted", resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
    },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const retried = loadPipelines()[0]!;
  expect(checks).toEqual([]);
  expect(retried.state).toBe("running");
  expect(retried.runs[0]!.attempts[0]).toMatchObject({ state: "failed", usageLimitedAccounts: [{ accountId: LIMITED_ACCOUNT, engine: "codex", resetsAt }] });
  expect(retried.runs[0]!.attempts[1]).toMatchObject({ state: "running" });
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.role.engine).toBe("claude");
  expect(h.spawnInputs[1]!.unavailableAccountIds).toEqual([]);
});
