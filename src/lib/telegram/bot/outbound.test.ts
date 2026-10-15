import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TelegramBotStore } from "./store";
import { recordOutbound, pendingOutbound, scopedOutbound, settleOutbound, ownerQuestionCutoff,
  holdPublications, publicationCooldown, type OutboundMessage } from "./outbound";
import { OutboundPublication } from "./outboundPublication";
import { ExternalRelayError } from "@/lib/externalRelay/client";

const message: OutboundMessage = { botId: "42", chatId: "41", topicId: 7, messageId: 18, date: 1791724800,
  text: "Which sample?\n1) Small\n2) Large", origin: "agent", conversationId: "conversation_fixture", replyToMessageId: 17,
  sendKey: "fixture", target: { relayId: "fixture", apiBase: "https://fixture.invalid/v1", targetId: "first", ownerId: "41" } };
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "outbound-store-"));
  const filename = path.join(root, "bot.sqlite"); const store = new TelegramBotStore(filename); store.close();
  return { filename, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("receipt and obligation commit atomically; replays are immutable and conflicting custody is refused", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message); await recordOutbound(f.filename, message);
    expect(await pendingOutbound(f.filename, 0)).toHaveLength(1);
    await expect(recordOutbound(f.filename, { ...message, text: "Changed" })).rejects.toThrow("receipt conflict");
    expect((await scopedOutbound(f.filename, "42", "41", 7, message.date))[0]).toEqual(message);
    const db = new Database(f.filename);
    db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages WHEN new.message_id=19 BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"); db.close();
    await expect(recordOutbound(f.filename, { ...message, messageId: 19 })).rejects.toThrow("fixture refusal");
    expect(await pendingOutbound(f.filename, 0)).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("new journal reads and writes yield to a peer lock while an independent timer advances", async () => {
  const f = fixture();
  const peer = new Database(f.filename); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await recordOutbound(f.filename, message);
    const row = (await pendingOutbound(f.filename, 0))[0]!;
    const cases: Array<() => Promise<unknown>> = [
      () => recordOutbound(f.filename, { ...message, messageId: 19 }),
      () => pendingOutbound(f.filename, 0),
      () => scopedOutbound(f.filename, "42", "41", 7, message.date),
      () => settleOutbound(f.filename, row, false, 1),
      () => ownerQuestionCutoff(f.filename, "scope", "request", message.date),
      () => holdPublications(f.filename, message, 300000),
      () => publicationCooldown(f.filename, message),
    ];
    for (const operation of cases) {
      peer.exec("BEGIN IMMEDIATE"); let advanced = false;
      timer = setTimeout(() => { advanced = true; peer.exec("ROLLBACK"); }, 20);
      await operation();
      // WAL readers may finish while the writer is held; the timer must still run.
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      expect(advanced).toBe(true);
      clearTimeout(timer);
    }
  } finally { clearTimeout(timer); if (peer.inTransaction) peer.exec("ROLLBACK"); peer.close(); f.cleanup(); }
});

test("context reads are scoped, bounded and retain Unicode and complete options", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 40; i++) await recordOutbound(f.filename, { ...message, messageId: i, text: `Question ${i}?\n1) 😀 Small\n2) Large` });
    for (const other of [{ botId: "43" }, { chatId: "99" }, { topicId: 8 }]) await recordOutbound(f.filename, { ...message, ...other, messageId: 99 });
    const rows = await scopedOutbound(f.filename, "42", "41", 7, message.date);
    expect(rows).toHaveLength(32); expect(rows[0]!.messageId).toBe(9); expect(rows.at(-1)!.messageId).toBe(40);
    expect(rows.every(r => r.topicId === 7 && r.text.includes("1) 😀 Small\n2) Large"))).toBe(true);
    expect(await scopedOutbound(f.filename, "42", "41", null, message.date)).toEqual([]);
    expect((await scopedOutbound(f.filename, "42", "41", 7, message.date, 1)).map(m => m.messageId)).toEqual([1]);
    await recordOutbound(f.filename, { ...message, messageId: 100, text: "😀".repeat(40000) });
    const bounded = await scopedOutbound(f.filename, "42", "41", 7, message.date);
    expect(bounded.some(m => m.messageId === 100)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(131072);
  } finally { f.cleanup(); }
});

