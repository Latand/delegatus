import { expect, test } from "bun:test";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { projectTaskTimelines } from "./taskTimeline";

const NOW = Date.parse("2026-11-03T19:00:00Z");
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const task = { id: "task-activity", project: "repo-activity", status: "assigned", createdAt: stamp(-74 * 3_600_000) } as BoardTask;
function lane(): Pipeline {
  return {
    id: "lane-activity", project: task.project, taskIds: [task.id], state: "running", hiddenAt: null,
    createdAt: stamp(-73 * 3_600_000), closedAt: null, cursor: { stageId: "build", state: "running" },
    stages: [{ id: "build", kind: "run", engine: "codex", model: "fixture-model" }],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", historical: false,
      conversationId: "conversation-activity", agentPath: "/fixture/activity.jsonl",
      startedAt: stamp(-72 * 3_600_000), completedAt: null }] }],
  } as unknown as Pipeline;
}
function member(patch: Partial<FileEntry> = {}): FileEntry {
  return { path: "/fixture/activity.jsonl", conversationId: "conversation-activity", project: task.project,
    engine: "codex", kind: "session", root: "codex-sessions", fmt: "codex", model: "fixture-model",
    activity: "idle", proc: "running", mtime: (NOW - 60_000) / 1000,
    lastTurn: { startedAt: NOW - 600_000, endedAt: NOW - 60_000 },
    pendingQuestion: null, waitingInput: null, ...patch } as FileEntry;
}
test.each([
  ["settled native turn", member()],
  ["dead host with an unclosed turn", member({ proc: "killed", activity: "live", lastTurn: { startedAt: NOW - 600_000, endedAt: null } })],
] as const)("Gantt does not claim a 72-hour running attempt is live after %s", (_name, file) => {
  const result = projectTaskTimelines({ project: task.project, tasks: [task], pipelines: [lane()], members: [{ taskId: task.id, file }], nowMs: NOW });
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0]!.pipelines[0]!.attempts[0]!.live).toBe(false);
  expect(result.tasks[0]!.live).toBe(false);
});

test("missing native evidence never promotes a running pipeline to live work", () => {
  const result = projectTaskTimelines({ project: task.project, tasks: [task], pipelines: [lane()], nowMs: NOW });
  const attempt = result.tasks[0]!.pipelines[0]!.attempts[0]!;
  expect(attempt.live).toBe(false);
  expect(attempt.activity).toBe("unknown");
  expect(attempt.observedTurn).toBeNull();
  expect(attempt.endAtMs).toBe(NOW); // The open lifecycle still includes waiting.
});

test("the known current turn remains separate from a 72-hour attempt lifetime", () => {
  const file = member({ activity: "live", lastTurn: { startedAt: NOW - 120_000, endedAt: null },
    agentActivity: { lastRecordAt: NOW - 1000, checking: false, check: null } });
  const result = projectTaskTimelines({ project: task.project, tasks: [task], pipelines: [lane()], members: [{ taskId: task.id, file }], nowMs: NOW });
  const attempt = result.tasks[0]!.pipelines[0]!.attempts[0]!;
  expect(attempt.live).toBe(true);
  expect(attempt.startedAtMs).toBe(NOW - 72 * 3_600_000);
  expect(attempt.observedTurn).toEqual({ startedAtMs: NOW - 120_000, endAtMs: NOW });
  expect(result.tasks[0]!.agents).toEqual([]);
});

test("a closed native turn supplies only its own interval and leaves the later gap unproven", () => {
  const file = member();
  const result = projectTaskTimelines({ project: task.project, tasks: [task], pipelines: [lane()], members: [{ taskId: task.id, file }], nowMs: NOW });
  expect(result.tasks[0]!.pipelines[0]!.attempts[0]!.observedTurn)
    .toEqual({ startedAtMs: NOW - 600_000, endAtMs: NOW - 60_000 });
});
