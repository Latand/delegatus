import { expect, test } from "bun:test";

import { retiredOrchestratorFor } from "./RetiredOrchestratorBanner";
import type { OrchestratorSeatStatus } from "./seatState";

const file = { conversationId: "conversation_previous", path: "/fixtures/previous.jsonl" };
const status = {
  seat: { conversationId: "conversation_current", path: "/fixtures/current.jsonl" },
  exists: true,
  previous: [{ conversationId: file.conversationId, path: file.path }],
} as OrchestratorSeatStatus;

test("a recorded former seat names the current conversation without changing identity", () => {
  expect(retiredOrchestratorFor(file, status)).toEqual({ successorConversationId: "conversation_current" });
  expect(retiredOrchestratorFor({ path: file.path }, status)).toEqual({ successorConversationId: "conversation_current" });
});

test("the current designation wins over an entry retained in seat history", () => {
  expect(retiredOrchestratorFor(file, { ...status, seat: { ...status.seat!, conversationId: file.conversationId } })).toBeNull();
});

test("another project's history and unknown seat evidence cannot retire a conversation", () => {
  expect(retiredOrchestratorFor({ conversationId: "conversation_worker", path: "/fixtures/worker.jsonl" }, status)).toBeNull();
  expect(retiredOrchestratorFor(file, null)).toBeNull();
});

test("failed refresh and a missing current transcript keep retirement without inventing navigation", () => {
  expect(retiredOrchestratorFor(file, status, true)).toEqual({ successorConversationId: null });
  expect(retiredOrchestratorFor(file, { ...status, exists: false })).toEqual({ successorConversationId: null });
  expect(retiredOrchestratorFor(file, { ...status, seat: null })).toEqual({ successorConversationId: null });
});
