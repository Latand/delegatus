import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { REGISTRY_WRITER_BUSY, type SpawnReceipt } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { expect, test, spyOn, crypto, path, harness, create, frozenWallClock, REMOTE_BRANCH,
  engineModule, patchPipeline, tickPipelines, loadPipelines, savePipelines,
  setAgentRegistryForTests, defaultPipelinePorts } from "./engine.fixture";

const FAILURE = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;
const KILLED_SETUP = `${FAILURE}; exit: signal SIGKILL; bwrap: setting up uid map`;
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
    readSession: async (identity: Parameters<RuntimeJournal["readSession"]>[0]) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
  } as RuntimeHostClient;
  const production = defaultPipelinePorts({ spawnRecoveryClient: () => client });
  h.ports.spawnReceipt = production.spawnReceipt;
  h.ports.claimSpawnRetry = production.claimSpawnRetry;
  h.ports.stopStageAgent = production.stopStageAgent;
  h.ports.failStoppedStageLaunch = production.failStoppedStageLaunch;
  h.ports.unpublishedLaunchRetrySafe = production.unpublishedLaunchRetrySafe;
  h.ports.retireInterruptedStageLaunch = production.retireInterruptedStageLaunch;
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
    return { h, registry, journal, client, production, advance, row, holder, storage, tries: () => tries,
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

async function interruptSetupOwner(f: Awaited<ReturnType<typeof fixture>>, receipt: SpawnReceipt, leaveSetupRunning: boolean) {
  const { launchId, admissionOwner } = receipt;
  expect(f.registry.releaseStartingStructuredSpawn(launchId, admissionOwner!).released).toBe(true);
  const owner = Bun.spawn([process.execPath, "-e", `
    const { AgentRegistry } = await import(process.argv[1]);
    const registry = new AgentRegistry(process.argv[2], undefined, undefined,
      { sqliteMode: "sqlite", sqliteFilename: process.argv[3] });
    if (!registry.claimStartingStructuredSpawn(process.argv[4]).claimed) process.exit(1);
    process.stdout.write("claimed");
    setInterval(() => {}, 1000);
  `, new URL("../agent/registry.ts", import.meta.url).href, path.join(f.storage.root, "registry.json"), f.storage.sqliteFilename, launchId],
  { stdout: "pipe", stderr: "inherit" });
  let helper: Bun.Subprocess | undefined;
  let handoff = false;
  try {
    const reader = owner.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("claimed"); }
    finally { reader.releaseLock(); }
    const identity = f.registry.spawnReceipt(launchId)!.admissionOwner!;
    expect(identity.pid).toBe(owner.pid);
    f.registry.beginStructuredHostSetup(launchId, identity, Date.parse(f.h.ports.now()));
    helper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    f.registry.recordStructuredHostSetup(launchId, identity, captureProcessIdentity(helper.pid));
    await f.holder.hold();
    try {
      expect(() => f.registry.recordStructuredHostSetup(launchId, identity)).toThrow(FAILURE);
      if (!leaveSetupRunning) helper.kill("SIGKILL");
      owner.kill("SIGKILL");
      await owner.exited;
      if (!leaveSetupRunning) {
        await helper.exited;
        expect(helper.signalCode).toBe("SIGKILL");
      }
    } finally { await f.holder.release(); }
    expect(owner.signalCode).toBe("SIGKILL");
    expect(processIdentityStatus(identity)).toBe("dead");
    handoff = leaveSetupRunning;
    return handoff ? helper : undefined;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await owner.exited;
    if (helper && !handoff) {
      if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
      await helper.exited;
    }
  }
}

