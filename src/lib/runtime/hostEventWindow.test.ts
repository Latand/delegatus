import { expect, test } from "bun:test";

import { RuntimeReplayGapError, type RuntimeEvent } from "./engineHost";
import {
  attachRuntimeEvents,
  boundMap,
  HOST_EVENT_WINDOW,
  runtimeEventsAfter,
  HostEventWindow,
  HOST_EVENT_WINDOW_BYTES,
  hostEventWindowByteLimit,
  type RuntimeEventSubscriber,
} from "./hostEventWindow";

const delta = (seq: number): RuntimeEvent => ({ kind: "delta", turnId: "turn", text: `part ${seq}`, seq });

/** A host's ledger and its in-memory window, kept the way the hosts keep them. */
function source(count: number) {
  const ledger: RuntimeEvent[] = [];
  const owner = new HostEventWindow();
  const window = owner.events;
  const subscribers = new Set<RuntimeEventSubscriber>();
  let ledgerReads = 0;
  const emit = () => {
    const event = delta(ledger.length + 1);
    ledger.push(event);
    owner.append(event);
    for (const subscriber of subscribers) { subscriber.queue.push(event); subscriber.wake?.(); }
  };
  for (let index = 0; index < count; index++) emit();
  return {
    ledger, window, subscribers, emit,
    close: () => { for (const subscriber of subscribers) { subscriber.closed = true; subscriber.wake?.(); } subscribers.clear(); },
    ledgerReads: () => ledgerReads,
    events: { window: () => window, ledger: () => { ledgerReads += 1; return ledger; }, subscribers },
  };
}

async function take(iterator: AsyncIterator<RuntimeEvent>, count: number): Promise<number[]> {
  const seqs: number[] = [];
  while (seqs.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    seqs.push(next.value.seq);
  }
  return seqs;
}

test("the in-memory window stays bounded however many events a host emits", () => {
  const host = source(HOST_EVENT_WINDOW * 5);
  expect(host.window.length).toBeLessThanOrEqual(HOST_EVENT_WINDOW * 1.25);
  expect(host.window.length).toBeGreaterThanOrEqual(HOST_EVENT_WINDOW);
  expect(host.window.at(-1)!.seq).toBe(HOST_EVENT_WINDOW * 5);
});

test("a reader behind the window gets the older events from the ledger, in order and without a gap", () => {
  const host = source(HOST_EVENT_WINDOW * 3);
  const first = host.window[0]!.seq;
  expect(first).toBeGreaterThan(1);
  const all = runtimeEventsAfter(host.window, 0, host.events.ledger);
  expect(all.map(event => event.seq)).toEqual(host.ledger.map(event => event.seq));
  expect(runtimeEventsAfter(host.window, first + 10, host.events.ledger).map(event => event.seq))
    .toEqual(host.ledger.slice(first + 10).map(event => event.seq));
  // Within the window the ledger is not read.
  expect(host.ledgerReads()).toBe(1);
});

test("a request older than the ledger is still a replay gap", () => {
  const host = source(HOST_EVENT_WINDOW * 3);
  const firstKept = host.ledger.findIndex(event => event.seq === 100);
  const trimmedLedger = host.ledger.slice(firstKept);
  expect(() => runtimeEventsAfter(host.window, 10, () => trimmedLedger)).toThrow(RuntimeReplayGapError);
  expect(() => runtimeEventsAfter(host.window, 0, () => [])).toThrow(RuntimeReplayGapError);
});

test("a stream returned before its first read leaves the host at once", async () => {
  const host = source(10);
  const stream = attachRuntimeEvents(0, host.events)[Symbol.asyncIterator]();
  expect(host.subscribers.size).toBe(1);
  // An async generator returned before it starts never runs its finally.
  await stream.return?.(undefined);
  expect(host.subscribers.size).toBe(0);
  for (let index = 0; index < 100; index++) host.emit();
  expect(host.subscribers.size).toBe(0);
});

test("a stream returned while it waits for the next event leaves the host and ends", async () => {
  const host = source(2);
  const stream = attachRuntimeEvents(0, host.events)[Symbol.asyncIterator]();
  expect(await take(stream, 2)).toEqual([1, 2]);
  const waiting = stream.next();
  await stream.return?.(undefined);
  expect((await waiting).done).toBeTrue();
  expect(host.subscribers.size).toBe(0);
});

