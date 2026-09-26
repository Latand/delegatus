import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import type { TelegramConnectionState } from "@/hooks/useTelegramConnection";
import { DISCONNECTED_BOT_STATUS, type TelegramBotChatView, type TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";

import { TelegramBotSection } from "./TelegramBot";
import { TelegramPanel } from "./TelegramConnect";

function stateFor(status: TelegramBotStatusPayload, failure: { code: string } | null = null): TelegramBotState {
  return {
    status,
    busy: false,
    failure,
    refresh: async () => {},
    connect: async () => {},
    setChat: async () => {},
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

const render = (status: TelegramBotStatusPayload, failure: { code: string } | null = null) =>
  renderToStaticMarkup(<TelegramBotSection state={stateFor(status, failure)} />);

test("disconnected: a password-type token field with no value, Connect, and the BotFather hint", () => {
  const html = render(DISCONNECTED_BOT_STATUS);
  expect(html).toContain("Bot token from @BotFather");
  expect(html).toContain("Connect bot");
  expect(html).toContain("/newbot");
  expect(html).toMatch(/<input[^>]*type="password"/);
  expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
  expect(html).toContain("What a bot can see");
  expect(html).not.toContain("Remove bot");
});

test("connected with mixed chats: name, receiving state, one compact row per chat, inactive chats grouped", () => {
  const html = render(connected());
  expect(html).toContain("Report Bot");
  expect(html).toContain("@report_test_bot");
  /* Polling is the green dot, and words only for a reader. */
  expect(html).toMatch(/<p role="status" class="sr-only">Receiving messages<\/p>/);
  expect(html).toContain("Team Reports");
  /* The alias field only where posting is on. */
  expect(html).toContain('value="team-reports"');
  expect(html.match(/<input type="text"/g)).toHaveLength(1);
  expect(html).toContain('role="switch" aria-checked="true" aria-label="Agents may post: Team Reports"');
  expect(html).toContain('role="switch" aria-checked="false" aria-label="Agents may post: Person A"');
  /* Every title here suggests an alias, so no row asks for one. */
  expect(html).not.toContain("Set an alias to allow posting");
  expect(html).toContain("Weekly report writer");
  expect(html).toContain("topics");
  expect(html).toContain("No longer a member (1)");
  /* A visibility line only where a group differs from the bot-wide state,
     with its reason; the bot-wide state sits in the collapsed note. */
  expect(html).toContain("Sees all messages: admin here");
  expect(html.match(/Sees all messages/g)).toHaveLength(1);
  expect(html.indexOf("Privacy mode on")).toBeGreaterThan(html.indexOf("What a bot can see"));
  expect(html).toContain("Remove bot");
  expect(html).toContain("/revoke");
  /* No token field once connected and healthy. */
  expect(html).not.toContain("Bot token from @BotFather");
});

test("a webhook elsewhere says reading is blocked and why", () => {
  const html = render(connected({ receiving: "webhook_elsewhere" }));
  expect(html).toContain("webhook elsewhere");
  expect(html).toContain("can post but not read");
});

test("a rejected token asks for a new one in place", () => {
  const html = render(connected({ receiving: "token_rejected" }));
  expect(html).toContain("Telegram rejected the token");
  expect(html).toContain("Bot token from @BotFather");
  expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
});

test("a chat whose title suggests no alias shows the field while off and says it needs one", () => {
  const html = render(connected({ chats: [chat({ chatId: "-1000000000505", title: "Реліз", type: "group" })] }));
  expect(html).toContain('aria-label="Alias agents use: Реліз"');
  expect(html).toContain("Set an alias to allow posting");
  expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Agents may post: Реліз" disabled=""/);
});

test("with privacy mode off, a group that still needs the bot re-added says so, and the rest say nothing", () => {
  const html = render(connected({
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: true, canJoinGroups: true },
    chats: [chat({ seesAllMessages: true }), chat({ chatId: "-1000000000202", title: "Lounge", readdToApply: true })],
  }));
  expect(html).toContain("Re-add the bot to this group");
  expect(html).not.toContain("admin here");
  expect(html).toContain("Privacy mode off");
});

test("an empty chat list explains how a chat appears", () => {
  const html = render(connected({ chats: [] }));
  expect(html).toContain("/start@report_test_bot");
});

test("a failed action renders its sentence", () => {
  expect(render(DISCONNECTED_BOT_STATUS, { code: "invalid_token" })).toContain("That is not a bot token");
  expect(render(connected(), { code: "alias_taken" })).toContain("Another chat already uses that alias");
});

test("the panel renders the Bot section below the personal account, whose read-only note moved with it", () => {
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
  const html = renderToStaticMarkup(<TelegramPanel state={personal} bot={stateFor(DISCONNECTED_BOT_STATUS)} onClose={() => {}} />);
  const personalAt = html.indexOf("Personal account");
  const noteAt = html.indexOf("Read-only · operator sessions only");
  const botAt = html.indexOf("Connect bot");
  expect(personalAt).toBeGreaterThan(-1);
  expect(noteAt).toBeGreaterThan(personalAt);
  expect(botAt).toBeGreaterThan(html.indexOf("Connect Telegram"));
});

test("each chat names the projects the operator chose it for, and a chosen chat that refuses posts says so", () => {
  const html = render(connected({
    chats: [
      chat({ alias: "team-reports", postAllowed: true, postable: true, reports: [{ name: "Widgets" }] }),
      chat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge", reports: [{ name: "Atlas", refused: true }] }),
      chat({ chatId: "-1000000000303", title: "Open Lobby", alias: "open-lobby", postAllowed: true, postable: true }),
    ],
  }));
  expect(html).toContain('data-telegram-chat-reports="chosen"');
  expect(html).toContain("Orchestrator reports: Widgets");
  expect(html).not.toContain("only chat agents may post in");
  expect(html).toContain('data-telegram-chat-reports="refused"');
  expect(html).toContain("Orchestrator reports: Atlas. Posts are refused here now, so they reach the log only: switch posting on or pick another chat");
  expect(html.match(/data-telegram-chat-reports=/g)).toHaveLength(2);
});
