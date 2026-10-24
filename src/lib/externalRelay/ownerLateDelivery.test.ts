import fs from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { startTestRelay } from "./testRelay";
import { clonePairing, cloneReceipt } from "./clone.fixture";
import { deliverOwnerLateAnswer } from "./ownerLateDelivery";
import { changeRun, dropRun, readRunLedger, reserveRun } from "./store";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";

const context = { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: 12 };
const body = { lease_id: "fixture", outcome: "answered" as const,
  answer: { action: "reply" as const, text: "Answer <with> & text", reply_to: "opaque_trigger" }, duration_ms: 121000 };
async function fixture(id: string, delivery: unknown = context, owner = true,
  handler: Parameters<typeof startTestRelay>[0] = () => ({ body: cloneReceipt() })) {
  const server = await startTestRelay(handler);
  const relay = clonePairing(server.origin);
  const directory = await fs.promises.mkdtemp(`${process.env.TMPDIR}/owner-late-send-`);
  reserveRun({ requestId: id, leaseId: "fixture", relayId: relay.id, targetId: "fixture-clone",
    ownerPid: process.pid, ownerIdentity: "fixture", childPid: null, childIdentity: null,
    startedAt: "2026-10-24T15:00:00Z", runDir: directory,
    ...(owner ? { ownerTurn: { clientAttemptId: `relay-owner-${id}`, delivery: delivery as typeof context } } : {}) }, 1);
  return { relay, pending: () => readRunLedger().runs.find(row => row.requestId === id)?.ownerTurn?.lateAnswer,
    send: (authorize = () => true) => deliverOwnerLateAnswer(relay, id, body, [], authorize),
    close: async () => { dropRun(id); await server.close(); await fs.promises.rm(directory, { recursive: true, force: true }); } };
}

test("lost send ACK and repeated delivery use the persisted key and payload", async () => {
  const payloads: unknown[] = [], messages = new Set<string>();
  const f = await fixture("stable_send", context, true, (req, payload) => {
    const input = payload as { client_key: string };
    const saved = f.pending();
    expect(input.client_key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(saved?.clientKey).toBe(input.client_key);
    expect(payload).toEqual(saved?.payload);
    expect(req.url).toBe("/api/relay/v1/targets/fixture-clone/send");
    expect(req.headers.authorization).toBe(`Bearer ${f.relay.credential}`);
    expect(req.headers["delegatus-relay-version"]).toBe("1");
    expect(req.headers["content-type"]).toBe("application/json");
    payloads.push(payload); messages.add(input.client_key);
    return payloads.length === 1 ? { drop: true } : { body: cloneReceipt(101, true) };
  });
  try {
    expect(await f.send()).toMatchObject({ delivery: "accepted" });
    changeRun("stable_send", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
    expect(await f.send()).toMatchObject({ delivery: "accepted" });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(f.pending()?.parts?.[0]?.receipt).toMatchObject({ kind: "sent", messageId: 101 });
    expect(messages.size).toBe(1);
    expect(payloads[0]).toMatchObject({ ...context, text: "Answer <with> & text", parse_mode: null, silent: false });
  } finally { await f.close(); }
});

for (const [name, delivery] of [
  ["absent", undefined], ["missing-trigger", { chat_id: context.chat_id, message_thread_id: 12 }],
  ["zero-chat", { ...context, chat_id: 0 }], ["unsafe-chat", { ...context, chat_id: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid-topic", { ...context, message_thread_id: 0 }], ["invalid-trigger", { ...context, reply_to_message_id: -1 }],
] as const) test(`${name} delivery context stays durable and sends nothing`, async () => {
  let calls = 0;
  // Explicitly remove default context for the absent case.
  const f = await fixture(`context_${name}`, delivery ?? null, true, () => { calls++; return { body: cloneReceipt() }; });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(f.pending()).toMatchObject({ body, status: "pending-delivery-context" });
    expect(calls).toBe(0);
    expect(log.mock.calls.some(args => String(args[0]).includes("pending-delivery-context"))).toBe(true);
    expect(requestSchema.parse({ ...contextRequest, owner_delivery: delivery }).owner_delivery).toBeUndefined();
  } finally { log.mockRestore(); await f.close(); }
});

test("null topic omits the thread field and refuses member or revoked custody", async () => {
  const payloads: Record<string, unknown>[] = [];
  const f = await fixture("no_topic", { ...context, message_thread_id: null }, true, (_req, payload) => {
    payloads.push(payload as Record<string, unknown>); return { body: cloneReceipt() };
  });
  try { expect(await f.send()).toMatchObject({ delivery: "accepted" });
    expect(payloads).toHaveLength(1); expect(payloads[0]).not.toHaveProperty("message_thread_id");
    expect(await f.send(() => false)).toMatchObject({ delivery: "refused" }); expect(payloads).toHaveLength(1);
  } finally { await f.close(); }
  const member = await fixture("member_context", context, false, () => { throw Error("member sent"); });
  try { expect(await member.send()).toMatchObject({ delivery: "refused" }); expect(member.pending()).toBeUndefined(); }
  finally { await member.close(); }
});

for (const [status, code] of [[404, "not_found"], [503, "telegram_unavailable"]] as const)
test(`${status} keeps the exact answer queued for retry`, async () => {
  let calls = 0, now = Date.parse("2026-10-24T15:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const payloads: unknown[] = [];
  const f = await fixture(`retry_${status}`, context, true, (_req, payload) => {
    payloads.push(payload); return calls++ === 0 ? { status, body: { error: { code } } } : { body: cloneReceipt() };
  });
  try {
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(f.pending()).toMatchObject({ body, status: "retry" });
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" }); expect(calls).toBe(1);
    now += 30000;
    expect(await f.send()).toMatchObject({ delivery: "accepted" });
    expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]);
  } finally { clock.mockRestore(); await f.close(); }
});

for (const code of ["send_uncertain", "idempotency_conflict"]) test(`${code} fences automatic retries`, async () => {
  let calls = 0, now = Date.parse("2026-10-24T15:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture(code, context, true, () => { calls++; return { status: 409, body: { error: { code } } }; });
  try {
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(f.pending()?.status).toBe("uncertain"); now += 86400000;
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" }); expect(calls).toBe(1);
  } finally { clock.mockRestore(); await f.close(); }
});

test("an unresolved key past service retention is kept without redispatch", async () => {
  let calls = 0;
  const f = await fixture("expired_key", context, true, () => { calls++; return { body: cloneReceipt() }; });
  changeRun("expired_key", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: {
    body, files: [], firstAttemptAt: Date.now() - 86400000 } } }));
  try { expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(f.pending()?.status).toBe("retry-expired"); expect(calls).toBe(0);
  } finally { await f.close(); }
});

