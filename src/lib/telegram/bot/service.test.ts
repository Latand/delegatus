import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-bot-service-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramBotError, TelegramBotService, productionTelegramBotDependencies, splitMessageText } = await import("./service");
const { FakeBotTransport, fakeBotToken, ok, refused, unreachable } = await import("./fakeTransport");
const { createBotApiTransport, telegramBotTokenPath } = await import("./transport");
const { statePath } = await import("@/lib/configDir");
const { documentBytesSecret, documentSecret } = await import("./documents");
const { retainProviderRedactionSecrets } = await import("@/lib/accounts/providerSecretRedaction");

import type { TgUpdate } from "./store";

const BOT_ID = 4242424;
const TOKEN = fakeBotToken(String(BOT_ID));
const TOKEN_TAIL = TOKEN.slice(TOKEN.indexOf(":") + 1);
const NOW = new Date("2026-09-24T12:00:00Z");
const T0 = Math.floor(NOW.getTime() / 1000) - 600;

/* The Viewer host's home for document roots: a sandbox, never the real one. */
const HOME = path.join(SANDBOX, "home");
const HANDOFF = path.join(HOME, "handoff");

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
    documentEnvironment: () => ({ home: HOME, stateDir: process.env.LLV_STATE_DIR! }),
  });
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "elsewhere"), { recursive: true, force: true });
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

/* Photos follow the document roots, so fixtures live under the default one. */
function mediaFile(name: string, bytes: Uint8Array, directory = HANDOFF): string {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

async function validImage(name: string, format: "jpeg" | "png", width = 1, height = 1, directory = HANDOFF): Promise<string> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } })[format]().toBuffer();
  return mediaFile(name, bytes, directory);
}

