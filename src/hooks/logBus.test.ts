/**
 * Stream reconnect pacing on the shared log bus (#1432): a subscriber that
 * arrives on a settled stream — the operator switching conversations — must
 * not wait the churn-coalescing window before its pane goes live.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

class FakeEventSource {
  static connects: Array<{ at: number; subs: Array<{ path: string; offset: number }> }> = [];
  static last: FakeEventSource | null = null;
  private closed = false;
  private opens: Array<() => void> = [];
  constructor(url: string) {
    const subs = JSON.parse(new URL(url, "http://localhost").searchParams.get("subs") ?? "[]") as Array<{ path: string; offset: number }>;
    FakeEventSource.connects.push({ at: Date.now(), subs });
    FakeEventSource.last = this;
  }
  open(): void { for (const listener of this.opens) listener(); }
  addEventListener(type: string, listener: () => void): void { if (type === "open") this.opens.push(listener); }
  removeEventListener(): void {}
  close(): void { this.closed = true; }
  onerror: (() => void) | null = null;
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const { subscribeLog } = await import("./logBus");
type LogBusResult = Parameters<Parameters<typeof subscribeLog>[0]["onChunk"]>[0];

const subscriber = (path: string, offset = 0) => ({ path, getOffset: () => offset, onChunk: () => {} });
let unsubscribes: Array<() => void> = [];
const subscribe = (path: string, offset = 0) => {
  const off = subscribeLog(subscriber(path, offset));
  unsubscribes.push(off);
  return off;
};
const connectsAtOrBefore = (ms: number) => FakeEventSource.connects.filter((entry) => entry.at <= ms).length;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  FakeEventSource.connects = [];
});

const realFetch = globalThis.fetch;
afterEach(() => {
  /* Dropping the last subscriber stops every transport, so the module's
     state is idle for the next test. */
  for (const off of unsubscribes.splice(0)) off();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

test("the first subscriber on a settled stream connects on the short window", () => {
  subscribe("/sessions/a.jsonl");
  jest.advanceTimersByTime(39);
  expect(FakeEventSource.connects.length).toBe(0);
  jest.advanceTimersByTime(1);
  expect(FakeEventSource.connects.length).toBe(1);
  expect(FakeEventSource.connects[0]!.subs.map((sub) => sub.path)).toEqual(["/sessions/a.jsonl"]);
});

test("a burst of subscribers in one tick shares one prompt connection", () => {
  subscribe("/sessions/a.jsonl");
  subscribe("/sessions/b.jsonl", 128);
  subscribe("/sessions/c.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  expect(FakeEventSource.connects[0]!.subs.length).toBe(3);
});

test("a subscriber arriving while the stream is fresh waits the long window; one arriving after it is prompt again", () => {
  subscribe("/sessions/a.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  /* 100 ms after the connect: churn territory — coalesce on the long window. */
  jest.advanceTimersByTime(100);
  subscribe("/sessions/b.jsonl");
  jest.advanceTimersByTime(200);
  expect(connectsAtOrBefore(340)).toBe(1);
  jest.advanceTimersByTime(100);
  expect(FakeEventSource.connects.length).toBe(2);
  expect(FakeEventSource.connects[1]!.at).toBe(440);
  /* Well after that reconnect: a switch, served promptly. */
  jest.advanceTimersByTime(1000);
  subscribe("/sessions/c.jsonl", 512);
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(3);
  expect(FakeEventSource.connects[2]!.at).toBe(1480);
});

test("an unsubscribe alone never triggers a prompt reconnect", () => {
  subscribe("/sessions/a.jsonl");
  const offB = subscribe("/sessions/b.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  jest.advanceTimersByTime(1000);
  offB();
  unsubscribes = unsubscribes.filter((off) => off !== offB);
  jest.advanceTimersByTime(299);
  expect(FakeEventSource.connects.length).toBe(1);
  jest.advanceTimersByTime(1);
  expect(FakeEventSource.connects.length).toBe(2);
});

/* A feed with no rows draws whatever its subscription last heard, so a stream
   that cannot connect must not report a failure the polled route then
   contradicts (the phone's launch drew the error for one frame under load). */
describe("a stream that fails", () => {
  const CHUNK = { data: "{}\n", start: 0, offset: 3, size: 3 };
  const heard: LogBusResult[] = [];
  const listen = () => unsubscribes.push(subscribeLog({ path: "/sessions/a.jsonl", getOffset: () => 0, onChunk: (result) => heard.push(result) }));
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
  beforeEach(() => { heard.length = 0; });

  test("before it opens leaves the feeds to the polled answer", async () => {
    globalThis.fetch = (async () => Response.json({ chunks: { 0: CHUNK } })) as unknown as typeof fetch;
    listen();
    jest.advanceTimersByTime(40);
    FakeEventSource.last!.onerror!();
    expect(heard).toEqual([]);
    jest.advanceTimersByTime(0);
    await settle();
    expect(heard).toEqual([CHUNK]);
  });

  test("before it opens, with the polled route failing too, reports the transport error once", async () => {
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    listen();
    jest.advanceTimersByTime(40);
    FakeEventSource.last!.onerror!();
    jest.advanceTimersByTime(0);
    await settle();
    expect(heard).toEqual([{ transportError: true }]);
  });

  test("after it opened reports the transport error at once", () => {
    globalThis.fetch = (async () => Response.json({ chunks: { 0: CHUNK } })) as unknown as typeof fetch;
    listen();
    jest.advanceTimersByTime(40);
    FakeEventSource.last!.open();
    FakeEventSource.last!.onerror!();
    expect(heard).toEqual([{ transportError: true }]);
  });
});
