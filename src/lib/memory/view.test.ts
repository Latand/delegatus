import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { writeAsksYouSettings } from "@/lib/asks/settings";
import { mutateOperatorAsks } from "@/lib/asks/store";
import { setSharedMemoryEnabled, sharedMemoryEnabled } from "./settings";
import { memoryIndex } from "./service";
import { memorySettingView } from "./view";
import { GET, PUT } from "@/app/api/memory/settings/route";
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
  for (const key of ["LLV_STATE_DIR", "OPENROUTER_API_KEY", "PORT", "LLV_STAGING"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});
test("staging without a key carries the production-settings destination to the browser", async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.LLV_STAGING = "1";
  const response = await GET(new NextRequest("http://localhost/api/memory/settings?project=fixture-project"));
  expect(await response.json()).toMatchObject({ enabled: true, staging: true, reasons: ["noKey"] });
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
for (const broken of ["spend", "pending"]) test(`unreadable ${broken} preserves the saved switch independently of status`, async () => {
  if (broken === "spend") fs.writeFileSync(path.join(root, "operator-asks.json"), "broken");
  else {
    fs.mkdirSync(path.join(root, "memory-injection-pending"));
    fs.writeFileSync(path.join(root, "memory-injection-pending", "a".repeat(64) + ".json"), "{}");
  }
  const get = () => GET(new NextRequest("http://localhost/api/memory/settings?project=fixture-project"));
  expect(await (await get()).json()).toEqual({ enabled: true, status: "unavailable" });
  for (const enabled of [false, true]) {
    const response = await PUT(new NextRequest("http://localhost/api/memory/settings", {
      method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ project: "fixture-project", enabled }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled, status: "unavailable" });
    expect(sharedMemoryEnabled("fixture-project")).toBe(enabled);
    const read = await get(); expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ enabled, status: "unavailable" });
  }
});
test("failed setting persistence reports a write error", async () => {
  fs.writeFileSync(path.join(root, "shared-memory-settings.json"), "broken");
  const response = await PUT(new NextRequest("http://localhost/api/memory/settings", {
    method: "PUT", headers: { host: "localhost", origin: "http://localhost" },
    body: JSON.stringify({ project: "fixture-project", enabled: false }),
  }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "write_failed" });
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

test("last-turn reason is project-scoped, survives reload, aliases and late confirmations", () => {
  const index = memoryIndex();
  index.recordLastTurn("fixture-project", "fixture-conversation", "first-turn", 1, "prepared");
  index.recordLastTurn("foreign-project", "foreign-conversation", "foreign-turn", 2, "failed");
  expect(memorySettingView("fixture-project").lastTurn).toBe("prepared");
  index.recordLastTurn("fixture-project", "fixture-conversation", "second-turn", 3, "noMatches");
  index.recordLastTurn("fixture-project", "fixture-conversation", "first-turn", 1, "failed");
  index.recordInjection([{ id: "fixture-memory", title: "Synthetic title", score: .9 }], "first-turn", "fixture-conversation");
  expect(index.lastTurn("fixture-project")).toBe("noMatches");
  index.close();
  expect(memoryIndex().lastTurn("fixture-project")).toBe("noMatches");
  index.recordLastTurn("fixture-project", "fixture-conversation", "third-turn", 4, "prepared");
  index.recordInjection([{ id: "fixture-memory", title: "Synthetic title", score: .9 }], "third-turn", "fixture-conversation");
  expect(index.lastTurn("fixture-project")).toBe("delivered");
  const payload = memorySettingView("fixture-project");
  expect(JSON.stringify(payload)).not.toContain("fixture-conversation");
  expect(JSON.stringify(payload)).not.toContain("third-turn");
});

test("an expired unconfirmed offer explains the last turn without claiming delivery", () => {
  memoryIndex().recordLastTurn("fixture-project", "fixture-conversation", "fixture-turn", 1, "prepared", Date.now() - 31000);
  expect(memorySettingView("fixture-project").lastTurn).toBe("unconfirmed");
});
