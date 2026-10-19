import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { deepFreeze } from "@/lib/deepFreeze";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { readPrototypeReviews, withPrototypeReviewSummaries } from "@/lib/prototypeReview/read";
import { prototypeReviewNotices } from "@/lib/prototypeReview/model";

import {
  DISMISSAL_CAPACITY,
  DISMISSAL_RETENTION_MS,
  DismissalError,
  attentionEscalationIndex,
  dismissAttention,
  overlayAttentionDismissals,
  parseDismissalTarget,
  readAttentionDismissals,
  systemClearAttention,
  writeAttentionEscalation,
  type DismissalPorts,
  type SystemAttentionClear,
} from "./dismissals";
import type { DismissedBy } from "./dismissalTypes";
import { needsYouAnswer } from "./needsYouRead";
import { attentionSystemClears } from "./reconcile";
import { reconcileAttentionOnce, type AttentionReconcilePorts } from "./reconcileController";
import { openBridgeAsks } from "@/lib/bridge/asks";
import type { BridgeReportLogV1 } from "@/lib/bridge/types";

/*
 * The one dismissal service (docs/design/needs-attention.md §5): a card's click
 * and an agent's `dismiss_attention` write the same record through it. These
 * drive the real store in a sandboxed state directory and stand in only for
 * the registry, the task store and the engine, whose own writes their own
 * suites cover.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-dismissals-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  closeAgentRegistryForTests();
  resetLegacyDocumentStoresForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const OPERATOR: DismissedBy = { kind: "operator", surface: "desktop" };
const SEAT: DismissedBy = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };

test.each(["done", "relaunched"])("a %s launch leaves both waiting projections with a stored reason and Undo", async (settlement) => {
  const now = new Date("2026-10-14T17:00:00Z");
  const file = { path: "spawn:launch-settled", conversationId: "conversation_launch_settled", project: "repo-fixture", title: "Failed launch", mtime: now.getTime() / 1000 - 60,
    spawn: { state: "failed", admittedAt: now.getTime() - 60_000 } } as FileEntry;
  const task = { id: "task-launch", project: file.project, status: settlement === "done" ? "done" : "assigned", assignments: [
    { launchId: "launch-settled", at: new Date(now.getTime() - 60_000).toISOString() },
    ...(settlement === "relaunched" ? [{ launchId: "launch-new", at: new Date(now.getTime() - 30_000).toISOString() }] : []),
  ] } as unknown as BoardTask;
  const facts = { canonicalConversationId: (id: string) => id, retiredSeats: new Set<string>(), operatorWroteAt: new Map<string, number>(), pipeline: () => null, tasks: [task] };
  const clears = attentionSystemClears([file], now.getTime() / 1000, facts);
  expect(clears).toHaveLength(1);
  expect(systemClearAttention(clears, now)).toHaveLength(1);
  const record = readAttentionDismissals(undefined, now).records[0]!;
  expect(record.subject).toBe(file.path);
  expect(record.conversationId).toBeNull();
  expect(record.by).toEqual({ kind: "system", rule: settlement === "done" ? "launch-task-done" : "launch-relaunched" });
  const body = { files: [file], tasks: [task], pipelines: [] };
  const evidence = () => ({ tasks: [task], pipelines: [], dismissals: readAttentionDismissals(undefined, now).records, reports: null, admissions: [], unavailable: [] });
  overlayAttentionDismissals(body.files);
  const hidden = needsYouAnswer(body, null, now.getTime() / 1000, file.project, evidence());
  expect(hidden).toMatchObject({ count: 0, cleared: [{ kind: "launch", cleared: { by: record.by }, undo: { path: file.path } }] });
  expect(hidden.cleared).toHaveLength(1);
  expect(systemClearAttention(attentionSystemClears(body.files, now.getTime() / 1000, facts), now)).toEqual([]);
  await dismissAttention({ kind: "conversation", conversationId: file.conversationId, path: file.path, reasonId: `spawn:launch-settled:launch-failed` }, OPERATOR, { undo: true });
  expect(readAttentionDismissals(undefined, now).records[0]).toMatchObject({ subject: file.path, restoredAt: expect.any(String) });
  overlayAttentionDismissals(body.files);
  expect(needsYouAnswer(body, null, now.getTime() / 1000, file.project, evidence())).toMatchObject({ count: 1 });
  expect(systemClearAttention(attentionSystemClears(body.files, now.getTime() / 1000, facts), now)).toEqual([]);
});

test("rule 3: hide removes a review from both waiting lists, keeps history and undo restores it; task completion alone leaves it waiting", async () => {
  const task = { id: "task-prototype", project: "repo-fixture", status: "done", assignments: [], text: "Layout",
    prototypeReviews: [{ id: "review-hide", title: "Layout", createdAt: "2026-09-24T09:00:00Z", source: { conversationId: null }, variants: [] }] } as unknown as BoardTask;
  const h = harness({ tasks: [task] });
  const target = { kind: "prototype" as const, taskId: task.id, reviewId: "review-hide" };
  expect(prototypeReviewNotices(withPrototypeReviewSummaries([task]))).toHaveLength(1);
  await dismissAttention(target, OPERATOR, { ports: h.ports });
  expect(prototypeReviewNotices(withPrototypeReviewSummaries([task]))).toEqual([]);
  const read = readPrototypeReviews(task);
  expect(read.waitingReviewId).toBeNull();
  expect(read.rounds).toHaveLength(1);
  expect(read.rounds[0]!.hidden?.by).toEqual(OPERATOR);
  expect(read.rounds[0]!.decision).toBeUndefined();
  h.clock.now = new Date(h.clock.now.getTime() + DISMISSAL_RETENTION_MS + 1);
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports });
  expect(readPrototypeReviews(task).waitingReviewId).toBeNull();
  expect(readPrototypeReviews(task).rounds[0]!.hidden?.by).toEqual(OPERATOR);
  for (let batch = 0; batch < Math.ceil(DISMISSAL_CAPACITY / 200) + 1; batch++) {
    const subjects = Array.from({ length: 200 }, (_, index) => ({ kind: "conversation" as const, path: `/fixture/overflow-${batch}-${index}.jsonl` }));
    await dismissAttention(parseDismissalTarget({ kind: "subjects", subjects }, { allowSubjects: true }), OPERATOR, { ports: h.ports });
  }
  expect(readAttentionDismissals().records.filter(record => record.kind !== "prototype")).toHaveLength(DISMISSAL_CAPACITY);
  expect(prototypeReviewNotices(withPrototypeReviewSummaries([task]))).toEqual([]);
  expect(readPrototypeReviews(task).rounds[0]!.hidden?.by).toEqual(OPERATOR);
  const undone = await dismissAttention(target, SEAT, { ports: h.ports, undo: true });
  expect(undone.alreadyClear).toEqual([]);
  expect(readPrototypeReviews(task).waitingReviewId).toBe("review-hide");
  expect(prototypeReviewNotices(withPrototypeReviewSummaries([task]))).toHaveLength(1);
  await dismissAttention(target, OPERATOR, { ports: h.ports });
  task.prototypeReviews!.push({ ...task.prototypeReviews![0]!, id: "review-next", createdAt: h.clock.now.toISOString() });
  expect(readPrototypeReviews(task).waitingReviewId).toBe("review-next");
  expect(readPrototypeReviews(task).rounds.find(round => round.id === "review-hide")?.hidden?.by).toEqual(OPERATOR);
});

function lane(id: string, state: Pipeline["state"], over: Partial<Pipeline> = {}): Pipeline {
  return {
    id,
    state,
    taskIds: ["task-1"],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", startedAt: "2026-09-24T09:00:00.000Z", completedAt: "2026-09-24T09:30:00.000Z" }] }],
    ...over,
  } as unknown as Pipeline;
}

interface Harness {
  ports: DismissalPorts;
  clock: { now: Date };
  lanes: Map<string, Pipeline>;
  writes: Array<{ pipelineId: string; dismiss: boolean; by: DismissedBy }>;
  /** Reports resolved, by seq: the bridge log's record, as the port writes it. */
  resolved: Map<number, { at: string; by: DismissedBy }>;
}

