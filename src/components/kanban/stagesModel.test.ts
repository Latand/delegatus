import { expect, test } from "bun:test";

import type { PatchPipelineRequest, Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

import { stageDigest, stageDigests } from "@/lib/pipelines/stageDigest";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import { stageDraftKey, StageDrafts } from "./stageDrafts";
import { actionObserved, currentStageId, draftFacts, draftOutcome, finishedStageIds, paneFacts, pipelineActionOptions, shownAttempt, stageNotStarted } from "./stagesModel";
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
    pause: { action: "pause", refusal: null, stageId: null, attempt: null },
    "retry-stage": { action: "retry-stage", refusal: "no-decision", stageId: null, attempt: null },
    "skip-stage": { action: "skip-stage", refusal: "no-decision", stageId: null, attempt: null },
    close: { action: "close", refusal: null, stageId: null, attempt: null },
  });
  const parked = byAction({ ...retrying, state: "needs_decision", cursor: { stageId: "verify", state: "running" } } as unknown as Pipeline);
  /* The attempt retry and skip expect is the waiting stage's latest own attempt. */
  expect(parked["retry-stage"]).toEqual({ action: "retry-stage", refusal: null, stageId: "verify", attempt: 2 });
  expect(parked["skip-stage"]).toEqual({ action: "skip-stage", refusal: null, stageId: "verify", attempt: 2 });
  /* Implement's last recorded attempt is an adopted helper (3): the expected attempt is its own latest, 2. */
  expect(byAction({ ...retrying, state: "needs_decision", cursor: { stageId: "implement", state: "running" } } as unknown as Pipeline)["retry-stage"]).toEqual({ action: "retry-stage", refusal: null, stageId: "implement", attempt: 2 });
  /* A stage the pipeline waits on before any attempt of its own (a provisioning park) is expected as attempt 0. */
  expect(byAction({ ...retrying, state: "needs_decision", cursor: { stageId: "merge", state: "pending" } } as unknown as Pipeline)["skip-stage"]).toEqual({ action: "skip-stage", refusal: null, stageId: "merge", attempt: 0 });
  expect(byAction({ ...retrying, state: "paused" } as Pipeline).resume).toEqual({ action: "resume", refusal: null, stageId: null, attempt: null });
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
      const record = records.length > 1 ? records.shift()! : records[0]!;
      return record ? { pipeline: record, stageDigests: stageDigests(record.stages) } : null;
    },
    patch: async (_id, body) => {
      patches.push(body);
      return answers.shift() ?? { ok: true, pipeline: records[0]! };
    },
  };
  return { ports, patches, reads, refreshes };
}
const key = stageDraftKey("p-search", "merge");
const mergeDigest = (record: Pipeline) => stageDigest(record.stages.find((entry) => entry.id === "merge")!);
const withMergePrompt = (prompt: string, record = retrying) => ({ ...record, stages: record.stages.map((entry) => (entry.id === "merge" ? { ...entry, prompt } : entry)) }) as Pipeline;

test("a save re-reads the stage and writes its words back into the stage's own wiring", async () => {
  const drafts = new StageDrafts(() => 1_000);
  const { ports, patches, reads } = fakePorts([retrying]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "  Merge after the rebuild settles.  ");
  await drafts.save(key, ports);
  expect(reads).toEqual(["p-search"]);
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles.", expectedStageDigest: mergeDigest(retrying) }]);
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
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles.", expectedStageDigest: mergeDigest(theirs) }]);
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
    read: () => new Promise((resolve) => { release = (record) => resolve({ pipeline: record, stageDigests: stageDigests(record.stages) }); }),
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
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles.", expectedStageDigest: mergeDigest(retrying) }]);

  const same = new StageDrafts();
  const quiet = fakePorts([retrying]);
  same.begin("p-search", "merge", "Stage merge.");
  await same.save(key, quiet.ports);
  expect(quiet.patches).toEqual([]);
  expect(same.get(key)).toBeNull();
  expect(same.saved(key)).toBeNull();
});

/* ── Review follow-ups: what an edit came to, unanswered writes, empty words ── */

const started = (prompt: string, attemptOver: Partial<PipelineStageAttempt> = {}, state = "running") => ({
  ...withMergePrompt(prompt),
  state,
  runs: [...retrying.runs, { stageId: "merge", attempts: [attempt(1, "running", "2026-09-15T10:00:00Z", attemptOver)] }],
}) as unknown as Pipeline;
const neverRan = { state: "pending", startedAt: null, conversationId: null, agentPath: null, launchId: null } as unknown as Partial<PipelineStageAttempt>;