/* A PNG signature alone: enough for the roots and the document type class,
   never a decodable photo. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0]);

test("media validates every local image before any Telegram call and refuses disallowed chats", async () => {
  await allowedTeam();
  const good = await validImage("valid.jpg", "jpeg");
  const bad = mediaFile("invalid.jpg", Uint8Array.from([1, 2, 3]));
  const send = (images: unknown, chat = "team-reports") => service.sendMedia({ conversationId: "conversation_writer", clientRequestId: "validate", chat, images });
  expect((await refusal(() => send([{ path: good, caption: "ok" }], "unknown"))).code).toBe("chat_unknown");
  expect((await refusal(() => send([{ path: good, caption: "ok" }, { path: bad, caption: "bad" }]))).code).toBe("photo_invalid");
  expect((await refusal(() => send([{ path: good, caption: "ok" }, { path: "relative.jpg", caption: "bad" }]))).code).toBe("photo_invalid");
  expect((await refusal(() => send([{ path: good, caption: "x".repeat(1025) }]))).code).toBe("text_too_long");
  const large = mediaFile("large.jpg", new Uint8Array(10 * 1024 * 1024 + 1));
  expect((await refusal(() => send([{ path: large, caption: "large" }]))).code).toBe("photo_invalid");
  expect(transport.callsOf("sendPhoto")).toHaveLength(0);
  expect(transport.callsOf("sendMediaGroup")).toHaveLength(0);
});

test("media rejects truncated, excessive-dimension and extreme-aspect images before single or album transport", async () => {
  await allowedTeam();
  const valid = await validImage("dimension-valid.png", "png");
  const truncated = mediaFile("truncated.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  const tooWide = await validImage("aspect.png", "png", 21, 1);
  const tooLarge = await validImage("dimensions.png", "png", 6000, 4001);
  const rejected = (clientRequestId: string, images: Array<{ path: string; caption: string }>) => refusal(() => service.sendMedia({
    conversationId: "conversation_writer", clientRequestId, chat: "team-reports", images,
  }));

  for (const [id, filename] of [["truncated", truncated], ["aspect", tooWide], ["dimensions", tooLarge]] as const) {
    expect((await rejected(id, [{ path: filename, caption: "invalid" }])).code).toBe("photo_invalid");
  }
  expect((await rejected("album-invalid", [{ path: valid, caption: "valid" }, { path: tooWide, caption: "invalid" }])).code).toBe("photo_invalid");
  expect(transport.callsOf("sendPhoto")).toHaveLength(0);
  expect(transport.callsOf("sendMediaGroup")).toHaveLength(0);
});

test("one photo uses sendPhoto, attributes its receipt and stores an outgoing photo", async () => {
  await allowedTeam();
  const filename = await validImage("single.jpg", "jpeg");
  transport.script("sendPhoto", ok({ message_id: 70, date: T0 + 100 }));
  const input = { conversationId: "conversation_writer", clientRequestId: "one", chat: "team-reports", images: [{ path: filename, caption: "<b>Step 1</b>" }], format: "html", topicId: 3, replyToMessageId: 1, silent: true };
  expect(await service.sendMedia(input)).toMatchObject({ messageIds: [70], attributedTo: { conversationId: "conversation_writer" }, alreadySent: false });
  expect(transport.callsOf("sendPhoto")[0]!.params).toMatchObject({ chat_id: TEAM.id, caption: "<b>Step 1</b>", parse_mode: "HTML", message_thread_id: 3, reply_parameters: { message_id: 1 }, disable_notification: true, photo: expect.any(Blob) });
  expect(service.readMessages({ chat: "team-reports" }).messages[0]).toMatchObject({ messageId: 70, direction: "out", kind: "photo", text: "<b>Step 1</b>", sentBy: { conversationId: "conversation_writer" }, topicId: 3 });
  expect(await service.sendMedia(input)).toMatchObject({ messageIds: [70], alreadySent: true });
  expect(transport.callsOf("sendPhoto")).toHaveLength(1);
});

test("album sends per-image captions once and an unfinished claim replays send_uncertain", async () => {
  await allowedTeam();
  const images = [{ path: await validImage("first.jpg", "jpeg"), caption: "First" }, { path: await validImage("second.png", "png"), caption: "Second" }];
  const input = { conversationId: "conversation_writer", clientRequestId: "album", chat: "team-reports", images, topicId: 5 };
  transport.script("sendMediaGroup", ok([{ message_id: 80, date: T0 + 100 }, { message_id: 81, date: T0 + 101 }]));
  expect(await service.sendMedia(input)).toMatchObject({ messageIds: [80, 81], parts: 2, alreadySent: false });
  const params = transport.callsOf("sendMediaGroup")[0]!.params;
  expect(JSON.parse(params.media as string)).toEqual([{ type: "photo", media: "attach://photo0", caption: "First" }, { type: "photo", media: "attach://photo1", caption: "Second" }]);
  expect(params).toMatchObject({ chat_id: TEAM.id, message_thread_id: 5, photo0: expect.any(Blob), photo1: expect.any(Blob) });
  expect(service.readMessages({ chat: "team-reports" }).messages.slice(0, 2)).toMatchObject([{ direction: "out", kind: "photo", text: "Second" }, { direction: "out", kind: "photo", text: "First" }]);
  expect(await service.sendMedia(input)).toMatchObject({ messageIds: [80, 81], alreadySent: true });

  transport.script("sendMediaGroup", unreachable("timed_out"));
  const uncertainInput = { ...input, clientRequestId: "uncertain" };
  expect((await refusal(() => service.sendMedia(uncertainInput))).code).toBe("send_uncertain");
  expect((await refusal(() => service.sendMedia(uncertainInput))).code).toBe("send_uncertain");
  expect(transport.callsOf("sendMediaGroup")).toHaveLength(2);
});

test("a truncated HTTP success stays pending across a service restart", async () => {
  await allowedTeam();
  await service.stopPoller();
  Reflect.get(service, "storeCache")?.close();

  let httpCalls = 0;
  const dependencies = {
    ...productionTelegramBotDependencies(),
    transportFor: () => createBotApiTransport(TOKEN, async () => {
      httpCalls += 1;
      return new Response('{"ok":true,"result":[', { status: 200 });
    }),
    now: () => NOW,
    sleep: async () => {},
    conversationTitle: () => "Weekly report writer",
    documentEnvironment: () => ({ home: HOME, stateDir: process.env.LLV_STATE_DIR! }),
  };
  const input = {
    conversationId: "conversation_writer",
    clientRequestId: "truncated-body",
    chat: "team-reports",
    images: [{ path: await validImage("truncated-response.jpg", "jpeg"), caption: "Step" }],
  };

  service = new TelegramBotService(dependencies);
  expect((await refusal(() => service.sendMedia(input))).code).toBe("send_uncertain");
  expect(httpCalls).toBe(1);
  Reflect.get(service, "storeCache")?.close();

  service = new TelegramBotService(dependencies);
  const retry = await refusal(() => service.sendMedia(input));
  expect(retry.code).toBe("send_uncertain");
  expect(retry.retryable).toBe(false);
  expect(httpCalls).toBe(1);
});

test("text and media receipts use separate namespaces for both call orders and prefixed user keys", async () => {
  await allowedTeam();
  const image = await validImage("collision.jpg", "jpeg");
  transport.script("sendMessage", ok({ message_id: 90, date: T0 + 100 }));
  const textFirst = await service.send({ conversationId: "conversation_writer", clientRequestId: "media:album", chat: "team-reports", text: "text first" });
  transport.script("sendMediaGroup", ok([{ message_id: 91, date: T0 + 101 }, { message_id: 92, date: T0 + 102 }]));
  const albumSecond = await service.sendMedia({ conversationId: "conversation_writer", clientRequestId: "album", chat: "team-reports", images: [{ path: image, caption: "One" }, { path: image, caption: "Two" }] });
  expect(textFirst.messageIds).toEqual([90]);
  expect(albumSecond.messageIds).toEqual([91, 92]);
  expect((await service.send({ conversationId: "conversation_writer", clientRequestId: "media:album", chat: "team-reports", text: "text first" })).messageIds).toEqual([90]);
  expect((await service.sendMedia({ conversationId: "conversation_writer", clientRequestId: "album", chat: "team-reports", images: [{ path: image, caption: "One" }, { path: image, caption: "Two" }] })).messageIds).toEqual([91, 92]);

  transport.script("sendMediaGroup", ok([{ message_id: 93, date: T0 + 103 }, { message_id: 94, date: T0 + 104 }]));
  const prefixedMedia = await service.sendMedia({ conversationId: "conversation_other", clientRequestId: "media:album", chat: "team-reports", images: [{ path: image, caption: "A" }, { path: image, caption: "B" }] });
  transport.script("sendMessage", ok({ message_id: 95, date: T0 + 105 }));
  const textSecond = await service.send({ conversationId: "conversation_other", clientRequestId: "media:album", chat: "team-reports", text: "text second" });
  expect(prefixedMedia.messageIds).toEqual([93, 94]);
  expect(textSecond.messageIds).toEqual([95]);
  expect(transport.callsOf("sendMessage")).toHaveLength(2);
  expect(transport.callsOf("sendMediaGroup")).toHaveLength(2);
});

test("a photo must come from under the document roots, like a document", async () => {
  await allowedTeam();
  const send = (images: unknown, clientRequestId = "rooted") => service.sendMedia({ conversationId: "conversation_writer", clientRequestId, chat: "team-reports", images });
  const code = async (filename: string) => (await refusal(() => send([{ path: filename, caption: "" }]))).code;
  const outside = await validImage("shot.png", "png", 1, 1, path.join(SANDBOX, "elsewhere"));
  expect(await code(outside)).toBe("document_outside_roots");
  expect(await code(mediaFile("qr.png", PNG, path.join(HANDOFF, ".cache")))).toBe("document_forbidden_path");
  fs.symlinkSync(outside, path.join(HANDOFF, "linked.png"));
  expect(await code(path.join(HANDOFF, "linked.png"))).toBe("document_outside_roots");
  /* A root that contains the state directory still never reaches into it. */
  service.setDocumentRoots([SANDBOX]);
  expect(await code(mediaFile("screen.png", PNG, process.env.LLV_STATE_DIR!))).toBe("document_forbidden_path");
  expect(transport.callsOf("sendPhoto")).toHaveLength(0);
  /* The same file sends once the operator makes its folder a root. */
  service.setDocumentRoots([path.join(SANDBOX, "elsewhere")]);
  transport.script("sendPhoto", ok({ message_id: 71, date: T0 + 100 }));
  expect((await send([{ path: outside, caption: "" }], "rooted-2")).messageIds).toEqual([71]);
});

/* ---- documents ------------------------------------------------------------ */

function documentFile(filename: string, content: string | Uint8Array): string {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
}

const REPORT = "# Weekly report\n\nAll lanes green; see the table below.\n\n| lane | state |\n| --- | --- |\n| one | merged |\n";
/* Secret-shaped values assembled at runtime, so no source line carries one. */
const PRIVATE_KEY = ["-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", "b3BlbnNzaC1rZXktdjEAAAAA\n", "-----END OPENSSH ", "PRIVATE KEY-----\n"].join("");
const FORGE_TOKEN = ["gh", "p_", "Fx7".repeat(12)].join("");

