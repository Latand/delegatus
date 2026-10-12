import { expect, test } from "bun:test";
import { encodeTask, decodeWireRow, TASK_WIRE_VERSION } from "./taskWire";
import { prototypeReviewReplica } from "@/lib/prototypeReview/model";
import { isPrototypeReplica } from "@/lib/prototypeReview/replica";
import { questions } from "@/lib/prototypeReview/questionnaire.fixture";
import type { BoardTask } from "@/lib/tasks/types";
const self = { id: ["00000000", "0000", "0000", "0000", "000000000002"].join("-"), prefix: "aaaaaaaa" };
const task: BoardTask = { id: ["00000000", "0000", "0000", "0000", "000000000001"].join("-"), project: `repo-${"a".repeat(32)}`, text: "Before work", status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" };
test("v6 questionnaire replicas round trip; v5 peers still receive the task without the replica", () => {
  const round = { id: `pr_${"a".repeat(32)}`, taskId: task.id, project: task.project, title: "Before work", createdAt: task.createdAt, source: { conversationId: null }, publicationKey: "question", inputDigest: "digest", variants: [], questions };
  const withQuestions = { ...task, prototypeReviews: [round] };
  expect(TASK_WIRE_VERSION).toBe(6);
  const replica = prototypeReviewReplica(withQuestions)!;
  expect(isPrototypeReplica(replica, task.id, task.project)).toBe(true);
  expect(decodeWireRow(encodeTask(withQuestions, self, { peerTaskWireVersion: 6 }).row)).toHaveProperty("prototypeReviewReplica");
  expect(encodeTask(withQuestions, self, { peerTaskWireVersion: 5 }).row).not.toHaveProperty("prototypeReviewReplica");
  const decided = { ...round, decision: { chosen: [], answers: questions.map(q => ({ questionId: q.id, options: [0] })), skipped: true as const, comment: "", at: task.createdAt, delivery: { state: "sent" as const, clientMessageId: "answer", conversationId: null, text: "answer" } } };
  const answered = prototypeReviewReplica({ ...task, prototypeReviews: [decided] })!;
  expect(isPrototypeReplica(answered, task.id, task.project)).toBe(true);
  const malformed = structuredClone(answered); malformed.rounds[0]!.decision!.answers![0]!.options = [99];
  expect(isPrototypeReplica(malformed, task.id, task.project)).toBe(false);
  const variantsOnly = { ...round, questions: undefined, variants: [{ number: 1, name: "Compact", description: "Compact", frames: [], videos: [] }] };
  expect(encodeTask({ ...task, prototypeReviews: [variantsOnly] }, self, { peerTaskWireVersion: 5 }).row).toHaveProperty("prototypeReviewReplica");
});


test("rejected variants survive the strict replica wire and local critic evidence is omitted", () => {
  const round = { id: `pr_${"b".repeat(32)}`, taskId: task.id, project: task.project, title: "Redo", createdAt: task.createdAt, source: { conversationId: null }, publicationKey: "redo", inputDigest: "digest",
    critic: { pipelineId: "lane", stageId: "critic", attempt: 1, outcome: "passed" as const },
    variants: [{ number: 1, name: "Compact", description: "Compact", frames: [], videos: [] }],
    decision: { chosen: [], rejected: true as const, comment: "Simplify the layout.", at: task.createdAt, delivery: { state: "sent" as const, clientMessageId: "redo", conversationId: null, text: "Corrections" } } };
  const rejected = { ...task, prototypeReviews: [round] };
  const replica = prototypeReviewReplica(rejected)!;
  expect(replica.summary.decision?.rejected).toBe(true); expect(replica.rounds[0]).not.toHaveProperty("critic");
  expect(isPrototypeReplica(replica, task.id, task.project)).toBe(true);
  const wire = decodeWireRow(encodeTask(rejected, self).row);
  expect(wire && "prototypeReviewReplica" in wire && wire.prototypeReviewReplica?.rounds[0]?.decision?.rejected).toBe(true);
  for (const change of ["no-corrections", "chosen", "no-variants"] as const) {
    const invalid = structuredClone(replica);
    if (change === "no-corrections") invalid.rounds[0]!.decision!.comment = "  ";
    if (change === "chosen") invalid.rounds[0]!.decision!.chosen = [1];
    if (change === "no-variants") invalid.rounds[0]!.variants = [];
    expect(isPrototypeReplica(invalid, task.id, task.project)).toBe(false);
  }
});
