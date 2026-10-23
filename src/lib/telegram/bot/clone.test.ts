import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clonePairing, cloneReceipt, cloneTargets } from "@/lib/externalRelay/clone.fixture";
import { CloneDirectory } from "@/lib/externalRelay/cloneDirectory";
import { sendAsClone, type CloneSendInput } from "@/lib/externalRelay/cloneSend";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { TelegramBotService, productionTelegramBotDependencies } from "./service";
import { FakeBotTransport, fakeBotToken, ok } from "./fakeTransport";
import { outboundState } from "./outbound";
import { telegramBotTokenPath } from "./transport";
import type { ClonePostingPort } from "./clone";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-bot-")), prior = process.env.LLV_STATE_DIR;
const group = { id: -1000000000101, type: "supergroup", title: "Fixture reports", is_forum: true };
let service: TelegramBotService, bot: FakeBotTransport, server: Awaited<ReturnType<typeof startTestRelay>>;
let directory: CloneDirectory, port: ClonePostingPort, relay: ReturnType<typeof clonePairing>;
let store: ReturnType<ReturnType<typeof productionTelegramBotDependencies>["openStore"]>;
let sends: CloneSendInput[], answer: (input: CloneSendInput) => ReturnType<Parameters<typeof startTestRelay>[0]>;
let now: number, sequence = 0;
beforeEach(async () => {
  now = Date.parse("2026-10-20T12:00:00Z"); sends = [];
  process.env.LLV_STATE_DIR = path.join(root, String(++sequence));
  answer = () => ({ body: cloneReceipt(100 + sends.length) });
  server = await startTestRelay((req, body) => {
    if (req.url!.includes("include=chats")) return { body: cloneTargets() };
    if (!req.url!.endsWith("/send")) throw new Error("unexpected relay route");
    sends.push(body as CloneSendInput); return answer(body as CloneSendInput);
  });
  relay = clonePairing(server.origin);
  directory = new CloneDirectory({ file: path.join(process.env.LLV_STATE_DIR, "clones.json"), relays: () => [relay], now: () => now, origin: server.origin });
  port = { route: chat => directory.route(chat), peek: chat => directory.peek(chat), valid: (r, chat) => directory.valid(r, chat),
    invalidate: (r, kind) => directory.invalidate(r, kind),
    send: (r, input, options) => sendAsClone(r.relay, r.targetId, input, { ...options, now: () => now, deadline: now + 300,
      sleep: async ms => { now += ms; } }) };
  bot = new FakeBotTransport();
  bot.handlers.getMe = () => ok({ id: 4242424, is_bot: true, first_name: "Fixture bot", username: "fixture_bot" });
  bot.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/webhook" });
  bot.handlers.getChatMember = () => ok({ status: "administrator" });
  bot.handlers.sendMessage = () => ok({ message_id: 201, date: Math.floor(now / 1000) });
  service = new TelegramBotService({ ...productionTelegramBotDependencies(), clones: port, now: () => new Date(now),
    transportFor: () => bot, documentEnvironment: () => ({ home: root, stateDir: process.env.LLV_STATE_DIR! }) });
  await service.connect(fakeBotToken("4242424"));
  store = productionTelegramBotDependencies().openStore();
  store.recordLookedUpChat(group, "member", new Date(now)); service.setChat(String(group.id), "reports", true);
  await directory.route(String(group.id));
});
afterEach(async () => { store.close(); await service.remove(); await server.close(); });
afterAll(() => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
  fs.rmSync(root, { recursive: true, force: true }); });
const send = (key = "fixture-send", text = "Fixture report") => service.send({ conversationId: "fixture-writer", clientRequestId: key,
  chat: "reports", text, topicId: 12 });

