import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRoleSelection, roleSelectionCollection, selectionCandidate } from "./roleSelection";
import { learnedRulesSnapshot } from "./roleStore";
import { sweepRoleSelections } from "./roleSelectionRetention";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

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

function custodyFixture() {
  const stage: PipelineStage = { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null,
    effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "high", roleId: "builder", access: "read-write", promptScaffold: "Build the task and verify its result." } };
  const pipeline = buildPipeline({ id: "retention-pipeline", task: "Retain a stage block", project: "retention-project", repoDir: root, stages: [stage], srcPath: null, srcConversationId: null, now: settled });
  const attempt: PipelineStageAttempt = { n: 1, state: "passed", effectiveRole: stage.effectiveRole,
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, accountId: null, usageLimitedAccounts: [], flowId: null,
    expectedReviewHeadSha: null, reviewHeadSha: null, startedAt: settled, completedAt: settled, input: null, activatedBy: null, output: null, verdict: null, error: null };
  pipeline.runs[0].attempts.push(attempt);
  pipeline.state = "running";
  pipeline.cursor!.state = "committing";
  return pipeline;
}

test("a passed report awaiting publication retains its block until custody settles", async () => {
  const pipeline = custodyFixture();
  savePipelines([pipeline]);
  await seed();
  await sweepRoleSelections("", cutoff);
  expect(exists()).toBe(1);
  pipeline.state = "completed";
  pipeline.cursor = null;
  const release = new Date(Date.parse(settled) + 3_600_000).toISOString();
  pipeline.closedAt = release;
  savePipelines([pipeline]);
  await sweepRoleSelections("", cutoff);
  expect(exists()).toBe(1);
  pipeline.unconfirmedHosts = [{ stageId: "build", attempt: 1, conversationId: null, agentPath: null, paneId: null, operationId: null, detail: "Termination is unconfirmed.", at: release }];
  savePipelines([pipeline]);
  await sweepRoleSelections("", Date.parse(release) + 86_400_000);
  expect(exists()).toBe(1);
  pipeline.unconfirmedHosts = [];
  savePipelines([pipeline]);
  await sweepRoleSelections("", Date.parse(release) + 86_400_000);
  expect(exists()).toBe(0);
});


test("a stale settlement read cannot delete a block after the pipeline becomes current again", async () => {
  const pipeline = custodyFixture();
  pipeline.state = "completed";
  pipeline.cursor = null;
  savePipelines([pipeline]);
  await seed();
  let reads = 0;
  await sweepRoleSelections("", cutoff, async () => {
    if (++reads === 2) {
      pipeline.state = "running";
      pipeline.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
      savePipelines([pipeline]);
    }
    return settled;
  });
  expect(reads).toBe(2);
  expect(exists()).toBe(1);
});
