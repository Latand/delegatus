// destructive-code: head-only; fixture-owned paths and recording process doubles.
import * as mcpTickFixture from "../monitor/seatTickController.fixture";
import fs from "node:fs";
import path from "node:path";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { bindCodexHostPersistence, codexHostColumns } from "./registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { structuredDeliveryMcpObservation, bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

test.each([false, true])("Codex child environments preserve the production evidence folder (resume=%s)", async resumed => {
  const access = materializeStructuredHostAccess(false, { ...process.env }, null);
  const server = new FakeAppServer("evidence-thread");
  const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
  const options = { cwd: metadataState, env: access.env, ...access.codex, ...access.host,
    eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
  const host = resumed ? await CodexAppServerHost.adopt("evidence-thread", options) : await CodexAppServerHost.start(options);
  try {
    expect(captured.options?.env?.LLV_EVIDENCE_DIR).toBe(access.env.LLV_EVIDENCE_DIR);
    expect(captured.options?.env?.TMPDIR).toBe(access.env.TMPDIR);
  } finally { await host.release(); access.cleanup(); }
});

for (const restored of [false, true]) test.each(["off", "sqlite"] as const)(`Viewer MCP denial reaches claimed persistence, keyed health and tick (%s, restored=${restored})`, async sqliteMode => {
  const { seatMcpHealth } = await import("../monitor/seatMcpHealth");
  const { harness, PROJECT, NOW, OPEN_LANE, runSeatTickCheck } = mcpTickFixture;
  const { flushStructuredHostPersistence } = await import("./registry");
  const threadId = ["00000000", "0000", "4000", "8000", "000000000031"].join("-");
  let server = new FakeAppServer(threadId);
  const store = new MemoryEventStore();
  let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
  const registry = new AgentRegistry(path.join(metadataState, "registry.json"), () => true, undefined, { sqliteMode });
  const artifactPath = `/sessions/${threadId}.jsonl`;
  const conversation = registry.ensureConversation("codex", artifactPath, null);
  expect(conversation.generations.at(-1)?.id).toBe(threadId);
  const key = { engine: "codex" as const, sessionId: threadId };
  registry.upsert({ key, artifactPath, cwd: "/repo", accountId: null, status: "idle", host: null,
    claimEpoch: 7, claimOwner: "mcp-health-writer", pendingAction: null, structuredHost: codexHostColumns(await host.health(), 7) });
  let stop = await bindCodexHostPersistence(registry, key, host, "mcp-health-writer", 7);
  const receipt = { spawnCapabilityDigest: "a".repeat(64), createdAt: new Date(NOW - 1800000).toISOString() };
  const filename = path.join(metadataState, "mcp-runtime", "sessions", `${receipt.spawnCapabilityDigest}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ checkedAt: new Date(NOW).toISOString(), ready: true, failedCalls: 0 }));
  const journal = new RuntimeJournal(path.join(metadataState, "mcp-journal.sqlite"), { structuredHosts: true });
  const client = {
    append: async (event: Parameters<RuntimeJournal["append"]>[0]) => journal.append(event),
    producerCursor: async () => 0,
    snapshot: async () => journal.snapshot(),
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client,
    watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
  const observe = () => structuredDeliveryMcpObservation(conversation.id, registry);
  const call = (phase: "started" | "completed", id: string, tool: string, fields: Record<string, unknown> = {}, incomingThread = threadId) => {
    server.notify(`item/${phase}`, { threadId: incomingThread, turnId: "mcp-turn", item: { type: "mcpToolCall", id, server: "viewer", tool, ...fields } });
  };
  const deny = (id: string, tool: string) => call("completed", id, tool, { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } });
  const success = (id: string, tool: string) => call("completed", id, tool, { status: "completed", result: { content: [], structuredContent: { ok: true } } });
  const flush = () => flushStructuredHostPersistence(host);
  try {
    expect(seatMcpHealth(receipt, null, metadataState, NOW).status).toBe("healthy");
    deny("denied-a", "get_task"); await flush();
    expect(observe()?.denied).toEqual([{ tool: "get_task", seq: expect.any(Number) }]);
    expect((await host.health()).status).toBe("idle");
    for (const transport of ["stdio", "http"] as const) {
      expect(seatMcpHealth(receipt, null, metadataState, NOW, transport, observe()).status).toBe("dead");
      const rig = harness({ pipelines: OPEN_LANE, seat: { conversationId: conversation.id, seatEpoch: 1, path: artifactPath } });
      const receiptRead = spyOn(registry, "seatMcpReceipt").mockReturnValue({ ...receipt, viewerMcpTransport: transport });
      rig.deps.sources!.registry = () => registry;
      const result = await runSeatTickCheck(PROJECT, rig.deps);
      receiptRead.mockRestore();
      expect(result?.delivery?.outcome).toBe("seat-mcp-unavailable");
      expect(rig.sent).toHaveLength(0);
      expect(rig.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "open" && card.detail.includes("engine approval denied: get_task"))).toBe(true);
    }
    call("started", "old", "get_task");
    deny("denied-again", "get_task");
    success("old", "get_task");
    call("started", "other", "get_pipeline"); success("other", "get_pipeline");
    success("no-start", "get_task");
    call("started", "business", "get_task");
    call("completed", "business", "get_task", { status: "completed", result: { content: [], structuredContent: { ok: false, code: "forbidden", retryable: false } } });
    call("completed", "unknown", "get_task", { status: "failed", error: { message: "synthetic-private-sentinel" } });
    call("completed", "malformed", "get_task", { status: "failed", error: [] });
    await flush(); expect(observe()?.denied).toHaveLength(1);
    deny("denied-b", "get_pipeline");
    call("started", "recovered-a", "get_task"); success("recovered-a", "get_task");
    await flush(); expect(observe()?.denied.map(item => item.tool)).toEqual(["get_pipeline"]);
    call("started", "recovered-b", "get_pipeline"); success("recovered-b", "get_pipeline");
    await flush(); expect(observe()?.denied).toEqual([]);
    expect(seatMcpHealth(receipt, null, metadataState, NOW, "stdio", observe()).status).toBe("healthy");
    expect(JSON.stringify(observe())).not.toContain("synthetic-private-sentinel");
    const failedWrite = spyOn(registry, "setStructuredHostClaimed").mockImplementation(() => { throw new Error("synthetic checkpoint unavailable"); });
    try {
      deny("failed-checkpoint", "get_task");
      await expect(flush()).rejects.toThrow("synthetic checkpoint unavailable");
      expect(registry.seatTickConversation(conversation.id)?.viewerMcp?.denied).toEqual([]);
      for (const transport of ["stdio", "http"] as const) {
        expect(seatMcpHealth(receipt, null, metadataState, NOW, transport, observe()).status).toBe("dead");
        const rig = harness({ pipelines: OPEN_LANE, seat: { conversationId: conversation.id, seatEpoch: 1, path: artifactPath } });
        const receiptRead = spyOn(registry, "seatMcpReceipt").mockReturnValue({ ...receipt, viewerMcpTransport: transport });
        rig.deps.sources!.registry = () => registry;
        try {
          await runSeatTickCheck(PROJECT, rig.deps);
          expect(rig.sent).toHaveLength(0);
          expect(rig.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "open"
            && card.detail.includes("engine approval denied: get_task"))).toBe(true);
        } finally { receiptRead.mockRestore(); }
      }
      call("started", "post-fault-recovery", "get_task"); success("post-fault-recovery", "get_task");
      expect(observe()?.denied).toEqual([]);
    } finally { failedWrite.mockRestore(); await flush(); }
    call("completed", "foreign", "get_task", { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } }, "other-thread");
    await flush(); expect(observe()?.denied).toEqual([]);
    deny("replay-first-denial", "get_task");
    call("started", "completed-recovery", "get_task"); success("completed-recovery", "get_task");
    await flush(); expect(observe()?.denied).toEqual([]);
    deny("replay-later-denial", "get_task"); await flush();
    const laterDenial = observe();
    if (restored) {
      await bindStructuredDeliveryQueue([], { client: null });
      await stop(); await host.release();
      server = new FakeAppServer(threadId);
      host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${threadId}`]!, claimOwner: "mcp-health-successor", claimEpoch: 8,
        structuredHost: codexHostColumns(await host.health(), 8) });
      stop = await bindCodexHostPersistence(registry, key, host, "mcp-health-successor", 8);
      await bindStructuredDeliveryQueue([{ key, host }], { registry, client,
        watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    }
    call("started", "completed-recovery", "get_task"); success("completed-recovery", "get_task");
    await flush();
    for (const recovered of [false, true]) {
      if (recovered) {
        call("started", "new-recovery", "get_task"); success("new-recovery", "get_task");
        await flush();
      } else expect(observe()).toEqual(laterDenial);
      const rig = harness({ pipelines: OPEN_LANE, seat: { conversationId: conversation.id, seatEpoch: 1, path: artifactPath } });
      const receiptRead = spyOn(registry, "seatMcpReceipt").mockReturnValue({ ...receipt, viewerMcpTransport: "stdio" });
      rig.deps.sources!.registry = () => registry;
      try {
        const result = await runSeatTickCheck(PROJECT, rig.deps);
        expect(rig.sent).toHaveLength(recovered ? 1 : 0);
        expect(result?.delivery?.outcome).toBe(recovered ? "delivered" : "seat-mcp-unavailable");
      } finally { receiptRead.mockRestore(); }
    }
  } finally { await bindStructuredDeliveryQueue([], { client: null }); await stop(); await host.release(); journal.close(); registry.close(); }
});

