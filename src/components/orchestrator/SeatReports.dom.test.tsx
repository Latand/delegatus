import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import { DISCONNECTED_BOT_STATUS, type TelegramBotChatView, type TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";
import { installActEnv } from "@/test-helpers/actEnv";

import { SeatReportsBody, seatReportsReading, useProjectReports } from "./SeatReports";

/* The orchestrator's Reports section (docs/design/orchestrator-reports.md
   §5.6): the opt-in stays explicit, the picker lists the chats the bot may
   post in, a chat added by id is picked in place, and every write names its
   own project. */

const dom = new Window({ url: "http://127.0.0.1:8899/" });
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

/* Invented chats. */
function chat(overrides: Partial<TelegramBotChatView>): TelegramBotChatView {
  return {
    chatId: "-1000000000101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true,
    alias: "team-reports", postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false,
    lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0,
    ...overrides,
  };
}

type Stored = { chat: string | null; name?: string } | null;
let stored: Record<string, Stored>;
let puts: Array<{ project: string; reportTelegram: unknown }>;
let botPosts: Array<Record<string, unknown>>;
let chats: TelegramBotChatView[];
const originalFetch = globalThis.fetch;

function botStatus(): TelegramBotStatusPayload {
  return { ...DISCONNECTED_BOT_STATUS, connected: true, receiving: "webhook_elsewhere", bot: { name: "Report Bot", username: null, canReadAllGroupMessages: false, canJoinGroups: true }, chats };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  stored = { "repo-alpha": null, "repo-beta": { chat: "team-reports", name: "Beta" } };
  puts = [];
  botPosts = [];
  chats = [chat({}), chat({ chatId: "-1000000000202", title: "Design Lounge", alias: "design-lounge" })];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:8899");
    if (url.pathname === "/api/projects/settings") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { project: string; reportTelegram: Stored };
        puts.push(body);
        stored[body.project] = body.reportTelegram ?? { chat: null };
        return json({ ok: true, project: body.project, reportTelegram: stored[body.project], reportNameSuggestion: null });
      }
      const project = url.searchParams.get("project")!;
      return json({ ok: true, project, reportTelegram: stored[project] ?? null, reportNameSuggestion: project === "repo-alpha" ? "Alpha" : null });
    }
    if (url.pathname === "/api/telegram/bot") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        botPosts.push(body);
        if (body.action === "add") {
          chats = [...chats, chat({ chatId: "-1000000000404", title: "Release Notes", alias: "release-notes" })];
          return json({ bot: botStatus(), added: { chat: "release-notes", chatId: "-1000000000404" } });
        }
      }
      return json({ bot: botStatus() });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
});

function Section({ project }: { project: string }) {
  const reports = useProjectReports(project);
  return <SeatReportsBody project={project} projectName={project} reports={reports} surface="desktop" />;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(project: string): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Section project={project} />));
  await settle();
  return container;
}

const q = <T extends Element>(scope: HTMLElement, selector: string) => scope.querySelector(selector) as T | null;

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

/* React's own handlers, order-independent across test files. */
function reactProps(element: Element): Record<string, (event: unknown) => void> {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]!;
}

test("a project that never chose reports to the log only; switching on writes nothing until a group is picked and saved", async () => {
  const section = await mount("repo-alpha");
  expect(q<HTMLButtonElement>(section, "[data-seat-reports-switch]")!.getAttribute("aria-checked")).toBe("false");
  expect(q(section, "[data-seat-reports-line]")!.textContent).toBe("Reports go to the log only.");

  await click(q(section, "[data-seat-reports-switch]"));
  expect(puts).toEqual([]);
  expect(q(section, "[data-seat-reports-line]")!.textContent).toContain("Until then they go to the log only");
  const radios = [...section.querySelectorAll<HTMLElement>("[data-seat-reports-chat]")].map((node) => [node.dataset.seatReportsChat, node.getAttribute("aria-checked")]);
  expect(radios).toEqual([["team-reports", "false"], ["design-lounge", "false"]]);
  expect(q<HTMLButtonElement>(section, "[data-seat-reports-save]")!.disabled).toBe(true);
  expect(q(section, "[data-seat-reports-warning]")!.textContent).toContain("may be public");

  await click(q(section, '[data-seat-reports-chat="design-lounge"]'));
  expect(q<HTMLInputElement>(section, "[data-seat-reports-name]")!.value).toBe("Alpha");
  await click(q(section, "[data-seat-reports-save]"));
  expect(puts).toEqual([{ project: "repo-alpha", reportTelegram: { chat: "design-lounge", name: "Alpha" } }]);
  expect(q(section, "[data-seat-reports-line]")!.textContent).toBe("Reports go to the log and to Design Lounge.");

  /* Off on a project that posts stores "Log only" for this project alone. */
  await click(q(section, "[data-seat-reports-switch]"));
  expect(puts.at(-1)).toEqual({ project: "repo-alpha", reportTelegram: null });
  expect(stored["repo-beta"]).toEqual({ chat: "team-reports", name: "Beta" });
});

test("a chat added by id in the picker is picked in place and saved for this project", async () => {
  const section = await mount("repo-beta");
  expect(q(section, "[data-seat-reports-line]")!.textContent).toBe("Reports go to the log and to Team Reports.");
  expect(q(section, '[data-seat-reports-chat="team-reports"]')!.getAttribute("aria-checked")).toBe("true");

  const input = q<HTMLInputElement>(section, "[data-telegram-add-chat-input]")!;
  await act(async () => reactProps(input).onChange!({ target: { value: "-1000000000404" } }));
  await act(async () => reactProps(input.closest("form")!).onSubmit!({ preventDefault() {} }));
  await settle();
  expect(botPosts).toEqual([{ action: "add", chat: "-1000000000404" }]);
  expect(q(section, "[data-telegram-add-chat-added]")!.textContent).toBe("Release Notes added: agents may post there as release-notes.");
  expect(q(section, '[data-seat-reports-chat="release-notes"]')!.getAttribute("aria-checked")).toBe("true");

  await click(q(section, "[data-seat-reports-save]"));
  expect(puts).toEqual([{ project: "repo-beta", reportTelegram: { chat: "release-notes", name: "Beta" } }]);
  expect(stored["repo-alpha"]).toBeNull();
});

/* The closed chip names a chat by the title the picker shows: two aliases
   that share their first fifteen characters truncate alike, their titles do
   not. Without a known title it falls back to the alias. */
test("the chip's value is the chosen chat's title, the alias only without one, and Log when nothing posts", () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
  const reviews = seatReportsReading({ reportTelegram: { chat: "atlas-design-reviews", name: "Atlas" }, reportChatTitle: "Design review", reportNameSuggestion: null }, t);
  const release = seatReportsReading({ reportTelegram: { chat: "atlas-design-release", name: "Atlas" }, reportChatTitle: "Release notes", reportNameSuggestion: null }, t);
  expect(reviews).toEqual({ face: "Design review", line: "Reports go to the log and to Design review.", chat: "atlas-design-reviews" });
  expect(release.face).toBe("Release notes");
  expect(seatReportsReading({ reportTelegram: { chat: "atlas-design-reviews", name: "Atlas" }, reportChatTitle: null, reportNameSuggestion: null }, t).face).toBe("atlas-design-reviews");
  expect(seatReportsReading({ reportTelegram: { chat: null }, reportChatTitle: null, reportNameSuggestion: null }, t)).toEqual({ face: "Log", line: "Reports go to the log only.", chat: null });
  expect(seatReportsReading(null, t).face).toBe("Log");
});
