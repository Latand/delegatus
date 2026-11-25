// destructive-code: head-only; fixture-owned paths and recording process doubles.
import { wakeResponseEvidenceFromEvents } from "../monitor/seatWakeResponse";
import { TURN_SILENCE_MS } from "./turnSilence";
import { idleWindowFixture } from "./fixtures/idleEventWindow";
import { readNativeTiming } from "./attemptTiming";
import { splitAttemptTime } from "@/lib/pipelines/accounting";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, setSystemTime, test } from "bun:test";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { HOST_EVENT_WINDOW } from "./hostEventWindow";
import type { RuntimeEvent } from "./engineHost";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

test("Codex host persists a media-free copy while its live event retains the response", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-private-media-ledger-"));
  const threadId = "thread-private-media";
  const store = new FileRuntimeEventStore(path.join(directory, "events"));
  const server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: directory, eventStore: store, spawnProcess: fakeSpawn(server) });
  try {
    const emit = (host as unknown as { emit(event: object): void }).emit.bind(host);
    const ref = `media_${"a".repeat(32)}`;
    const pixels = "cHJpdmF0ZS1waXhlbHM=";
    emit({ kind: "item", turnId: "turn-private", phase: "completed", item: {
      type: "mcpToolCall", tool: "relay_service_tools", result: { content: [{ type: "image", data: pixels }], ref },
    }, voiceResponse: { responseId: "voice-private", text: `spoken ${ref}` } });
    emit({ kind: "delta", turnId: "turn-private", text: `media_${"b".repeat(9)}` });
    emit({ kind: "delta", turnId: "turn-private", text: "b".repeat(23) });
    const stored = JSON.stringify(store.load(threadId));
    expect(stored).not.toContain(ref);
    expect(stored).not.toContain(pixels);
    expect(stored).not.toContain(`media_${"b".repeat(32)}`);
    expect(JSON.stringify((host as unknown as { events: RuntimeEvent[] }).events)).toContain(pixels);
  } finally {
    await host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("native accounting clocks reach the retained time reader through the real Codex producer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timing-"));
  const threadId = "accounting-thread";
  const server = new FakeAppServer(threadId);
  const events = new FileRuntimeEventStore(root);
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: events, spawnProcess: fakeSpawn(server) });
  const at = (ms: number) => new Date(ms).toISOString();
  try {
    setSystemTime(new Date(1000));
    await host.send({ id: "accounting-turn", text: "Run the check" });
    setSystemTime(new Date(2000));
    server.notify("item/started", { threadId, turnId: "turn-1", item: { id: "tool", type: "commandExecution", command: "true" } });
    setSystemTime(new Date(3000));
    server.notify("item/completed", { threadId, turnId: "turn-1", item: { id: "tool", type: "commandExecution", command: "true", exitCode: 0 } });
    const open = splitAttemptTime(at(1000), at(4000), readNativeTiming(threadId, root));
    expect(open).toMatchObject({ modelMs: 1000, toolsMs: 1000, unknownMs: 1000 });
    setSystemTime(new Date(5000));
    server.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
    expect(splitAttemptTime(at(1000), at(5000), readNativeTiming(threadId, root)))
      .toMatchObject({ modelMs: 3000, toolsMs: 1000, unknownMs: 0 });
  } finally { setSystemTime(); await host.release(); }
});

test("a Codex host keeps a bounded event window, replays older events from its ledger and keeps turn boundaries", async () => {
  const threadId = "event-window-thread";
  const eventStore = new MemoryEventStore();
  const retained = (host: CodexAppServerHost) => (host as unknown as { events: RuntimeEvent[] }).events.length;
  const replay = async (host: CodexAppServerHost, count: number) => {
    const stream = host.attach(0)[Symbol.asyncIterator]();
    const events: RuntimeEvent[] = [];
    while (events.length < count) events.push((await stream.next()).value as RuntimeEvent);
    await stream.return?.(undefined);
    return events;
  };
  const server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
  server.notify("turn/started", { threadId, turn: { id: "turn-first" } });
  server.notify("turn/completed", { threadId, turn: { id: "turn-first", status: "interrupted" } });
  server.notify("turn/started", { threadId, turn: { id: "turn-long" } });
  const deltas = HOST_EVENT_WINDOW * 2;
  for (let index = 0; index < deltas; index++) {
    server.notify("item/agentMessage/delta", { threadId, turnId: "turn-long", delta: `part ${index} ` });
  }
  server.notify("turn/completed", { threadId, turn: { id: "turn-long", status: "completed" } });
  await waitForCondition(() => eventStore.load(threadId).some(event => event.kind === "turn-ended" && event.turnId === "turn-long"), "the long turn to end");
  const ledger = eventStore.load(threadId);
  expect(ledger.length).toBeGreaterThan(deltas);
  expect(retained(host)).toBeLessThanOrEqual(HOST_EVENT_WINDOW * 1.25);
  // A reader from the start gets every event, the older ones from the ledger.
  expect(await replay(host, ledger.length)).toEqual(ledger);
  // The first turn's boundaries left the window long ago and still answer.
  expect(host.tierCutEvidence("turn-first")).toBe("turn-ended");
  await host.release();

  // Adoption reconciles against the whole ledger, then keeps only the window.
  const resumed = new FakeAppServer(threadId, threadId, false, [
    { id: "turn-first", status: "interrupted", items: [] },
    { id: "turn-long", status: "completed", items: [] },
  ]);
  const adopted = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore, spawnProcess: fakeSpawn(resumed) });
  const after = eventStore.load(threadId);
  expect(after.filter(event => event.kind === "turn-started" && event.turnId === "turn-first")).toHaveLength(1);
  expect(after.filter(event => event.kind === "turn-started" && event.turnId === "turn-long")).toHaveLength(1);
  expect(retained(adopted)).toBeLessThanOrEqual(HOST_EVENT_WINDOW * 1.25);
  expect(await replay(adopted, after.length)).toEqual(after);
  expect(adopted.tierCutEvidence("turn-first")).toBe("turn-ended");
  await adopted.release();
});