test("Viewer MCP denial restoration retains bounds and requires a fresh recovery start", async () => {
  const threadId = "mcp-restart-thread", store = new MemoryEventStore();
  let server = new FakeAppServer(threadId);
  let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
  const notify = (phase: string, id: string, tool: string, fields: Record<string, unknown> = {}) => server.notify(`item/${phase}`, { threadId, turnId: "turn-restart", item: { type: "mcpToolCall", server: "viewer", id, tool, ...fields } });
  const denied = { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } };
  const success = { status: "completed", result: { content: [], structuredContent: { ok: true } } };
  try {
    notify("completed", "first", "get_task", denied);
    notify("started", "old-start", "get_task");
    expect((await host.health()).viewerMcp?.denied).toHaveLength(1);
    await host.release();
    server = new FakeAppServer(threadId);
    host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    notify("completed", "old-start", "get_task", success);
    expect((await host.health()).viewerMcp?.denied).toHaveLength(1);
    notify("started", "fresh", "get_task"); notify("completed", "fresh", "get_task", success);
    expect((await host.health()).viewerMcp?.denied).toEqual([]);
    for (let index = 0; index < 32; index++) notify("completed", `denied-${index}`, index === 0 ? "x".repeat(128) : `tool_${index}`, denied);
    expect((await host.health()).viewerMcp).toMatchObject({ unverified: false, denied: expect.any(Array) });
    expect((await host.health()).viewerMcp?.denied).toHaveLength(32);
    notify("completed", "overflow", "x".repeat(129), denied);
    expect((await host.health()).viewerMcp).toMatchObject({ unverified: true });
    expect((await host.health()).viewerMcp?.denied).toHaveLength(32);
    await host.release();
    server = new FakeAppServer(threadId);
    host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    expect((await host.health()).viewerMcp?.unverified).toBe(true);
  } finally { await host.release(); }
});

