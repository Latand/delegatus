import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, agentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { reconcileMigrationInventory } from "./coordinator";
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
      /* Historical residue was held while the switch waited. A send made after it parked is assigned to the
         current generation and is delivered by the tick (#1709), so it is not residue. */
      registry.holdDelivery(row.id, "preserve this held message", `held-${row.id}`, "text", [], null);
      registry.transitionConversationMigration(row.id, requested.migration!.revision, [requested.migration!.phase], { phase: "failed-recoverable", error: "old failure" });
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
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries).map((item) => item.state)).toEqual(Array(13).fill("held"));
  } finally { registry.close(); }
});

test("controller migration cycle reconciles and ticks all durable quota policy guards", async () => {
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

  expect(ticks.sort()).toEqual(["claude", "codex", "copilot"]);
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


test("inventory reconciles only file deltas and retries a failed delta before acknowledging it", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "delta-inventory.json"));
  const file = (name: string, size = 1) => ({ path: `/delta/${name}.jsonl`, engine: "codex", size, mtime: 1,
    activity: "idle", title: name, parent: null }) as never;
  let files = [file("one"), file("two")];
  const batches: string[][] = [];
  let fail = false;
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: async (current, changed) => {
      batches.push(changed.map(entry => entry.path));
      if (fail) throw new Error("retry delta");
      return current.readOnlySnapshot();
    },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {},
    reconcileHandoffOwnership: async () => {}, reconcileFiles: async () => {},
    reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll(); await controller.poll();
    expect(batches).toEqual([["/delta/one.jsonl", "/delta/two.jsonl"]]);
    files = [file("one", 2), file("two")]; fail = true;
    await expect(controller.poll()).rejects.toThrow("retry delta");
    fail = false; await controller.poll(); await controller.poll();
    expect(batches.slice(1)).toEqual([["/delta/one.jsonl"], ["/delta/one.jsonl"]]);
    files = [file("two")]; await controller.poll();
    files = [file("one", 2), file("two")]; await controller.poll();
    expect(batches.at(-1)).toEqual(["/delta/one.jsonl"]);
    // A new process has no acknowledged inventory: its first pass replays it.
    const restarted = new AccountMigrationController(registry, { tick: async () => {} }, null, {
      scan: async () => ({ files, projectCatalog: [], complete: true }),
      reconcileInventory: async (current, changed) => { batches.push(changed.map(entry => entry.path)); return current.readOnlySnapshot(); },
      reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
      reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
      reconcileMigrationCycle: async () => {},
    });
    await restarted.poll();
    expect(batches.at(-1)).toEqual(["/delta/one.jsonl", "/delta/two.jsonl"]);
  } finally { registry.close(); }
});

test("incomplete transcript observations remain on the bounded retry cursor", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "pending-transcript-inventory.json"));
  const pathname = "/delta/pending.jsonl";
  const file = { path: pathname, engine: "codex", size: 1, mtime: 1, parent: null } as never;
  const batches: string[][] = [];
  let complete = false;
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [file], projectCatalog: [], complete: true }),
    reconcileInventory: async (_current, changed, reportRead) => {
      batches.push(changed.map(entry => entry.path));
      for (const entry of changed) reportRead?.(entry.path, complete);
      return registry.readOnlySnapshot();
    },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    expect(batches).toEqual([[pathname]]);
    await controller.poll();
    expect(batches).toHaveLength(2);
    complete = true;
    await controller.poll();
    await controller.poll();
    expect(batches).toEqual([[pathname], [pathname], [pathname]]);
  } finally { registry.close(); }
});

