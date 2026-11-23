import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { historySamples, historySince, readHistory, recordLimitSample, recordLimitSamples, resetLimitsHistoryStoreForTests, RETENTION_S } from "./limitsHistoryStore";
import { readStateCollectionRevision } from "./state/sqliteStateStore";
import type { EngineLimits } from "./types";

let dir: string;
const prev = process.env.LLV_STATE_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-history-"));
  process.env.LLV_STATE_DIR = dir;
});

afterEach(() => {
  resetLimitsHistoryStoreForTests();
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

test("a batch appends every account in one transaction and retains the five-minute gap", () => {
  const t = 1_700_000_000_000;
  const revision = () => readStateCollectionRevision(path.join(dir, "state.sqlite"), "limits_history");
  recordLimitSamples("codex", [{ accountId: "a", source: "live", limits: limits(10,20) }, { accountId: "b", source: "live", limits: limits(30,40) }],t);
  const first = revision();
  expect(first).not.toBeNull();
  // Inside every series' gap: no transaction at all.
  recordLimitSamples("codex", [{ accountId: "a", source: "live", limits: limits(20,30) }, { accountId: "b", source: "live", limits: limits(40,50) }],t+60000);
  expect(revision()).toBe(first);
  expect(historySamples("codex","b","weekly",t/1000)).toEqual([{ t: t/1000,remaining: 60 }]);
  recordLimitSamples("codex", [{ accountId: "a", source: "live", limits: limits(20,30) }],t+300000);
  expect(revision()).toBe(first! + 1);
  expect(historySamples("codex","a","weekly",t/1000+300)).toHaveLength(2);
});

test("Codex forward history keeps only windows its own live probe answered", () => {
  const t0 = 1_700_000_000_000;
  const mixed: EngineLimits = { ...limits(10, 96),
    session: { usedPercent: 10, resetsAt: null, source: "live" }, weekly: { usedPercent: 96, resetsAt: null, source: "transcript" } };
  recordLimitSamples("codex", [{ accountId: "mixed", source: "transcript", limits: mixed },
    { accountId: "fallback", source: "transcript", limits: limits(20, 30) }, { accountId: "live", source: "live", limits: limits(40, 50) }], t0);
  expect(historySamples("codex", "mixed", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 90 }]);
  expect(historySamples("codex", "mixed", "weekly", t0 / 1000)).toEqual([]);
  expect(readHistory().series["codex|fallback|session"]).toBeUndefined();
  expect(readHistory().series["codex|fallback|weekly"]).toBeUndefined();
  expect(historySamples("codex", "live", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 50 }]);
  // A transcript-marked window stays out even when the read as a whole was live.
  recordLimitSample("codex", "marked", mixed, "live", t0);
  expect(historySamples("codex", "marked", "weekly", t0 / 1000)).toEqual([]);
  recordLimitSample("claude", "claude", limits(20, 40), "transcript", t0);
  expect(historySamples("claude", "claude", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 60 }]);
});

test("records a remaining-quota sample per window and persists it", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", limits(20, 40), "live", t0);
  expect(historySamples("claude", "acct", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 80 }]);
  expect(historySamples("claude", "acct", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 60 }]);
  expect(historySince()).toBe(new Date(t0).toISOString());
  // Survives a fresh read of the file.
  expect(readHistory().series["claude|acct|session"]).toHaveLength(1);
});

test("legacy Codex samples are excluded and retained in quarantine on the next write", () => {
  const file = path.join(dir, "limits-history.json"), t = 1_700_000_000;
  const mixed = [{ t, remaining: 96 }, { t: t + 300, remaining: 85 }];
  fs.writeFileSync(file, JSON.stringify({ version: 1, since: new Date(t * 1000).toISOString(), series: {
    "codex|a|weekly": mixed, "claude|a|weekly": [{ t, remaining: 50 }],
  } }));
  expect(historySamples("codex", "a", "weekly", t + 600)).toEqual([]);
  expect(historySamples("claude", "a", "weekly", t + 600)).toEqual([{ t, remaining: 50 }]);
  recordLimitSample("codex", "a", limits(20, 30), "live", (t + 600) * 1000);
  // The write imported the file; the quarantine moved with it.
  expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(historySamples("codex", "a", "weekly", t + 600)).toEqual([{ t: t + 600, remaining: 70 }]);
  expect(readHistory().unattributedCodexSeries).toEqual({ "codex|a|weekly": mixed });
  recordLimitSample("claude", "b", limits(10, 10), "live", (t + 900) * 1000);
  expect(readHistory().unattributedCodexSeries).toEqual({ "codex|a|weekly": mixed });
});

test("downsamples samples closer than five minutes apart", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("codex", "acct", limits(10, 10), "live", t0);
  recordLimitSample("codex", "acct", limits(11, 11), "live", t0 + 60_000); // +1 min → dropped
  recordLimitSample("codex", "acct", limits(12, 12), "live", t0 + 6 * 60_000); // +6 min → kept
  expect(historySamples("codex", "acct", "session", (t0 + 6 * 60_000) / 1000)).toEqual([
    { t: t0 / 1000, remaining: 90 },
    { t: (t0 + 6 * 60_000) / 1000, remaining: 88 },
  ]);
});

test("prunes samples older than the retention window on write", () => {
  const old = 1_700_000_000; // seconds
  const now = old + RETENTION_S + 3600; // just past retention
  recordLimitSample("claude", "acct", limits(50, 50), "live", old * 1000);
  recordLimitSample("claude", "acct", limits(60, 60), "live", now * 1000);
  const kept = readHistory().series["claude|acct|session"];
  expect(kept).toEqual([{ t: now, remaining: 40 }]);
});

test("keeps per-account series separate", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("codex", "a", limits(10, 10), "live", t0);
  recordLimitSample("codex", "b", limits(20, 20), "live", t0);
  expect(historySamples("codex", "a", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 90 }]);
  expect(historySamples("codex", "b", "session", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 80 }]);
});

test("skips windows with no numeric usage", () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", { session: null, weekly: { usedPercent: 25, resetsAt: null }, plan: null, capturedAt: null }, "live", t0);
  expect(historySamples("claude", "acct", "session", t0 / 1000)).toEqual([]);
  expect(historySamples("claude", "acct", "weekly", t0 / 1000)).toEqual([{ t: t0 / 1000, remaining: 75 }]);
});

test("a sample another process records is read here without reading the other series again", async () => {
  const t0 = 1_700_000_000_000;
  recordLimitSample("claude", "acct", limits(20, 40), "live", t0);
  expect(readHistory().series["claude|acct|session"]).toHaveLength(1);
  const child = Bun.spawn([process.execPath, "-e", `const { recordLimitSample } = await import(${JSON.stringify(path.resolve(import.meta.dir, "limitsHistoryStore.ts"))});`
    + `recordLimitSample("claude", "other", { session: { usedPercent: 30, resetsAt: null }, weekly: { usedPercent: 30, resetsAt: null }, plan: "pro", capturedAt: null }, "live", ${t0 + 6 * 60_000});`], {
    env: { ...process.env, LLV_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect([stdout, stderr, code]).toEqual(["", "", 0]);
  expect(Object.keys(readHistory().series).sort()).toEqual(["claude|acct|session", "claude|acct|weekly", "claude|other|session", "claude|other|weekly"]);
  expect(historySamples("claude", "other", "weekly", t0 / 1000 + 360)).toEqual([{ t: t0 / 1000 + 360, remaining: 70 }]);
  expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