test("MCP service controls preserve denial layers and same-key effects", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("../mcp/server");
  let effects = 0, allowed = false;
  const bindings = Object.fromEntries<import("../mcp/server").McpToolBinding>(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as import("../mcp/server").McpToolBindings;
  bindings.update_task = async () => { effects++; return { updated: true }; };
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), {
    permit: () => allowed ? { allowed: true } : { allowed: false, code: "tool_not_permitted", error: "Synthetic project fence" },
  });
  const args = { clientRequestId: "same-key-control", taskId: "synthetic-task", text: "Synthetic update" };
  const denied = await service.callTool("update_task", args);
  expect(denied).toMatchObject({ ok: false, code: "tool_not_permitted", retryable: false });
  expect(effects).toBe(0);
  allowed = true;
  const success = await service.callTool("update_task", args);
  const replay = await service.callTool("update_task", args);
  expect(success.ok).toBe(true); expect(replay.replayed).toBe(true); expect(effects).toBe(1);
  const threadId = "service-control", server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  const send = (phase: string, id: string, fields: Record<string, unknown>) => server.notify(`item/${phase}`, {
    threadId, turnId: "control-turn", item: { type: "mcpToolCall", server: "viewer", tool: "update_task", id, ...fields },
  });
  try {
    send("completed", "engine-denied", { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } });
    for (const [i, result] of [denied, success, replay].entries()) {
      send("started", `control-${i}`, {});
      send("completed", `control-${i}`, { status: "completed", result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      expect((await host.health()).viewerMcp?.denied.length).toBe(i === 0 ? 1 : 0);
    }
    expect(effects).toBe(1);
  } finally { await host.release(); }
});

