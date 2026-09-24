import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-bot-service-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramBotError, TelegramBotService, productionTelegramBotDependencies, splitMessageText } = await import("./service");
const { FakeBotTransport, fakeBotToken, ok, refused, unreachable } = await import("./fakeTransport");
const { telegramBotTokenPath } = await import("./transport");
const { statePath } = await import("@/lib/configDir");

import type { TgUpdate } from "./store";

const BOT_ID = 4242424;
const TOKEN = fakeBotToken(String(BOT_ID));
const TOKEN_TAIL = TOKEN.slice(TOKEN.indexOf(":") + 1);
const NOW = new Date("2026-09-24T12:00:00Z");
const T0 = Math.floor(NOW.getTime() / 1000) - 600;

/* Invented chats; none of these ids exists. */
const TEAM = { id: -1000000000101, type: "supergroup", title: "Team Reports" };
const LOUNGE = { id: -1000000000202, type: "supergroup", title: "Lounge" };
const GONE = { id: -1000000000303, type: "supergroup", title: "Old Project" };
const SENDER = { id: 700000505, first_name: "Person", last_name: "B" };

let transport: InstanceType<typeof FakeBotTransport>;
let tokensSeen: string[];
let sleeps: number[];
let service: InstanceType<typeof TelegramBotService>;

function me(overrides: Record<string, unknown> = {}) {
  return ok({ id: BOT_ID, is_bot: true, first_name: "Report Bot", username: "report_test_bot", can_join_groups: true, can_read_all_group_messages: false, ...overrides });
}

function newService() {
  return new TelegramBotService({
    ...productionTelegramBotDependencies(),
    transportFor: (token) => {
      tokensSeen.push(token);
      return transport;
    },
    now: () => NOW,
    sleep: async (ms) => { sleeps.push(ms); },
    conversationTitle: (id) => (id === "conversation_writer" ? "Weekly report writer" : null),
  });
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  transport = new FakeBotTransport();
  tokensSeen = [];
  sleeps = [];
  service = newService();
});
afterEach(async () => {
  await service.remove();
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** Connects, then feeds one batch through the poller's own path. */
async function connectWithChats(updates: TgUpdate[]) {
  transport.script("getMe", me());
  await service.connect(TOKEN);
  await service.stopPoller();
  transport.script("getUpdates", ok(updates));
  expect(await service.pollOnce(new AbortController().signal)).toEqual({ next: "continue", delayMs: 0 });
}

const joined = (chat: object, updateId: number, status = "member"): TgUpdate =>
  ({ update_id: updateId, my_chat_member: { chat: chat as never, date: T0, new_chat_member: { status } } });
const said = (chat: object, updateId: number, messageId: number, text = `message ${messageId}`): TgUpdate =>
  ({ update_id: updateId, message: { message_id: messageId, date: T0 + messageId, chat: chat as never, from: SENDER, text } });

async function refusal(run: () => Promise<unknown> | unknown): Promise<InstanceType<typeof TelegramBotError>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TelegramBotError) return error;
    throw error;
  }
  throw new Error("expected a TelegramBotError");
}

/* ---- connect / remove ----------------------------------------------------- */

test("connect validates the token's shape before any network call", async () => {
  const error = await refusal(() => service.connect("12345:short"));
  expect(error.code).toBe("invalid_token");
  expect(tokensSeen).toEqual([]);
  expect(transport.calls).toEqual([]);
});

test("connect requires a bot, stores the token owner-only, and never returns it", async () => {
  transport.script("getMe", me({ is_bot: false }));
  expect((await refusal(() => service.connect(TOKEN))).code).toBe("not_a_bot");
  expect(fs.existsSync(telegramBotTokenPath())).toBe(false);

  transport.script("getMe", me());
  const status = await service.connect(TOKEN);
  expect(status).toMatchObject({ connected: true, bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false }, receiving: "polling" });
  expect(service.pollerRunning()).toBe(true);
  expect(fs.statSync(telegramBotTokenPath()).mode & 0o777).toBe(0o600);
  expect(fs.statSync(statePath("telegram", "bot.sqlite")).mode & 0o777).toBe(0o600);
  const serialized = JSON.stringify(status) + JSON.stringify(service.listChats());
  expect(serialized).not.toContain(TOKEN_TAIL);
  expect(serialized).not.toContain(String(BOT_ID));
});

