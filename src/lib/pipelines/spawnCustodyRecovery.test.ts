import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { REGISTRY_WRITER_BUSY } from "@/lib/agent/registry";
import { codexSessionRoots } from "@/lib/accounts/codex";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { expect, test, spyOn, crypto, fs, path, harness, create, frozenWallClock, REMOTE_BRANCH,
  engineModule, patchPipeline, tickPipelines, loadPipelines, savePipelines,
  setAgentRegistryForTests, defaultPipelinePorts, durableStageTurnEvidence } from "./engine.fixture";

const FAILURE = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;
const KILLED_AT = "2026-11-21T09:08:13.818Z";
const KILLED_SETUP = `${FAILURE}; exit: signal SIGKILL; no Delegatus stop recorded at ${KILLED_AT}; ` +
  "stderr: bwrap: setting up uid map: Permission denied";
const NOW = "2026-11-12T12:00:00.000Z";
beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => setSystemTime());

async function fixture(trigger: "resume" | "takeover" = "resume") {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00007000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const h = harness();
  h.ports.now = () => NOW;
  const advance = frozenWallClock(h);
  const storage = sqliteRegistryFixture("spawn-custody");
  const registry = storage.registry;
  setAgentRegistryForTests(registry);
  const holder = registryLockHolder(storage.sqliteFilename);
  const journal = new RuntimeJournal(path.join(storage.root, "runtime.sqlite"),
    { structuredHosts: true, now: () => Date.parse(h.ports.now()) });
  const client = {
    operationStatus: async (id: string) => journal.operationResult(id),
    snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
  } as RuntimeHostClient;
  const production = defaultPipelinePorts({ spawnRecoveryClient: () => client });
  h.ports.spawnReceipt = production.spawnReceipt;
  h.ports.claimSpawnRetry = production.claimSpawnRetry;
  h.ports.stopStageAgent = production.stopStageAgent;
  h.ports.failStoppedStageLaunch = production.failStoppedStageLaunch;
  h.ports.unpublishedLaunchRetrySafe = production.unpublishedLaunchRetrySafe;
  h.ports.retireInterruptedStageSetup = production.retireInterruptedStageSetup;
  const close = async () => {
    await holder.close(); journal.close(); registry.close(); setAgentRegistryForTests(null);
    storage.cleanup(); ids.mockRestore();
  };
  try {
    const lane = await create(h.ports, [{ id: "plan", kind: "run", role: { roleId: "architect" },
      engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", prompt: "Review", next: null,
    }] as never, REMOTE_BRANCH);
    await tickPipelines([], h.ports);
    let tries = 0;
    const spawn = h.ports.spawnAgent;
    let failedLaunch = "";
    h.ports.spawnAgent = async (input, reserved, ...rest) => {
      if (++tries > 1) return spawn(input, reserved, ...rest);
      const begun = beginLegacySpawnFixture(registry, {
        engine: input.role.engine, cwd: input.cwd, transport: "structured", clientAttemptId: input.clientAttemptId,
        memberships: [input.membership],
      });
      expect(begun.kind).toBe("created");
      const receipt = begun.receipt;
      failedLaunch = receipt.launchId;
      await reserved(receipt);
      journal.executeOperation({ kind: "spawn", operationId: receipt.launchId, idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId, engine: receipt.engine, cwd: input.cwd, prompt: input.prompt });
      registry.beginStructuredHostSetup(receipt.launchId, receipt.admissionOwner!, Date.parse(h.ports.now()));
      await holder.hold();
      let failure: unknown;
      try { registry.recordStructuredHostSetup(receipt.launchId, receipt.admissionOwner!); }
      catch (error) { failure = error; }
      finally { await holder.release(); }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(FAILURE);
      registry.confirmStructuredHostSetupCleanup(receipt.launchId, receipt.admissionOwner!);
      journal.transitionOperation(receipt.launchId, "failed", { reason: FAILURE });
      await registry.failStructuredSpawnOffLoop(receipt.launchId, FAILURE);
      registry.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner!);
      throw failure;
    };
    if (trigger === "resume") {
      expect(await patchPipeline(lane.id, { action: "pause" }, h.ports)).not.toHaveProperty("error");
      expect(await patchPipeline(lane.id, { action: "resume" }, h.ports)).not.toHaveProperty("error");
    } else {
      const target = loadPipelines()[0]!.delivery!;
      expect(await patchPipeline(lane.id, { action: "takeover", expectedOwner: target.ownerId!,
        expectedEpoch: target.epoch, reason: "Recover delivery ownership" }, h.ports)).not.toHaveProperty("error");
      expect(loadPipelines()[0]!.delivery!.epoch).toBe(target.epoch + 1);
    }
    const row = () => loadPipelines()[0]!;
    return { h, registry, journal, client, production, holder, root: storage.root, advance, row, tries: () => tries,
      launch: () => failedLaunch,
      async launchOnce() {
        await tickPipelines([], h.ports);
        await engineModule.drainStageActivations(h.ports);
        expect(tries).toBe(1);
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

test.each(["resume", "takeover"] as const)("setup write lock after %s retries without a decision", async trigger => {
  const f = await fixture(trigger);
  try {
    await f.launchOnce();
    const attempt = f.row().runs[0]!.attempts[0]!;
    expect(f.row().state).toBe("running");
    expect(attempt.state).toBe("pending");
    expect(attempt.retiredLaunches).toMatchObject([{ launchId: f.launch(), error: FAILURE }]);
    expect(f.registry.conversation(f.registry.spawnReceipt(f.launch())!.conversationId)).toBeNull();
    expect(f.journal.operationResult(`spawn_message_${f.launch()}`)).toBeNull();
    const delay = Date.parse(attempt.controllerWait!.retryAfter) - Date.parse(f.h.ports.now());
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(30_000);
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(1);
    f.advance(delay);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(2);
    expect(f.row()).toMatchObject({ state: "running", cursor: { state: "running" } });
    expect(f.row().runs[0]!.attempts).toHaveLength(1);
  } finally { await f.close(); }
});

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const { setMcpHttpDependenciesForTests } = await import("@/lib/mcp/http");
  const { POST } = await import("@/app/api/mcp/route");
  let calls = 0;
  const dependencies = { ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "manager" as const, conversationId: "conversation_seat", role: "orchestrator" }),
    patchPipeline: (...args: Parameters<typeof engineModule.patchPipeline>) => {
      calls++;
      return engineModule.patchPipeline(args[0], args[1], f.h.ports, args[3]);
    },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies),
    new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const capability = "c".repeat(43);
  setMcpHttpDependenciesForTests({ service: async () => service,
    conversationForCapability: value => value === capability ? "conversation_seat" : null });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  const client = new Client({ name: "spawn-custody", version: "1" });
  const close = async () => {
    try { await client.close(); }
    finally { listener.stop(true); setMcpHttpDependenciesForTests(null); }
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
      requestInit: { headers: { "x-llv-spawn-capability": capability } },
    }));
  } catch (error) { await close(); throw error; }
  return { calls: () => calls,
    retry: (explicit: boolean, requestId = "custody-retry") => client.callTool({ name: "pipeline_action", arguments: {
      pipelineId: f.row().id, action: "retry-stage", clientRequestId: requestId,
      ...(explicit ? { stageId: "plan", launchId: f.launch() } : {}),
    } }),
    close,
  };
}