function harness(options: { tasks?: BoardTask[]; lanes?: Pipeline[] } = {}): Harness {
  const clock = { now: new Date("2026-09-24T10:00:00.000Z") };
  const lanes = new Map((options.lanes ?? []).map((entry) => [entry.id, entry] as const));
  const writes: Harness["writes"] = [];
  const resolved: Harness["resolved"] = new Map();
  const known = new Map([
    ["conversation_a", "/t/a.jsonl"],
    ["conversation_b", "/t/b.jsonl"],
  ]);
  const ports: DismissalPorts = {
    now: () => clock.now,
    resolveConversation: (ref) => {
      if (ref.conversationId && known.has(ref.conversationId)) return { conversationId: ref.conversationId, path: known.get(ref.conversationId)! };
      const byPath = [...known].find(([, knownPath]) => knownPath === ref.path);
      if (byPath) return { conversationId: byPath[0], path: byPath[1] };
      return ref.path ? { conversationId: null, path: ref.path } : null;
    },
    task: (taskId) => deepFreeze(structuredClone((options.tasks ?? []).find((entry) => entry.id === taskId) ?? null)),
    pipelines: () => deepFreeze(structuredClone([...lanes.values()])),
    pipeline: (pipelineId) => deepFreeze(structuredClone(lanes.get(pipelineId) ?? null)),
    setPipelineDismissal: async (pipelineId, dismiss, by) => {
      writes.push({ pipelineId, dismiss, by });
      const current = lanes.get(pipelineId)!;
      const next = { ...current, dismissedAt: dismiss ? clock.now.toISOString() : null, dismissedBy: dismiss ? by : undefined } as Pipeline;
      lanes.set(pipelineId, next);
      return { pipeline: next };
    },
    resolveReports: (seqs, resolve, by, at) => {
      const outcome = { resolved: [] as number[], alreadyClear: [] as number[], unknown: [] as number[] };
      for (const seq of seqs) {
        if (!QUESTIONS.has(seq)) outcome.unknown.push(seq);
        else if (resolve === resolved.has(seq)) outcome.alreadyClear.push(seq);
        else {
          if (resolve) resolved.set(seq, { at, by });
          else resolved.delete(seq);
          outcome.resolved.push(seq);
        }
      }
      return outcome;
    },
  };
  return { ports, clock, lanes, writes, resolved };
}