function sendDocument(document: unknown, extra: Record<string, unknown> = {}) {
  return service.sendDocument({ conversationId: "conversation_writer", clientRequestId: "doc", chat: "team-reports", document, ...extra });
}

test("a document receipt has its own namespace: the same key under text, photo and document posts three times", async () => {
  await allowedTeam();
  const report = documentFile(path.join(HANDOFF, "shared-key.md"), REPORT);
  const image = await validImage("shared-key.jpg", "jpeg");
  transport.script("sendMessage", ok({ message_id: 110, date: T0 + 100 }));
  transport.script("sendPhoto", ok({ message_id: 111, date: T0 + 101 }));
  transport.script("sendDocument", ok({ message_id: 112, date: T0 + 102 }));
  const text = { conversationId: "conversation_writer", clientRequestId: "shared", chat: "team-reports", text: "note" };
  const photo = { conversationId: "conversation_writer", clientRequestId: "shared", chat: "team-reports", images: [{ path: image, caption: "" }] };
  expect((await service.send(text)).messageIds).toEqual([110]);
  expect((await service.sendMedia(photo)).messageIds).toEqual([111]);
  expect((await sendDocument({ path: report }, { clientRequestId: "shared" })).messageIds).toEqual([112]);
  /* Each replays its own receipt, and a text key shaped like the old prefix reaches no document. */
  expect(await sendDocument({ path: report }, { clientRequestId: "shared" })).toMatchObject({ messageIds: [112], alreadySent: true });
  expect(await service.send(text)).toMatchObject({ messageIds: [110], alreadySent: true });
  transport.script("sendMessage", ok({ message_id: 113, date: T0 + 103 }));
  expect(await service.send({ ...text, clientRequestId: "document:shared" })).toMatchObject({ messageIds: [113], alreadySent: false });
  expect(transport.callsOf("sendDocument")).toHaveLength(1);
});

test("a document under the default root goes out as multipart sendDocument, is stored with its filename, and replays", async () => {
  await allowedTeam();
  const report = documentFile(path.join(HANDOFF, "weekly.md"), REPORT);
  transport.script("sendDocument", ok({ message_id: 90, date: T0 + 100 }));
  const input = { conversationId: "conversation_writer", clientRequestId: "doc-1", chat: "team-reports", document: { path: report, filename: "Weekly report.md", caption: "<b>Week 39</b>" }, format: "html", topicId: 3, replyToMessageId: 1, silent: true };
  expect(await service.sendDocument(input)).toMatchObject({ chat: "team-reports", messageIds: [90], parts: 1, attributedTo: { conversationId: "conversation_writer" }, alreadySent: false });
  const params = transport.callsOf("sendDocument")[0]!.params;
  expect(params).toMatchObject({ chat_id: TEAM.id, caption: "<b>Week 39</b>", parse_mode: "HTML", message_thread_id: 3, reply_parameters: { message_id: 1 }, disable_notification: true });
  const file = params.document as File;
  expect(file).toBeInstanceOf(File);
  expect(file.name).toBe("Weekly report.md");
  expect(file.type).toStartWith("text/markdown");
  expect(await file.text()).toBe(REPORT);
  expect(service.readMessages({ chat: "team-reports" }).messages[0]).toMatchObject({ messageId: 90, direction: "out", kind: "document", text: "<b>Week 39</b>", filename: "Weekly report.md", sentBy: { conversationId: "conversation_writer" }, topicId: 3 });
  expect(service.status().chats[0]!.lastPostBy).toEqual({ conversationId: "conversation_writer", title: "Weekly report writer" });

  expect(await service.sendDocument(input)).toMatchObject({ messageIds: [90], alreadySent: true });
  expect(transport.callsOf("sendDocument")).toHaveLength(1);
  /* The key space is the document tool's own: the same id on the text tool posts. */
  transport.script("sendMessage", ok({ message_id: 91, date: T0 + 101 }));
  expect(await service.send({ conversationId: "conversation_writer", clientRequestId: "doc-1", chat: "team-reports", text: "x" })).toMatchObject({ messageIds: [91], alreadySent: false });
});

test("the shown filename defaults to the file's own name and a caption is optional", async () => {
  await allowedTeam();
  const pdf = documentFile(path.join(HANDOFF, "q3", "summary.pdf"), "%PDF-1.7\n%fixture\n");
  transport.script("sendDocument", ok({ message_id: 92, date: T0 + 100 }));
  await sendDocument({ path: pdf });
  const params = transport.callsOf("sendDocument")[0]!.params;
  expect((params.document as File).name).toBe("summary.pdf");
  expect((params.document as File).type).toBe("application/pdf");
  expect(params).not.toHaveProperty("caption");
  expect(params).not.toHaveProperty("parse_mode");
  expect(service.readMessages({ chat: "team-reports" }).messages[0]).toMatchObject({ kind: "document", text: null, filename: "summary.pdf" });
});

test("every file refusal lands before Telegram is called, with its own code", async () => {
  await allowedTeam();
  const good = documentFile(path.join(HANDOFF, "good.md"), REPORT);
  const outside = documentFile(path.join(SANDBOX, "elsewhere", "report.md"), REPORT);
  const code = async (document: unknown, extra: Record<string, unknown> = {}) => (await refusal(() => sendDocument(document, extra))).code;

  expect(await code({ path: good }, { chat: "unknown" })).toBe("chat_unknown");
  expect(await code("just-a-string")).toBe("document_invalid");
  expect(await code({ path: "handoff/good.md" })).toBe("document_invalid");
  expect(await code({ path: path.join(HANDOFF, "missing.md") })).toBe("document_invalid");
  expect(await code({ path: documentFile(path.join(HANDOFF, "empty.md"), "") })).toBe("document_invalid");
  fs.mkdirSync(path.join(HANDOFF, "folder.md"));
  expect(await code({ path: path.join(HANDOFF, "folder.md") })).toBe("document_invalid");
  expect(await code({ path: good, filename: "../escape.md" })).toBe("document_invalid");
  expect(await code({ path: good, caption: "x".repeat(1025) })).toBe("text_too_long");

  expect(await code({ path: outside })).toBe("document_outside_roots");
  /* The root itself is a directory, never a document. */
  expect(await code({ path: HANDOFF })).toBe("document_outside_roots");

  expect(await code({ path: documentFile(path.join(HANDOFF, "deploy.sh"), "echo hi\n") })).toBe("document_type");
  expect(await code({ path: documentFile(path.join(HANDOFF, "NOTES"), "no extension\n") })).toBe("document_type");
  expect(await code({ path: good, filename: "report.exe" })).toBe("document_type");
  expect(await code({ path: documentFile(path.join(HANDOFF, "fake.pdf"), "not a pdf") })).toBe("document_type");
  expect(await code({ path: documentFile(path.join(HANDOFF, "fake.png"), "not a png") })).toBe("document_type");
  /* Uppercase extensions compare lowercase. */
  transport.script("sendDocument", ok({ message_id: 93, date: T0 + 100 }));
  expect((await sendDocument({ path: documentFile(path.join(HANDOFF, "LOUD.MD"), REPORT) }, { clientRequestId: "loud" })).messageIds).toEqual([93]);

  const large = path.join(HANDOFF, "large.log");
  fs.writeFileSync(large, "x");
  fs.truncateSync(large, 20 * 1024 * 1024 + 1);
  expect(await code({ path: large })).toBe("document_too_large");
  expect(transport.callsOf("sendDocument")).toHaveLength(1);
});

