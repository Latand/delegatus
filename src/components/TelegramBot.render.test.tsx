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

test("connected with mixed chats: name, receiving state, per-chat alias and switch, inactive chats grouped", () => {
  const html = render(connected());
  expect(html).toContain("Report Bot");
  expect(html).toContain("@report_test_bot");
  expect(html).toContain("Receiving messages");
  expect(html).toContain("Privacy mode on");
  expect(html).toContain("Team Reports");
  expect(html).toContain('value="team-reports"');
  expect(html).toContain('role="switch" aria-checked="true"');
  expect(html).toContain('role="switch" aria-checked="false"');
  expect(html).toContain("Set an alias to allow posting");
  expect(html).toContain("Weekly report writer");
  expect(html).toContain("topics");
  expect(html).toContain("No longer a member (1)");
  expect(html).toContain("Sees only mentions and replies");
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
