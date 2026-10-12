import { expect, test } from "bun:test";

import { probeQuiet, type QuietPorts } from "./quiet";
import { owners } from "./quietTestFixtures";
import type { Snapshot } from "./types";

/* The update confirmation names a running stage by its card, its role and
   its project. The probe carries those from the pipeline record it already
   reads, and a review flow no pipeline owns carries none of them. */

const NOW = Date.parse("2026-01-01T12:00:00Z");
const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

function ports(): QuietPorts {
  return {
    runtimeSnapshot: async () => ({ sessions: [] }) as never,
    owners: owners(),
    pipelines: () => [],
    presence: () => [],
    registryHealth: () => [],
  };
}

test("a running stage carries its project, its role and its first card", async () => {
  const p = ports();
  p.pipelines = () => [{ id: "lane", task: "Fix the update modal\nDetails", state: "running", project: "repo-one", taskIds: ["task-one", "task-two"],
    stages: [{ id: "build", role: { roleId: "builder" } }, { id: "review", role: { roleId: "reviewer" } }],
    cursor: { stageId: "build", state: "running" }, runs: [{ stageId: "build", attempts: [{ conversationId: "conversation_build" }] }] }] as never;
  const { blockers } = await probeQuiet(snapshot, p, NOW);
  expect(blockers.stageList).toEqual([{ pipelineId: "lane", stageId: "build", cursor: "running", task: "Fix the update modal",
    conversationId: "conversation_build", project: "repo-one", roleId: "builder", taskId: "task-one" }]);
});

test("a stage with no role and a lane with no card carry null", async () => {
  const p = ports();
  p.pipelines = () => [{ id: "lane", task: "Legacy lane", state: "running", project: "repo-one", taskIds: [],
    stages: [{ id: "build" }], cursor: { stageId: "build", state: "running" }, runs: [{ stageId: "build", attempts: [{ conversationId: "conversation_build" }] }] }] as never;
  const { blockers } = await probeQuiet(snapshot, p, NOW);
  expect(blockers.stageList?.[0]).toMatchObject({ project: "repo-one", roleId: null, taskId: null });
});

test("a review flow takes its parent's names, and a flow with no parent takes none", async () => {
  const p = ports();
  const flow = (id: string) => ({ id, state: "reviewing", mode: "auto", stateDetail: "Review the change", rounds: [{ reviewerConversationId: `conversation_${id}` }] });
  const withFlows: QuietPorts = { ...p,
    pipelines: () => [{ id: "lane", task: "Fix the update modal", state: "paused", project: "repo-one", taskIds: ["task-one"],
      stages: [{ id: "review", role: { roleId: "reviewer" } }], cursor: null,
      runs: [{ stageId: "review", attempts: [{ flowId: "owned", conversationId: null }] }] }] as never,
    flows: () => [flow("owned"), flow("loose")] as never,
    reviewerProcess: () => ({ state: "alive" }) as never,
  };
  const { blockers } = await probeQuiet(snapshot, withFlows, NOW);
  const byId = new Map((blockers.stageList ?? []).map((stage) => [stage.pipelineId, stage]));
  expect(byId.get("lane")).toMatchObject({ stageId: "review", project: "repo-one", roleId: "reviewer", taskId: "task-one" });
  expect(byId.get("flow:loose")).toMatchObject({ project: null, roleId: null, taskId: null });
});