/** The decision requests the harness's report log holds. */
const QUESTIONS = new Set([11, 12]);

test.each(["task", "conversation"] as const)("%s clear returns each covered report's reason, attribution and usable undo", async kind => {
  const task = { id: "task-1", project: "project-a", status: "assigned", assignments: [
    { conversationId: "conversation_a", path: "/t/a.jsonl", at: "2026-09-24T09:00:00.000Z" },
  ] } as BoardTask;
  const h = harness({ tasks: [task] });
  const reports: BridgeReportLogV1 = { schemaVersion: 1, lastSeq: 12, trimmedThroughSeq: 0, reports: [11, 12].map(seq => ({
    seq, id: `report-${seq}`, key: `question-${seq}`, class: "question", body: `Choose ${seq}`,
    project: "project-a", targetSeatConversationId: "conversation_a", at: "2026-09-24T09:30:00.000Z",
  })), retired: [], resolvedAsks: [] };
  const asks = openBridgeAsks(reports, { now: h.clock.now }).get("conversation_a")!;
  const files = [{ path: "/t/a.jsonl", name: "seat", title: "Seat", project: "project-a", conversationId: "conversation_a",
    root: "claude-projects", kind: "session", engine: "claude", fmt: "claude", parent: null, size: 1,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    mtime: h.clock.now.getTime() / 1000, bridgeAsks: asks, bridgeAsk: asks.at(-1),
  }] as FileEntry[];
  const read = () => {
    overlayAttentionDismissals(files);
    return needsYouAnswer({ files, tasks: [task], pipelines: [] }, null, h.clock.now.getTime() / 1000, "project-a", {
      tasks: [task], pipelines: [], dismissals: readAttentionDismissals().records, reports, admissions: [], unavailable: [],
    });
  };
  const before = read();
  expect(before.rows.map(row => row.subject.reportSeq)).toEqual([11, 12]);
  const target = kind === "task" ? { kind: "task" as const, taskId: task.id } : { kind: "conversation" as const, conversationId: "conversation_a" };
  const reason = "The operator already answered both questions";
  await dismissAttention(target, SEAT, { ports: h.ports, reason });
  const cleared = read();
  expect(cleared.count).toBe(0);
  expect(cleared.cleared).toEqual(before.rows.map(row => ({
    id: row.id, kind: row.kind, title: row.title, taskId: task.id,
    cleared: { at: h.clock.now.toISOString(), by: SEAT, note: reason },
    undo: { kind: "conversation", conversationId: "conversation_a" },
  })));
  await dismissAttention(cleared.cleared[0]!.undo, SEAT, { ports: h.ports, undo: true });
  const restored = read();
  expect(restored.rows.map(row => row.id)).toEqual(before.rows.map(row => row.id));
  expect(restored.cleared).toEqual([]);
});

test("a conversation's dismissal is recorded with who made it, and a new one replaces the old", async () => {
  const h = harness();
  const first = await dismissAttention({ kind: "conversation", conversationId: "conversation_a", reasonId: "toolu_1" }, OPERATOR, { ports: h.ports });
  expect(first).toMatchObject({ dismissed: [{ kind: "conversation", conversationId: "conversation_a" }], alreadyClear: [], at: "2026-09-24T10:00:00.000Z", by: OPERATOR, undo: false });
  expect(readAttentionDismissals().records).toEqual([
    { subject: "conversation_a", conversationId: "conversation_a", path: "/t/a.jsonl", at: "2026-09-24T10:00:00.000Z", by: OPERATOR, reason: null, reasonId: "toolu_1" },
  ]);

  h.clock.now = new Date("2026-09-24T10:05:00.000Z");
  await dismissAttention({ kind: "conversation", path: "/t/a.jsonl" }, SEAT, { ports: h.ports });
  const records = readAttentionDismissals().records;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ subject: "conversation_a", at: "2026-09-24T10:05:00.000Z", by: SEAT, reasonId: null });
});

