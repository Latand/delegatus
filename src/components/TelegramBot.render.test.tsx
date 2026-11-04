import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import type { TelegramConnectionState } from "@/hooks/useTelegramConnection";
import { DISCONNECTED_BOT_STATUS, type TelegramBotChatView, type TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";

import type { SettingsSub } from "./settings/openSettings";
import { TelegramSectionView } from "./settings/TelegramSection";
import { TelegramPanel } from "./TelegramConnect";

function stateFor(status: TelegramBotStatusPayload, failure: { code: string } | null = null): TelegramBotState {
  return {
    status,
    busy: false,
    failure,
    refresh: async () => {},
    connect: async () => {},
    setChat: async () => {},
    addChat: async () => null,
    testPost: async () => false,
    setDocumentRoots: async () => false,
    remove: async () => {},
  };
}

/* Invented bot and chats. */
function chat(overrides: Partial<TelegramBotChatView>): TelegramBotChatView {
  return {
    chatId: "-1000000000101",
    title: "Team Reports",
    type: "supergroup",
    username: null,
    isForum: false,
    member: true,
    alias: null,
    postAllowed: false,
    postable: false,
    seesAllMessages: false,
    readdToApply: false,
    lastMessageAt: null,
    lastPostAt: null,
    lastPostBy: null,
    storedMessages: 0,
    ...overrides,
  };
}

function connected(overrides: Partial<TelegramBotStatusPayload> = {}): TelegramBotStatusPayload {
  return {
    ...DISCONNECTED_BOT_STATUS,
    connected: true,
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    chats: [
      chat({ alias: "team-reports", postAllowed: true, postable: true, seesAllMessages: true, lastPostAt: "2026-09-24T09:30:00Z", lastPostBy: { conversationId: "conversation_writer", title: "Weekly report writer" } }),
      chat({ chatId: "-1000000000202", title: "Lounge", isForum: true }),
      chat({ chatId: "700000303", title: "Person A", type: "private", seesAllMessages: true }),
      chat({ chatId: "-1000000000404", title: "Old Project", member: false, alias: "old-project", postAllowed: true }),
    ],
    ...overrides,
  };
}

const noop = () => {};
const render = (status: TelegramBotStatusPayload, failure: { code: string } | null = null, sub: SettingsSub | null = null) =>
  renderToStaticMarkup(<TelegramSectionView state={stateFor(status, failure)} sub={sub} go={noop} back={noop} />);
const chatPage = (status: TelegramBotStatusPayload, chatId = "-1000000000101") => render(status, null, { id: "chat", arg: chatId, title: "" });
const botPage = (status: TelegramBotStatusPayload) => render(status, null, { id: "bot", title: "" });

test("no bot and no clone: a key row opens Keys and no token field is drawn, with the BotFather hint", () => {
  const html = render(DISCONNECTED_BOT_STATUS);
  expect(html).toContain('data-telegram-bot-token="missing"');
  expect(html).toContain("Opens Keys");
  expect(html).toContain("/newbot");
  expect(html).not.toMatch(/<input[^>]*type="password"/);
  expect(html).toContain("data-settings-details-toggle");
  expect(html).not.toContain("Remove bot");
});

test("connected with mixed chats: the bot and its state word, one row per chat, inactive chats folded", () => {
  const html = render(connected());
  expect(html).toContain("Report Bot");
  expect(html).toContain("@report_test_bot");
  expect(html).toContain(">Receiving<");
  expect(html).toContain("Team Reports");
  expect(html).toContain("group · topics");
  expect(html).toContain("No longer a member (1)");
  /* A chat is added by id on a page of its own, and another bot too: no field stands on the first level. */
  expect(html).toContain("Add a chat by id");
  expect(html).toContain("Add another bot");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<textarea");
  /* A bot's actions are on its page. */
  expect(html).not.toContain("Remove bot");
});

test("the bot's page holds its token row, Refresh, Remove and the revoke hint; the token is only ever a row that opens Keys", () => {
  const html = botPage(connected());
  expect(html).toContain('data-telegram-bot-token="saved"');
  expect(html).toContain("Remove bot");
  expect(html).toContain("/revoke");
  expect(html).not.toMatch(/<input[^>]*type="password"/);
});

test("a chat's page: its switch, the alias only where posting is on, a visibility line only where it differs", () => {
  const html = chatPage(connected());
  expect(html).toContain('role="switch" aria-checked="true" aria-label="Agents may post"');
  expect(html).toContain('value="team-reports"');
  expect(html).not.toContain("Set an alias to allow posting");
  expect(html).toContain("Weekly report writer");
  expect(html).toContain("Sees all messages: admin here");
  expect(html.match(/Sees all messages/g)).toHaveLength(1);
});

const postingBots = connected({ chats: [chat({
  alias: "team-reports",
  bots: [
    { name: "Removed Bot", username: "removed_bot", assigned: false, member: false, status: "kicked", canPost: false, canSendPhotos: false, canSendDocuments: false, canManageTopics: false, reason: "bot_not_in_chat", checkedAt: "2026-10-20T12:00:00.000Z" },
    { name: "Ready Bot", username: "ready_bot", assigned: false, member: true, status: "member", canPost: true, canSendPhotos: true, canSendDocuments: true, canManageTopics: false, reason: null, checkedAt: "2026-10-20T12:00:00.000Z" },
    { name: "Restricted Bot", username: "restricted_bot", assigned: false, member: true, status: "restricted", canPost: false, canSendPhotos: false, canSendDocuments: false, canManageTopics: false, reason: "not_enough_rights", checkedAt: "2026-10-20T12:00:00.000Z" },
    { name: "Unverified Bot", username: "unverified_bot", assigned: false, member: null, status: null, canPost: null, canSendPhotos: null, canSendDocuments: null, canManageTopics: null, reason: null, checkedAt: null },
  ],
})] });

test("each connected bot has a visible and accessible posting state", () => {
  const html = chatPage(postingBots);
  expect(html).toContain('data-telegram-bot-posting-state="removed">removed from the chat</span>');
  expect(html).toContain('data-telegram-bot-posting-state="may-post">Agents may post</span>');
  expect(html).toContain('data-telegram-bot-posting-state="cannot-post">may not post here</span>');
  expect(html).toContain('data-telegram-bot-posting-state="not-checked">Not checked yet</span>');
  expect(html).toContain('aria-label="Removed Bot: ');
  expect(html).toContain('aria-label="Ready Bot: Agents may post');
});

test("a webhook elsewhere says reading is blocked and why", () => {
  const html = botPage(connected({ receiving: "webhook_elsewhere" }));
  expect(html).toContain("webhook elsewhere");
  expect(html).toContain("can post but not read");
});

const cloned = (relay: boolean) => connected({ chats: [chat({ alias: "reports", postAllowed: true, postable: true, member: true,
  bots: [
    { name: "Report clone", username: null, ...(relay ? { clone: { relay: "Celestia" } } : {}), assigned: false, member: true, status: null, canPost: true, canSendPhotos: false,
      canSendDocuments: false, canManageTopics: false, reason: null, checkedAt: null },
    { name: "Removed bot", username: "removed_fixture_bot", assigned: false, member: false, status: "kicked", canPost: false,
      canSendPhotos: false, canSendDocuments: false, canManageTopics: false, reason: "bot_not_in_chat", checkedAt: null },
  ] })] });

test("a clone keeps a removed bot's group active, reads as a sender, and is never an option in «Posts as»", () => {
  const list = render(cloned(true));
  expect(list).toContain("posts as Report clone, a Celestia clone");
  expect(list).not.toContain("No longer a member (1)");
  const page = chatPage(cloned(true));
  expect(page).toContain("Report clone, a Celestia clone");
  expect(page).toContain('data-telegram-bot-posting-state="removed"');
  expect(page).not.toContain('option value="Report clone"');
});

test("clone-only: the groups are listed, nothing asks to paste a token and the page says none is stored", () => {
  const html = render({ ...DISCONNECTED_BOT_STATUS, chats: [chat({ alias: "reports", postAllowed: true, postable: true, bots: cloned(true).chats[0]!.bots })] });
  expect(html).toContain("No bot token is stored here");
  expect(html).toContain('data-telegram-bot-token="missing"');
  expect(html).not.toMatch(/<input[^>]*type="password"/);
});

test("a rejected token shows the key row with an amber dot in place of a field", () => {
  const html = botPage(connected({ receiving: "token_rejected" }));
  expect(html).toContain("Telegram rejected the token");
  expect(html).toContain('data-telegram-bot-token="rejected"');
  expect(html).toContain('data-settings-dot="warn"');
  expect(html).not.toMatch(/<input[^>]*type="password"/);
});

test("a chat whose title suggests no alias shows the field while off and says it needs one", () => {
  const html = chatPage(connected({ chats: [chat({ chatId: "-1000000000505", title: "Реліз", type: "group" })] }), "-1000000000505");
  expect(html).toContain('aria-label="Alias agents use: Реліз"');
  expect(html).toContain("Set an alias to allow posting");
  expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Agents may post"[^>]*>/);
  expect(html.match(/<button[^>]*data-telegram-chat-switch[^>]*>/)?.[0] ?? "").toContain('disabled=""');
});

test("with privacy mode off, a group that still needs the bot re-added says so, and the rest say nothing", () => {
  const status = connected({
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: true, canJoinGroups: true },
    chats: [chat({ seesAllMessages: true }), chat({ chatId: "-1000000000202", title: "Lounge", readdToApply: true })],
  });
  expect(chatPage(status, "-1000000000202")).toContain("Re-add the bot to this group");
  expect(chatPage(status)).not.toContain("admin here");
});

