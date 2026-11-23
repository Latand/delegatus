import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";
import { RuntimeReplayGapError, type RuntimeEvent } from "./engineHost";
import { createEngineHostLedgerProjection } from "./engineHostEvents";
import { attachRuntimeEvents, HostEventWindow, runtimeEventsAfter, type RuntimeEventSubscriber } from "./hostEventWindow";

const event = (seq: number, text = `part ${seq}`): Extract<RuntimeEvent, { kind: "delta" }> => ({ kind: "delta", turnId: "turn", text, seq });
const hash = (events: readonly RuntimeEvent[]) => createHash("sha256").update(events.map(e => JSON.stringify(e)).join("")).digest("hex");
function pausedStore(events: RuntimeEvent[]) {
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const store: RuntimeEventStore = {
    load: () => events.slice(), append: (_id, e) => { events.push(e); },
    scan: async (_id, visit) => {
      const snapshot = events.slice();
      for (const e of snapshot) visit(e);
      await paused;
      return snapshot.at(-1)?.seq ?? 0;
    },
  };
  return { store, resume };
}

test("production-shaped history has identical suffix, previews, hash and final cursor after streaming refill", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "window-stream-"));
  const filename = path.join(directory, "thread.jsonl");
  const fd = fs.openSync(filename, "w");
  try {
    for (let seq = 1; seq <= 2455; seq++) {
      const e: RuntimeEvent = seq % 3 ? event(seq, "ї🌱".repeat(1500)) : {
        kind: "item", phase: "completed", turnId: "turn", seq,
        item: { type: "commandExecution", id: `item-${seq}`, aggregatedOutput: "output".repeat(3000), exitCode: 0 },
      };
      fs.writeSync(fd, `${JSON.stringify(e)}\n`);
    }
  } finally { fs.closeSync(fd); }
  const store = new FileRuntimeEventStore(directory);
  const expected = new HostEventWindow();
  expected.restore(store.load("thread"));
  const window = new HostEventWindow();
  window.append(event(2455));
  window.release();
  await window.refill(store, "thread");
  expect(window.events.map(e => e.seq)).toEqual(expected.events.map(e => e.seq));
  expect(hash(window.events)).toBe(hash(expected.events));
  expect(window.heapAttribution()).toEqual(expected.heapAttribution());
  expect(window.events.at(-1)?.seq).toBe(2455);
  expect(runtimeEventsAfter(window.events, 2454, () => { throw new Error("unexpected ledger read"); })).toEqual([expected.events.at(-1)!]);
  expect(runtimeEventsAfter(window.events, 0, () => store.load("thread"))).toHaveLength(2455);
});

test("short or corrupt history keeps the released cursor and retries from recovered state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "window-recovery-"));
  const filename = path.join(directory, "thread.jsonl");
  const store = new FileRuntimeEventStore(directory);
  const window = new HostEventWindow();
  window.append(event(3)); window.release();
  await expect(window.refill(store, "thread")).rejects.toBeInstanceOf(RuntimeReplayGapError);
  fs.writeFileSync(filename, `${JSON.stringify(event(1))}\n`);
  await expect(window.refill(store, "thread")).rejects.toBeInstanceOf(RuntimeReplayGapError);
  fs.writeFileSync(filename, `{broken}\n${JSON.stringify(event(3))}\n`);
  await expect(window.refill(store, "thread")).rejects.toThrow("malformed JSON");
  expect(window.events).toEqual([]);
  fs.writeFileSync(filename, [1, 2, 3].map(seq => JSON.stringify(event(seq))).join("\n") + "\n{partial");
  await window.refill(new FileRuntimeEventStore(directory), "thread");
  expect(window.events.map(e => e.seq)).toEqual([1, 2, 3]);
  expect(() => runtimeEventsAfter(window.events, 0, () => [])).not.toThrow();
});

