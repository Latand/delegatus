import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import type { CodexAccount } from "@/lib/accounts/codex";
import { structuredContent, type StructuredImageRef } from "@/lib/runtime/structuredContent";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";
import { QuotaController, type QuotaProbePort } from "./quotaController";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-"));
const { AccountMigrationController, createMigrationDeliveryPort, reconcileAccountMigrationCycle, startAccountMigrationController } = await import("./controller");

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("production inventory scheduler leaves a full idle minute after a slow scan completes", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "idle-scheduler.json"));
  let clock = 0;
  let scans = 0;
  let finishScan!: () => void;
  const timers = new Map<object, { run: () => void; due: number; interval: number }>();
  const schedule = (run: () => void, delay: number, interval = 0) => {
    const handle = { unref() {} };
    timers.set(handle, { run, due: clock + delay, interval });
    return handle;
  };
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => {
      scans++;
      if (scans === 1) await new Promise<void>(resolve => { finishScan = resolve; });
      return { files: [], projectCatalog: [], complete: true };
    },
    // External board/process/account writes are isolated. Inventory and migration
    // reconciliation, the controller's poll/running fence and its scheduler are real.
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {},
    reconcileHandoffOwnership: async () => {}, reconcileFiles: async () => {},
    reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ["__llvAccountMigrationController", "__llvAccountMigrationStopPolling", "__llvAccountMigrationTimer",
    "__llvAccountMigrationInitialTimer", "__llvAccountMigrationBootstrapStarted"];
  const saved = new Map(keys.map(key => [key, globals[key]]));
  const worker = process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => schedule(run, delay)) as never);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((run: () => void, delay: number) => schedule(run, delay, delay)) as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: object) => { timers.delete(handle); }) as never);
  const advance = async (ms: number) => {
    const until = clock + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [handle, timer] = next;
      clock = timer.due;
      if (timer.interval) timer.due += timer.interval; else timers.delete(handle);
      timer.run();
      await Promise.resolve();
    }
    clock = until;
  };
  try {
    for (const key of keys) delete globals[key];
    globals.__llvAccountMigrationController = controller;
    process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER = "1";
    await startAccountMigrationController();
    await advance(1000);
    expect(scans).toBe(1);
    await advance(180_000);
    expect(scans).toBe(1);
    const running = controller.poll();
    finishScan();
    await running;
    await Promise.resolve(); await Promise.resolve();
    await advance(59_000);
    expect(scans).toBe(1);
    await advance(1000);
    expect(scans).toBe(2);
    await controller.poll();
  } finally {
    (globals.__llvAccountMigrationStopPolling as (() => void) | undefined)?.();
    await controller.poll();
    timeout.mockRestore(); interval.mockRestore(); clear.mockRestore();
    for (const [key, value] of saved) { if (value === undefined) delete globals[key]; else globals[key] = value; }
    if (worker === undefined) delete process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER;
    else process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER = worker;
    registry.close();
  }
});

test("historical failures and orphaned applying rows perform no conversation or delivery reads per migration tick", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "quiet-history.json"), undefined, undefined, { sqliteMode: "sqlite" });
  try {
    registry.reconcileConversations(Array.from({ length: 100 }, (_, i) => ({ engine: "codex" as const,
      path: `/quiet/${i}.jsonl`, accountId: "account-a", launchProfile: emptyLaunchProfile(),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null }, observedAt: "2026-07-01T00:00:00Z" })));
    const rows = Object.values(registry.readOnlySnapshot().conversations);
    for (const row of rows.slice(0, 13)) {
      const requested = registry.requestConversationReseat(row.id, "account-b");
      registry.transitionConversationMigration(row.id, requested.migration!.revision, [requested.migration!.phase], { phase: "failed-recoverable", error: "old failure" });
      registry.holdDelivery(row.id, "preserve this held message", `held-${row.id}`, "text", [], null);
    }
    for (const [i, row] of rows.slice(13, 15).entries()) registry.claimConversationReconfigure(row.id, {
      operationId: `orphan-${i}`, revision: 1, profile: { model: "gpt-5.6-sol", effort: "high", fast: false }, accountId: "account-b",
    });
    let reads = 0;
    for (const method of ["conversation", "pendingDeliveries"] as const) {
      const original = registry[method].bind(registry);
      registry[method] = ((id: Parameters<typeof original>[0]) => { reads++; return original(id); }) as never;
    }
    const provider: SuccessorProviderPort = { create: async () => { throw new Error("no actionable migration"); }, verify: async () => {} };
    const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
      scan: async () => ({ files: [], projectCatalog: [], complete: true }),
      reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {},
      reconcileHandoffOwnership: async () => {}, reconcileFiles: async () => {},
      reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
      reconcileMigrationCycle: (r, q) => reconcileAccountMigrationCycle(r, q, provider,
        { deliver: async () => { throw new Error("no actionable delivery"); } }),
    });
    for (let tick = 0; tick < 3; tick++) await controller.poll();
    expect(reads).toBe(0);
    expect(Object.values(registry.readOnlySnapshot().conversations).filter(row => row.migration?.phase === "failed-recoverable")).toHaveLength(13);
  } finally { registry.close(); }
});

