import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { historySamples, historySince, readHistory, recordLimitSample, RETENTION_S } from "./limitsHistoryStore";
import type { EngineLimits } from "./types";

let dir: string;
const prev = process.env.LLV_STATE_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-history-"));
  process.env.LLV_STATE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

const limits = (session: number, weekly: number): EngineLimits => ({
  session: { usedPercent: session, resetsAt: null },
  weekly: { usedPercent: weekly, resetsAt: null },
  plan: "pro",
  capturedAt: null,
});

test("records a remaining-quota sample per window and persists it", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", limits(20, 40), t0);
  expect(historySamples("claude", "acct", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 80 }]);
  expect(historySamples("claude", "acct", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 60 }]);
  expect(historySince()).toBe(new Date(t0).toISOString());
  // Survives a fresh read of the file.
  expect(readHistory().series["claude|acct|session"]).toHaveLength(1);
});

test("downsamples samples closer than five minutes apart", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("codex", "acct", limits(10, 10), t0);
  recordLimitSample("codex", "acct", limits(11, 11), t0 + 60_000); // +1 min → dropped
  recordLimitSample("codex", "acct", limits(12, 12), t0 + 6 * 60_000); // +6 min → kept
  expect(historySamples("codex", "acct", "session", (t0 + 6 * 60_000) / 1000)).toEqual([
    { t: t0 / 1000, remaining: 90 },
    { t: (t0 + 6 * 60_000) / 1000, remaining: 88 },
  ]);
});

test("prunes samples older than the retention window on write", () => {
  const old = 1_700_000_000; // seconds
  const now = old + RETENTION_S + 3600; // just past retention
  recordLimitSample("claude", "acct", limits(50, 50), old * 1000);
  recordLimitSample("claude", "acct", limits(60, 60), now * 1000);
  const kept = readHistory().series["claude|acct|session"];
  expect(kept).toEqual([{ t: now, remaining: 40 }]);
});

test("keeps per-account series separate", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("codex", "a", limits(10, 10), t0);
  recordLimitSample("codex", "b", limits(20, 20), t0);
  expect(historySamples("codex", "a", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 90 }]);
  expect(historySamples("codex", "b", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 80 }]);
});

test("skips windows with no numeric usage", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", { session: null, weekly: { usedPercent: 25, resetsAt: null }, plan: null, capturedAt: null }, t0);
  expect(historySamples("claude", "acct", "session", t0 / 1000)).toEqual([]);
  expect(historySamples("claude", "acct", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 75 }]);
});

test("replaces the history file whole so a reader in another process never sees a torn write", () => {
  // The Viewer and the account-controller sidecar both record samples. A reader
  // that opened the file before the other process wrote must keep reading the
  // complete history it opened; a truncate-in-place write would hand it an
  // empty or half-written file, which readHistory treats as no history at all.
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", limits(20, 40), t0);
  const file = path.join(dir, "limits-history.json");
  const reader = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(reader).ino;
    recordLimitSample("claude", "other", limits(30, 30), t0 + 6 * 60_000);
    expect(fs.statSync(file).ino).not.toBe(opened);
    const seenByReader = JSON.parse(fs.readFileSync(reader, "utf8"));
    expect(Object.keys(seenByReader.series).sort()).toEqual(["claude|acct|session", "claude|acct|weekly"]);
  } finally {
    fs.closeSync(reader);
  }
  expect(Object.keys(readHistory().series)).toHaveLength(4);
  expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
