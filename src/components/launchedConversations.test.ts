import { expect, test } from "bun:test";

import { isLaunchedConversation, markLaunchedConversation } from "./launchedConversations";

test("a launch is remembered by the conversation's identity, across the provisional and the scanned path", () => {
  const provisional = { conversationId: "conversation_launch-a", path: "spawn:launch-a" };
  const scanned = { conversationId: "conversation_launch-a", path: "/repo/launch-a.jsonl" };
  expect(isLaunchedConversation(scanned)).toBe(false);
  markLaunchedConversation(provisional);
  expect(isLaunchedConversation(scanned)).toBe(true);
  expect(isLaunchedConversation({ conversationId: "conversation_other", path: "/repo/other.jsonl" })).toBe(false);
});

test("only the newest launches are kept", () => {
  for (let index = 0; index < 80; index += 1) markLaunchedConversation({ conversationId: `conversation_bulk-${index}`, path: `/repo/bulk-${index}.jsonl` });
  expect(isLaunchedConversation({ conversationId: "conversation_bulk-0", path: "" })).toBe(false);
  expect(isLaunchedConversation({ conversationId: "conversation_bulk-79", path: "" })).toBe(true);
});