test("undo deletes the record, and an undo of nothing is already clear rather than an error", async () => {
  const h = harness();
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports });
  const undone = await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports, undo: true });
  expect(undone).toMatchObject({ dismissed: [{ kind: "conversation", conversationId: "conversation_a" }], undo: true });
  expect(readAttentionDismissals().records).toEqual([]);
  const again = await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports, undo: true });
  expect(again).toMatchObject({ dismissed: [], alreadyClear: [{ kind: "conversation", conversationId: "conversation_a" }] });
});

test("a conversation the registry never adopted is recorded by its path", async () => {
  const h = harness();
  await dismissAttention({ kind: "conversation", path: "/t/terminal.jsonl" }, OPERATOR, { ports: h.ports });
  expect(readAttentionDismissals().records[0]).toMatchObject({ subject: "/t/terminal.jsonl", conversationId: null, path: "/t/terminal.jsonl" });
});

test("records past their retention and past capacity are dropped on the next write", async () => {
  const h = harness();
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports });
  h.clock.now = new Date(Date.parse("2026-09-24T10:00:00.000Z") + DISMISSAL_RETENTION_MS + 1);
  await dismissAttention({ kind: "conversation", conversationId: "conversation_b" }, OPERATOR, { ports: h.ports });
  expect(readAttentionDismissals().records.map((record) => record.subject)).toEqual(["conversation_b"]);

  const many = Array.from({ length: DISMISSAL_CAPACITY + 5 }, (_, index) => ({ kind: "conversation" as const, path: `/t/many-${index}.jsonl` }));
  await dismissAttention({ kind: "subjects", subjects: many }, OPERATOR, { ports: h.ports });
  const records = readAttentionDismissals().records;
  expect(records).toHaveLength(DISMISSAL_CAPACITY);
  expect(records.at(-1)!.subject).toBe(`/t/many-${DISMISSAL_CAPACITY + 4}.jsonl`);
});

test("a replay of the same operation answers what it wrote and writes nothing new", async () => {
  const h = harness();
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, SEAT, { ports: h.ports, operationKey: "op-1" });
  const revision = readAttentionDismissals().revision;
  h.clock.now = new Date("2026-09-24T10:09:00.000Z");
  const replay = await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, SEAT, { ports: h.ports, operationKey: "op-1" });
  expect(replay.dismissed).toEqual([{ kind: "conversation", conversationId: "conversation_a" }]);
  expect(readAttentionDismissals().revision).toBe(revision);
  expect(readAttentionDismissals().records[0]!.at).toBe("2026-09-24T10:00:00.000Z");
});

test("a lane is stamped through the engine; one that asks nothing, or is already cleared, is already clear", async () => {
  const h = harness({
    lanes: [
      lane("parked", "needs_decision"),
      lane("review", "needs_review"),
      lane("running", "running"),
      lane("closed", "closed"),
      lane("cleared", "needs_decision", { dismissedAt: "2026-09-24T09:45:00.000Z" }),
    ],
  });
  const outcome = await dismissAttention({ kind: "subjects", subjects: ["parked", "review", "running", "closed", "cleared"].map((pipelineId) => ({ kind: "pipeline" as const, pipelineId })) }, SEAT, { ports: h.ports });
  expect(outcome.dismissed).toEqual([{ kind: "pipeline", pipelineId: "parked" }, { kind: "pipeline", pipelineId: "review" }]);
  expect(outcome.alreadyClear.map((subject) => subject.kind === "pipeline" && subject.pipelineId)).toEqual(["running", "closed", "cleared"]);
  expect(h.writes).toEqual([
    { pipelineId: "parked", dismiss: true, by: SEAT },
    { pipelineId: "review", dismiss: true, by: SEAT },
  ]);
  /* The undo reaches only a lane something cleared. */
  const undo = await dismissAttention({ kind: "pipeline", pipelineId: "parked" }, OPERATOR, { ports: h.ports, undo: true });
  expect(undo.dismissed).toEqual([{ kind: "pipeline", pipelineId: "parked" }]);
  expect(h.lanes.get("parked")!.dismissedAt).toBeNull();
  const nothing = await dismissAttention({ kind: "pipeline", pipelineId: "running" }, OPERATOR, { ports: h.ports, undo: true });
  expect(nothing.alreadyClear).toEqual([{ kind: "pipeline", pipelineId: "running" }]);
});