test("removed bot's group sends through the clone once, with a published journal and no forwarding obligation", async () => {
  store.recordLookedUpChat(group, "kicked", new Date(now));
  bot.handlers.getChatMember = () => ok({ status: "kicked" });
  await service.refresh();
  const visible = service.listChats().chats[0]!;
  expect(visible).toMatchObject({ member: true, postAllowed: true });
  expect(visible.bots?.[0]).toMatchObject({ name: "Report clone", canPost: true });
  expect(await send()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone", username: null } });
  expect(await send()).toMatchObject({ alreadySent: true });
  expect(sends).toHaveLength(1); expect(bot.callsOf("sendMessage")).toHaveLength(0);
  expect(store.sendRow("text:fixture-writer", "fixture-send")?.botId).toBe(`clone:${relay.id}:fixture-clone`);
  expect(await outboundState(store.filename, false, db => db.query("SELECT state FROM relay_outbound").all())).toEqual([{ state: "published" }]);
  expect(await outboundState(store.filename, false, db => db.query("SELECT * FROM relay_outbound_handoffs").all())).toEqual([]);
});
test("pairing-only clone discovery, allowlisting and idempotent send work without a stored bot token", async () => {
  fs.rmSync(telegramBotTokenPath(), { force: true });
  const calls: string[] = [];
  const deps = productionTelegramBotDependencies();
  service = new TelegramBotService({ ...deps, clones: port, openStore: () => store,
    withStoredToken: () => null, transportFor: () => { calls.push("bot-api"); return bot; },
    now: () => new Date(now), documentEnvironment: () => ({ home: root, stateDir: process.env.LLV_STATE_DIR! }) });

  const listed = service.listChats();
  expect(listed).toMatchObject({ bot: { connected: false }, chats: [expect.objectContaining({ chat: "reports", bots: [expect.objectContaining({ name: "Report clone", canPost: true })] })] });
  service.setChat(String(group.id), "reports", false);
  service.setChat(String(group.id), "reports", true);
  expect(await send()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone", username: null } });
  expect(await send()).toMatchObject({ alreadySent: true });
  expect(sends).toHaveLength(1);
  expect(calls).toEqual([]);
  expect(fs.existsSync(telegramBotTokenPath())).toBe(false);
});
test("unused-key refusal records the clone before bot fallback", async () => {
  answer = () => ({ status: 409, body: { error: { code: "clone_not_in_chat" } } });
  bot.handlers.sendMessage = () => {
    expect(store.sendRow("text:fixture-writer", "fixture-send")?.attempts[0]?.code).toBe("bot_not_in_chat");
    return ok({ message_id: 201, date: Math.floor(now / 1000) });
  };
  expect(await send()).toMatchObject({ messageIds: [201], refusals: [{ bot: { name: "Report clone" }, code: "bot_not_in_chat" }] });
  expect(sends).toHaveLength(1); expect(bot.callsOf("sendMessage")).toHaveLength(1);
});
test("cache persistence failure after clone_not_in_chat still falls back and settles the claim once", async () => {
  answer = () => ({ status: 409, body: { error: { code: "clone_not_in_chat" } } });
  const cacheFile = path.join(process.env.LLV_STATE_DIR!, "clones.json");
  fs.rmSync(cacheFile, { force: true }); fs.mkdirSync(cacheFile);
  expect(await send()).toMatchObject({ messageIds: [201], refusals: [{ bot: { name: "Report clone" }, code: "bot_not_in_chat" }] });
  expect(store.sendRow("text:fixture-writer", "fixture-send")?.state).toBe("sent");
  answer = () => ({ body: cloneReceipt(999) });
  expect(await send()).toMatchObject({ alreadySent: true, messageIds: [201] });
  expect(sends).toHaveLength(1); expect(bot.callsOf("sendMessage")).toHaveLength(1);
});
test("429 refuses with a wait, releases only the unsent claim, and the same key later sends", async () => {
  answer = () => ({ status: 429, body: { error: { code: "rate_limited", retry_after_s: 7 } } });
  await expect(send()).rejects.toMatchObject({ code: "rate_limited", message: "Celestia is rate-limiting sends; retry after 7 s", extra: { retryAfterSeconds: 7 } });
  expect(bot.callsOf("sendMessage")).toHaveLength(0);
  answer = () => ({ body: cloneReceipt() }); now += 7000;
  expect(await send()).toMatchObject({ messageIds: [101] });
  expect(sends[0]!.client_key).toBe(sends[1]!.client_key);
});
test("uncertainty stays pending and blocks bot fallback and repeated logical sends", async () => {
  answer = () => ({ status: 409, body: { error: { code: "send_uncertain" } } });
  await expect(send()).rejects.toMatchObject({ code: "send_uncertain" });
  await expect(send()).rejects.toMatchObject({ code: "send_uncertain" });
  expect(sends).toHaveLength(1); expect(bot.callsOf("sendMessage")).toHaveLength(0);
  expect(store.sendRow("text:fixture-writer", "fixture-send")?.state).toBe("pending");
});
test("multipart keys differ; a later refusal stays on the clone and reports the delivered prefix", async () => {
  answer = () => sends.length === 1 ? { body: cloneReceipt() } : { status: 403, body: { error: { code: "chat_not_allowed" } } };
  await expect(send("parts", "x".repeat(5000))).rejects.toMatchObject({ code: "send_partial", extra: { sentMessageIds: [101] } });
  expect(sends).toHaveLength(2); expect(sends[0]!.client_key).not.toBe(sends[1]!.client_key);
  expect(bot.callsOf("sendMessage")).toHaveLength(0);
});
test("bridge HTML, silent, reply and topic reach the relay; operator test posts use the same candidate", async () => {
  await service.send({ conversationId: "fixture-seat", clientRequestId: "bridge-copy", chat: "reports", text: "<b>Fixture report</b>",
    format: "html", silent: true, replyToMessageId: 17, topicId: 12 });
  expect(sends[0]).toMatchObject({ parse_mode: "HTML", silent: true, reply_to_message_id: 17, message_thread_id: 12 });
  await service.testPost("reports", "Fixture test");
  expect(sends).toHaveLength(2); expect(bot.callsOf("sendMessage")).toHaveLength(0);
});
test("assigned bots, private chats, uncovered groups and rich reviews stay on the bot", async () => {
  await service.assignBot(String(group.id), "fixture_bot"); await send("assigned");
  await service.assignBot(String(group.id), null);
  store.recordLookedUpChat({ id: 700000101, type: "private", first_name: "Fixture owner" }, "member", new Date(now));
  service.setChat("700000101", "owner", true);
  await service.send({ conversationId: null, clientRequestId: "private", chat: "owner", text: "Fixture private" });
  store.recordLookedUpChat({ ...group, id: -1000000000202 }, "member", new Date(now));
  service.setChat("-1000000000202", "other", true);
  await service.send({ conversationId: null, clientRequestId: "other", chat: "other", text: "Uncovered" });
  bot.handlers.sendRichMessage = () => ok({ message_id: 301, date: Math.floor(now / 1000) });
  await service.sendRichMessage({ clientRequestId: "review", chat: "reports", message: { markdown: "Review", images: [] } });
  expect(sends).toHaveLength(0); expect(bot.callsOf("sendMessage")).toHaveLength(3);
});
test("media and documents stay on the bot even when a clone covers the group", async () => {
  const handoff = path.join(root, "handoff"); fs.mkdirSync(handoff, { recursive: true });
  const sharp = (await import("sharp")).default;
  const photo = path.join(handoff, "fixture-frame.png"), document = path.join(handoff, "fixture-report.md");
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toFile(photo);
  fs.writeFileSync(document, "A clean fixture report.");
  bot.handlers.sendPhoto = () => ok({ message_id: 401, date: Math.floor(now / 1000) });
  bot.handlers.sendDocument = () => ok({ message_id: 402, date: Math.floor(now / 1000) });
  const common = { conversationId: "fixture-writer", chat: "reports" };
  await service.sendMedia({ ...common, clientRequestId: "photo", images: [{ path: photo, caption: "Fixture frame" }] });
  await service.sendDocument({ ...common, clientRequestId: "document", document: { path: document } });
  expect(sends).toHaveLength(0); expect(bot.callsOf("sendPhoto")).toHaveLength(1); expect(bot.callsOf("sendDocument")).toHaveLength(1);
});
test("an unsupported directory keeps the bot path unchanged", async () => {
  const route = await directory.route(String(group.id));
  directory.invalidate(route!, "unsupported");
  expect(await send()).toMatchObject({ messageIds: [201], sentBy: { name: "Fixture bot" } });
  expect(sends).toHaveLength(0);
});
test("allowlist and authority changes during lookup or HTTP preparation prevent all sends", async () => {
  service.setChat(String(group.id), "reports", false);
  await expect(send("not-allowed")).rejects.toMatchObject({ code: "chat_not_allowed" });
  service.setChat(String(group.id), "reports", true);
  const original = port.route;
  port.route = async chat => { const r = await original(chat); service.setChat(String(group.id), "reports", false); return r; };
  await expect(send("revoked-in-lookup")).rejects.toMatchObject({ code: "chat_not_allowed" });
  port.route = original; service.setChat(String(group.id), "reports", true);
  const originalSend = port.send;
  port.send = (r, input, options) => { relay.paused = true; return originalSend(r, input, options); };
  expect(await send("paused-before-emission")).toMatchObject({ messageIds: [201] });
  expect(sends).toHaveLength(0); expect(bot.callsOf("sendMessage")).toHaveLength(1);
});
