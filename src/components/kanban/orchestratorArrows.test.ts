import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { ORCHESTRATOR_BURST_LIMIT, orchestratorLinks, seatActions } from "./orchestratorArrows";

/* The link rule and the seat's actions (docs/design/orchestrator-arrows.md §2, §5). */

const SEAT = "conversation_seat";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1_000).toISOString();
const seatActor = { kind: "agent" as const, role: "orchestrator", conversationId: SEAT };
const task = (id: string, status: BoardTask["status"] = "assigned", conversationIds: string[] = [], over: Partial<BoardTask> = {}) =>
  ({ id, status, assignments: conversationIds.map((conversationId) => ({ conversationId, path: `/t/${conversationId}.jsonl` })), ...over }) as unknown as BoardTask;
const lane = (id: string, taskIds: string[], state: Pipeline["state"], over: Record<string, unknown> = {}) =>
  ({ id, taskIds, state, srcConversationId: SEAT, hiddenAt: null, createdAt: at(3_600), runs: [], ...over }) as unknown as Pipeline;
const file = (conversationId: string, parent: string | null, over: Partial<FileEntry> = {}) =>
  ({ conversationId, path: `/t/${conversationId}.jsonl`, activity: "idle", durableLineage: { parentConversationId: parent }, ...over }) as unknown as FileEntry;
const run = (stageId: string, ...attempts: Record<string, unknown>[]) => ({ stageId, attempts: attempts.map((attempt, index) => ({ n: index + 1, state: "running", ...attempt })) });

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