test.each(["suffix", "evicted-prefix", "oversized"])("live events during refill preserve the bounded window: %s", async mode => {
  const history = [event(1), event(2)];
  const f = pausedStore(history);
  const window = new HostEventWindow(350);
  window.restore(history); window.release();
  const pending = window.refill(f.store, "thread");
  const expected = new HostEventWindow(350); expected.restore(history);
  const writes = mode === "oversized" ? [event(3, "x".repeat(1000))]
    : Array.from({ length: mode === "suffix" ? 1 : 10 }, (_, i) => event(i + 3));
  for (const e of writes) { f.store.append("thread", e); window.append(e); expected.append(e); }
  f.resume(); await pending;
  expect(window.events).toEqual(expected.events);
  expect(window.heapAttribution()).toEqual(expected.heapAttribution());
  window.release();
  await expect(window.refill({ ...f.store, scan: async () => 2 }, "thread")).rejects.toBeInstanceOf(RuntimeReplayGapError);
});

test("failed refill preserves live events and older replay gaps remain visible", async () => {
  const window = new HostEventWindow(); window.append(event(3)); window.release();
  const f = pausedStore([event(1)]);
  const pending = window.refill(f.store, "thread");
  window.append(event(4)); f.resume();
  await expect(pending).rejects.toBeInstanceOf(RuntimeReplayGapError);
  expect(window.events).toEqual([event(4)]);
  expect(() => runtimeEventsAfter(window.events, 0, () => [event(3)])).toThrow(RuntimeReplayGapError);
});

test("deferred attach subscribes once refill finishes, deduplicates live replay and cancels before readiness", async () => {
  const window = new HostEventWindow(); window.append(event(1)); window.release();
  const f = pausedStore([event(1)]);
  const subscribers = new Set<RuntimeEventSubscriber>();
  const source = { window: () => window.events, ledger: () => f.store.load("thread"), subscribers };
  const ready = window.refill(f.store, "thread");
  const reader = attachRuntimeEvents(0, source, () => ready)[Symbol.asyncIterator]();
  const cancelled = attachRuntimeEvents(0, source, () => ready)[Symbol.asyncIterator]();
  expect(await cancelled.return!()).toEqual({ done: true, value: undefined });
  window.append(event(2)); f.store.append("thread", event(2));
  f.resume();
  expect((await reader.next()).value).toEqual(event(1));
  expect((await reader.next()).value).toEqual(event(2));
  expect(subscribers.size).toBe(1);
  await reader.return!();
  expect(subscribers.size).toBe(0);
});

test("deferred attach reports restoration errors and leaves no subscriber", async () => {
  const subscribers = new Set<RuntimeEventSubscriber>();
  const reader = attachRuntimeEvents(0, { window: () => [], ledger: () => [], subscribers }, () => Promise.reject(new Error("invalid prefix")))[Symbol.asyncIterator]();
  await expect(reader.next()).rejects.toThrow("invalid prefix");
  expect(subscribers.size).toBe(0);
});

test("refill projects restored items before previewing and retains a cursor with an empty byte window", async () => {
  const f = pausedStore([event(1, "x".repeat(1000))]);
  const window = new HostEventWindow(100);
  const pending = window.refill(f.store, "thread", e => ({ ...e, activityAt: null } as RuntimeEvent));
  f.resume(); await pending;
  expect(window.events).toEqual([]);
  expect(() => runtimeEventsAfter(window.events, 0, () => [])).toThrow(RuntimeReplayGapError);
});


test("an append included in the descriptor snapshot keeps its original live payload", async () => {
  const window = new HostEventWindow(); window.append(event(1)); window.release();
  const live = event(2, "original live text");
  const store: RuntimeEventStore = { load: () => [], append: () => {}, scan: async (_id, visit) => {
    await Promise.resolve();
    visit(event(1)); visit(event(2, "durable projection"));
    return 2;
  } };
  const pending = window.refill(store, "thread");
  window.append(live);
  await pending;
  expect(window.events).toEqual([event(1), live]);
});


test("an oversized live append included in the snapshot cannot resurrect older projected events", async () => {
  const window = new HostEventWindow(200); window.append(event(1)); window.release();
  const store: RuntimeEventStore = { load: () => [], append: () => {}, scan: async (_id, visit) => {
    await Promise.resolve();
    visit(event(1)); visit(event(2, "small durable projection"));
    return 2;
  } };
  const pending = window.refill(store, "thread");
  window.append(event(2, "x".repeat(1000)));
  await pending;
  expect(window.events).toEqual([]);
  expect(() => runtimeEventsAfter(window.events, 0, () => [])).toThrow(RuntimeReplayGapError);
});