test("a stream dropped unread gives its seat back once collected", async () => {
  const host = source(10);
  (() => { attachRuntimeEvents(0, host.events)[Symbol.asyncIterator](); })();
  expect(host.subscribers.size).toBe(1);
  for (let round = 0; round < 20 && host.subscribers.size > 0; round++) {
    Bun.gc(true);
    await Bun.sleep(10);
  }
  expect(host.subscribers.size).toBe(0);
});

test("a reader behind the window keeps every event emitted while it reads", async () => {
  const host = source(10);
  const late = attachRuntimeEvents(5, host.events)[Symbol.asyncIterator]();
  for (let index = 0; index < HOST_EVENT_WINDOW * 2; index++) host.emit();
  const total = host.ledger.length;
  expect(await take(late, total - 5)).toEqual(host.ledger.slice(5).map(event => event.seq));
  host.emit();
  expect(await take(late, 1)).toEqual([total + 1]);
  await late.return?.(undefined);
  expect(host.subscribers.size).toBe(0);
});

test("a host closing a stream ends it after the events emitted before the close", async () => {
  const host = source(3);
  const stream = attachRuntimeEvents(0, host.events)[Symbol.asyncIterator]();
  host.emit();
  host.close();
  host.emit();
  expect(await take(stream, 10)).toEqual([1, 2, 3, 4]);
  expect(host.subscribers.size).toBe(0);
});

test("a bounded map drops its oldest settled entries and keeps open ones whatever their age", () => {
  const map = new Map<string, { open: boolean }>();
  map.set("open-oldest", { open: true });
  for (let index = 0; index < 10; index++) map.set(`settled-${index}`, { open: false });
  boundMap(map, 4, value => !value.open);
  expect([...map.keys()]).toEqual(["open-oldest", "settled-7", "settled-8", "settled-9"]);
});

const toolEvent = (seq: number, output = "x".repeat(20 * 1024)): RuntimeEvent => ({
  kind: "item", turnId: "turn", phase: "completed", seq,
  item: { type: "commandExecution", id: `command-${seq}`, command: "printf output", status: "completed", exitCode: 7, aggregatedOutput: output },
});
const bytesOf = (events: readonly RuntimeEvent[]) => events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);

test("byte eviction, count eviction and restoration keep an exactly accounted contiguous suffix", () => {
  const window = new HostEventWindow(12_000);
  for (let seq = 1; seq <= 50; seq++) {
    window.append(toolEvent(seq));
    expect(window.heapAttribution()).toEqual({ windowBytes: bytesOf(window.events), windowByteLimit: 12_000, trimmedEvents: window.events.length });
    expect(bytesOf(window.events)).toBeLessThanOrEqual(12_000);
    expect(window.events.map(event => event.seq)).toEqual(Array.from({ length: window.events.length }, (_, index) => seq - window.events.length + index + 1));
  }
  const restored = new HostEventWindow(12_000);
  restored.restore(Array.from({ length: 50 }, (_, index) => toolEvent(index + 1)));
  expect(restored.events).toEqual(window.events);
  expect(restored.heapAttribution()).toEqual(window.heapAttribution());
  restored.restore([delta(51)]);
  expect(restored.heapAttribution()).toMatchObject({ windowBytes: bytesOf(restored.events), trimmedEvents: 0 });
  restored.restore(restored.events);
  expect(restored.events).toEqual([delta(51)]);
  const countBound = new HostEventWindow();
  for (let seq = 1; seq <= HOST_EVENT_WINDOW * 2; seq++) countBound.append(delta(seq));
  expect(countBound.events).toHaveLength(HOST_EVENT_WINDOW);
  expect(countBound.heapAttribution().windowBytes).toBe(bytesOf(countBound.events));
});

