import { expect, test, reserveActivationOnly, loadPipelines, savePipelines, patchPipeline, tickPipelines, engineModule, AgentRegistry, setAgentRegistryForTests, path, recoveryReport, registerPipelineTick } from "./engine.fixture";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { reportLaneFrom } from "@/lib/orchestrator/boardReportRun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { viewerMcpBindings, type ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { harness, create, BUILD_ONLY, fs, finishReported, durableStageTurnEvidence, stageDigest } from "./engine.fixture";
import { buildManifest, descriptorDigest, digest, physical, identitySchema } from "@/lib/recordedChecks/wire";
import { RecordedCheckStore, rowSchema } from "@/lib/recordedChecks/store";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { buildPipeline } from "./store";

const retryLane = () => loadPipelines()[0]!;
const retryAttempt = () => retryLane().runs[0]!.attempts.at(-1)!;

async function retainedRetryCheck() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "completed-retry-check-"));
  fs.writeFileSync(path.join(root, "source.ts"), "export const check = true;\n");
  const manifest = await buildManifest({ cwd: root, deadline: 1_900_000_000_000, executionMs: 1000,
    executionEnvironment: {}, selection: ["retained-check"], configurationDigest: digest("retained-check"),
    roots: [{ directory: root, purpose: "evidence" }], inputs: [{ root, file: "source.ts" }],
    outputs: [{ root, file: "output.log" }], completion: { root, file: "complete.json" } });
  const owner = identitySchema.parse(captureProcessIdentity(process.pid));
  const body = { version: 1 as const, runId: digest(["retained-retry-check", retryLane().id]), manifest, argv: ["fixture"], recorder: owner,
    directoryIdentity: physical(root), startedAt: 1_790_000_000_000, startedUptimeMs: 1, deadlineUptimeMs: manifest.deadlineUptimeMs };
  const row = rowSchema.parse({ id: body.runId, request: digest(["retained-retry-request", retryLane().id]), binding: {
    project: retryLane().project, pipeline: retryLane().id, stage: "build", attempt: 1, launch: retryAttempt().launchId,
    conversation: retryAttempt().conversationId, session: retryAttempt().sessionId, runtimeFence: "fixture-fence", endpoint: "fixture", host: owner,
  }, log: path.join(root, "check.log"), descriptor: { ...body, wrapper: owner, descriptorDigest: descriptorDigest(body) },
    revision: 1, admission: "refused", reason: "retained admission refusal", notification: null, acknowledgement: null,
    result: { state: "terminal", reason: "command never started", complete: false, visited: 0, completed: 0, failed: 0,
      evidence: [], evidenceDigest: digest([]), evidenceCount: 0, revision: 1, digest: digest("retained-result"), history: [],
      terminal: { version: 1, runId: body.runId, descriptorDigest: descriptorDigest(body), wrapperExit: 69,
        wrapperSignal: null, cancellation: null, closedAt: 1_790_000_001_000, closedUptimeMs: 2, report: null, dispatch: "not-started" } } });
  const store = new RecordedCheckStore();
  try { await store.write(row, null); return store.get(row.id)!; }
  finally { store.close(); }
}

/** Real creation, report, native transcript, MCP action and controller;
 * runtime control and dispatch are local seams; productionIdentity retains
 * the real staged registry and default receipt and identity ports. */