const mcpRestartCases = [1, 33, "pending-denial", "starts-32", "starts-33", "healthy-32", "healthy-33"] as const;

const mcpRestartDeliveries = [
  ...mcpRestartCases.map(scenario => ({ scenario, delivery: undefined as string | undefined, label: String(scenario) })),
  ...["buffered", "live"].flatMap(delivery => [1, "starts-33"].map(scenario => ({ scenario, delivery, label: `${scenario}, ${delivery}` }))),
];

test.each(mcpRestartDeliveries)("a fresh process retains MCP correlation ($label)", async ({ scenario, delivery }) => {
  const fixture = path.join(import.meta.dir, "fixtures/codexCallbackProcess.ts");
  const directory = path.join(metadataState, "mcp-process-events");
  const first = spawn(process.execPath, [fixture, "mcp-produce", directory, path.join(metadataState, "unused.jsonl"), String(scenario), ...(delivery ? [delivery] : [])],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let firstOutput = "", firstErrors = "";
  first.stderr!.on("data", data => { firstErrors += String(data); });
  const closed = new Promise<void>(resolve => first.once("close", () => resolve()));
  try {
    const ready = await new Promise<{ observation: unknown }>((resolve, reject) => {
      first.once("error", reject);
      first.once("close", () => reject(new Error(firstErrors || "MCP producer exited before readiness")));
      first.stdout!.on("data", data => {
        firstOutput += String(data);
        if (firstOutput.includes("\n")) resolve(JSON.parse(firstOutput.split("\n")[0]!));
      });
    });
    if (typeof scenario === "number") expect(ready.observation).toMatchObject({ denied: [{ tool: "get_task", seq: expect.any(Number) }], unverified: scenario > 32 });
    else if (scenario.startsWith("healthy-")) expect(ready.observation).toMatchObject({ denied: [], unverified: false });
    else expect(ready.observation).toBeUndefined();
    first.kill("SIGKILL");
    await closed;
    const resumed = Bun.spawn([process.execPath, fixture, "mcp-resume", directory, path.join(metadataState, "unused.jsonl"), String(scenario), ...(delivery ? [delivery] : [])],
      { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(resumed.stdout).text(), new Response(resumed.stderr).text(), resumed.exited]);
    expect({ exit, errors }).toMatchObject({ exit: 0 });
    expect(JSON.parse(output).observation).toMatchObject({
      denied: scenario === "starts-32" || (typeof scenario === "string" && scenario.startsWith("healthy-")) ? [] : [{ tool: "get_task", seq: expect.any(Number) }],
      unverified: scenario === "starts-33" || scenario === 33,
    });
    expect(JSON.parse(output).activeTurnRef).toBe("mcp-turn");
    const events = new FileRuntimeEventStore(directory).load("callback-process-thread");
    expect(events.filter(event => event.kind === "turn-started").map(event => event.turnId)).toEqual(["mcp-turn"]);
    expect(events.filter(event => event.kind === "turn-ended")).toEqual([]);
    const target = scenario.toString().startsWith("starts-") ? "fresh-recovery" : "before-restart";
    expect(events.filter(event => event.kind === "item" && event.phase === "completed"
      && (event.item as { id?: string }).id === target)).toMatchObject([{
        turnId: "mcp-turn", codexItemIdentity: { threadId: "callback-process-thread", turnId: "mcp-turn" },
      }]);
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    await closed;
  }
}, 30_000);

for (const scenario of ["tool-128", "tool-129", "denials-33", "starts-33", "large-result"] as const)
  test(`Viewer MCP observation stays bounded for ${scenario}`, async () => {
    const threadId = "mcp-bounds", server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    const notify = (phase: string, id: string, tool: string, fields: Record<string, unknown>) => server.notify(`item/${phase}`, {
      threadId, turnId: "bounds-turn", item: { type: "mcpToolCall", server: "viewer", id, tool, ...fields },
    });
    const denied = { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } };
    try {
      if (scenario.startsWith("tool-")) notify("completed", "denied", "x".repeat(scenario === "tool-128" ? 128 : 129), denied);
      else {
        notify("completed", "denied", "get_task", denied);
        if (scenario === "denials-33") for (let index = 1; index <= 32; index++) notify("completed", `denied-${index}`, `tool_${index}`, denied);
        if (scenario === "starts-33") for (let index = 0; index < 33; index++) notify("started", `start-${index}`, "get_task", {});
        if (scenario === "large-result") {
          notify("started", "large", "get_pipeline", {});
          notify("completed", "large", "get_pipeline", { status: "completed", result: {
            structuredContent: { ok: true }, content: [{ type: "text", text: "界".repeat(100_000) }],
          } });
        }
      }
      const observation = host.readViewerMcpObservation()!;
      expect(observation.unverified).toBe(["tool-129", "denials-33", "starts-33"].includes(scenario));
      expect(observation.denied.length).toBeLessThanOrEqual(32);
      expect(JSON.stringify(observation).length).toBeLessThan(6000);
      expect(JSON.stringify(observation)).not.toContain("界");
      observation.denied.length = 0;
      if (scenario !== "tool-129") expect(host.readViewerMcpObservation()!.denied.length).toBeGreaterThan(0);
    } finally { await host.release(); }
  });

