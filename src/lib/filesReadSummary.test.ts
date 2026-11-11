import { expect, test } from "bun:test";
import type { Flow } from "./flows/types";
import type { Pipeline } from "./pipelines/types";
import { filesReadSummary } from "./filesReadSummary";
import { BoardEncoder } from "./boardEncoding";
import { createFilesClientCache } from "@/hooks/useFiles";
import { renderStagePrompt } from "./pipelines/prompts";
import { stageAgentRowModel, stageAccess, stageOverrideBody } from "@/components/pipelines/pipelineModel";
import { stageIdentity } from "@/components/kanban/stageIdentity";

test("board reads retain every historical attempt and recovery handle without execution bodies", () => {
  const text = "Synthetic execution content. ".repeat(2000);
  const flows = [{ id: "flow", spec: text, rounds: [{ n: 1, reviewerPath: "/repo/reviewer", readyNote: "A visible note", relayDelivery: { operationId: "original-relay" } }] }] as unknown as Flow[];
  const pipelines = [{ id: "pipeline", cursor: { stageId: "build", input: text }, stages: [{ id: "build", prompt: "Editable prompt" }],
    runs: [{ stageId: "build", attempts: [{ n: 1, agentPath: "/repo/old", conversationId: "conversation-old", input: text, output: text, historical: true, launchId: "original-launch" },
      { n: 2, agentPath: "/repo/current", conversationId: "conversation-current", input: text, output: null }] }] }] as unknown as Pipeline[];
  const before = JSON.stringify({ flows, pipelines });
  const summary = filesReadSummary(flows, pipelines);
  expect(JSON.stringify(summary).length).toBeLessThan(before.length / 20);
  expect(summary.flows[0]!.rounds).toBe(flows[0]!.rounds);
  expect(summary.pipelines[0]!.stages).toBe(pipelines[0]!.stages);
  expect(summary.pipelines[0]!.runs[0]!.attempts.map(attempt => [attempt.n, attempt.conversationId, attempt.agentPath, attempt.launchId]))
    .toEqual(pipelines[0]!.runs[0]!.attempts.map(attempt => [attempt.n, attempt.conversationId, attempt.agentPath, attempt.launchId]));
  expect(JSON.stringify({ flows, pipelines })).toBe(before);
});


test("board projection retains result lines and drops per-attempt task summary without mutating the report", () => {
  const report = { result: "Result for the timeline", summary: "Publication text", taskSummary: { headline: "Outcome", text: "Detailed task state." } };
  const pipelines = [{ cursor: null, runs: [{ stageId: "build", attempts: [{ report }] }] }] as unknown as Pipeline[];
  const projected = filesReadSummary([], pipelines).pipelines[0]!.runs[0]!.attempts[0]!.report!;
  expect(projected.result).toBe(report.result);
  expect(projected.summary).toBe(report.summary);
  expect(projected).not.toHaveProperty("taskSummary");
  expect(report.taskSummary).toEqual({ headline: "Outcome", text: "Detailed task state." });
});


function retainedLane(): Pipeline {
  const role = { roleId: "builder", engine: "codex", model: "model", effort: "high", access: "read-write", promptScaffold: "Stage scaffold." };
  return {
    id: "lane", project: "project", task: "Task", taskIds: [], spec: "Acceptance",
    branch: "work", state: "running", cursor: { stageId: "build", input: "Input", state: "running" },
    stages: [{ id: "build", kind: "run", prompt: "Editable prompt", next: null, effectiveRole: role }],
    runs: [{ stageId: "build", attempts: ["passed", "failed", "needs_decision", "running"].map((state, index) => ({
      n: index + 1, state, conversationId: `conversation-${index}`, agentPath: `/fixture/attempt-${index}`,
      launchId: `launch-${index}`, input: "Input", output: "Output", historical: index === 0,
      effectiveRole: { ...role, model: `model-${index}`, promptScaffold: "Frozen execution provenance. ".repeat(2000) },
      error: state === "failed" ? "The complete error" : null,
      verdict: { status: state === "failed" ? "fail" : "pass", findings: ["Complete finding"] },
      report: index === 0 ? null : { summary: "Complete report", result: "Visible result" },
    })) }],
  } as unknown as Pipeline;
}

