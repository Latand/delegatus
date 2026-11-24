import { afterAll, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { readAntigravityTranscriptLimits, readAntigravityTranscriptQuotaExhaustion } from "./antigravityTranscriptLimits";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-antigravity-transcript-limits-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function exhaustionLine(timestamp: string, message: string, resetsAt: number | null): string {
  const observedAt = Math.floor(Date.parse(timestamp) / 1000);
  return `${JSON.stringify({
    type: "session.quota_exhausted",
    timestamp,
    data: {
      turnId: `turn_${crypto.randomUUID().slice(0, 8)}`,
      code: "RESOURCE_EXHAUSTED",
      message,
      resetsAt,
      windowMinutes: 300,
      usedPercent: 100,
      observedAt,
    },
  })}\n`;
}

function writeSession(parent: string, id: string, contents: string, mtimeSec: number): string {
  const dir = path.join(parent, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, contents);
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

test("picks newest exhaustion across newest 5 sessions, skips truncated tail, and expires after resetsAt", () => {
  const parent = path.join(root, "ordering");
  fs.mkdirSync(parent, { recursive: true });
  const tOld = "2026-11-24T01:00:00.000Z";
  const tNew = "2026-11-24T02:00:00.000Z";
  const resetOld = Math.floor(Date.parse(tOld) / 1000) + 3600;
  const resetNew = Math.floor(Date.parse(tNew) / 1000) + 7200;

  // 6th oldest session (mtime 10) must not be inspected when 5 newer sessions exist.
  writeSession(parent, "s0-too-old", exhaustionLine("2026-11-24T05:00:00.000Z", "RESOURCE_EXHAUSTED: ignored", resetNew + 99_999), 10);
  writeSession(parent, "s1", exhaustionLine(tOld, "RESOURCE_EXHAUSTED: Resets in 1h", resetOld), 100);
  writeSession(parent, "s2", '{"type":"session.start","timestamp":"2026-11-24T01:10:00.000Z","data":{}}\n', 200);
  writeSession(parent, "s3", '{"type":"session.start","timestamp":"2026-11-24T01:20:00.000Z","data":{}}\n', 300);
  writeSession(parent, "s4", '{"type":"session.start","timestamp":"2026-11-24T01:30:00.000Z","data":{}}\n', 400);
  writeSession(
    parent,
    "s5-newest",
    exhaustionLine(tNew, "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h", resetNew)
      + '{"type":"session.quota_exhausted","timestamp":"2026-11-24T02:05:00.000Z","data":{"message":"truncated',
    500,
  );

  const raw = readAntigravityTranscriptQuotaExhaustion(parent);
  expect(raw?.observedAt).toBe(Math.floor(Date.parse(tNew) / 1000));
  expect(raw?.resetsAt).toBe(resetNew);
  // Caller mutation does not affect subsequent reads.
  raw!.message = "mutated";
  expect(readAntigravityTranscriptQuotaExhaustion(parent)?.message).toContain("Individual quota reached");

  const active = readAntigravityTranscriptLimits(parent, Date.parse(tNew) + 60_000, { tierName: "Pro" });
  expect(active).toEqual({
    source: "transcript",
    reason: null,
    data: {
      session: {
        usedPercent: 100,
        resetsAt: resetNew,
        windowMinutes: 300,
        observedAt: Math.floor(Date.parse(tNew) / 1000),
        source: "account",
      },
      weekly: null,
      tiers: [],
      plan: "Pro",
      capturedAt: Math.floor(Date.parse(tNew) / 1000),
    },
  });

  // After reset window elapses, limits clear cleanly to unavailable.
  const expired = readAntigravityTranscriptLimits(parent, resetNew * 1000 + 1000, { tierName: "Pro" });
  expect(expired).toEqual({
    data: null,
    source: "unavailable",
    reason: "antigravity quota reset window elapsed",
  });
});

test("bounds bytes read and UTF-8 decoding on a 20 MiB session without quota events", () => {
  const parent = path.join(root, "bounded-tail");
  const dir = path.join(parent, "huge-session");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  // Place an exhaustion record more than 17 MiB before EOF so the 16 MiB cap stops before it.
  const fd = fs.openSync(file, "w");
  try {
    const header = exhaustionLine("2026-11-24T01:00:00.000Z", "RESOURCE_EXHAUSTED: ancient", Math.floor(Date.parse("2026-11-24T06:00:00.000Z") / 1000));
    fs.writeSync(fd, header);
    const padLine = `${JSON.stringify({ type: "assistant.message", timestamp: "2026-11-24T01:01:00.000Z", data: { content: "x".repeat(4000) } })}\n`;
    const block = Buffer.from(padLine.repeat(256)); // ~1 MiB
    for (let i = 0; i < 18; i += 1) fs.writeSync(fd, block);
  } finally {
    fs.closeSync(fd);
  }

  const realToString = Buffer.prototype.toString;
  let decodedBytes = 0;
  const spy = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, encoding?: BufferEncoding, start?: number, end?: number) {
    decodedBytes += Math.max(0, (end ?? this.length) - (start ?? 0));
    return realToString.call(this, encoding, start, end);
  });
  try {
    const read = readAntigravityTranscriptLimits(parent, Date.parse("2026-11-24T02:00:00.000Z"));
    expect(read.source).toBe("unavailable");
    expect(read.data).toBeNull();
    // Repeated poll on an unchanged file hits the stat fingerprint cache (0 extra bytes read!).
    const readSpy = spyOn(fs, "readSync");
    try {
      const repeat = readAntigravityTranscriptLimits(parent, Date.parse("2026-11-24T02:00:05.000Z"));
      expect(repeat.source).toBe("unavailable");
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  } finally {
    spy.mockRestore();
  }
  expect(decodedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("remains consistent beside a concurrent transcript writer and across two SQLite registry connections", async () => {
  const parent = path.join(root, "concurrent");
  fs.mkdirSync(parent, { recursive: true });
  const t0 = "2026-11-24T03:00:00.000Z";
  const resetAt = Math.floor(Date.parse(t0) / 1000) + 5400;
  const file = writeSession(parent, "live-session", exhaustionLine(t0, "RESOURCE_EXHAUSTED: Resets in 1h 30m", resetAt), 1000);

  // Concurrent writer appends valid and partial lines while reader scans.
  const writer = (async () => {
    for (let i = 0; i < 20; i += 1) {
      fs.appendFileSync(file, `{"type":"assistant.message","timestamp":"2026-11-24T03:00:${String(i).padStart(2, "0")}.000Z","data":{"content":"chunk-${i}"}}\n`);
      await Promise.resolve();
    }
  })();
  const reads = Array.from({ length: 10 }, () => readAntigravityTranscriptLimits(parent, Date.parse(t0) + 30_000));
  await writer;
  for (const read of reads) {
    expect(read.source).toBe("transcript");
    expect(read.data?.session?.usedPercent).toBe(100);
    expect(read.data?.session?.resetsAt).toBe(resetAt);
  }

  // Second SQLite registry connection sees recorded Antigravity quota observation cleanly.
  const sqliteFile = path.join(root, "registry.sqlite");
  const jsonFile = path.join(root, "registry.json");
  const writerReg = new AgentRegistry(jsonFile, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sqliteFile });
  const readerReg = new AgentRegistry(jsonFile, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sqliteFile });
  try {
    const active = readAntigravityTranscriptLimits(parent, Date.parse(t0) + 30_000);
    writerReg.recordQuotaObservations([{
      engine: "antigravity",
      accountId: "default",
      authenticated: true,
      authCheckedAt: t0,
      observedAt: t0,
      bootId: "slice4-test",
      provenance: { source: "transcript", reason: null, staleSince: null },
      limits: active.data,
      resetCredits: null,
      limitReached: true,
    }]);
    const seen = readerReg.quotaObservations("antigravity");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      engine: "antigravity",
      accountId: "default",
      limitReached: true,
      limits: { session: { usedPercent: 100, resetsAt: resetAt, windowMinutes: 300 } },
    });
    // Mutating returned observation must not mutate stored state.
    seen[0]!.limits!.session!.usedPercent = 5;
    expect(readerReg.quotaObservations("antigravity")[0]?.limits?.session?.usedPercent).toBe(100);
  } finally {
    writerReg.close();
    readerReg.close();
  }
});

