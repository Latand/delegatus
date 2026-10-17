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
async function mount(documents: TelegramBotStatusPayload["documents"] = { roots: ["/fixture-home/handoff"], custom: false }): Promise<{ saves: Array<[string, string, boolean]>; rootSaves: string[][]; section: HTMLElement }> {
  const saves: Array<[string, string, boolean]> = [];
  const rootSaves: string[][] = [];
  const status: TelegramBotStatusPayload = {
    ...DISCONNECTED_BOT_STATUS,
    connected: true,
    bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
    receiving: "polling",
    chats: CHATS,
    documents,
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

const switchFor = (section: HTMLElement, title: string) =>
  section.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Agents may post: ${title}"]`)!;
const fieldFor = (section: HTMLElement, title: string) =>
  section.querySelector<HTMLInputElement>(`input[aria-label="Alias agents use: ${title}"]`);

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

test("document folders: the default shows as a hint, and a save sends one trimmed path per line", async () => {
  const { rootSaves, section } = await mount();
  const field = section.querySelector<HTMLTextAreaElement>("[data-telegram-document-roots-input]")!;
  const save = section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-save]")!;
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("/fixture-home/handoff");
  expect(section.textContent).toContain("Using the default folder.");
  expect(save.disabled).toBe(true);
  await type(field, "  /fixture-home/handoff \n\n/fixture-home/reports\n");
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(rootSaves).toEqual([["/fixture-home/handoff", "/fixture-home/reports"]]);
});

test("document folders: operator roots fill the field, and emptying it returns to the default", async () => {
  const { rootSaves, section } = await mount({ roots: ["/fixture-home/reports"], custom: true });
  const field = section.querySelector<HTMLTextAreaElement>("[data-telegram-document-roots-input]")!;
  expect(field.value).toBe("/fixture-home/reports");
  expect(section.textContent).not.toContain("Using the default folder.");
  await type(field, "");
  await act(async () => section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-save]")!.click());
  expect(rootSaves).toEqual([[]]);
});

test("document folders: the field shows every root, a wrapped one included, instead of a fixed two rows", async () => {
  const roots = ["/fixture-home/handoff", "/fixture-home/reports/weekly-summaries-for-the-team", "/fixture-home/exports"];
  const { section } = await mount({ roots, custom: true });
  const field = section.querySelector<HTMLTextAreaElement>("[data-telegram-document-roots-input]")!;
  /* Without layout, one row per root. */
  expect(field.getAttribute("rows")).toBe("3");
  await type(field, `${roots.join("\n")}\n/fixture-home/drafts`);
  expect(field.getAttribute("rows")).toBe("4");

  /* With layout, the height follows the content, so a root that wraps at
     390 px keeps the next one in view. The DOM reports the wrapped height. */
  const prototype = dom.HTMLTextAreaElement.prototype as unknown as HTMLTextAreaElement;
  const scrollHeight = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  Object.defineProperty(prototype, "scrollHeight", { configurable: true, get() { return 6 * 15; } });
  try {
    await type(field, roots.join("\n"));
    expect(field.style.height).toBe("90px");
  } finally {
    if (scrollHeight) Object.defineProperty(prototype, "scrollHeight", scrollHeight);
    else delete (prototype as unknown as Record<string, unknown>).scrollHeight;
  }
  expect(field.className).not.toContain("resize-y");
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
  function Live() {
    return <TelegramBotSection state={useTelegramBot(true)} />;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Live />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    section: container,
    posts,
    answer: (response: Response) => act(async () => { answer(response); await new Promise((resolve) => setTimeout(resolve, 0)); }),
    restore: () => { globalThis.fetch = saved; },
  };
}

test("a chat's posting switch flips at once, only that row waits, a second tap sends nothing, and a refusal flips it back with the reason", async () => {
  const live = await mountLive();
  try {
    expect(switchFor(live.section, "Реліз").getAttribute("aria-checked")).toBe("false");
    const field = fieldFor(live.section, "Реліз")!;
    await type(field, "release");
    await tapAfterTyping(field, switchFor(live.section, "Реліз"));
    expect(switchFor(live.section, "Реліз").getAttribute("aria-checked")).toBe("true");
    expect(switchFor(live.section, "Реліз").disabled).toBe(true);
    expect(switchFor(live.section, "Team Reports").disabled).toBe(false);
    await act(async () => switchFor(live.section, "Реліз").click());
    expect(live.posts).toEqual([{ action: "chat", chatId: "-1000000000505", alias: "release", postAllowed: true }]);
    await live.answer(Response.json({ code: "alias_taken" }, { status: 409 }));
    expect(switchFor(live.section, "Реліз").getAttribute("aria-checked")).toBe("false");
    /* The field returns to the stored (empty) alias, so the switch waits for one again. */
    expect(fieldFor(live.section, "Реліз")!.value).toBe("");
    expect(fieldFor(live.section, "Реліз")!.disabled).toBe(false);
    expect(live.section.textContent).toContain("Another chat already uses that alias.");
  } finally { live.restore(); }
});

test("document folders close on the press and list the saved roots, and a refusal reopens the form with the typed paths", async () => {
  const live = await mountLive();
  try {
    const field = () => live.section.querySelector<HTMLTextAreaElement>("[data-telegram-document-roots-input]")!;
    const save = () => live.section.querySelector<HTMLButtonElement>("[data-telegram-document-roots-save]")!;
    await type(field(), "/fixture-home/reports");
    await act(async () => save().click());
    expect(field().value).toBe("/fixture-home/reports");
    expect(live.section.textContent).not.toContain("Using the default folder.");
    expect(save().disabled).toBe(true);
    expect(live.posts).toEqual([{ action: "documents", roots: ["/fixture-home/reports"] }]);
    await live.answer(Response.json({ code: "document_roots_invalid" }, { status: 400 }));
    expect(field().value).toBe("/fixture-home/reports");
    /* Save is pressable again: the typed paths differ from the stored default. */
    expect(save().disabled).toBe(false);
    expect(live.section.querySelector('[role="alert"]')).not.toBeNull();
  } finally { live.restore(); }
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
    function Live() {
      return <TelegramBotSection state={useTelegramBot(true)} />;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    try {
      await act(async () => root!.render(<Live />));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const section = container;
      const checked = (title: string) => switchFor(section, title).getAttribute("aria-checked");
      /* Team Reports is switched off; Реліз gets an alias and is switched on. */
      await act(async () => switchFor(section, "Team Reports").click());
      const field = fieldFor(section, "Реліз")!;
      await type(field, "release");
      await tapAfterTyping(field, switchFor(section, "Реліз"));
      expect([checked("Team Reports"), checked("Реліз")]).toEqual(["false", "true"]);
      expect(posts.map((post) => post.chatId)).toEqual(["-1000000000101", "-1000000000505"]);
      const releaseStored = { ...status, chats: status.chats.map((entry) => (entry.chatId === "-1000000000505" ? { ...entry, alias: "release", postAllowed: true, postable: true } : entry)) };
      if (order === "the other chat answers first") {
        await answer("-1000000000505", Response.json({ bot: releaseStored }));
        await answer("-1000000000101", Response.json({ code: "action_failed" }, { status: 500 }));
      } else {
        await answer("-1000000000101", Response.json({ code: "action_failed" }, { status: 500 }));
        /* Реліз is still on its way: it stays drawn on. */
        expect([checked("Team Reports"), checked("Реліз")]).toEqual(["true", "true"]);
        await answer("-1000000000505", Response.json({ bot: releaseStored }));
      }
      expect([checked("Team Reports"), checked("Реліз")]).toEqual(["true", "true"]);
      expect(fieldFor(section, "Реліз")!.value).toBe("release");
      expect(posts).toHaveLength(2);
    } finally { globalThis.fetch = saved; }
  });
}
