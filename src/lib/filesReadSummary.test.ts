import { expect, test } from "bun:test";
import type { Flow } from "./flows/types";
import type { Pipeline } from "./pipelines/types";
import { filesReadSummary } from "./filesReadSummary";

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