// The incident was a sixth attempt that already carried restart context.
// Reconstruct the saved pipeline and its original receipt using fixture IDs.
async function killedSetup(f: Awaited<ReturnType<typeof fixture>>,
  state: "starting" | "failed" | "silent" | "answered" | "native-answer" | "delivered"
    | "path-pending-silent" | "path-pending-answer",
  extraSetupProcess?: "alive" | "unverified") {
  // Keep this receipt in the historical park instead of scheduling a retry.
  f.h.ports.unpublishedLaunchRetrySafe = async () => false;
  await f.launchOnce();
  f.h.ports.unpublishedLaunchRetrySafe = f.production.unpublishedLaunchRetrySafe;
  f.advance(Date.parse(KILLED_AT) - Date.parse(NOW));
  const lane = f.row();
  const run = lane.runs[0]!;
  const first = run.attempts[0]!;
  const accounting = first.accounting!;
  const attempt = { ...structuredClone(first), n: 6, state: "spawning" as const, spawnCalls: 1,
    startedAt: "2026-11-21T09:08:05.907Z", completedAt: null, error: KILLED_SETUP,
    accounting: { ...accounting, repeatReason: "unknown" as const },
    restartContext: { previousAttempt: 5, transcriptPath: null } };
  const { receipt } = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: lane.worktreeDir!,
    transport: "structured", clientAttemptId: `pipeline_${lane.id}_plan_6`,
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "plan", slot: "plan:6",
      round: 6, role: "architect", stageOrder: 0, parentConversationId: null }] });
  const { launchId, conversationId, admissionOwner } = receipt;
  const spawnOperation = { kind: "spawn" as const, operationId: launchId, idempotencyKey: launchId,
    conversationId, engine: "codex" as const, cwd: lane.worktreeDir!, prompt: "Review" };
  f.journal.executeOperation(spawnOperation);
  expect(f.registry.releaseStartingStructuredSpawn(launchId, admissionOwner!).released).toBe(true);
  const owner = Bun.spawn([process.execPath, "-e", `
    const { AgentRegistry } = await import(process.argv[1]);
    const registry = new AgentRegistry(process.argv[2], undefined, undefined,
      { sqliteMode: "sqlite", sqliteFilename: process.argv[3] });
    if (!registry.claimStartingStructuredSpawn(process.argv[4]).claimed) process.exit(1);
    process.stdout.write("claimed");
    setInterval(() => {}, 1000);
  `, new URL("../agent/registry.ts", import.meta.url).href, path.join(f.root, "registry.json"), f.holder.sqliteFilename, launchId],
  { stdout: "pipe", stderr: "inherit" });
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  try {
    const reader = owner.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("claimed"); }
    finally { reader.releaseLock(); }
    const ownerIdentity = f.registry.spawnReceipt(launchId)!.admissionOwner!;
    expect(ownerIdentity.pid).toBe(owner.pid);
    const native = captureProcessIdentity(child.pid);
    expect(processIdentityStatus(ownerIdentity)).toBe("alive");
    expect(processIdentityStatus(native)).toBe("alive");
    f.registry.beginStructuredHostSetup(launchId, ownerIdentity, Date.parse(attempt.startedAt));
    f.registry.recordStructuredHostSetup(launchId, ownerIdentity, native);
    if (extraSetupProcess) {
      const identity = captureProcessIdentity(process.pid);
      f.registry.recordStructuredHostSetup(launchId, ownerIdentity, extraSetupProcess === "alive" ? identity
        : { ...identity, startIdentity: null });
    }
    await f.holder.hold();
    try {
      expect(() => f.registry.recordStructuredHostSetup(launchId, ownerIdentity)).toThrow(FAILURE);
      child.kill("SIGKILL");
      owner.kill("SIGKILL");
      await Promise.all([child.exited, owner.exited]);
      expect(child.signalCode).toBe("SIGKILL");
      expect(owner.signalCode).toBe("SIGKILL");
    } finally { await f.holder.release(); }
  } finally {
    if (child.signalCode === null && child.exitCode === null) child.kill("SIGKILL");
    if (owner.signalCode === null && owner.exitCode === null) owner.kill("SIGKILL");
    await Promise.all([child.exited, owner.exited]);
  }
  if (state !== "starting" && state !== "failed") {
    const sessionId = `custody-${launchId}`;
    const pathname = path.join(codexSessionRoots()[0]!, `${sessionId}.jsonl`);
    const nativeAnswer = state === "answered" || state === "native-answer" || state === "path-pending-answer";
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, [
      { timestamp: attempt.startedAt, type: "session_meta", payload: { id: sessionId, cwd: lane.worktreeDir } },
      ...(nativeAnswer ? [
        { timestamp: attempt.startedAt, type: "event_msg", payload: { type: "task_started" } },
        { timestamp: KILLED_AT, type: "response_item", payload: { type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Review complete" }] } },
      ] : []),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const staged = f.registry.stageStructuredSpawn(launchId, {
      key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: lane.worktreeDir!,
      accountId: null, status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
    });
    expect(staged.kind).toBe("settled");
    expect(await durableStageTurnEvidence("codex", pathname)).toMatchObject(nativeAnswer
      ? { message: { text: "Review complete" } }
      : { promptHistoryComplete: true, prompts: [], turn: "unknown", message: null });
    if (state === "answered" || state === "delivered") {
      f.journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "codex", sessionId }, artifactPath: pathname,
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      } });
      const messageId = `spawn_message_${launchId}`;
      f.journal.executeOperation({ kind: "send", operationId: messageId, idempotencyKey: messageId,
        conversationId, text: "Review", policy: "queue" });
      f.journal.transitionOperation(messageId, "delivering");
      f.journal.transitionOperation(messageId, "delivered");
      expect(f.journal.operationResult(messageId)?.receipt.status).toBe("delivered");
    }
    f.h.ports.durableTurnEvidence = durableStageTurnEvidence;
    f.h.ports.sourcePathAllowed = value => value === pathname;
  }
  f.journal.transitionOperation(launchId, "failed", { reason: KILLED_SETUP });
  if (state !== "starting" && !state.startsWith("path-pending-")) {
    expect((await f.registry.failStructuredSpawnOffLoop(launchId, KILLED_SETUP)).claimed).toBe(true);
  }
  const interrupted = f.registry.spawnReceipt(launchId)!;
  expect(interrupted.hostSetup?.cleanupConfirmed).toBeUndefined();
  expect(processIdentityStatus(interrupted.admissionOwner!)).toBe("dead");
  expect(interrupted.hostSetup?.processes.map(identity => processIdentityStatus(identity))).toEqual([
    "dead", ...(extraSetupProcess ? [extraSetupProcess] : []),
  ]);
  run.attempts = Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(first), n: index + 1, state: "failed", completedAt: attempt.startedAt,
    accounting: { ...accounting, repeatReason: index === 0 ? null : "unknown" as const },
  }));
  Object.assign(attempt, { launchId, conversationId });
  run.attempts.push(attempt);
  lane.state = "needs_decision"; lane.stateDetail = KILLED_SETUP; lane.cursor!.state = "spawning";
  savePipelines([lane]);
  // Reopen the controller's receipt projection after the original owners died.
  f.h.ports.spawnReceipt = defaultPipelinePorts({ spawnRecoveryClient: () => f.client }).spawnReceipt;
  return { lane, launchId, conversationId };
}

