import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ownerIndex, ownerRequest, x1Claim, x1Request, x1Results } from "./toolLoop.fixture";
import { expect, test } from "bun:test";
import { checkedAnswer, checkedRound, toolCallResultSchema, descriptorSchema, requestSchema } from "./protocol";
import type { ExternalRelayRequest } from "./protocol";
import { contextRequest, sampleRequest, serviceClaims } from "./request.fixture";

test("paired service windows and late claims parse in requests and descriptors", () => {
  const liveness = { ...sampleRequest.liveness, claim_window_s: 120, stall_window_s: 4, ack_window_s: 600, poll_freshness_s: 1 };
  expect(requestSchema.safeParse({ ...sampleRequest, liveness }).success).toBe(true);
  expect(descriptorSchema.safeParse({ protocol: "delegatus-relay", versions: [1], name: "Test", description: "Test",
    api_base: "https://relay.example/v1", kinds: ["answer"], liveness,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 } }).success).toBe(true);
  for (const field of ["claim_window_s", "ack_window_s", "poll_freshness_s", "stall_window_s"])
    expect(requestSchema.safeParse({ ...sampleRequest, liveness: { ...liveness, [field]: 0 } }).success).toBe(false);
});

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

test("F4 descriptor features survive parsing and owner I10 schemas survive unchanged", () => {
  const descriptor = { protocol: "delegatus-relay", versions: [1], name: "Test", description: "Test",
    api_base: "https://relay.example/v1", kinds: ["answer"], liveness: sampleRequest.liveness,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "relay_owner_tools"] };
  expect(descriptorSchema.parse(descriptor).features).toEqual(descriptor.features);
  const parsed = requestSchema.parse(ownerRequest());
  expect(parsed.input.tools!.filter((tool) => tool.name.startsWith("owner_"))).toEqual(ownerIndex);
  expect(ownerIndex).toHaveLength(14);
  expect(ownerIndex.filter((tool) => tool.effect === "read")).toHaveLength(6);
  expect(ownerIndex.reduce((bytes, tool) => bytes + Buffer.byteLength(JSON.stringify(tool.parameters)), 0)).toBe(4903);
  expect(ownerIndex.find((tool) => tool.name === "owner_attach_grid_chats")!.parameters).toHaveProperty("$defs.AttachSettingsGridChatsRequest");
  expect(ownerIndex.some((tool) => tool.name === "owner_me")).toBe(false);
});