test("isolates per-file EIO errors and bounds warm directory scan stat calls across 256 sessions", () => {
  // 1. Per-file EIO isolation: unreadable file never throws and never hides another readable session.
  const eioDir = path.join(root, "eio-isolation");
  fs.mkdirSync(eioDir, { recursive: true });
  const t0 = "2026-11-24T04:00:00.000Z";
  const resetAt = Math.floor(Date.parse(t0) / 1000) + 3600;
  const broken = writeSession(eioDir, "broken-session", "{}\n", 2000);
  const brokenStat = fs.statSync(broken);

  const origReadSync = fs.readSync;
  fs.readSync = function (fd: number, ...rest: unknown[]) {
    const fdStat = fs.fstatSync(fd);
    if (fdStat.ino === brokenStat.ino && fdStat.dev === brokenStat.dev) {
      throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    }
    return (origReadSync as (...args: unknown[]) => number).call(fs, fd, ...rest);
  } as typeof fs.readSync;
  try {
    const onlyBroken = readAntigravityTranscriptLimits(eioDir, Date.parse(t0) + 10_000);
    expect(onlyBroken).toEqual({
      data: null,
      source: "unavailable",
      reason: "antigravity transcript read error",
    });

    // Adding a readable session with active exhaustion is discovered despite the broken sibling.
    writeSession(eioDir, "healthy-session", exhaustionLine(t0, "Individual quota reached. Resets in 1h", resetAt), 1900);
    const withHealthy = readAntigravityTranscriptLimits(eioDir, Date.parse(t0) + 10_000);
    expect(withHealthy.source).toBe("transcript");
    expect(withHealthy.data?.session?.usedPercent).toBe(100);
    expect(withHealthy.data?.session?.resetsAt).toBe(resetAt);
  } finally {
    fs.readSync = origReadSync;
  }

  // 2. Bounded warm metadata polling: 256 sessions do <= 5 file stats and 0 opens/reads on warm polls.
  const scaleDir = path.join(root, "scale-256");
  fs.mkdirSync(scaleDir, { recursive: true });
  const padLine = `${JSON.stringify({ type: "assistant.message", data: { content: "x".repeat(960) } })}\n`;
  for (let i = 0; i < 256; i += 1) {
    writeSession(scaleDir, `fixture-${i}`, i < 251 ? padLine : padLine.repeat(100), 1000 + i);
  }

  const origStatSync = fs.statSync;
  const origOpenSync = fs.openSync;
  let stats = 0;
  let opens = 0;
  let bytes = 0;
  fs.statSync = function (file: fs.PathLike, ...rest: unknown[]) {
    if (String(file).startsWith(`${scaleDir}/`)) stats += 1;
    return (origStatSync as (...args: unknown[]) => fs.Stats).call(fs, file, ...rest);
  } as typeof fs.statSync;
  fs.openSync = function (file: fs.PathLike, ...rest: unknown[]) {
    if (String(file).startsWith(`${scaleDir}/`)) opens += 1;
    return (origOpenSync as (...args: unknown[]) => number).call(fs, file, ...rest);
  } as typeof fs.openSync;
  fs.readSync = function (...args: unknown[]) {
    const read = (origReadSync as (...a: unknown[]) => number).apply(fs, args);
    bytes += read;
    return read;
  } as typeof fs.readSync;
  try {
    readAntigravityTranscriptLimits(scaleDir);
    expect(opens).toBeLessThanOrEqual(5);

    stats = 0;
    opens = 0;
    bytes = 0;
    readAntigravityTranscriptLimits(scaleDir);
    expect(stats).toBeLessThanOrEqual(5);
    expect(opens).toBe(0);
    expect(bytes).toBe(0);

    // Creating a new session subdirectory invalidates the dir cache immediately (nlink/mtime change).
    writeSession(scaleDir, "fixture-newest-after-warm", exhaustionLine(t0, "Individual quota reached. Resets in 1h", resetAt), 5000);
    const afterNewDir = readAntigravityTranscriptLimits(scaleDir, Date.parse(t0) + 10_000);
    expect(afterNewDir.source).toBe("transcript");
    expect(afterNewDir.data?.session?.usedPercent).toBe(100);
  } finally {
    fs.statSync = origStatSync;
    fs.openSync = origOpenSync;
    fs.readSync = origReadSync;
  }
});