test.each(["failed", "starting", "compacted", "silent", "path-pending-silent"] as const)("retry-stage abandons the killed setup with a %s record", async state => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, state === "compacted" ? "failed" : state);
    if (state === "starting" || state === "path-pending-silent") {
      expect(f.registry.spawnReceipt(launchId)?.state).toBe(state === "starting" ? "starting" : "path-pending");
      lane.state = "running";
      lane.stateDetail = null;
      savePipelines([lane]);
      const genericRecovery = spyOn(f.production, "recoverStagedLaunch");
      f.h.ports.recoverStagedLaunch = genericRecovery;
      await tickPipelines([], f.h.ports);
      const parked = f.row();
      expect(parked.state).toBe("needs_decision");
      expect(parked.stateDetail).toContain(KILLED_SETUP);
      expect(genericRecovery).not.toHaveBeenCalled();
      expect(f.tries()).toBe(1);
    }
    if (state === "compacted") {
      f.journal.append({ scope: { type: "operation", id: "compaction-fixture" }, kind: "fixture-marker", payload: {} });
      f.journal.compact(1);
      expect(f.journal.snapshot().retentionFloorSeq).toBeGreaterThan(0);
      expect(f.journal.operationResult(launchId)).toBeNull();
    }
    const req = { action: "retry-stage", stageId: "plan", launchId } as const;
    const retry = await patchPipeline(lane.id, req, f.h.ports);
    expect(retry.error, JSON.stringify(retry.error)).toBeUndefined();
    expect(f.row().runs[0]!.attempts[5]).toMatchObject({ n: 6, launchId, state: "failed",
      error: expect.stringContaining("abandoned") });
    expect(f.registry.spawnReceipt(launchId)).toMatchObject({ state: "failed", admissionOwner: null, hostSetup: { cleanupConfirmed: true } });
    expect(f.journal.operationResult(`spawn_message_${launchId}`)).toBeNull();
    expect((await patchPipeline(lane.id, req, f.h.ports)).status).toBe(409);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 7, state: "running" });
    expect(f.row().runs[0]!.attempts[6]!.launchId).not.toBe(launchId);
    expect(f.tries()).toBe(2);
  } finally { await f.close(); }
});

