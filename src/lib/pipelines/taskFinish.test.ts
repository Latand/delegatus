import { expect, test } from "bun:test";

import { finishesTaskOffer } from "@/components/pipelines/finishesTask";

import { openPipelinesOnTask, pipelineTaskFinishState, taskFinishWaitCount } from "./taskFinish";
import type { Pipeline, PipelineState } from "./types";

/* The rules the board and the finish sweep share (#2187 §5-§6), on invented records. */
const TASK = "task-big";
const lane = (id: string, state: PipelineState, extra: Partial<Pipeline> = {}) => ({ id, state, taskIds: [TASK], ...extra }) as unknown as Pipeline;

test("only started, unended pipelines on the task hold its move to Done", () => {
  const pipelines = [
    lane("marked", "completed", { finishesTaskIds: [TASK] }),
    lane("running", "running"), lane("paused", "paused"), lane("review", "needs_review"), lane("decide", "needs_decision"), lane("boot", "provisioning"),
    lane("plan", "draft"), lane("done", "completed"), lane("gone", "closed"),
    lane("elsewhere", "running", { taskIds: ["task-other"] }),
  ];
  expect(openPipelinesOnTask(pipelines, TASK, "marked")).toEqual(["boot", "decide", "paused", "review", "running"]);
});

test("a lane row's state for its task: marked, waiting with the count, finished, or none", () => {
  expect(pipelineTaskFinishState(lane("a", "running", { finishesTaskIds: [TASK] }), TASK)).toEqual({ kind: "marked" });
  expect(pipelineTaskFinishState(lane("a", "completed", { finishesTaskIds: [TASK], taskFinishWaits: [{ taskId: TASK, since: "x", open: ["b", "c"] }] }), TASK)).toEqual({ kind: "waits", open: 2 });
  expect(pipelineTaskFinishState(lane("a", "completed", { finishesTaskIds: [TASK], taskFinishes: [{ taskId: TASK, at: "x", outcome: "moved" }] }), TASK)).toEqual({ kind: "finished" });
  expect(pipelineTaskFinishState(lane("a", "running"), TASK)).toBeNull();
  /* A flag for a task the lane no longer links says nothing. */
  expect(pipelineTaskFinishState(lane("a", "running", { taskIds: [], finishesTaskIds: [TASK] }), TASK)).toBeNull();
  const card = [lane("a", "completed", { finishesTaskIds: [TASK], taskFinishWaits: [{ taskId: TASK, since: "x", open: ["b"] }] }), lane("b", "running")];
  expect(taskFinishWaitCount(card, TASK)).toBe(1);
  expect(taskFinishWaitCount([lane("b", "running")], TASK)).toBe(0);
});

test("the menu offers the toggle checked or not, with the count of other open lanes, and not where it means nothing", () => {
  const pipelines = [lane("a", "running"), lane("b", "running"), lane("c", "draft")];
  expect(finishesTaskOffer(pipelines[0]!, TASK, pipelines)).toEqual({ checked: false, open: 1 });
  const marked = lane("a", "running", { finishesTaskIds: [TASK] });
  expect(finishesTaskOffer(marked, TASK, [marked, pipelines[1]!])).toEqual({ checked: true, open: 1 });
  expect(finishesTaskOffer(marked, TASK, [marked])).toEqual({ checked: true, open: 0 });
  expect(finishesTaskOffer(marked, null, [marked])).toBeNull();
  expect(finishesTaskOffer(lane("a", "closed"), TASK, [])).toBeNull();
  expect(finishesTaskOffer(lane("a", "completed", { taskFinishes: [{ taskId: TASK, at: "x", outcome: "moved" }] }), TASK, [])).toBeNull();
});