test("heap counters observe events and subscriber queues without consuming them", async () => {
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer("heap-counter-thread")) });
  const before = host.heapAttribution();
  const stop = host.onStateChange(() => {});
  const stream = host.attach(0)[Symbol.asyncIterator]();
  try {
    expect(before.engine).toBe("codex");
    expect(before.events).toBeGreaterThan(0);
    expect(host.heapAttribution()).toMatchObject({ events: before.events,
      eventSubscribers: before.eventSubscribers + 1, stateSubscribers: before.stateSubscribers + 1,
      queuedEvents: before.queuedEvents + before.events });
    await stream.next();
    expect(host.heapAttribution().queuedEvents).toBe(before.queuedEvents + before.events - 1);
    await stream.return?.();
    stop();
    expect(host.heapAttribution()).toMatchObject({ eventSubscribers: before.eventSubscribers, stateSubscribers: before.stateSubscribers });
  } finally { stop(); await stream.return?.(); await host.release(); }
});

test("central native completion releases an unanswered old tool and admits the next ordinary message", async () => {
  const server = new FakeAppServer("central-completion");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    await host.send({ id: "first-central-message", text: "first" });
    server.notify("item/started", { threadId: host.identity.threadId, turnId: "turn-1",
      item: { id: "historical-tool", type: "commandExecution", status: "inProgress" } });
    expect(host.reconcileAgentStateTerminal("older-turn", "older-turn", 1000)).toBe(false);
    expect(host.reconcileAgentStateTerminal("turn-1", "turn-1", 1000)).toBe(true);
    expect(host.agentStateMemory().activeTurnRef).toBeNull();
    expect(await host.send({ id: "second-central-message", text: "second" })).toMatchObject({ outcome: "turn-started", turnId: "turn-2" });
    expect(host.reconcileAgentStateTerminal("turn-1", "turn-1", 1000)).toBe(false);
    expect(host.agentStateMemory().activeTurnRef).toBe("turn-2");
  } finally { await host.release(); }
});

test.each(["memory", "file"])("a settled host releases idle events, replays to subscribers and refills on its next turn (%s)", async kind => {
  const eventStore = kind === "file"
    ? new FileRuntimeEventStore(fs.mkdtempSync(path.join(os.tmpdir(), "host-refill-"))) : new MemoryEventStore();
  const server = new FakeAppServer("idle-window-thread");
  const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore, spawnProcess: fakeSpawn(server) });
  const idle = idleWindowFixture(host);
  try {
    const count = host.heapAttribution().events;
    expect(count).toBeGreaterThan(0);
    expect(await host.releaseIdleEventWindow(() => false)).toBeFalse();
    expect(await host.releaseIdleEventWindow(() => true)).toBeTrue();
    expect(host.heapAttribution().events).toBe(0);
    const stream = host.attach(0)[Symbol.asyncIterator]();
    try {
      for (let index = 0; index < count; index++) expect((await stream.next()).done).toBeFalse();
      expect(host.heapAttribution().events).toBeGreaterThan(0);
    } finally { await stream.return?.(); }
    expect(await host.releaseIdleEventWindow(() => true)).toBeTrue();
    await host.send({ id: "next-idle-turn", text: "continue" });
    expect(host.heapAttribution().events).toBeGreaterThan(0);
  } finally { idle.cleanup(); await host.release(); }
});