test.each(["alive", "unverified"] as const)("retry-stage fences an %s setup process", async processState => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, "failed", processState);
    const reply = await patchPipeline(lane.id, { action: "retry-stage", stageId: "plan", launchId }, f.h.ports);
    expect(reply).toMatchObject({ status: 409, error: expect.stringContaining("native setup process cleanup is unconfirmed") });
    expect(f.registry.spawnReceipt(launchId)?.retryClaim).toBeUndefined();
    expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ launchId, n: 6 });
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(1);
  } finally { await f.close(); }
});

test("retry-stage closes admission before releasing interrupted setup custody", async () => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, "starting");
    const release = f.registry.releaseStructuredSpawnAdmissionOwner.bind(f.registry);
    const releaseAttempt = spyOn(f.registry, "releaseStructuredSpawnAdmissionOwner")
      .mockImplementationOnce(id => {
        const receipt = f.registry.spawnReceipt(id)!;
        expect(receipt.state).toBe("failed");
        return { released: false, receipt };
      }).mockImplementation(release);
    try {
      const request = { action: "retry-stage", stageId: "plan", launchId } as const;
      expect(await patchPipeline(lane.id, request, f.h.ports)).toMatchObject({ status: 409,
        error: expect.stringContaining("setup owner changed during cleanup reconciliation") });
      expect(f.registry.spawnReceipt(launchId)).toMatchObject({
        state: "failed", hostSetup: { cleanupConfirmed: true }, admissionOwner: { pid: expect.any(Number) },
      });
      expect(f.tries()).toBe(1);
      expect((await patchPipeline(lane.id, request, f.h.ports)).error).toBeUndefined();
      expect(f.registry.spawnReceipt(launchId)).toMatchObject({ state: "failed", admissionOwner: null });
      expect(f.row().runs[0]!.attempts[5]).toMatchObject({ n: 6, launchId, state: "failed",
        error: expect.stringContaining("abandoned") });
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.tries()).toBe(2);
    } finally { releaseAttempt.mockRestore(); }
  } finally { await f.close(); }
});