test.each([240, 6 * 1024 * 1024])("a retained live original survives candidate eviction at the %s byte limit", async byteLimit => {
  const first = event(1);
  const liveTwo = event(2, "x");
  const baseThree = event(3, "");
  const baseFour = event(4, "");
  const remaining = byteLimit - [liveTwo, baseThree, baseFour].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  expect(remaining).toBeGreaterThan(8);
  const liveThree = event(3, "a".repeat(Math.floor(remaining / 2)));
  const liveFour = event(4, "b".repeat(remaining - Math.floor(remaining / 2)));
  const live = [liveTwo, liveThree, liveFour];
  const durable = [{ ...liveTwo, text: `${liveTwo.text}12345678` }, liveThree, liveFour];
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const history: RuntimeEvent[] = [first];
  const store: RuntimeEventStore = {
    load: () => history.slice(),
    append: (_id, value) => { history.push(value); },
    scan: async (_id, visit) => {
      await gate;
      const snapshot = history.slice();
      for (const value of snapshot) visit(value);
      return snapshot.at(-1)?.seq ?? 0;
    },
  };
  const window = new HostEventWindow(byteLimit);
  window.append(first);
  window.release();
  const pending = window.refill(store, "thread");
  for (const [index, value] of live.entries()) {
    store.append("thread", durable[index]!);
    window.append(value);
  }
  resume();
  await pending;
  expect(window.events).toEqual(live);
  expect(window.heapAttribution().windowBytes).toBe(byteLimit);
});

test.each([240, 6 * 1024 * 1024])("overlapping durable projections preserve historical rows at the %s byte limit", async byteLimit => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "window-overlap-"));
  const store = new FileRuntimeEventStore(directory);
  const project = createEngineHostLedgerProjection();
  // The projector holds eight characters for the next delta in this turn.
  const first = project(event(1, "h".repeat(14) + "[1234567"));
  const liveTwo = event(2, "]" + "x".repeat(7));
  const durableTwo = project(liveTwo);
  const size = (value: RuntimeEvent) => Buffer.byteLength(JSON.stringify(value));
  expect(size(first)).toBe(64);
  expect(size(liveTwo)).toBe(58);
  expect(size(durableTwo)).toBe(66);
  const liveThree = event(3, "a".repeat(byteLimit - size(first) - size(liveTwo) - size(event(3, ""))));
  store.append("thread", first);
  const expected = new HostEventWindow(byteLimit);
  expected.restore([first, liveTwo, liveThree]);
  const window = new HostEventWindow(byteLimit);
  window.append(first);
  window.release();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let scans = 0;
  let loads = 0;
  const pending = window.refill({
    append: (id, value) => store.append(id, value),
    load: () => { loads++; throw new Error("unexpected ledger load"); },
    scan: async (id, visit) => { scans++; await gate; return store.scan(id, visit); },
  }, "thread");
  store.append("thread", durableTwo);
  window.append(liveTwo);
  store.append("thread", project(liveThree));
  window.append(liveThree);
  resume();
  await pending;
  expect(scans).toBe(1);
  expect(loads).toBe(0);
  expect(window.events.map(value => value.seq)).toEqual([1, 2, 3]);
  expect(hash(window.events)).toBe(hash(expected.events));
  expect(window.heapAttribution()).toEqual(expected.heapAttribution());
  expect(window.heapAttribution().windowBytes).toBe(byteLimit);
  expect(runtimeEventsAfter(window.events, 0, () => { throw new Error("unexpected replay read"); })).toEqual(expected.events);
});

test("invalid attach cursors cannot start an unobserved refill", () => {
  let reads = 0;
  expect(() => attachRuntimeEvents(-1, { window: () => [], ledger: () => [], subscribers: new Set() }, () => {
    reads++;
    return Promise.reject(new Error("unobserved"));
  })).toThrow("afterSeq must be a non-negative integer");
  expect(reads).toBe(0);
});
