import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TelegramBotStore, type TgMessage, type TgUpdate } from "./store";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-bot-store-"));
const NOW = new Date("2026-09-24T12:00:00Z");
const T0 = Math.floor(NOW.getTime() / 1000) - 3600;

let store: TelegramBotStore;
let filename: string;
let nextUpdate = 1;

beforeEach(() => {
  filename = path.join(SANDBOX, `bot-${crypto.randomUUID()}.sqlite`);
  store = new TelegramBotStore(filename);
  nextUpdate = 1;
});
afterEach(() => store.close());
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

/* Invented chats and people; none of these ids exists. */
const TEAM = { id: -1000000000101, type: "supergroup", title: "Team Reports", is_forum: false };
const OLD_GROUP = { id: -500000202, type: "group", title: "Old Group" };
const PRIVATE = { id: 700000303, type: "private", first_name: "Person", last_name: "A", username: "person_a" };
const CHANNEL = { id: -1000000000404, type: "channel", title: "Announcements" };
const PERSON_B = { id: 700000505, first_name: "Person", last_name: "B", username: "person_b" };

function message(chat: object, messageId: number, date: number, extra: Partial<TgMessage> = {}): TgMessage {
  return { message_id: messageId, date, chat: chat as TgMessage["chat"], from: PERSON_B, text: `message ${messageId}`, ...extra };
}

function update(fields: Omit<TgUpdate, "update_id">): TgUpdate {
  return { update_id: nextUpdate++, ...fields };
}

test("the store file is owner-only before SQLite writes to it", () => {
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
});

test("message intake: chats appear from what the bot sees, texts, captions and media kinds are kept", () => {
  const applied = store.applyUpdates([
    update({ message: message(TEAM, 10, T0) }),
    update({ message: message(TEAM, 11, T0 + 1, { text: undefined, caption: "a chart", photo: [{}] }) }),
    update({ message: message(TEAM, 12, T0 + 2, { text: undefined, sticker: {} }) }),
    update({ message: message(PRIVATE, 1, T0 + 3, { from: { id: PRIVATE.id, first_name: "Person", last_name: "A", username: "person_a" } }) }),
    update({ channel_post: message(CHANNEL, 5, T0 + 4, { from: undefined, sender_chat: CHANNEL as TgMessage["chat"] }) }),
  ], NOW);
  expect(applied.maxUpdateId).toBe(5);
  expect(applied.touched.sort()).toEqual([String(CHANNEL.id), String(PRIVATE.id), String(TEAM.id)].sort());
  /* Group and channel have no membership event yet; a private chat is one the
     user opened, so the bot is in it. */
  expect(applied.needsMembership.sort()).toEqual([String(CHANNEL.id), String(TEAM.id)].sort());
  expect(store.chat(String(PRIVATE.id))).toMatchObject({ type: "private", title: "Person A", botStatus: "member" });

  const page = store.messagesPage(String(TEAM.id), { limit: 10, maxChars: 1000 });
  expect(page.messages.map((row) => [row.messageId, row.kind, row.text])).toEqual([
    [12, "sticker", null],
    [11, "photo", "a chart"],
    [10, "text", "message 10"],
  ]);
  expect(page.messages[0]!.from).toEqual({ name: "Person B", username: "person_b" });
  const channel = store.messagesPage(String(CHANNEL.id), { limit: 10, maxChars: 1000 });
  expect(channel.messages[0]!.from).toBeNull();
});

test("edits update the stored text in place; a redelivered batch changes nothing", () => {
  const batch = [
    update({ message: message(TEAM, 20, T0) }),
    update({ message: message(TEAM, 21, T0 + 1, { reply_to_message: { message_id: 20 } }) }),
  ];
  store.applyUpdates(batch, NOW);
  store.applyUpdates([update({ edited_message: message(TEAM, 20, T0, { text: "fixed", edit_date: T0 + 60 }) })], NOW);
  store.applyUpdates(batch, NOW);
  const page = store.messagesPage(String(TEAM.id), { limit: 10, maxChars: 1000 });
  expect(page.messages.map((row) => row.messageId)).toEqual([21, 20]);
  expect(page.messages[1]).toMatchObject({ text: "fixed", editedAt: new Date((T0 + 60) * 1000).toISOString() });
  expect(page.messages[0]!.replyToMessageId).toBe(20);
  expect(store.chat(String(TEAM.id))!.storedMessages).toBe(2);
});

