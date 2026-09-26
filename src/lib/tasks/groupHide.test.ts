import { expect, test } from "bun:test";

import { isSeatConversation, seatOnlyTask, type SeatRefs } from "./groupHide";
import type { TaskAssignment } from "./types";

/* docs/design/ghost-seat.md §5 "Hidden from lists": a seat's deputy is part of
   the seat, so the seat's task stays seat-only with it and its conversation is
   left out wherever the seat's is. */

const SEAT: SeatRefs = {
  conversationIds: ["conversation_seat"],
  paths: ["/t/seat.jsonl"],
  previous: { conversationIds: [], paths: [] },
  deputies: { conversationIds: ["conversation_ghost"], paths: ["/t/ghost.jsonl"] },
};

function assignment(conversationId: string, path: string): TaskAssignment {
  return { conversationId, path, state: "linked", at: "2026-09-26T12:00:00.000Z" } as TaskAssignment;
}

test("a deputy counts as the seat's own conversation, by id or by path", () => {
  expect(isSeatConversation(SEAT, { conversationId: "conversation_ghost" })).toBe(true);
  expect(isSeatConversation(SEAT, { path: "/t/ghost.jsonl" })).toBe(true);
  expect(isSeatConversation(SEAT, { conversationId: "conversation_worker", path: "/t/worker.jsonl" })).toBe(false);
  /* An unreadable seat record still hides nothing. */
  expect(isSeatConversation({ ...SEAT, previous: undefined }, { conversationId: "conversation_ghost" })).toBe(false);
});

test("a task whose live assignments are the seat and its deputy is still seat-only", () => {
  const task = { id: "task_seat", assignments: [assignment("conversation_seat", "/t/seat.jsonl"), assignment("conversation_ghost", "/t/ghost.jsonl")] };
  expect(seatOnlyTask(task, SEAT)).toBe(true);
  /* Without the deputy set the deputy reads as real work and the card returns. */
  expect(seatOnlyTask(task, { ...SEAT, deputies: undefined })).toBe(false);
  /* A worker beside them is real work. */
  expect(seatOnlyTask({ ...task, assignments: [...task.assignments, assignment("conversation_worker", "/t/worker.jsonl")] }, SEAT)).toBe(false);
});