test("revocation after durable preparation refuses the actual HTTP dispatch", async () => {
  let calls = 0, checks = 0;
  const f = await fixture("revoked_at_dispatch", context, true, () => { calls++; return { body: cloneReceipt() }; });
  try {
    expect(await f.send(() => ++checks < 3)).toMatchObject({ delivery: "unconfirmed" });
    expect(checks).toBe(3); expect(calls).toBe(0); expect(f.pending()?.payload).toBeDefined();
  } finally { await f.close(); }
});

test("a later unused-key refusal cannot clear an earlier unresolved delivery fence", async () => {
  let calls = 0, now = Date.parse("2026-10-24T15:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture("unresolved_then_refused", context, true, () => {
    calls++; return calls === 1 ? { status: 409, body: { error: { code: "unrecognised" } } }
      : { status: 503, body: { error: { code: "telegram_unavailable" } } };
  });
  try {
    await f.send(); const firstAttempt = f.pending()?.firstAttemptAt;
    now += 30000; await f.send();
    expect(f.pending()?.firstAttemptAt).toBe(firstAttempt);
    now += 86400000; await f.send();
    expect(f.pending()?.status).toBe("retry-expired"); expect(calls).toBe(2);
  } finally { clock.mockRestore(); await f.close(); }
});

for (const text of ["x".repeat(5000), "`" + "x".repeat(4094) + "😀<&>".repeat(1100) + "`", "`" + "<&>".repeat(4000) + "`"])
test(`long rich answer fits plain Telegram parts (${text.length} UTF-16 units)`, async () => {
  const payloads: import("./cloneSend").CloneSendInput[] = [];
  const f = await fixture(`long_${text.length}`, context, true, (_req, payload) => {
    payloads.push(payload as import("./cloneSend").CloneSendInput);
    return { body: cloneReceipt(100 + payloads.length) };
  });
  const rich = { ...body, answer: { ...body.answer, text, format: "rich_markdown" as const } };
  const { checkedAnswerV2, answerCapabilities } = await import("./answerV2");
  try {
    const { richRequest } = await import("./rich.fixture");
    const request = richRequest(true);
    expect(checkedAnswerV2(rich.answer, request, answerCapabilities(request, "codex"))).not.toBeNull();
    expect(await deliverOwnerLateAnswer(f.relay, `long_${text.length}`, rich, [], () => true)).toMatchObject({ delivery: "accepted" });
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.map(part => part.text).join("")).toBe(text);
    expect(new Set(payloads.map(part => part.client_key)).size).toBe(payloads.length);
    for (const part of payloads) {
      expect(part).toMatchObject({ ...context, parse_mode: null, silent: false });
      expect(part.text.length).toBeLessThanOrEqual(4096);
      expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(f.pending()?.parts?.every(part => part.receipt?.kind === "sent")).toBe(true);
  } finally { await f.close(); }
});

