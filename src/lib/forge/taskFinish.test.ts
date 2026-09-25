import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline, PipelineMerge, PipelineState } from "@/lib/pipelines/types";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";
import type { BoardTask } from "@/lib/tasks/types";

/* A pipeline that finishes its task (#2187 §5.2-§5.3) against in-memory
   pipelines and tasks: invented ids, no network. The stores resolve their
   state directory at import, so a sandbox is pinned first; only the last case
   writes one, through the real task store. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-finish-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const { finishBoardTask, laneFinishedForTasks, sweepTaskFinishes } = await import("./autoMerge");
const { createTask } = await import("@/lib/tasks/commands");
const { loadTasks, mutateTasks } = await import("@/lib/tasks/store");
const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-25T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const TASK = "task-big";

function lane(id: string, state: PipelineState, extra: Partial<Pipeline> = {}): Pipeline {
  return {
    id,
    project: "repo-fixture",
    task: `lane ${id}`,
    taskIds: [TASK],
    state,
    closedAt: state === "completed" || state === "closed" ? iso(T0 - 1_000) : null,
    hiddenAt: null,
    createdAt: iso(T0 - 3_600_000),
    lastPassedCommit: "a".repeat(40),
    stages: [],
    runs: [],
    ...extra,
  } as unknown as Pipeline;
}

const merged = (): PipelineMerge => ({ state: "merged", by: "auto-merge", prNumber: 7, repository: "acme/widgets" } as unknown as PipelineMerge);

function harness(options: { lanes: Pipeline[]; setting?: boolean; pr?: boolean; cached?: "merged" | "open"; tasks?: Record<string, BoardTask["status"]> }) {
  const pipelines = new Map(options.lanes.map((pipeline) => [pipeline.id, structuredClone(pipeline)]));
  const tasks = new Map(Object.entries(options.tasks ?? { [TASK]: "assigned" }));
  const moves: Array<{ taskId: string; pipelineId: string }> = [];
  let setting: MergeOnReviewSetting = { enabled: options.setting ?? false, changedAt: iso(T0 - 3_600_000), changedBy: "operator" };
  const ports = {
    now: () => T0,
    run: async () => { throw new Error("no gh here"); },
    loadPipelines: () => [...pipelines.values()].map((pipeline) => structuredClone(pipeline)),
    mutate: async (pipelineId: string, change: (pipeline: Pipeline) => boolean) => {
      const live = pipelines.get(pipelineId);
      if (!live) return false;
      const copy = structuredClone(live);
      if (!change(copy)) return false;
      pipelines.set(pipelineId, copy);
      return true;
    },
    setting: () => setting,
    pullRequestOf: () => (options.pr ? { repository: "acme/widgets", number: 7 } : null),
    cachedState: () => options.cached ?? null,
    finishTask: (taskId: string, pipelineId: string) => {
      const status = tasks.get(taskId);
      if (status === undefined) return "missing" as const;
      if (status === "done") return "already-done" as const;
      tasks.set(taskId, "done");
      moves.push({ taskId, pipelineId });
      return "moved" as const;
    },
  };
  return {
    ports,
    sweep: () => sweepTaskFinishes(ports),
    pipeline: (id: string) => pipelines.get(id)!,
    set: (id: string, change: (pipeline: Pipeline) => void) => change(pipelines.get(id)!),
    status: (taskId = TASK) => tasks.get(taskId),
    reopen: (taskId = TASK) => tasks.set(taskId, "assigned"),
    turnOn: () => { setting = { ...setting, enabled: true }; },
    moves,
  };
}

describe("§5.2: when a marked lane finishes its task", () => {
  test("setting off: the lane completing moves the task once, attributed to the pipeline, and its PR stays open", async () => {
    const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })], setting: false, pr: true, cached: "open" });
    await h.sweep();
    expect(h.status()).toBe("done");
    expect(h.moves).toEqual([{ taskId: TASK, pipelineId: "marked" }]);
    expect(h.pipeline("marked").taskFinishes).toEqual([{ taskId: TASK, at: iso(T0), outcome: "moved" }]);
    const events = projectPipelineEvents([h.pipeline("marked")]).filter((event) => event.type === "task_finished");
    expect(events).toEqual([expect.objectContaining({ key: `pipeline:marked:finished-task:${TASK}`, pipelineId: "marked", summary: `task ${TASK} moved to Done by pipeline:marked` })]);
    await h.sweep();
    expect(h.moves).toHaveLength(1);
  });

  test("setting on, no PR: the lane completing moves the task", async () => {
    const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })], setting: true, pr: false });
    await h.sweep();
    expect(h.status()).toBe("done");
    expect(h.moves).toHaveLength(1);
  });

  test("setting on, a PR: completed is not enough; the merge moves it, by the runner or by anyone", async () => {
    const byRunner = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })], setting: true, pr: true, cached: "open" });
    await byRunner.sweep();
    expect(byRunner.status()).toBe("assigned");
    expect(byRunner.pipeline("marked").taskFinishes).toBeUndefined();
    byRunner.set("marked", (pipeline) => { pipeline.merge = merged(); });
    await byRunner.sweep();
    expect(byRunner.status()).toBe("done");
    expect(byRunner.moves).toHaveLength(1);

    const byAnyone = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })], setting: true, pr: true, cached: "merged" });
    await byAnyone.sweep();
    expect(byAnyone.status()).toBe("done");
  });

  test("a blocked merge leaves the task where it is", async () => {
    const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK], merge: { ...merged(), state: "blocked" } })], setting: true, pr: true, cached: "open" });
    await h.sweep();
    expect(h.status()).toBe("assigned");
  });

  test("needs_review, needs_decision, paused and closed never finish a task", async () => {
    for (const state of ["needs_review", "needs_decision", "paused", "closed", "running"] as const) {
      const h = harness({ lanes: [lane("marked", state, { finishesTaskIds: [TASK] })] });
      await h.sweep();
      expect(h.status()).toBe("assigned");
      expect(laneFinishedForTasks(h.pipeline("marked"), h.ports)).toBe(false);
    }
  });

  test("an unmarked lane never moves its task", async () => {
    const h = harness({ lanes: [lane("plain", "completed")] });
    await h.sweep();
    expect(h.status()).toBe("assigned");
    expect(h.pipeline("plain").taskFinishes).toBeUndefined();
  });

  test("a task already done is only recorded, and a task the operator reopens stays open", async () => {
    const already = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })], tasks: { [TASK]: "done" } });
    await already.sweep();
    expect(already.moves).toHaveLength(0);
    expect(already.pipeline("marked").taskFinishes).toEqual([{ taskId: TASK, at: iso(T0), outcome: "already-done" }]);

    const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] })] });
    await h.sweep();
    expect(h.status()).toBe("done");
    h.reopen();
    await h.sweep();
    await h.sweep();
    expect(h.status()).toBe("assigned");
    expect(h.moves).toHaveLength(1);
  });

  test("a marked id the lane does not link is ignored", async () => {
    const h = harness({ lanes: [lane("marked", "completed", { taskIds: [], finishesTaskIds: [TASK] })] });
    await h.sweep();
    expect(h.status()).toBe("assigned");
  });
});

describe("§5.3: two lanes on one task, the marked one completing while the other runs", () => {
  const twoLanes = (): Pipeline[] => [
    lane("marked", "completed", { finishesTaskIds: [TASK] }),
    lane("other", "running"),
  ];

  test("the task stays, one open lane is recorded, and the other completing moves it on the next sweep", async () => {
    const h = harness({ lanes: twoLanes() });
    await h.sweep();
    expect(h.status()).toBe("assigned");
    expect(h.pipeline("marked").taskFinishWaits).toEqual([{ taskId: TASK, since: iso(T0), open: ["other"] }]);
    expect(h.pipeline("marked").taskFinishes).toBeUndefined();
    /* A second pass over the same state writes nothing. */
    await h.sweep();
    expect(h.pipeline("marked").taskFinishWaits).toEqual([{ taskId: TASK, since: iso(T0), open: ["other"] }]);

    h.set("other", (pipeline) => { pipeline.state = "completed"; });
    await h.sweep();
    expect(h.status()).toBe("done");
    expect(h.moves).toEqual([{ taskId: TASK, pipelineId: "marked" }]);
    expect(h.pipeline("marked").taskFinishWaits).toBeUndefined();
    expect(h.pipeline("marked").taskFinishes).toEqual([{ taskId: TASK, at: iso(T0), outcome: "moved" }]);
  });

  test("and, separately, when the other lane is closed", async () => {
    const h = harness({ lanes: twoLanes() });
    await h.sweep();
    expect(h.status()).toBe("assigned");
    h.set("other", (pipeline) => { pipeline.state = "closed"; });
    await h.sweep();
    expect(h.status()).toBe("done");
    expect(h.pipeline("marked").taskFinishWaits).toBeUndefined();
  });

  test("every open state holds the move, and a lane linked while the task waits counts too", async () => {
    for (const state of ["provisioning", "paused", "needs_review", "needs_decision"] as const) {
      const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] }), lane("other", state)] });
      await h.sweep();
      expect(h.status()).toBe("assigned");
    }
    const h = harness({ lanes: [...twoLanes(), lane("late", "draft", { taskIds: [] })] });
    await h.sweep();
    h.set("other", (pipeline) => { pipeline.state = "completed"; });
    h.set("late", (pipeline) => { pipeline.taskIds = [TASK]; pipeline.state = "running"; });
    await h.sweep();
    expect(h.status()).toBe("assigned");
    expect(h.pipeline("marked").taskFinishWaits).toEqual([{ taskId: TASK, since: iso(T0), open: ["late"] }]);
  });

  test("a draft linked to the task doesn't hold it", async () => {
    const h = harness({ lanes: [lane("marked", "completed", { finishesTaskIds: [TASK] }), lane("plan", "draft")] });
    await h.sweep();
    expect(h.status()).toBe("done");
  });

  test("unmarking a waiting lane drops its wait", async () => {
    const h = harness({ lanes: twoLanes() });
    await h.sweep();
    h.set("marked", (pipeline) => { delete pipeline.finishesTaskIds; });
    await h.sweep();
    expect(h.pipeline("marked").taskFinishWaits).toBeUndefined();
    h.set("other", (pipeline) => { pipeline.state = "completed"; });
    await h.sweep();
    expect(h.status()).toBe("assigned");
  });
});

describe("the production move", () => {
  test("moves the task in its own store and reports a task already there or gone", () => {
    const created = mutateTasks((tasks) => {
      const outcome = createTask(tasks, { project: "repo-fixture", text: "Ship the big thing", placement: "unplaced" });
      if (!outcome.ok) throw new Error(outcome.error);
      return { tasks: outcome.tasks, result: outcome.task };
    });
    expect(finishBoardTask(created.id)).toBe("moved");
    expect(loadTasks().find((task) => task.id === created.id)?.status).toBe("done");
    expect(finishBoardTask(created.id)).toBe("already-done");
    expect(finishBoardTask("no-such-task")).toBe("missing");
  });
});
