// destructive-code: head-only; fixture-owned paths and recording process doubles.
import { TurnSilence, TURN_SILENCE_MS } from "./turnSilence";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { HostState, RuntimeEvent } from "./engineHost";
import { appendRuntimeLiveTurnDelta, runtimeLiveTurnItems, type RuntimeLiveTurn } from "./liveTurn";
import { bindCodexHostPersistence } from "./registry";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();
afterEach(() => setSystemTime());

describe("CodexAppServerHost", () => {
  test("closes an unresolved ledger turn when resume reports idle", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("crashed-turn", { kind: "turn-started", turnId: "turn-active", seq: 1 });
    eventStore.append("crashed-turn", { kind: "session-status", status: "active", seq: 2 });
    const server = new FakeAppServer("crashed-turn", "crashed-turn", false, [], { type: "idle" });
    const host = await CodexAppServerHost.adopt("crashed-turn", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(2)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-ended", turnId: "turn-active", status: "error", seq: 3 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 4 });
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    await host.release();
  });

  test("completes partially recorded ledger history from the resume response", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("completed-after-crash", { kind: "turn-started", turnId: "crashed-turn", seq: 1 });
    const persistedItem = { type: "agentMessage", id: "response-item", text: "persisted response" };
    const server = new FakeAppServer("completed-after-crash", "completed-after-crash", false, [{
      id: "crashed-turn",
      status: "completed",
      items: [persistedItem],
    }], { type: "idle" });
    const host = await CodexAppServerHost.adopt("completed-after-crash", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({
      kind: "item",
      turnId: "crashed-turn",
      item: persistedItem,
      phase: "completed",
      seq: 2,
    });
    expect((await replay.next()).value).toEqual({
      kind: "turn-ended",
      turnId: "crashed-turn",
      status: "completed",
      seq: 3,
    });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 4 });
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    await host.release();
  });

  test("adopts a paginated thread that refuses full-history resume (#1332)", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("paginated-resume-thread", { kind: "turn-started", turnId: "crashed-turn", seq: 1 });
    const persistedItem = { type: "agentMessage", id: "response-item", text: "persisted response" };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-paginated-resume-"));
    const rollout = path.join(directory, "paginated-resume-thread.jsonl");
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: { type: "item_completed", turn_id: "crashed-turn", item: persistedItem },
    })}\n${JSON.stringify({
      timestamp: "t2",
      type: "event_msg",
      payload: { type: "turn_completed", turn_id: "crashed-turn" },
    })}\n`);
    const server = new FakeAppServer("paginated-resume-thread", "paginated-resume-thread", false, [], { type: "idle" });
    server.threadPath = rollout;
    server.paginatedResume = true;
    const host = await CodexAppServerHost.adopt("paginated-resume-thread", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({
      kind: "item",
      turnId: "crashed-turn",
      item: persistedItem,
      phase: "completed",
      seq: 2,
    });
    expect((await replay.next()).value).toEqual({
      kind: "turn-ended",
      turnId: "crashed-turn",
      status: "completed",
      seq: 3,
    });
    const resumes = server.requests.filter((request) => request.method === "thread/resume");
    expect(resumes.length).toBe(2);
    expect((resumes[1]!.params as { excludeTurns?: boolean }).excludeTurns).toBeTrue();
    expect(server.requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(1);
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    await host.release();
  });

  test.each(["pending-tool", "completed-during-resume", "silent-history"])("adopted silence uses native tool state and original progress: %s", async mode => {
    const threadId = `silence-adoption-${mode}`, turnId = "active-turn";
    const base = Date.parse("2026-11-01T00:00:00Z");
    let now = base, deadline: (() => Promise<void>) | undefined;
    const prior = new TurnSilence({ engine: "codex", artifactPath: () => null,
      state: () => ({ sessionKey: threadId, activeTurnRef: turnId, status: "active", pendingAttention: [] }) as unknown as HostState,
      current: () => true, expire: () => {}, hold: () => {} }, { now: () => now, schedule: () => () => {} });
    prior.observe({ kind: "turn-started", turnId }); prior.stop();
    const pending = { type: "commandExecution", id: "owned-command", command: "fixture command", status: "inProgress" };
    const item = mode === "silent-history" ? { type: "agentMessage", id: "old-output", text: "earlier answer fragment" } : pending;
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "item", turnId, phase: "completed", item, seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{ id: turnId, status: "inProgress", items: [item] }],
      { type: "active", activeFlags: ["running"] }, mode === "completed-during-resume"
        ? { method: "item/completed", params: { threadId, turnId, item: { ...pending, status: "completed" } } } : null);
    now += 10 * 60_000;
    const host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState, eventStore, initialEventCursor: 2, spawnProcess: fakeSpawn(server),
      turnSilence: { now: () => now, schedule: callback => { deadline = callback; return () => { if (deadline === callback) deadline = undefined; }; } } });
    try {
      expect(deadline).toBeFunction();
      if (mode === "pending-tool") {
        now += 2 * TURN_SILENCE_MS; await deadline!();
        expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: turnId });
        server.notify("item/completed", { threadId, turnId, item: { ...pending, status: "completed" } });
        await waitForCondition(() => eventStore.load(threadId).some(event => event.kind === "item"
          && (event.item as { status?: string }).status === "completed"), "native tool completion");
        now += TURN_SILENCE_MS;
      } else if (mode === "completed-during-resume") {
        await deadline!(); now += TURN_SILENCE_MS;
      } else now = base + TURN_SILENCE_MS + 31_000;
      await deadline!();
      expect(await host.health()).toMatchObject({ status: "dead" });
      expect(eventStore.load(threadId).some(event => event.kind === "item"
        && (event.item as { reason?: string }).reason === "turn-silence-timeout")).toBe(true);
    } finally { await host.release(); }
  });

  test("restores the resumed active turn after a dead ledger", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("active-after-crash", { kind: "turn-started", turnId: "stale-turn", seq: 1 });
    eventStore.append("active-after-crash", { kind: "session-status", status: "dead", seq: 2 });
    const server = new FakeAppServer("active-after-crash", "active-after-crash", false, [{
      id: "resumed-turn",
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] });
    const host = await CodexAppServerHost.adopt("active-after-crash", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(2)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "resumed-turn", seq: 3 });
    expect((await replay.next()).value).toEqual({
      kind: "session-status",
      status: "active",
      activeFlags: ["running"],
      seq: 4,
    });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "resumed-turn" });
    expect(await host.send({ id: "steer-resumed", text: "continue", expectedTurnId: "resumed-turn" }))
      .toEqual({ outcome: "steered", turnId: "resumed-turn" });
    await host.interrupt("resumed-turn");
    expect(server.requests.some((request) => request.method === "turn/start")).toBeFalse();
    expect(server.requests.find((request) => request.method === "turn/steer")?.params)
      .toMatchObject({ expectedTurnId: "resumed-turn" });
    expect(server.requests.find((request) => request.method === "turn/interrupt")?.params)
      .toMatchObject({ turnId: "resumed-turn" });
    await host.release();
  });

  test("retains unowned ledger attention during adoption and preserves resumed active flags", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("crashed-attention", {
      kind: "attention",
      id: "item/commandExecution/requestApproval:approval-crash",
      method: "item/commandExecution/requestApproval",
      attention: { command: "date" },
      seq: 1,
    });
    const server = new FakeAppServer("crashed-attention", "crashed-attention", false, [{
      id: "approval-turn",
      status: "inProgress",
      items: [],
    }], {
      type: "active",
      activeFlags: ["waitingForApproval"],
    });
    const host = await CodexAppServerHost.adopt("crashed-attention", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "approval-turn", seq: 2 });
    expect((await replay.next()).value).toEqual({
      kind: "attention",
      id: "item/commandExecution/requestApproval:approval-crash",
      method: "item/commandExecution/requestApproval",
      attention: { command: "date", unowned: true },
      seq: 3,
    });
    expect((await replay.next()).value).toEqual({
      kind: "session-status",
      status: "active",
      activeFlags: ["waitingForApproval"],
      seq: 4,
    });
    expect(await host.health()).toMatchObject({
      status: "attention",
      activeTurnRef: "approval-turn",
      pendingAttention: ["item/commandExecution/requestApproval:approval-crash"],
      activeFlags: ["waitingForApproval", expect.stringMatching(/^destructive-guard:nested:(on|off)$/), "native-inject", "native-turn-profile"],
    });
    await host.release();
  });

  test("preserves a live approval delivered by the resumed process", async () => {
    const server = new FakeAppServer("live-attention", "live-attention", false, [{
      id: "live-turn",
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["waitingForApproval"] }, {
      id: "live-approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "date" },
    });
    const host = await CodexAppServerHost.adopt("live-attention", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const attentionId = (await host.health()).pendingAttention[0]!;
    expect(await host.health()).toMatchObject({
      status: "attention",
      activeTurnRef: "live-turn",
      pendingAttention: [attentionId],
    });
    await host.answer(attentionId, { decision: "accept" });
    expect(server.requests.at(-1)).toMatchObject({ id: "live-approval", result: { decision: "accept" } });
    await host.release();
  });

  test.each([2906, 2908])("anchors pre-restore notifications after durable sequence 2907 when the registry cursor is %i", async (registryCursor) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-cursor-recovery-"));
    const threadId = `cursor-recovery-${registryCursor}`;
    const ledgerPath = path.join(directory, `${encodeURIComponent(threadId)}.jsonl`);
    const durableEvents = Array.from({ length: 2_907 }, (_, index) => JSON.stringify({
      kind: "session-status",
      status: "idle",
      seq: index + 1,
    })).join("\n");
    fs.writeFileSync(ledgerPath, `${durableEvents}\n`, { mode: 0o600 });
    const eventStore = new FileRuntimeEventStore(directory);
    const diagnostics: unknown[] = [];
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, {
      id: "approval-before-restore",
      method: "item/commandExecution/requestApproval",
      params: { command: "date" },
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: registryCursor,
      onEventCursorRecovery: (diagnostic) => diagnostics.push(diagnostic),
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(-3)).toEqual([
      { kind: "session-status", status: "idle", seq: 2_907 },
      {
        kind: "attention",
        id: expect.stringContaining("item/commandExecution/requestApproval:approval-before-restore:"),
        method: "item/commandExecution/requestApproval",
        attention: { command: "date", threadId, turnId: "turn-1", itemId: "item-approval-before-restore", startedAtMs: 1 },
        codexReceipt: expect.objectContaining({ identity: expect.objectContaining({ threadId, requestId: "approval-before-restore" }) }),
        seq: 2_908,
      },
      { kind: "session-status", status: "idle", seq: 2_909 },
    ]);
    expect(await host.health()).toMatchObject({
      status: "attention",
      eventCursor: 2_909,
      pendingAttention: [expect.stringContaining("item/commandExecution/requestApproval:approval-before-restore:")],
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      kind: "runtime-event-cursor-recovery",
      sessionId: threadId,
      durableTailSeq: 2_907,
      registryCursor,
      chosenNextSeq: 2_908,
      action: "use-durable-tail",
    })]);
    await host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("persists overlapping pre-restore lifecycle notifications exactly once after a 942-record ledger", async () => {
    const threadId = ["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-");
    const turnId = "turn-after-942";
    const item = { type: "agentMessage", id: "item-after-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 942; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/started", params: { threadId, turnId, item } },
      { method: "item/completed", params: { threadId, turnId, item } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "started", seq: 944 },
      { kind: "item", turnId, item, phase: "completed", seq: 945 },
      { kind: "turn-ended", turnId, status: "completed", seq: 946 },
      { kind: "session-status", status: "idle", seq: 947 },
    ]);
    await host.release();

    const restartCursor = eventStore.load(threadId).at(-1)!.seq;
    const replacement = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: restartCursor,
      spawnProcess: fakeSpawn(new FakeAppServer(threadId, threadId, false, [{
        id: turnId,
        status: "completed",
        items: [item],
      }], { type: "idle" })),
    });
    const lifecycle = eventStore.load(threadId).filter((event) =>
      event.kind === "turn-started" || event.kind === "item" || event.kind === "turn-ended");
    expect(lifecycle).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "started", seq: 944 },
      { kind: "item", turnId, item, phase: "completed", seq: 945 },
      { kind: "turn-ended", turnId, status: "completed", seq: 946 },
    ]);
    await replacement.release();
  });

  test("a buffered completion keeps a stale active resume snapshot terminal", async () => {
    const threadId = "buffered-terminal-stale-active-snapshot";
    const turnId = "turn-completed-during-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, {
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stale-resume-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: threadId };
    registry.upsert({
      key,
      artifactPath: `/sessions/${threadId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
        process: null,
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 7,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 7,
      claimOwner: "viewer",
      pendingAction: null,
    });
    const stopPersistence = await bindCodexHostPersistence(registry, key, host, "viewer", 7);

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId, seq: 1 },
      { kind: "turn-ended", turnId, status: "completed", seq: 2 },
      { kind: "session-status", status: "idle", seq: 3 },
    ]);
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(registry.snapshot().entries[`codex:${threadId}`]).toMatchObject({
      status: "idle",
      structuredHost: { eventCursor: 3, activeTurnRef: null },
    });

    stopPersistence();
    await host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const scenario of ["idle", "active", "attention", "paused", "unknown-status", "system-error", "start-during-list"]) {
    test(`native cold recovery starts only an observed idle unblocked head (${scenario})`, async () => {
      const threadId = `cold-queue-${scenario}`;
      const eventStore = new MemoryEventStore();
      if (scenario === "paused") {
        eventStore.append(threadId, { kind: "turn-started", turnId: "paused-turn", seq: 1 });
        eventStore.append(threadId, { kind: "turn-ended", turnId: "paused-turn", status: "interrupted", seq: 2 });
      }
      const server = new FakeAppServer(threadId, threadId, false,
        scenario === "active" ? [{ id: "running-turn", status: "inProgress", items: [] }] : [],
        scenario === "unknown-status" ? undefined : { type: scenario === "active" ? "active" : scenario === "system-error" ? "systemError" : "idle" },
        scenario === "attention" ? { id: "blocked-request", method: "item/commandExecution/requestApproval", params: { threadId, command: "fixture" } } : null);
      server.userAgent = "codex_desktop_app/0.159.0 (Linux)";
      server.paginatedHistory = true;
      server.nativeQueueItems = [{ id: "retained-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained input" }] }];
      if (scenario === "start-during-list") server.nativeQueueListNotification = {
        method: "turn/started", params: { threadId, turn: { id: "auto-dispatched-turn" } },
      };
      const host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
      try {
        const starts = server.requests.filter(request => request.method === "thread/queue/start");
        expect(starts).toHaveLength(scenario === "idle" ? 1 : 0);
        expect(server.requests.filter(request => request.method === "thread/queue/add" || request.method === "turn/start")).toHaveLength(0);
        if (scenario === "idle") {
          expect(starts[0]?.params).toEqual({ threadId, queuedSubmissionId: "retained-head" });
          expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "recovered-native-turn" });
          expect(eventStore.load(threadId).filter(event => event.kind === "item")).toEqual([
            expect.objectContaining({ item: expect.objectContaining({ clientId: "original-client" }) }),
          ]);
        }
      } finally { await host.release(); }
    });
  }

  test("native cold recovery leaves an authoritative start refusal with the native owner", async () => {
    const threadId = "cold-queue-race-refusal";
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" });
    server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
    server.paginatedHistory = true;
    server.nativeQueueItems = [{ id: "observed-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained" }] }];
    server.nativeQueueStartError = "queued message no longer exists";
    server.beforeNativeQueueStart = () => { server.nativeQueueItems.shift(); };
    const host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      expect(server.requests.filter(request => request.method === "thread/queue/start")).toHaveLength(1);
      expect(server.requests.filter(request => request.method === "thread/queue/add" || request.method === "turn/start")).toHaveLength(0);
      expect(server.nativeQueueItems).toHaveLength(0);
      expect((await host.health()).status).toBe("idle");
    } finally { await host.release(); }
  });

  test("native cold recovery reports a refusal when the same idle head remains", async () => {
    const threadId = "cold-queue-start-refused";
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" });
    server.userAgent = "codex_desktop_app/0.159.0 (Linux)";
    server.paginatedHistory = true;
    server.nativeQueueItems = [{ id: "observed-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained" }] }];
    server.nativeQueueStartError = "provider configuration refused";
    await expect(CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    })).rejects.toThrow("provider configuration refused");
    expect(server.requests.filter(request => request.method === "thread/queue/start")).toHaveLength(1);
    expect(server.nativeQueueItems).toHaveLength(1);
  });

  for (const [failure, storage] of [["refused", "memory"], ["uncertain", "memory"], ["refused", "file"]]) test(`native cold recovery retries adoption after ${failure} start with reconciled interruption (${storage})`, async () => {
    // Exercise the start refusal/lost reply, independently of CPU time spent
    // validating the initial queue snapshot. RPC timers still run normally.
    setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
    const threadId = `cold-queue-retry-${failure}`;
    const directory = storage === "file" ? fs.mkdtempSync(path.join(os.tmpdir(), "llv-cold-retry-")) : null;
    const eventStore = directory ? new FileRuntimeEventStore(directory) : new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId: "lost-turn", seq: 1 });
    const makeServer = () => {
      const server = new FakeAppServer(threadId, threadId, false,
        [{ id: "lost-turn", status: "interrupted", items: [] }], { type: "idle" }, null,
        failure === "uncertain" ? ["thread/queue/start"] : []);
      server.userAgent = "codex_desktop_app/0.159.0 (Linux)";
      server.paginatedHistory = true;
      server.nativeQueueItems = [{ id: "retained-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained" }] }];
      return server;
    };
    const failed = makeServer();
    if (failure === "refused") failed.nativeQueueStartError = "provider configuration refused";
    await expect(CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", requestTimeoutMs: 20, eventStore, spawnProcess: fakeSpawn(failed),
    })).rejects.toThrow(failure === "refused" ? "provider configuration refused" : "Native queue mutation outcome is uncertain");
    expect(failed.requests.filter(request => request.method === "thread/queue/start")).toHaveLength(1);
    expect(eventStore.load(threadId)).toContainEqual(expect.objectContaining({ kind: "turn-ended", turnId: "lost-turn", status: "interrupted", interruptionSource: "history" }));
    const replacement = new FakeAppServer(threadId, threadId, false,
      [{ id: "lost-turn", status: "interrupted", items: [] }], { type: "idle" });
    replacement.userAgent = "codex_desktop_app/0.159.0 (Linux)";
    replacement.paginatedHistory = true;
    replacement.nativeQueueItems = structuredClone(failed.nativeQueueItems);
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", eventStore: directory ? new FileRuntimeEventStore(directory) : eventStore, spawnProcess: fakeSpawn(replacement),
    });
    try {
      const starts = replacement.requests.filter(request => request.method === "thread/queue/start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params).toEqual({ threadId, queuedSubmissionId: "retained-head" });
      expect(replacement.requests.filter(request => request.method === "thread/queue/add" || request.method === "turn/start")).toHaveLength(0);
      expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "recovered-native-turn" });
    } finally {
      await host.release();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("native cold recovery never retries an unacknowledged start", async () => {
    setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
    const threadId = "cold-queue-lost-start-reply";
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, null, ["thread/queue/start"]);
    server.userAgent = "codex_desktop_app/0.159.0 (Linux)";
    server.paginatedHistory = true;
    server.nativeQueueItems = [{ id: "observed-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained" }] }];
    await expect(CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", requestTimeoutMs: 20, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    })).rejects.toThrow("Native queue mutation outcome is uncertain");
    expect(server.requests.filter(request => request.method === "thread/queue/start")).toHaveLength(1);
    expect(server.requests.filter(request => request.method === "thread/queue/add" || request.method === "turn/start")).toHaveLength(0);
    expect(server.nativeQueueItems).toHaveLength(1);
  });

  test("a native queue turn started during resume survives its idle snapshot", async () => {
    const threadId = "queue-start-during-idle-resume";
    const turnId = "queued-turn";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, [
      { method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["running"] } } },
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ]);
    server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
    server.paginatedHistory = true;
    server.nativeQueueItems = [{ id: "already-dispatched-head", clientUserMessageId: "original-client", input: [{ type: "text", text: "retained" }] }];
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server),
    });
    try {
      expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: turnId });
      expect(eventStore.load(threadId).filter(event => event.kind === "turn-ended")).toEqual([]);
      expect(server.requests.filter(request => request.method === "thread/queue/start")).toHaveLength(0);
      await host.interrupt(turnId);
      expect(server.requests.some(request => request.method === "turn/interrupt")).toBeTrue();
    } finally {
      await host.release();
    }
  });

  test("a buffered start cannot reopen a turn the resume history proves terminal", async () => {
    const threadId = "buffered-start-terminal-history";
    const turnId = "completed-before-snapshot";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [
      { id: turnId, status: "completed", items: [] },
    ], { type: "idle" }, { method: "turn/started", params: { threadId, turn: { id: turnId } } });
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server),
    });
    try {
      expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
      expect(eventStore.load(threadId).filter(event => event.kind === "turn-started")).toHaveLength(1);
      expect(eventStore.load(threadId).filter(event => event.kind === "turn-ended")).toEqual([
        expect.objectContaining({ turnId, status: "completed" }),
      ]);
    } finally {
      await host.release();
    }
  });

  test("a newer buffered turn survives the stale snapshot of its completed predecessor", async () => {
    const threadId = "buffered-successor-after-stale-snapshot";
    const completedTurnId = "turn-stale-snapshot";
    const activeTurnId = "turn-started-during-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: completedTurnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      {
        method: "turn/completed",
        params: { threadId, turn: { id: completedTurnId, status: "completed" } },
      },
      { method: "turn/started", params: { threadId, turn: { id: activeTurnId } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId: completedTurnId, seq: 1 },
      { kind: "turn-ended", turnId: completedTurnId, status: "completed", seq: 2 },
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 4 },
    ]);
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: activeTurnId });
    await host.release();
  });

  test("deduplicates a buffered lifecycle overlap against the durable crash prefix", async () => {
    const threadId = `${["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-")}-overlap`;
    const turnId = "turn-overlapping-942";
    const item = { type: "agentMessage", id: "item-overlapping-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 940; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 941 });
    eventStore.append(threadId, { kind: "item", turnId, item, phase: "started", seq: 942 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/started", params: { threadId, turnId, item } },
      { method: "item/completed", params: { threadId, turnId, item } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "item", turnId, item, phase: "completed", seq: 943 },
      { kind: "turn-ended", turnId, status: "completed", seq: 944 },
      { kind: "session-status", status: "idle", seq: 945 },
    ]);
    await host.release();
  });

  test("reconciles repeated buffered deltas by occurrence against the durable crash prefix", async () => {
    const threadId = "buffered-delta-overlap";
    const turnId = "buffered-delta-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "same fragment", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "same fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "same fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "same fragment", seq: 2 },
      { kind: "delta", turnId, text: "same fragment", seq: 3 },
    ]);
    await host.release();
  });

  test("matches buffered delta overlap against the ordered durable suffix", async () => {
    const threadId = "buffered-delta-ordered-overlap";
    const turnId = "buffered-delta-ordered-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "first fragment", seq: 2 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "second fragment", seq: 3 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "second fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "first fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 3,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "first fragment", seq: 2 },
      { kind: "delta", turnId, text: "second fragment", seq: 3 },
      { kind: "delta", turnId, text: "first fragment", seq: 4 },
    ]);
    await host.release();
  });

  test("reactivates a dead durable turn before its buffered resumed delta", async () => {
    const threadId = "buffered-dead-turn-reactivation";
    const turnId = "buffered-resumed-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "session-status", status: "dead", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "resumed fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(2)).toEqual([
      { kind: "turn-started", turnId, seq: 3 },
      { kind: "delta", turnId, text: "resumed fragment", seq: 4 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 5 },
    ]);
    await host.release();
  });

  test("preserves buffered terminal ordering before the next resumed turn", async () => {
    const threadId = "buffered-cross-turn-order";
    const completedTurnId = "buffered-completed-turn";
    const activeTurnId = "buffered-next-turn";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [
      { id: completedTurnId, status: "completed", items: [] },
      { id: activeTurnId, status: "inProgress", items: [] },
    ], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/completed", params: { threadId, turn: { id: completedTurnId, status: "completed" } } },
      { method: "turn/started", params: { threadId, turn: { id: activeTurnId } } },
      { method: "item/agentMessage/delta", params: { threadId, turnId: activeTurnId, delta: "next turn fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId: completedTurnId, seq: 1 },
      { kind: "turn-ended", turnId: completedTurnId, status: "completed", seq: 2 },
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
      { kind: "delta", turnId: activeTurnId, text: "next turn fragment", seq: 4 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 5 },
    ]);
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: activeTurnId });
    await host.release();
  });

  /* #1284: one app-server connection carries every thread of a session tree, so
     a native sub-agent's turn streams down the same pipe as its parent's. Left
     unfiltered, the two turn ids alternate in the parent's ledger and the live
     projection opens a fresh item on every switch — the parent's answer rendered
     as a column of mid-sentence fragments. */
  test("keeps a sibling thread's interleaved turn out of the parent's stream", async () => {
    const parentThreadId = "parent-thread-stream";
    const childThreadId = "child-thread-stream";
    const parentTurnId = "turn-parent-stream";
    const childTurnId = "turn-child-stream";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(parentThreadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    server.notify("turn/started", { threadId: parentThreadId, turn: { id: parentTurnId } });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "The parent answer ",
    });
    /* The sub-agent's whole lifecycle, interleaved delta by delta. */
    server.notify("turn/started", { threadId: childThreadId, turn: { id: childTurnId } });
    server.notify("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: childTurnId,
      itemId: "child-item",
      delta: "VERDICT",
    });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "stays one ",
    });
    server.notify("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: childTurnId,
      itemId: "child-item",
      delta: "_HELD",
    });
    server.notify("item/completed", {
      threadId: childThreadId,
      turnId: childTurnId,
      item: { type: "agentMessage", id: "child-item", text: "VERDICT_HELD" },
    });
    server.notify("turn/completed", {
      threadId: childThreadId,
      turn: { id: childTurnId, status: "completed" },
    });
    server.notify("thread/status/changed", { threadId: childThreadId, status: { type: "idle" } });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "continuous stream.",
    });
    await Bun.sleep(0);

    const events = eventStore.load(parentThreadId);
    expect(events.filter((event) => event.kind !== "session-status")).toEqual([
      { kind: "turn-started", turnId: parentTurnId, seq: 2, accountingAt: expect.any(String) },
      { kind: "delta", turnId: parentTurnId, text: "The parent answer ", seq: 3 },
      { kind: "delta", turnId: parentTurnId, text: "stays one ", seq: 4 },
      { kind: "delta", turnId: parentTurnId, text: "continuous stream.", seq: 5 },
    ]);
    /* The parent's own record of the delegation is untouched, and the child's
       turn neither idles the parent's session nor steals its active turn. */
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: parentTurnId });

    const live = events.reduce<RuntimeLiveTurn | null>(
      (turn, event) => event.kind === "delta"
        ? appendRuntimeLiveTurnDelta(turn, event.turnId, event.text)
        : turn,
      null,
    );
    expect(runtimeLiveTurnItems(live).map((item) => item.text))
      .toEqual(["The parent answer stays one continuous stream."]);

    server.notify("item/completed", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        status: "completed",
        agentsStates: {},
      },
    });
    await Bun.sleep(0);
    expect(eventStore.load(parentThreadId).findLast((event) => event.kind === "item"))
      .toMatchObject({ turnId: parentTurnId, item: { type: "collabAgentToolCall" } });
    await host.release();
  });

  test("skips a sibling thread's buffered frames when replaying a crash prefix", async () => {
    const threadId = "buffered-sibling-thread";
    const siblingThreadId = "buffered-sibling-child";
    const turnId = "buffered-sibling-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "durable fragment", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      {
        method: "item/agentMessage/delta",
        params: { threadId: siblingThreadId, turnId: "buffered-sibling-child-turn", delta: "sibling fragment" },
      },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "durable fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "replayed fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    /* The sibling frame is neither replayed nor counted: counting it would put a
       key at the head of the buffered prefix that replay never emits, breaking
       the overlap match and re-emitting the durable fragment as a duplicate. */
    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "durable fragment", seq: 2 },
      { kind: "delta", turnId, text: "replayed fragment", seq: 3 },
    ]);
    await host.release();
  });

  test("keeps restored and newly issued same-RPC-id requests in distinct generations", async () => {
    const threadId = "buffered-attention-overlap";
    const attentionId = "item/commandExecution/requestApproval:buffered-approval";
    const attention = { command: "date" };
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, {
      kind: "attention",
      id: attentionId,
      method: "item/commandExecution/requestApproval",
      attention,
      seq: 1,
    });
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, {
      id: "buffered-approval",
      method: "item/commandExecution/requestApproval",
      params: attention,
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });

    const newId = (await host.health()).pendingAttention.find(id => id !== attentionId)!;
    expect(newId).toStartWith(`${attentionId}:`);
    expect((await host.health()).pendingAttention).toEqual([attentionId, newId]);
    await expect(host.answer(attentionId, { decision: "accept" })).rejects.toThrow("previous host generation");
    await host.answer(newId, { decision: "accept" });
    expect((await host.health()).pendingAttention).toEqual([attentionId]);
    await host.release();
  });

  test("orders a buffered terminal-only suffix after reconstructed resume history", async () => {
    const threadId = `${["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-")}-terminal-suffix`;
    const turnId = "turn-terminal-suffix-942";
    const item = { type: "agentMessage", id: "item-terminal-suffix-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 942; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "completed", seq: 944 },
      { kind: "turn-ended", turnId, status: "completed", seq: 945 },
      { kind: "session-status", status: "idle", seq: 946 },
    ]);
    await host.release();
  });

  test("a deferred completed turn cannot clear the newer resumed active turn", async () => {
    const threadId = "deferred-terminal-active-turn";
    const completedTurnId = "turn-completed-before-resume";
    const activeTurnId = "turn-active-after-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [
      { id: completedTurnId, status: "completed", items: [] },
      { id: activeTurnId, status: "inProgress", items: [] },
    ], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/completed", params: { threadId, turn: { id: completedTurnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) =>
      event.kind === "turn-started" && event.turnId === activeTurnId)).toEqual([
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
    ]);
    expect(await host.health()).toMatchObject({
      status: "active",
      activeTurnRef: activeTurnId,
      activeFlags: ["running", expect.stringMatching(/^destructive-guard:nested:(on|off)$/), "native-inject", "native-turn-profile"],
    });
    await host.release();
  });

  test("fails closed before host emission advances beyond the safe-integer cursor range", async () => {
    const threadId = "cursor-near-safe-limit";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: Number.MAX_SAFE_INTEGER - 1,
      spawnProcess: fakeSpawn(server),
    });
    expect(eventStore.load(threadId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);

    server.notify("account/rateLimits/updated", { credits: "unchanged" });
    await Bun.sleep(0);

    expect(eventStore.load(threadId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);
    expect(await host.health()).toMatchObject({
      status: "dead",
      eventCursor: Number.MAX_SAFE_INTEGER,
    });
    await host.release();
  });

  test("parses generated-schema thread status notifications", async () => {
    const server = new FakeAppServer("status-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const fixtures = fs.readFileSync(path.join(import.meta.dir, "fixtures/codex-thread-status-v0.144.1.jsonl"), "utf8")
      .trim().split("\n");
    for (const [index, fixture] of fixtures.entries()) {
      server.stdout.write(`${fixture}\n`);
      const event = (await stream.next()).value as RuntimeEvent;
      if (index === 0) expect(event).toMatchObject({ kind: "session-status", status: "active", activeFlags: ["waitingForApproval"] });
      if (index === 1) expect(event).toMatchObject({ kind: "session-status", status: "idle" });
      if (index === 2) expect(event).toMatchObject({ kind: "session-status", status: "unhosted" });
      if (index === 3) expect(event).toMatchObject({ kind: "session-status", status: "idle", activeFlags: ["recovering"] });
    }
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(server.signals).toEqual([]);
    await host.release();
    expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "unhosted" });
    expect((await stream.next()).done).toBeTrue();
  });
});
