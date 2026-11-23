import { afterAll, afterEach, spyOn } from "bun:test";
import path from "node:path";
import { expect, test, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, closeAndDrain } from "./engine.fixture";
import { decideProactiveTask, proactiveDecisionToken } from "@/lib/tasks/proactive";
import { NOW } from "@/lib/tasks/proactive.fixture";

import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";

import { assertProactivePipelineExecution } from "@/lib/tasks/proactiveExecution";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { TASKS_FILE, loadTasksByIds, mutateTasks } from "@/lib/tasks/store";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { proactiveGraphDigest } from "@/lib/tasks/proactiveLane";
import { requestDigest } from "@/lib/mcp/server";
import { mergeAdmission, mergeEligible } from "@/lib/forge/autoMerge";
import { mergeOnReviewSetting } from "@/lib/projects/settings";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { fixture, stages } from "./engine.proactive.fixture";

const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterEach(() => { clock.mockImplementation(() => NOW); });
afterAll(() => clock.mockRestore());

test.each(["write-boundary", "open-ack", "closed-merged", "hidden-merged", "closed-unmerged", "closed-ack", "head-changed", "review-changed"])("unadopted merge custody survives restart: %s", async kind => {
  const f = await fixture(`merge-custody-${kind}`);
  await f.complete();
  const { sweepAutoMerge, MERGE_SETTLE_MS, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
  const { findPipelineRecord } = await import("./store");
  let now = NOW, writes = 0, reads = 0, state = "OPEN";
  let boundary: ReturnType<typeof f.current> | undefined;
  const head = f.current().lastPassedCommit!;
  const ports: import("@/lib/forge/autoMerge").AutoMergePorts = {
    now: () => now, loadPipelines,
    mutate: async (id, change) => { const lanes = loadPipelines(); const lane = lanes.find(row => row.id === id); if (!lane || !change(lane)) return false; savePipelines(lanes); return true; },
    setting: () => ({ enabled: true, changedAt: new Date(NOW - 3_600_000).toISOString(), changedBy: "operator" }),
    pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }), cachedState: () => null,
    run: async args => {
      if (args[0] === "pr" && args[1] === "view") { reads++; return JSON.stringify({ state, headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        mergeCommit: state === "MERGED" ? { oid: "f".repeat(40) } : null }); }
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[1]?.includes("/reviews") || args[1]?.includes("/comments")) return "";
      if (args[1]?.includes("/branches/")) return args[1].includes("/rules/") ? "[]" : '["ci"]';
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    write: async (_args, _repo, beforeDispatch) => {
      if (kind === "head-changed" || kind === "review-changed") {
        const current = f.current();
        if (kind === "head-changed") current.lastPassedCommit = "f".repeat(40);
        else current.runs.find(run => run.stageId === "review")!.attempts.at(-1)!.reviewHeadSha = "f".repeat(40);
        savePipelines([current]);
      }
      beforeDispatch?.(); writes++; boundary = structuredClone(findPipelineRecord(f.id)!);
      if (kind === "closed-ack") state = "CLOSED";
      return "";
    },
    finishTask: () => "missing",
  };
  for (let n = 0; n < 10 && !writes; n++) { await sweepAutoMerge(ports); now += MERGE_SETTLE_MS + MERGE_POLL_MS; }
  if (kind === "head-changed" || kind === "review-changed") {
    expect(writes).toBe(0);
    expect(f.current().merge).toMatchObject({ state: "blocked", reason: expect.stringContaining("result-review evidence") });
    expect(f.current().merge?.effectUncertain).toBeUndefined();
    return;
  }
  expect(writes).toBe(1);
  expect(boundary?.merge).toMatchObject({ state: "merging", effectUncertain: true });
  if (kind === "closed-ack") {
    expect(f.current().merge).toMatchObject({ state: "blocked", nextReadAt: null });
    expect(f.current().merge?.effectUncertain).toBeUndefined();
    return;
  }
  expect(f.current().merge?.effectUncertain).toBe(true); // OPEN acknowledgement keeps custody.
  if (kind === "write-boundary") savePipelines([boundary!]);
  // Read the actual writer output in another interpreter, with cold module state.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "pipeline-record"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const decoded = JSON.parse(out.split("RESULT ")[1]!);
    expect(decoded.merge.effectUncertain).toBe(true);
    savePipelines([decoded]);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  if (kind.startsWith("closed")) {
    const result = await closeAndDrain(f.id, { action: "close" }, f.h.ports);
    expect(result.error).toBeUndefined(); expect(f.current().state).toBe("closed");
    const { archiveSettledPipelines } = await import("./store");
    expect(await archiveSettledPipelines(NOW + 30 * 86_400_000)).toBe(0);
    expect(f.current().merge?.effectUncertain).toBe(true);
    const held = await createPipelineFromRequest(f.request, f.h.ports, {
      creationRequest: { key: "held-before-merge-settles", digest: requestDigest("create_pipeline", f.request) },
    });
    expect(held.error).toContain("reserved");
  }
  if (kind === "hidden-merged") { const lane = f.current(); lane.hiddenAt = f.at; savePipelines([lane]); }
  const before = reads;
  now += MERGE_POLL_MS; await sweepAutoMerge(ports);
  expect(reads).toBeGreaterThan(before); expect(writes).toBe(1);
  expect(f.current().merge?.effectUncertain).toBe(true);
  const paced = reads; await sweepAutoMerge(ports); expect(reads).toBe(paced);
  state = kind === "closed-unmerged" ? "CLOSED" : "MERGED";
  now += MERGE_POLL_MS; await sweepAutoMerge(ports);
  expect(writes).toBe(1);
  expect(f.current().merge?.effectUncertain).toBeUndefined();
  expect(f.current().merge?.state).toBe(state === "MERGED" ? "merged" : "blocked");
  if (kind.startsWith("closed")) {
    const next = await createPipelineFromRequest(f.request, f.h.ports, {
      creationRequest: { key: "next-after-merge", digest: requestDigest("create_pipeline", f.request) },
    });
    expect(next.error).toBeUndefined(); expect(next.pipeline?.id).not.toBe(f.id);
  }
});