test("a persistent incomplete read does not starve later registry contexts", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "fair-context-cursor.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const paths = Array.from({ length: 64 }, (_, index) => `/fair/${String(index).padStart(3, "0")}.jsonl`);
  const files = paths.map(pathname => ({ path: pathname, engine: "codex", size: 1, mtime: 1, parent: null }) as never);
  const batches: string[][] = [];
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: async (_current, changed, reportRead) => {
      const visited = changed.map(file => file.path);
      batches.push(visited);
      for (const pathname of visited) reportRead?.(pathname, pathname !== paths[0]);
      return registry.readOnlySnapshot();
    },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    await controller.poll();
    registry.reconcileConversations([{ engine: "codex", path: paths[63]!, accountId: null, launchProfile: emptyLaunchProfile(),
      turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-10-16T00:01:00Z" }], { snapshot: false });
    for (let pass = 0; pass < 8; pass++) await controller.poll();
    expect(batches.slice(1).every(batch => batch.length <= 32)).toBe(true);
    expect(batches.slice(1).some(batch => batch.includes(paths[63]!))).toBe(true);
  } finally { registry.close(); }
});

test("more than 32 persistent incomplete reads all receive fair retries", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "fair-pending-cursor.json"));
  const paths = Array.from({ length: 70 }, (_, index) => `/pending/${String(index).padStart(3, "0")}.jsonl`);
  const files = paths.map(pathname => ({ path: pathname, engine: "codex", size: 1, mtime: 1, parent: null }) as never);
  const retryCounts = new Map(paths.map(pathname => [pathname, 0]));
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: async (_current, changed, reportRead) => {
      for (const file of changed) {
        retryCounts.set(file.path, retryCounts.get(file.path)! + 1);
        reportRead?.(file.path, false);
      }
      return registry.readOnlySnapshot();
    },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    await controller.poll(); await controller.poll(); await controller.poll();
    expect([...retryCounts.values()].every(count => count >= 2)).toBe(true);
  } finally { registry.close(); }
});

test("an acknowledged provider fork is reconsidered when its source thread appears", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "late-fork-source-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const root = path.join(stateDir, "late-fork-source");
  fs.mkdirSync(root, { recursive: true });
  const sourceThreadId = "019f9557-0000-0700-0000-00000000aaaa";
  const forkThreadId = "019f9557-0000-0700-0000-00000000bbbb";
  const sourcePath = path.join(root, `rollout-${sourceThreadId}.jsonl`);
  const forkPath = path.join(root, `rollout-${forkThreadId}.jsonl`);
  const sessionMeta = (id: string, forkedFromId?: string) => JSON.stringify({ type: "session_meta", payload: {
    id, cwd: "/repo", ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
  } }) + "\n";
  fs.writeFileSync(forkPath, sessionMeta(forkThreadId, sourceThreadId));
  const described = (pathname: string, nativeForkSourceThreadId: string | null) => {
    const stat = fs.statSync(pathname);
    return { path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "repo", title: path.basename(pathname),
      engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: stat.mtimeMs / 1000, size: stat.size,
      activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
      nativeForkSourceThreadId } as never;
  };
  let files = [described(forkPath, sourceThreadId)];
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: (current, changed, onTranscriptRead) => reconcileMigrationInventory(current, changed, {
      readOnlySnapshot: true, incrementalInventory: true, onTranscriptRead,
    }),
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll(); await controller.poll();
    expect(Object.values(registry.readOnlySnapshot().conversations)).toHaveLength(1);
    const forkContents = fs.readFileSync(forkPath, "utf8");
    fs.writeFileSync(sourcePath, sessionMeta(sourceThreadId));
    files = [described(forkPath, sourceThreadId), described(sourcePath, null)];
    await controller.poll();
    await controller.poll();
    const conversations = Object.values(registry.readOnlySnapshot().conversations);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.providerForkPaths).toContain(forkPath);
    expect(registry.conversationForPath(forkPath)?.id).toBe(registry.conversationForPath(sourcePath)?.id);
    expect(fs.readFileSync(forkPath, "utf8")).toBe(forkContents);
  } finally { registry.close(); }
});