test("a lane that moved after the card drew it is answered changed and keeps asking", async () => {
  const drawn = lane("parked", "needs_decision");
  const drawnAt = laneMovedAt(drawn);
  /* It ran another round and parked again between the poll and the click. */
  const reparked = lane("parked", "needs_decision", {
    runs: [{ stageId: "build", attempts: [
      { n: 1, state: "failed", startedAt: "2026-09-24T09:00:00.000Z", completedAt: "2026-09-24T09:30:00.000Z" },
      { n: 2, state: "failed", startedAt: "2026-09-24T09:50:00.000Z", completedAt: "2026-09-24T09:59:00.000Z" },
    ] }],
  } as Partial<Pipeline>);
  const h = harness({ lanes: [reparked, lane("still", "needs_review")] });
  const outcome = await dismissAttention({
    kind: "subjects",
    subjects: [
      { kind: "pipeline", pipelineId: "parked", laneMovedAt: drawnAt },
      { kind: "pipeline", pipelineId: "still", laneMovedAt: laneMovedAt(lane("still", "needs_review")) },
    ],
  }, OPERATOR, { ports: h.ports });
  expect(outcome.changed).toEqual([{ kind: "pipeline", pipelineId: "parked" }]);
  expect(outcome.dismissed).toEqual([{ kind: "pipeline", pipelineId: "still" }]);
  expect(h.writes.map((write) => write.pipelineId)).toEqual(["still"]);
  expect(h.lanes.get("parked")!.dismissedAt).toBeUndefined();

  /* The engine re-checks under its own lock: a lane that moves after the
     service read it is answered the same way. */
  const racing = harness({ lanes: [lane("parked", "needs_decision")] });
  const write = racing.ports.setPipelineDismissal;
  racing.ports.setPipelineDismissal = async (pipelineId, dismiss, by, drawnMovedAt) => {
    racing.lanes.set(pipelineId, reparked);
    return drawnMovedAt !== undefined && laneMovedAt(reparked) > (drawnMovedAt ?? Number.NEGATIVE_INFINITY)
      ? { pipeline: reparked, moved: true }
      : write(pipelineId, dismiss, by, drawnMovedAt);
  };
  const raced = await dismissAttention({ kind: "pipeline", pipelineId: "parked", laneMovedAt: drawnAt }, OPERATOR, { ports: racing.ports });
  expect(raced).toMatchObject({ dismissed: [], changed: [{ kind: "pipeline", pipelineId: "parked" }] });

  /* An agent names no drawn state: the lane is cleared as it stands. */
  const agent = await dismissAttention({ kind: "pipeline", pipelineId: "parked" }, SEAT, { ports: h.ports });
  expect(agent.dismissed).toEqual([{ kind: "pipeline", pipelineId: "parked" }]);
});

test("a task expands to the subjects its card drew, or to everything on it", async () => {
  const task = {
    id: "task-1",
    assignments: [
      { path: "/t/a.jsonl", conversationId: "conversation_a", state: "delivered" },
      { path: "/t/b.jsonl", conversationId: "conversation_b", state: "delivered" },
      { path: null, conversationId: null, state: "spawning" },
    ],
  } as unknown as BoardTask;
  const h = harness({ tasks: [task], lanes: [lane("parked", "needs_decision"), lane("elsewhere", "needs_decision", { taskIds: ["task-2"] })] });

  const drawn = await dismissAttention({ kind: "task", taskId: "task-1", subjects: [{ kind: "conversation", conversationId: "conversation_b", reasonId: "toolu_b" }] }, OPERATOR, { ports: h.ports });
  expect(drawn.dismissed).toEqual([{ kind: "conversation", conversationId: "conversation_b" }]);
  expect(readAttentionDismissals().records.map((record) => record.subject)).toEqual(["conversation_b"]);

  const whole = await dismissAttention({ kind: "task", taskId: "task-1" }, SEAT, { ports: h.ports });
  expect(whole.dismissed).toEqual([
    { kind: "conversation", conversationId: "conversation_a" },
    { kind: "conversation", conversationId: "conversation_b" },
    { kind: "pipeline", pipelineId: "parked" },
  ]);
  expect(h.writes.map((write) => write.pipelineId)).toEqual(["parked"]);
  await expect(dismissAttention({ kind: "task", taskId: "task-missing" }, OPERATOR, { ports: h.ports })).rejects.toBeInstanceOf(DismissalError);
});

test("a target that names nothing is refused; a malformed one never reaches the service", async () => {
  const h = harness();
  await expect(dismissAttention({ kind: "pipeline", pipelineId: "gone" }, OPERATOR, { ports: h.ports })).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  await expect(dismissAttention({ kind: "subjects", subjects: [] }, OPERATOR, { ports: h.ports })).rejects.toMatchObject({ code: "NOTHING_TO_DISMISS" });
  expect(() => parseDismissalTarget({ kind: "conversation" }, { allowSubjects: false })).toThrow(DismissalError);
  expect(() => parseDismissalTarget({ kind: "subjects", subjects: [] }, { allowSubjects: false })).toThrow(DismissalError);
  expect(parseDismissalTarget({ kind: "task", taskId: "t", subjects: [{ kind: "pipeline", pipelineId: "p" }] }, { allowSubjects: false })).toEqual({ kind: "task", taskId: "t" });
  expect(parseDismissalTarget({ kind: "subjects", subjects: [{ kind: "conversation", path: "/t/a.jsonl", reasonId: "r", reason: "question" }] }, { allowSubjects: true }))
    .toEqual({ kind: "subjects", subjects: [{ kind: "conversation", path: "/t/a.jsonl", reasonId: "r", reason: "question" }] });
});