test("N1 preserves every pre-amendment v3 answer, compact, completion and X2 capture byte", () => {
  const pins = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1/owner-tools-off-v3-hashes.json"), "utf8"));
  for (const [name, sha] of Object.entries(pins))
    expect(createHash("sha256").update(fs.readFileSync(path.resolve(name))).digest("hex")).toBe(String(sha));
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

test("the durable service-wire catalog covers every cross-check case", () => {
  expect(serviceClaims.map(({ name }) => name)).toEqual([
    "claimed_legacy_claim_without_feature.json",
    "claimed_rc_admin.json",
    "claimed_rc_anonymous_admin.json",
    "claimed_rc_byte_bound.json",
    "claimed_rc_emoji_memory_16000.json",
    "claimed_rc_emoji_transcript_12000.json",
    "claimed_rc_member.json",
    "claimed_rc_memory_16000.json",
    "claimed_rc_owner.json",
  ]);
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

test("a verified owner's addressed prototype reply reaches the parser up to its 20000-character cap", () => {
  const words = `#proto-20fbd832 ${"🙂".repeat(20_000 - [..."#proto-20fbd832 "].length)}`;
  const input = { ...contextRequest.input, requester: { ...contextRequest.input.requester!, is_owner: true },
    conversation: [{ ...contextRequest.input.conversation[0]!, text: words }] };
  const passes = (change: Partial<ExternalRelayRequest["input"]> = {}) => requestSchema.safeParse({ ...contextRequest, input: { ...input, ...change } }).success;
  expect(passes()).toBe(true);
  expect(passes({ conversation: [{ ...input.conversation[0]!, text: words + "я" }] })).toBe(false);
  expect(passes({ requester: { ...input.requester, is_owner: false } })).toBe(false);
  expect(passes({ requester: { ...input.requester, is_anonymous_admin: true } })).toBe(false);
  expect(passes({ respond_to: "another-message" })).toBe(false);
  expect(passes({ conversation: [{ ...input.conversation[0]!, author: { ...input.conversation[0]!.author, key: "other-owner" } }] })).toBe(false);
  expect(passes({ conversation: [{ ...input.conversation[0]!, author: { ...input.conversation[0]!.author, self: true } }] })).toBe(false);
  expect(passes({ conversation: [{ ...input.conversation[0]!, text: "я".repeat(20_000) }] })).toBe(false);
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

test("X1 tool indexes keep their compact wire bytes and every result parses", () => {
  for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin"]) {
    const raw = x1Claim(role);
    const parsed = requestSchema.parse(raw);
    expect(JSON.stringify(parsed.input.tools)).toBe(JSON.stringify(raw.input.tools));
    expect(parsed.input.tool_guidance).toBe(raw.input.tool_guidance);
  }
  expect(Object.keys(x1Results)).toHaveLength(26);
  for (const value of Object.values(x1Results)) expect(toolCallResultSchema.safeParse(value).success).toBe(true);
  for (const change of [{ audience: "everyone" }, { status: "future" }, { calls_remaining: 17 }, { output: "😀".repeat(16001) }])
    expect(toolCallResultSchema.safeParse({ ...x1Results.ok, ...change }).success).toBe(false);
  const request = x1Request("member");
  const call = { action: "call", text: "", reply_to: null, calls: [{ tool: "search_docs", arguments: "{}", cursor: null }] };
  expect(checkedRound(call, request)).toMatchObject({ kind: "calls", calls: call.calls });
  expect(checkedAnswer(call, request)).toBeNull();
  expect(checkedRound({ action: "reply", text: "Done", reply_to: null, calls: [] }, request))
    .toEqual(checkedAnswer({ action: "reply", text: "Done", reply_to: null }, request));
});

test("all earlier fixtures and wire evidence retain their slice 2b hashes; X3 copies match the manifest", () => {
  const pins = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1/switches-off-2b-hashes.json"), "utf8"));
  for (const [name, sha] of Object.entries(pins)) if (name.startsWith("src/") || name.startsWith("evidence/"))
    expect(createHash("sha256").update(fs.readFileSync(path.resolve(name))).digest("hex")).toBe(String(sha));
  const readme = fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1/README.md"), "utf8");
  for (const row of readme.matchAll(/\| `([^`]+\.json)` \| (\d+) \| `([a-f0-9]{64})` \|/g)) {
    const bytes = fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1", row[1]!));
    expect(bytes.length).toBe(Number(row[2])); expect(createHash("sha256").update(bytes).digest("hex")).toBe(row[3]);
  }
});


test("rich negotiation fields survive parsing without changing legacy requests", () => {
  const format = { version: "celestia-rich-v1", formats: { plain: 4000, rich_markdown: 32000 }, guide: "Use rich Markdown for tables and long answers.", markdown_subset: ["headings"], max_blocks: 500, max_depth: 16, max_table_columns: 20,
    buttons: { allowed: true, placement: "answer.buttons", kind: "url", max_rows: 2, max_per_row: 3, max_total: 6, item_schema: { type: "object" } }, forbidden: ["raw_html"] };
  const media = { max_items: 4, max_total_bytes: 67108864, kinds: ["photo", "document", "audio", "video"] };
  const raw = { ...sampleRequest, features: ["relay_rich_messages", "relay_media_out"], input: { ...sampleRequest.input, format }, answer: { ...sampleRequest.answer, attachments: media } };
  const parsed = requestSchema.parse(raw);
  expect(parsed).toHaveProperty("features", raw.features);
  expect(parsed.input).toHaveProperty("format", format);
  expect(parsed.answer).toHaveProperty("attachments", media);
  for (const bad of [null, [], { version: "other" }]) {
    const malformed = requestSchema.parse({ ...raw, features: bad === null ? null : {}, input: { ...raw.input, format: bad }, answer: { ...raw.answer, attachments: bad } });
    expect(malformed).toHaveProperty("features", undefined);
    expect(malformed.input).toHaveProperty("format", undefined);
    expect(malformed.answer).toHaveProperty("attachments", undefined);
  }
  expect(requestSchema.parse(sampleRequest) as unknown).toEqual(sampleRequest);
});
test("owner answer URL button labels and filenames use Unicode code point limits", async () => {
  const { relayAnswerSchema } = await import("./protocol");
  expect(relayAnswerSchema.safeParse({ buttons: [[{ text: "😀".repeat(64), url: "https://example.com/" }]] }).success).toBe(true);
  expect(relayAnswerSchema.safeParse({ buttons: [[{ text: "😀".repeat(65), url: "https://example.com/" }]] }).success).toBe(false);
  expect(relayAnswerSchema.safeParse({ attachments: [{ path: "/file", kind: "document", filename: "😀".repeat(124) + ".pdf" }] }).success).toBe(true);
  expect(relayAnswerSchema.safeParse({ attachments: [{ path: "/file", kind: "document", filename: "😀".repeat(125) + ".pdf" }] }).success).toBe(false);
});