test("an edit's outcome is read from the stage: waiting, untouched, included, ended before start, or undelivered", () => {
  const edit = { text: "Merge after the warm query.", base: "Stage merge." };
  expect(draftOutcome(retrying, "merge", edit)).toBe("waiting");
  expect(draftOutcome(retrying, "merge", { text: " Stage merge. ", base: "Stage merge." })).toBe("waiting");
  expect(draftOutcome(started("{{prev.output}}\n\nStage merge."), "merge", { text: "Stage merge.", base: "Stage merge." })).toBe("untouched");
  /* The stage's prompt froze with the edit's words in it. */
  expect(draftOutcome(started("{{prev.output}}\n\nMerge after the  warm query."), "merge", edit)).toBe("included");
  expect(draftOutcome(started("{{prev.output}}\n\nStage merge."), "merge", edit)).toBe("undelivered");
  /* Closed while the stage's attempt was still only recorded. */
  expect(draftOutcome(started("{{prev.output}}\n\nStage merge.", neverRan, "closed"), "merge", edit)).toBe("ended-before-start");
  expect(draftOutcome({ ...retrying, state: "completed" } as Pipeline, "merge", edit)).toBe("ended-before-start");
  expect(draftOutcome({ ...retrying, state: "completed" } as Pipeline, "merge", { text: "Stage merge.", base: "Stage merge." })).toBe("untouched");
  expect(draftOutcome(started("{{prev.output}}\n\nStage merge.", {}, "closed"), "merge", edit)).toBe("undelivered");
});

test("an unanswered action is observed only in the state it leads to", () => {
  const parked = { ...retrying, state: "needs_decision", cursor: { stageId: "verify", state: "running" } } as unknown as Pipeline;
  expect(actionObserved("pause", null, { ...retrying, state: "paused" } as Pipeline)).toBe(true);
  expect(actionObserved("pause", null, retrying)).toBe(false);
  expect(actionObserved("resume", null, retrying)).toBe(true);
  expect(actionObserved("resume", null, { ...retrying, state: "paused" } as Pipeline)).toBe(false);
  expect(actionObserved("close", null, { ...retrying, state: "closed" } as Pipeline)).toBe(true);
  expect(actionObserved("retry-stage", "verify", parked)).toBe(false);
  expect(actionObserved("skip-stage", "verify", { ...parked, cursor: { stageId: "merge", state: "pending" } } as unknown as Pipeline)).toBe(true);
  expect(actionObserved("retry-stage", "verify", retrying)).toBe(true);
});

test("empty words are saved as the stage's wiring alone", async () => {
  const drafts = new StageDrafts();
  const { ports, patches } = fakePorts([retrying]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "   ");
  await drafts.save(key, ports);
  expect(patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}", expectedStageDigest: mergeDigest(retrying) }]);
  expect(drafts.get(key)).toBeNull();
});