test("a webhook set elsewhere is never deleted: the bot connects, posts, and says reading is blocked", async () => {
  transport.script("getMe", me());
  transport.script("getWebhookInfo", ok({ url: "https://example.invalid/hook" }));
  const status = await service.connect(TOKEN);
  expect(status.receiving).toBe("webhook_elsewhere");
  expect(service.pollerRunning()).toBe(false);
  expect(transport.callsOf("deleteWebhook")).toEqual([]);
  service.ensurePoller();
  expect(service.pollerRunning()).toBe(false);
});

test("a token for the same bot replaces the stored one and keeps the chats; a different bot is refused", async () => {
  await connectWithChats([joined(TEAM, 1)]);
  service.setChat(String(TEAM.id), "team-reports", true);
  transport.script("getMe", me());
  const replaced = await service.connect(fakeBotToken(String(BOT_ID)).replace("fake", "next"));
  expect(replaced.chats).toMatchObject([{ alias: "team-reports", postAllowed: true }]);

  transport.script("getMe", me({ id: 5151515 }));
  expect((await refusal(() => service.connect(fakeBotToken("5151515")))).code).toBe("bot_already_connected");
});

test("remove aborts the poller and deletes the token and the store", async () => {
  transport.script("getMe", me());
  await service.connect(TOKEN);
  expect(service.pollerRunning()).toBe(true);
  const status = await service.remove();
  expect(status).toMatchObject({ connected: false, chats: [] });
  expect(service.pollerRunning()).toBe(false);
  expect(fs.existsSync(telegramBotTokenPath())).toBe(false);
  expect(fs.readdirSync(statePath("telegram")).filter((name) => name.startsWith("bot"))).toEqual([]);
});

/* ---- intake ---------------------------------------------------------------- */

test("the poller advances Telegram's offset only past committed batches and asks its own status in new groups", async () => {
  transport.script("getMe", me());
  await service.connect(TOKEN);
  await service.stopPoller();
  transport.script("getUpdates", ok([said(TEAM, 7, 1), said(TEAM, 9, 2)]));
  transport.script("getChatMember", ok({ status: "administrator" }));
  await service.pollOnce(new AbortController().signal);
  expect(transport.callsOf("getChatMember").map((call) => call.params)).toEqual([{ chat_id: TEAM.id, user_id: BOT_ID }]);
  transport.script("getUpdates", ok([]));
  await service.pollOnce(new AbortController().signal);
  const polls = transport.callsOf("getUpdates").map((call) => call.params.offset);
  expect(polls.slice(-2)).toEqual([undefined, 10]);
  const chat = service.listChats().chats[0]!;
  expect(chat).toMatchObject({ title: "Team Reports", seesAllMessages: true, storedMessages: 2, postAllowed: false });
});

test("the receiving state machine: webhook, another reader, rejected token, rate limit, network", async () => {
  transport.script("getMe", me());
  await service.connect(TOKEN);
  await service.stopPoller();
  const poll = () => service.pollOnce(new AbortController().signal);

  transport.script("getUpdates", refused(409, "Conflict: can't use getUpdates method while webhook is active"));
  transport.script("getWebhookInfo", ok({ url: "https://example.invalid/hook" }));
  expect(await poll()).toEqual({ next: "stop" });
  expect(service.listChats().bot.receiving).toBe("webhook_elsewhere");

  transport.script("getUpdates", refused(409, "Conflict: terminated by other getUpdates request"));
  expect(await poll()).toEqual({ next: "continue", delayMs: 30_000 });
  expect(service.status().receiving).toBe("stopped");

  transport.script("getUpdates", refused(429, "Too Many Requests", { retryAfterSeconds: 3 }));
  expect(await poll()).toEqual({ next: "continue", delayMs: 3000 });

  transport.script("getUpdates", unreachable(), unreachable());
  expect(await poll()).toEqual({ next: "continue", delayMs: 5000 });
  expect(await poll()).toEqual({ next: "continue", delayMs: 10_000 });

  transport.script("getUpdates", refused(401, "Unauthorized"));
  expect(await poll()).toEqual({ next: "stop" });
  expect(service.status().receiving).toBe("token_rejected");
});

test("a running poller stops for good on a rejected token until the operator acts", async () => {
  transport.handlers.getUpdates = () => refused(401, "Unauthorized");
  transport.script("getMe", me());
  await service.connect(TOKEN);
  for (let attempt = 0; attempt < 20 && service.pollerRunning(); attempt += 1) await Bun.sleep(1);
  expect(service.pollerRunning()).toBe(false);
  service.ensurePoller();
  expect(service.pollerRunning()).toBe(false);
  expect(service.status().receiving).toBe("token_rejected");
});

