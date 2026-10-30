import { afterAll, afterEach, spyOn } from "bun:test";
import path from "node:path";
import { expect, test, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, closeAndDrain } from "./engine.fixture";
import { decideProactiveTask, proactiveDecisionToken } from "@/lib/tasks/proactive";
import { NOW } from "@/lib/tasks/proactive.fixture";
import { readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { proactiveObservation } from "@/lib/accounts/proactiveReserve.fixture";
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
test.each(["parent", "child", "expiry", "reject", "continue", "adopt"])("native pending discretionary turns retain guarded custody: %s", async kind => {
  const f = await fixture(`native-pending-${kind}`);
  await f.tick(); await f.pass();
  const { migrationDeliveryFixture } = await import("@/test-helpers/migrationDelivery");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
  const { NativeCodexQueue } = await import("@/lib/runtime/nativeCodexQueue");
  const delivery = migrationDeliveryFixture();
  const registry = delivery.registry;
  const lane = f.current();
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: delivery.root, transport: "structured", conversationId: delivery.conversation.id,
    origin: { kind: "container", container: "pipeline", containerId: f.id, creatorConversationId: null },
    clientAttemptId: `pending-${kind}`, taskIds: [f.task.id],
    memberships: [{ kind: "pipeline", containerId: f.id, role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: delivery.root, model: "gpt-5.6-sol", title: "Continue the reviewed filter improvement" }) });
  if (begun.kind !== "created") throw new Error("fresh native receipt required");
  lane.runs[1]!.attempts.at(-1)!.conversationId = delivery.conversation.id;
  savePipelines([lane]);
  agentRegistry().recordQuotaObservation(proactiveObservation("account-a"));
  let active = true, adds = 0, starts = 0;
  const host = delivery.host;
  const health = host.health.bind(host);
  host.health = async () => ({ ...await health(), status: active ? "active" : "idle", activeTurnRef: active ? "current-turn" : null, activeFlags: ["native-queue"] });
  const input = [{ type: "text" as const, text: "Preserve this pending payload" }];
  const binding = { threadId: delivery.key.sessionId, accountId: "account-a" };
  Object.assign(host, { nativeQueue: {
    queue: new NativeCodexQueue({ rpc: async (method, params) => {
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method === "thread/queue/add") { adds++; return { queuedSubmission: { id: "pending-native", clientUserMessageId: params.clientUserMessageId, input } }; }
      throw new Error(`unexpected native call ${method}`);
    } }, binding.threadId),
    prepare: async () => input, evidence: async () => null,
    sendWithdrawn: async () => { if (active) throw new Error("fixture turn still active"); starts++; return { turnId: "guarded-turn" }; },
  } });
  delivery.client.nativeQueueRead = async id => delivery.journal.nativeQueueRead(id);
  delivery.client.nativeQueueTransition = async (id, change) => delivery.journal.nativeQueueTransition(id, change);
  const bind = () => bindStructuredDeliveryQueue([{ key: delivery.key, host }], { registry, client: delivery.client,
    hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
  try {
    if (kind === "adopt") await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(f.task));
    await bind();
    expect(delivery.journal.executeOperation({ kind: "native-queue", action: "add", binding, operationId: "pending-guarded", idempotencyKey: "pending-guarded",
      conversationId: delivery.conversation.id, text: input[0].text }).receipt.status).toBe("queued");
    await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(0);
    const settings = readSeatTickSettings(f.project);
    if (kind === "parent") settings.autonomy!.enabled = false;
    if (kind === "child") settings.autonomy!.proactive!.enabled = false;
    if (kind === "expiry") settings.autonomy!.until = new Date(NOW - 1).toISOString();
    writeSeatTickSettings(f.project, settings);
    if (kind === "reject") await decideProactiveTask(f.task.id, "reject", "operator", proactiveDecisionToken(f.task));
    // A replacement controller must recover the original durable operation.
    await bindStructuredDeliveryQueue([], { client: null }); active = false;
    await bind(); await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(kind === "continue" ? 1 : 0);
    const entry = delivery.journal.nativeQueueRead(delivery.conversation.id)[0]!;
    expect(entry.versions[0]!.text).toBe(input[0].text);
    expect(entry.state).toBe(kind === "continue" ? "dispatching" : kind === "adopt" ? "queued" : "refused");
  } finally { await delivery.cleanup(); }
});

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