test("the files projection stamps each record on its conversation's entries, and an undo takes the mark off", async () => {
  const h = harness();
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a", reasonId: "toolu_1" }, OPERATOR, { ports: h.ports });
  await dismissAttention({ kind: "conversation", path: "/t/terminal.jsonl" }, SEAT, { ports: h.ports });
  const entry = (over: Partial<FileEntry>) => ({ path: "/t/x.jsonl", ...over }) as FileEntry;
  const files = [
    entry({ path: "/t/a-generation-2.jsonl", conversationId: "conversation_a" }),
    entry({ path: "/t/terminal.jsonl" }),
    entry({ path: "/t/a-retired.jsonl", conversationId: "conversation_a", migratedTo: "/t/a-generation-2.jsonl" }),
    entry({ path: "/t/other.jsonl", conversationId: "conversation_other", attentionDismissal: { at: "2026-09-24T09:00:00.000Z", by: OPERATOR } }),
  ];
  overlayAttentionDismissals(files);
  expect(files[0]!.attentionDismissal).toEqual({ at: "2026-09-24T10:00:00.000Z", by: OPERATOR, reasonId: "toolu_1" });
  expect(files[1]!.attentionDismissal).toEqual({ at: "2026-09-24T10:00:00.000Z", by: SEAT, reasonId: null });
  expect(files[2]!.attentionDismissal).toBeUndefined();
  expect(files[3]!.attentionDismissal).toBeUndefined();

  /* A store that cannot be read costs the mark, never the poll. */
  const unread = [entry({ path: "/t/q.jsonl" })];
  overlayAttentionDismissals(unread, () => { throw new Error("busy"); });
  expect(unread[0]!.attentionDismissal).toBeUndefined();
});

test("an orchestrator's question is resolved in the report log, together with the other rows of one «Dismiss all», and Undo takes it back", async () => {
  const h = harness({ lanes: [lane("lane-1", "needs_decision")] });
  const outcome = await dismissAttention({
    kind: "subjects",
    subjects: [
      { kind: "report", seq: 11 },
      { kind: "report", seq: 12 },
      { kind: "conversation", conversationId: "conversation_a", reasonId: "toolu_1" },
      { kind: "pipeline", pipelineId: "lane-1" },
    ],
  }, OPERATOR, { ports: h.ports });
  expect(outcome.dismissed).toEqual([
    { kind: "conversation", conversationId: "conversation_a" },
    { kind: "pipeline", pipelineId: "lane-1" },
    { kind: "report", seq: 11 },
    { kind: "report", seq: 12 },
  ]);
  expect([...h.resolved.keys()]).toEqual([11, 12]);
  expect(h.resolved.get(11)).toEqual({ at: "2026-09-24T10:00:00.000Z", by: OPERATOR });

  const again = await dismissAttention({ kind: "subjects", subjects: [{ kind: "report", seq: 11 }] }, OPERATOR, { ports: h.ports });
  expect(again).toMatchObject({ dismissed: [], alreadyClear: [{ kind: "report", seq: 11 }] });

  const undone = await dismissAttention({ kind: "subjects", subjects: [{ kind: "report", seq: 11 }] }, OPERATOR, { ports: h.ports, undo: true });
  expect(undone).toMatchObject({ dismissed: [{ kind: "report", seq: 11 }], undo: true });
  expect([...h.resolved.keys()]).toEqual([12]);
});

test("a report subject is parsed from the operator's route; a seq that is not a positive integer is refused", () => {
  expect(parseDismissalTarget({ kind: "subjects", subjects: [{ kind: "report", seq: 7 }] }, { allowSubjects: true })).toEqual({ kind: "subjects", subjects: [{ kind: "report", seq: 7 }] });
  expect(() => parseDismissalTarget({ kind: "subjects", subjects: [{ kind: "report", seq: 0 }] }, { allowSubjects: true })).toThrow();
  expect(() => parseDismissalTarget({ kind: "subjects", subjects: [{ kind: "report" }] }, { allowSubjects: true })).toThrow();
});