test("a transient transcript EIO retries through the controller without a file change", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "controller-transcript-eio.json"));
  const pathname = path.join(stateDir, "controller-transcript-eio.jsonl");
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/controller-eio" } }),
    "x".repeat(150_000),
    JSON.stringify({ type: "event_msg", timestamp: "2026-10-16T00:00:00.000Z", payload: { type: "task_complete" } }),
    "",
  ].join("\n"));
  const stat = fs.statSync(pathname);
  const file = { path: pathname, engine: "codex", parent: null, size: stat.size, mtime: stat.mtimeMs / 1000,
    activity: "recent", title: "Controller EIO" } as never;
  registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
    turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-10-15T00:00:00.000Z" }], { snapshot: false });
  const originalOpenSync = fs.openSync;
  let opens = 0;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (path.resolve(String(target)) === pathname) {
      opens++;
      if (opens === 1) {
        const error = new Error("temporary transcript EIO") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
    }
    return Reflect.apply(originalOpenSync, fs, [target, ...args]);
  }) as typeof fs.openSync;
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [file], projectCatalog: [], complete: true }),
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    expect(registry.conversationForPath(pathname)?.turn.state).toBe("busy");
    fs.openSync = originalOpenSync;
    await controller.poll();
    expect(registry.conversationForPath(pathname)?.turn.state).toBe("terminal");
    await controller.poll();
    expect(opens).toBe(2);
  } finally { fs.openSync = originalOpenSync; registry.close(); }
});

test("a concurrent inventory write remains unacknowledged until the next pass", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "inventory-cas-conflict.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const pathname = "/delta/cas.jsonl";
  const file = { path: pathname, engine: "codex", size: 1, mtime: 1, parent: null } as never;
  const batches: string[][] = [];
  let compete = true;
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [file], projectCatalog: [], complete: true }),
    reconcileInventory: async (_current, changed, reportRead) => {
      batches.push(changed.map(entry => entry.path));
      for (const entry of changed) reportRead?.(entry.path, true);
      if (compete) {
        compete = false;
        registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
          turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-10-16T00:01:00Z" }], { snapshot: false });
      }
      return registry.activityConversationSnapshot(pathname);
    },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    await controller.poll();
    expect(batches).toEqual([[pathname], [pathname]]);
    await controller.poll();
    expect(batches).toHaveLength(2);
  } finally { registry.close(); }
});

test("late parent admission invalidates a child's inventory dependency", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "late-parent-inventory.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const parentPath = path.join(stateDir, "codex-parent.jsonl");
  const childPath = path.join(stateDir, "codex-parent-subagents-child.jsonl");
  fs.writeFileSync(parentPath, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/parent" } }) + "\n");
  fs.writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/parent" } }) + "\n");
  const stat = fs.statSync(childPath);
  const child = { path: childPath, engine: "codex", size: stat.size, mtime: stat.mtimeMs / 1000, parent: parentPath,
    activity: "idle", title: "Child" } as never;
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [child], projectCatalog: [], complete: true }),
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    const childConversation = registry.conversationForPath(childPath)!;
    expect(childConversation.generations.at(-1)?.launchProfile.parentConversationId).toBeNull();
    registry.reconcileConversations([{ engine: "codex", path: parentPath, accountId: null, launchProfile: emptyLaunchProfile(),
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-10-16T00:00:00Z" }], { snapshot: false });
    await controller.poll();
    const parentConversation = registry.conversationForPath(parentPath)!;
    expect(registry.conversationForPath(childPath)?.generations.at(-1)?.launchProfile.parentConversationId).toBe(parentConversation.id);
    expect(registry.readOnlySnapshot().lineageEdges[childConversation.id]?.parentConversationId).toBe(parentConversation.id);
  } finally { registry.close(); }
});


test("an idle migration tick does not sweep all delivery history", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "no-idle-compaction.json"));
  const sweep = spyOn(registry, "compactDeliveryReservations");
  const boardPlacement = spyOn(registry, "markMigrationBoardPlacementProjects");
  const board = spyOn(registry, "markMigrationBoardProjects");
  try {
    await reconcileAccountMigrationCycle(registry, { tick: async () => {} });
    expect(boardPlacement).not.toHaveBeenCalled();
    expect(board).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  } finally { sweep.mockRestore(); boardPlacement.mockRestore(); board.mockRestore(); registry.close(); }
});


