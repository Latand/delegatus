import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { REGISTRY_WRITER_BUSY } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { expect, test, spyOn, crypto, path, harness, create, frozenWallClock, REMOTE_BRANCH,
  engineModule, patchPipeline, tickPipelines, loadPipelines, savePipelines,
  setAgentRegistryForTests, defaultPipelinePorts } from "./engine.fixture";

const FAILURE = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;
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
    return { h, registry, journal, client, production, advance, row, tries: () => tries,
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