test("large tool payloads retain previews after live writes and adoption without duplicate reconciliation", async () => {
  const threadId = "preview-window-thread";
  const eventStore = new MemoryEventStore();
  const item = { id: "large-command", type: "commandExecution", command: "printf output", exitCode: 7, aggregatedOutput: "output".repeat(10_000) };
  const server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
  const check = async (current: CodexAppServerHost) => {
    const stored = eventStore.load(threadId);
    const stream = current.attach(0)[Symbol.asyncIterator]();
    try {
      const replay: RuntimeEvent[] = [];
      for (let index = 0; index < stored.length; index++) replay.push((await stream.next()).value as RuntimeEvent);
      const command = replay.find(event => event.kind === "item" && (event.item as { id?: string }).id === item.id);
      expect(command).toMatchObject({ item: { id: item.id, exitCode: 7, aggregatedOutput: expect.stringContaining("[truncated; original UTF-8 bytes: 60000;") } });
      expect(stored.find(event => event.kind === "item" && (event.item as { id?: string }).id === item.id)).toMatchObject({ item });
      expect(current.heapAttribution()).toMatchObject({ trimmedEvents: 1 });
      expect(current.heapAttribution().windowBytes).toBeLessThanOrEqual(current.heapAttribution().windowByteLimit);
    } finally { await stream.return?.(); }
  };
  try {
    server.notify("turn/started", { threadId, turn: { id: "preview-turn" } });
    server.notify("item/completed", { threadId, turnId: "preview-turn", item });
    server.notify("turn/completed", { threadId, turn: { id: "preview-turn", status: "completed" } });
    await waitForCondition(() => eventStore.load(threadId).some(event => event.kind === "turn-ended"), "preview turn to end");
    await check(host);
  } finally { await host.release(); }
  const resumed = new FakeAppServer(threadId, threadId, false, [{ id: "preview-turn", status: "completed", items: [item] }]);
  const adopted = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore, spawnProcess: fakeSpawn(resumed) });
  try {
    await check(adopted);
    expect(eventStore.load(threadId).filter(event => event.kind === "item" && (event.item as { id?: string }).id === item.id)).toHaveLength(1);
  } finally { await adopted.release(); }
});

test.each(["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"])("live reasoning refreshes Codex silence without answering: %s", async method => {
  for (const adopt of [false, true]) {
    let now = Date.parse("2026-11-01T00:00:00Z"), deadline: (() => Promise<void>) | undefined;
    const threadId = `reasoning-${method.split("/").at(-1)}-${adopt}`, turnId = adopt ? "resumed-turn" : "turn-1";
    const store = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false,
      adopt ? [{ id: turnId, status: "inProgress", items: [] }] : [], adopt ? { type: "active", activeFlags: ["running"] } : { type: "idle" },
      adopt ? { method, params: { threadId, turnId, itemId: "old-thought", delta: "Replayed reasoning" } } : null);
    const opts = { cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server),
      turnSilence: { now: () => now, schedule: (callback: () => Promise<void>) => { deadline = callback; return () => {}; } } };
    const host = adopt ? await CodexAppServerHost.adopt(threadId, opts) : await CodexAppServerHost.start(opts);
    try {
      if (!adopt) await host.send({ id: "reasoning-request", text: "reason through the request" });
      expect(store.load(threadId).some(event => event.kind === "item" && (event.item as { text?: string }).text === "Replayed reasoning")).toBe(false);
      now += 14 * 60_000;
      server.notify(method, { threadId, turnId, itemId: "thought", summaryIndex: 0, contentIndex: 0, delta: "Fresh reasoning" });
      await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && (event.item as { text?: string }).text === "Fresh reasoning"), "reasoning activity");
      now += 60_000; await deadline!();
      expect(await host.health()).toMatchObject({ status: "active" });
      expect(store.load(threadId).filter(event => event.kind === "delta" || event.kind === "turn-ended")).toEqual([]);
      now += 14 * 60_000; await deadline!();
      expect(await host.health()).toMatchObject({ status: "dead" });
      expect(store.load(threadId).some(event => event.kind === "item" && (event.item as { reason?: string }).reason === "turn-silence-timeout")).toBe(true);
    } finally { await host.release(); }
  }
});

test.each(["foreign-thread", "old-turn", "empty", "writer"])("Codex reasoning cannot renew silence from %s", async mode => {
  let now = Date.parse("2026-11-01T00:00:00Z"), deadline: (() => Promise<void>) | undefined;
  const threadId = `fenced-reasoning-${mode}`, store = new MemoryEventStore(), server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server),
    turnSilence: { now: () => now, schedule: callback => { deadline = callback; return () => {}; } } });
  try {
    await host.send({ id: "reasoning-request", text: "reason through the request" });
    now += 14 * 60_000;
    if (mode === "writer") host.setWriterFence(() => false);
    server.notify("item/reasoning/textDelta", { threadId: mode === "foreign-thread" ? "other-thread" : threadId,
      turnId: mode === "old-turn" ? "old-turn" : "turn-1", itemId: "thought", delta: mode === "empty" ? " " : "Unowned reasoning" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.load(threadId).some(event => event.kind === "item" && (event.item as { type?: string }).type === "reasoning")).toBe(false);
    host.setWriterFence(() => true);
    now += 60_000; await deadline!();
    expect(await host.health()).toMatchObject({ status: "dead" });
  } finally { await host.release(); }
});

