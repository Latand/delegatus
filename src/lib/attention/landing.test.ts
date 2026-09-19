import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { allCards, cardAnchors, conversationOwners, kanbanFocusIndex } from "@/components/kanban/kanbanFocus";
import { buildKanbanModel } from "@/components/kanban/kanbanModel";
import { createFocusHandoffBus } from "@/components/attention/focusHandoffBus";
import { runFocusHandoff } from "@/components/attention/navigate";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { resetPresenceForTest } from "@/lib/view/presenceStore";

import { attentionForDevice, raiseAttentionRequest } from "./service";
import type { AttentionRecordSources } from "./targetRecords";
import type { FocusTarget } from "./types";

/**
 * A lane the server has admitted and the board has not drawn yet (#1836).
 *
 * The production failure, reproduced end to end over the real pieces: the
 * server's device read, the board's own projection, and the navigator. A
 * pipeline was created at 08:28:04 and `request_attention` on it answered
 * TARGET_LOST a minute later — not because the navigator was wrong, but
 * because `/api/files` is a whole-corpus scan of about fourteen seconds served
 * stale-while-revalidate, so the browser's payload did not carry the pipeline
 * or its task, and a card that does not exist has no anchor to land on.
 *
 * The board here is the kanban board the operator was actually on: no camera,
 * cards from the same band projection the scheme uses. `clientPayload` is the
 * browser's stale copy, and applying the pushed records is the client's data
 * layer learning the rows from the request itself.
 */

let sandbox = "";
let previousStateDir: string | undefined;

const NOW = 1_800_000_000;
const DEVICE = "device-desktop";
const PROJECT = "repo-fixture";
/** The instant of the production report: the request is raised and read at it,
    so the landing grace is not what decides this test. */
const T0 = new Date("2026-09-19T08:29:25.825Z");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-landing-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPresenceForTest();
});

afterEach(() => {
  resetPresenceForTest();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const lane: Pipeline = {
  id: "pl-fresh",
  task: "A lane just created",
  project: PROJECT,
  state: "provisioning",
  cursor: { stageId: "build", state: "pending", input: null, activatedBy: null },
  stages: [
    { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: {} },
    { id: "review", kind: "run", prompt: "", next: null, effectiveRole: {} },
  ],
  runs: [],
  taskIds: ["task-fresh"],
  createdAt: "2026-09-19T08:28:04.028Z",
} as unknown as Pipeline;

const laneTask: BoardTask = {
  id: "task-fresh",
  project: PROJECT,
  text: "A lane just created\nWhat the lane is for",
  status: "inbox",
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-09-19T08:27:35.616Z",
  updatedAt: "2026-09-19T08:27:35.616Z",
} as unknown as BoardTask;

const serverKnows: AttentionRecordSources = { pipelines: () => [lane], tasks: () => [laneTask] };
const serverKnowsNothing: AttentionRecordSources = { pipelines: () => [], tasks: () => [] };

/** The browser's own copy of the board rows — the stale scan payload. */
function clientPayload() {
  const pipelines: Pipeline[] = [];
  const tasks: BoardTask[] = [];
  return {
    pipelines,
    tasks,
    /** What the poll does with the rows the read carried. */
    apply(records: ReturnType<typeof attentionForDevice>["records"]) {
      for (const pipeline of records?.pipelines ?? []) {
        const at = pipelines.findIndex((held) => held.id === pipeline.id);
        if (at < 0) pipelines.push(pipeline);
        else pipelines[at] = pipeline;
      }
      for (const task of records?.tasks ?? []) {
        const at = tasks.findIndex((held) => held.id === task.id);
        if (at < 0) tasks.push(task);
        else tasks[at] = task;
      }
    },
  };
}

/** The kanban board this payload draws, as a focus bus the navigator can use. */
function boardFor(payload: ReturnType<typeof clientPayload>) {
  const bus = createFocusHandoffBus();
  const moved: string[] = [];
  const publish = () => {
    const layout = buildSchemeLayout([], [], [], [], [], [...payload.pipelines], [], new Set(), new Set(), [], new Set(), { now: NOW });
    const projection = projectTaskWorkflows([...payload.tasks], [...payload.pipelines], [], []);
    const bands = buildTaskBands(layout, { tasks: payload.tasks, projection, untitled: "Untitled task" });
    const model = buildKanbanModel({ bands, tasks: payload.tasks, pipelines: payload.pipelines, projection, files: [], now: NOW });
    const cards = allCards(model);
    const anchors = cardAnchors(cards, conversationOwners(cards, []));
    bus.setBoard({
      project: PROJECT,
      index: kanbanFocusIndex(model, anchors, PROJECT),
      moveTo: (destination) => {
        const anchor = destination.anchorKeys.find((key) => anchors.has(key));
        if (!anchor) return false;
        moved.push(anchor);
        return true;
      },
      restoreCamera: () => false,
    });
  };
  publish();
  return { bus, moved, publish };
}

function requestFor(target: FocusTarget) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target,
    frameAtCreation: { project: PROJECT, rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
    intent: "show",
    reason: "The lane you just asked for is running.",
    directedAt: DEVICE,
  }, { now: T0 }).request;
}

