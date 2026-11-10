import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { translate } from "@/lib/i18n";
import { DISCONNECTED_BOT_STATUS, type TelegramBotChatView, type TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";
import { installActEnv } from "@/test-helpers/actEnv";

import type { SettingsSub } from "./settings/openSettings";
import { TelegramSectionView } from "./settings/TelegramSection";

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
  HTMLSelectElement: dom.HTMLSelectElement,
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

/* The section with its pages, as the Settings window drives it. */
function Paged({ state }: { state: TelegramBotState }) {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  return <><button type="button" data-test-back="" onClick={() => setSub(null)} /><TelegramSectionView state={state} sub={sub} go={setSub} back={() => setSub(null)} /></>;
}
function LivePaged({ useState: read }: { useState: () => TelegramBotState }) {
  return <Paged state={read()} />;
}
const goBack = async (section: HTMLElement) => { await act(async () => section.querySelector<HTMLButtonElement>("[data-test-back]")!.click()); };

/**
 * Mounts the section the way the hook drives it: a save marks the section
 * busy at once, which disables its controls, exactly as `act()` does.
 */
async function mount(documents: TelegramBotStatusPayload["documents"] = { roots: ["/fixture-home/handoff"], custom: false },
  overrides: Partial<TelegramBotStatusPayload> = {}): Promise<{ saves: Array<[string, string, boolean]>; rootSaves: string[][]; section: HTMLElement }> {
  const saves: Array<[string, string, boolean]> = [];
  const rootSaves: string[][] = [];
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS,
    connected: true,
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    chats: CHATS,
    documents,
    ...overrides,
  };
  const render = (busy: boolean) => root!.render(<Paged state={stateFor(busy)} />);
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
    setDocumentRoots: async (roots) => {
      rootSaves.push(roots);
      return true;
    },
    remove: async () => {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => render(false));
  return { saves, rootSaves, section: container };
}

const openChat = async (section: HTMLElement, chatId: string) => {
  await act(async () => section.querySelector<HTMLButtonElement>(`[data-telegram-chat-row="${chatId}"] [data-settings-row="link"]`)!.click());
};
const switchOf = (section: HTMLElement) => section.querySelector<HTMLButtonElement>("[data-telegram-chat-switch]")!;
const fieldFor = (section: HTMLElement, title: string) =>
  section.querySelector<HTMLInputElement>(`input[aria-label="Alias agents use: ${title}"]`);
const openFolders = async (section: HTMLElement) => {
  await act(async () => section.querySelector<HTMLButtonElement>('[data-telegram-folders-row] [data-settings-row="link"]')!.click());
};

test("paired clone groups stay visible and allowlisted while the bot token is disconnected", async () => {
  const cloneChat = chat({ bots: [{ name: "Report clone", username: null, assigned: false, member: true, status: null, canPost: true,
    canSendPhotos: false, canSendDocuments: false, canManageTopics: false, reason: null, checkedAt: null }] });
  const { saves, section } = await mount(undefined, { connected: false, bot: null, chats: [cloneChat] });
  expect(section.querySelector('input[type="password"]')).toBeNull();
  await openChat(section, "-1000000000101");
  const toggle = switchOf(section);
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle.click());
  expect(saves).toEqual([["-1000000000101", "team-reports", true]]);
});

/* React's own onChange for the controlled field: order-independent across
   test files, unlike a dispatched input event. */
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
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
  await openChat(section, "700000303");
  /* Off and suggestible: no field to fill. */
  expect(fieldFor(section, "Person A")).toBeNull();
  const button = switchOf(section);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(saves).toEqual([["700000303", "person-a", true]]);
});

test("an alias typed for a chat that suggests none, then the switch, is one save that allows posting", async () => {
  const { saves, section } = await mount();
  await openChat(section, "-1000000000505");
  const input = fieldFor(section, "Реліз")!;
  const button = switchOf(section);
  expect(button.disabled).toBe(true);
  expect(section.textContent).toContain("Set an alias to allow posting");
  await type(input, "Release");
  expect(button.disabled).toBe(false);
  await tapAfterTyping(input, button);
  expect(saves).toEqual([["-1000000000505", "release", true]]);
});

test("renaming an allowed chat and switching it off is one save carrying both", async () => {
  const { saves, section } = await mount();
  await openChat(section, "-1000000000101");
  const input = fieldFor(section, "Team Reports")!;
  expect(input.value).toBe("team-reports");
  await type(input, "team-weekly");
  await tapAfterTyping(input, switchOf(section));
  expect(saves).toEqual([["-1000000000101", "team-weekly", false]]);
});