describe("seatActions", () => {
  const actions = (before: { tasks?: BoardTask[]; pipelines?: Pipeline[] }, after: { tasks?: BoardTask[]; pipelines?: Pipeline[] }, seat: (string | null)[] = [SEAT]) =>
    seatActions({ tasks: before.tasks ?? [], pipelines: before.pipelines ?? [] }, { tasks: after.tasks ?? [], pipelines: after.pipelines ?? [] }, seat, NOW);

  test("a board that did not change holds no action", () => {
    const tasks = [task("a", "assigned", [], { statusBy: { actor: seatActor, from: "inbox", at: at(5) } })];
    const pipelines = [lane("p1", ["a"], "running", { createdAt: at(5) })];
    expect(seatActions({ tasks, pipelines }, { tasks, pipelines }, [SEAT], NOW)).toEqual([]);
    expect(actions({ tasks, pipelines }, { tasks: [...tasks], pipelines: [...pipelines] })).toEqual([]);
  });

  test("a new lane the seat made is a started pipeline on each of its tasks", () => {
    expect(actions({ pipelines: [] }, { pipelines: [lane("p1", ["a", "b"], "running", { createdAt: at(2) })] })).toEqual([
      { kind: "pipeline", taskId: "a", pipelineId: "p1" },
      { kind: "pipeline", taskId: "b", pipelineId: "p1" },
    ]);
  });

  test("a lane somebody else made, a draft, and an old lane that only now entered the list are no action", () => {
    expect(actions({}, { pipelines: [
      lane("p1", ["a"], "running", { createdAt: at(2), srcConversationId: "conversation_other" }),
      lane("p2", ["b"], "draft", { createdAt: at(2) }),
      lane("p3", ["c"], "running", { createdAt: at(86_400) }),
    ] })).toEqual([]);
  });

  test("a move the seat made is an action; the operator's, a stage agent's and an unattributed one are not", () => {
    const before = [task("a", "inbox"), task("b", "inbox"), task("c", "inbox"), task("d", "inbox")];
    const after = [
      task("a", "assigned", [], { statusBy: { actor: seatActor, from: "inbox", at: at(1) } }),
      task("b", "assigned", [], { statusBy: { actor: { kind: "operator" }, from: "inbox", at: at(1) } }),
      task("c", "assigned", [], { statusBy: { actor: { kind: "agent", role: "builder", conversationId: "conversation_worker" }, from: "inbox", at: at(1) } }),
      task("d", "assigned"),
    ];
    expect(actions({ tasks: before }, { tasks: after })).toEqual([{ kind: "move", taskId: "a", pipelineId: null }]);
  });

  test("a second move by the seat is a new action, and the same record read again is not", () => {
    const first = task("a", "assigned", [], { statusBy: { actor: seatActor, from: "inbox", at: at(30) } });
    const second = task("a", "blocked", [], { statusBy: { actor: seatActor, from: "assigned", at: at(1) } });
    expect(actions({ tasks: [first] }, { tasks: [second] })).toEqual([{ kind: "move", taskId: "a", pipelineId: null }]);
    expect(actions({ tasks: [first] }, { tasks: [{ ...first, text: "Renamed" } as BoardTask] })).toEqual([]);
  });

  test("a task the seat created is an action; a row that only gained an old record is not", () => {
    expect(actions({ tasks: [] }, { tasks: [task("a", "inbox", [], { statusBy: { actor: seatActor, from: null, at: at(1) } })] })).toEqual([{ kind: "task", taskId: "a", pipelineId: null }]);
    expect(actions({ tasks: [] }, { tasks: [task("a", "inbox", [], { statusBy: { actor: seatActor, from: null, at: at(86_400) } })] })).toEqual([]);
  });

  test("a relaunch the seat recorded is a launched stage; the engine's own next stage is not", () => {
    const before = lane("p1", ["a"], "running", { runs: [run("build", { startedAt: at(600), state: "failed" })] });
    const relaunched = lane("p1", ["a"], "running", {
      runs: [run("build", { startedAt: at(600), state: "failed" }, { startedAt: at(1) })],
      remoteAction: { id: "r", action: "retry-stage", state: "settled", fence: "f", at: at(3), actor: seatActor },
    });
    expect(actions({ pipelines: [before] }, { pipelines: [relaunched] })).toEqual([{ kind: "stage", taskId: "a", pipelineId: "p1" }]);
    const advanced = lane("p1", ["a"], "running", { runs: [run("build", { startedAt: at(600), state: "passed" }), run("review", { startedAt: at(1), activatedBy: { stageId: "build", attempt: 1, edge: "pass" } })] });
    expect(actions({ pipelines: [before] }, { pipelines: [advanced] })).toEqual([]);
  });

  test("a relaunch by the operator, and one with no writer on record, draw nothing", () => {
    const before = lane("p1", ["a"], "running", { runs: [run("build", { startedAt: at(600), state: "failed" })] });
    const runs = [run("build", { startedAt: at(600), state: "failed" }, { startedAt: at(1) })];
    expect(actions({ pipelines: [before] }, { pipelines: [lane("p1", ["a"], "running", { runs, remoteAction: { id: "r", action: "retry-stage", state: "settled", fence: "f", at: at(3), actor: { kind: "operator" } } })] })).toEqual([]);
    expect(actions({ pipelines: [before] }, { pipelines: [lane("p1", ["a"], "running", { runs })] })).toEqual([]);
    /* A relaunch the seat recorded long before this attempt is not this attempt's. */
    expect(actions({ pipelines: [before] }, { pipelines: [lane("p1", ["a"], "running", { runs, remoteAction: { id: "r", action: "retry-stage", state: "settled", fence: "f", at: at(7_200), actor: seatActor } })] })).toEqual([]);
  });

  test("an attempt the seat's decision answer created is a launched stage", () => {
    const before = lane("p1", ["a"], "needs_decision", { runs: [run("build", { startedAt: at(600), state: "needs_decision" })] });
    const answered = (actor: unknown) => lane("p1", ["a"], "running", {
      runs: [run("build", { startedAt: at(600), state: "needs_decision" }, { startedAt: at(1), decisionAnswerId: "answer-1" })],
      decisionAnswers: [{ clientRequestId: "answer-1", stageId: "build", attempt: 1, nextAttempt: 2, actor, at: at(2) }],
    });
    expect(actions({ pipelines: [before] }, { pipelines: [answered(seatActor)] })).toEqual([{ kind: "stage", taskId: "a", pipelineId: "p1" }]);
    expect(actions({ pipelines: [before] }, { pipelines: [answered({ kind: "operator" })] })).toEqual([]);
  });

  test("one action per card, a started pipeline before a move", () => {
    const moved = task("a", "assigned", [], { statusBy: { actor: seatActor, from: "inbox", at: at(1) } });
    expect(actions({ tasks: [task("a", "inbox")] }, { tasks: [moved], pipelines: [lane("p1", ["a"], "running", { createdAt: at(1) })] })).toEqual([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
  });

  test("a burst above the limit is no action at all, and the limit itself still draws", () => {
    const moves = (count: number) => Array.from({ length: count }, (_, index) => task(`t${index}`, "assigned", [], { statusBy: { actor: seatActor, from: "inbox", at: at(1) } }));
    const before = (count: number) => Array.from({ length: count }, (_, index) => task(`t${index}`, "inbox"));
    expect(actions({ tasks: before(ORCHESTRATOR_BURST_LIMIT) }, { tasks: moves(ORCHESTRATOR_BURST_LIMIT) })).toHaveLength(ORCHESTRATOR_BURST_LIMIT);
    expect(actions({ tasks: before(ORCHESTRATOR_BURST_LIMIT + 1) }, { tasks: moves(ORCHESTRATOR_BURST_LIMIT + 1) })).toEqual([]);
  });

  test("no seat, no actions", () => {
    expect(actions({}, { pipelines: [lane("p1", ["a"], "running", { createdAt: at(1) })] }, [null])).toEqual([]);
  });
});