async function completedFailureRetry(receiptState: "path-pending" | "completed" = "path-pending", publication: "internal" | "remote-branch" = "internal", recordedReport = true, productionIdentity = false) {
  const h = harness();
  const nativePath = (n: string | number) => path.join(process.env.LLV_STATE_DIR!, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.jsonl`);
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const result = await spawn(input, reserved);
    const transcript = nativePath(h.spawnInputs.length);
    fs.writeFileSync(transcript, JSON.stringify({ type: "event_msg", timestamp: h.ports.now(), payload: { type: "task_started" } }) + "\n");
    return { ...result, paneId: null, transcript };
  };
  h.ports.pathForConversation = id => {
    const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
    return n ? nativePath(n) : null;
  };
  h.ports.conversationIdForPath = file => file === "/codex/creator.jsonl" ? "conversation_creator"
    : `conversation_stage_${Number(/(\d{12})\.jsonl$/.exec(file)?.[1])}`;
  h.ports.sourcePathAllowed = file => file.startsWith(process.env.LLV_STATE_DIR!) || file === "/codex/creator.jsonl";
  h.ports.conversationDeliveryOutstanding = () => false;
  h.ports.conversationTurnInterrupted = async () => null;
  h.ports.stopSettledStageWriter = async () => ({ outcome: "not-running" });
  await create(h.ports, BUILD_ONLY as never, { repoDir: process.env.LLV_STATE_DIR!, publication });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pathname = retryAttempt().agentPath!;
  const conversationId = retryAttempt().conversationId!;
  if (recordedReport) {
    const reported = await engineModule.reportStageCompletion({ verdict: "fail", summary: "Build check failed",
      findings: [{ severity: "P1", text: "Build check failed" }] }, { kind: "agent", conversationId, role: "builder" }, h.ports);
    expect(reported.error).toBeUndefined();
  }
  const finished = finishReported(h, pathname, "fail", "Build check failed");
  const text = h.messages.get(pathname)!.text;
  const timestamp = new Date(h.messages.get(pathname)!.ts).toISOString();
  fs.appendFileSync(pathname, [
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } },
    { type: "event_msg", timestamp, payload: { type: "task_complete", last_agent_message: text } },
  ].map(record => JSON.stringify(record) + "\n").join(""));
  h.ports.durableTurnEvidence = durableStageTurnEvidence;
  await tickPipelines([finished], h.ports);
  expect(retryAttempt()).toMatchObject({ n: 1, state: "failed", verdict: { status: "fail" } });
  if (recordedReport) expect(retryAttempt().report).toMatchObject({ verdict: { status: "fail" } });
  else expect(retryAttempt().report).toBeFalsy();
  const receipt = { state: receiptState, launchId: "launch-1", conversationId, sessionId: null, transcript: null, paneId: null,
    retryIdentity: { engine: retryAttempt().effectiveRole.engine, sessionId: retryAttempt().sessionId!, artifactPath: pathname } };
  h.ports.spawnReceipt = id => id === receipt.launchId ? receipt as never : null;
  h.ports.spawnReceiptState = id => h.ports.spawnReceipt(id)?.state ?? null;
  h.ports.claimSpawnRetry = () => { throw new Error("completed execution must retain its original launch receipt"); };
  h.ports.failStageLaunch = () => { throw new Error("completed execution must not become a never-started launch"); };
  let registry: InstanceType<typeof AgentRegistry> | null = null;
  if (productionIdentity) {
    registry = new AgentRegistry(path.join(fs.mkdtempSync(path.join(process.env.TMPDIR!, "retry-registry-")), "registry.json"));
    setAgentRegistryForTests(registry);
    const lane = retryLane();
    const profile = emptyLaunchProfile({ cwd: lane.worktreeDir!, title: "Completed stage fixture" });
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: lane.worktreeDir!, transport: "structured",
      launchProfile: profile, conversationId: conversationId as `conversation_${string}`, expectedArtifactPath: pathname });
    if (begun.kind !== "created") throw new Error("expected a fresh registry receipt");
    const entry = { key: { engine: "codex" as const, sessionId: path.basename(pathname, ".jsonl") }, artifactPath: pathname,
      cwd: lane.worktreeDir!, accountId: null, launchProfile: profile, status: "dead" as const, host: null,
      claimEpoch: 1, claimOwner: null, pendingAction: null };
    expect(registry.stageStructuredSpawn(begun.receipt.launchId, entry).kind).toBe("settled");
    if (receiptState === "completed") registry.completeSpawn(begun.receipt.launchId, entry);
    Object.assign(lane.runs[0]!.attempts[0]!, { launchId: begun.receipt.launchId, sessionId: entry.key.sessionId });
    savePipelines([lane]);
    const actual = engineModule.defaultPipelinePorts();
    h.ports.spawnReceipt = actual.spawnReceipt;
    h.ports.spawnReceiptState = actual.spawnReceiptState;
    h.ports.pathForConversation = actual.pathForConversation;
    h.ports.conversationIdForPath = actual.conversationIdForPath;
    expect(actual.pathForConversation(conversationId)).toBe(receiptState === "path-pending" ? null : pathname);
    expect(actual.conversationIdForPath(pathname)).toBe(receiptState === "path-pending" ? null : conversationId);
  }
  const dependencies = {
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
    readPipelineRecord: engineModule.getPipeline,
    patchPipeline: (id, request, _ports, ...authority) => engineModule.patchPipeline(id, request, h.ports, ...authority),
  } satisfies Partial<ViewerMcpDomainDependencies>;
  const bindings = viewerMcpBindings(undefined, undefined, dependencies as ViewerMcpDomainDependencies);
  const receipts = new MemoryMcpReceiptStore();
  const server = createViewerMcpServer(createMcpToolService(bindings, receipts));
  const client = new Client({ name: "completed-stage-retry-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "pipeline_action", arguments: { pipelineId: retryLane().id,
      clientRequestId: `completed-retry-${++sequence}`, ...args } });
    return { isError: result.isError === true, answer: result.structuredContent as Record<string, unknown>, raw: JSON.stringify(result) };
  };
  const override = await call({ action: "override-stage", stageId: "build", prompt: "Run the corrected build check",
    expectedStageDigest: stageDigest(retryLane().stages[0]!) });
  expect(override.isError, override.raw).toBe(false);
  expect(override.answer.graphEdit).toMatchObject({ appliesFromAttempt: 2 });
  return { h, call, receipt, registry, old: structuredClone(retryAttempt()), transcript: fs.readFileSync(pathname, "utf8"),
    close: async () => { await client.close(); await server.close(); registry?.close(); setAgentRegistryForTests(null); } };
}

test.each([
  { state: "path-pending", recordedReport: true },
  { state: "completed", recordedReport: true },
  { state: "path-pending", recordedReport: false },
] as const)("completed fail retries through MCP after override with $state receipt, recorded report $recordedReport (#2034)", async ({ state, recordedReport }) => {
  const f = await completedFailureRetry(state, "internal", recordedReport, true);
  try {
    const registryReceipt = f.registry!.spawnReceipt(f.old.launchId!);
    const registryConversation = f.registry!.conversation(f.old.conversationId as `conversation_${string}`);
    const check = await retainedRetryCheck();
    const lane = retryLane();
    const request = { action: "retry-stage", stageId: "build", clientRequestId: "completed-fail-retry" };
    const retried = await f.call(request);
    expect(retried.isError, retried.raw).toBe(false);
    expect((await f.call(request)).answer.replayed).toBe(true);
    for (let i = 0; i < 3; i++) await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(retryLane()).toMatchObject({ id: lane.id, branch: lane.branch, worktreeDir: lane.worktreeDir });
    expect(retryLane().stageReports).toEqual(lane.stageReports);
    expect(retryLane().srcConversationId).toBe(lane.srcConversationId);
    expect(retryLane().runs[0]!.attempts).toHaveLength(2);
    expect(retryLane().runs[0]!.attempts[0]).toEqual(f.old);
    expect(retryAttempt()).toMatchObject({ n: 2, state: "running", definition: { prompt: "Run the corrected build check" } });
    expect(f.h.spawnInputs[1]!.prompt).toContain("Run the corrected build check");
    expect(fs.readFileSync(f.old.agentPath!, "utf8")).toBe(f.transcript);
    expect(f.registry!.spawnReceipt(f.old.launchId!)).toEqual(registryReceipt);
    expect(f.registry!.conversation(f.old.conversationId as `conversation_${string}`)).toEqual(registryConversation);
    const checkStore = new RecordedCheckStore();
    try { expect(checkStore.get(check.id)).toEqual(check); }
    finally { checkStore.close(); }
    expect(f.h.spawnInputs[1]!.supersedes).toBe(f.old.conversationId!);
    expect(f.h.spawnInputs[1]!.membership).toMatchObject({ containerId: lane.id, stageId: "build", round: 2 });
    expect((await f.call(request)).answer.replayed).toBe(true);
    expect((await f.call({ action: "retry-stage", stageId: "build" })).isError).toBe(true);
    const stale = await f.call({ action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 });
    expect(stale.raw).toContain("STAGE_CHANGED");
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { await f.close(); }
});

test.each(["live host", "unconfirmed stop", "unknown delivery", "busy transcript", "missing transcript", "missing verdict",
  "identity mismatch", "starting receipt", "missing receipt"] as const)
("completed failure retry keeps execution fenced for %s (#2034)", async counterexample => {
  const f = await completedFailureRetry("path-pending", "internal", true, true);
  let stops = 0;
  f.h.ports.stopSettledStageWriter = async () => {
    stops++;
    return counterexample === "live host" ? { outcome: "deferred" }
      : counterexample === "unconfirmed stop" ? { outcome: "unconfirmed", operationId: "retry-stop", detail: "Host has not stopped" }
      : { outcome: "not-running" };
  };
  if (counterexample === "unknown delivery") f.h.ports.conversationDeliveryOutstanding = () => true;
  if (counterexample === "busy transcript") fs.appendFileSync(f.old.agentPath!, JSON.stringify({ type: "event_msg",
    timestamp: f.h.ports.now(), payload: { type: "task_started" } }) + "\n");
  if (counterexample === "missing transcript") fs.unlinkSync(f.old.agentPath!);
  if (counterexample === "missing verdict") {
    const lane = retryLane();
    lane.runs[0]!.attempts[0]!.verdict = null;
    savePipelines([lane]);
  }
  if (counterexample === "identity mismatch") {
    const lane = retryLane();
    lane.runs[0]!.attempts[0]!.sessionId = "foreign-session";
    savePipelines([lane]);
  }
  if (counterexample === "starting receipt") {
    const entry = f.registry!.readOnlySnapshot().entries[`codex:${f.old.sessionId}`]!;
    const begun = f.registry!.beginSpawnRequest({ engine: "codex", cwd: entry.cwd, transport: "structured",
      launchProfile: entry.launchProfile!, conversationId: f.old.conversationId as `conversation_${string}` });
    if (begun.kind !== "created") throw new Error("expected an uncertain receipt");
    const lane = retryLane();
    lane.runs[0]!.attempts[0]!.launchId = begun.receipt.launchId;
    savePipelines([lane]);
  }
  if (counterexample === "missing receipt") f.h.ports.spawnReceipt = () => null;
  const before = structuredClone(retryAttempt());
  const receipt = f.registry!.spawnReceipt(before.launchId!);
  try {
    const request = { action: "retry-stage", stageId: "build", clientRequestId: "refused-completed-retry" };
    const refused = await f.call(request);
    expect(refused.isError, refused.raw).toBe(true);
    expect((await f.call(request)).answer.replayed).toBe(true);
    expect(retryLane().state).toBe("needs_decision");
    expect(retryLane().runs[0]!.attempts).toHaveLength(1);
    expect(retryAttempt()).toEqual(before);
    expect(f.registry!.spawnReceipt(before.launchId!)).toEqual(receipt);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(stops).toBe(counterexample === "live host" || counterexample === "unconfirmed stop" ? 1 : 0);
  } finally { await f.close(); }
});

test("completed retry retains unresolved stop custody across a fresh request (#2034)", async () => {
  const f = await completedFailureRetry();
  const survivor = identitySchema.parse(captureProcessIdentity(process.pid));
  let stops = 0;
  f.h.ports.stopSettledStageWriter = async () => {
    stops++;
    return { outcome: "unresolved", error: "owned writer still running", survivors: [survivor] };
  };
  try {
    const first = await f.call({ action: "retry-stage", stageId: "build" });
    expect(first.isError, first.raw).toBe(true);
    expect(retryAttempt()).toMatchObject({ state: "failed", verdict: f.old.verdict, report: f.old.report,
      unresolvedTermination: { survivors: [survivor], error: "owned writer still running" } });
    const held = structuredClone(retryAttempt().unresolvedTermination);
    const fresh = await f.call({ action: "retry-stage", stageId: "build" });
    expect(fresh.isError, fresh.raw).toBe(true);
    expect(retryAttempt().unresolvedTermination).toEqual(held);
    expect(stops).toBe(1);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(f.receipt.state).toBe("path-pending");
  } finally { await f.close(); }
});

test.each(["transcript read", "host stop", "shutdown read"] as const)("completed retry rechecks ownership and native completion after %s (#2034)", async boundary => {
  for (const change of ["conversation", "delivery", "transcript"] as const) {
    const f = await completedFailureRetry();
    const before = structuredClone(retryAttempt());
    const withdraw = () => {
      if (change === "conversation") f.receipt.conversationId = "conversation_replaced";
      if (change === "delivery") f.h.ports.conversationDeliveryOutstanding = () => true;
      if (change === "transcript") fs.appendFileSync(f.old.agentPath!, JSON.stringify({ type: "event_msg",
        timestamp: f.h.ports.now(), payload: { type: "task_started" } }) + "\n");
    };
    if (boundary === "transcript read") {
      f.h.ports.durableTurnEvidence = async (...args) => { const evidence = await durableStageTurnEvidence(...args); withdraw(); return evidence; };
    } else if (boundary === "host stop") f.h.ports.stopSettledStageWriter = async () => { withdraw(); return { outcome: "stopped" }; };
    else {
      let reads = 0;
      f.h.ports.stopSettledStageWriter = async () => {
        fs.appendFileSync(f.old.agentPath!, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
          payload: { type: "token_count", info: null } }) + "\n");
        return { outcome: "stopped" };
      };
      f.h.ports.durableTurnEvidence = async (...args) => {
        const evidence = await durableStageTurnEvidence(...args);
        if (++reads === 2) withdraw();
        return evidence;
      };
    }
    try {
      const refused = await f.call({ action: "retry-stage", stageId: "build" });
      expect(refused.isError, refused.raw).toBe(true);
      expect(retryAttempt()).toEqual(before);
      expect(retryLane().state).toBe("needs_decision");
      expect(f.h.spawnInputs).toHaveLength(1);
    } finally { await f.close(); }
  }
});

test.each(["before read", "transcript read", "host stop", "shutdown read"] as const)
("completed retry rechecks production identity at %s (#2034)", async boundary => {
  for (const change of ["entry path", "entry launch", "generation"] as const) {
    const f = await completedFailureRetry("path-pending", "internal", true, true);
    const before = structuredClone(retryAttempt());
    const receipt = f.registry!.spawnReceipt(before.launchId!);
    const withdraw = () => {
      const entry = f.registry!.readOnlySnapshot().entries[`codex:${f.old.sessionId}`]!;
      if (change === "entry path") f.registry!.upsert({ ...entry, artifactPath: `${entry.artifactPath}.other` });
      if (change === "entry launch") f.registry!.upsert({ ...entry, structuredHostOperationId: "foreign-launch" });
      if (change === "generation") {
        const begun = f.registry!.beginSpawnRequest({ engine: "codex", cwd: entry.cwd, transport: "structured",
          launchProfile: entry.launchProfile!, conversationId: f.old.conversationId as `conversation_${string}`,
          expectedArtifactPath: `${entry.artifactPath}.successor` });
        if (begun.kind !== "created") throw new Error("expected a successor reservation");
        f.registry!.stageStructuredSpawn(begun.receipt.launchId, { ...entry,
          key: { engine: "codex", sessionId: "successor-session" }, artifactPath: `${entry.artifactPath}.successor` });
      }
    };
    if (boundary === "before read") withdraw();
    else if (boundary === "transcript read") f.h.ports.durableTurnEvidence = async (...args) => {
      const evidence = await durableStageTurnEvidence(...args); withdraw(); return evidence;
    };
    else if (boundary === "host stop") f.h.ports.stopSettledStageWriter = async () => { withdraw(); return { outcome: "stopped" }; };
    else {
      let reads = 0;
      f.h.ports.stopSettledStageWriter = async () => {
        fs.appendFileSync(f.old.agentPath!, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
          payload: { type: "token_count", info: null } }) + "\n");
        return { outcome: "stopped" };
      };
      f.h.ports.durableTurnEvidence = async (...args) => {
        const evidence = await durableStageTurnEvidence(...args);
        if (++reads === 2) withdraw();
        return evidence;
      };
    }
    try {
      const refused = await f.call({ action: "retry-stage", stageId: "build" });
      expect(refused.isError, `${change}: ${refused.raw}`).toBe(true);
      expect(retryAttempt()).toEqual(before);
      expect(f.registry!.spawnReceipt(before.launchId!)).toEqual(receipt);
      expect(f.h.spawnInputs).toHaveLength(1);
    } finally { await f.close(); }
  }
});

test("completed retry refuses a stale delivery epoch owned by another lane (#2034)", async () => {
  const f = await completedFailureRetry("path-pending", "remote-branch", true, true);
  const old = structuredClone(retryAttempt());
  const lane = retryLane();
  expect(lane.delivery).toBeTruthy();
  const replacement = buildPipeline({ id: "replacement-owner", task: "Own the delivery target", repoDir: lane.repoDir,
    project: lane.project, stages: lane.stages, srcPath: null, srcConversationId: null, now: f.h.ports.now() });
  replacement.delivery = { ...structuredClone(lane.delivery!), ownerId: replacement.id, epoch: lane.delivery!.epoch + 1 };
  lane.delivery!.active = false;
  lane.delivery!.publish = "disabled";
  // Delivery replacement shares the pipeline lease with retry admission;
  // only the external receipt and transcript can drift inside that lease.
  savePipelines([lane, replacement]);
  try {
    const result = await f.call({ action: "retry-stage", stageId: "build" });
    expect(result.isError, result.raw).toBe(true);
    expect(result.raw).toContain("Viewer publication denied");
    expect(retryAttempt()).toEqual(old);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { await f.close(); }
});

test("completed fail's confirmed stop survives shutdown bookkeeping and controller restart without a second dispatch (#2034)", async () => {
  const f = await completedFailureRetry();
  let stops = 0;
  f.h.ports.stopSettledStageWriter = async (target, key) => {
    expect(target).toMatchObject({ launchId: f.old.launchId, conversationId: f.old.conversationId, agentPath: f.old.agentPath });
    expect(key).toBe(`pipeline_retry_${retryLane().id}_build_1`);
    stops++;
    fs.appendFileSync(f.old.agentPath!, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "token_count", info: null } }) + "\n");
    return { outcome: "stopped" };
  };
  try {
    expect((await f.call({ action: "retry-stage", stageId: "build" })).isError).toBe(false);
    for (let i = 0; i < 3; i++) await tickPipelines([], f.h.ports);
    expect(stops).toBe(1);
    expect(f.h.spawnInputs).toHaveLength(2);
    const child = Bun.spawn([process.execPath, "-e", `
      const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
      await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
        spawnAgent: async () => { throw new Error("duplicate completed-stage dispatch after restart"); },
      });
    `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(retryLane().runs[0]!.attempts).toHaveLength(2);
    expect(retryLane().runs[0]!.attempts[0]).toEqual(f.old);
    expect(f.receipt.state).toBe("path-pending");
  } finally { await f.close(); }
});

test("retry recovers a zero-launch pending replacement after pause/resume with a stale activation (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  pipeline.runs[0]!.attempts.unshift({ ...structuredClone(attempt), n: 1, activation: undefined,
    state: "failed", completedAt: h.ports.now(), error: "superseded launch failure" });
  attempt.n = 2;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  expect((await patchPipeline(pipeline.id, { action: "pause" }, h.ports)).error).toBeUndefined();
  expect((await patchPipeline(pipeline.id, { action: "resume" }, h.ports)).error).toBeUndefined();
  h.ports.structuredDeliveryPublication = () => "unbound";
  const retry = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: pipeline.cursor!.stageId, expectedAttempt: 2 }, h.ports);
  expect(retry.error).toBeUndefined();
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.runs[0]!.attempts[1]).toMatchObject({ launchId: null, conversationId: null, startedAt: null });
  expect(waiting.stateDetail).toContain("delivery controller");
  expect(reportLaneFrom(waiting).failure).toBeNull();
  h.ports.structuredDeliveryPublication = () => "ready";
  for (let i = 0; i < 3; i++) {
    await engineModule.drainStageActivations(h.ports);
    await tickPipelines([], h.ports);
  }
  const recovered = loadPipelines()[0]!;
  expect(recovered.runs[0]!.attempts).toHaveLength(2);
  expect(recovered.runs[0]!.attempts[1]).toMatchObject({ n: 2, state: "running", launchId: "launch-1", spawnCalls: 1 });
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
  expect(reportLaneFrom(recovered).failure).toBeNull();
  // A fresh process has no in-memory activation guard. Durable settlement
  // must still prevent a second launch.
  const child = Bun.spawn([process.execPath, "-e", `
    const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
      spawnAgent: async () => { throw new Error("duplicate launch after restart"); },
    });
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toMatchObject({ code: 0 });
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.launchId).toBe("launch-1");
});