const pausedWorkerStates = ["deferred", "unconfirmed", "failed", "unresolved", "throws", "starting", "exiting", "survivor", "claimed", "pending", "dead", "unhosted"] as const;
test.each([
  ...pausedWorkerStates.map(kind => ["pause", kind] as const),
  ["close", "unconfirmed"], ["close", "dead"], ["close", "unhosted"],
] as const)("%s lane worker capacity follows retained custody: %s", async (action, kind) => {
  const f = await fixture(`${action}-worker-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested correction", placement: "unplaced" }, [],
      { id: () => `${action}-ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const made = await createPipelineFromRequest({ task: ordinary.text, repoDir: "/repo", taskIds: [ordinary.id], publication: "internal",
    stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, prompt: "Apply the correction", next: null }] }, f.h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const ordinaryId = made.pipeline.id;
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: made.pipeline.worktreeDir, taskIds: [ordinary.id],
    conversationId: `conversation_${action}_worker_${kind}`, role: "builder",
    origin: { kind: "container", container: "pipeline", containerId: ordinaryId, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: ordinaryId, role: "builder", slot: "work:1", stageId: "work", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: made.pipeline.worktreeDir, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary worker required");
  const workerIndex = pausedWorkerStates.indexOf(kind) + 1 + (action === "close" ? pausedWorkerStates.length : 0);
  const sessionId = ["20000000", "0000", "4000", "8000", workerIndex.toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  const entry = { key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: made.pipeline.worktreeDir,
    accountId: null, status: "dead" as const, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null };
  const settled = kind === "dead" || kind === "unhosted";
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    ...entry, status: kind === "unhosted" ? "unhosted" : settled || ["exiting", "survivor", "claimed", "pending"].includes(kind) ? "dead" : "live",
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  await f.tick();
  const spawns = () => f.h.spawnInputs.filter(input => input.membership.containerId === f.id);
  expect(spawns()).toHaveLength(0);
  expect(f.current().stateDetail).toContain("capacity is exhausted");
  const ordinaryLane = loadPipelines().find(lane => lane.id === ordinaryId)!;
  const attempt = ordinaryLane.runs[0]!.attempts.at(-1)!;
  expect(attempt.state).toBe("running");
  attempt.conversationId = begun.receipt.conversationId;
  attempt.launchId = begun.receipt.launchId;
  attempt.agentPath = artifactPath;
  attempt.paneId = null;
  savePipelines(loadPipelines().map(lane => lane.id === ordinaryId ? ordinaryLane : lane));
  f.h.setConversationActive(true);
  f.h.ports.stopStageAgent = async () => {
    if (kind === "throws") throw new Error("stop confirmation unavailable");
    if (kind === "failed") return { outcome: "failed", error: "stop confirmation unavailable" };
    if (kind === "unconfirmed") return { outcome: "unconfirmed", operationId: null, detail: "stop confirmation unavailable" };
    if (kind === "unresolved") return { outcome: "unresolved", error: "host still alive", survivors: [captureProcessIdentity(process.pid)] };
    return { outcome: settled ? "stopped" : "deferred" };
  };
  const stop = () => action === "close"
    ? closeAndDrain(ordinaryId, { action: "close" }, f.h.ports)
    : patchPipeline(ordinaryId, { action: "pause", reason: "Hold requested work" }, f.h.ports);
  expect((await stop()).error).toBeUndefined();
  const stopped = loadPipelines().find(lane => lane.id === ordinaryId)!;
  if (action === "close") {
    expect(stopped.closedAt).toBeTruthy();
    expect(stopped.closeReport!.unconfirmed).toHaveLength(settled ? 0 : 1);
    if (!settled) expect(Object.values(registry.conversationRetentionSnapshot(begun.receipt.conversationId).entries)
      .some(row => row.status === "live")).toBe(true);
  } else {
    expect(stopped.state).toBe("paused");
    expect(!!stopped.runs[0]!.attempts.at(-1)!.suspension?.stoppedAt).toBe(settled);
  }
  const check = () => assertProactivePipelineExecution(f.current(), "dispatch");
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
  await f.tick();
  expect(spawns()).toHaveLength(settled ? 1 : 0);
  if (settled) expect(check).not.toThrow();
  else expect(check).toThrow("worker capacity is exhausted");
  // A fresh process must observe the same retained capacity after pause or close.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const result = JSON.parse(out.split("RESULT ")[1]!);
    if (settled) expect(result).toEqual({ error: null });
    else expect(result.error).toContain("worker capacity is exhausted");
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  if (!settled) {
    if (["deferred", "unconfirmed", "failed", "throws", "starting", "claimed", "pending"].includes(kind)) {
      if (kind === "starting") registry.completeSpawn(begun.receipt.launchId, entry);
      else registry.upsert(entry);
      f.h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
      expect((await stop()).error).toBeUndefined();
      expect(() => assertProactivePipelineExecution(f.current(), "dispatch")).not.toThrow();
      expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await f.tick();
      expect(spawns()).toHaveLength(1);
    }
  }
});

const standaloneStates = ["dead", "unhosted", "live", "claimed", "pending", "starting", "exiting", "survivor"] as const;
test.each([...standaloneStates])("review probe: standalone worker capacity follows retained custody: %s", async kind => {
  const f = await fixture(`standalone-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Completed requested work", placement: "unplaced" }, [],
      { id: () => `ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/repo", taskIds: [ordinary.id],
    conversationId: `conversation_standalone_${kind}`, origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary conversation required");
  const sessionId = ["10000000", "0000", "4000", "8000", (standaloneStates.indexOf(kind) + 1).toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: "/repo", accountId: null,
    status: kind === "unhosted" ? "unhosted" : kind === "live" ? "live" : "dead", host: null, claimEpoch: 0,
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  expect(loadTasksByIds(new Set([ordinary.id]))[0]!.assignments.some(row => row.state === "linked")).toBe(true);
  expect(registry.conversationMemberships(begun.receipt.conversationId).filter(member => member.kind === "pipeline")).toEqual([]);
  const error = () => { try { assertProactivePipelineExecution(f.current(), "dispatch"); return null; } catch (error) { return String(error); } };
  const settled = kind === "dead" || kind === "unhosted";
  if (settled) expect(error()).toBeNull();
  else expect(error()).toContain("worker capacity is exhausted");
  // Capacity is recomputed from the durable registry after a real process restart.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const result = JSON.parse(out.split("RESULT ")[1]!);
    if (settled) expect(result).toEqual({ error: null });
    else expect(result.error).toContain("worker capacity is exhausted");
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});