/* ---- the allowlist -------------------------------------------------------- */

test("allowlist refusal: unknown chat, no alias, not allowed, left chat — and no transport call in any of them", async () => {
  await connectWithChats([joined(TEAM, 1), joined(LOUNGE, 2), joined(GONE, 3, "member")]);
  service.setChat(String(LOUNGE.id), "lounge", false);
  service.setChat(String(GONE.id), "old-project", true);
  transport.script("getUpdates", ok([joined(GONE, 4, "kicked")]));
  await service.pollOnce(new AbortController().signal);
  const before = transport.callsOf("sendMessage").length;

  const send = (chat: string) => service.send({ conversationId: "conversation_writer", clientRequestId: `req-${chat}`, chat, text: "hello" });
  const unknown = await refusal(() => send("nowhere"));
  expect(unknown.code).toBe("chat_unknown");
  expect(unknown.message).toContain("telegram_bot_chats");
  const noAlias = await refusal(() => send(String(TEAM.id)));
  expect(noAlias.code).toBe("chat_not_allowed");
  expect(noAlias.message).toContain("Team Reports");
  const off = await refusal(() => send("lounge"));
  expect(off.code).toBe("chat_not_allowed");
  expect(off.message).toContain("Telegram panel");
  const left = await refusal(() => send("old-project"));
  expect(left.code).toBe("bot_not_in_chat");
  expect(left.retryable).toBe(false);

  expect(transport.callsOf("sendMessage").length).toBe(before);
  const listed = service.listChats({ includeInactive: true }).chats;
  expect(listed.find((chat) => chat.chat === "lounge")).toMatchObject({ postAllowed: false, postRefusal: expect.stringContaining("not allowed posting") });
  expect(listed.find((chat) => chat.chat === "old-project")).toMatchObject({ member: false, postAllowed: false });
  expect(service.listChats().chats.map((chat) => chat.chat)).not.toContain("old-project");
});

test("with no bot connected the reads answer honestly and the send is refused", async () => {
  expect(service.listChats()).toMatchObject({ bot: { connected: false }, chats: [], note: expect.stringContaining("Telegram") });
  expect(service.listChats().limits).toHaveLength(3);
  expect((await refusal(() => service.send({ conversationId: null, clientRequestId: "x", chat: "a", text: "b" }))).code).toBe("bot_not_connected");
  expect((await refusal(() => service.readMessages({ chat: "a" }))).code).toBe("bot_not_connected");
});

/* ---- send attribution and idempotency ------------------------------------ */

async function allowedTeam() {
  await connectWithChats([joined(TEAM, 1), said(TEAM, 2, 1)]);
  service.setChat(String(TEAM.id), "team-reports", true);
}

test("send attribution: the caller's conversation lands on the send, the outgoing message and the chat", async () => {
  await allowedTeam();
  transport.script("sendMessage", ok({ message_id: 50, date: T0 + 100 }));
  const answer = await service.send({ conversationId: "conversation_writer", clientRequestId: "req-1", chat: "team-reports", text: "Weekly report", topicId: 3, replyToMessageId: 1, silent: true });
  expect(answer).toMatchObject({ chat: "team-reports", chatId: String(TEAM.id), messageIds: [50], attributedTo: { conversationId: "conversation_writer" }, parts: 1, alreadySent: false });
  expect(transport.callsOf("sendMessage")[0]!.params).toEqual({
    chat_id: TEAM.id, text: "Weekly report", reply_parameters: { message_id: 1, allow_sending_without_reply: true }, message_thread_id: 3, disable_notification: true,
  });
  const read = service.readMessages({ chat: "team-reports" });
  expect(read.messages[0]).toMatchObject({ messageId: 50, direction: "out", from: null, text: "Weekly report", sentBy: { conversationId: "conversation_writer" }, topicId: 3 });
  expect(read.messages[1]).toMatchObject({ messageId: 1, direction: "in", sentBy: null, from: { name: "Person B" } });
  expect(service.status().chats[0]!.lastPostBy).toEqual({ conversationId: "conversation_writer", title: "Weekly report writer" });

  transport.script("sendMessage", ok({ message_id: 51, date: T0 + 101 }));
  const anonymous = await service.send({ conversationId: null, clientRequestId: "req-1", chat: "team-reports", text: "From outside" });
  expect(anonymous.attributedTo).toEqual({ unidentified: true });
  expect(service.readMessages({ chat: "team-reports" }).messages[0]!.sentBy).toEqual({ unidentified: true });
  expect(service.status().chats[0]!.lastPostBy).toEqual({ unidentified: true });
});

