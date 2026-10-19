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
      () => scopedOutbound(f.filename, "42", "41", 7, message.date, message.messageId),
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
    for (let i = 1; i <= 40; i++) await recordOutbound(f.filename, { ...message, sendKey: `question-${i}`, messageId: i, text: `Question ${i}?\n1) 😀 Small\n2) Large` });
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

test("explicit parents recover their bounded complete send group behind unrelated reports", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    await recordOutbound(f.filename, { ...message, messageId: 19, date: message.date + 1, text: "3) Remaining option" });
    for (let i = 0; i < 40; i++) await recordOutbound(f.filename, { ...message, messageId: 100 + i,
      sendKey: `other-${i}`, text: "Other question?", date: message.date + i + 2 });
    for (const parent of [18, 19]) {
      const rows = await scopedOutbound(f.filename, "42", "41", 7, message.date + 100, parent);
      expect(rows.map(m => m.messageId)).toEqual([18, 19]);
      expect(rows.map(m => m.text)).toEqual([message.text, "3) Remaining option"]);
    }
    expect(await scopedOutbound(f.filename, "42", "41", 8, message.date + 100, 18)).toEqual([]);
    expect(await scopedOutbound(f.filename, "42", "41", 7, message.date + 100, 999)).toEqual([]);
    for (let i = 20; i < 60; i++) await recordOutbound(f.filename, { ...message, messageId: i, text: "x".repeat(4000) });
    const bounded = await scopedOutbound(f.filename, "42", "41", 7, message.date + 100, 18);
    expect(bounded.some(m => m.messageId === 18)).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(32);
    expect(bounded.reduce((bytes, m) => bytes + Buffer.byteLength(m.text), 0)).toBeLessThanOrEqual(65536);
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

test("disconnected forwarding receipts expire on a later send and retention skips forwarding history", async () => {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000);
  const disconnected = { ...message, target: null, messageId: 700, date: now - 2 * 86400 };
  try {
    await recordOutbound(f.filename, disconnected);
    const db = new Database(f.filename);
    try {
      db.query("UPDATE relay_outbound SET state='forwarding', attempts=1 WHERE message_id=?").run(disconnected.messageId);
      db.query("INSERT INTO relay_outbound_handoffs (key, link, destination, due) VALUES (?, ?, ?, ?)")
        .run(JSON.stringify([disconnected.botId, disconnected.chatId, disconnected.messageId]), "peer", "{}", now * 1000);
    } finally { db.close(); }

    await recordOutbound(f.filename, { ...message, messageId: 701, date: now });
    const afterExpiry = new Database(f.filename, { readonly: true });
    try {
      expect(afterExpiry.query("SELECT state, attempts FROM relay_outbound WHERE message_id=?").get(disconnected.messageId))
        .toEqual({ state: "terminal", attempts: 1 });
      expect(afterExpiry.query("SELECT reason FROM relay_publication_results WHERE key=?").get(JSON.stringify([disconnected.botId, disconnected.chatId, disconnected.messageId])))
        .toEqual({ reason: "expired" });
      expect(afterExpiry.query("SELECT 1 FROM relay_outbound_handoffs WHERE key=?").get(JSON.stringify([disconnected.botId, disconnected.chatId, disconnected.messageId])))
        .toBeNull();
    } finally { afterExpiry.close(); }

    const age = new Database(f.filename);
    try { age.query("UPDATE relay_outbound SET date=? WHERE message_id=?").run(now - 31 * 86400 - 1, disconnected.messageId); }
    finally { age.close(); }
    await recordOutbound(f.filename, { ...message, messageId: 702, date: now + 1 });
    const afterRetention = new Database(f.filename, { readonly: true });
    try { expect(afterRetention.query("SELECT 1 FROM relay_outbound WHERE message_id=?").get(disconnected.messageId)).toBeNull(); }
    finally { afterRetention.close(); }

    const history = new Database(f.filename);
    try {
      history.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
        INSERT INTO relay_outbound (key, bot_id, chat_id, topic_id, date, message_id, value_json, is_question, send_key, state, due, attempts)
        SELECT 'old-forward-'||n, '42', '41', 7, ${now - 31 * 86400}, 1000+n, '{}', 0, 'old', 'forwarding', 0, 1 FROM seq`);
      const plan = history.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT key FROM relay_outbound
        WHERE state NOT IN ('pending', 'forwarding') AND date<? ORDER BY date, key LIMIT 64`).all(now - 30 * 86400);
      expect(plan.map(row => row.detail).join(" ")).toContain("relay_outbound_retention_eligible");
    } finally { history.close(); }
    await recordOutbound(f.filename, { ...message, messageId: 703, date: now + 2 });
    const retained = new Database(f.filename, { readonly: true });
    try {
      expect(retained.query("SELECT count(*) AS count FROM relay_outbound WHERE state='forwarding' AND key LIKE 'old-forward-%'").get())
        .toEqual({ count: 99984 });
    } finally { retained.close(); }
  } finally { f.cleanup(); }
});