test.each(["launchId", "conversationId", "agentPath", "paneId", "startedAt", "report", "verdict"] as const)
("pending retry refuses an attempt with retained %s evidence (#2996)", async field => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  Object.assign(attempt, { [field]: field === "verdict" ? { status: "fail" }
    : field === "report" ? recoveryReport(h.ports.now())
    : field === "startedAt" ? h.ports.now() : "retained-evidence" });
  savePipelines(records);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation;
  const retry = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(retry.status).toBe(409);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toEqual(before);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test.each(["running", "paused"] as const)("pending retry preserves custody and request guards, state=%s (#2996)", async state => {
  const paused = state === "paused";
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  if (paused) { pipeline.state = "paused"; pipeline.pausedState = "running"; }
  savePipelines(records);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation;
  for (const guard of [{ expectedStageId: "other-stage" }, { expectedStageId: "plan", expectedAttempt: 2 }, { stageId: "plan", launchId: "stale-launch" }]) {
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", ...guard }, h.ports)).status).toBe(409);
  }
  for (let i = 0; i < 2; i++) {
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toEqual(before);
  }
  expect(loadPipelines()[0]!.state).toBe(paused ? "paused" : "running");
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test("a stale reservation with an admitted receipt keeps the original launch in custody (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pending-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const admitted = beginLegacySpawnFixture(registry, { engine: attempt.effectiveRole.engine,
      cwd: pipeline.worktreeDir!, clientAttemptId: attempt.activation!.clientAttemptId, transport: "structured",
      memberships: [attempt.activation!.input.membership] });
    if (admitted.kind !== "created") throw new Error("fixture receipt admission failed");
    attempt.activation!.phase = "reserving";
    attempt.spawnCalls = 1;
    attempt.state = "pending";
    attempt.startedAt = null;
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      launchId: admitted.receipt.launchId, conversationId: admitted.receipt.conversationId,
      state: "spawning", spawnCalls: 1,
    });
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
    expect(reportLaneFrom(loadPipelines()[0]!).wait).toContain("original launch receipt");
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test.each(["unbound", "rebinding"] as const)("a pending attempt without an activation waits for the %s controller and launches once (#2996)", async publication => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  h.ports.structuredDeliveryPublication = () => publication;
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain(`delivery controller (${publication})`);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  h.ports.structuredDeliveryPublication = () => "ready";
  if (publication === "rebinding") {
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait!;
    h.advanceWallClock(Date.parse(wait.retryAfter) - Date.parse(h.ports.now()));
  }
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test("a recovered pending attempt refuses a launch after its recorded controller deadline (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  h.ports.structuredDeliveryPublication = () => "rebinding";
  await tickPipelines([], h.ports);
  const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait!;
  h.advanceWallClock(Date.parse(wait.startedAt) + wait.budgetMs! - Date.parse(h.ports.now()));
  h.ports.structuredDeliveryPublication = () => "ready";
  await tickPipelines([], h.ports);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toEqual(wait);
});