test.each(["answered", "native-answer", "delivered", "path-pending-answer"] as const)("parked retry-stage fences interrupted setup with %s evidence", async state => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, state);
    const [explicit, implicit] = await Promise.all([
      patchPipeline(lane.id, { action: "retry-stage", stageId: "plan", launchId }, f.h.ports),
      patchPipeline(lane.id, { action: "retry-stage" }, f.h.ports),
    ]);
    expect(explicit.status).toBe(409);
    expect(implicit.status).toBe(409);
    const refusal = state === "delivered" ? "runtime journal retains a first-message operation" : "verified silent transcript";
    expect(explicit.error).toContain(refusal);
    expect(implicit.error).toContain(refusal);
    expect(f.row().runs[0]!.attempts).toHaveLength(6);
    expect(f.registry.spawnReceipt(launchId)?.retryClaim).toBeUndefined();
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(1);
  } finally { await f.close(); }
});

test.each(["answered", "silent"] as const)("automatic recovery checks the original %s transcript", async state => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, state);
    lane.state = "running";
    lane.stateDetail = null;
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    if (state === "answered") {
      expect(f.row().state).toBe("needs_decision");
      expect(f.row().stateDetail).toContain("first-message journal evidence do not prove a safe replacement");
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ launchId, n: 6 });
      expect(f.registry.spawnReceipt(launchId)?.retryClaim).toBeUndefined();
    } else {
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ state: "pending", n: 6,
        retiredLaunches: [{ launchId, error: KILLED_SETUP }] });
      expect(f.registry.spawnReceipt(launchId)).toMatchObject({ admissionOwner: null,
        retryClaim: { claimId: `${lane.id}:plan:${launchId}` }, hostSetup: { cleanupConfirmed: true } });
    }
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(state === "answered" ? 1 : 2);
  } finally { await f.close(); }
});

