import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { writeAsksYouSettings } from "@/lib/asks/settings";
import { mutateOperatorAsks } from "@/lib/asks/store";
import { setSharedMemoryEnabled } from "./settings";
import { memoryIndex } from "./service";
import { memorySettingView } from "./view";
import { GET } from "@/app/api/memory/settings/route";
const previous = { ...process.env };
const now = new Date("2026-10-05T12:00:00Z");
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-view-"));
  process.env.LLV_STATE_DIR = root;
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.PORT;
  setSharedMemoryEnabled("fixture-project", true);
});
afterEach(() => {
  memoryIndex().close();
  for (const key of ["LLV_STATE_DIR", "OPENROUTER_API_KEY", "PORT"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});
test("status explains every blocker and permits ready injection", () => {
  expect(memorySettingView("fixture-project", now).reasons).toEqual([]);
  delete process.env.OPENROUTER_API_KEY;
  expect(memorySettingView("fixture-project", now).reasons).toContain("noKey");
  process.env.OPENROUTER_API_KEY = "test-key";
  setSharedMemoryEnabled("fixture-project", false);
  expect(memorySettingView("fixture-project", now).reasons).toEqual(["projectOff"]);
  setSharedMemoryEnabled("fixture-project", true);
  writeAsksYouSettings({ capUsd: .01 });
  mutateOperatorAsks(file => { file.spend.usd = .001; }, now);
  expect(memorySettingView("fixture-project", now).reasons).toEqual(["capped"]);
  // Raising a cap clears the reason even with a historical cap-hit count.
  mutateOperatorAsks(file => { file.spend.capped = 4; }, now);
  writeAsksYouSettings({ capUsd: 1 });
  expect(memorySettingView("fixture-project", now).reasons).toEqual([]);
  process.env.PORT = "9876";
  fs.writeFileSync(path.join(root, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9875" }));
  expect(memorySettingView("fixture-project", now).reasons).toEqual(["notOwner"]);
});
test("current month ledger counts decisions separately from confirmed turns, with no text", async () => {
  const index = memoryIndex();
  for (const event of ["decisions", "decisions", "prepared", "skipped", "failed", "noMatches", "noCandidates"] as const) index.recordInjectionActivity(event, now);
  index.recordInjectionActivity("decisions", new Date("2026-09-30T00:00:00Z"));
  const entries = [{ id: "fixture-one", title: "Private fixture name", score: .9 }, { id: "fixture-two", title: "Other fixture name", score: .8 }];
  index.recordInjection(entries, "turn", "conversation");
  index.recordInjection(entries, "turn", "conversation");
  index.recordInjection(entries, "other-turn", "other-conversation");
  const db = new Database(path.join(root, "memory-index.sqlite"));
  db.query("UPDATE memory_offers SET at = ?").run(now.toISOString());
  db.close();
  const view = memorySettingView("fixture-project", now);
  expect(view.counts).toEqual({ decisions: 2, prepared: 1, delivered: 2, skipped: 1, failed: 1, noMatches: 1, noCandidates: 1 });
  expect(memorySettingView("fixture-project", new Date("2026-11-01")).counts.decisions).toBe(0);
  const response = await GET(new NextRequest("http://localhost/api/memory/settings?project=fixture-project"));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(entries[0].title);
  expect(text).not.toContain(process.env.OPENROUTER_API_KEY!);
});
test("unreadable spend reports status unavailable rather than a false ready answer", async () => {
  fs.writeFileSync(path.join(root, "operator-asks.json"), "broken");
  expect((await GET(new NextRequest("http://localhost/api/memory/settings?project=fixture-project"))).status).toBe(503);
});

test("contended activity stays in process and flushes on the next successful write", () => {
  const index = memoryIndex(); index.injectionActivity(now);
  const db = new Database(path.join(root, "memory-index.sqlite")); db.exec("BEGIN IMMEDIATE");
  try { index.recordInjectionActivity("failed", now); } finally { db.exec("ROLLBACK"); }
  expect(db.query("SELECT count FROM memory_injection_activity").all()).toEqual([]);
  index.recordInjectionActivity("decisions", new Date("2026-11-01"));
  expect(index.injectionActivity(now).failed).toBe(1);
  expect(index.injectionActivity(new Date("2026-11-01")).decisions).toBe(1);
  index.recordInjectionActivity("decisions", now);
  expect(index.injectionActivity(now).failed).toBe(1);
  expect(fs.existsSync(path.join(root, "memory-activity-pending"))).toBe(false);
  db.close();
});

test("ten thousand events use one row per month and event", () => {
  const index = memoryIndex();
  for (let i = 0; i < 10000; i++) index.recordInjectionActivity("decisions", now);
  for (const event of ["skipped", "failed", "noCandidates", "noMatches", "prepared"] as const) index.recordInjectionActivity(event, now);
  expect(index.injectionActivity(now).decisions).toBe(10000);
  const db = new Database(path.join(root, "memory-index.sqlite"));
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_injection_activity").get()?.count).toBe(6);
  db.close();
  expect(fs.existsSync(path.join(root, "memory-activity-pending"))).toBe(false);
});

test("the earlier activity schema is aggregated once without losing counts", () => {
  const db = new Database(path.join(root, "memory-index.sqlite"), { create: true });
  db.exec("CREATE TABLE memory_injection_activity (id TEXT PRIMARY KEY, month TEXT, event TEXT)");
  const write = db.query("INSERT INTO memory_injection_activity VALUES (?, ?, ?)");
  write.run("one", "2026-10", "decisions"); write.run("two", "2026-10", "decisions"); write.run("three", "2026-09", "failed");
  db.close();
  expect(memoryIndex().injectionActivity(now).decisions).toBe(2);
  memoryIndex().close();
  expect(memoryIndex().injectionActivity(now).decisions).toBe(2);
  expect(memoryIndex().injectionActivity(new Date("2026-09-30")).failed).toBe(1);
});

test("unauthenticated malformed or oversized envelopes do not count operator turns", async () => {
  const { POST } = await import("@/app/api/memory/inject/route");
  for (const body of ["broken fixture body", "x".repeat(128001)]) {
    expect(await (await POST(new Request("http://localhost/api/memory/inject", { method: "POST", body }))).json()).toEqual({ block: "" });
  }
  expect(memoryIndex().injectionActivity()).toMatchObject({ failed: 0, skipped: 0 });
});

test("a confirmed delivery replayed next month counts in its emission month", () => {
  const index = memoryIndex(); index.injectionActivity(now);
  const db = new Database(path.join(root, "memory-index.sqlite")); db.exec("BEGIN IMMEDIATE");
  try { index.recordConfirmedInjection([{ id: "fixture-late", title: "Fixture", score: .9 }], "late-turn", "late-conversation", "2026-09-30T23:59:59Z"); }
  finally { db.exec("ROLLBACK"); db.close(); }
  expect(index.injectionActivity(now).delivered).toBe(0);
  expect(index.injectionActivity(new Date("2026-09-30")).delivered).toBe(1);
});
