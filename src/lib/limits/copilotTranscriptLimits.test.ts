import { afterAll, expect, test, spyOn } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCopilotTranscriptLimits } from "./copilotTranscriptLimits";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-transcript-limits-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function session(timestamp: string, remaining: number, body = ""): string {
  const quotaSnapshots = { chat: { entitlementRequests: 200, remainingPercentage: remaining, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false } };
  const data = { responseUsage: {}, requestMessages: body, quotaSnapshots, requestId: crypto.randomUUID(), copilotUsage: {} };
  return `${JSON.stringify({ type: "model.model_call_success", data, id: crypto.randomUUID(), timestamp, parentId: null })}\n`;
}

function writeSession(parent: string, id: string, contents: string, mtime: number): void {
  const dir = path.join(parent, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, contents);
  fs.utimesSync(file, mtime, mtime);
}

test("reads quota JSON without parsing a multi-megabyte requestMessages value", () => {
  const parent = path.join(root, "large");
  fs.mkdirSync(parent, { recursive: true });
  writeSession(parent, "large-session", session("2026-09-03T10:00:00.000Z", 99.8, "x".repeat(5 * 1024 * 1024)), 100);
  const realParse = JSON.parse;
  const parse = spyOn(JSON, "parse");
  try {
    parse.mockImplementation(((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => realParse(text, reviver)) as typeof JSON.parse);
    const result = readCopilotTranscriptLimits(parent);
    expect(result.source).toBe("transcript");
    expect(result.data?.weekly?.usedPercent).toBeCloseTo(0.2);
    expect(parse.mock.calls.some(([value]) => typeof value === "string" && value.length > 10_000)).toBe(false);
  } finally { parse.mockRestore(); }
});

test("newest timestamp wins across session files and a truncated tail is skipped", () => {
  const parent = path.join(root, "ordering");
  fs.mkdirSync(parent, { recursive: true });
  writeSession(parent, "older", session("2026-09-03T10:00:00.000Z", 80), 100);
  writeSession(parent, "newer", session("2026-09-04T10:00:00.000Z", 40) + '{"type":"model.model_call_success","data":{"requestMessages":"","quotaSnapshots":{"chat":', 200);
  const result = readCopilotTranscriptLimits(parent);
  expect(result.data?.weekly?.usedPercent).toBe(60);
  expect(result.data?.capturedAt).toBe(Date.parse("2026-09-04T10:00:00.000Z") / 1000);
});

test("returns unavailable with a bounded newest-file reason when snapshots are absent", () => {
  const parent = path.join(root, "empty");
  writeSession(parent, "session", '{"timestamp":"2026-09-03T10:00:00.000Z","type":"session.start"}\n', 100);
  expect(readCopilotTranscriptLimits(parent)).toMatchObject({
    data: null,
    source: "unavailable",
    reason: "no quotaSnapshots in newest 1 session files",
  });
});

test("bounds UTF-8 decoding while scanning a 16 MiB tail without quota keys", () => {
  const parent = path.join(root, "bounded-tail");
  const dir = path.join(parent, "session");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, 16 * 1024 * 1024);
  const realToString = Buffer.prototype.toString;
  let decodedBytes = 0;
  const toString = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, encoding?: BufferEncoding, start?: number, end?: number) {
    decodedBytes += Math.max(0, (end ?? this.length) - (start ?? 0));
    return realToString.call(this, encoding, start, end);
  });
  try {
    expect(readCopilotTranscriptLimits(parent).source).toBe("unavailable");
  } finally { toString.mockRestore(); }
  expect(decodedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});