test("retry-stage keeps custody if native work appears during journal verification", async () => {
  const f = await fixture();
  try {
    const { lane, launchId } = await killedSetup(f, "silent");
    const pathname = f.registry.spawnReceipt(launchId)!.artifactPath!;
    const replay = f.client.events;
    f.client.events = async (...args) => {
      const page = await replay(...args);
      fs.appendFileSync(pathname, JSON.stringify({ timestamp: KILLED_AT, type: "event_msg",
        payload: { type: "task_started" } }) + "\n");
      return page;
    };
    const reply = await patchPipeline(lane.id, { action: "retry-stage", stageId: "plan", launchId }, f.h.ports);
    expect(reply).toMatchObject({ status: 409, error: expect.stringContaining("evidence changed") });
    expect(f.registry.spawnReceipt(launchId)?.retryClaim).toBeUndefined();
    expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ launchId, n: 6 });
    await tickPipelines([], f.h.ports);
    expect(f.tries()).toBe(1);
  } finally { await f.close(); }
});

test.each([false, true].flatMap(explicit => ["absent", "uncertain", "journal-down", "owner-change"].map(delivery => ({ explicit, delivery }))))
("MCP retry-stage reconciles a stuck replacement: %j", async ({ explicit, delivery }) => {
  const f = await fixture();
  let sdk: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    // Preserve the old controller's exact park, before automatic retirement.
    f.h.ports.unpublishedLaunchRetrySafe = async () => false;
    await f.launchOnce();
    const lane = f.row();
    const first = lane.runs[0]!.attempts[0]!;
    const attempt = structuredClone(first);
    Object.assign(first, { state: "failed", completedAt: NOW });
    Object.assign(attempt, { n: 2, state: "needs_decision", completedAt: null, error: FAILURE,
      restartContext: { previousAttempt: 1, transcriptPath: null },
      accounting: { ...attempt.accounting, repeatReason: "unknown" } });
    // The original reservation must belong to this second attempt, as in the incident.
    const receipt = f.registry.spawnReceipt(f.launch())!;
    const key = `pipeline_${lane.id}_plan_2`;
    // Reserve through the real writer with the replacement's original request key.
    const replacement = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: lane.worktreeDir!,
      transport: "structured", clientAttemptId: key,
      memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "plan", slot: "plan:2",
        round: 2, role: "architect", stageOrder: 0, parentConversationId: null }] });
    const active = replacement.receipt;
    f.journal.executeOperation({ kind: "spawn", operationId: active.launchId, idempotencyKey: active.launchId,
      conversationId: active.conversationId, engine: "codex", cwd: lane.worktreeDir!, prompt: "Review" });
    f.registry.beginStructuredHostSetup(active.launchId, active.admissionOwner!, Date.parse(f.h.ports.now()));
    f.journal.transitionOperation(active.launchId, "failed", { reason: FAILURE });
    await f.registry.failStructuredSpawnOffLoop(active.launchId, FAILURE);
    f.registry.confirmStructuredHostSetupCleanup(active.launchId, active.admissionOwner!);
    f.registry.releaseStructuredSpawnAdmissionOwner(active.launchId, active.admissionOwner!);
    Object.assign(attempt, { launchId: active.launchId, conversationId: active.conversationId, spawnCalls: 1 });
    lane.runs[0]!.attempts.push(attempt);
    lane.state = "needs_decision"; lane.stateDetail = FAILURE; lane.cursor!.state = "spawning";
    savePipelines([lane]);
    expect(f.registry.conversation(active.conversationId)).toBeNull();
    expect(receipt.state).toBe("failed");
    if (delivery === "uncertain") {
      f.journal.append({ scope: { type: "session", id: active.conversationId }, kind: "session-status", payload: {
        conversationId: active.conversationId, sessionKey: { engine: "codex", sessionId: "uncertain-stage" },
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      } });
      f.journal.executeOperation({ kind: "send", operationId: `spawn_message_${active.launchId}`,
        idempotencyKey: `spawn_${active.launchId}`, conversationId: active.conversationId, text: "Review", policy: "queue" });
      f.journal.transitionOperation(`spawn_message_${active.launchId}`, "uncertain");
      expect(f.journal.operationResult(`spawn_message_${active.launchId}`)?.receipt.status).toBe("uncertain");
    }
    if (delivery === "owner-change") {
      const events = f.client.events;
      f.client.events = async (...args) => {
        const replay = await events(...args);
        f.registry.claimFailedSpawnForRetry(active.launchId, "replacement-owner");
        return replay;
      };
    }
    const production = defaultPipelinePorts({ spawnRecoveryClient: () => delivery === "journal-down" ? null : f.client });
    f.h.ports.spawnReceipt = production.spawnReceipt;
    f.h.ports.failStoppedStageLaunch = production.failStoppedStageLaunch;
    f.h.ports.unpublishedLaunchRetrySafe = production.unpublishedLaunchRetrySafe;
    // The SDK uses the current launch, including its explicit receipt selector.
    expect(f.h.ports.spawnReceipt(active.launchId)).toMatchObject({ state: "failed", error: FAILURE });
    const current = { ...f, launch: () => active.launchId };
    sdk = await connect(current);
    const answer = await sdk.retry(explicit);
    expect(sdk.calls()).toBe(1);
    if (delivery === "absent") {
      expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
      expect(f.row().cursor!.state).toBe("pending");
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, state: "failed" });
      expect(f.registry.spawnReceipt(active.launchId)?.retryClaim?.claimId).toBe(`${lane.id}:plan:${active.launchId}`);
      expect((await sdk.retry(explicit)).isError).not.toBe(true);
      expect(sdk.calls()).toBe(1);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "running" });
      expect(f.tries()).toBe(2);
    } else {
      expect(answer.isError).toBe(true);
      expect(f.row().cursor!.state).toBe("spawning");
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ launchId: active.launchId, verdict: null });
      if (delivery === "owner-change") {
        expect(f.registry.spawnReceipt(active.launchId)?.retryClaim?.claimId).toBe("replacement-owner");
      } else expect(f.registry.spawnReceipt(active.launchId)?.retryClaim).toBeUndefined();
      expect(f.tries()).toBe(1);
      if (delivery === "journal-down") {
        const restored = defaultPipelinePorts({ spawnRecoveryClient: () => f.client });
        f.h.ports.spawnReceipt = restored.spawnReceipt;
        f.h.ports.unpublishedLaunchRetrySafe = restored.unpublishedLaunchRetrySafe;
        expect((await sdk.retry(explicit, "custody-restored")).isError).not.toBe(true);
        expect(sdk.calls()).toBe(2);
        expect(f.row().cursor!.state).toBe("pending");
      }
    }
  } finally { await sdk?.close(); await f.close(); }
});