test("forum topics: the topic is kept, and the topic opener is not a reply", () => {
  store.applyUpdates([update({ message: message({ ...TEAM, is_forum: true }, 30, T0, { is_topic_message: true, message_thread_id: 7, reply_to_message: { message_id: 7 } }) })], NOW);
  const row = store.messagesPage(String(TEAM.id), { limit: 1, maxChars: 1000 }).messages[0]!;
  expect(row).toMatchObject({ topicId: 7, replyToMessageId: null });
  expect(store.chat(String(TEAM.id))!.isForum).toBe(true);
});

test("my_chat_member: added, promoted, kicked — the bot learns its own status in each chat", () => {
  const membership = (status: string) => update({ my_chat_member: { chat: TEAM as TgMessage["chat"], date: T0, new_chat_member: { status } } });
  let applied = store.applyUpdates([membership("member")], NOW);
  expect(applied.needsMembership).toEqual([]);
  expect(store.chat(String(TEAM.id))).toMatchObject({ botStatus: "member", title: "Team Reports" });
  store.applyUpdates([membership("administrator")], NOW);
  expect(store.chat(String(TEAM.id))!.botStatus).toBe("administrator");
  applied = store.applyUpdates([membership("kicked")], NOW);
  expect(store.chat(String(TEAM.id))!.botStatus).toBe("kicked");
  /* A redelivered older message does not undo a block in a private chat. */
  store.applyUpdates([update({ my_chat_member: { chat: PRIVATE as TgMessage["chat"], date: T0, new_chat_member: { status: "kicked" } } })], NOW);
  store.applyUpdates([update({ message: message(PRIVATE, 2, T0) })], NOW);
  expect(store.chat(String(PRIVATE.id))!.botStatus).toBe("kicked");
});

test("a group upgraded to a supergroup keeps its alias, allowlist flag and messages under the new id", () => {
  store.applyUpdates([update({ message: message(OLD_GROUP, 40, T0) })], NOW);
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "ops", postAllowed: true })).toBe("ok");
  const NEW_ID = -1000000000606;
  const applied = store.applyUpdates([
    update({ message: message(OLD_GROUP, 41, T0 + 1, { text: undefined, migrate_to_chat_id: NEW_ID }) }),
  ], NOW);
  expect(applied.touched).toEqual([String(NEW_ID)]);
  expect(store.chat(String(OLD_GROUP.id))).toBeNull();
  expect(store.resolveChat("ops")).toMatchObject({ chatId: String(NEW_ID), type: "supergroup", alias: "ops", postAllowed: true, storedMessages: 2 });

  /* The service's migrate path, when the new chat already exists. */
  store.applyUpdates([update({ message: message(TEAM, 1, T0) })], NOW);
  store.migrateChat(String(NEW_ID), String(TEAM.id));
  expect(store.resolveChat("ops")).toMatchObject({ chatId: String(TEAM.id), postAllowed: true, storedMessages: 3 });
});

test("retention keeps the newest messages per chat and nothing older than the horizon", () => {
  const old = T0 - 40 * 86_400;
  store.applyUpdates([
    update({ message: message(TEAM, 1, old) }),
    ...[2, 3, 4, 5, 6].map((id) => update({ message: message(TEAM, id, T0 + id) })),
    update({ message: message(PRIVATE, 1, old) }),
  ], NOW);
  store.retain([String(TEAM.id)], NOW, { messages: 3, days: 30 });
  expect(store.messagesPage(String(TEAM.id), { limit: 10, maxChars: 1000 }).messages.map((row) => row.messageId)).toEqual([6, 5, 4]);
  /* Only touched chats are pruned in a round. */
  expect(store.chat(String(PRIVATE.id))!.storedMessages).toBe(1);
  store.retain([String(PRIVATE.id)], NOW);
  expect(store.chat(String(PRIVATE.id))!.storedMessages).toBe(0);
});