test("controller migration cycle reconciles and ticks both durable quota policy guards", async () => {
  const ticks: string[] = [];
  const quota = { tick: async (engine: string) => { ticks.push(engine); } };
  const registry = new AgentRegistry(path.join(stateDir, "registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: "/source.jsonl",
    accountId: "source",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath("/source.jsonl")!;
  registry.commitMigrationIntent({ engine: "codex", targetId: "target", origin: "manual", requestId: "controller-cycle", expectedRevision: registry.engineRouting("codex").revision });
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create(input) { return { operationId: input.operationId, nativeId: "successor", path: "/target.jsonl", continuityPaths: [], historyHash: "hash", host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" } }; },
    async verify() {},
  };

  await reconcileAccountMigrationCycle(registry, quota as never, provider, { async deliver() { return "delivered"; } });

  expect(ticks.sort()).toEqual(["claude", "codex"]);
  expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
}, 20_000);

test("controller preserves durable image refs while draining a migration-held structured message", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "structured-delivery-registry.json"));
  registry.reconcileConversations([{
    engine: "claude",
    path: "/structured-successor.jsonl",
    accountId: "target",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath("/structured-successor.jsonl")!;
  const imageRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const content = structuredContent("continue", [imageRef]);
  const assigned = registry.holdDelivery(conversation.id, "continue", "migration-message", "runtime-images", [imageRef], content.contentDigest);
  const claimed = registry.beginDeliveryAttempt(assigned.id, assigned.generationId!)!;
  const structured: unknown[] = [];
  let legacyCalls = 0;
  const port = createMigrationDeliveryPort({
    structuredDelivery: async (request) => {
      structured.push(request);
      return "delivered";
    },
    legacyDelivery: async () => {
      legacyCalls += 1;
      return "delivered";
    },
  });

  const outcome = await port.deliver({
    delivery: claimed,
    path: "/structured-successor.jsonl",
    clientMessageId: "migration-message",
  });

  expect(outcome).toBe("delivered");
  expect(structured).toEqual([{
    conversationId: conversation.id,
    runtimeConversationId: conversation.id,
    path: "/structured-successor.jsonl",
    deliveryId: claimed.id,
    clientMessageId: "migration-message",
    text: "continue",
    command: claimed.command,
    imageRefs: [imageRef],
  }]);
  expect(legacyCalls).toBe(0);
});

test("controller keeps an uncertain structured claim fenced when ownership cannot be reconciled", async () => {
  let legacyCalls = 0;
  const port = createMigrationDeliveryPort({
    structuredDelivery: async () => null,
    legacyDelivery: async () => {
      legacyCalls += 1;
      return "delivered";
    },
  });
  const delivery = {
    id: "held-one",
    conversationId: "conversation_11111111-1111-4111-8111-111111111111" as const,
    runtimeConversationId: "conversation_11111111-1111-4111-8111-111111111111" as const,
    text: "continue",
    createdAt: "2026-07-13T00:00:00.000Z",
    clientMessageId: "migration-message",
    payloadKind: "text" as const,
    runtimeImages: [],
    contentDigest: null,
    artifactPaths: [],
    command: {
      operationId: "held-one",
      kind: "send" as const,
      policy: "interrupt-active" as const,
    },
    requestDigest: "held-one-request-digest",
    state: "delivery-uncertain" as const,
    generationId: "generation-one",
    attempts: 1,
    assignedAt: "2026-07-13T00:00:00.000Z",
    deliveredAt: null,
    error: "delivery started; recovery requires an explicit outcome",
  };

  const outcome = await port.reconcileUncertain!({
    delivery,
    path: "/structured-successor.jsonl",
    clientMessageId: "migration-message",
  });

  expect(outcome).toBe("delivery-uncertain");
  expect(legacyCalls).toBe(0);
});

test("controller runs a trailing cycle when a signal arrives during reconciliation", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "trailing-cycle-registry.json"));
  let releaseFirstCycle = () => {};
  const firstCycleBlocked = new Promise<void>((resolve) => { releaseFirstCycle = resolve; });
  let cycles = 0;
  let activeCycles = 0;
  let maxActiveCycles = 0;
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => {} } as never,
    async () => {
      cycles += 1;
      activeCycles += 1;
      maxActiveCycles = Math.max(maxActiveCycles, activeCycles);
      try {
        if (cycles === 1) await firstCycleBlocked;
      } finally {
        activeCycles -= 1;
      }
    },
  );

  const firstTick = controller.tick();
  const trailingTick = controller.tick();
  const coalescedTick = controller.tick();
  releaseFirstCycle();
  await Promise.all([firstTick, trailingTick, coalescedTick]);

  expect(cycles).toBe(2);
  expect(maxActiveCycles).toBe(1);
});