test("previews copy large UTF-8 command output, file contents, diffs and tool results without mutating the ledger", () => {
  const body = "😀ї".repeat(5000);
  const items = [
    { type: "commandExecution", id: "cmd", aggregatedOutput: body },
    { type: "fileChange", id: "patch", changes: [{ path: "file.ts", diff: body }] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "write", name: "Write", input: { file_path: "file.ts", content: body } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "write", is_error: true, content: [{ type: "text", text: body }] }] } },
    { type: "mcpToolCall", id: "mcp", result: { content: [{ type: "text", text: body }] } },
    { sessionUpdate: "tool_call_update", toolCallId: "acp", rawOutput: body, status: "failed" },
  ];
  for (const item of items) {
    const original = { kind: "item", turnId: "turn", phase: "completed", seq: 1, item } as RuntimeEvent;
    const recorded = JSON.stringify(original);
    const window = new HostEventWindow();
    window.append(original);
    const preview = JSON.stringify(window.events[0]);
    expect(preview).toContain(`[truncated; original UTF-8 bytes: ${Buffer.byteLength(body)}; full text in transcript]`);
    expect(preview).not.toContain("�");
    expect(preview.length).toBeLessThan(5000);
    expect(window.heapAttribution().trimmedEvents).toBe(1);
    expect(JSON.stringify(original)).toBe(recorded);
  }
});

test("unpreviewable oversized events evict the whole prefix and remain replayable from the ledger", () => {
  const ledger = [delta(1), { ...delta(2), text: "large exact delta".repeat(1000) }];
  const window = new HostEventWindow(500);
  for (const event of ledger) window.append(event);
  expect(window.events).toEqual([]);
  expect(window.heapAttribution()).toMatchObject({ windowBytes: 0, trimmedEvents: 0 });
  expect(runtimeEventsAfter(window.events, 0, () => ledger)).toEqual(ledger);
  expect(() => runtimeEventsAfter(window.events, 0, () => ledger.slice(1))).toThrow(RuntimeReplayGapError);
  ledger.push(delta(3)); window.append(ledger[2]!);
  expect(runtimeEventsAfter(window.events, 0, () => ledger)).toEqual(ledger);
  expect(() => runtimeEventsAfter(window.events, 0, () => ledger.slice(1))).toThrow(RuntimeReplayGapError);
});

test("new subscribers replay previews and old ledger events in sequence; returning and continuing still work", async () => {
  const ledger = Array.from({ length: 4 }, (_, index) => toolEvent(index + 1));
  const window = new HostEventWindow(12_000);
  ledger.forEach(event => window.append(event));
  const subscribers = new Set<RuntimeEventSubscriber>();
  const stream = attachRuntimeEvents(0, { window: () => window.events, ledger: () => ledger, subscribers })[Symbol.asyncIterator]();
  const replay: RuntimeEvent[] = [];
  for (let index = 0; index < 4; index++) replay.push((await stream.next()).value as RuntimeEvent);
  expect(replay.map(event => event.seq)).toEqual([1, 2, 3, 4]);
  expect(replay[0]).toEqual(ledger[0]);
  expect(JSON.stringify(replay.at(-1))).toContain("[truncated;");
  const waiting = stream.next();
  const next = toolEvent(5);
  ledger.push(next); window.append(next);
  for (const subscriber of subscribers) { subscriber.queue.push(next); subscriber.wake?.(); }
  expect((await waiting).value).toEqual(next);
  await stream.return?.();
  expect(subscribers.size).toBe(0);
});

test("sizes are serialized once on insertion; scalar diagnostics and eviction do no serialization", () => {
  let serializations = 0;
  const item = { type: "commandExecution", toJSON() { serializations++; return { type: "commandExecution", command: "true" }; } };
  const window = new HostEventWindow(200);
  window.append({ kind: "item", seq: 1, turnId: "turn", phase: "completed", item });
  expect(serializations).toBe(1);
  for (let index = 0; index < 20; index++) { window.heapAttribution(); window.append(delta(index + 2)); }
  expect(serializations).toBe(1);
});

