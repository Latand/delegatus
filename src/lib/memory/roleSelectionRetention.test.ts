import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRoleSelection, roleSelectionCollection, selectionCandidate } from "./roleSelection";
import { learnedRulesSnapshot } from "./roleStore";
import { sweepRoleSelections } from "./roleSelectionRetention";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-selection-retention-"));
const original = process.env.LLV_STATE_DIR;
let n = 0;
beforeEach(async () => { process.env.LLV_STATE_DIR = path.join(root, `state-${++n}`); await prepareRoleSelection(); });
afterAll(() => { if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original; fs.rmSync(root, { recursive: true, force: true }); });
const settled = "2026-10-22T00:00:00.000Z";
const cutoff = Date.parse(settled) + 86_400_000;
async function seed() {
  const row = selectionCandidate({ pipelineId: "retention-pipeline", stageId: "build", attempt: 1 }, learnedRulesSnapshot("retention-project", "builder"));
  const store = roleSelectionCollection()!;
  try { store.boundedPatch(1, tx => tx.put(row)); } finally { store.close(); }
  return row;
}
const exists = () => { const store = roleSelectionCollection()!; try { return store.keyPage("", 10).length; } finally { store.close(); } };

test("retention keeps running and unreadable attempts and expires at the one-day boundary", async () => {
  await seed();
  expect(await sweepRoleSelections("", cutoff, async () => null)).toBe("");
  expect(exists()).toBe(1);
  await sweepRoleSelections("", cutoff - 1, async () => settled);
  expect(exists()).toBe(1);
  await sweepRoleSelections("", cutoff, async () => settled);
  expect(exists()).toBe(0);
});

test("retention rechecks settlement after admission and holds a resumed attempt", async () => {
  await seed();
  let reads = 0;
  await sweepRoleSelections("", cutoff, async () => ++reads === 1 ? settled : null);
  expect(reads).toBe(2);
  expect(exists()).toBe(1);
});
