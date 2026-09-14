import { expect, test } from "bun:test";

import type { PatchPipelineRequest, Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import { stageDraftKey, StageDrafts } from "./stageDrafts";
import { currentStageId, draftFacts, finishedStageIds, paneFacts, pipelineActionOptions, shownAttempt, stageNotStarted } from "./stagesModel";
import { stageViews } from "./pipelineGraph";

/* The Stages sheet's pure half and the stage-draft save flow (#1695 K5b), over
   invented pipeline records shaped like the store's. */

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
function stage(id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) {
  return { id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `{{prev.output}}\n\nStage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over };
}
function attempt(n: number, state: string, startedAt: string, over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n, state, effectiveRole: role("builder"), launchId: null, conversationId: `conversation_${n}_${startedAt}`, sessionId: null, agentPath: `/fixture/${n}-${startedAt}.jsonl`,
    paneId: null, flowId: null, startedAt, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
  } as PipelineStageAttempt;
}
function pipeline(stages: unknown[], runs: unknown[], cursor: unknown, state = "running"): Pipeline {
  return { id: "p-search", task: "Restore search", taskIds: ["t"], project: "fixture", stages, runs, cursor, state } as unknown as Pipeline;
}

const retryStages = [
  stage("implement", "builder", "review", { prompt: "{{task}}\n\nKeep the old index serving." }),
  stage("review", "reviewer", "verify"),
  stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }),
  stage("merge", "cleaner", null),
];

/* Implement ran twice (Verify failed once), a helper was adopted, Review passed, Verify runs again. */
const retrying = pipeline(retryStages, [
  { stageId: "implement", attempts: [
    attempt(1, "passed", "2026-09-15T08:00:00Z"),
    attempt(2, "passed", "2026-09-15T09:00:00Z", { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
    attempt(3, "passed", "2026-09-15T09:20:00Z", { historical: true, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
  ] },
  { stageId: "review", attempts: [attempt(1, "passed", "2026-09-15T09:30:00Z")] },
  { stageId: "verify", attempts: [
    attempt(1, "failed", "2026-09-15T08:30:00Z"),
    attempt(2, "running", "2026-09-15T09:40:00Z", { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } }),
  ] },
], { stageId: "verify", state: "running" });

test("the sheet opens on the live stage, else the last one that started, else the first", () => {
  expect(currentStageId(retrying, stageViews(retrying))).toBe("verify");
  const finished = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "passed", "2026-09-15T08:00:00Z")] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-15T08:30:00Z")] },
  ], null, "paused");
  expect(currentStageId(finished, stageViews(finished))).toBe("review");
  const fresh = pipeline(retryStages, [], null, "provisioning");
  expect(currentStageId(fresh, stageViews(fresh))).toBe("implement");
});

test("Collapse finished folds passed and skipped stages, never the live one or a waiting one", () => {
  expect(finishedStageIds(retrying, stageViews(retrying))).toEqual(["implement", "review"]);
});

test("a pane shows the operator's attempt or the latest own one, and a helper is never an attempt tab", () => {
  expect(shownAttempt(retrying, "implement", null)?.n).toBe(2);
  expect(shownAttempt(retrying, "implement", 1)?.n).toBe(1);
  /* Attempt 3 is the adopted helper: choosing it falls back to the latest own attempt. */
  expect(shownAttempt(retrying, "implement", 3)?.n).toBe(2);
  expect(shownAttempt(retrying, "merge", null)).toBeNull();
});

test("pane facts: who started the shown attempt, what a waiting stage runs after, and the fail budget without helpers", () => {
  const views = stageViews(retrying);
  const implement = retrying.stages[0]!;
  expect(paneFacts(retrying, implement, shownAttempt(retrying, "implement", null), views.get("implement"))).toEqual({
    startedBy: { stageId: "verify", edge: "fail" }, runsAfter: null, nextAttempt: null, onFail: null,
  });
  const verify = retrying.stages[2]!;
  expect(paneFacts(retrying, verify, shownAttempt(retrying, "verify", null), views.get("verify")).onFail).toEqual({ to: "implement", fired: 1, max: 2 });
  const merge = retrying.stages[3]!;
  expect(paneFacts(retrying, merge, null, views.get("merge"))).toEqual({ startedBy: null, runsAfter: "verify", nextAttempt: null, onFail: null });
  expect(draftFacts(retrying, merge)).toEqual({ after: "verify", then: null, onFail: null });
  expect(draftFacts(retrying, verify)).toEqual({ after: "review", then: "merge", onFail: { to: "implement", max: 2 } });
});

test("a stage is editable until its first attempt exists, a helper included", () => {
  expect(stageNotStarted(retrying, "merge")).toBe(true);
  expect(stageNotStarted(retrying, "review")).toBe(false);
});

test("pipeline actions carry the engine's own refusals", () => {
  const byAction = (record: Pipeline) => Object.fromEntries(pipelineActionOptions(record).map((option) => [option.action, option]));
  expect(byAction(retrying)).toEqual({
    pause: { action: "pause", refusal: null, stageId: null },
    "retry-stage": { action: "retry-stage", refusal: "no-decision", stageId: null },
    "skip-stage": { action: "skip-stage", refusal: "no-decision", stageId: null },
    close: { action: "close", refusal: null, stageId: null },
  });
  const parked = byAction({ ...retrying, state: "needs_decision", cursor: { stageId: "verify", state: "running" } } as unknown as Pipeline);
  expect(parked["retry-stage"]).toEqual({ action: "retry-stage", refusal: null, stageId: "verify" });
  expect(parked["skip-stage"]).toEqual({ action: "skip-stage", refusal: null, stageId: "verify" });
  expect(byAction({ ...retrying, state: "paused" } as Pipeline).resume).toEqual({ action: "resume", refusal: null, stageId: null });
  const ended = byAction({ ...retrying, state: "completed" } as Pipeline);
  expect([ended.pause!.refusal, ended["retry-stage"]!.refusal, ended.close!.refusal]).toEqual(["ended", "ended", "ended"]);
  const draft = byAction({ ...retrying, state: "draft" } as Pipeline);
  expect([draft.pause!.refusal, draft.close!.refusal]).toEqual(["draft", "draft"]);
});

/* ── The stage-draft save flow ─────────────────────────────────────────── */

function fakePorts(records: Array<Pipeline | null>, answers: PipelineWriteResult[] = []) {
  const patches: PatchPipelineRequest[] = [];
  const reads: string[] = [];
  const refreshes = { count: 0 };
  const ports: PipelinePorts = {
    refresh: () => { refreshes.count += 1; },
    read: async (id) => {
      reads.push(id);
      return records.length > 1 ? records.shift()! : records[0]!;
    },
    patch: async (_id, body) => {
      patches.push(body);
      return answers.shift() ?? { ok: true, pipeline: records[0]! };
    },
  };
  return { ports, patches, reads, refreshes };
}
const key = stageDraftKey("p-search", "merge");
const withMergePrompt = (prompt: string, record = retrying) => ({ ...record, stages: record.stages.map((entry) => (entry.id === "merge" ? { ...entry, prompt } : entry)) }) as Pipeline;

test("a save re-reads the stage and writes its words back into the stage's own wiring", async () => {
  const drafts = new StageDrafts(() => 1_000);
  const { ports, patches, reads } = fakePorts([retrying]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "  Merge after the rebuild settles.  ");
  await drafts.save(key, ports);
  expect(reads).toEqual(["p-search"]);
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles." }]);
  expect(drafts.get(key)).toBeNull();
  expect(drafts.saved(key)).toBe(1_000);
});

test("a stage whose prompt lost its wiring gets the position default back, never an empty input", async () => {
  const drafts = new StageDrafts();
  const bare = withMergePrompt("Merge it.");
  const { ports, patches } = fakePorts([bare]);
  drafts.begin("p-search", "merge", "Merge it.");
  drafts.edit(key, "Merge it carefully.");
  await drafts.save(key, ports);
  expect(patches[0]!.prompt).toBe("{{prev.output}}\n\nMerge it carefully.");
});

test("words another client saved since the edit began stop the write: Use theirs drops the draft, Keep mine writes over what the check found", async () => {
  const drafts = new StageDrafts();
  const theirs = withMergePrompt("{{prev.output}}\n\nMerge only on a green main.");
  const { ports, patches } = fakePorts([theirs]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Merge after the rebuild settles.");
  await drafts.save(key, ports);
  expect(patches).toEqual([]);
  expect(drafts.get(key)).toMatchObject({ phase: "changed", theirs: "Merge only on a green main.", text: "Merge after the rebuild settles.", base: "Stage merge." });

  await drafts.save(key, ports, { keepMine: true });
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles." }]);
  expect(drafts.get(key)).toBeNull();

  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Something else.");
  await drafts.save(key, ports);
  expect(drafts.get(key)?.phase).toBe("changed");
  drafts.drop(key);
  expect(drafts.get(key)).toBeNull();
  expect(patches).toHaveLength(1);
});

test("a stage that started before the save keeps the text and writes nothing; one that starts between the check and the write answers 409 and keeps it too", async () => {
  const started = { ...retrying, runs: [...retrying.runs, { stageId: "merge", attempts: [attempt(1, "running", "2026-09-15T10:00:00Z")] }] } as Pipeline;
  const early = new StageDrafts();
  const first = fakePorts([started]);
  early.begin("p-search", "merge", "Stage merge.");
  early.edit(key, "Merge after the rebuild settles.");
  await early.save(key, first.ports);
  expect(first.patches).toEqual([]);
  expect(early.get(key)).toMatchObject({ phase: "started", text: "Merge after the rebuild settles." });
  /* The board is behind the store: it is asked to read the catalog again. */
  expect(first.refreshes.count).toBe(1);

  const late = new StageDrafts();
  const second = fakePorts([retrying], [{ ok: false, status: 409, error: "stage has already started" }]);
  late.begin("p-search", "merge", "Stage merge.");
  late.edit(key, "Merge after the rebuild settles.");
  await late.save(key, second.ports);
  expect(second.patches).toHaveLength(1);
  expect(late.get(key)).toMatchObject({ phase: "started", text: "Merge after the rebuild settles." });
  expect(late.saved(key)).toBeNull();
  expect(second.refreshes.count).toBe(1);
});

test("any other refusal, an unreadable pipeline, or a stage gone from it keeps the draft with its reason", async () => {
  const refused = new StageDrafts();
  const write = fakePorts([retrying], [{ ok: false, status: 409, error: "pipeline is closed or completed" }]);
  refused.begin("p-search", "merge", "Stage merge.");
  refused.edit(key, "Merge after the rebuild settles.");
  await refused.save(key, write.ports);
  expect(refused.get(key)).toMatchObject({ phase: "failed", text: "Merge after the rebuild settles.", error: { kind: "write", message: "pipeline is closed or completed" } });

  const unread = new StageDrafts();
  const read = fakePorts([null]);
  unread.begin("p-search", "merge", "Stage merge.");
  unread.edit(key, "Merge after the rebuild settles.");
  await unread.save(key, read.ports);
  expect(read.patches).toEqual([]);
  expect(unread.get(key)).toMatchObject({ phase: "failed", error: { kind: "read" } });

  const missing = new StageDrafts();
  const gone = fakePorts([{ ...retrying, stages: retrying.stages.filter((entry) => entry.id !== "merge") } as Pipeline]);
  missing.begin("p-search", "merge", "Stage merge.");
  missing.edit(key, "Merge after the rebuild settles.");
  await missing.save(key, gone.ports);
  expect(missing.get(key)).toMatchObject({ phase: "failed", error: { kind: "missing" } });
});

test("a draft saving cannot be edited, dropped or saved twice; unchanged words close the editor without a write", async () => {
  const drafts = new StageDrafts();
  let release: (value: Pipeline) => void = () => {};
  const patches: PatchPipelineRequest[] = [];
  const ports: PipelinePorts = {
    refresh: () => {},
    read: () => new Promise<Pipeline>((resolve) => { release = resolve; }),
    patch: async (_id, body) => { patches.push(body); return { ok: true, pipeline: retrying }; },
  };
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Merge after the rebuild settles.");
  const saving = drafts.save(key, ports);
  expect(drafts.get(key)?.phase).toBe("saving");
  drafts.edit(key, "changed mid-save");
  drafts.drop(key);
  await drafts.save(key, ports);
  release(retrying);
  await saving;
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles." }]);

  const same = new StageDrafts();
  const quiet = fakePorts([retrying]);
  same.begin("p-search", "merge", "Stage merge.");
  await same.save(key, quiet.ports);
  expect(quiet.patches).toEqual([]);
  expect(same.get(key)).toBeNull();
  expect(same.saved(key)).toBeNull();
});
