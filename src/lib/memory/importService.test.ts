import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMemoryImport } from "./importJob";
import { readImportCandidates, readImportRecord } from "./importStore";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { performanceSpans, performanceSites } from "@/lib/performanceSpans";

const at = "2026-10-19T00:00:00.000Z";
const roots: string[] = [];
const prior = process.env.LLV_STATE_DIR;
afterEach(async () => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior; for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-service-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const home = path.join(root, "claude");
  const memory = path.join(home, "projects", "fixture-project", "memory");
  await fs.mkdir(memory, { recursive: true }); await fs.mkdir(process.env.LLV_STATE_DIR!, { recursive: true });
  return { root, memory, roots: { claudeHomes: [home], codexHomes: [] } };
}
test("the production job reports labeled operations while the serving loop turns during held import work", async () => {
  const fixtureHome = await fixture();
  await fs.writeFile(path.join(fixtureHome.memory, "topic.md"), "Fixture topic.\n");
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: "fixture-1", changedAt: at }));
  let releasePhase!: () => void;
  let phaseStarted!: () => void;
  let released = false;
  const phaseSignal = new Promise<void>(resolve => { phaseStarted = resolve; });
  const held = new Promise<void>(resolve => { releasePhase = () => { released = true; resolve(); }; });
  const observed: { operation: string; current: string | undefined }[] = [];
  const request = { importId: "fixture-1", previous: null, at, roots: fixtureHome.roots };
  const job = runMemoryImport(request, { observeOperation: (operation, current) => {
    observed.push({ operation, current });
    if (operation === "memory.import.backup") { phaseStarted(); return held; }
  } });
  try {
    await phaseSignal;
    expect(observed).toContainEqual({ operation: "memory.import", current: "memory.import" });
    expect(observed).toContainEqual({ operation: "memory.import.backup", current: "memory.import.backup" });
    let loopTurn = false;
    await new Promise<void>(resolve => setImmediate(() => { loopTurn = true; resolve(); }));
    expect(loopTurn).toBe(true);
    expect(released).toBe(false);
  } finally { releasePhase(); }
  expect((await job).state).toBe("ready");
  for (const operation of ["memory.import", "memory.import.backup", "memory.import.candidates", "memory.import.retention"]) {
    expect(observed.some(row => row.operation === operation && row.current === operation)).toBe(true);
  }
  expect(readImportCandidates("fixture-1").candidates.length).toBeGreaterThan(0);
  expect(performanceSpans.snapshot().records.some(row => row.site === performanceSites.indexOf("memory.import") && row.kind === "await")).toBe(true);
});

test("the helper refuses a stale import and clears its single-flight slot for a later valid job", async () => {
  const fixtureHome = await fixture();
  await expect(runMemoryImport({ importId: "stale", previous: null, roots: fixtureHome.roots, at })).rejects.toThrow("source_changed");
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: "valid", changedAt: at }));
  expect((await runMemoryImport({ importId: "valid", previous: null, roots: fixtureHome.roots, at })).state).toBe("ready");
});

test("large private root inventories stay in state while the leased helper returns bounded metadata", async () => {
  const fixtureHome = await fixture();
  await fs.writeFile(path.join(fixtureHome.memory, "topic.md"), "Fixture topic.\n");
  const id = "large-root-inventory";
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: id, changedAt: at }));
  const homes = [...fixtureHome.roots.claudeHomes, ...Array.from({ length: 80 }, (_, i) => path.join(fixtureHome.root, "empty-home-" + i + "-" + "x".repeat(200)))];
  expect(Buffer.byteLength(JSON.stringify(homes))).toBeGreaterThan(16 * 1024);
  const result = await runMemoryImport({ importId: id, previous: null, roots: { claudeHomes: homes, codexHomes: [] }, at });
  expect(result.state).toBe("ready"); expect(result.roots).toBeUndefined();
  expect(readImportRecord(id)?.roots?.claudeHomes).toHaveLength(homes.length);
});
