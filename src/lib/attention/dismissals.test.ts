import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import {
  DISMISSAL_CAPACITY,
  DISMISSAL_RETENTION_MS,
  DismissalError,
  dismissAttention,
  overlayAttentionDismissals,
  parseDismissalTarget,
  readAttentionDismissals,
  type DismissalPorts,
} from "./dismissals";
import type { DismissedBy } from "./dismissalTypes";

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
  resetLegacyDocumentStoresForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const OPERATOR: DismissedBy = { kind: "operator", surface: "desktop" };
const SEAT: DismissedBy = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };

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
}

function harness(options: { tasks?: BoardTask[]; lanes?: Pipeline[] } = {}): Harness {
  const clock = { now: new Date("2026-09-24T10:00:00.000Z") };
  const lanes = new Map((options.lanes ?? []).map((entry) => [entry.id, entry] as const));
  const writes: Harness["writes"] = [];
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
    task: (taskId) => (options.tasks ?? []).find((entry) => entry.id === taskId) ?? null,
    pipelines: () => [...lanes.values()],
    pipeline: (pipelineId) => lanes.get(pipelineId) ?? null,
    setPipelineDismissal: async (pipelineId, dismiss, by) => {
      writes.push({ pipelineId, dismiss, by });
      const current = lanes.get(pipelineId)!;
      const next = { ...current, dismissedAt: dismiss ? clock.now.toISOString() : null, dismissedBy: dismiss ? by : undefined } as Pipeline;
      lanes.set(pipelineId, next);
      return { pipeline: next };
    },
  };
  return { ports, clock, lanes, writes };
}

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
