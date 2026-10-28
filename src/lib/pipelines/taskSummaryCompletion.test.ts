import { afterEach, expect, test } from "bun:test";
import { fs, realWorktreeLane, loadPipelines, savePipelines, saveTasks, loadTasks, tickPipelines, finishReported, engineModule } from "./engine.fixture";
import { isStoredPipeline } from "./store";
import type { StageCompletionRequest } from "./engine";

const roots: string[] = [];
afterEach(() => { saveTasks([]); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const stage = (id: string, next: string | null, extra: Record<string, unknown> = {}) => ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next, ...extra });
const current = () => loadPipelines()[0]!;
const content = { headline: "Task complete", text: "Storage is updated in 6\u00a0s. Reads retain the outcome.", left: "Interface follows." };

async function fixture(stages: unknown[]) {
  const f = await realWorktreeLane("task-summary", stages);
  roots.push(f.root);
  const now = "2026-10-02T10:00:00.000Z";
  const tasks = ["task-a", "task-b", "foreign"].map(id => ({ id, text: "Retain summary", project: id === "foreign" ? "other" : "viewer", status: "assigned" as const,
    placement: "unplaced" as const, assignments: [], createdAt: now, updatedAt: now }));
  saveTasks(tasks);
  const pipeline = current(); pipeline.taskIds = [...tasks.map(task => task.id), "missing"]; savePipelines([pipeline]);
  f.h.setConversationActive(false);
  const report = (n: number, request: StageCompletionRequest) => engineModule.reportStageCompletion(request,
    { kind: "agent", role: "builder", conversationId: `conversation_stage_${n}` }, f.h.ports);
  const finish = (n: number, verdict: "pass" | "fail") => tickPipelines([finishReported(f.h, `/codex/stage-${n}.jsonl`, verdict, "Stage concluded.")], f.h.ports);
  return { ...f, report, finish };
}

test.each(["pass", "fail", "absent", "refresh", "earlier"] as const)("only the completing pass applies the task summary: %s", async kind => {
  const f = await fixture(kind === "earlier" ? [stage("build", "verify"), stage("verify", null)] : [stage("build", null)]);
  if (kind === "refresh") { const pipeline = current(); pipeline.refreshOf = { pipelineId: "source", base: f.base }; savePipelines([pipeline]); }
  expect((await f.report(1, { verdict: kind === "fail" ? "fail" : "pass", ...(kind === "absent" ? {} : { taskSummary: content, result: "Stored the outcome (1\u00a0→\u00a02\u00a0s)." }) })).error).toBeUndefined();
  if (kind !== "absent") {
    expect(current().runs[0]!.attempts[0]!.report).toMatchObject({ taskSummary: content, result: "Stored the outcome (1\u00a0→\u00a02\u00a0s)." });
    const valid = current();
    expect(isStoredPipeline(valid)).toBe(true);
    for (const fields of [{ result: "x".repeat(161) }, { result: 42 }, { result: "two\nlines" }, { taskSummary: { headline: "", text: "Body" } }]) {
      const invalid = structuredClone(valid); Object.assign(invalid.runs[0]!.attempts[0]!.report!, fields);
      expect(isStoredPipeline(invalid)).toBe(false);
      expect(() => savePipelines([invalid])).toThrow("refusing to persist a malformed pipeline record");
    }
  }
  await f.finish(1, kind === "fail" ? "fail" : "pass");
  if (kind === "earlier") {
    await tickPipelines([], f.h.ports);
    expect((await f.report(2, { verdict: "pass" })).error).toBeUndefined();
    await f.finish(2, "pass");
  }
  for (const task of loadTasks()) {
    if (kind === "pass" && task.project === "viewer") expect(task.summary).toEqual({ ...content, updatedAt: current().closedAt!,
      author: { kind: "stage", pipelineId: f.id, stageId: "build", attempt: 1, conversationId: "conversation_stage_1" } });
    else expect(task.summary).toBeUndefined();
  }
  expect(current().state).toBe(kind === "fail" ? "needs_decision" : "completed");
});

test("a failed report's summary cannot leak through the succeeding fix and final review", async () => {
  const f = await fixture([stage("review", null, { onFail: { to: "fix", maxRounds: 1 } }), stage("fix", "review")]);
  expect((await f.report(1, { verdict: "fail", findings: [{ severity: "P2", text: "Repair required" }], taskSummary: content })).error).toBeUndefined();
  await f.finish(1, "fail");
  await tickPipelines([], f.h.ports);
  expect((await f.report(2, { verdict: "pass" })).error).toBeUndefined();
  await f.finish(2, "pass");
  expect(current().state).toBe("running");
  expect(loadTasks().every(task => !task.summary)).toBe(true);
  await tickPipelines([], f.h.ports);
  expect((await f.report(3, { verdict: "pass" })).error).toBeUndefined();
  await f.finish(3, "pass");
  expect(current().state).toBe("completed");
  expect(loadTasks().every(task => !task.summary)).toBe(true);
});