test("a repeated clientRequestId answers the first post and never posts again; an unfinished one is uncertain", async () => {
  await allowedTeam();
  transport.script("sendMessage", ok({ message_id: 60, date: T0 + 100 }));
  const first = await service.send({ conversationId: "conversation_writer", clientRequestId: "req-once", chat: "team-reports", text: "once" });
  const again = await service.send({ conversationId: "conversation_writer", clientRequestId: "req-once", chat: "team-reports", text: "once" });
  expect(again).toMatchObject({ messageIds: first.messageIds, alreadySent: true });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);

  /* A send whose process died mid-flight leaves a pending row. */
  let release: (value: never) => void = () => {};
  transport.handlers.sendMessage = () => new Promise((resolve) => { release = resolve as never; });
  const hanging = service.send({ conversationId: "conversation_writer", clientRequestId: "req-hang", chat: "team-reports", text: "hang" });
  await Bun.sleep(1);
  const uncertain = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-hang", chat: "team-reports", text: "hang" }));
  expect(uncertain.code).toBe("send_uncertain");
  expect(transport.callsOf("sendMessage")).toHaveLength(2);
  release(ok({ message_id: 61, date: T0 + 101 }) as never);
  await hanging;
});

test("a send Telegram did not answer in time stays uncertain and is never posted again under its key", async () => {
  await allowedTeam();
  transport.script("sendMessage", unreachable("timed_out"));
  const timedOut = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-slow", chat: "team-reports", text: "slow" }));
  expect(timedOut.code).toBe("send_uncertain");
  expect(timedOut.retryable).toBe(false);
  const again = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-slow", chat: "team-reports", text: "slow" }));
  expect(again.code).toBe("send_uncertain");
  expect(transport.callsOf("sendMessage")).toHaveLength(1);

  /* Unreachable means nothing went out, so the same key may try again. */
  transport.script("sendMessage", unreachable("network_failed"));
  expect((await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-down", chat: "team-reports", text: "down" }))).code).toBe("network_failed");
  transport.script("sendMessage", ok({ message_id: 62, date: T0 + 102 }));
  expect(await service.send({ conversationId: "conversation_writer", clientRequestId: "req-down", chat: "team-reports", text: "down" })).toMatchObject({ messageIds: [62], alreadySent: false });
});

test("long plain text is split into at most four parts; only the first replies; html is never split", async () => {
  await allowedTeam();
  let id = 70;
  transport.handlers.sendMessage = () => ok({ message_id: id++, date: T0 });
  const paragraph = `${"x".repeat(3000)}\n\n`;
  const answer = await service.send({ conversationId: "conversation_writer", clientRequestId: "req-long", chat: "team-reports", text: paragraph.repeat(4), replyToMessageId: 1, topicId: 5 });
  expect(answer.parts).toBe(4);
  const calls = transport.callsOf("sendMessage");
  expect(calls.map((call) => (call.params.text as string).length)).toEqual([3000, 3000, 3000, 3000]);
  expect(calls.map((call) => "reply_parameters" in call.params)).toEqual([true, false, false, false]);
  expect(calls.every((call) => call.params.message_thread_id === 5)).toBe(true);

  expect(splitMessageText("y".repeat(5000), "plain").map((part) => part.length)).toEqual([4096, 904]);
  expect((await refusal(() => service.send({ conversationId: null, clientRequestId: "req-huge", chat: "team-reports", text: "z".repeat(16_385) }))).code).toBe("text_too_long");
  expect((await refusal(() => service.send({ conversationId: null, clientRequestId: "req-html", chat: "team-reports", text: `<b>${"z".repeat(4100)}</b>`, format: "html" }))).code).toBe("text_too_long");
  expect((await refusal(() => service.send({ conversationId: null, clientRequestId: "req-empty", chat: "team-reports", text: "   " }))).code).toBe("text_empty");
});

test("Telegram's refusals map to codes: 403 forbidden, 429 rate_limited, entity errors format_invalid", async () => {
  await allowedTeam();
  transport.script("sendMessage", refused(403, "Forbidden: bot was kicked from the supergroup chat"));
  const forbidden = await refusal(() => service.send({ conversationId: null, clientRequestId: "r1", chat: "team-reports", text: "a" }));
  expect(forbidden).toMatchObject({ code: "forbidden", retryable: false });
  expect(forbidden.message).toContain("never wrote to it");

  transport.script("sendMessage", refused(429, "Too Many Requests: retry after 9", { retryAfterSeconds: 9 }));
  const limited = await refusal(() => service.send({ conversationId: null, clientRequestId: "r2", chat: "team-reports", text: "a" }));
  expect(limited).toMatchObject({ code: "rate_limited", retryable: true, extra: { retryAfterSeconds: 9 } });

  transport.script("sendMessage", refused(400, "Bad Request: can't parse entities: Unsupported start tag \"x\""));
  expect((await refusal(() => service.send({ conversationId: null, clientRequestId: "r3", chat: "team-reports", text: "<x>a</x>", format: "html" }))).code).toBe("format_invalid");
  expect(transport.callsOf("sendMessage").at(-1)!.params.parse_mode).toBe("HTML");

  /* A failed key may be retried: nothing was posted under it. */
  transport.script("sendMessage", ok({ message_id: 90, date: T0 }));
  expect((await service.send({ conversationId: null, clientRequestId: "r2", chat: "team-reports", text: "a" })).messageIds).toEqual([90]);
});

test("a group upgraded under a send moves the chat and retries once at the new id", async () => {
  await allowedTeam();
  const NEW_ID = "-1000000000909";
  transport.script("sendMessage", refused(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrateToChatId: NEW_ID }), ok({ message_id: 3, date: T0 }));
  const answer = await service.send({ conversationId: "conversation_writer", clientRequestId: "r-migrate", chat: "team-reports", text: "a" });
  expect(answer).toMatchObject({ chat: "team-reports", chatId: NEW_ID, messageIds: [3] });
  expect(transport.callsOf("sendMessage").map((call) => call.params.chat_id)).toEqual([TEAM.id, Number(NEW_ID)]);
});

test("a failure after some parts were posted names them and refuses a blind retry", async () => {
  await allowedTeam();
  transport.script("sendMessage", ok({ message_id: 80, date: T0 + 1000 }), refused(429, "Too Many Requests", { retryAfterSeconds: 2 }));
  const partial = await refusal(() => service.send({ conversationId: null, clientRequestId: "r-part", chat: "team-reports", text: `${"p".repeat(4000)}\n${"q".repeat(4000)}` }));
  expect(partial).toMatchObject({ code: "send_partial", extra: { sentMessageIds: [80] } });
  expect(service.readMessages({ chat: "team-reports" }).messages[0]!.messageId).toBe(80);
  const sends = transport.callsOf("sendMessage").length;
  const retry = await refusal(() => service.send({ conversationId: null, clientRequestId: "r-part", chat: "team-reports", text: "anything" }));
  expect(retry).toMatchObject({ code: "send_partial", extra: { sentMessageIds: [80] } });
  expect(transport.callsOf("sendMessage")).toHaveLength(sends);
});

test("reads are bounded and clamped, and every answer carries the limits", async () => {
  await connectWithChats(Array.from({ length: 30 }, (_, index) => said(LOUNGE, index + 1, index + 1)));
  const page = service.readMessages({ chat: String(LOUNGE.id), limit: 500, maxChars: 0 });
  expect(page.messages).toHaveLength(30);
  expect(page.messages[0]).toMatchObject({ messageId: 30, text: "m", truncated: true });
  expect(page.limits).toHaveLength(3);
  expect(page.chat).toMatchObject({ chat: String(LOUNGE.id), seesAllMessages: false, visibilityNote: expect.stringContaining("privacy mode is on") });
  const defaults = service.readMessages({ chat: String(LOUNGE.id) });
  expect(defaults.messages).toHaveLength(20);
  expect(defaults.hasMore).toBe(true);
  expect(service.readMessages({ chat: String(LOUNGE.id), cursor: defaults.nextCursor! }).messages.map((row) => row.messageId)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("privacy turned off after the bot joined a group asks for a re-add until the bot is admin", async () => {
  await connectWithChats([joined(LOUNGE, 1)]);
  transport.script("getMe", me({ can_read_all_group_messages: true }));
  const later = new TelegramBotService({
    ...productionTelegramBotDependencies(),
    transportFor: () => transport,
    now: () => new Date(NOW.getTime() + 60_000),
    sleep: async () => {},
    conversationTitle: () => null,
  });
  await later.refresh();
  await later.stopPoller();
  expect(later.status().chats[0]).toMatchObject({ seesAllMessages: false, readdToApply: true });
  transport.script("getUpdates", ok([joined(LOUNGE, 2, "administrator")]));
  await later.pollOnce(new AbortController().signal);
  expect(later.status().chats[0]).toMatchObject({ seesAllMessages: true, readdToApply: false });
});