for (const phase of ["started", "completed"]) for (const content of ["empty", "whitespace", "blocks"]) {
  test.each(["reasoning", "agentMessage"])(`empty native envelopes preserve both deadlines: ${phase}/${content}/%s`, async type => {
    const base = Date.parse("2026-11-03T00:00:00Z");
    let now = base, deadline: (() => Promise<void>) | undefined;
    const threadId = `empty-envelope-${phase}-${content}-${type}`, store = new MemoryEventStore(), server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server),
      turnSilence: { now: () => now, schedule: callback => { deadline = callback; return () => {}; } } });
    try {
      setSystemTime(base);
      await host.send({ id: "empty-envelope-request", text: "perform work" });
      now += 14 * 60_000; setSystemTime(now);
      const item = { type, id: "empty-envelope", text: content === "whitespace" ? " \n " : "",
        summary: content === "blocks" ? [{ type: "summary_text", text: " " }] : [],
        content: content === "blocks" ? [{ type: "text", text: " " }] : [] };
      server.notify(`item/${phase}`, { threadId, turnId: "turn-1", item });
      await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && (event.item as { id?: string }).id === item.id), "native envelope retained");
      const response = wakeResponseEvidenceFromEvents({ clientMessageId: "empty-envelope-request", operationId: "empty-envelope-request",
        conversationId: "conversation_fixture", seatEpoch: 7, turnId: "turn-1", deliveredAt: new Date(base).toISOString(),
        progressAt: new Date(base).toISOString(), boundMs: TURN_SILENCE_MS, action: "pending" }, store.load(threadId) as unknown as Record<string, unknown>[]);
      // Check the independent tick reader too, before the host expires.
      now += 60_000; await deadline!();
      expect({ status: (await host.health()).status, progressAt: response.progressAt })
        .toEqual({ status: "dead", progressAt: undefined });
      expect(store.load(threadId).some(event => event.kind === "item" && (event.item as { reason?: string }).reason === "turn-silence-timeout")).toBe(true);
    } finally { setSystemTime(); await host.release(); }
  });
}

test.each(["reasoning", "agentMessage", "commandExecution"])("meaningful native envelopes retain progress and owned tools: %s", async type => {
  const base = Date.parse("2026-11-03T00:00:00Z");
  let now = base, deadline: (() => Promise<void>) | undefined;
  const threadId = `meaningful-envelope-${type}`, store = new MemoryEventStore(), server = new FakeAppServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server),
    turnSilence: { now: () => now, schedule: callback => { deadline = callback; return () => {}; } } });
  try {
    setSystemTime(base);
    await host.send({ id: "meaningful-request", text: "perform work" });
    now += 14 * 60_000; setSystemTime(now);
    const item = { type, id: "meaningful-item", status: "inProgress",
      ...(type === "reasoning" ? { summary: [{ type: "summary_text", text: "A real thought" }] }
        : type === "agentMessage" ? { text: "A real answer" } : { command: "owned foreground work" }) };
    server.notify("item/started", { threadId, turnId: "turn-1", item });
    await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && (event.item as { id?: string }).id === item.id), "meaningful native item retained");
    const response = wakeResponseEvidenceFromEvents({ clientMessageId: "meaningful-request", operationId: "meaningful-request",
      conversationId: "conversation_fixture", seatEpoch: 7, turnId: "turn-1", deliveredAt: new Date(base).toISOString(),
      progressAt: new Date(base).toISOString(), boundMs: TURN_SILENCE_MS, action: "pending" }, store.load(threadId) as unknown as Record<string, unknown>[]);
    expect(response.progressAt).toBeDefined();
    expect(response.answered).toBe(false);
    now += 60_000; await deadline!();
    expect(await host.health()).toMatchObject({ status: "active" });
    if (type === "commandExecution") {
      now += 30 * 60_000; await deadline!();
      expect(await host.health()).toMatchObject({ status: "active" });
      server.notify("item/completed", { threadId, turnId: "turn-1", item: { ...item, status: "completed" } });
      await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed" && (event.item as { id?: string }).id === item.id), "owned command completed");
    }
    now += TURN_SILENCE_MS; await deadline!();
    expect(await host.health()).toMatchObject({ status: "dead" });
  } finally { setSystemTime(); await host.release(); }
});