test.each(["review-before-build", "unreachable-review", "write-after-review"])("proactive success graph requires result review after implementation: %s", async kind => {
  const graph: { id: string; [key: string]: unknown }[] = structuredClone(stages).map(stage => ({ ...stage }));
  if (kind === "review-before-build") {
    graph[0]!.next = "review"; graph[2]!.next = "build"; graph[1]!.next = null;
  } else if (kind === "unreachable-review") graph[1]!.next = null;
  else {
    graph[2]!.next = "final-build";
    graph.push({ ...graph[1]!, id: "final-build", next: null });
  }
  await expect(fixture(`graph-${kind}`, false, "/repo", `graph-${kind}`, graph)).rejects.toThrow("result-review");
});

test("proactive success graph follows edges when stage array order differs", async () => {
  const f = await fixture("graph-edges", false, "/repo", "graph-edges", [stages[0], stages[2], stages[1]]);
  await f.complete();
  expect(f.current().state).toBe("completed");
  expect(mergeEligible(f.current())).toBe(true);
});

test.each(["different", "missing"])("proactive automatic merge requires evidence for its final head: %s", async kind => {
  const f = await fixture(`review-head-${kind}`);
  await f.complete();
  const lane = f.current();
  expect(mergeEligible(lane)).toBe(true);
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  review.reviewHeadSha = kind === "different" ? "f".repeat(40) : null;
  review.outputBaseHead = undefined;
  if (review.report) review.report.provenance.head = null;
  const admission = mergeAdmission(lane, NOW, { setting: () => ({ ...mergeOnReviewSetting(f.project), enabled: true, changedAt: f.at }),
    pullRequestOf: () => ({ repository: "acme/fixture", number: 17 }), hasPublishedPrototype: () => false });
  expect(admission).toEqual({ reason: "lane has not met the review merge bar" });
});