const laneTargets: Array<[string, FocusTarget]> = [
  ["the pipeline", { kind: "pipeline", pipelineId: "pl-fresh" }],
  ["one of its stages", { kind: "stage", pipelineId: "pl-fresh", stageId: "build" }],
  ["its board task", { kind: "task", taskId: "task-fresh" }],
];

for (const [what, target] of laneTargets) {
  test(`attention on ${what} lands on a lane the board's payload has not carried yet`, async () => {
    const request = requestFor(target);
    const payload = clientPayload();
    const board = boardFor(payload);

    /* The failure as production had it: the browser's payload is the stale
       scan, so the board holds no card for the lane. */
    const stale = await runFocusHandoff(request, board.bus, { timeoutMs: 20, pollMs: 5 });
    expect(stale.resolution).toBe("lost");

    /* The poll that delivers the request delivers the rows behind it. */
    const view = attentionForDevice(DEVICE, { records: serverKnows, now: T0 });
    expect(view.records?.pipelines.map((entry) => entry.id)).toEqual(["pl-fresh"]);
    expect(view.records?.tasks.map((entry) => entry.id)).toEqual(["task-fresh"]);
    payload.apply(view.records);
    board.publish();

    const landed = await runFocusHandoff(request, board.bus, { timeoutMs: 200, pollMs: 5 });
    expect(landed.resolution).toBe("exact");
    expect(landed.moved).toBe(true);
    expect(board.moved).toHaveLength(1);
  });
}

test("the lane is drawn as its title, its task band and one pending slot per stage", () => {
  requestFor({ kind: "pipeline", pipelineId: "pl-fresh" });
  const payload = clientPayload();
  payload.apply(attentionForDevice(DEVICE, { records: serverKnows, now: T0 }).records);
  const layout = buildSchemeLayout([], [], [], [], [], [...payload.pipelines], [], new Set(), new Set(), [], new Set(), { now: NOW });
  const projection = projectTaskWorkflows([...payload.tasks], [...payload.pipelines], [], []);
  const bands = buildTaskBands(layout, { tasks: payload.tasks, projection, untitled: "Untitled task" });
  const model = buildKanbanModel({ bands, tasks: payload.tasks, pipelines: payload.pipelines, projection, files: [], now: NOW });
  const cards = allCards(model);

  /* One card, not two: the pushed pipeline joins the pushed task's band
     rather than deriving a lookalike lane of its own. */
  expect(cards).toHaveLength(1);
  expect(cards[0]!.title).toBe("A lane just created");
  expect(cards[0]!.pipelines[0]!.pipeline.id).toBe("pl-fresh");
  expect(cards[0]!.pipelines[0]!.waiting).toBe(2);
  expect([...cardAnchors(cards, conversationOwners(cards, [])).keys()]).toEqual([
    "task::task-fresh",
    "group::pipeline::pl-fresh",
    "slot::pl-fresh::build",
    "slot::pl-fresh::review",
  ]);
});

test("the real row replaces the pushed one in place, with no second band", () => {
  requestFor({ kind: "pipeline", pipelineId: "pl-fresh" });
  const payload = clientPayload();
  payload.apply(attentionForDevice(DEVICE, { records: serverKnows, now: T0 }).records);
  const running: Pipeline = { ...lane, state: "running" } as Pipeline;
  payload.apply({ pipelines: [running], tasks: [{ ...laneTask, status: "assigned" }] });

  expect(payload.pipelines).toHaveLength(1);
  expect(payload.pipelines[0]!.state).toBe("running");
  expect(payload.tasks).toHaveLength(1);
  expect(payload.tasks[0]!.status).toBe("assigned");
});

test("a target the server does not know carries no record and is still lost", async () => {
  const request = requestFor({ kind: "pipeline", pipelineId: "pl-does-not-exist" });
  const payload = clientPayload();
  const board = boardFor(payload);

  const view = attentionForDevice(DEVICE, { records: serverKnowsNothing, now: T0 });
  expect(view.records).toBeNull();
  payload.apply(view.records);
  board.publish();

  const outcome = await runFocusHandoff(request, board.bus, { timeoutMs: 40, pollMs: 5 });
  expect(outcome.resolution).toBe("lost");
  expect(outcome.moved).toBe(false);
  expect(board.moved).toHaveLength(0);
});
