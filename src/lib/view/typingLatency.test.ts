import { expect, test } from "bun:test";

import { createTypingLatencyLog, MAX_TYPING_SAMPLES, TYPING_LOG_LIMIT, TYPING_LOG_WINDOW_MS, validateTypingLatency } from "./typingLatency";

const sample = { at: 1_792_000_000_000, ms: 88, delayMs: 40, animations: 4 };

test("a report of numeric samples is accepted as sent", () => {
  expect(validateTypingLatency({ schemaVersion: 1, samples: [sample] })).toEqual({ schemaVersion: 1, samples: [sample] });
});

test("nothing typed can ride along: unknown keys at either level are refused", () => {
  expect(() => validateTypingLatency({ schemaVersion: 1, samples: [sample], text: "secret" })).toThrow(/unknown request\.text/);
  expect(() => validateTypingLatency({ schemaVersion: 1, samples: [{ ...sample, value: "secret" }] })).toThrow(/unknown samples\[0\]\.value/);
});

test("strings, fractions, negatives and out-of-range numbers are refused", () => {
  for (const bad of [{ ms: "88" }, { ms: 8.5 }, { ms: -1 }, { ms: 10_000_000 }, { animations: 1e9 }, { at: "now" }, { delayMs: null }]) {
    expect(() => validateTypingLatency({ schemaVersion: 1, samples: [{ ...sample, ...bad }] })).toThrow();
  }
});

test("an empty report, an oversized one and a wrong version are refused", () => {
  expect(() => validateTypingLatency({ schemaVersion: 1, samples: [] })).toThrow();
  expect(() => validateTypingLatency({ schemaVersion: 1, samples: Array.from({ length: MAX_TYPING_SAMPLES + 1 }, () => sample) })).toThrow();
  expect(() => validateTypingLatency({ schemaVersion: 2, samples: [sample] })).toThrow(/schemaVersion/);
  expect(() => validateTypingLatency([sample])).toThrow();
  expect(() => validateTypingLatency(null)).toThrow();
});

test("the log writes a line with the slowest sample and caps lines per window", () => {
  const lines: string[] = [];
  let now = 1_000;
  const log = createTypingLatencyLog((line) => lines.push(line), () => now);
  const report = validateTypingLatency({ schemaVersion: 1, samples: [sample, { ...sample, ms: 140 }] });
  expect(log.record(report)).toBe(true);
  expect(lines[0]).toMatch(/^\[typing-latency\] /);
  expect(JSON.parse(lines[0]!.slice("[typing-latency] ".length))).toMatchObject({ slowestMs: 140, droppedReports: 0 });
  for (let n = 1; n < TYPING_LOG_LIMIT; n++) expect(log.record(report)).toBe(true);
  expect(log.record(report)).toBe(false);
  expect(log.record(report)).toBe(false);
  expect(lines.length).toBe(TYPING_LOG_LIMIT);
  now += TYPING_LOG_WINDOW_MS;
  expect(log.record(report)).toBe(true);
  expect(JSON.parse(lines.at(-1)!.slice("[typing-latency] ".length)).droppedReports).toBe(2);
});