test("a rename that leaves the field for anywhere else saves on blur, still allowed", async () => {
  const { saves, section } = await mount();
  await openChat(section, "-1000000000101");
  const input = fieldFor(section, "Team Reports")!;
  await type(input, "team-weekly");
  await act(async () => {
    input.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
  });
  expect(saves).toEqual([["-1000000000101", "team-weekly", true]]);
});

test("document folders: the default shows as a row, and adding a folder replaces it with the operator's list", async () => {
  const { rootSaves, section } = await mount();
  await openFolders(section);
  const field = section.querySelector<HTMLInputElement>("[data-telegram-document-roots-input]")!;
  const save = section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-save]")!;
  expect(field.value).toBe("");
  expect(section.querySelector('[data-telegram-document-root="/fixture-home/handoff"]')).not.toBeNull();
  expect(section.textContent).toContain("Using the default folder.");
  expect(section.querySelector("[data-telegram-document-root-remove]")).toBeNull();
  expect(save.disabled).toBe(true);
  await type(field, "  /fixture-home/reports ");
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(rootSaves).toEqual([["/fixture-home/reports"]]);
});

test("document folders: operator roots are rows, each removable, and the default comes back on request", async () => {
  const { rootSaves, section } = await mount({ roots: ["/fixture-home/reports", "/fixture-home/exports"], custom: true });
  await openFolders(section);
  expect(section.textContent).not.toContain("Using the default folder.");
  await act(async () => section.querySelector<HTMLButtonElement>('[data-telegram-document-root="/fixture-home/reports"] [data-telegram-document-root-remove]')!.click());
  await act(async () => section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-default]")!.click());
  expect(rootSaves).toEqual([["/fixture-home/exports"], []]);
});

/* Audit B38, B39: through the real hook, a chat's switch, its alias and the
   document folders show at once; only the written chat waits, and a refusal
   puts the stored value back with the failure line. */
async function mountLive(documents: TelegramBotStatusPayload["documents"] = { roots: ["/fixture-home/handoff"], custom: false }) {
  const { useTelegramBot } = await import("@/hooks/useTelegramBot");
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS,
    connected: true,
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    chats: CHATS,
    documents,
  };
  const posts: Array<Record<string, unknown>> = [];
  let answer: (response: Response) => void = () => {};
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ bot: status });
    posts.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => { answer = resolve; });
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<LivePaged useState={() => useTelegramBot(true)} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    section: container,
    posts,
    answer: (response: Response) => act(async () => { answer(response); await new Promise((resolve) => setTimeout(resolve, 0)); }),
    restore: () => { globalThis.fetch = saved; },
  };
}

test("a chat's posting switch flips at once, only that chat waits, a second tap sends nothing, and a refusal flips it back with the reason", async () => {
  const live = await mountLive();
  try {
    await openChat(live.section, "-1000000000505");
    expect(switchOf(live.section).getAttribute("aria-checked")).toBe("false");
    const field = fieldFor(live.section, "Реліз")!;
    await type(field, "release");
    await tapAfterTyping(field, switchOf(live.section));
    expect(switchOf(live.section).getAttribute("aria-checked")).toBe("true");
    expect(switchOf(live.section).disabled).toBe(true);
    await act(async () => switchOf(live.section).click());
    expect(live.posts).toEqual([{ action: "chat", chatId: "-1000000000505", alias: "release", postAllowed: true }]);
    /* Another chat's page does not wait. */
    await goBack(live.section);
    await openChat(live.section, "-1000000000101");
    expect(switchOf(live.section).disabled).toBe(false);
    await goBack(live.section);
    await openChat(live.section, "-1000000000505");
    await live.answer(Response.json({ code: "alias_taken" }, { status: 409 }));
    expect(switchOf(live.section).getAttribute("aria-checked")).toBe("false");
    /* The field returns to the stored (empty) alias, so the switch waits for one again. */
    expect(fieldFor(live.section, "Реліз")!.value).toBe("");
    expect(fieldFor(live.section, "Реліз")!.disabled).toBe(false);
    expect(live.section.textContent).toContain("Another chat already uses that alias.");
  } finally { live.restore(); }
});

test("a folder lists as saved on the press, and a refusal puts the typed path back with the reason", async () => {
  const live = await mountLive();
  try {
    await openFolders(live.section);
    const field = () => live.section.querySelector<HTMLInputElement>("[data-telegram-document-roots-input]")!;
    await type(field(), "/fixture-home/reports");
    await act(async () => live.section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-save]")!.click());
    expect(live.section.querySelector('[data-telegram-document-root="/fixture-home/reports"]')).not.toBeNull();
    expect(field().value).toBe("");
    expect(live.section.textContent).not.toContain("Using the default folder.");
    expect(live.posts).toEqual([{ action: "documents", roots: ["/fixture-home/reports"] }]);
    await live.answer(Response.json({ code: "document_roots_invalid" }, { status: 400 }));
    expect(field().value).toBe("/fixture-home/reports");
    expect(live.section.querySelector('[data-telegram-document-root="/fixture-home/handoff"]')).not.toBeNull();
    expect(live.section.querySelector('[role="alert"]')).not.toBeNull();
  } finally { live.restore(); }
});