test("configuration is validated and new processes start with fresh byte counters", () => {
  for (const value of [undefined, "", "0", "-1", "NaN", "Infinity", "1.5"]) expect(hostEventWindowByteLimit(value)).toBe(HOST_EVENT_WINDOW_BYTES);
  expect(hostEventWindowByteLimit("8192")).toBe(8192);
  for (const value of [0, -1, Infinity]) expect(() => new HostEventWindow(value)).toThrow("positive safe integer");
  const source = `import { HostEventWindow } from ${JSON.stringify(import.meta.path.replace(/\.test\.ts$/, ".ts"))};
    const window = new HostEventWindow();
    console.log(JSON.stringify(window.heapAttribution()));
    window.append({kind: "delta", seq: 1, turnId: "t", text: "hello"});
    console.log(JSON.stringify(window.heapAttribution()));`;
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, LLV_HOST_EVENT_WINDOW_BYTES: "8192" } });
    expect(child.exitCode).toBe(0);
    const states = child.stdout.toString().trim().split("\n").map(line => JSON.parse(line));
    expect(states[0]).toEqual({ windowBytes: 0, windowByteLimit: 8192, trimmedEvents: 0 });
    expect(states[1].windowBytes).toBeGreaterThan(0);
  }
});

test("identical recorded large-output data stays below the per-host budget in repeated before/after measurements", () => {
  // 2500 events fit the previous count limit plus its 512-event slack.
  const recorded = Array.from({ length: 2500 }, (_, index) => JSON.stringify(toolEvent(index + 1)));
  const beforeBytes = recorded.reduce((sum, record) => sum + Buffer.byteLength(record), 0);
  const measurements: { beforeBytes: number; afterBytes: number; events: number; trimmed: number }[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const host = new HostEventWindow();
    for (const record of recorded) host.append(JSON.parse(record));
    const { windowBytes, trimmedEvents } = host.heapAttribution();
    expect(windowBytes).toBeLessThanOrEqual(HOST_EVENT_WINDOW_BYTES);
    expect(windowBytes).toBe(bytesOf(host.events));
    expect(windowBytes).toBeLessThan(beforeBytes / 8);
    expect(host.events.at(-1)!.seq).toBe(2500);
    expect(trimmedEvents).toBe(host.events.length);
    measurements.push({ beforeBytes, afterBytes: windowBytes, events: host.events.length, trimmed: trimmedEvents });
  }
  expect(measurements[1]).toEqual(measurements[0]);
  expect(measurements[2]).toEqual(measurements[0]);
  console.log("host-window recorded-data measurement (serialized UTF-8 bytes)", JSON.stringify(measurements));
});


test("delivery echoes, user content digests, callback requests, terminal voice and deltas stay exact beside a trimmed payload", () => {
  const text = "exact user text".repeat(1000);
  const events: RuntimeEvent[] = [
    { kind: "item", turnId: "turn", phase: "completed", seq: 1, codexItemIdentity: { threadId: "thread", turnId: "turn" },
      item: { type: "userMessage", id: "user", clientId: "send", content: [{ type: "text", text }] } },
    { kind: "item", turnId: "turn", phase: "completed", seq: 2, deliveryEcho: { operationId: "send", at: "2026-11-12T00:00:00.000Z", memberOperationIds: ["part"] },
      item: { type: "user", contentDigest: "exact-digest", message: { content: [{ type: "text", text }, { type: "tool_result", tool_use_id: "tool", content: text }] } } },
    { kind: "item", turnId: "turn", phase: "completed", seq: 3, item: { type: "agentMessage", text } },
    { kind: "attention", id: "request", method: "can_use_tool", attention: { input: { command: text } }, seq: 4 },
    { kind: "delta", turnId: "turn", text, seq: 5 },
  ];
  const window = new HostEventWindow();
  events.forEach(event => window.append(event));
  expect(window.events[0]).toBe(events[0]);
  expect(window.events[2]).toBe(events[2]);
  expect(window.events[3]).toBe(events[3]);
  expect(window.events[4]).toBe(events[4]);
  expect(window.events[1]).toMatchObject({ deliveryEcho: { operationId: "send", memberOperationIds: ["part"] },
    item: { contentDigest: "exact-digest", message: { content: [{ type: "text", text }, { type: "tool_result", tool_use_id: "tool", content: expect.stringContaining("[truncated;") }] } } });
  expect(window.heapAttribution().trimmedEvents).toBe(1);
});
