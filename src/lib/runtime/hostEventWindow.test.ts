import { expect, test } from "bun:test";

import { RuntimeReplayGapError, type RuntimeEvent } from "./engineHost";
import {
  attachRuntimeEvents,
  assertReleasedHostEventLedger,
  boundMap,
  HOST_EVENT_WINDOW,
  runtimeEventsAfter,
  releaseHostEventWindow,
  trimHostEventWindow,
  type RuntimeEventSubscriber,
} from "./hostEventWindow";

const delta = (seq: number): RuntimeEvent => ({ kind: "delta", turnId: "turn", text: `part ${seq}`, seq });

/** A host's ledger and its in-memory window, kept the way the hosts keep them. */
function source(count: number) {
  const ledger: RuntimeEvent[] = [];
  const window: RuntimeEvent[] = [];
  const subscribers = new Set<RuntimeEventSubscriber>();
  let ledgerReads = 0;
  const emit = () => {
    const event = delta(ledger.length + 1);
    ledger.push(event);
    window.push(event);
    trimHostEventWindow(window);
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

for (const afterSeq of [0, 7]) test(`empty-window UI replay and producer cursor ${afterSeq} read the ledger`, async () => {
  const host = source(12);
  host.window.length = 0;
  expect(runtimeEventsAfter(host.window, afterSeq, host.events.ledger)).toEqual(host.ledger.slice(afterSeq));
  const stream = attachRuntimeEvents(afterSeq, host.events)[Symbol.asyncIterator]();
  try {
    expect(await take(stream, 12 - afterSeq)).toEqual(host.ledger.slice(afterSeq).map(event => event.seq));
    host.emit();
    expect(await take(stream, 1)).toEqual([13]);
  } finally { await stream.return?.(); }
});

test("an emptied window retains replay-gap refusal for a truncated ledger", () => {
  expect(() => runtimeEventsAfter([], 0, () => [delta(4)])).toThrow(RuntimeReplayGapError);
});

test("released windows refuse missing and shortened ledgers until the acknowledged cursor", () => {
  const events = [delta(1), delta(2), delta(3)];
  releaseHostEventWindow(events);
  expect(() => runtimeEventsAfter(events, 0, () => [])).toThrow(RuntimeReplayGapError);
  expect(() => runtimeEventsAfter(events, 0, () => [delta(1)])).toThrow(RuntimeReplayGapError);
  expect(runtimeEventsAfter(events, 3, () => [])).toEqual([]);
});

test("refill refuses a shortened ledger and can retry when its tail returns", () => {
  const events = [delta(1), delta(2)];
  releaseHostEventWindow(events);
  expect(() => assertReleasedHostEventLedger(events, [delta(1)])).toThrow(RuntimeReplayGapError);
  expect(events).toEqual([]);
  expect(() => assertReleasedHostEventLedger(events, [delta(1), delta(2)])).not.toThrow();
});
