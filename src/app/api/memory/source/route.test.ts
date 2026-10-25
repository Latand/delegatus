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
  return new NextRequest("http://localhost/api/memory/source", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://localhost", host: "localhost", ...headers }, body: JSON.stringify(body) });
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
  expect((await PUT(new NextRequest("http://localhost/api/memory/source", { method: "PUT", headers: { Origin: "http://localhost", host: "localhost" }, body: "{" }))).status).toBe(400);
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

test("an import that failed after the current choice is named on the read; a newer choice or Delegatus hides it", async () => {
  const { writeImportRows } = await import("@/lib/memory/importStore");
  const record = (id: string, at: string, state: "failed" | "ready", reason?: "integrity" | "interrupted") => ({ kind: "import" as const, id, state, at, previous: null,
    backup: path.join(root, "backups", "engine-memory", id), files: 0, candidates: 0, parts: 0, ...(reason ? { reason } : {}) });
  const read = async () => (await GET()).json();
  /* No import store yet: the unchosen read is unchanged. */
  expect(await read()).toEqual({ choice: null, phase: null });
  await writeImportRows([record("fixture-old", "2026-10-17T10:00:00.000Z", "failed", "interrupted"), record("fixture-new", "2026-10-17T12:00:00.000Z", "failed", "integrity"), record("fixture-ok", "2026-10-17T13:00:00.000Z", "ready")]);
  expect(await read()).toEqual({ choice: null, phase: null, lastFailure: { reason: "integrity", at: "2026-10-17T12:00:00.000Z" } });
  /* The engines position restored by the failed import keeps its earlier changedAt. */
  fs.writeFileSync(path.join(root, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "engines", changedAt: "2026-10-17T11:00:00.000Z" }));
  expect((await read()).lastFailure).toEqual({ reason: "integrity", at: "2026-10-17T12:00:00.000Z" });
  /* A later choice: the successful import's engines position, which keeps its import id. */
  fs.writeFileSync(path.join(root, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "engines", changedAt: "2026-10-17T13:30:00.000Z", importId: "fixture-ok", phase: "active" }));
  expect((await read()).lastFailure).toBeUndefined();
  chooseSource("active");
  expect((await read()).lastFailure).toBeUndefined();
});

test("GET names the admission hold in front of the import's pending passes, by word and only while parts are pending", async () => {
  const { writeImportRows } = await import("@/lib/memory/importStore");
  const { defaultSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  const progress = (pendingParts: number) => ({ files: 351, parts: 351, pendingFiles: pendingParts, pendingParts, pendingLoadedParts: pendingParts, adopted: 80, dropped: 40 });
  const seed = (pendingParts: number) => writeImportRows([{ kind: "import", id: "fixture-import", state: "ready", at: "2026-10-17T00:00:00.000Z", previous: null,
    backup: path.join(root, "backups", "engine-memory", "fixture-import"), files: 351, candidates: 351, parts: 351, hostProject: "held-project", progress: progress(pendingParts) }]);
  const read = async () => (await GET()).json();
  chooseSource("importing"); await seed(231);
  /* Nothing holds it: no word. */
  expect((await read()).import.admission).toBeUndefined();
  /* Seat wakes off for the host project. */
  writeSeatTickSettings("held-project", { ...defaultSeatTickSettings("held-project"), enabled: false });
  const held = await read();
  expect(held.import).toMatchObject({ admission: "wakesOff", counts: { pendingParts: 231 } });
  expect(JSON.stringify(held)).not.toContain("curation:");
  expect(JSON.stringify(held)).not.toContain(root);
  /* Nothing left to pass: the hold stops nothing, so it is not named. */
  await seed(0);
  expect((await read()).import.admission).toBeUndefined();
  /* The automatic update draining holds every project. */
  writeSeatTickSettings("held-project", defaultSeatTickSettings("held-project"));
  await seed(10);
  fs.mkdirSync(path.join(root, "self-update"), { recursive: true });
  fs.writeFileSync(path.join(root, "self-update", "auto-drain.json"), JSON.stringify({ id: "drain", target: "release", since: "2026-10-17T00:00:00.000Z", until: 0, persistent: true }));
  expect((await read()).import.admission).toBe("update");
  /* The engines position names no hold: the sync is not the import. */
  chooseSource("engines");
  expect((await read()).import?.admission).toBeUndefined();
});

test("the driver's frame states read back through GET with the hold or the undo they draw", async () => {
  const { MEMORY_SOURCE_FRAME_STATES, seedMemorySourceState } = await import("@/lib/memory/fixtures/sourceStates");
  const wanted: Partial<Record<typeof MEMORY_SOURCE_FRAME_STATES[number], { admission?: string; undo?: unknown }>> = {
    "importing-held": { admission: "wakesOff" }, "draining-held": { admission: "update" },
    "active-undone": { undo: { state: "undone", kept: 0 } }, "active-partly-undone": { undo: { state: "partlyUndone", kept: 1 } },
  };
  for (const state of MEMORY_SOURCE_FRAME_STATES) {
    await seedMemorySourceState(state);
    const body = await (await GET()).json();
    expect({ state, admission: body.import?.admission, undo: body.import?.undo }).toEqual({ state, admission: wanted[state]?.admission, undo: wanted[state]?.undo });
  }
});
