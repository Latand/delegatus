import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { DISCONNECTED_BOT_STATUS, type TelegramBotChatView, type TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";
import { installActEnv } from "@/test-helpers/actEnv";

import { TelegramBotSection } from "./TelegramBot";

/* The chat row's posting switch (docs/design/telegram-bot-account.md,
   Decision 8): one tap allows a chat, and a field's save on blur never
   swallows the tap that caused the blur. */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  FocusEvent: dom.FocusEvent,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

/* Invented chats. */
function chat(overrides: Partial<TelegramBotChatView>): TelegramBotChatView {
  return {
    chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true,
    alias: null, postAllowed: false, postable: false, seesAllMessages: false, readdToApply: false,
    lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0,
    ...overrides,
  };
}

const CHATS = [
  chat({ alias: "team-reports", postAllowed: true, postable: true }),
  chat({ chatId: "700000303", title: "Person A", type: "private", seesAllMessages: true }),
  /* A title with no latin letters suggests no alias. */
  chat({ chatId: "-1000000000505", title: "Реліз", type: "group" }),
];

/**
 * Mounts the section the way the hook drives it: a save marks the section
 * busy at once, which disables its controls, exactly as `act()` does.
 */
async function mount(): Promise<{ saves: Array<[string, string, boolean]>; section: HTMLElement }> {
  const saves: Array<[string, string, boolean]> = [];
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS,
    connected: true,
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    chats: CHATS,
  };
  const render = (busy: boolean) => root!.render(<TelegramBotSection state={stateFor(busy)} />);
  const stateFor = (busy: boolean): TelegramBotState => ({
    status,
    busy,
    failure: null,
    refresh: async () => {},
    connect: async () => {},
    setChat: async (chatId, alias, postAllowed) => {
      saves.push([chatId, alias, postAllowed]);
      render(true);
    },
    addChat: async () => null,
    testPost: async () => false,
    remove: async () => {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => render(false));
  return { saves, section: container };
}

const switchFor = (section: HTMLElement, title: string) =>
  section.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Agents may post: ${title}"]`)!;
const fieldFor = (section: HTMLElement, title: string) =>
  section.querySelector<HTMLInputElement>(`input[aria-label="Alias agents use: ${title}"]`);

/* React's own onChange for the controlled field: order-independent across
   test files, unlike a dispatched input event. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  await act(async () => props.onChange({ target: { value } }));
}

/* A tap on the switch after typing: pointerdown on the switch, the field's
   blur toward it, then the click. */
async function tapAfterTyping(input: HTMLInputElement, button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new dom.Event("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await act(async () => {
    input.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true, relatedTarget: button as never }) as unknown as Event);
  });
  await act(async () => button.click());
}

test("switching on a chat with no alias adopts the suggested one in a single save", async () => {
  const { saves, section } = await mount();
  /* Off and suggestible: one line, no field to fill. */
  expect(fieldFor(section, "Person A")).toBeNull();
  const button = switchFor(section, "Person A");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(saves).toEqual([["700000303", "person-a", true]]);
});

test("an alias typed for a chat that suggests none, then the switch, is one save that allows posting", async () => {
  const { saves, section } = await mount();
  const input = fieldFor(section, "Реліз")!;
  const button = switchFor(section, "Реліз");
  expect(button.disabled).toBe(true);
  expect(section.textContent).toContain("Set an alias to allow posting");
  await type(input, "Release");
  expect(button.disabled).toBe(false);
  await tapAfterTyping(input, button);
  expect(saves).toEqual([["-1000000000505", "release", true]]);
});

test("renaming an allowed chat and switching it off is one save carrying both", async () => {
  const { saves, section } = await mount();
  const input = fieldFor(section, "Team Reports")!;
  expect(input.value).toBe("team-reports");
  await type(input, "team-weekly");
  await tapAfterTyping(input, switchFor(section, "Team Reports"));
  expect(saves).toEqual([["-1000000000101", "team-weekly", false]]);
});

test("a rename that leaves the field for anywhere else saves on blur, still allowed", async () => {
  const { saves, section } = await mount();
  const input = fieldFor(section, "Team Reports")!;
  await type(input, "team-weekly");
  await act(async () => {
    input.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
  });
  expect(saves).toEqual([["-1000000000101", "team-weekly", true]]);
});