test.each(["assigned", "done"] as const)("retained live lane occupies worker capacity with card status %s", async status => {
  const f = await fixture(`card-capacity-${status}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested filter correction", placement: "unplaced" }, [],
      { id: () => `ordinary-${status}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const made = await createPipelineFromRequest({ task: ordinary.text, repoDir: "/repo", taskIds: [ordinary.id], publication: "internal",
    stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, prompt: "Apply the requested correction", next: null }] }, f.h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const ordinaryLane = made.pipeline;
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: ordinaryLane.worktreeDir, taskIds: [ordinary.id],
    conversationId: `conversation_ordinary_${status}`, role: "builder", origin: { kind: "container", container: "pipeline", containerId: ordinaryLane.id, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: ordinaryLane.id, role: "builder", slot: "work:1", stageId: "work", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: ordinaryLane.worktreeDir, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary worker required");
  const sessionId = ["30000000", "0000", "4000", "8000", status === "assigned" ? "000000000001" : "000000000002"].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  const entry = { key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: ordinaryLane.worktreeDir,
    accountId: null, status: "live" as const, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null };
  registry.completeSpawn(begun.receipt.launchId, entry);
  mutateTasks(tasks => {
    const result = patchTask(tasks, ordinary.id, { status }, f.at);
    if (!result.ok) throw new Error(result.error);
    result.task.assignments = [{ conversationId: begun.receipt.conversationId, launchId: begun.receipt.launchId,
      state: "linked", path: null, panePid: null, at: f.at, error: null }];
    return { tasks: result.tasks, result: undefined };
  });
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved, prepare) => {
    if (input.membership.containerId === f.id) {
      await reserved({ launchId: "held-proactive", conversationId: "conversation_held_proactive", accountId: "account-limited" });
    }
    return spawn(input, reserved, prepare);
  };
  await f.tick();
  expect(f.h.spawnInputs.filter(input => input.membership.containerId === f.id)).toHaveLength(0);
  expect(f.current().stateDetail).toContain("capacity is exhausted");
  const running = loadPipelines().find(lane => lane.id === ordinaryLane.id)!;
  expect(running.state).toBe("running");
  Object.assign(running.runs[0]!.attempts.at(-1)!, { conversationId: begun.receipt.conversationId,
    launchId: begun.receipt.launchId, agentPath: artifactPath, paneId: null });
  savePipelines(loadPipelines().map(lane => lane.id === running.id ? running : lane));
  f.h.setConversationActive(true);
  f.h.ports.stopStageAgent = async target => {
    expect(target.conversationId).toBe(begun.receipt.conversationId);
    registry.upsert({ ...entry, status: "dead" });
    return { outcome: "stopped" };
  };
  expect((await closeAndDrain(ordinaryLane.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  expect(loadPipelines().find(lane => lane.id === ordinaryLane.id)?.closeReport?.status).toBe("settled");
  expect(Object.values(registry.conversationRetentionSnapshot(begun.receipt.conversationId).entries)
    .some(row => row.status === "dead")).toBe(true);
  expect(() => assertProactivePipelineExecution(f.current(), "dispatch")).not.toThrow();
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
  await f.tick();
  expect(f.h.spawnInputs.filter(input => input.membership.containerId === f.id)).toHaveLength(1);
});

test.each(["skipped", "accepted", "budget-spent"])("proactive result review retains explicit merge exceptions: %s", async kind => {
  const f = await fixture(`review-exception-${kind}`);
  await f.complete();
  const lane = f.current();
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  review.state = kind === "skipped" ? "skipped" : "failed";
  if (kind === "accepted") lane.reviewAcceptances = [{ clientRequestId: "accepted-review", expectedRevision: "current",
    stageId: "review", attempt: review.n, fixStageId: "build", fixAttempt: 1, reviewedHead: review.reviewHeadSha ?? null,
    currentHead: lane.lastPassedCommit!, at: f.at, actor: { kind: "operator" } }];
  if (kind === "budget-spent") {
    review.budgetSpent = true;
    lane.runs.find(run => run.stageId === "build")!.attempts.at(-1)!.activatedBy = {
      stageId: "review", attempt: review.n, edge: "fail", budgetSpent: true,
    };
  }
  expect(mergeEligible(lane)).toBe(kind !== "budget-spent");
  if (kind === "accepted") {
    lane.reviewAcceptances![0]!.currentHead = "f".repeat(40);
    expect(mergeEligible(lane)).toBe(false);
    lane.reviewAcceptances![0]!.currentHead = lane.lastPassedCommit!;
  }
  const summary = { ...lane.stages[0]!, id: "summary", next: null, onFail: null };
  lane.stages.find(stage => stage.id === "review")!.next = summary.id;
  lane.stages.push(summary);
  expect(mergeEligible(lane)).toBe(true);
  summary.effectiveRole = { ...lane.stages.find(stage => stage.id === "build")!.effectiveRole };
  expect(mergeEligible(lane)).toBe(false);
});

test("proactive review evidence follows only the recorded publication integration", async () => {
  const f = await fixture("review-integration");
  await f.complete();
  const lane = f.current();
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  const passedSha = lane.lastPassedCommit!;
  lane.lastPassedCommit = "f".repeat(40);
  expect(mergeEligible(lane)).toBe(false);
  review.publicationIntegration = { passedSha, acceptedSha: lane.lastPassedCommit, mainSha: "e".repeat(40) };
  expect(mergeEligible(lane)).toBe(true);
  review.publicationIntegration.passedSha = "d".repeat(40);
  expect(mergeEligible(lane)).toBe(false);
});

test("a writable stage named review cannot authorize a proactive merge", async () => {
  const f = await fixture("writable-review");
  await f.complete();
  const lane = f.current();
  lane.runs.find(run => run.stageId === "review")!.attempts = [];
  const builder = lane.stages.find(stage => stage.id === "build")!;
  lane.stages.push({ ...builder, id: "fix-review", next: null, onFail: { to: "build", maxRounds: 1 } });
  const buildRun = structuredClone(lane.runs.find(run => run.stageId === "build")!);
  buildRun.stageId = "fix-review";
  lane.runs.push(buildRun);
  expect(mergeEligible(lane)).toBe(false);
});

test("review probe: invalid task link cannot strand the project reservation", async () => {
  const f = await fixture("invalid-link-probe");
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  const other = mutateTasks(tasks => {
    const made = createTask(tasks, { project: "other-project", text: "Other requested outcome", placement: "unplaced" }, [],
      { id: () => "cross-project-task", now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const invalid = { ...f.request, taskIds: [f.task.id, other.id] };
  const refused = await createPipelineFromRequest(invalid, f.h.ports, {
    creationRequest: { key: "invalid-link-probe", digest: requestDigest("create_pipeline", invalid) },
  });
  expect(refused.pipeline).toBeUndefined();
  expect(refused.status).toBe(400);
  expect(refused.error).toContain("task project does not match");
  const valid = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "valid-after-invalid-probe", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(valid.error).toBeUndefined();
});

test("review probe: companion scope cannot enter an unadopted proactive lane", async () => {
  const f = await fixture("linked-edit-probe");
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  const other = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested companion scope", placement: "unplaced" }, [],
      { id: () => "linked-companion-task", now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    const patched = patchTask(made.tasks, made.task.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: patched.task };
  });
  const request = { ...f.request, taskIds: [f.task.id, other.id] };
  const made = await createPipelineFromRequest(request, f.h.ports, {
    creationRequest: { key: "linked-edit-probe", digest: requestDigest("create_pipeline", request) },
  });
  expect(made.error).toContain("exactly one linked task");
  expect(made.pipeline).toBeUndefined();
  // Refusing a companion must not consume the candidate's next scope review.
  const corrected = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "without-companion", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(corrected.error).toBeUndefined();
  await f.tick(); await f.pass();
  expect(f.h.spawnInputs.map(input => input.role.roleId)).toEqual(["reviewer", "builder"]);
  const lane = loadPipelines().find(row => row.id === corrected.pipeline!.id)!;
  // Existing records and edits that add a companion also lose authority at effects.
  lane.taskIds.push(other.id);
  // Recreate an older multi-task grant from the real reservation writer's output.
  // Its graph already includes the companion, so graph drift alone cannot fence it.
  type ScopeRow = { key: string; graph: string; laneId: string };
  const reservations = new SqliteStateCollection<ScopeRow>(legacyDatabasePath(TASKS_FILE), {
    collection: "proactive_execution", schemaVersion: 1, key: row => row.key,
    decode: value => value as ScopeRow, clone: structuredClone, busyMessage: "fixture scope receipt is busy",
  });
  try {
    const saved = reservations.snapshot().find(row => row.laneId === lane.id)!;
    reservations.boundedPatch(1, tx => tx.put({ ...saved, graph: proactiveGraphDigest(lane) }));
  } finally { reservations.close(); }
  savePipelines(loadPipelines().map(row => row.id === lane.id ? lane : row));
  expect(() => assertProactivePipelineExecution(lane, "effect")).toThrow("linked task scope changed");
  mutateTasks(tasks => {
    const patched = patchTask(tasks, other.id, { text: "A materially different companion scope" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  expect(() => assertProactivePipelineExecution(lane, "dispatch")).toThrow("linked task scope changed");
  await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(loadTasksByIds(new Set([f.task.id]))[0]!));
  expect(() => assertProactivePipelineExecution(lane, "dispatch")).not.toThrow();
});
