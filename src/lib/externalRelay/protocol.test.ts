import { expect, test } from "bun:test";
import { checkedAnswer, requestSchema } from "./protocol";
export const sampleRequest = {
  request_id: "rq_1",
  lease_id: "ls_Zq3vN8bY1xKp4LmT0aW9rE",
  kind: "answer",
  target_id: "target_1",
  claimed_at: "2026-09-28T12:00:01Z",
  liveness: {
    poll_freshness_s: 60,
    claim_window_s: 5,
    ack_window_s: 10,
    heartbeat_interval_s: 10,
    stall_window_s: 45,
  },
  input: {
    instructions: "Answer briefly",
    owner_instructions: null,
    documents: [],
    conversation: [
      {
        id: "m1",
        author: { key: "u1", name: "User", self: false },
        sent_at: "2026-09-28T12:00:00Z",
        text: "Hello",
        reply_to: null,
      },
    ],
    respond_to: "m1",
    request_text: null,
  },
  answer: { max_chars: 20, progress: "notes" },
} as const;
/** The same request with requester_context (§A.8): who asked, memory and the tool index. */
export const contextRequest = {
  ...sampleRequest,
  input: {
    ...sampleRequest.input,
    requester: {
      author_key: "u1",
      role: "admin",
      rights: { can_restrict_members: true, x_future: 1 },
      is_owner: false,
      anonymous: false,
      x_future: 1,
    },
    short_term_memory: "The meetup moved to Friday.",
    tools: [
      { name: "search_docs", summary: "Search the chat's documents", mode: "direct" },
      { name: "mute_participant", summary: "Mute a participant", mode: "handoff", x_future: 1 },
    ],
    x_future: 1,
  },
} as const;
test("request limits and additive fields", () => {
  expect(
    requestSchema.safeParse({ ...sampleRequest, x_future: 1 }).success,
  ).toBe(true);
  expect(
    requestSchema.safeParse({
      ...sampleRequest,
      answer: { max_chars: 32001, progress: "notes" },
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...sampleRequest,
      input: {
        ...sampleRequest.input,
        documents: Array.from({ length: 21 }, () => ({
          title: "x",
          text: "y",
        })),
      },
    }).success,
  ).toBe(false);
});
test("answer checks", () => {
  const request = requestSchema.parse(sampleRequest);
  expect(
    checkedAnswer({ action: "reply", text: " ", reply_to: null }, request),
  ).toBeNull();
  expect(
    checkedAnswer(
      { action: "reply", text: "x".repeat(21), reply_to: null },
      request,
    ),
  ).toBeNull();
  expect(
    checkedAnswer(
      { action: "reply", text: "hello", reply_to: "foreign" },
      request,
    ),
  ).toEqual({ action: "reply", text: "hello", reply_to: null });
  expect(
    checkedAnswer(
      { action: "ignore", text: "discard", reply_to: "m1" },
      request,
    )?.text,
  ).toBe("");
});

test("requester_context fields are optional and additive", () => {
  const legacy = requestSchema.parse(sampleRequest);
  expect(legacy.input.requester).toBeUndefined();
  expect(legacy.input.tools).toBeUndefined();
  const parsed = requestSchema.parse(contextRequest);
  // Unknown fields inside the new objects are ignored.
  expect(parsed.input.requester).toEqual({
    author_key: "u1",
    role: "admin",
    rights: { can_restrict_members: true },
    is_owner: false,
    anonymous: false,
  });
  expect(parsed.input.tools?.[1]).toEqual({ name: "mute_participant", summary: "Mute a participant", mode: "handoff" });
  expect(parsed.input.short_term_memory).toBe("The meetup moved to Friday.");
  // null means absent, as for the other nullable inputs.
  expect(
    requestSchema.safeParse({ ...sampleRequest, input: { ...sampleRequest.input, requester: null, short_term_memory: null } }).success,
  ).toBe(true);
  const withInput = (input: Record<string, unknown>) =>
    requestSchema.safeParse({ ...sampleRequest, input: { ...sampleRequest.input, ...input } }).success;
  const tool = (name: string) => ({ name, summary: "s", mode: "handoff" });
  expect(withInput({ tools: Array.from({ length: 128 }, (_, i) => tool(`t${i}`)) })).toBe(true);
  expect(withInput({ tools: Array.from({ length: 129 }, (_, i) => tool(`t${i}`)) })).toBe(false);
  expect(withInput({ tools: [tool("x".repeat(65))] })).toBe(false);
  expect(withInput({ tools: [tool("same"), tool("same")] })).toBe(false);
  expect(withInput({ tools: [{ ...tool("t"), summary: "s".repeat(241) }] })).toBe(false);
  expect(withInput({ tools: [{ ...tool("t"), mode: "auto" }] })).toBe(false);
  expect(withInput({ short_term_memory: "m".repeat(10000) })).toBe(true);
  expect(withInput({ short_term_memory: "m".repeat(10001) })).toBe(false);
  expect(withInput({ requester: { ...contextRequest.input.requester, role: "owner" } })).toBe(false);
  expect(withInput({ requester: { ...contextRequest.input.requester, author_key: "has space" } })).toBe(false);
});
test("handoff is an answer only when the request lists the service's tools", () => {
  const handoff = { action: "handoff", text: "I would mute them", reply_to: "m1" };
  expect(checkedAnswer(handoff, requestSchema.parse(sampleRequest))).toBeNull();
  expect(
    checkedAnswer(handoff, requestSchema.parse({ ...contextRequest, input: { ...contextRequest.input, tools: [] } })),
  ).toBeNull();
  // The model's text and reply target never travel with a hand-off.
  expect(checkedAnswer(handoff, requestSchema.parse(contextRequest))).toEqual({
    action: "handoff",
    text: "",
    reply_to: null,
  });
});