test("periodic polling joins a running cycle without scheduling another full inventory", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cycles = 0;
  const controller = new AccountMigrationController(
    new AgentRegistry(path.join(stateDir, "poll-coalescing-registry.json")),
    { tick: async () => {} } as never,
    async () => { cycles += 1; await blocked; },
  );

  const running = controller.tick();
  const periodic = controller.poll();
  release();
  await Promise.all([running, periodic]);

  expect(cycles).toBe(1);
});

test("controller preserves one trailing cycle when the running cycle fails", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cycles = 0;
  const controller = new AccountMigrationController(
    new AgentRegistry(path.join(stateDir, "failing-trailing-registry.json")),
    { tick: async () => {} } as never,
    async () => { cycles += 1; if (cycles === 1) { await blocked; throw new Error("cycle failed"); } },
  );
  const first = controller.tick();
  controller.tick();
  release();
  await expect(first).rejects.toThrow("cycle failed");
  expect(cycles).toBe(2);
});

test("controller reconciliation waits for a complete scanner inventory", async () => {
  const reconciliations: string[] = [];
  let complete = false;
  const registry = new AgentRegistry(path.join(stateDir, "incomplete-inventory-registry.json"));
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => {} } as never,
    null,
    {
      scan: async () => ({ files: [], projectCatalog: [], complete }),
      reconcileInventory: async () => { reconciliations.push("inventory"); return registry.snapshot(); },
      reconcileFlowOwnership: async () => { reconciliations.push("flows"); },
      reconcileWorkflowOwnership: async () => { reconciliations.push("workflows"); },
      reconcileHandoffOwnership: async () => { reconciliations.push("handoffs"); },
      reconcileFiles: async () => { reconciliations.push("files"); },
      reconcileRuntime: async () => { reconciliations.push("runtime"); },
      reconcileTaskStore: async () => { reconciliations.push("tasks"); },
      syncRouting: async () => { reconciliations.push("routing"); },
      reconcileMigrationCycle: async () => { reconciliations.push("migration"); },
    },
  );

  await controller.tick();
  expect(reconciliations).toEqual([]);

  complete = true;
  await controller.tick();
  expect(reconciliations).toEqual([
    "inventory",
    "flows",
    "workflows",
    "handoffs",
    "files",
    "runtime",
    "tasks",
    "routing",
    "migration",
  ]);
});

test("quota controller cycles preserve routing and transcript ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-auto-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    const main: CodexAccount = { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 };
    const managed: CodexAccount = { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    const probe: QuotaProbePort = {
      list: (engine) => engine === "codex" ? [main, managed] : [],
      active: () => "default",
      async probe(engine, candidate, observedAt) {
        const used = candidate.id === "default" ? 80 : 20;
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: observedAt,
          limits: { session: { usedPercent: used, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(observedAt / 1000) },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt,
        };
      },
    };
    const bootId = crypto.randomUUID();
    const quota = new QuotaController(registry, probe, bootId, () => current);
    registry.setAutoBalancePolicy("codex", true);
    registry.setEngineRouting("codex", "default");
    registry.reconcileConversations([{
      engine: "codex",
      path: "/main.jsonl",
      accountId: "default",
      launchProfile: emptyLaunchProfile({ title: "Main card" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: new Date(current).toISOString(),
    }]);
    registry.upsert({
      key: { engine: "codex", sessionId: crypto.randomUUID() },
      artifactPath: "/main.jsonl",
      cwd: "/repo",
      accountId: "default",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const conversationId = registry.conversationForPath("/main.jsonl")!.id;
    let successorStarts = 0;
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        successorStarts += 1;
        return {
          operationId: input.operationId,
          nativeId: "managed-successor",
          path: "/managed.jsonl",
          continuityPaths: [],
          historyHash: "managed-history",
          host: { kind: "codex-app-server", identity: "managed-successor", epoch: 1, verifiedAt: new Date(current).toISOString() },
        };
      },
      async verify() {},
    };

    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    const snapshot = registry.snapshot();
    expect(snapshot.quotaObservations.codex.default).toMatchObject({ authenticated: true, bootId });
    expect(snapshot.quotaObservations.codex.managed).toMatchObject({ authenticated: true, bootId });
    expect(snapshot.engineRouting.codex.activeAccountId).toBe("default");
    expect(snapshot.conversations[conversationId]?.migration).toBeNull();
    expect(snapshot.conversations[conversationId]?.generations.at(-1)?.accountId).toBe("default");
    expect(Object.values(snapshot.migrationIntents)).toHaveLength(0);
    expect(successorStarts).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