test("both outbound expiry passes seek expired dates through matching partial indexes", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    const db = new Database(f.filename);
    try {
      const forwarding = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT key FROM relay_outbound
        WHERE state IN ('unrouted', 'forwarding') AND date<=? ORDER BY date, key LIMIT 16`).all(message.date - 86400);
      const all = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT key FROM relay_outbound
        WHERE state IN ('pending', 'unrouted', 'forwarding') AND date<=? ORDER BY date, key LIMIT 16`).all(message.date - 86400);
      expect(forwarding.map(row => row.detail).join(" ")).toContain("relay_outbound_expiry_forwarding");
      expect(all.map(row => row.detail).join(" ")).toContain("relay_outbound_expiry");
      expect(forwarding.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
      expect(all.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test("legacy handoff rows gain a due key without losing their persisted retry deadline", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.filename, message);
    const due = message.date * 1000 + 4321;
    const legacy = new Database(f.filename);
    try {
      legacy.query("UPDATE relay_outbound SET state='forwarding', due=? WHERE key=?").run(due, JSON.stringify([message.botId, message.chatId, message.messageId]));
      legacy.query("INSERT INTO relay_outbound_handoffs (key, link, destination) VALUES (?, ?, ?)")
        .run(JSON.stringify([message.botId, message.chatId, message.messageId]), "legacy-link", "{}");
      legacy.exec("DROP INDEX relay_outbound_handoff_link_due");
      legacy.exec("ALTER TABLE relay_outbound_handoffs DROP COLUMN due");
    } finally { legacy.close(); }
    await recordOutbound(f.filename, { ...message, messageId: 19 });
    const migrated = new Database(f.filename, { readonly: true });
    try {
      expect(migrated.query<{ due: number }, [string]>("SELECT due FROM relay_outbound_handoffs WHERE key=?")
        .get(JSON.stringify([message.botId, message.chatId, message.messageId]))?.due).toBe(due);
      const plan = migrated.query<{ detail: string }, [string, number]>(`EXPLAIN QUERY PLAN SELECT key FROM relay_outbound_handoffs
        WHERE link=? AND due<=? ORDER BY due, key LIMIT 16`).all("legacy-link", due);
      expect(plan.map(row => row.detail).join(" ")).toContain("relay_outbound_handoff_link_due");
    } finally { migrated.close(); }
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

test.each([400, 403, 409])("durable publication %s ends once and records the service reason", async status => {
  const f = fixture(); let calls = 0;
  const ports = { target: () => message.target, allowed: () => true, now: () => message.date * 1000,
    publish: async () => { calls++; throw new ExternalRelayError("fixture_refusal", status); } };
  let worker = new OutboundPublication(f.filename, ports);
  try {
    await recordOutbound(f.filename, message);
    worker.wake(); await worker.idle(); await worker.stop();
    worker = new OutboundPublication(f.filename, ports); worker.wake(); await worker.idle();
    expect(calls).toBe(1);
    const db = new Database(f.filename, { readonly: true });
    try { expect(db.query("SELECT state, reason FROM relay_outbound JOIN relay_publication_results USING(key)").get())
      .toEqual({ state: "terminal", reason: `${status}:fixture_refusal` }); }
    finally { db.close(); }
  } finally { await worker.stop(); f.cleanup(); }
});

test("an expired receipt never reaches the service and its Telegram text stays readable", async () => {
  const f = fixture(); let calls = 0;
  const worker = new OutboundPublication(f.filename, { target: () => message.target, allowed: () => true,
    now: () => (message.date + 86400) * 1000, publish: () => { calls++; return "published"; } });
  try {
    await recordOutbound(f.filename, message); worker.wake(); await worker.idle();
    expect(calls).toBe(0);
    expect(await pendingOutbound(f.filename, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await scopedOutbound(f.filename, message.botId, message.chatId, message.topicId, message.date + 86400))[0]?.text).toBe(message.text);
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