test("«Posts as» shows the choice at once and a refusal puts the stored sender back with the reason", async () => {
  const { useTelegramBot } = await import("@/hooks/useTelegramBot");
  const posting = (name: string, username: string) => ({ name, username, assigned: false, member: true, status: "member" as const, canPost: true, canSendPhotos: true, canSendDocuments: true, canManageTopics: false, reason: null, checkedAt: null });
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS, connected: true, receiving: "polling",
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    chats: [chat({ alias: "team-reports", postAllowed: true, postable: true, bots: [posting("Report Bot", "report_test_bot"), posting("Second Bot", "second_test_bot")], assignedBot: null })],
  };
  let answer: (response: Response) => void = () => {};
  const posts: unknown[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ bot: status });
    posts.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => { answer = resolve; });
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  try {
    await act(async () => root!.render(<LivePaged useState={() => useTelegramBot(true)} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await openChat(container, "-1000000000101");
    const select = () => container!.querySelector<HTMLSelectElement>("[data-telegram-posts-as]")!;
    /* Only bots that may post and have a username; the choice is drawn before the answer. */
    expect([...select().options].map((option) => option.value)).toEqual(["", "report_test_bot", "second_test_bot"]);
    await act(async () => { select().value = "second_test_bot"; select().dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event); });
    expect(select().value).toBe("second_test_bot");
    expect(posts).toEqual([{ action: "chat_bot", chatId: "-1000000000101", bot: "second_test_bot" }]);
    await act(async () => { answer(Response.json({ code: "forbidden" }, { status: 403 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(select().value).toBe("");
    expect(container.querySelector('[data-telegram-failure="forbidden"]')).not.toBeNull();
  } finally { globalThis.fetch = saved; }
});

/* Two chats written at once, answered in each order: a refusal takes back only
   its own chat, and the other chat keeps what was drawn for it or what the
   server answered. */
for (const order of ["the other chat answers first", "the refusal answers first"] as const) {
  test(`a refused chat write leaves another chat's write standing (${order})`, async () => {
    const { useTelegramBot } = await import("@/hooks/useTelegramBot");
    const status: TelegramBotStatusPayload = {
      ...DISCONNECTED_BOT_STATUS,
      connected: true,
      bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
      receiving: "polling",
      chats: CHATS,
      documents: { roots: ["/fixture-home/handoff"], custom: false },
    };
    const pending = new Map<string, (response: Response) => void>();
    const posts: Array<Record<string, unknown>> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ bot: status });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return new Promise<Response>((resolve) => { pending.set(String(body.chatId), resolve); });
    }) as typeof fetch;
    const answer = (chatId: string, response: Response) => act(async () => { pending.get(chatId)!(response); await new Promise((resolve) => setTimeout(resolve, 0)); });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    try {
      await act(async () => root!.render(<LivePaged useState={() => useTelegramBot(true)} />));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const section = container;
      const TEAM = "-1000000000101", RELEASE = "-1000000000505";
      const checkedOn = async (chatId: string) => {
        await goBack(section);
        await openChat(section, chatId);
        return switchOf(section).getAttribute("aria-checked");
      };
      const checks = async () => [await checkedOn(TEAM), await checkedOn(RELEASE)];
      /* Team Reports is switched off; Реліз gets an alias and is switched on. */
      await openChat(section, TEAM);
      await act(async () => switchOf(section).click());
      await goBack(section);
      await openChat(section, RELEASE);
      const field = fieldFor(section, "Реліз")!;
      await type(field, "release");
      await tapAfterTyping(field, switchOf(section));
      expect(await checks()).toEqual(["false", "true"]);
      expect(posts.map((post) => post.chatId)).toEqual(["-1000000000101", "-1000000000505"]);
      const releaseStored = { ...status, chats: status.chats.map((entry) => (entry.chatId === "-1000000000505" ? { ...entry, alias: "release", postAllowed: true, postable: true } : entry)) };
      if (order === "the other chat answers first") {
        await answer("-1000000000505", Response.json({ bot: releaseStored }));
        await answer("-1000000000101", Response.json({ code: "action_failed" }, { status: 500 }));
      } else {
        await answer("-1000000000101", Response.json({ code: "action_failed" }, { status: 500 }));
        /* Реліз is still on its way: it stays drawn on. */
        expect(await checks()).toEqual(["true", "true"]);
        await answer("-1000000000505", Response.json({ bot: releaseStored }));
      }
      expect(await checks()).toEqual(["true", "true"]);
      expect(fieldFor(section, "Реліз")!.value).toBe("release");
      expect(posts).toHaveLength(2);
    } finally { globalThis.fetch = saved; }
  });
}

