import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMemoryImport } from "./importJob";
import { readImportCandidates } from "./importStore";
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
test("the production job uses a labeled helper, leaves the Viewer loop available, and persists retention across fresh helper processes", async () => {
  const fixtureHome = await fixture();
  for (let index = 0; index < 48; index++) await fs.writeFile(path.join(fixtureHome.memory, `topic-${index}.md`), `Fixture ${index}.\n` + "Keep the fixture complete.\n".repeat(500));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let firstBackup = "";
  const restoreLog = viewerLoopMonitor.setLogSink(() => {});
  try {
    for (let index = 1; index <= 6; index++) {
      await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: `fixture-${index}`, changedAt: at }));
      const request = { importId: `fixture-${index}`, previous: null, at: `2026-10-19T00:00:0${index}.000Z`, roots: fixtureHome.roots };
      const job = runMemoryImport(request);
      expect(viewerLoopMonitor.current()).toBeUndefined();
      expect(runMemoryImport(request)).toBe(job);
      await expect(runMemoryImport({ ...request, importId: "overlap" })).rejects.toThrow("already running");
      const before = ticks;
      const row = await job;
      expect(row.state).toBe("ready"); expect(ticks).toBeGreaterThan(before);
      if (index === 1) firstBackup = row.backup;
      expect(readImportCandidates(request.importId).candidates.length).toBeGreaterThan(0);
      expect(typeof readImportCandidates(request.importId).candidates[0].occurrences[0].project).toBe("string");
    }
    expect(await fs.stat(firstBackup).catch(() => null)).toBeNull();
    expect(performanceSpans.snapshot().records.some(row => row.site === performanceSites.indexOf("memory.import") && row.kind === "await")).toBe(true);
  } finally { clearInterval(timer); restoreLog(); }
}, 60_000);

test("the helper refuses a stale import and clears its single-flight slot for a later valid job", async () => {
  const fixtureHome = await fixture();
  await expect(runMemoryImport({ importId: "stale", previous: null, roots: fixtureHome.roots, at })).rejects.toThrow("source_changed");
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: "valid", changedAt: at }));
  expect((await runMemoryImport({ importId: "valid", previous: null, roots: fixtureHome.roots, at })).state).toBe("ready");
});