test("dot components, symlinks out of a root, hard links and the state directory are refused", async () => {
  await allowedTeam();
  const code = async (document: unknown) => (await refusal(() => sendDocument(document))).code;
  const outside = documentFile(path.join(SANDBOX, "elsewhere", "report.md"), REPORT);

  expect(await code({ path: documentFile(path.join(HANDOFF, ".private", "report.md"), REPORT) })).toBe("document_forbidden_path");
  expect(await code({ path: documentFile(path.join(HANDOFF, ".report.md"), REPORT) })).toBe("document_forbidden_path");
  /* Written out: path.join would resolve the `..` away before the check. */
  expect(await code({ path: `${HANDOFF}/../../elsewhere/report.md` })).toBe("document_forbidden_path");

  /* A link inside the root to a file outside it, and a linked directory. */
  fs.symlinkSync(outside, path.join(HANDOFF, "linked.md"));
  expect(await code({ path: path.join(HANDOFF, "linked.md") })).toBe("document_outside_roots");
  fs.symlinkSync(path.join(SANDBOX, "elsewhere"), path.join(HANDOFF, "linked-dir"));
  expect(await code({ path: path.join(HANDOFF, "linked-dir", "report.md") })).toBe("document_outside_roots");
  /* A link that stays in the root but resolves into a dot-directory. */
  fs.symlinkSync(path.join(HANDOFF, ".private", "report.md"), path.join(HANDOFF, "innocent.md"));
  expect(await code({ path: path.join(HANDOFF, "innocent.md") })).toBe("document_forbidden_path");

  fs.linkSync(outside, path.join(HANDOFF, "hard.md"));
  expect(await code({ path: path.join(HANDOFF, "hard.md") })).toBe("document_forbidden_path");

  /* A root that contains the state directory still never reaches into it. */
  service.setDocumentRoots([SANDBOX]);
  const stateFile = documentFile(path.join(process.env.LLV_STATE_DIR!, "notes.json"), "{}\n");
  expect(await code({ path: stateFile })).toBe("document_forbidden_path");
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});

test("a parent directory swapped for a link after the path is checked is caught on the opened file", async () => {
  await allowedTeam();
  const inside = documentFile(path.join(HANDOFF, "weekly", "report.md"), REPORT);
  documentFile(path.join(SANDBOX, "elsewhere", "weekly", "report.md"), "# Not for the chat\n");
  const open = fs.openSync;
  /* The swap lands between realpath and open: the last component is still
     a plain file, so O_NOFOLLOW alone would open the file outside. */
  const swap = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === inside) {
      fs.renameSync(path.join(HANDOFF, "weekly"), path.join(HANDOFF, "weekly-kept"));
      fs.symlinkSync(path.join(SANDBOX, "elsewhere", "weekly"), path.join(HANDOFF, "weekly"));
    }
    return open(...args);
  }) as typeof fs.openSync);
  try {
    expect((await refusal(() => sendDocument({ path: inside }))).code).toBe("document_outside_roots");
  } finally {
    swap.mockRestore();
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});

test("without /proc the swap is caught by resolving the path again against the opened file", async () => {
  await allowedTeam();
  const inside = documentFile(path.join(HANDOFF, "weekly", "report.md"), REPORT);
  documentFile(path.join(SANDBOX, "elsewhere", "weekly", "report.md"), "# Not for the chat\n");
  const open = fs.openSync;
  const readlink = fs.readlinkSync;
  let swapped = false;
  const swap = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === inside && !swapped) {
      swapped = true;
      fs.renameSync(path.join(HANDOFF, "weekly"), path.join(HANDOFF, "weekly-kept"));
      fs.symlinkSync(path.join(SANDBOX, "elsewhere", "weekly"), path.join(HANDOFF, "weekly"));
    }
    return open(...args);
  }) as typeof fs.openSync);
  const noProc = spyOn(fs, "readlinkSync").mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
    if (String(args[0]).startsWith("/proc/self/fd/")) throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
    return readlink(...args);
  }) as typeof fs.readlinkSync);
  try {
    expect((await refusal(() => sendDocument({ path: inside }))).code).toBe("document_forbidden_path");
    /* Swapped back before the second resolution: the path names the inside
       file again, but the descriptor holds the outside one. */
    fs.rmSync(path.join(HANDOFF, "weekly"));
    fs.renameSync(path.join(HANDOFF, "weekly-kept"), path.join(HANDOFF, "weekly"));
    swapped = false;
    const realpath = fs.realpathSync.native;
    let resolutions = 0;
    const back = spyOn(fs.realpathSync, "native").mockImplementation(((...args: Parameters<typeof fs.realpathSync.native>) => {
      if (args[0] === inside && ++resolutions === 2) {
        fs.rmSync(path.join(HANDOFF, "weekly"));
        fs.renameSync(path.join(HANDOFF, "weekly-kept"), path.join(HANDOFF, "weekly"));
      }
      return realpath(...args);
    }) as typeof fs.realpathSync.native);
    try {
      expect((await refusal(() => sendDocument({ path: inside }, { clientRequestId: "doc-back" }))).code).toBe("document_forbidden_path");
    } finally {
      back.mockRestore();
    }
    /* Nothing swapped: the fallback admits the file. */
    swapped = true;
    transport.script("sendDocument", ok({ message_id: 97, date: T0 + 100 }));
    expect((await sendDocument({ path: inside }, { clientRequestId: "doc-still" })).messageIds).toEqual([97]);
  } finally {
    swap.mockRestore();
    noProc.mockRestore();
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(1);
});

