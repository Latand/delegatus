import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { linkedPipelineTasks } from "./pipelineAnchor";

function pipeline(overrides: Record<string, unknown> = {}): Pipeline {
  return {
    id: "pipeline-a",
    task: "Ship the board groups",
    taskIds: [],
    project: "viewer",
    repoDir: "/repo",
    worktreeDir: "/repo-pipeline-a",
    branch: "pipeline/a",
    baseBranch: "main",
    baseRef: "abc",
    lastPassedCommit: "abc",
    stages: [],
    runs: [],
    cursor: null,
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  } as Pipeline;
}

function task(id: string, pos?: { x: number; y: number }): BoardTask {
  return {
    id,
    project: "viewer",
    status: "assigned",
    text: id,
    placement: pos ? "pinned" : "unplaced",
    ...(pos ? { pos } : {}),
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function source(path: string): NonNullable<BoardTask["source"]> {
  return { path, ts: null, text: "Linked task", fingerprint: "synthetic", engine: "codex" };
}

describe("linkedPipelineTasks", () => {
  test("includes explicit taskIds in board-task order and ignores missing ids", () => {
    const first = task("task-1", { x: 20, y: 40 });
    const second = task("task-2", { x: 420, y: 180 });

    expect(linkedPipelineTasks(
      pipeline({ taskIds: [second.id, "missing", first.id, second.id] }),
      [first, task("unrelated"), second],
    )).toEqual([first, second]);
  });

  test("includes assignments linked by a stage attempt path or conversation id", () => {
    const byPath = {
      ...task("path-link", { x: 760, y: 240 }),
      assignments: [{ path: "/stage.jsonl", panePid: 12, state: "handoff" as const, error: null, at: "2026-07-19T00:00:00.000Z" }],
    };
    const byConversation = {
      ...task("conversation-link"),
      assignments: [{ ...byPath.assignments[0], path: "/moved.jsonl", conversationId: "conversation-stage" }],
    };

    expect(linkedPipelineTasks(
      pipeline({
        runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/stage.jsonl", conversationId: "conversation-stage" }] }],
      }),
      [byPath, task("unrelated"), byConversation],
    )).toEqual([byPath, byConversation]);
  });

  test("keeps unplaced explicit tasks as members alongside placed tasks", () => {
    const unplaced = task("unplaced");
    const placed = task("placed", { x: 900, y: 100 });

    expect(linkedPipelineTasks(
      pipeline({ taskIds: [unplaced.id, placed.id] }),
      [unplaced, placed],
    )).toEqual([unplaced, placed]);
  });

  test("includes task sources from the pipeline origin and historical attempts", () => {
    const origin = { ...task("origin"), source: source("/origin.jsonl") };
    const earlier = { ...task("earlier"), source: source("/earlier.jsonl") };
    const current = { ...task("current"), source: source("/current.jsonl") };
    const unrelated = { ...task("unrelated"), source: source("/other.jsonl") };

    expect(linkedPipelineTasks(
      pipeline({
        srcPath: "/origin.jsonl",
        runs: [{ stageId: "build", attempts: [
          { n: 1, state: "failed", agentPath: "/earlier.jsonl" },
          { n: 2, state: "running", agentPath: "/current.jsonl" },
        ] }],
      }),
      [origin, earlier, unrelated, current],
    )).toEqual([origin, earlier, current]);
  });

  test("includes origin conversation assignments and emits multiply linked tasks once", () => {
    const linked = {
      ...task("origin-link"),
      source: source("/origin.jsonl"),
      assignments: [{ path: "/moved.jsonl", conversationId: "conversation-origin", panePid: 12, state: "handoff" as const, error: null, at: "2026-07-19T00:00:00.000Z" }],
    };
    const origin = pipeline({ srcConversationId: "conversation-origin" });

    expect(linkedPipelineTasks(origin, [linked])).toEqual([linked]);
    expect(linkedPipelineTasks(
      pipeline({ taskIds: [linked.id], srcPath: linked.source.path, srcConversationId: "conversation-origin" }),
      [linked],
    )).toEqual([linked]);
  });

  test("allows multiple pipelines to share a linked task", () => {
    const linked = task("shared", { x: 420, y: 180 });
    for (const id of ["pipeline-a", "pipeline-b"]) {
      expect(linkedPipelineTasks(pipeline({ id, taskIds: [linked.id] }), [linked])).toEqual([linked]);
    }
  });

  test("excludes tasks when no explicit id, source or assignment matches", () => {
    const unrelated = {
      ...task("unrelated"),
      source: source("/other.jsonl"),
      assignments: [{ path: "/other.jsonl", conversationId: "other", panePid: 12, state: "handoff" as const, error: null, at: "2026-07-19T00:00:00.000Z" }],
    };
    expect(linkedPipelineTasks(pipeline(), [task("unlinked"), unrelated])).toEqual([]);
    expect(linkedPipelineTasks(
      pipeline({ srcPath: "/origin.jsonl", srcConversationId: "conversation-origin", taskIds: ["missing"] }),
      [unrelated],
    )).toEqual([]);
    expect(linkedPipelineTasks(pipeline(), [])).toEqual([]);
  });
});