test("a task dismissal covers its waiting prototype, keeps its reason, and undo restores it", async () => {
  const task = { id: "task-prototype", project: "project-a", assignments: [], prototypeReview: {
    latestReviewId: "review-a", waitingReviewId: "review-a", title: "Layout", rounds: 1, createdAt: "2026-09-24T09:00:00Z",
  } } as unknown as BoardTask;
  const h = harness({ tasks: [task] });
  const first = await dismissAttention({ kind: "task", taskId: task.id }, SEAT, { ports: h.ports, reason: "The publishing lane has moved on" });
  expect(first.dismissed).toEqual([{ kind: "prototype", taskId: task.id, reviewId: "review-a" }]);
  expect(readAttentionDismissals().records[0]).toMatchObject({ kind: "prototype", subject: "prototype:review-a", taskId: task.id, by: SEAT, note: "The publishing lane has moved on" });
  await dismissAttention({ kind: "prototype", taskId: task.id, reviewId: "review-a" }, SEAT, { ports: h.ports, undo: true });
  expect(readAttentionDismissals().records).toEqual([]);
  const old = await dismissAttention({ kind: "prototype", taskId: task.id, reviewId: "review-old" }, SEAT, { ports: h.ports });
  expect(old.alreadyClear).toEqual([{ kind: "prototype", taskId: task.id, reviewId: "review-old" }]);
});

/* docs/design/attention-auto-resolve.md, acceptance 2: Delegatus clears what
   its own evidence proves settled, through the same record a card writes. */
test("a system clear is recorded with its rule, is a no-op when repeated, and Undo keeps it restored against the same rule", async () => {
  const h = harness();
  const clear: SystemAttentionClear = { conversationId: "conversation_a", path: "/t/a.jsonl", reasonId: "ask-1", reason: "ask", raisedAt: Date.parse("2026-09-24T09:00:00.000Z") / 1000, rule: "operator-replied", title: "Roll out the release", project: "viewer" };
  const snapshot = { reason: "ask" as const, raisedAt: clear.raisedAt, title: "Roll out the release", project: "viewer" };
  const at = new Date("2026-09-24T10:00:00.000Z");
  expect(systemClearAttention([clear], at)).toEqual([clear]);
  expect(readAttentionDismissals().records).toEqual([
    { subject: "conversation_a", conversationId: "conversation_a", path: "/t/a.jsonl", at: at.toISOString(), by: { kind: "system", rule: "operator-replied" }, reason: "ask", reasonId: "ask-1", cleared: snapshot },
  ]);
  /* The next pass sees the record already covering it. */
  expect(systemClearAttention([clear], new Date("2026-09-24T10:01:00.000Z"))).toEqual([]);
  const files = [{ path: "/t/a.jsonl", conversationId: "conversation_a" } as FileEntry];
  overlayAttentionDismissals(files);
  expect(files[0]!.attentionDismissal).toEqual({ at: at.toISOString(), by: { kind: "system", rule: "operator-replied" }, reasonId: "ask-1", cleared: snapshot });

  /* The operator brings it back: the record stays, covers nothing, and the
     same rule on the same reason cannot clear it again. */
  h.clock.now = new Date("2026-09-24T10:02:00.000Z");
  await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports, undo: true });
  expect(readAttentionDismissals().records[0]).toMatchObject({ by: { kind: "system", rule: "operator-replied" }, reasonId: "ask-1", restoredAt: "2026-09-24T10:02:00.000Z", restoredBy: OPERATOR });
  overlayAttentionDismissals(files);
  expect(files[0]!.attentionDismissal).toMatchObject({ restoredAt: "2026-09-24T10:02:00.000Z" });
  expect(systemClearAttention([clear], new Date("2026-09-24T10:03:00.000Z"))).toEqual([]);
  /* A second Undo has nothing left to bring back. */
  const again = await dismissAttention({ kind: "conversation", conversationId: "conversation_a" }, OPERATOR, { ports: h.ports, undo: true });
  expect(again.alreadyClear).toEqual([{ kind: "conversation", conversationId: "conversation_a" }]);

  /* A newer ask, raised after the restore, can be cleared on new evidence. */
  const newer = { ...clear, reasonId: "ask-2", raisedAt: Date.parse("2026-09-24T10:04:00.000Z") / 1000 };
  expect(systemClearAttention([newer], new Date("2026-09-24T10:05:00.000Z"))).toEqual([newer]);
  expect(readAttentionDismissals().records[0]).toMatchObject({ reasonId: "ask-2", by: { kind: "system", rule: "operator-replied" } });
  expect(readAttentionDismissals().records[0]!.restoredAt).toBeUndefined();
});

