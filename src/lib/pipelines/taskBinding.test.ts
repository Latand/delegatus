import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import { launchMembershipInput } from "@/lib/tasks/launchMembership";

import { adoptPipelineFallbackTask } from "./engine";
import { buildPipeline } from "./store";
import { ensurePipelineForTask, projectTaskPipelineIds } from "./taskBinding";

const role = {
  roleId: "builder" as const,
  engine: "codex" as const,
  model: "gpt-5.6-sol",
  effort: "high",
  access: "read-write" as const,
  promptScaffold: "Build",
};

const spawnIdentity = {
  launchId: "launch-task-binding",
  conversationId: "conversation_task_binding",
};

function task(): BoardTask {
  return {
    id: "task-binding-1",
    project: "viewer",
    status: "inbox",
    text: "Durable binding\nFull acceptance criteria",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

test("an unlinked task produces a minimal builder pipeline request", () => {
  const decision = ensurePipelineForTask(task(), [], {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    ...spawnIdentity,
    srcPath: "/sessions/assigned.jsonl",
  });

  expect(decision).toEqual({
    task: "Durable binding",
    spec: "Durable binding\nFull acceptance criteria",
    taskIds: ["task-binding-1"],
    repoDir: "/repo",
    src: "/sessions/assigned.jsonl",
    autoStart: false,
    stages: [{
      id: "run",
      kind: "run",
      role: { roleId: "builder" },
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      access: "read-write",
      "prompt": "{{task}}",
      next: null,
    }],
  });
});

test("live links suppress auto-create while closed and hidden links remain history", () => {
  const linked = buildPipeline({
    id: "linked01",
    task: "linked",
    taskIds: [task().id],
    project: "viewer",
    repoDir: "/repo",
    stages: [{ id: "run", kind: "run", prompt: "run", next: null, effectiveRole: role }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });

  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).toBeNull();

  linked.state = "closed";
  linked.cursor = null;
  linked.closedAt = "later";
  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).not.toBeNull();

  linked.state = "provisioning";
  linked.cursor = { stageId: "run", state: "pending", input: null, activatedBy: null };
  linked.closedAt = null;
  linked.hiddenAt = "later";
  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).not.toBeNull();
});

test("auto-create bounds a valid long board-task title to the pipeline limit", () => {
  const longTask = task();
  longTask.text = "x".repeat(4_500);

  const decision = ensurePipelineForTask(longTask, [], {
    repoDir: "/repo",
    engine: "codex",
    model: null,
    effort: null,
    ...spawnIdentity,
    srcPath: "/sessions/assigned.jsonl",
  });

  expect(decision?.task).toHaveLength(4_000);
  expect(decision?.spec).toHaveLength(4_500);
});

/* #1720 — what a manager can actually read back after repairing a binding.
   `pipeline_action "link-task"` writes `pipeline.taskIds` and nothing else: no
   assignment is recorded, and the stages already running stay on the card they
   were admitted to. The task's own read model answers from the pipeline side,
   so the link is visible as `pipelineIds` the moment it lands — which is what
   the mandate tells the seat to confirm, and it must stay true. */
test("a linked pipeline shows on the task as pipelineIds while its assignments stay untouched", () => {
  const board = task();
  const unlinked = buildPipeline({
    id: "repaired1",
    task: "repaired",
    taskIds: [],
    project: "viewer",
    repoDir: "/repo",
    stages: [{ id: "run", kind: "run", prompt: "run", next: null, effectiveRole: role }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });

  expect(projectTaskPipelineIds([board], [unlinked])[0]!.pipelineIds).toEqual([]);

  /* The one write `link-task` performs. */
  unlinked.taskIds.push(board.id);

  const [readBack] = projectTaskPipelineIds([board], [unlinked]);
  expect(readBack!.pipelineIds).toEqual([unlinked.id]);
  expect(readBack!.assignments).toEqual([]);
});

/* #1720 — the repair a manager actually faces. A pipeline created without
   taskIds adopts the placeholder its first stage minted AT THAT STAGE'S
   RESERVATION, so by the time anyone repairs it the list is [placeholder]:
   link-task appends, and later stages join BOTH cards. Re-adoption runs only on
   an EMPTY list, so unlinking the placeholder after the link leaves the outcome
   alone for good — the step that removes the duplicate — while unlinking the
   LAST task brings the placeholder back. The mandate's repair order and its
   "never unlink the last task" rule rest on exactly this. */
test("adopt, link the outcome, unlink the placeholder: no re-adoption, and the next stage names only the outcome", () => {
  const placeholder: BoardTask = { ...task(), id: "fallback-card", origin: { kind: "pipeline", key: "repair01", refinement: "pending" } };
  const outcome: BoardTask = { ...task(), id: "outcome-card" };
  const pipeline = buildPipeline({
    id: "repair01",
    task: "repair",
    taskIds: [],
    project: "viewer",
    repoDir: "/repo",
    stages: [{ id: "run", kind: "run", prompt: "run", next: null, effectiveRole: role }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const stageLaunch = { engine: "codex", cwd: "/repo", origin: { kind: "container" as const, container: "pipeline" as const, containerId: pipeline.id } };
  const nextStage = () => launchMembershipInput(stageLaunch, { launchId: "launch-next", conversationId: "conversation_next" }, () => pipeline.taskIds, () => "viewer");

  /* First stage reservation: adoption. */
  expect(adoptPipelineFallbackTask(pipeline, [placeholder, outcome])).toBe(true);
  expect(pipeline.taskIds).toEqual(["fallback-card"]);

  /* link-task appends: a stage launched now joins both cards. */
  pipeline.taskIds.push(outcome.id);
  expect(nextStage().explicitTaskIds).toEqual(["fallback-card", "outcome-card"]);

  /* unlink-task the placeholder: the list is not empty, so nothing re-adopts. */
  pipeline.taskIds = pipeline.taskIds.filter((id) => id !== placeholder.id);
  expect(adoptPipelineFallbackTask(pipeline, [placeholder, outcome])).toBe(false);
  expect(pipeline.taskIds).toEqual(["outcome-card"]);
  expect(nextStage().explicitTaskIds).toEqual(["outcome-card"]);

  /* Unlinking the LAST task is the step the mandate forbids: the placeholder returns. */
  pipeline.taskIds = [];
  expect(adoptPipelineFallbackTask(pipeline, [placeholder, outcome])).toBe(true);
  expect(pipeline.taskIds).toEqual(["fallback-card"]);
});