test.each([
  ...[false, true].flatMap(explicit => ["absent", "uncertain", "journal-down", "owner-change"].map(delivery => ({ explicit, delivery, cut: "setup" }))),
  { explicit: true, delivery: "absent", cut: "before-admission" },
  { explicit: true, delivery: "absent", cut: "killed-setup" },
  { explicit: true, delivery: "uncertain", cut: "before-admission" },
  { explicit: true, delivery: "uncertain", cut: "killed-setup" },
  { explicit: true, delivery: "cleanup-unproven", cut: "killed-setup" },
  { explicit: true, delivery: "compacted", cut: "before-admission" },
  { explicit: true, delivery: "native-session", cut: "killed-setup" },
  { explicit: true, delivery: "pending-reservation", cut: "before-admission" },
  { explicit: true, delivery: "killed-owner", cut: "killed-setup" },
  { explicit: true, delivery: "killed-owner-starting", cut: "killed-setup" },
  { explicit: true, delivery: "retirement-interrupted", cut: "killed-setup" },
  { explicit: true, delivery: "release-interrupted", cut: "killed-setup" },
  { explicit: true, delivery: "live-setup-process", cut: "killed-setup" },
  { explicit: true, delivery: "setup-owner-change", cut: "killed-setup" },
  { explicit: true, delivery: "different-journal-failure", cut: "killed-setup" },
])
("MCP retry-stage reconciles a stuck replacement: %j", async ({ explicit, delivery, cut }) => {
  const f = await fixture();
  let sdk: Awaited<ReturnType<typeof connect>> | undefined;
  let liveSetup: Bun.Subprocess | undefined;
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
    const interruptedRetirement = delivery === "retirement-interrupted" || delivery === "release-interrupted";
    const interruptedOwner = interruptedRetirement
      || ["killed-owner", "killed-owner-starting", "live-setup-process", "setup-owner-change"].includes(delivery);
    const ownerIdentity = active.admissionOwner!;
    const failure = cut === "before-admission" ? `structured spawn interrupted before runtime admission: ${active.launchId}`
      : cut === "killed-setup" ? KILLED_SETUP : FAILURE;
    if (cut !== "before-admission") {
      f.journal.executeOperation({ kind: "spawn", operationId: active.launchId, idempotencyKey: active.launchId,
        conversationId: active.conversationId, engine: "codex", cwd: lane.worktreeDir!, prompt: "Review" });
      if (interruptedOwner) {
        liveSetup = await interruptSetupOwner(f, active, delivery === "live-setup-process");
      } else {
        f.registry.beginStructuredHostSetup(active.launchId, ownerIdentity, Date.parse(f.h.ports.now()));
      }
      if (cut === "killed-setup" && !interruptedOwner) {
        // The setup helper has no engine exec permit.
        const helper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
        try { f.registry.recordStructuredHostSetup(active.launchId, active.admissionOwner!, captureProcessIdentity(helper.pid)); }
        finally { helper.kill("SIGKILL"); await helper.exited; }
        expect(helper.signalCode).toBe("SIGKILL");
      }
      f.journal.transitionOperation(active.launchId, "failed", {
        reason: delivery === "different-journal-failure" ? "native session setup failed" : failure,
      });
      if (delivery !== "cleanup-unproven" && !interruptedOwner) f.registry.confirmStructuredHostSetupCleanup(active.launchId, ownerIdentity);
    }
    const starting = interruptedRetirement || delivery === "pending-reservation" || delivery === "killed-owner-starting";
    if (!starting) await f.registry.failStructuredSpawnOffLoop(active.launchId, failure);
    if (!interruptedOwner) f.registry.releaseStructuredSpawnAdmissionOwner(active.launchId, ownerIdentity);
    Object.assign(attempt, { launchId: active.launchId, conversationId: active.conversationId, spawnCalls: 1, error: failure });
    lane.runs[0]!.attempts.push(attempt);
    lane.state = "needs_decision"; lane.stateDetail = failure; lane.cursor!.state = "spawning";
    savePipelines([lane]);
    expect(f.registry.conversation(active.conversationId)).toBeNull();
    expect(f.registry.spawnReceipt(active.launchId)).toMatchObject({ key: null, artifactPath: null });
    if (cut === "before-admission") {
      expect(f.journal.operationResult(active.launchId)).toBeNull();
      expect(f.journal.readSession({ conversationId: active.conversationId })).toBeNull();
    }
    expect(receipt.state).toBe("failed");
    if (delivery === "compacted") {
      for (let n = 0; n < 4; n++) f.journal.append({ scope: { type: "operation", id: "compaction-fixture" },
        kind: "fixture-marker", payload: { n } });
      f.journal.compact(1);
      expect(f.journal.snapshot().retentionFloorSeq).toBeGreaterThan(0);
    }
    if (delivery === "uncertain" || delivery === "native-session") {
      f.journal.append({ scope: { type: "session", id: active.conversationId }, kind: "session-status", payload: {
        conversationId: active.conversationId, sessionKey: { engine: "codex", sessionId: "uncertain-stage" },
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      } });
      if (delivery === "uncertain") {
        f.journal.executeOperation({ kind: "send", operationId: `spawn_message_${active.launchId}`,
          idempotencyKey: `spawn_${active.launchId}`, conversationId: active.conversationId, text: "Review", policy: "queue" });
        f.journal.transitionOperation(`spawn_message_${active.launchId}`, "uncertain");
        expect(f.journal.operationResult(`spawn_message_${active.launchId}`)?.receipt.status).toBe("uncertain");
      }
    }
    if (delivery === "owner-change" || delivery === "setup-owner-change") {
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
    expect(f.h.ports.spawnReceipt(active.launchId)).toMatchObject(starting
      ? { state: "starting", error: null } : { state: "failed", error: failure });
    if (delivery !== "uncertain") expect(f.journal.operationResult(`spawn_message_${active.launchId}`)).toBeNull();
    const current = { ...f, launch: () => active.launchId };
    sdk = await connect(current);
    if (interruptedRetirement) {
      const checkpoint = delivery === "retirement-interrupted"
        ? spyOn(f.registry, "confirmStructuredHostSetupCleanup").mockImplementationOnce(() => { throw new Error("fixture interruption before setup cleanup"); })
        : spyOn(f.registry, "releaseStructuredSpawnAdmissionOwner").mockImplementationOnce(() => { throw new Error("fixture interruption before owner release"); });
      try {
        expect((await sdk.retry(explicit)).isError).toBe(true);
        expect(f.registry.spawnReceipt(active.launchId)).toMatchObject({
          state: "failed", error: failure, hostSetup: { phase: "executing" },
        });
        expect(f.registry.spawnReceipt(active.launchId)?.hostSetup?.cleanupConfirmed)
          .toBe(delivery === "release-interrupted" ? true : undefined);
        expect(f.registry.spawnReceipt(active.launchId)?.admissionOwner).not.toBeNull();
        expect(f.row().runs[0]!.attempts).toHaveLength(2);
        expect(f.tries()).toBe(1);
      } finally { checkpoint.mockRestore(); }
    }
    const requestId = interruptedRetirement ? "retirement-resume" : "custody-retry";
    const retryCalls = interruptedRetirement ? 2 : 1;
    const answer = await sdk.retry(explicit, requestId);
    expect(sdk.calls()).toBe(retryCalls);
    if (interruptedRetirement || ["absent", "pending-reservation", "killed-owner", "killed-owner-starting"].includes(delivery)) {
      expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
      expect(f.row().cursor!.state).toBe("pending");
      expect(f.row().runs[0]!.attempts[1]).toMatchObject({ n: 2, state: "failed", launchId: active.launchId });
      if (cut !== "setup") expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "pending", launchId: null });
      expect(f.registry.spawnReceipt(active.launchId)?.retryClaim?.claimId).toBe(`${lane.id}:plan:${active.launchId}`);
      if (interruptedOwner) expect(f.registry.spawnReceipt(active.launchId)).toMatchObject({
        state: "failed", admissionOwner: null, hostSetup: { cleanupConfirmed: true },
      });
      expect((await sdk.retry(explicit, requestId)).isError).not.toBe(true);
      expect(sdk.calls()).toBe(retryCalls);
      if (explicit && cut !== "setup") {
        expect((await sdk.retry(true, "custody-stale-launch")).isError).toBe(true);
        expect(f.row().runs[0]!.attempts).toHaveLength(3);
      }
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "running" });
      expect(f.tries()).toBe(2);
    } else {
      expect(answer.isError).toBe(true);
      expect(f.row().cursor!.state).toBe("spawning");
      expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ launchId: active.launchId, verdict: null });
      if (delivery === "owner-change" || delivery === "setup-owner-change") {
        expect(f.registry.spawnReceipt(active.launchId)?.retryClaim?.claimId).toBe("replacement-owner");
        if (delivery === "setup-owner-change") expect(f.registry.spawnReceipt(active.launchId)?.hostSetup?.cleanupConfirmed).toBeUndefined();
      } else expect(f.registry.spawnReceipt(active.launchId)?.retryClaim).toBeUndefined();
      expect(f.tries()).toBe(1);
      if (delivery === "cleanup-unproven") expect(JSON.stringify(answer)).toContain("admission owner");
      if (delivery === "live-setup-process") {
        expect(JSON.stringify(answer)).toContain("native setup process cleanup is unconfirmed");
        expect(f.registry.spawnReceipt(active.launchId)?.hostSetup?.cleanupConfirmed).toBeUndefined();
        liveSetup!.kill("SIGKILL");
        await liveSetup!.exited;
        expect((await sdk.retry(explicit, "setup-process-exited")).isError).not.toBe(true);
        expect(f.row().runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "pending", launchId: null });
      }
      if (delivery === "different-journal-failure") expect(JSON.stringify(answer)).toContain("first-message journal");
      if (delivery === "journal-down") {
        const restored = defaultPipelinePorts({ spawnRecoveryClient: () => f.client });
        f.h.ports.spawnReceipt = restored.spawnReceipt;
        f.h.ports.unpublishedLaunchRetrySafe = restored.unpublishedLaunchRetrySafe;
        expect((await sdk.retry(explicit, "custody-restored")).isError).not.toBe(true);
        expect(sdk.calls()).toBe(2);
        expect(f.row().cursor!.state).toBe("pending");
      }
    }
  } finally {
    if (liveSetup) {
      if (liveSetup.exitCode === null && liveSetup.signalCode === null) liveSetup.kill("SIGKILL");
      await liveSetup.exited;
    }
    await sdk?.close(); await f.close();
  }
});
