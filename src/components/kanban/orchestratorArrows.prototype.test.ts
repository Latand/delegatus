import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { orchestratorLinks } from "./orchestratorArrows.prototype";

/* The link rule the design proposes (docs/design/orchestrator-arrows.md §2). */

const SEAT = "conversation_seat";
const task = (id: string, status: BoardTask["status"] = "assigned", conversationIds: string[] = []) =>
  ({ id, status, assignments: conversationIds.map((conversationId) => ({ conversationId, path: `/t/${conversationId}.jsonl` })) }) as unknown as BoardTask;
const lane = (id: string, taskIds: string[], state: Pipeline["state"], over: Partial<Pipeline> = {}) =>
  ({ id, taskIds, state, srcConversationId: SEAT, hiddenAt: null, ...over }) as unknown as Pipeline;
const file = (conversationId: string, parent: string | null, over: Partial<FileEntry> = {}) =>
  ({ conversationId, path: `/t/${conversationId}.jsonl`, activity: "idle", durableLineage: { parentConversationId: parent }, ...over }) as unknown as FileEntry;

describe("orchestratorLinks", () => {
  test("a lane the seat made links its open tasks, with the lane's tone", () => {
    const links = orchestratorLinks({
      seatConversationIds: [SEAT],
      tasks: [task("a"), task("b"), task("c", "done")],
      pipelines: [lane("p1", ["a"], "running"), lane("p2", ["b"], "needs_decision"), lane("p3", ["c"], "running")],
      files: [],
    });
    expect(links).toEqual([
      { taskId: "a", via: "pipeline", pipelineId: "p1", tone: "live" },
      { taskId: "b", via: "pipeline", pipelineId: "p2", tone: "needs" },
    ]);
  });

  test("another conversation's lane, a closed lane and a draft draw nothing", () => {
    const links = orchestratorLinks({
      seatConversationIds: [SEAT],
      tasks: [task("a"), task("b"), task("c")],
      pipelines: [lane("p1", ["a"], "running", { srcConversationId: "conversation_other" }), lane("p2", ["b"], "closed"), lane("p3", ["c"], "draft")],
      files: [],
    });
    expect(links).toEqual([]);
  });

  test("a lane the seat's deputy made is the seat's", () => {
    const links = orchestratorLinks({
      seatConversationIds: [SEAT],
      tasks: [task("a")],
      pipelines: [lane("p1", ["a"], "completed", { srcConversationId: "conversation_deputy", srcDeputyConversationId: SEAT })],
      files: [],
    });
    expect(links).toEqual([{ taskId: "a", via: "pipeline", pipelineId: "p1", tone: "idle" }]);
  });

  test("an agent the seat spawned links its task; the most urgent link wins, a lane before a spawn", () => {
    const links = orchestratorLinks({
      seatConversationIds: [SEAT, null],
      tasks: [task("a", "assigned", ["w1"]), task("b", "assigned", ["w2"]), task("c", "inbox", ["w3"])],
      pipelines: [lane("p1", ["a"], "completed"), lane("p2", ["b"], "running")],
      files: [file("w1", SEAT, { waitingInput: { since: 1 } } as Partial<FileEntry>), file("w2", SEAT, { activity: "live" } as Partial<FileEntry>), file("w3", "conversation_other")],
    });
    expect(links).toEqual([
      { taskId: "a", via: "spawn", pipelineId: null, tone: "needs" },
      { taskId: "b", via: "pipeline", pipelineId: "p2", tone: "live" },
    ]);
  });

  test("no seat, no links", () => {
    expect(orchestratorLinks({ seatConversationIds: [null], tasks: [task("a")], pipelines: [lane("p1", ["a"], "running")], files: [] })).toEqual([]);
  });
});