test("a FIFO in a root is refused at once instead of holding the Viewer at the open", async () => {
  await allowedTeam();
  const pipe = path.join(HANDOFF, "pipe.md");
  fs.mkdirSync(HANDOFF, { recursive: true });
  expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
  expect((await refusal(() => sendDocument({ path: pipe }))).code).toBe("document_invalid");
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
}, 5_000);

test("the shown filename keeps the file's type class, and a text file is scanned whatever it is shown as", async () => {
  await allowedTeam();
  const code = async (document: unknown) => (await refusal(() => sendDocument(document))).code;
  const png = documentFile(path.join(HANDOFF, "chart.png"), PNG);
  const markdown = documentFile(path.join(HANDOFF, "notes.md"), REPORT);
  expect(await code({ path: png, filename: "notes.txt" })).toBe("document_type");
  expect(await code({ path: markdown, filename: "invoice.pdf" })).toBe("document_type");
  expect(await code({ path: markdown, filename: "chart.png" })).toBe("document_type");
  expect(await code({ path: documentFile(path.join(HANDOFF, "brief.pdf"), "%PDF-1.7\n"), filename: "brief.md" })).toBe("document_type");
  const leaky = documentFile(path.join(HANDOFF, "leaky.md"), `${REPORT}\n${FORGE_TOKEN}\n`);
  expect(await code({ path: leaky, filename: "leaky.txt" })).toBe("document_secret");
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
  /* Within a class the name may change. */
  transport.script("sendDocument", ok({ message_id: 98, date: T0 + 100 }));
  expect((await sendDocument({ path: markdown, filename: "notes.txt" }, { clientRequestId: "same-class" })).messageIds).toEqual([98]);
  transport.script("sendDocument", ok({ message_id: 99, date: T0 + 101 }));
  expect((await sendDocument({ path: png, filename: "chart.jpg" }, { clientRequestId: "same-class-image" })).messageIds).toEqual([99]);
});

/* Credential keywords, assembled so no source line reads as an assignment
   to the publication gate. */
const PASSWORD = ["pass", "word"].join("");
const API_KEY = ["api", "_key"].join("");

function utf16(text: string, order: "le" | "be", bom: boolean): Uint8Array {
  const little = Buffer.from(text, "utf16le");
  const bytes = order === "le" ? little : Buffer.from(little.map((_, index) => little[index ^ 1]!));
  const mark = order === "le" ? [0xff, 0xfe] : [0xfe, 0xff];
  return Uint8Array.from([...(bom ? mark : []), ...bytes]);
}