test("attachment omission note remains whole at the part boundary", async () => {
  const payloads: { text: string }[] = [];
  const f = await fixture("note_boundary", context, true, (_req, payload) => {
    payloads.push(payload as { text: string }); return { body: cloneReceipt() };
  });
  const withFiles = { ...body, answer: { ...body.answer, text: "x".repeat(4096),
    attachments: [{ attachment_id: "fixture_file", kind: "document" as const, caption: "" }] } };
  try {
    expect(await deliverOwnerLateAnswer(f.relay, "note_boundary", withFiles, [], () => true)).toMatchObject({ delivery: "accepted" });
    expect(payloads.map(part => part.text)).toEqual([withFiles.answer.text,
      "[Files were produced; late delivery supports text only, so files are omitted.]"]);
  } finally { await f.close(); }
});

test("a definite permanent text refusal is retained without automatic redispatch", async () => {
  let calls = 0;
  const f = await fixture("permanent_refusal", context, true, () => {
    calls++; return { status: 400, body: { error: { code: "text_too_long" } } };
  });
  try {
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    changeRun("permanent_refusal", row => ({ ...row, ownerTurn: { ...row.ownerTurn!,
      lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(f.pending()?.status).toBe("refused"); expect(calls).toBe(1);
  } finally { await f.close(); }
});

for (const [code, lostFirst] of [["already_completed", false], ["already_completed", true], ["lease_lost", true]] as const)
test(`${code} owner completion keeps delivery uncertain (lost ACK: ${lostFirst})`, async () => {
  const { completeRelayRequest } = await import("./relayCompletion");
  let calls = 0;
  const f = await fixture(`complete_uncertain_${code}_${lostFirst}`, context, true, () => {
    calls++;
    return lostFirst && calls === 1 ? { drop: true } : { status: 409, body: { error: { code } } };
  });
  try {
    const until = Date.now() + 10000;
    expect(await completeRelayRequest(f.relay, "complete_uncertain", body, () => until, () => true)).toEqual({ body, delivery: "unconfirmed" });
    expect(calls).toBe(lostFirst ? 2 : 1);
  } finally { await f.close(); }
});

for (const unresolved of [false, true]) test(`legacy long HTML payload migration preserves delivery certainty (${unresolved})`, async () => {
  const { cloneClientKey } = await import("./cloneSend");
  const id = `legacy_long_${unresolved}`;
  const key = cloneClientKey("paired-clone-fixture", "owner-late-answer", id, 0);
  const payloads: import("./cloneSend").CloneSendInput[] = [];
  const f = await fixture(id, context, true, (_req, raw) => {
    const part = raw as typeof payloads[number]; payloads.push(part);
    return part.parse_mode === "HTML" ? { status: 400, body: { error: { code: "text_too_long" } } }
      : { body: cloneReceipt(100 + payloads.length) };
  });
  const longBody = { ...body, answer: { ...body.answer, text: "x".repeat(5000) } };
  const payload = { ...context, client_key: key, text: "x".repeat(5000), parse_mode: "HTML" as const, silent: false };
  changeRun(id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { body: longBody, files: [],
    clientKey: key, payload, ...(unresolved ? { firstAttemptAt: Date.now() } : {}) } } }));
  try {
    const result = await f.send();
    if (unresolved) {
      // No changed payload is ever sent on a key which may already have landed.
      expect(result.delivery).toBe("unconfirmed"); expect(payloads).toEqual([payload]);
      expect(f.pending()?.status).toBe("refused");
    } else {
      expect(result.delivery).toBe("accepted"); expect(payloads).toHaveLength(2);
      expect(payloads.map(part => part.text).join("")).toBe(longBody.answer.text);
      expect(payloads[0]?.client_key).toBe(key);
    }
  } finally { await f.close(); }
});

test("a lost per-part receipt write retries the persisted payload without another visible message", async () => {
  const store = await import("./store");
  const messages = new Set<string>(), payloads: unknown[] = [];
  const f = await fixture("receipt_write_lost", context, true, (_req, raw) => {
    const input = raw as { client_key: string }; payloads.push(raw); messages.add(input.client_key);
    return { body: cloneReceipt(101, payloads.length > 1) };
  });
  const write = store.changeRunAsync;
  let refused = false;
  const writer = spyOn(store, "changeRunAsync").mockImplementation(async (id, update, until) => {
    const row = store.readRunLedger().runs.find(row => row.requestId === id);
    if (!refused && row && update(row).ownerTurn?.lateAnswer?.parts?.[0]?.receipt) {
      refused = true; throw new Error("fixture receipt write refused");
    }
    return write(id, update, until);
  });
  try {
    expect(await f.send()).toMatchObject({ delivery: "unconfirmed" });
    expect(refused).toBe(true);
    expect(f.pending()?.parts?.[0]?.receipt).toBeUndefined();
    writer.mockRestore();
    changeRun("receipt_write_lost", row => ({ ...row, ownerTurn: { ...row.ownerTurn!,
      lateAnswer: { ...row.ownerTurn!.lateAnswer!, nextAttemptAt: 0 } } }));
    expect(await f.send()).toMatchObject({ delivery: "accepted" });
    expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]); expect(messages.size).toBe(1);
  } finally { writer.mockRestore(); await f.close(); }
});