test("paging is newest first, and the cursor stays stable while new messages arrive", () => {
  store.applyUpdates([1, 2, 3, 4, 5].map((id) => update({ message: message(TEAM, id, T0 + id) })), NOW);
  const first = store.messagesPage(String(TEAM.id), { limit: 2, maxChars: 1000 });
  expect(first.messages.map((row) => row.messageId)).toEqual([5, 4]);
  expect(first.hasMore).toBe(true);
  store.applyUpdates([6, 7].map((id) => update({ message: message(TEAM, id, T0 + id) })), NOW);
  const second = store.messagesPage(String(TEAM.id), { limit: 2, maxChars: 1000, cursor: first.nextCursor! });
  expect(second.messages.map((row) => row.messageId)).toEqual([3, 2]);
  const third = store.messagesPage(String(TEAM.id), { limit: 2, maxChars: 1000, cursor: second.nextCursor! });
  expect(third.messages.map((row) => row.messageId)).toEqual([1]);
  expect(third).toMatchObject({ hasMore: false, nextCursor: null, storedSince: new Date((T0 + 1) * 1000).toISOString() });
  /* Same-second messages order by id. */
  store.applyUpdates([update({ message: message(TEAM, 9, T0 + 7) })], NOW);
  expect(store.messagesPage(String(TEAM.id), { limit: 3, maxChars: 1000 }).messages.map((row) => row.messageId)).toEqual([9, 7, 6]);
});

test("since bounds the page inclusively, and maxChars truncates with a flag", () => {
  store.applyUpdates([
    update({ message: message(TEAM, 1, T0) }),
    update({ message: message(TEAM, 2, T0 + 10, { text: "a".repeat(50) }) }),
  ], NOW);
  const page = store.messagesPage(String(TEAM.id), { limit: 10, maxChars: 20, since: T0 + 10 });
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]).toMatchObject({ messageId: 2, text: "a".repeat(20), truncated: true });
});

test("aliases are lowercase and unique, and clearing one turns posting off", () => {
  store.applyUpdates([update({ message: message(TEAM, 1, T0) }), update({ message: message(OLD_GROUP, 1, T0) })], NOW);
  expect(store.setChatSettings(String(TEAM.id), { alias: "Team-Reports", postAllowed: true })).toBe("ok");
  expect(store.resolveChat("TEAM-reports")).toMatchObject({ chatId: String(TEAM.id), alias: "team-reports", postAllowed: true });
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "team-reports", postAllowed: true })).toBe("alias_taken");
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "no spaces", postAllowed: true })).toBe("alias_invalid");
  /* Digits alone would read as a chat id, and capture the chat that has it. */
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "700000303", postAllowed: true })).toBe("alias_invalid");
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "2026", postAllowed: false })).toBe("alias_invalid");
  expect(store.setChatSettings(String(OLD_GROUP.id), { alias: "q3-2026", postAllowed: false })).toBe("ok");
  expect(store.setChatSettings("-42", { alias: "ghost", postAllowed: true })).toBe("chat_unknown");
  expect(store.setChatSettings(String(TEAM.id), { alias: "", postAllowed: true })).toBe("ok");
  expect(store.chat(String(TEAM.id))).toMatchObject({ alias: null, postAllowed: false });
});

test("a send key is claimed once; a failed attempt can be claimed again", () => {
  store.applyUpdates([update({ message: message(TEAM, 1, T0) })], NOW);
  expect(store.claimSend("conversation_a", "req-1", String(TEAM.id), NOW)).toEqual({ claimed: true });
  expect(store.claimSend("conversation_a", "req-1", String(TEAM.id), NOW)).toMatchObject({ claimed: false, row: { state: "pending" } });
  /* Keys are per caller. */
  expect(store.claimSend("conversation_b", "req-1", String(TEAM.id), NOW)).toEqual({ claimed: true });
  store.failSend("conversation_b", "req-1", "rate_limited", []);
  expect(store.claimSend("conversation_b", "req-1", String(TEAM.id), NOW)).toEqual({ claimed: true });
});
