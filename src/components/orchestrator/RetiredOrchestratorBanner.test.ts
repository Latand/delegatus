import { expect, test } from "bun:test";

import { retiredOrchestratorFor } from "./RetiredOrchestratorBanner";
import type { OrchestratorSeatStatus } from "./seatState";

const file = { conversationId: "conversation_previous", path: "/fixtures/previous.jsonl", project: "viewer" };
const status = {
  seat: { conversationId: "conversation_current", path: "/fixtures/current.jsonl", project: "viewer" },
  exists: true,
  previous: [{ conversationId: file.conversationId, path: file.path }],
} as OrchestratorSeatStatus;

const linked = (successorConversationId: string) => ({ successorConversationId, pending: false });
const unlinked = { successorConversationId: null, pending: false };

test("a former seat names the current conversation without changing identity", () => {
  expect(retiredOrchestratorFor(file, status)).toEqual(linked("conversation_current"));
  expect(retiredOrchestratorFor({ path: file.path, project: file.project }, status)).toEqual(linked("conversation_current"));
});

test("an unanswered detail read is pending, and a failed one is settled without a link", () => {
  expect(retiredOrchestratorFor(file, null)).toEqual({ successorConversationId: null, pending: true });
  expect(retiredOrchestratorFor(file, null, true)).toEqual(unlinked);
  expect(retiredOrchestratorFor(file, status, true)).toEqual(unlinked);
});

test("whole-history retirement survives a missing detail record or recent-page omission", () => {
  expect(retiredOrchestratorFor(file, { ...status, seat: null, previous: [] })).toEqual(unlinked);
  expect(retiredOrchestratorFor(file, { ...status, previous: [] })).toEqual(linked("conversation_current"));
  expect(retiredOrchestratorFor(file, { ...status, seat: { ...status.seat!, project: "elsewhere" } })).toEqual(unlinked);
  expect(retiredOrchestratorFor(file, { ...status, seat: { ...status.seat!, conversationId: file.conversationId } })).toEqual(unlinked);
});

test("a missing current transcript keeps retirement without inventing navigation", () => {
  expect(retiredOrchestratorFor(file, { ...status, exists: false })).toEqual(unlinked);
  expect(retiredOrchestratorFor(file, { ...status, seat: null })).toEqual(unlinked);
});