test("a text document in UTF-16, with or without a byte-order mark, is scanned as text", async () => {
  await allowedTeam();
  const cases: Array<[string, Uint8Array, string]> = [
    ["le-bom.txt", utf16(`notes\n${FORGE_TOKEN}\n`, "le", true), "api_token"],
    ["be-bom.md", utf16(`${REPORT}\n${PRIVATE_KEY}`, "be", true), "private_key"],
    ["le.log", utf16(`started\n${PASSWORD}=Zq81mR02kLx7Tw45\n`, "le", false), "credential_assignment"],
    ["be.csv", utf16(`name,value\ndeploy,${FORGE_TOKEN}\n`, "be", false), "api_token"],
  ];
  for (const [name, content, secretClass] of cases) {
    const error = await refusal(() => sendDocument({ path: documentFile(path.join(HANDOFF, name), content) }, { clientRequestId: name }));
    expect([name, error.code, error.extra.secretClass]).toEqual([name, "document_secret", secretClass]);
    expect(error.message).not.toContain(FORGE_TOKEN);
    expect(error.message).not.toContain("Zq81mR02kLx7Tw45");
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
  /* A clean UTF-16 report still sends. */
  transport.script("sendDocument", ok({ message_id: 100, date: T0 + 100 }));
  expect((await sendDocument({ path: documentFile(path.join(HANDOFF, "clean.md"), utf16(REPORT, "le", true)) }, { clientRequestId: "clean" })).messageIds).toEqual([100]);
});

test("a credential assigned a plain word is caught; prose, placeholders and references are not", async () => {
  await allowedTeam();
  /* Word secrets are assembled so no source line reads as an assignment. */
  const word = ["sword", "fish"].join("");
  for (const [name, content] of [
    ["env.txt", `DB_HOST=db\nDB_PASSWORD=${word}\n`],
    ["config.json", `{\n  "${PASSWORD}": "${word}"\n}\n`],
    ["notes.md", `Login:\n\nsecret: ${word}\n`],
    ["app.log", `login user=bob passwd=${word} status=ok\n`],
  ]) {
    const error = await refusal(() => sendDocument({ path: documentFile(path.join(HANDOFF, name!), content!) }, { clientRequestId: name }));
    expect([name, error.code, error.extra.secretClass]).toEqual([name, "document_secret", "credential_assignment"]);
    expect(error.message).not.toContain(word);
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(0);

  expect(documentSecret(`${["sec", "ret"].join("")}=${word}`)).toEqual({ secretClass: "credential_assignment", line: 1 });
  expect(documentSecret(`a\n${API_KEY}: ${word}`)).toEqual({ secretClass: "credential_assignment", line: 2 });
  for (const prose of [
    `${PASSWORD}: reset by the operator on Monday.`,
    "token: expired",
    "Token: see the panel",
    `${PASSWORD}: none`,
    "secret: [redacted]",
    `${PASSWORD}: YOUR_PASSWORD`,
    `${API_KEY} = os.environ["API_KEY"]`,
    `${PASSWORD}: process.env.DB_PASSWORD`,
    "pwd: /srv/app",
    "max_token: 4096",
    `**${PASSWORD}:** stored in the vault`,
  ]) expect([prose, documentSecret(prose)]).toEqual([prose, null]);
});

test(".env keys that go on past their keyword and URL userinfo are caught; describing keys and placeholders are not", () => {
  /* Word values assembled at runtime, as above. */
  const word = ["sword", "fish"].join("");
  const secretKey = ["SECRET", "_KEY"].join("");
  expect(documentSecret(`DEBUG=1\n${secretKey}=abcdefghij${word}\n`)).toEqual({ secretClass: "credential_assignment", line: 2 });
  expect(documentSecret(`DJANGO_${secretKey}=k9f2m3n4b5v6c7x8z9${word}`)).toEqual({ secretClass: "credential_assignment", line: 1 });
  const url = `postgres://app:${word}Zq81${"@"}db.internal:5432/app`;
  expect(documentSecret(`# db\nDATABASE_URL=${url}\n`)).toEqual({ secretClass: "url_credentials", line: 2 });
  expect(documentSecret(`see ${["https", "://bot:", word, "@example.test/hook"].join("")} for the hook`)).toMatchObject({ secretClass: "url_credentials" });
  for (const prose of [
    `TOKEN_TYPE=bearer`,
    `${PASSWORD}_policy: strict`,
    `${PASSWORD}_reset_url: https://example.test/reset`,
    `${secretKey}_NAME=application`,
    "token_count: 123456",
    "tokens: many",
    `${secretKey}=\${DJANGO_KEY}`,
    `${secretKey}: <generate one>`,
    `DB_URL=${["postgres", "://app:", "${DB_PASS}", "@db/app"].join("")}`,
    `DB_URL=${["postgres", "://app:", "<", PASSWORD, ">", "@db/app"].join("")}`,
    `DB_URL=${["postgres", "://app:", "****", "@db/app"].join("")}`,
    `DB_URL=${["postgres", "://postgres:", "postgres", "@localhost/app"].join("")}`,
    `DB_URL=${["postgres", "://app:", PASSWORD, "@localhost/app"].join("")}`,
    ["ssh://git", "@example.test:22/repo.git"].join(""),
  ]) expect([prose, documentSecret(prose)]).toEqual([prose, null]);
});

test("a text document carrying a secret is refused with its class, never its value", async () => {
  await allowedTeam();
  const cases: Array<[string, string]> = [
    ["key.md", `${REPORT}\n${PRIVATE_KEY}`],
    ["token.txt", `deploy used ${FORGE_TOKEN} yesterday\n`],
    ["config.json", `{\n  "api_key": "Zq81mR02kLx7Tw45"\n}\n`],
  ];
  const classes: string[] = [];
  for (const [name, content] of cases) {
    const error = await refusal(() => sendDocument({ path: documentFile(path.join(HANDOFF, name), content) }));
    expect(error.code).toBe("document_secret");
    expect(error.message).not.toContain(FORGE_TOKEN);
    expect(error.message).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(error.message).not.toContain("Zq81mR02kLx7Tw45");
    classes.push(error.extra.secretClass!);
  }
  expect(classes).toEqual(["private_key", "api_token", "credential_assignment"]);
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
  /* Images and PDFs are not text, so they are not scanned as text. */
  transport.script("sendDocument", ok({ message_id: 94, date: T0 + 100 }));
  expect((await sendDocument({ path: documentFile(path.join(HANDOFF, "scan.pdf"), `%PDF-1.7\n${FORGE_TOKEN}\n`) }, { clientRequestId: "pdf" })).messageIds).toEqual([94]);
});

test("UTF-16 text appended after 64 KiB of ASCII is still read as text", async () => {
  await allowedTeam();
  const prefix = Buffer.from(`${"a".repeat(70 * 1024)}\n`);
  const word = ["hunter2", "sword", "fish"].join("");
  const error = await refusal(() => sendDocument({ path: documentFile(path.join(HANDOFF, "appended.log"), Buffer.concat([prefix, Buffer.from(`${PASSWORD}: ${word}\n`, "utf16le")])) }));
  expect([error.code, error.extra.secretClass]).toEqual(["document_secret", "credential_assignment"]);
  expect(error.message).not.toContain(word);
  /* A zero between the letters of a keyword past the first 64 KiB too. */
  const split = Buffer.concat([prefix, Buffer.from(`pass\u0000word: ${word}\n`, "latin1")]);
  expect(documentBytesSecret(split)).toMatchObject({ secretClass: "credential_assignment" });
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});

/* Invented provider credentials of different lengths, so the scan reads the
   text once per length; nothing here resembles a real one. */
function retainedProviderSecrets(count: number): string[] {
  const secrets = Array.from({ length: count }, (_, index) => crypto.randomBytes(24 + index).toString("hex"));
  retainProviderRedactionSecrets(secrets);
  return secrets;
}

test("a retained provider credential in a document is refused, on its line and in UTF-16", async () => {
  await allowedTeam();
  const retained = retainedProviderSecrets(10)[0]!;
  const text = `${REPORT}\nthe provider answered with ${retained} again\n`;
  const line = REPORT.split("\n").length + 1;
  expect(documentSecret(text)).toEqual({ secretClass: "provider_credential", line });
  expect(documentSecret(`{"key":${JSON.stringify(`${retained}\n`)}}`)).toMatchObject({ secretClass: "provider_credential" });
  const error = await refusal(() => sendDocument({ path: documentFile(path.join(HANDOFF, "provider.md"), utf16(text, "le", false)) }));
  expect([error.code, error.extra.secretClass]).toEqual(["document_secret", "provider_credential"]);
  expect(error.message).not.toContain(retained);
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});

test("the secret scan names classes and leaves ordinary report prose alone", () => {
  expect(documentSecret(REPORT)).toBeNull();
  /* Placeholders a report quotes; assembled so no source line reads as one. */
  expect(documentSecret(["The token field is [redacted]", "password: <your password>", "api_key = ${API_KEY}", "secret: " + "x".repeat(12)].join("\n"))).toBeNull();
  expect(documentSecret(`line one\n${PRIVATE_KEY}`)).toEqual({ secretClass: "private_key", line: 2 });
  expect(documentSecret(PRIVATE_KEY.split("\n")[0]!)).toMatchObject({ secretClass: "private_key" });
  expect(documentSecret(`a\nb\nAuthorization: Bearer ${"Qm9".repeat(8)}\n`)).toMatchObject({ secretClass: "bearer_token", line: 3 });
  expect(documentSecret(`bot ${"4242424"}:${"AAx9".repeat(9)}\n`)).toMatchObject({ secretClass: "bot_token" });
  expect(documentSecret(["eyJhbGciOiJIUzI1", "eyJzdWIiOiIxMjM0", "c2lnbmF0dXJlMTIz"].join("."))).toMatchObject({ secretClass: "jwt" });
});

/* The scan runs synchronously in the send_document request, so a slow input
   stalls every Viewer route. Both shapes below once took minutes to hours at
   the 20 MB document limit; linear, each takes one to two seconds on a busy
   machine, and the bound leaves room for a loaded runner. */
const SCAN_MB = 20 * 1024 * 1024;
const SCAN_BOUND_MS = 4000;

test("a 20 MB text document with a megabyte-long word run scans in linear time", () => {
  const run = crypto.randomBytes(768 * 1024).toString("base64url");
  const filler = `${"x".repeat(999)}\n`;
  const text = `{"t":"${run}"}\n${filler.repeat(Math.ceil((SCAN_MB - run.length) / filler.length))}`;
  expect(text.length).toBeGreaterThanOrEqual(SCAN_MB);
  const bytes = Buffer.from(text);
  const started = performance.now();
  expect(documentBytesSecret(bytes)).toBeNull();
  expect(performance.now() - started).toBeLessThan(SCAN_BOUND_MS);
}, 30_000);

test("20 MB of prose lines after a credential keyword scan in linear time", () => {
  const line = `${PASSWORD}: vault is where it lives\n`;
  const text = line.repeat(Math.ceil(SCAN_MB / line.length));
  const bytes = Buffer.from(text);
  const started = performance.now();
  expect(documentBytesSecret(bytes)).toBeNull();
  expect(performance.now() - started).toBeLessThan(SCAN_BOUND_MS);
  /* A word secret after the prose is still found, and a key that opens with
     a prefix still reads as a key now that a match must start the word. */
  const word = ["sword", "fish"].join("");
  expect(documentSecret(`${text.slice(0, 64 * line.length)}${PASSWORD}: ${word}`)).toEqual({ secretClass: "credential_assignment", line: 65 });
  for (const assignment of [`x.${PASSWORD}=${word}`, `my_${PASSWORD}: ${word}`, `run --db-${PASSWORD}=${word}`]) {
    expect([assignment, documentSecret(assignment)]).toEqual([assignment, { secretClass: "credential_assignment", line: 1 }]);
  }
}, 30_000);

/* Each of these once let one pattern restart at every offset of a run and
   read to its end: `(^|\n)\s*` at each newline of a blank run, `\beyJ` after
   each `-`, and a keyword line's rest copied once per keyword on it. */
for (const [shape, unit] of [
  ["blank lines", "\n"],
  ["CRLF blank lines", "\r\n"],
  ["an `eyJ-` run", "eyJ-"],
  ["one line of keyword prose", `${PASSWORD}: vault is `],
] as const) {
  test(`20 MB of ${shape} scans in linear time`, () => {
    const bytes = Buffer.from(unit.repeat(Math.ceil(SCAN_MB / unit.length)));
    const started = performance.now();
    expect(documentBytesSecret(bytes)).toBeNull();
    expect(performance.now() - started).toBeLessThan(SCAN_BOUND_MS);
  }, 30_000);
}

test("a 20 MB clean text document scans in linear time with ten provider credentials retained", () => {
  retainedProviderSecrets(10);
  const bytes = Buffer.from("lorem ipsum dolor sit amet\n".repeat(Math.ceil(SCAN_MB / 27)));
  const started = performance.now();
  expect(documentBytesSecret(bytes)).toBeNull();
  expect(performance.now() - started).toBeLessThan(SCAN_BOUND_MS);
}, 60_000);

test("a refused document leaves its key free: the corrected file sends under the same clientRequestId", async () => {
  await allowedTeam();
  const report = documentFile(path.join(HANDOFF, "draft.md"), `${REPORT}\n${FORGE_TOKEN}\n`);
  expect((await refusal(() => sendDocument({ path: report }))).code).toBe("document_secret");
  fs.writeFileSync(report, REPORT);
  transport.script("sendDocument", ok({ message_id: 95, date: T0 + 100 }));
  expect(await sendDocument({ path: report })).toMatchObject({ messageIds: [95], alreadySent: false });
});

test("an unconfirmed document send answers send_uncertain and never sends twice under its key", async () => {
  await allowedTeam();
  const report = documentFile(path.join(HANDOFF, "weekly.md"), REPORT);
  transport.script("sendDocument", unreachable("timed_out"));
  expect((await refusal(() => sendDocument({ path: report }))).code).toBe("send_uncertain");
  expect((await refusal(() => sendDocument({ path: report }))).code).toBe("send_uncertain");
  expect(transport.callsOf("sendDocument")).toHaveLength(1);
});

test("document roots are the operator's setting: custom roots replace the default, bad roots are refused, empty returns to the default", async () => {
  await allowedTeam();
  expect(service.status().documents).toEqual({ roots: [HANDOFF], custom: false });
  const reports = path.join(SANDBOX, "elsewhere", "reports");
  const inReports = documentFile(path.join(reports, "weekly.md"), REPORT);
  const inHandoff = documentFile(path.join(HANDOFF, "weekly.md"), REPORT);
  expect((await refusal(() => sendDocument({ path: inReports }))).code).toBe("document_outside_roots");

  expect(service.setDocumentRoots([`${reports}/`, reports]).documents).toEqual({ roots: [reports], custom: true });
  transport.script("sendDocument", ok({ message_id: 96, date: T0 + 100 }));
  expect((await sendDocument({ path: inReports }, { clientRequestId: "custom" })).messageIds).toEqual([96]);
  expect((await refusal(() => sendDocument({ path: inHandoff }, { clientRequestId: "old-default" }))).code).toBe("document_outside_roots");

  for (const bad of [["relative/reports"], [path.join(HOME, ".config", "reports")], [process.env.LLV_STATE_DIR!], [path.join(process.env.LLV_STATE_DIR!, "telegram")], ["/"], "not-a-list", [42]]) {
    expect((await refusal(() => service.setDocumentRoots(bad))).code).toBe("document_roots_invalid");
  }
  expect(service.status().documents).toEqual({ roots: [reports], custom: true });
  expect(service.setDocumentRoots([]).documents).toEqual({ roots: [HANDOFF], custom: false });
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

  /* A connection that never opened sent nothing, so the same key may try
     again, and so may a refusal Telegram answered. */
  transport.script("sendMessage", unreachable("unreachable"));
  const down = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-down", chat: "team-reports", text: "down" }));
  expect(down.code).toBe("network_failed");
  expect(down.retryable).toBe(true);
  expect(down.message).toContain("nothing was sent");
  transport.script("sendMessage", refused(500, "Internal Server Error"));
  expect((await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-down", chat: "team-reports", text: "down" }))).code).toBe("telegram_failed");
  transport.script("sendMessage", ok({ message_id: 62, date: T0 + 102 }));
  expect(await service.send({ conversationId: "conversation_writer", clientRequestId: "req-down", chat: "team-reports", text: "down" })).toMatchObject({ messageIds: [62], alreadySent: false });
});

test("a connection that fails during a send is uncertain too: it may have been posted, and its key never posts again", async () => {
  await allowedTeam();
  transport.script("sendMessage", unreachable("network_failed"));
  const cut = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-cut", chat: "team-reports", text: "cut" }));
  expect(cut.code).toBe("send_uncertain");
  expect(cut.retryable).toBe(false);
  expect(cut.message).toContain("connection to Telegram failed");
  expect(cut.message).toContain("may already be posted");
  const again = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-cut", chat: "team-reports", text: "cut" }));
  expect(again.code).toBe("send_uncertain");
  expect(transport.callsOf("sendMessage")).toHaveLength(1);

  /* A later part cut the same way reports the parts that did go out and
     says the rest may or may not have. */
  let id = 80;
  let calls = 0;
  transport.handlers.sendMessage = () => (calls++ === 0 ? ok({ message_id: id++, date: T0 }) : unreachable("network_failed"));
  const partial = await refusal(() => service.send({ conversationId: "conversation_writer", clientRequestId: "req-cut-2", chat: "team-reports", text: `${"x".repeat(3000)}\n\n${"y".repeat(3000)}` }));
  expect(partial.code).toBe("send_partial");
  expect(partial.extra.sentMessageIds).toEqual([80]);
  expect(partial.message).toContain("may or may not have been posted");
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

/* ---- chats added by id (a post-only bot) --------------------------------- */

/* Another program owns this bot's updates through a webhook, so Delegatus
   posts and never reads: no update ever names the group the bot joined. */
const RELEASES = { id: -1000000000404, type: "supergroup", title: "Release Notes" };

async function connectPostOnly() {
  transport.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/hook" });
  transport.script("getMe", me());
  const status = await service.connect(TOKEN);
  expect(status.receiving).toBe("webhook_elsewhere");
  expect(service.pollerRunning()).toBe(false);
  return transport.calls.length;
}

test("a chat added by id is stored allowed and postable with no update received, and nothing reads it", async () => {
  const before = await connectPostOnly();
  transport.script("getChat", ok(RELEASES));
  transport.script("getChatMember", ok({ status: "administrator" }));

  const added = await service.addChat("-1000000000404");
  expect(added).toMatchObject({ chat: "release-notes", chatId: "-1000000000404" });
  expect(added.status.chats).toEqual([expect.objectContaining({ chatId: "-1000000000404", title: "Release Notes", alias: "release-notes", postAllowed: true, postable: true, member: true, storedMessages: 0 })]);
  /* Selectable where the settings route looks: the agent listing says posting is allowed. */
  expect(service.listChats().chats).toEqual([expect.objectContaining({ chat: "release-notes", postAllowed: true, postRefusal: null })]);

  /* The bot was asked about the chat and its own membership, nothing else:
     no getUpdates, no poller, no message stored. */
  const lookups = transport.calls.slice(before).map((call) => call.method);
  expect(lookups).toEqual(["getChat", "getChatMember"]);
  expect(transport.callsOf("getUpdates")).toEqual([]);
  expect(transport.callsOf("getChat")[0]!.params).toEqual({ chat_id: -1000000000404 });
  expect(transport.callsOf("getChatMember")[0]!.params).toEqual({ chat_id: -1000000000404, user_id: BOT_ID });
  expect(service.pollerRunning()).toBe(false);
  expect(service.status().receiving).toBe("webhook_elsewhere");
});

test("a chat is added by @username or t.me link, keeps the alias the operator gave, and a taken title alias gets a number", async () => {
  await connectPostOnly();
  transport.script("getChat", ok(RELEASES), ok({ id: -1000000000505, type: "channel", title: "Release Notes" }));
  transport.script("getChatMember", ok({ status: "member" }), ok({ status: "administrator" }));
  expect((await service.addChat("@release_notes", "Releases")).chat).toBe("releases");
  expect(transport.callsOf("getChat")[0]!.params).toEqual({ chat_id: "@release_notes" });
  expect((await service.addChat("https://t.me/release_channel")).chat).toBe("release-notes");
  expect(transport.callsOf("getChat")[1]!.params).toEqual({ chat_id: "@release_channel" });

  /* Adding the same chat again keeps its alias and stays allowed. */
  transport.script("getChat", ok(RELEASES));
  transport.script("getChatMember", ok({ status: "member" }));
  const again = await service.addChat(String(RELEASES.id));
  expect(again.chat).toBe("releases");
  expect(again.status.chats.filter((chat) => chat.postable).map((chat) => chat.alias).sort()).toEqual(["release-notes", "releases"]);
});

test("adding refuses an unreadable reference before any call, and stores nothing Telegram does not confirm", async () => {
  const before = await connectPostOnly();
  for (const reference of ["", "team reports", "12ab", "@abc", null, { id: 1 }]) {
    await expect(service.addChat(reference)).rejects.toMatchObject({ code: "chat_reference_invalid" });
  }
  expect(transport.calls.length).toBe(before);

  transport.script("getChat", refused(400, "Bad Request: chat not found"));
  await expect(service.addChat("-1000000000999")).rejects.toMatchObject({ code: "chat_unknown" });
  transport.script("getChat", ok(RELEASES));
  transport.script("getChatMember", ok({ status: "left" }));
  await expect(service.addChat(String(RELEASES.id))).rejects.toMatchObject({ code: "bot_not_in_chat" });
  transport.script("getChat", unreachable("unreachable"));
  await expect(service.addChat(String(RELEASES.id))).rejects.toMatchObject({ code: "network_failed" });
  await expect(service.addChat(String(RELEASES.id), "12345")).rejects.toMatchObject({ code: "alias_invalid" });
  expect(service.status().chats).toEqual([]);
});

test("the operator's test post goes out silently once, is not recorded as an agent's post, and is refused for a chat agents may not post in", async () => {
  await connectPostOnly();
  transport.script("getChat", ok(RELEASES));
  transport.script("getChatMember", ok({ status: "member" }));
  await service.addChat(String(RELEASES.id));
  transport.script("sendMessage", ok({ message_id: 9, date: T0 }));
  const tested = await service.testPost("release-notes", "Delegatus: test post.");
  expect(tested.sentAt).toBe(NOW.toISOString());
  expect(transport.callsOf("sendMessage").map((call) => call.params)).toEqual([{ chat_id: -1000000000404, text: "Delegatus: test post.", disable_notification: true }]);
  expect(tested.status.chats[0]).toMatchObject({ lastPostAt: null, lastPostBy: null, storedMessages: 0 });

  service.setChat(String(RELEASES.id), "release-notes", false);
  await expect(service.testPost("release-notes", "again")).rejects.toMatchObject({ code: "chat_not_allowed" });
  expect(transport.callsOf("sendMessage")).toHaveLength(1);
  expect(transport.callsOf("getUpdates")).toEqual([]);
});
