import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  activateDeputy,
  beginDeputy,
  DEPUTY_CONVERSATION_CLOSED,
  DEPUTY_HISTORY_CAP,
  deputyConversationRefs,
  deputyDeliveryRefusal,
  deputyMessageKey,
  endDeputy,
  readDeputies,
  readDeputyFileOrNull,
  recordDeputyFork,
  spawnParentForCaller,
} from "./deputies";

/*
 * The deputy record as the rest of the Viewer reads it (docs/design/ghost-seat.md
 * §4, §5): a ghost stays hidden, closed to messages and parented to its seat
 * after its full record is trimmed, and only the ghost route's own first
 * message ever reaches it.
 */

const PROJECT = "proj-ghost";
const SEAT_ID = "conversation_seat";
let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deputies-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function forked(index: number, now = new Date(Date.UTC(2026, 8, 26, 0, index))) {
  const begun = beginDeputy({
    project: PROJECT,
    seatConversationId: SEAT_ID,
    seatEpoch: 1,
    seatPath: "/fixture/seat.jsonl",
    clientRequestId: `ask-${index}`,
    ask: { text: `ask ${index}`, images: 0, sender: null },
    now,
    askId: `deputy_${index}`,
  });
  if (begun.kind !== "begun") throw new Error(`deputy ${index} did not begin`);
  recordDeputyFork(begun.deputy.askId, {
    deputyConversationId: `conversation_ghost_${index}`,
    artifactPath: `/fixture/ghost-${index}.jsonl`,
    forkRecordCount: 3,
  });
  return begun.deputy.askId;
}

test("a trimmed ghost stays hidden, closed and parented to its seat", () => {
  for (let index = 0; index <= DEPUTY_HISTORY_CAP; index += 1) {
    const askId = forked(index);
    endDeputy(askId, { outcome: "done", now: new Date(Date.UTC(2026, 8, 26, 0, index, 30)) });
  }
  /* The first full record is gone… */
  expect(readDeputies().some((deputy) => deputy.askId === "deputy_0")).toBe(false);
  expect(readDeputies()).toHaveLength(DEPUTY_HISTORY_CAP);
  expect(readDeputyFileOrNull()?.retired).toEqual([
    { deputyConversationId: "conversation_ghost_0", artifactPath: "/fixture/ghost-0.jsonl", seatConversationId: SEAT_ID },
  ]);
  /* …and every reader still knows its conversation was a ghost's. */
  const refs = deputyConversationRefs();
  expect(refs?.conversationIds).toContain("conversation_ghost_0");
  expect(refs?.paths).toContain("/fixture/ghost-0.jsonl");
  expect(deputyDeliveryRefusal({ conversationId: "conversation_ghost_0" })).toMatchObject({ code: DEPUTY_CONVERSATION_CLOSED, status: 409, seatConversationId: SEAT_ID });
  expect(deputyDeliveryRefusal({ path: "/fixture/ghost-0.jsonl" })?.code).toBe(DEPUTY_CONVERSATION_CLOSED);
  expect(spawnParentForCaller("conversation_ghost_0")).toBe(SEAT_ID);
});

test("only the route's own first message reaches a pending ghost; nothing reaches a live or ended one", () => {
  const askId = forked(1);
  const target = { conversationId: "conversation_ghost_1", path: "/fixture/ghost-1.jsonl" };
  expect(deputyDeliveryRefusal({ ...target, clientMessageId: deputyMessageKey(askId) })).toBeNull();
  expect(deputyDeliveryRefusal({ ...target, clientMessageId: "mcp_send_worker_report" })?.code).toBe(DEPUTY_CONVERSATION_CLOSED);
  expect(deputyDeliveryRefusal({ path: target.path })?.code).toBe(DEPUTY_CONVERSATION_CLOSED);

  activateDeputy(askId);
  expect(deputyDeliveryRefusal({ ...target, clientMessageId: deputyMessageKey(askId) })?.code).toBe(DEPUTY_CONVERSATION_CLOSED);
  expect(deputyDeliveryRefusal({ ...target, clientMessageId: "any" })?.error).toContain(SEAT_ID);

  endDeputy(askId, { outcome: "done" });
  expect(deputyDeliveryRefusal({ ...target, clientMessageId: deputyMessageKey(askId) })?.code).toBe(DEPUTY_CONVERSATION_CLOSED);
});

test("any other conversation is untouched by the fence and is its own spawn parent", () => {
  forked(2);
  expect(deputyDeliveryRefusal({ conversationId: SEAT_ID, clientMessageId: "x" })).toBeNull();
  expect(deputyDeliveryRefusal({ conversationId: "conversation_worker", path: "/fixture/worker.jsonl" })).toBeNull();
  expect(deputyDeliveryRefusal({})).toBeNull();
  expect(spawnParentForCaller("conversation_worker")).toBe("conversation_worker");
  expect(spawnParentForCaller("conversation_ghost_2")).toBe(SEAT_ID);
});