test("a test post's success goes away on the next press, so a later refusal reads alone", async () => {
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS, connected: true, receiving: "polling",
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true }, chats: CHATS,
  };
  let failure: TelegramBotState["failure"] = null;
  let answer: (sent: boolean) => void = () => {};
  const state = (): TelegramBotState => ({
    status, busy: false, failure, refresh: async () => {}, connect: async () => {}, setChat: async () => {}, addChat: async () => null,
    setDocumentRoots: async () => true, remove: async () => {},
    testPost: () => new Promise<boolean>((resolve) => { answer = (sent) => { if (!sent) failure = { code: "action_failed" }; resolve(sent); }; }),
  });
  const render = () => root!.render(<Paged state={state()} />);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => render());
  await openChat(container, "-1000000000101");
  const press = () => act(async () => container!.querySelector<HTMLButtonElement>("[data-telegram-chat-test]")!.click());
  const sent = () => container!.querySelector("[role='status']")?.textContent ?? null;
  const settle = (ok: boolean) => act(async () => { answer(ok); await new Promise((resolve) => setTimeout(resolve, 0)); render(); });
  await press();
  await settle(true);
  expect(sent()).toBe("Test post sent to Team Reports.");
  await press();
  expect(sent()).toBeNull();
  await settle(false);
  expect(sent()).toBeNull();
  expect(container.querySelector("[data-telegram-failure='action_failed']")).not.toBeNull();
});

test("the bot page carries one time at rest, and the bot's popover adds the check to the row's word", async () => {
  const { section } = await mount(undefined, { lastUpdateAt: "2026-11-05T08:29:00.000Z", lastCheckedAt: "2026-11-05T08:30:00.000Z" });
  const row = section.querySelector<HTMLElement>("[data-telegram-bot-row]")!;
  const note = row.querySelector("[data-settings-dot]")!.getAttribute("aria-label")!;
  expect(note).toContain(translate("en", "settings.telegram.note.pollingChecked", { time: "\u0000" }).split("\u0000")[0]!);
  expect(note.toLowerCase()).not.toContain(translate("en", "settings.telegram.word.polling").toLowerCase());
  await act(async () => row.querySelector<HTMLButtonElement>("[data-settings-row='link']")!.click());
  const page = section.querySelector<HTMLElement>("[data-telegram-bot-page]")!;
  expect(page.textContent!.match(/\d\d:\d\d/g)?.length).toBe(1);
});

test("the chat page says what it knows above the alias, so no line under the field reads as its hint", async () => {
  const { section } = await mount(undefined, { chats: [chat({ alias: "team-reports", postAllowed: true, readdToApply: true, lastPostAt: "2026-11-05T08:00:00.000Z", lastPostBy: { unidentified: true },
    lastDelivery: { at: "2026-11-05T08:00:00.000Z", state: "refused", refusals: [] } })] });
  await openChat(section, "-1000000000101");
  const alias = section.querySelector("[data-telegram-chat-alias]")!.closest("[data-settings-row='field']")!;
  expect(alias.nextElementSibling?.getAttribute("data-settings-row")).not.toBe("text");
  expect(section.querySelector("[data-telegram-chat-page]")!.textContent).toContain(translate("en", "telegram.bot.readd"));
});

for (const posting of [true, false]) test(`reports refused in a chat whose posting is ${posting ? "on" : "off"} advise the real action`, async () => {
  const { section } = await mount(undefined, { chats: [chat({ alias: "team-reports", postAllowed: posting, postable: false, reports: [{ name: "Atlas", refused: true }] })] });
  await openChat(section, "-1000000000101");
  const line = section.querySelector("[data-telegram-chat-page] [data-telegram-chat-reports='refused']")!.textContent;
  expect(line).toBe(translate("en", posting ? "telegram.bot.reportsRefusedPosting" : "telegram.bot.reportsRefused", { names: "Atlas" }));
  expect(section.querySelector("[data-telegram-chat-switch]")!.getAttribute("aria-checked")).toBe(String(posting));
  if (posting) expect(line!.toLowerCase()).not.toContain("switch posting on");
});