test("a retired seat's clear covers every reason it raised up to then, and leaves an operator's covering record alone", () => {
  const raisedAt = Date.parse("2026-09-24T09:00:00.000Z") / 1000;
  const retired: SystemAttentionClear = { conversationId: "conversation_seat", path: "/t/seat.jsonl", reasonId: null, reason: "decision", raisedAt, rule: "retired-seat", title: "Pick a release day", project: "viewer" };
  expect(systemClearAttention([retired], new Date("2026-09-24T10:00:00.000Z"))).toHaveLength(1);
  expect(readAttentionDismissals().records[0]).toMatchObject({ reasonId: null, by: { kind: "system", rule: "retired-seat" } });
  /* An earlier reason of the same conversation is already covered. */
  expect(systemClearAttention([{ ...retired, raisedAt: raisedAt - 60 }], new Date("2026-09-24T10:01:00.000Z"))).toEqual([]);
});

test("an escalation is stored by the wait it names, replays by operation, and undo withdraws it", () => {
  const by: DismissedBy = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
  const escalation = { key: "reason:ask-1", seat: "conversation_seat", taskId: "task-1", reviewId: "round-1" };
  const first = writeAttentionEscalation(escalation, by, { operationKey: "op-1", now: new Date("2026-09-24T10:00:00.000Z") });
  expect(first).toEqual({ changed: true, escalation: { ...escalation, at: "2026-09-24T10:00:00.000Z" } });
  expect(writeAttentionEscalation(escalation, by, { operationKey: "op-1", now: new Date("2026-09-24T10:05:00.000Z") }).changed).toBe(false);
  expect([...attentionEscalationIndex().values()]).toEqual([{ ...escalation, at: "2026-09-24T10:00:00.000Z" }]);
  /* An escalation names a wait, never a conversation's dismissal. */
  const files = [{ path: "escalation:reason:ask-1" } as FileEntry];
  overlayAttentionDismissals(files);
  expect(files[0]!.attentionDismissal).toBeUndefined();
  expect(writeAttentionEscalation(escalation, by, { undo: true })).toEqual({ changed: true, escalation: null });
  expect(attentionEscalationIndex().size).toBe(0);
});


test("an archived finished ask is durably cleared and stays restored after Undo and reconciliation", async () => {
  const now = new Date("2026-10-19T06:00:00.000Z");
  const askedAt = "2026-10-12T06:00:00.000Z";
  const membership = { kind: "pipeline" as const, containerId: "archived-lane", stageId: "build", stageOrder: 0, role: "builder", slot: "build", round: null, parentConversationId: null };
  const stale = { path: "/t/archived-ask.jsonl", conversationId: "conversation_archived_ask", project: "repo-fixture", title: "Archived ask",
    proc: "killed", activity: "recent", mtime: Date.parse(askedAt) / 1000, pendingPermission: { id: "permission-old", since: askedAt, tool: "Bash", command: "make" },
    durableLineage: { kind: "spawn", role: "builder", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [membership] } } as unknown as FileEntry;
  const lane = { id: "archived-lane", state: "closed", closedAt: "2026-10-13T06:00:00.000Z", taskIds: ["task-archived"], runs: [], stages: [] } as unknown as Pipeline;
  const task = { id: "task-archived", project: "repo-fixture", status: "assigned", assignments: [{ path: stale.path, conversationId: stale.conversationId, at: askedAt, state: "linked" }] } as unknown as BoardTask;
  const reconcileFacts = { canonicalConversationId: (id: string) => id, retiredSeats: new Set<string>(), operatorWroteAt: new Map<string, number>(),
    pipeline: (id: string) => id === lane.id ? lane : null, tasks: [task], pipelines: [lane] };
  const dismissalHarness = harness();
  dismissalHarness.clock.now = now;
  const dismissalPorts = { ...dismissalHarness.ports, resolveConversation: () => ({ conversationId: stale.conversationId!, path: stale.path }) };
  const ports: AttentionReconcilePorts = {
    now: () => now,
    board: async () => { const files = [{ ...stale }]; overlayAttentionDismissals(files); return { files, pipelines: [], tasks: [task] }; },
    facts: () => reconcileFacts, write: systemClearAttention, announce: async () => {},
  };

  const cleared = await reconcileAttentionOnce(ports);
  expect(cleared.map(clear => clear.rule)).toEqual(["container-finished"]);
  expect(readAttentionDismissals(undefined, now).records).toHaveLength(1);
  await reconcileAttentionOnce(ports);
  expect(readAttentionDismissals(undefined, now).records).toHaveLength(1);

  const undone = await dismissAttention({ kind: "conversation", conversationId: stale.conversationId, path: stale.path }, OPERATOR, { undo: true, ports: dismissalPorts });
  expect(undone.alreadyClear).toEqual([]);
  expect(readAttentionDismissals(undefined, now).records[0]?.restoredAt).toEqual(now.toISOString());
  expect(await reconcileAttentionOnce(ports)).toEqual([]);
  const visible = [{ ...stale }]; overlayAttentionDismissals(visible);
  const { attentionReason } = await import("@/components/attention");
  expect(attentionReason(visible[0]!, now.getTime() / 1000)?.kind).toBe("permission");
});