test("an empty chat list explains how a chat appears", () => {
  const html = render(connected({ chats: [] }));
  expect(html).toContain("/start@report_test_bot");
});

test("a failed read renders its sentence where it happened", () => {
  expect(render(DISCONNECTED_BOT_STATUS, { code: "invalid_token" })).toContain("That is not a bot token");
  expect(render(connected(), { code: "alias_taken" })).toContain("Another chat already uses that alias");
});

test("the panel renders one row for the bot below the personal account, and its read-only note moved with it", () => {
  const personal: TelegramConnectionState = {
    status: { phase: "disconnected", login: null, identity: null, credentialRef: null, credentialsConfigured: true, lastHealthCheckAt: null, error: null },
    busy: false,
    failure: null,
    refresh: async () => {},
    connect: async () => {},
    submitPassword: async () => {},
    cancel: async () => {},
    logout: async () => {},
    deleteLocal: async () => {},
    saveCredentials: async () => {},
  };
  const html = renderToStaticMarkup(<TelegramPanel state={personal} bot={stateFor(connected())} onClose={() => {}} />);
  const personalAt = html.indexOf("Personal account");
  const noteAt = html.indexOf("Read-only · operator sessions only");
  const botAt = html.indexOf("data-telegram-bot-entry");
  expect(personalAt).toBeGreaterThan(-1);
  expect(noteAt).toBeGreaterThan(personalAt);
  expect(botAt).toBeGreaterThan(html.indexOf("Connect Telegram"));
  expect(html).toContain("Report Bot");
  expect(html).not.toContain("Team Reports");
});

test("each chat names the projects the operator chose it for, and a chosen chat that refuses posts says so", () => {
  const status = connected({
    chats: [
      chat({ alias: "team-reports", postAllowed: true, postable: true, reports: [{ name: "Widgets" }] }),
      chat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge", reports: [{ name: "Atlas", refused: true }] }),
      chat({ chatId: "-1000000000303", title: "Open Lobby", alias: "open-lobby", postAllowed: true, postable: true }),
    ],
  });
  const chosen = chatPage(status);
  expect(chosen).toContain('data-telegram-chat-reports="chosen"');
  expect(chosen).toContain("Orchestrator reports: Widgets");
  expect(chosen).not.toContain("only chat agents may post in");
  const refused = chatPage(status, "-1000000000202");
  expect(refused).toContain('data-telegram-chat-reports="refused"');
  expect(refused).toContain("Orchestrator reports: Atlas. Posts are refused here now, so they reach the log only: switch posting on or pick another chat");
  expect(chatPage(status, "-1000000000303")).not.toContain("data-telegram-chat-reports=");
});