test("registry-only custody changes are found by the bounded inventory cursor", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "cursor-inventory.json"), undefined, undefined, { sqliteMode: "sqlite" });
  let files = Array.from({ length: 70 }, (_, index) => ({ path: `/cursor/${index}.jsonl`, engine: "codex", size: 1, mtime: 1 }) as never);
  const batches: string[][] = [];
  const contexts = spyOn(registry, "activityConversationSnapshot");
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: async (current, changed) => { batches.push(changed.map(file => file.path)); return current.activityConversationSnapshot(""); },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  try {
    await controller.poll();
    contexts.mockClear();
    await controller.poll();
    expect(contexts).toHaveBeenCalledTimes(32);
    expect(batches).toHaveLength(1);
    registry.reconcileConversations([{ engine: "codex", path: "/cursor/69.jsonl", accountId: null, launchProfile: emptyLaunchProfile(),
      turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-10-16T00:00:00Z" }], { snapshot: false });
    // Scanner activity ordering changes between polls. Move the changed path
    // just outside the next positional batch on each pass.
    for (let pass = 0; pass < 3; pass++) {
      const target = files.find(file => (file as { path: string }).path === "/cursor/69.jsonl")!;
      const others = files.filter(file => file !== target);
      const position = (64 + pass * 32 + 33) % files.length;
      files = [...others.slice(0, position), target, ...others.slice(position)];
      await controller.poll();
    }
    expect(batches.at(-1)).toEqual(["/cursor/69.jsonl"]);
    registry.setEngineRouting("codex", "account-a");
    await controller.poll();
    expect(batches.at(-1)).toHaveLength(70);
  } finally { contexts.mockRestore(); registry.close(); }
});


test("a registry change after inventory awaits stays visible to the next cursor pass", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "cursor-await-race.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const pathname = "/cursor/await.jsonl";
  registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-10-16T00:00:00Z" }], { snapshot: false });
  let size = 1;
  let inject = false;
  const batches: number[] = [];
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [{ path: pathname, engine: "codex", mtime: 1, size } as never], projectCatalog: [], complete: true }),
    reconcileInventory: async (current, changed) => { batches.push(changed[0]!.size); return current.activityConversationSnapshot(pathname); },
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {}, reconcileMigrationCycle: async () => {},
    reconcileRuntime: async () => {
      if (!inject) return;
      inject = false;
      registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
        turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-10-16T00:01:00Z" }], { snapshot: false });
    },
  });
  try {
    await controller.poll();
    size = 2; inject = true; await controller.poll();
    await controller.poll();
    expect(batches).toEqual([1, 2, 2]);
  } finally { registry.close(); }
});


test("the inventory sidecar prepares its shared read view before it starts polling", async () => {
  const original = agentRegistry();
  const registry = new AgentRegistry(path.join(stateDir, "prepared-sidecar.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ["__llvAccountMigrationController", "__llvAccountMigrationStopPolling"];
  const saved = new Map(keys.map(key => [key, globals[key]]));
  const worker = process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER;
  const prepare = spyOn(registry, "prepareReadOnlySnapshot");
  try {
    setAgentRegistryForTests(registry);
    globals.__llvAccountMigrationController = { poll: async () => {} };
    delete globals.__llvAccountMigrationStopPolling;
    process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER = "1";
    await startAccountMigrationController();
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    (globals.__llvAccountMigrationStopPolling as (() => void) | undefined)?.();
    for (const [key, value] of saved) { if (value === undefined) delete globals[key]; else globals[key] = value; }
    if (worker === undefined) delete process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER;
    else process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER = worker;
    prepare.mockRestore(); setAgentRegistryForTests(original); registry.close();
  }
});