test("attempt scaffold growth does not enlarge bootstrap; stage previews, actions and history keep their inputs", () => {
  const lane = retainedLane();
  const before = structuredClone(lane);
  const projected: Pipeline = filesReadSummary([], [lane]).pipelines[0]!;
  const expected = structuredClone(lane);
  expected.cursor!.input = null;
  for (const run of expected.runs) for (const attempt of run.attempts) {
    attempt.input = null;
    attempt.output = null;
    attempt.effectiveRole.promptScaffold = null;
  }
  expect(projected).toEqual(expected);
  const small = structuredClone(lane);
  for (const run of small.runs) for (const attempt of run.attempts) attempt.effectiveRole.promptScaffold = "Small";
  expect(JSON.stringify(projected).length).toBe(JSON.stringify(filesReadSummary([], [small]).pipelines[0]).length);
  expect(projected.stages).toBe(lane.stages);
  expect(stageAgentRowModel(projected, "build")).toEqual(stageAgentRowModel(lane, "build"));
  expect(stageIdentity(projected, projected.stages[0]!)).toEqual(stageIdentity(lane, lane.stages[0]!));
  expect(stageAccess(projected, projected.stages[0]!)).toBe(stageAccess(lane, lane.stages[0]!));
  expect(renderStagePrompt(projected, projected.stages[0]!, projected.stages[0]!.effectiveRole, "Relay"))
    .toBe(renderStagePrompt(lane, lane.stages[0]!, lane.stages[0]!.effectiveRole, "Relay"));
  const form = { prompt: "Changed", roleId: "", engine: "codex", model: "other", effort: "high" } as const;
  expect(stageOverrideBody(projected.stages[0]!, form)).toEqual(stageOverrideBody(lane.stages[0]!, form));
  expect(lane).toEqual(before);
  // Frozen provenance stays in the detail record even when it differs from the stage.
  expect(lane.runs[0]!.attempts[0]!.effectiveRole.promptScaffold).not.toBe(lane.stages[0]!.effectiveRole.promptScaffold);
});

test("summary survives an old certified base, v2 updates, 304 and full resets without losing details", async () => {
  const lane = retainedLane();
  const data = (pipeline: Pipeline) => ({
    files: [], tasks: [{ id: "task", text: "Task", details: "Complete task details", assignments: [] }],
    ...filesReadSummary([], [pipeline]), readProjection: "board-summary",
  });
  const encoder = new BoardEncoder();
  const legacy = data(lane);
  // A persisted answer from the previous release still includes the scaffold.
  legacy.pipelines[0]!.runs[0]!.attempts.forEach((attempt, i) => {
    attempt.effectiveRole = { ...lane.runs[0]!.attempts[i]!.effectiveRole };
  });
  const old = new BoardEncoder().encode("summary", "epoch", legacy, 1);
  const current = encoder.encode("summary", "epoch", data(lane), 2, { etag: old.etag, readBody: () => old.body });
  expect(current.delta).toBeDefined();
  const updated = structuredClone(lane);
  updated.runs[0]!.attempts[1]!.error = "Updated complete error";
  updated.stages[0]!.effectiveRole.promptScaffold = "Updated stage scaffold";
  const next = encoder.encode("summary", "epoch", data(updated), 3);
  const full = (value: typeof old) => new Response(value.body, { headers: { ETag: value.etag, "x-llv-board-protocol": "2" } });
  const delta = (value: typeof old) => new Response(JSON.stringify({ deltas: [JSON.parse(value.delta!.body)] }), {
    headers: { ETag: value.etag, "x-llv-board-protocol": "2", "x-llv-files-delta-base": value.delta!.base },
  });
  const replies = [
    () => full(old), () => delta(current),
    () => new Response(null, { status: 304, headers: { ETag: current.etag, "x-llv-board-protocol": "2" } }),
    () => delta(next), () => full(next),
  ];
  const cache = createFilesClientCache(async () => replies.shift()!());
  try {
    await cache.revalidate();
    await cache.revalidate();
    expect(cache.read().pipelines).toEqual(data(lane).pipelines);
    const stable = cache.read();
    await cache.revalidate();
    expect(cache.read().pipelines).toBe(stable.pipelines);
    await cache.revalidate();
    expect(cache.read().pipelines).toEqual(data(updated).pipelines);
    await cache.revalidate();
    expect(cache.certifiedGlobal()?.raw).toEqual(JSON.parse(next.body));
    expect(cache.read().tasks[0]!.details).toBe("Complete task details");
  } finally { cache.dispose(); }
});