for (const terminalCount of [1, 30, 32, 33]) for (const restore of [false, true])
  test(`Viewer MCP terminal replay stays fenced at ${terminalCount} identities (restore=${restore})`, async () => {
    const threadId = "mcp-terminal-replay", store = new MemoryEventStore();
    let server = new FakeAppServer(threadId);
    let host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
    const notify = (phase: string, id: string, fields: Record<string, unknown> = {}) => server.notify(`item/${phase}`, {
      threadId, turnId: "terminal-turn", item: { type: "mcpToolCall", server: "viewer", tool: "get_task", id, ...fields },
    });
    const success = { status: "completed", result: { content: [], structuredContent: { ok: true } } };
    const denial = { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } };
    try {
      // Completed calls must be remembered even before the first denial.
      for (let index = 0; index < terminalCount; index++) {
        notify("started", `terminal-${index}`); notify("completed", `terminal-${index}`, success);
      }
      if (restore) {
        await host.release();
        server = new FakeAppServer(threadId);
        host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
      }
      notify("completed", "denial", denial);
      const denied = host.readViewerMcpObservation()!.denied;
      notify("started", "terminal-0"); notify("completed", "terminal-0", success);
      expect(host.readViewerMcpObservation()!.denied).toEqual(denied);
      notify("started", "new-call"); notify("completed", "new-call", success);
      if (terminalCount <= 30) expect(host.readViewerMcpObservation()).toMatchObject({ denied: [], unverified: false });
      else expect(host.readViewerMcpObservation()).toMatchObject({ denied, unverified: true });
    } finally { await host.release(); }
  });

test("Viewer MCP recovery stays unverified when restoration has lost event history", async () => {
  const threadId = "mcp-history-gap", store = new MemoryEventStore();
  let server = new FakeAppServer(threadId);
  let host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
  const notify = (phase: string, id: string, fields: Record<string, unknown> = {}) => server.notify(`item/${phase}`, {
    threadId, turnId: "gap-turn", item: { type: "mcpToolCall", server: "viewer", tool: "get_task", id, ...fields },
  });
  try {
    notify("completed", "denied", { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } });
    await host.release();
    const retained = store.load(threadId).filter(event => event.kind === "item");
    expect(retained[0]!.seq).toBeGreaterThan(1);
    server = new FakeAppServer(threadId);
    host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState,
      eventStore: { load: () => retained, append: (id, event) => store.append(id, event) }, spawnProcess: fakeSpawn(server) });
    notify("started", "fresh");
    notify("completed", "fresh", { status: "completed", result: { content: [], structuredContent: { ok: true } } });
    expect(host.readViewerMcpObservation()).toMatchObject({ denied: [{ tool: "get_task", seq: expect.any(Number) }], unverified: true });
  } finally { await host.release(); }
});