test("a write with no answer is unconfirmed; Check again settles only on what the stage holds and never writes", async () => {
  const drafts = new StageDrafts(() => 2_000);
  const route = fakePorts([retrying], [{ ok: false, status: 0, error: "Failed to fetch", unknown: true }]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Merge after the warm query.");
  await drafts.save(key, route.ports);
  expect(drafts.get(key)).toMatchObject({ phase: "unconfirmed", text: "Merge after the warm query." });

  /* The stage does not hold the words: still unconfirmed, nothing sent. */
  await drafts.check(key, route.ports);
  expect(drafts.get(key)?.phase).toBe("unconfirmed");
  expect(route.patches).toHaveLength(1);

  /* An unreadable pipeline proves nothing either. */
  const unread = fakePorts([null]);
  await drafts.check(key, unread.ports);
  expect(drafts.get(key)?.phase).toBe("unconfirmed");

  /* The stage holds them: saved. */
  const landed = fakePorts([withMergePrompt("{{prev.output}}\n\nMerge after the warm query.")]);
  await drafts.check(key, landed.ports);
  expect(drafts.get(key)).toBeNull();
  expect(drafts.saved(key)).toBe(2_000);
  expect(landed.patches).toEqual([]);
});

test("a save that finds the stage started with the edit's words drops the draft; one that finds the pipeline ended before the start says so", async () => {
  const included = new StageDrafts();
  const first = fakePorts([started("{{prev.output}}\n\nMerge after the warm query.")]);
  included.begin("p-search", "merge", "Stage merge.");
  included.edit(key, "Merge after the warm query.");
  await included.save(key, first.ports);
  expect(included.get(key)).toBeNull();
  expect(first.patches).toEqual([]);

  const ended = new StageDrafts();
  const second = fakePorts([started("{{prev.output}}\n\nStage merge.", neverRan, "closed")]);
  ended.begin("p-search", "merge", "Stage merge.");
  ended.edit(key, "Merge after the warm query.");
  await ended.save(key, second.ports);
  expect(ended.get(key)?.phase).toBe("ended");
  expect(second.patches).toEqual([]);

  /* A draft the stage makes moot goes when the board sees the record; one mid-save is its save's. */
  const moot = new StageDrafts();
  moot.begin("p-search", "merge", "Stage merge.");
  expect(moot.settleFromStage(key, started("{{prev.output}}\n\nStage merge."))).toBe(true);
  expect(moot.get(key)).toBeNull();
});

test("the browser port calls a write with no answer, or an answer without the route's error, unknown; the route's own refusal stays known", async () => {
  const { browserPipelinePorts } = await import("./pipelinePorts");
  const realFetch = globalThis.fetch;
  const answer = (respond: () => Promise<Response>) => { globalThis.fetch = respond as unknown as typeof fetch; };
  try {
    answer(async () => { throw new TypeError("Failed to fetch"); });
    expect(await browserPipelinePorts.patch("p-search", { action: "pause" })).toEqual({ ok: false, status: 0, error: "Failed to fetch", unknown: true });
    answer(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await browserPipelinePorts.patch("p-search", { action: "pause" })).toEqual({ ok: false, status: 502, error: "HTTP 502", unknown: true });
    answer(async () => new Response(JSON.stringify({}), { status: 200 }));
    expect(await browserPipelinePorts.patch("p-search", { action: "pause" })).toMatchObject({ ok: false, unknown: true });
    answer(async () => new Response(JSON.stringify({ error: "pipeline is not paused" }), { status: 409 }));
    expect(await browserPipelinePorts.patch("p-search", { action: "resume" })).toEqual({ ok: false, status: 409, error: "pipeline is not paused" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ── K5c: the engine's own guard on a stage message save ─────────────────── */

const stageChanged: PipelineWriteResult = { ok: false, status: 409, error: "the stage changed since it was read; read it again before overriding it", code: "STAGE_CHANGED", field: "expectedStageDigest" };

test("a stage another client changed between the read and the write is refused by the engine; the save reads it again and shows its words", async () => {
  const drafts = new StageDrafts();
  const theirs = withMergePrompt("{{prev.output}}\n\nMerge only on a green main.");
  const route = fakePorts([retrying, theirs], [stageChanged]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Merge after the rebuild settles.");
  await drafts.save(key, route.ports);
  expect(route.patches).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the rebuild settles.", expectedStageDigest: mergeDigest(retrying) }]);
  expect(route.reads).toEqual(["p-search", "p-search"]);
  expect(drafts.get(key)).toMatchObject({ phase: "changed", theirs: "Merge only on a green main.", text: "Merge after the rebuild settles." });
  expect(drafts.saved(key)).toBeNull();
});

test("when only the stage's account, role or runtime changed, its words are the same, and Keep mine writes against the new digest", async () => {
  const drafts = new StageDrafts();
  const otherAccount = { ...retrying, stages: retrying.stages.map((entry) => (entry.id === "merge" ? { ...entry, account: "account-b" } : entry)) } as Pipeline;
  const route = fakePorts([retrying, otherAccount, otherAccount], [stageChanged]);
  drafts.begin("p-search", "merge", "Stage merge.");
  drafts.edit(key, "Merge after the rebuild settles.");
  await drafts.save(key, route.ports);
  expect(drafts.get(key)).toMatchObject({ phase: "changed", theirs: "Stage merge.", base: "Stage merge." });
  await drafts.save(key, route.ports, { keepMine: true });
  expect(route.patches.map((patch) => patch.expectedStageDigest)).toEqual([mergeDigest(retrying), mergeDigest(otherAccount)]);
  expect(drafts.get(key)).toBeNull();
});

test("a read that carries no digest for the stage writes nothing, and a stage that started before the re-read settles as started", async () => {
  const unguarded = new StageDrafts();
  const bare: PipelinePorts = { refresh: () => {}, read: async () => ({ pipeline: retrying, stageDigests: {} }), patch: async () => { throw new Error("no write may be sent"); } };
  unguarded.begin("p-search", "merge", "Stage merge.");
  unguarded.edit(key, "Merge after the rebuild settles.");
  await unguarded.save(key, bare);
  expect(unguarded.get(key)).toMatchObject({ phase: "failed", error: { kind: "read" } });

  const raced = new StageDrafts();
  const route = fakePorts([retrying, started("{{prev.output}}\n\nStage merge.")], [stageChanged]);
  raced.begin("p-search", "merge", "Stage merge.");
  raced.edit(key, "Merge after the rebuild settles.");
  await raced.save(key, route.ports);
  expect(route.patches).toHaveLength(1);
  expect(raced.get(key)).toMatchObject({ phase: "started", text: "Merge after the rebuild settles." });
});
