import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCandidateStateDataset, CANDIDATE_HISTORY_PROJECT, CANDIDATE_HISTORY_PASS, CANDIDATE_HISTORY_SCOPE } from "./candidateStateDataset";

test("generated history matches the RG2 census and real curator and rules readers can consume it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rg2-state-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const census = await buildCandidateStateDataset(root);
    expect(census).toMatchObject({ hotPipelines: 270, hotMaxBytes: 515000, archivedPipelines: 950, archiveMaxBytes: 1100000, tasks: 2450, taskBytes: 9800000, memoryRows: 3900, scopes: 100, curatorPasses: 50 });
    expect(census.hotBytes).toBeGreaterThanOrEqual(33999000);
    expect(census.archiveBytes).toBeGreaterThanOrEqual(110999000);
    expect(census.historyBytes).toBeGreaterThanOrEqual(12600000);
    expect(census.memoryBytes).toBeGreaterThanOrEqual(15900000);
    expect(census.memoryMaxBytes).toBeGreaterThanOrEqual(2900000);
    const { loadPipelines, loadArchivedPipelines } = await import("@/lib/pipelines/store");
    expect(loadPipelines()).toHaveLength(270);
    expect(loadArchivedPipelines()).toHaveLength(950);
    const { loadTasks } = await import("@/lib/tasks/store");
    expect(loadTasks(path.join(root, "tasks.json"))).toHaveLength(2450);
    const { projectViewAsync } = await import("@/lib/memory/roleStore");
    const { readPass } = await import("@/lib/memory/curation/store");
    const { readCuration } = await import("@/lib/memory/curation/read");
    const view = await projectViewAsync(CANDIDATE_HISTORY_PROJECT);
    expect(view.scopes.filter(scope => scope.revision > 0)).toHaveLength(100);
    expect(view.curation?.passes).toHaveLength(50);
    expect(await readCuration(readPass(CANDIDATE_HISTORY_PASS)!, CANDIDATE_HISTORY_SCOPE)).toHaveProperty("scope", CANDIDATE_HISTORY_SCOPE);
    // The generator never merges with an existing installation or a prior seed.
    await expect(buildCandidateStateDataset(root)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
