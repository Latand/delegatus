import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkedAnswer, descriptorSchema, requestSchema } from "./protocol";

const fixtureDir = path.join(import.meta.dir, "fixtures/service-wire");
export const serviceClaims = fs.readdirSync(fixtureDir)
  .filter((name) => /^claimed_.*\.json$/.test(name))
  .sort()
  .map((name) => ({ name, body: JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) }));
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
      key: "u1",
      is_admin: true,
      can_restrict_members: true,
      can_delete_messages: false,
      is_owner: false,
      is_anonymous_admin: false,
      x_future: 1,
    },
    short_term_memory: "The meetup moved to Friday.",
    tools: [
      { name: "lookup_notes", summary: "Search the chat's documents", mode: "direct" },
      { name: "restrict_member", summary: "Mute a participant", mode: "handoff", x_future: 1 },
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
    key: "u1",
    is_admin: true,
    can_restrict_members: true,
    can_delete_messages: false,
    is_owner: false,
    is_anonymous_admin: false,
  });
  expect(parsed.input.tools?.[1]).toEqual({ name: "restrict_member", summary: "Mute a participant", mode: "handoff" });
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
  expect(withInput({ short_term_memory: "m".repeat(16000) })).toBe(true);
  expect(withInput({ short_term_memory: "m".repeat(16001) })).toBe(false);
  expect(withInput({ requester: { ...contextRequest.input.requester, is_admin: "yes" } })).toBe(false);
  expect(withInput({ requester: { ...contextRequest.input.requester, key: "has space" } })).toBe(false);
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
test("a request's chat key is kept when valid and dropped when malformed", () => {
  expect(requestSchema.parse({ ...sampleRequest, chat: { key: "ck_3Rw9TtYqL0pZx7VbN2mD4e" } }).chat).toEqual({ key: "ck_3Rw9TtYqL0pZx7VbN2mD4e" });
  const malformed = requestSchema.safeParse({ ...sampleRequest, chat: { key: "short" } });
  expect(malformed.success).toBe(true);
  expect(malformed.data?.chat).toBeUndefined();
  expect(requestSchema.parse(sampleRequest).chat).toBeUndefined();
});

for (const { name, body } of serviceClaims)
  test(`service-built wire fixture parses: ${name}`, () => {
    expect(requestSchema.parse(body.request)).toEqual(body.request);
  });

test("the requester requires a key and exactly five boolean flags", () => {
  const requester = requestSchema.parse(contextRequest).input.requester!;
  expect(Object.keys(requester).sort()).toEqual([
    "can_delete_messages", "can_restrict_members", "is_admin", "is_anonymous_admin", "is_owner", "key",
  ]);
  for (const field of Object.keys(requester)) {
    const missing = { ...requester } as Record<string, unknown>;
    delete missing[field];
    expect(requestSchema.safeParse({ ...contextRequest, input: { ...contextRequest.input, requester: missing } }).success).toBe(false);
    expect(requestSchema.safeParse({ ...contextRequest, input: { ...contextRequest.input, requester: { ...requester, [field]: 1 } } }).success).toBe(false);
  }
});

test("input string bounds count Unicode code points", () => {
  const passes = (input: Record<string, unknown>) => requestSchema.safeParse({
    ...sampleRequest, input: { ...sampleRequest.input, ...input },
  }).success;
  const message = (text: string) => [{ ...sampleRequest.input.conversation[0], text }];
  expect(passes({ conversation: message("😀".repeat(12000)) })).toBe(true);
  for (const [max, input] of [
    [16000, (text: string) => ({ conversation: message(text) })],
    [16000, (text: string) => ({ short_term_memory: text })],
    [16000, (text: string) => ({ owner_instructions: text })],
    [32000, (text: string) => ({ instructions: text })],
    [4000, (text: string) => ({ request_text: text })],
    [16000, (text: string) => ({ documents: [{ title: "Test", text }] })],
    [200, (title: string) => ({ documents: [{ title, text: "Test" }] })],
    [128, (name: string) => ({ conversation: [{ ...sampleRequest.input.conversation[0], author: { key: "u1", name, self: false } }] })],
    [64, (name: string) => ({ tools: [{ name, summary: "Test", mode: "handoff" }] })],
    [240, (summary: string) => ({ tools: [{ name: "test", summary, mode: "handoff" }] })],
  ] as const) {
    expect(passes(input("😀".repeat(max)))).toBe(true);
    expect(passes(input("😀".repeat(max + 1)))).toBe(false);
  }
});

test("a descriptor allows a null or absent icon URL", () => {
  const descriptor = {
    protocol: "delegatus-relay", versions: [1], name: "Test", description: "Test",
    api_base: "https://relay.example/v1", kinds: ["answer"], liveness: sampleRequest.liveness,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
  };
  for (const icon_url of [null, undefined, "https://relay.example/icon.png"])
    expect(descriptorSchema.safeParse({ ...descriptor, icon_url }).success).toBe(true);
});