for (const scenario of ["pending-denial", "replayed-start", "restored-replayed-start",
  "healthy-32", "healthy-33", "healthy-34", "restored-healthy-32", "restored-healthy-33"] as const)
  test.each(["off", "sqlite"] as const)(`Viewer MCP first-start correlation survives ${scenario} (%s)`, async sqliteMode => {
    const { seatMcpHealth } = await import("../monitor/seatMcpHealth");
    const { harness, PROJECT, NOW, OPEN_LANE, runSeatTickCheck } = mcpTickFixture;
    const { flushStructuredHostPersistence } = await import("./registry");
    const threadId = ["00000000", "0000", "4000", "8000", "000000000071"].join("-");
    const store = new MemoryEventStore();
    let server = new FakeAppServer(threadId);
    let host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
    const registryFile = path.join(metadataState, "first-start-registry.json");
    const registry = new AgentRegistry(registryFile, () => true, undefined, { sqliteMode });
    const artifactPath = `/sessions/${threadId}.jsonl`;
    const conversation = registry.ensureConversation("codex", artifactPath, null);
    const key = { engine: "codex" as const, sessionId: threadId };
    registry.upsert({ key, artifactPath, cwd: metadataState, accountId: null, status: "idle", host: null,
      claimEpoch: 7, claimOwner: "fixture-writer", pendingAction: null, structuredHost: codexHostColumns(await host.health(), 7) });
    let stop = await bindCodexHostPersistence(registry, key, host, "fixture-writer", 7);
    const journal = new RuntimeJournal(path.join(metadataState, "first-start-journal.sqlite"), { structuredHosts: true });
    const client = {
      append: async (event: Parameters<RuntimeJournal["append"]>[0]) => journal.append(event),
      producerCursor: async () => 0, snapshot: async () => journal.snapshot(), effectBatch: async () => [],
    } as unknown as RuntimeHostClient;
    const bind = () => bindStructuredDeliveryQueue([{ key, host }], { registry, client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    const notify = (phase: "started" | "completed", id: string, fields: Record<string, unknown> = {}, tool = "get_task") =>
      server.notify(`item/${phase}`, { threadId, turnId: "first-start-turn", item: { id, type: "mcpToolCall", server: "viewer", tool, ...fields } });
    const denial = { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } };
    const success = { status: "completed", result: { content: [], structuredContent: { ok: true } } };
    const observe = () => structuredDeliveryMcpObservation(conversation.id, registry);
    const assertWake = async (recovered: boolean) => {
      const receipt = { spawnCapabilityDigest: "a".repeat(64), createdAt: new Date(NOW - 1800000).toISOString(), viewerMcpTransport: "http" as const };
      expect(seatMcpHealth(receipt, null, metadataState, NOW, "http", observe()).status).toBe(recovered ? "untracked" : "dead");
      const rig = harness({ pipelines: OPEN_LANE, seat: { conversationId: conversation.id, seatEpoch: 1, path: artifactPath } });
      const receiptRead = spyOn(registry, "seatMcpReceipt").mockReturnValue(receipt);
      rig.deps.sources!.registry = () => registry;
      try {
        const result = await runSeatTickCheck(PROJECT, rig.deps);
        expect(rig.sent).toHaveLength(recovered ? 1 : 0);
        expect(result?.delivery?.outcome).toBe(recovered ? "delivered" : "seat-mcp-unavailable");
        expect(rig.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "open")).toBe(!recovered);
      } finally { receiptRead.mockRestore(); }
    };
    try {
      await bind();
      if (scenario.includes("healthy-")) {
        const terminalCount = Number(scenario.split("-").at(-1));
        notify("completed", "initial-denial", denial);
        notify("started", "recovery"); notify("completed", "recovery", success);
        // The denial and recovery already occupy two terminal identities.
        for (let index = 2; index < terminalCount; index++) {
          notify("started", `healthy-${index}`, {}, "get_pipeline");
          notify("completed", `healthy-${index}`, success, "get_pipeline");
        }
        await flushStructuredHostPersistence(host);
        expect(observe()).toMatchObject({ denied: [], unverified: false });
        if (scenario.startsWith("restored-")) {
          await bindStructuredDeliveryQueue([], { client: null });
          await stop(); await host.release();
          server = new FakeAppServer(threadId);
          host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
          registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${threadId}`]!, claimOwner: "fixture-successor", claimEpoch: 8,
            structuredHost: codexHostColumns(await host.health(), 8) });
          stop = await bindCodexHostPersistence(registry, key, host, "fixture-successor", 8);
          await bind();
        }
        // Check both sides of the next completion: the 32-entry case crosses
        // the terminal bound here, while the others have already crossed it.
        notify("started", "continuation", {}, "get_pipeline");
        await flushStructuredHostPersistence(host);
        expect(observe()).toMatchObject({ denied: [], unverified: false });
        notify("completed", "continuation", success, "get_pipeline");
        await flushStructuredHostPersistence(host);
        expect(observe()).toMatchObject({ denied: [], unverified: false });
        const reopened = new AgentRegistry(registryFile, () => true, undefined, { sqliteMode });
        try { expect(reopened.seatTickConversation(conversation.id)?.viewerMcp).toEqual(observe()); }
        finally { reopened.close(); }
        await assertWake(true);
        // Healthy continuation must retain the history-loss fence for a later
        // denial, including a replay of the evicted recovery identity.
        notify("completed", "new-denial", denial);
        notify("started", "recovery"); notify("completed", "recovery", success);
        notify("started", "new-recovery"); notify("completed", "new-recovery", success);
        await flushStructuredHostPersistence(host);
        expect(observe()).toMatchObject({ denied: [{ tool: "get_task", seq: expect.any(Number) }], unverified: true });
        await assertWake(false);
        return;
      }
      notify("started", "pending");
      if (scenario !== "pending-denial") notify("completed", "later-denial", denial);
      await flushStructuredHostPersistence(host);
      if (scenario !== "replayed-start") {
        await bindStructuredDeliveryQueue([], { client: null });
        await stop(); await host.release();
        server = new FakeAppServer(threadId);
        host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
        registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${threadId}`]!, claimOwner: "fixture-successor", claimEpoch: 8,
          structuredHost: codexHostColumns(await host.health(), 8) });
        stop = await bindCodexHostPersistence(registry, key, host, "fixture-successor", 8);
        await bind();
      }
      if (scenario === "pending-denial") notify("completed", "pending", denial);
      else { notify("started", "pending"); notify("completed", "pending", success); }
      await flushStructuredHostPersistence(host);
      expect(observe()).toMatchObject({ denied: [{ tool: "get_task", seq: expect.any(Number) }], unverified: false });
      const reopened = new AgentRegistry(registryFile, () => true, undefined, { sqliteMode });
      try { expect(reopened.seatTickConversation(conversation.id)?.viewerMcp).toEqual(observe()); }
      finally { reopened.close(); }
      await assertWake(false);
      notify("completed", "other-denial", denial, "get_pipeline");
      notify("started", "fresh"); notify("completed", "fresh", success);
      await flushStructuredHostPersistence(host);
      expect(observe()?.denied.map(entry => entry.tool)).toEqual(["get_pipeline"]);
      await assertWake(false);
      notify("started", "fresh-other", {}, "get_pipeline"); notify("completed", "fresh-other", success, "get_pipeline");
      await flushStructuredHostPersistence(host);
      expect(observe()).toMatchObject({ denied: [], unverified: false });
      await assertWake(true);
    } finally { await bindStructuredDeliveryQueue([], { client: null }); await stop(); await host.release(); journal.close(); registry.close(); }
  });
