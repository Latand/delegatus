import { expect, test } from "bun:test";

import {
  createTypingLatencyBeacon, FLUSH_INTERVAL_MS, MAX_REPORTS_PER_SESSION, MAX_SAMPLES_PER_REPORT, SLOW_INPUT_MS, TYPING_LATENCY_PATH,
  type TypingLatencyEnvironment,
} from "./typingLatencyBeacon";

/* A stand-in for the page: entries are fed by hand, time is a list of timers
   the test fires, and what is sent is recorded as the exact JSON string. */
function page() {
  let feed: ((entries: readonly PerformanceEventTiming[]) => void) | null = null;
  const timers = new Map<number, () => void>();
  let next = 1;
  let hidden: (() => void) | null = null;
  const sent: { path: string; body: string }[] = [];
  const environment: TypingLatencyEnvironment = {
    observe(onEntries) { feed = onEntries; return () => { feed = null; }; },
    send(path, body) { sent.push({ path, body }); },
    setTimeout(callback) { const id = next++; timers.set(id, callback); return id; },
    clearTimeout(handle) { timers.delete(handle as number); },
    onHidden(callback) { hidden = callback; return () => { hidden = null; }; },
    animations: () => 3,
    timeOrigin: () => 1_000_000,
  };
  const field = { hasAttribute: (name: string) => name === "data-composer-field" };
  const other = { hasAttribute: () => false };
  return {
    environment, sent, timers,
    field, other,
    entry(target: unknown, duration: number, name = "input", startTime = 500, processingStart = 520) {
      return { name, duration, startTime, processingStart, target } as unknown as PerformanceEventTiming;
    },
    feed: (entries: PerformanceEventTiming[]) => feed?.(entries),
    fireTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    hide: () => hidden?.(),
  };
}

test("a slow input event in the composer field becomes a numbers-only sample, sent once after the interval", () => {
  const p = page();
  const { field } = p;
  const beacon = createTypingLatencyBeacon(p.environment);
  beacon.start();
  p.feed([p.entry(field, SLOW_INPUT_MS + 8)]);
  expect(p.sent).toEqual([]);
  expect(p.timers.size).toBe(1);
  p.fireTimers();
  expect(p.sent.length).toBe(1);
  expect(p.sent[0]!.path).toBe(TYPING_LATENCY_PATH);
  expect(JSON.parse(p.sent[0]!.body)).toEqual({ schemaVersion: 1, samples: [{ at: 1_000_500, ms: SLOW_INPUT_MS + 8, delayMs: 20, animations: 3 }] });
});

test("fast events, other event kinds and other elements are ignored", () => {
  const p = page();
  const { field, other } = p;
  createTypingLatencyBeacon(p.environment).start();
  p.feed([
    p.entry(field, SLOW_INPUT_MS - 1),
    p.entry(field, 500, "pointerdown"),
    p.entry(field, 500, "keydown"),
    p.entry(other, 500),
    p.entry(null, 500),
  ]);
  expect(p.timers.size).toBe(0);
  expect(p.sent).toEqual([]);
});

test("a report holds at most the sample bound and the session at most the report bound", () => {
  const p = page();
  const { field } = p;
  const beacon = createTypingLatencyBeacon(p.environment);
  beacon.start();
  for (let report = 0; report < MAX_REPORTS_PER_SESSION + 5; report++) {
    p.feed(Array.from({ length: MAX_SAMPLES_PER_REPORT + 4 }, () => p.entry(field, 200)));
    p.fireTimers();
  }
  expect(p.sent.length).toBe(MAX_REPORTS_PER_SESSION);
  for (const message of p.sent) expect(JSON.parse(message.body).samples.length).toBe(MAX_SAMPLES_PER_REPORT);
});

test("a page going hidden sends what it has at once, and stop sends the rest and unsubscribes", () => {
  const p = page();
  const { field } = p;
  const beacon = createTypingLatencyBeacon(p.environment);
  beacon.start();
  p.feed([p.entry(field, 120)]);
  p.hide();
  expect(p.sent.length).toBe(1);
  expect(p.timers.size).toBe(0);
  p.feed([p.entry(field, 130)]);
  beacon.stop();
  expect(p.sent.length).toBe(2);
  p.feed([p.entry(field, 140)]);
  p.fireTimers();
  expect(p.sent.length).toBe(2);
});

test("a transport that throws costs a sample, never an error", () => {
  const p = page();
  const { field } = p;
  const beacon = createTypingLatencyBeacon({ ...p.environment, send() { throw new Error("offline"); } });
  beacon.start();
  p.feed([p.entry(field, 120)]);
  expect(() => p.fireTimers()).not.toThrow();
});

test("the interval between reports is the documented one", () => {
  expect(FLUSH_INTERVAL_MS).toBe(30_000);
});
