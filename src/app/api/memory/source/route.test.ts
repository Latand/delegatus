import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { chooseSource } from "@/lib/memory/fixtures/source";
import { readMemorySourceFile } from "@/lib/memory/source";
import { GET, PUT } from "./route";

const previous = process.env.LLV_STATE_DIR;
let root: string;
let registry: AgentRegistry;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-source-route-")); process.env.LLV_STATE_DIR = root;
  registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
});
afterEach(async () => {
  const scheduler = await import("@/lib/memory/importController").catch(() => null);
  await scheduler?.scheduleMemoryImport();
  setAgentRegistryForTests(null); registry.close();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/memory/source", { method: "PUT", headers: { cookie: `llv_operator=${soloBrowserSession()}`, "Content-Type": "application/json", Origin: "http://localhost", host: "localhost", ...headers }, body: JSON.stringify(body) });
}
test("GET is uncached and an operator PUT starts importing without accepting a supplied phase or roots", async () => {
  const response = await GET(); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ choice: null, phase: null });
  const put = await PUT(request({ source: "delegatus", phase: "active", roots: { claudeHomes: [root] } }));
  expect(put.status).toBe(200); expect(await put.json()).toEqual({ choice: "delegatus", phase: "importing", import: { counts: null, remainingGenerations: 0, hold: null } });
  expect(readMemorySourceFile()).toMatchObject({ phase: "importing" });
  const { readImportRecord } = await import("@/lib/memory/importStore");
  expect(readImportRecord(readMemorySourceFile()!.importId!)?.roots).toBeUndefined();
});
test("only the operator's same-origin write can select engines; import evidence survives", async () => {
  chooseSource("draining");
  const before = readMemorySourceFile();
  expect((await PUT(request({ source: "engines" }, { Origin: "https://other.example" }))).status).toBe(403);
  const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Synthetic memory settings caller" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  expect((await PUT(request({ source: "engines" }, { "x-llv-spawn-capability": capability }))).status).toBe(403);
  expect((await PUT(request({ source: "delegatus" }, { Origin: "https://other.example" }))).status).toBe(403);
  expect((await PUT(request({ source: "delegatus" }, { "x-llv-spawn-capability": capability }))).status).toBe(403);
  expect(readMemorySourceFile()).toEqual(before);
  const allowed = await PUT(request({ source: "engines" }, { Origin: "http://localhost" }));
  expect(allowed.status).toBe(200); expect(await allowed.json()).toEqual({ choice: "engines", phase: "draining" });
  expect(readMemorySourceFile()?.importId).toBe("fixture-import");
});
test("invalid bodies and an engines-first choice change nothing", async () => {
  for (const value of [null, [], {}, { source: "other" }, { source: true }]) expect((await PUT(request(value))).status).toBe(400);
  expect((await PUT(new NextRequest("http://localhost/api/memory/source", { method: "PUT", headers: { cookie: `llv_operator=${soloBrowserSession()}`, Origin: "http://localhost", host: "localhost" }, body: "{" }))).status).toBe(400);
  expect((await PUT(request({ source: "engines" }))).status).toBe(409);
  expect(readMemorySourceFile()).toBeNull();
});

test("a durable write failure reports an error and leaves the selected source intact", async () => {
  chooseSource("active");
  const before = readMemorySourceFile();
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw Error("fixture refused rename"); });
  try {
    const response = await PUT(request({ source: "engines" }));
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "write_failed" });
    expect(readMemorySourceFile()).toEqual(before);
  } finally { rename.mockRestore(); }
});

test("the operator sets the sync interval; other callers and invalid values change nothing", async () => {
  const file = path.join(root, "memory-sync.json");
  for (const value of [-1, 169, 1.5, "6", null]) expect((await PUT(request({ syncIntervalHours: value }))).status).toBe(400);
  expect((await PUT(request({ syncIntervalHours: 6 }, { Origin: "https://other.example" }))).status).toBe(403);
  expect(fs.existsSync(file)).toBe(false);
  const accepted = await PUT(request({ syncIntervalHours: 0 }));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ choice: null, phase: null });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ schemaVersion: 1, intervalHours: 0 });
  expect(readMemorySourceFile()).toBeNull();
});

test("GET carries the sync schedule in the engines position with a ready import, counts only", async () => {
  chooseSource("draining");
  expect((await (await GET()).json()).sync).toBeUndefined();
  const { importCollection } = await import("@/lib/memory/importStore");
  importCollection(true)!.boundedPatch(2, tx => tx.put({ kind: "import", id: "fixture-import", state: "ready", at: "2026-10-17T00:00:00.000Z", previous: null, backup: path.join(root, "backups", "engine-memory", "fixture-import"), files: 1, candidates: 1, parts: 1,
    sync: { lastAt: "2026-10-22T00:00:00.000Z", result: "ok", added: 3 } }));
  expect((await PUT(request({ source: "engines" }))).status).toBe(200);
  const body = await (await GET()).json();
  expect(body.sync).toEqual({ intervalHours: 24, lastAt: "2026-10-22T00:00:00.000Z", nextAt: expect.any(String), added: 3, capped: false, failure: null });
  expect(JSON.stringify(body)).not.toContain(root);
  expect((await PUT(request({ source: "engines", syncIntervalHours: 0 }))).status).toBe(200);
  expect((await (await GET()).json()).sync).toMatchObject({ intervalHours: 0, nextAt: null });
});