test("pending retry preserves a booked controller backoff and names its deadline (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  attempt.controllerWait = { startedAt: h.ports.now(), retryAfter: new Date(Date.parse(h.ports.now()) + 60_000).toISOString(), rounds: 1 };
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  const before = structuredClone(attempt.controllerWait);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toEqual(before);
  expect(loadPipelines()[0]!.stateDetail).toContain(before.retryAfter);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test.each(["unadmitted", "admitted"] as const)("retry reconciles a stale %s activation on a failed predecessor before launching its replacement (#2996)", async admission => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const predecessor = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "predecessor-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const reserved = admission === "admitted" ? beginLegacySpawnFixture(registry, {
      engine: predecessor.effectiveRole.engine, cwd: pipeline.worktreeDir!,
      clientAttemptId: predecessor.activation!.clientAttemptId, transport: "structured",
      memberships: [predecessor.activation!.input.membership],
    }) : null;
    if (reserved && reserved.kind !== "created") throw new Error("fixture receipt admission failed");
    const receipt = reserved?.kind === "created" ? reserved.receipt : null;
    let receiptState: "starting" | "failed" = "starting";
    if (receipt) {
      predecessor.activation!.phase = "reserving";
      predecessor.spawnCalls = 1;
      h.ports.spawnReceipt = id => id === receipt.launchId ? ({ launchId: receipt.launchId, conversationId: receipt.conversationId,
        state: receiptState, sessionId: null, transcript: null, paneId: null }) : null;
    }
    predecessor.state = "failed";
    predecessor.completedAt = h.ports.now();
    predecessor.error = "pipeline paused";
    const replacement = { ...structuredClone(predecessor), n: 2, state: "pending" as const,
      startedAt: null, completedAt: null, error: null, activation: undefined, spawnCalls: undefined };
    predecessor.roleMemoryWait = { revision: "settled-memory", observations: 0, retryAfter: "2099-01-01T00:00:00.000Z" };
    pipeline.runs[0]!.attempts.push(replacement);
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    h.ports.structuredDeliveryPublication = () => "unbound";
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 2 }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
    h.ports.structuredDeliveryPublication = () => "ready";
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "pipeline paused" });
    if (receipt) {
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("dispatching");
      await new Promise(resolve => setImmediate(resolve));
      let wakes = 0;
      const unregister = registerPipelineTick(async () => { wakes++; });
      try {
        await tickPipelines([], h.ports);
        await new Promise(resolve => setImmediate(resolve));
        expect(wakes).toBe(0);
      } finally { unregister(); registerPipelineTick(async () => {}); }
      expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
      expect(loadPipelines()[0]!.cursor!.state).toBe("pending");
      const child = Bun.spawn([process.execPath, "-e", `
        const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
        await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
          spawnReceipt: () => (${JSON.stringify({ launchId: receipt.launchId, conversationId: receipt.conversationId,
            state: "starting", sessionId: null, transcript: null, paneId: null })}),
          spawnAgent: async () => { throw new Error("duplicate launch during receipt recovery"); },
        });
      `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("dispatching");
      receiptState = "failed";
      await engineModule.drainStageActivations(h.ports);
    }
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "running", launchId: "launch-1" });
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
    expect(reportLaneFrom(loadPipelines()[0]!).failure).toBeNull();
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test.each(["membership", "engine", "worktree", "transport"] as const)
("stale activation recovery refuses a receipt with mismatched %s (#2996)", async mismatch => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "foreign-receipt-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const reserved = beginLegacySpawnFixture(registry, {
      engine: mismatch === "engine" ? (attempt.effectiveRole.engine === "codex" ? "claude" : "codex") : attempt.effectiveRole.engine,
      cwd: mismatch === "worktree" ? `${pipeline.worktreeDir}-foreign` : pipeline.worktreeDir!,
      clientAttemptId: attempt.activation!.clientAttemptId, transport: mismatch === "transport" ? "tmux" : "structured",
      ...(mismatch !== "membership" ? { memberships: [attempt.activation!.input.membership] } : {}),
    });
    if (reserved.kind !== "created") throw new Error("fixture receipt admission failed");
    attempt.activation!.phase = "reserving";
    attempt.state = "pending";
    attempt.startedAt = null;
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBeNull();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeDefined();
    expect(loadPipelines()[0]!.stateDetail).toContain("stage membership");
    expect(registry.spawnReceipt(reserved.receipt.launchId)?.state).toBe("starting");
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  } finally { registry.close(); setAgentRegistryForTests(null); }
});