test("published retention is bounded and pending receipts survive expiry; observed owner cutoffs replay", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    await recordOutbound(f.filename, { ...message, messageId: 19 });
    const rows = await pendingOutbound(f.filename, 0);
    await settleOutbound(f.filename, rows[0]!, true, message.date * 1000);
    await settleOutbound(f.filename, rows[1]!, false, (message.date + 31 * 86400) * 1000);
    expect((await pendingOutbound(f.filename, Number.MAX_SAFE_INTEGER)).map(r => r.message.messageId)).toEqual([19]);
    expect(await ownerQuestionCutoff(f.filename, "scope", "a", 100)).toBe(0);
    expect(await ownerQuestionCutoff(f.filename, "scope", "a", 100)).toBe(0);
    expect(await ownerQuestionCutoff(f.filename, "scope", "b", 200)).toBe(100);
    expect(await ownerQuestionCutoff(f.filename, "scope", "old", 50)).toBe(200);
    expect(await ownerQuestionCutoff(f.filename, "scope", "a", 100)).toBe(0);
  } finally { f.cleanup(); }
});

test.each(["unpaired", "target-changed", "owner-changed", "chat-revoked", "revoked-after-await"])("publication refuses %s without discarding custody", async kind => {
  const f = fixture(); let calls = 0; let current = message.target; let allowed = true;
  const worker = new OutboundPublication(f.filename, { target: () => current, allowed: () => allowed,
    publish: async (_m, authorize) => { if (kind === "revoked-after-await") { await Promise.resolve(); current = null; } authorize(); calls++; return "published"; }, now: () => 0 });
  try {
    await recordOutbound(f.filename, message);
    if (kind === "unpaired") current = null;
    if (kind === "target-changed") current = { ...message.target!, targetId: "other" };
    if (kind === "owner-changed") current = { ...message.target!, ownerId: "99" };
    if (kind === "chat-revoked") allowed = false;
    worker.wake(); await worker.idle();
    expect(calls).toBe(0);
    expect((await pendingOutbound(f.filename, 1000))[0]?.attempts).toBe(1);
  } finally { await worker.stop(); f.cleanup(); }
});

test("429 delay is durable, shared by siblings and preserved by a new queue owner", async () => {
  const f = fixture(); let now = 0; let calls = 0;
  const ports = { target: () => message.target, allowed: () => true, now: () => now,
    publish: async () => { calls++; if (calls === 1) throw new ExternalRelayError("rate_limited", 429, 60); return "published"; } };
  let worker = new OutboundPublication(f.filename, ports);
  try {
    await recordOutbound(f.filename, message); await recordOutbound(f.filename, { ...message, messageId: 19 });
    worker.wake(); await worker.idle(); await worker.stop();
    expect(calls).toBe(1);
    worker = new OutboundPublication(f.filename, ports); now = 59000; worker.wake(); await worker.idle(); expect(calls).toBe(1);
    now = 60000; worker.wake(); await worker.idle(); expect(calls).toBe(3);
    expect(await pendingOutbound(f.filename, now)).toEqual([]);
  } finally { await worker.stop(); f.cleanup(); }
});


test("unrouted receipts expire with bounded send-time cleanup while pending custody remains", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, { ...message, target: null });
    await recordOutbound(f.filename, { ...message, messageId: 19 });
    await recordOutbound(f.filename, { ...message, target: null, messageId: 20, date: message.date + 31 * 86400 });
    const db = new Database(f.filename, { readonly: true });
    try { expect(db.query("SELECT message_id FROM relay_outbound ORDER BY message_id").all()).toEqual([{ message_id: 19 }, { message_id: 20 }]); }
    finally { db.close(); }
  } finally { f.cleanup(); }
});


test("a latest question and its send group survive more than a history window of reports", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    await recordOutbound(f.filename, { ...message, messageId: 19, text: "3) Complete remaining option" });
    for (let i = 0; i < 40; i++) await recordOutbound(f.filename, { ...message, messageId: 100 + i, date: message.date + i + 1,
      sendKey: `report-${i}`, text: "Routine report." });
    const rows = await scopedOutbound(f.filename, message.botId, message.chatId, message.topicId, message.date + 100);
    expect(rows).toHaveLength(32);
    expect(rows.slice(0, 2).map(m => m.text)).toEqual([message.text, "3) Complete remaining option"]);
  } finally { f.cleanup(); }
});


test("competing question groups remain visible behind a window of reports", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    await recordOutbound(f.filename, { ...message, messageId: 19, sendKey: "second-question", date: message.date + 1 });
    for (let i = 0; i < 40; i++) await recordOutbound(f.filename, { ...message, messageId: 100 + i, date: message.date + i + 2,
      sendKey: `report-${i}`, text: "Routine report." });
    const rows = await scopedOutbound(f.filename, message.botId, message.chatId, message.topicId, message.date + 100);
    expect(rows.slice(0, 2).map(m => m.sendKey)).toEqual([message.sendKey, "second-question"]);
  } finally { f.cleanup(); }
});
