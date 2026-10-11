import { expect, test } from "bun:test";
import { startTestRelay } from "./testRelay";
import { createRelayPublisher, publishRelayMessage, relayPublishBody } from "./publish";
import type { PairedRelay } from "./store";

const receipt = { botId: "123", chatId: "41", messageId: 17, date: 1791724800, topicId: null, text: "Review" };
test("publish body keeps Telegram time, topic and Unicode within both limits", () => {
  expect(relayPublishBody(receipt)).toEqual({ chat_id: 41, message_id: 17, sent_at: "2026-10-11T13:20:00.000Z", text: "Review" });
  for (const text of ["😀".repeat(13000), "\u0000".repeat(13000), "Review\n" + "字".repeat(13000)]) {
    const body = relayPublishBody({ ...receipt, topicId: 7, text })!;
    expect([...body.text].length).toBeLessThanOrEqual(12000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(65536);
    expect(body.text.endsWith("\n[truncated]")).toBe(true);
    expect(body.message_thread_id).toBe(7);
    expect(body.text).not.toContain("�");
  }
  for (const bad of [{ chatId: "0" }, { messageId: 0 }, { messageId: 2147483648 }, { text: " " }])
    expect(relayPublishBody({ ...receipt, ...bad })).toBeNull();
});

test("lost publish receipt and 429 retry preserve the body and pairing headers", async () => {
  const bodies: unknown[] = [], waits: number[] = [];
  const credential = "q".repeat(43);
  const server = await startTestRelay((request, body) => {
    expect(request.url).toBe("/v1/targets/fixture/messages");
    expect(request.headers.authorization).toBe(`Bearer ${credential}`);
    expect(request.headers["delegatus-relay-version"]).toBe("1");
    bodies.push(body);
    if (bodies.length === 1) return { drop: true };
    if (bodies.length === 2) return { status: 429, body: { error: { code: "rate_limited", retry_after_s: 60 } } };
    return { body: { message_key: "message_review", replayed: true } };
  });
  try {
    const body = relayPublishBody(receipt)!;
    expect(await publishRelayMessage({ api_base: `${server.origin}/v1`, credential }, "fixture", body,
      { sleep: async ms => { waits.push(ms); } })).toBe("published");
    expect(bodies).toEqual([body, body, body]);
    expect(waits).toEqual([1000, 60000]);
  } finally { await server.close(); }
});

for (const [status, outcome] of [[403, "not_allowed"], [404, "unavailable"], [409, "refused"],
  [400, "refused"], [401, "refused"], [413, "refused"], [426, "refused"]] as const)
test(`publish ${status} is terminal`, async () => {
  let calls = 0;
  const server = await startTestRelay(() => { calls++; return { status, body: { error: { code: "fixture" } } }; });
  try {
    expect(await publishRelayMessage({ api_base: `${server.origin}/v1`, credential: "q".repeat(43) }, "fixture", relayPublishBody(receipt)!,
      { sleep: async () => { throw Error("must not wait"); } })).toBe(outcome);
    expect(calls).toBe(1);
  } finally { await server.close(); }
});

test("transient failures stop after four attempts", async () => {
  let calls = 0;
  const server = await startTestRelay(() => { calls++; return { drop: true }; });
  try {
    expect(await publishRelayMessage({ api_base: `${server.origin}/v1`, credential: "q".repeat(43) }, "fixture", relayPublishBody(receipt)!,
      { sleep: async () => {} })).toBe("unconfirmed");
    expect(calls).toBe(4);
  } finally { await server.close(); }
});

for (const status of [403, 404]) test(`queued publications share the ${status} cooldown and recover later`, async () => {
  let calls = 0, time = 0;
  const server = await startTestRelay(() => { calls++; return calls === 1
    ? { status, body: { error: { code: "fixture" } } }
    : { body: { message_key: "m_fixture", replayed: false } }; });
  const paired = { id: "fixture", api_base: `${server.origin}/v1`, credential: "q".repeat(43) } as PairedRelay;
  const publisher = createRelayPublisher(botId => botId === receipt.botId ? { relay: paired, targetId: "fixture" } : null,
    { now: () => time });
  try {
    const results = await Promise.all([publisher(receipt), publisher({ ...receipt, messageId: 18 }), publisher({ ...receipt, messageId: 19 })]);
    expect(results).toEqual([status === 403 ? "not_allowed" : "unavailable", "skipped", "skipped"]);
    expect(calls).toBe(1);
    expect(await publisher({ ...receipt, botId: "other" })).toBe("skipped");
    if (status === 403) expect(await publisher({ ...receipt, chatId: "77" })).toBe("published");
    else expect(await publisher({ ...receipt, chatId: "77" })).toBe("skipped");
    time = 300001;
    expect(await publisher(receipt)).toBe("published");
  } finally { await server.close(); }
});

test("429 pauses sibling messages and an unpaired queued message is skipped", async () => {
  const bodies: unknown[] = [];
  let waited!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { waited = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const server = await startTestRelay((_request, body) => {
    bodies.push(body);
    return bodies.length === 1 ? { status: 429, body: { error: { code: "rate_limited", retry_after_s: 60 } } }
      : { body: { message_key: "m_fixture", replayed: true } };
  });
  const paired = { id: "fixture", api_base: `${server.origin}/v1`, credential: "q".repeat(43) } as PairedRelay;
  let connected = true;
  const publisher = createRelayPublisher(() => connected ? { relay: paired, targetId: "fixture" } : null,
    { sleep: async ms => { expect(ms).toBe(60000); waited(); await gate; } });
  try {
    const first = publisher(receipt), second = publisher({ ...receipt, messageId: 18 });
    await waiting;
    expect(bodies).toHaveLength(1);
    connected = false; resume();
    expect(await first).toBe("published"); expect(await second).toBe("skipped");
    expect(bodies).toEqual([relayPublishBody(receipt), relayPublishBody(receipt)]);
  } finally { resume(); await server.close(); }
});
