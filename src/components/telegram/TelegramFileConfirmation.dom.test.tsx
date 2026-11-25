import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";
import type { FileConfirmationView } from "@/lib/telegram/bot/fileConfirmationContract";

/* The owner page for one Telegram file send, when the browser cannot confirm yet.
   The page says exactly what is missing, in the reader's language, and does the
   Telegram steps itself; it never sends the browser to /sign-in on its own, and
   after each step it asks the server again. */

const PAGE = "http://127.0.0.1:8898/telegram-file-confirmation?id=fixture-confirmation";
const harness = installOnboardingDom({ url: PAGE });
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TelegramFileConfirmation } = await import("./TelegramFileConfirmation");
const { fileConfirmationText, typesetFileConfirmation } = await import("@/lib/telegram/bot/fileConfirmationContract");
const { setLocale, translate } = await import("@/lib/i18n");

/* The page's waits (a poll every few seconds, a beat to read the name) sit in a queue the test advances by hand:
   nothing runs because time passed on the machine, so a loaded runner cannot change what a step shows. */
const POLL_MS = 3_000;
const CONFIRM_MS = 1_600;
type Timer = { id: number; callback: () => void; due: number };
const clock = { now: 0, nextId: 1, queue: [] as Timer[] };
const windowTimers = harness.dom as unknown as {
  setTimeout: (callback: () => void, delay?: number) => number;
  clearTimeout: (id?: number) => void;
};
windowTimers.setTimeout = (callback, delay) => {
  const id = clock.nextId++;
  clock.queue.push({ id, callback, due: clock.now + (delay ?? 0) });
  return id;
};
windowTimers.clearTimeout = id => { clock.queue = clock.queue.filter(timer => timer.id !== id); };

const VIEW: FileConfirmationView = {
  id: "fixture-confirmation", digest: "a".repeat(64), kind: "document", chatId: "-1000000000101", chatTitle: "Fixture reports", topicId: null,
  options: { conversationId: null, clientRequestId: "fixture", chat: "reports", topicId: null, replyToMessageId: null, format: "plain", silent: false,
    document: { path: "/sandbox/handoff/staffing.xlsx", filename: "staffing.xlsx", caption: null } },
  files: [{ path: "/sandbox/handoff/staffing.xlsx", resolvedPath: "/sandbox/handoff/staffing.xlsx", filename: "staffing.xlsx", sha256: "b".repeat(64), bytes: 2048 }],
  reasons: [{ code: "document_forbidden_path", reason: "The file is inside a hidden folder.", segment: ".private" }],
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "pending",
};
type Gap = keyof typeof fileConfirmationText.en.missing;
const refused = (missing?: Gap, status = 401) => () => jsonResponse(missing ? { code: "OPERATOR_REQUIRED", missing } : { code: "MEMBER_REQUIRED" }, status);
const pending = () => jsonResponse(VIEW);

/* What the server says next, one answer per ask, and the bot's side of one Telegram request. */
const server = {
  reads: [] as Array<() => Response>,
  decide: (() => jsonResponse({}, 500)) as () => Response,
  start: (() => jsonResponse({ id: "tg-1", proof: "proof-1", url: "https://t.me/fixture_bot?start=one-time", expiresAt: new Date(Date.now() + 600_000).toISOString() })) as () => Response,
  poll: [] as Array<() => Response>,
  confirm: (() => jsonResponse({ state: "linked", name: "Owner" })) as () => Response,
};
const opened: Array<{ url: string; target: string | undefined }> = [];
let mounted: { root: Root; host: HTMLDivElement } | null = null;

beforeEach(() => {
  server.reads = []; server.poll = []; opened.length = 0;
  clock.now = 0; clock.queue = [];
  server.decide = () => jsonResponse({}, 500);
  server.confirm = () => jsonResponse({ state: "linked", name: "Owner" });
  (harness.dom as unknown as { open: unknown }).open = (url: string, target?: string) => { opened.push({ url, target }); return null; };
  harness.setRoute((url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url.startsWith("/api/telegram/bot/confirmation")) return method === "GET" ? (server.reads.shift() ?? (() => jsonResponse({}, 500)))() : server.decide();
    if (url === "/api/team/session/telegram") return server.start();
    if (url === "/api/team/session/telegram/tg-1") {
      if (body.action === "confirm") return server.confirm();
      if (body.action === "complete") return jsonResponse({ me: { name: "Owner" } });
      if (body.action === "not-me") return jsonResponse({ state: "denied" });
      return (server.poll.shift() ?? (() => jsonResponse({ state: "waiting" })))();
    }
    return undefined;
  });
});
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.host.remove(); mounted = null; }
  document.body.replaceChildren();
  setLocale("en");
});

async function mount(locale: "en" | "uk" = "en"): Promise<HTMLDivElement> {
  setLocale(locale);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => { root.render(<TelegramFileConfirmation />); await settle(); });
  return host;
}
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); await settle(); });
/** Moves the page's clock on by `ms`, runs each timer that falls due in order, and lets the renders and answers they cause settle. */
const advance = (ms: number) => act(async () => {
  clock.now += ms;
  for (let due = clock.queue.filter(timer => timer.due <= clock.now).sort((one, other) => one.due - other.due || one.id - other.id)[0]; due;
    due = clock.queue.filter(timer => timer.due <= clock.now).sort((one, other) => one.due - other.due || one.id - other.id)[0]) {
    clock.queue = clock.queue.filter(timer => timer !== due);
    due.callback();
    await settle();
  }
});
const stage = (host: HTMLElement) => host.querySelector("[data-telegram-step-stage]")?.getAttribute("data-telegram-step-stage");
const gate = (host: HTMLElement) => host.querySelector("[data-file-confirmation-gap]");
const heading = (host: HTMLElement) => host.querySelector("[data-file-confirmation-heading]")?.textContent;
const reads = () => harness.calls.filter(call => call.method === "GET" && call.url.startsWith("/api/telegram/bot/confirmation"));
const posts = (url: string) => harness.calls.filter(call => call.method === "POST" && call.url === url).map(call => call.body);
/** Nothing on the page leads to the sign-in page, and the browser stayed where it was. */
const staysPut = (host: HTMLElement) => {
  expect(host.querySelector('a[href*="/sign-in"]')).toBeNull();
  expect(window.location.href).toBe(PAGE);
};

const ACTIONS: Record<Gap, string | null> = { team: 'a[href="/team"]', owner: 'a[href^="/sign-in?next="]', pairing: null, telegram_link: '[data-telegram-step="link"]', telegram_account: '[data-telegram-step="link"]', telegram_session: '[data-telegram-step="sign-in"]' };
test.each((["en", "uk"] as const).flatMap(locale => (Object.keys(ACTIONS) as Gap[]).map(missing => [locale, missing] as const)))("%s: the page names the missing step %s, with its own action and no redirect to sign-in", async (locale, missing) => {
  const words = fileConfirmationText[locale];
  server.reads = [refused(missing)];
  const host = await mount(locale);
  expect(gate(host)?.getAttribute("data-file-confirmation-gap")).toBe(missing);
  expect(heading(host)).toBe(typesetFileConfirmation(words.missing[missing].title, locale));
  expect(host.textContent).toContain(typesetFileConfirmation(words.missing[missing].body, locale));
  const action = ACTIONS[missing] ? host.querySelector(ACTIONS[missing]!) : null;
  if (ACTIONS[missing]) expect(action?.textContent).toBe(missing === "team" ? words.missing.team.action : missing === "owner" ? words.missing.owner.action : translate(locale, missing === "telegram_session" ? "team.signIn.telegram" : "team.telegram.link"));
  else expect(host.querySelectorAll("a, button")).toHaveLength(0);
  /* Only the owner step is a link to sign-in, and only because the person presses it. */
  expect(host.querySelectorAll('a[href*="/sign-in"]')).toHaveLength(missing === "owner" ? 1 : 0);
  expect(window.location.href).toBe(PAGE);
  expect(reads()).toHaveLength(1);
});

test("nobody signed in gets the sign-in card, and nothing else about the install", async () => {
  server.reads = [refused(undefined)];
  const host = await mount();
  expect(gate(host)?.getAttribute("data-file-confirmation-gap")).toBe("sign-in");
  expect(heading(host)).toBe(fileConfirmationText.en.ownerTitle);
  const link = host.querySelector<HTMLAnchorElement>('a[href*="/sign-in"]');
  expect(link?.textContent).toBe(fileConfirmationText.en.signIn);
  expect(link?.getAttribute("href")).toBe(`/sign-in?next=${encodeURIComponent("/telegram-file-confirmation?id=fixture-confirmation")}`);
  expect(window.location.href).toBe(PAGE);
});

test("an owner with no linked Telegram links one, signs in with it, and then sees the request", async () => {
  server.reads = [refused("telegram_link"), refused("telegram_session"), pending];
  server.poll = [() => jsonResponse({ state: "waiting" }), () => jsonResponse({ state: "code_sent" })];
  const host = await mount();
  expect(heading(host)).toBe(fileConfirmationText.en.missing.telegram_link.title);
  staysPut(host);

  /* Link: the bot opens in another tab, the code is typed back here. */
  await click(host.querySelector('[data-telegram-step="link"]'));
  expect(posts("/api/team/session/telegram")).toEqual([{ purpose: "link" }]);
  expect(opened).toEqual([{ url: "https://t.me/fixture_bot?start=one-time", target: "_blank" }]);
  expect(host.querySelector("[data-telegram-step-stage]")?.getAttribute("data-telegram-step-stage")).toBe("waiting");
  expect(host.textContent).toContain(translate("en", "team.telegram.waiting"));
  expect(host.querySelector<HTMLAnchorElement>("[data-telegram-step-open]")?.getAttribute("href")).toBe("https://t.me/fixture_bot?start=one-time");
  /* The first poll hears nothing yet and asks again later; the second finds the code sent. */
  await advance(POLL_MS - 1);
  expect(stage(host)).toBe("waiting");
  await advance(1);
  expect(stage(host)).toBe("waiting");
  expect(posts("/api/team/session/telegram/tg-1")).toHaveLength(1);
  await advance(POLL_MS);
  expect(stage(host)).toBe("code");
  expect(reads()).toHaveLength(1);
  typeInto(host.querySelector<HTMLInputElement>("[data-telegram-code]")!, "123 456");
  await act(async () => { host.querySelector<HTMLFormElement>("[data-telegram-code-form]")!.requestSubmit(); await settle(); });
  expect(posts("/api/team/session/telegram/tg-1").filter(body => (body as { action?: string }).action)).toEqual([{ proof: "proof-1", action: "confirm", code: "123 456" }]);

  /* Linking mints no session, so the page asks again and is told the sign-in is next. */
  expect(reads()).toHaveLength(2);
  expect(gate(host)?.getAttribute("data-file-confirmation-gap")).toBe("telegram_session");
  expect(heading(host)).toBe(fileConfirmationText.en.missing.telegram_session.title);
  expect(host.querySelector('[data-telegram-step="sign-in"]')?.textContent).toBe(translate("en", "team.signIn.telegram"));
  staysPut(host);

  /* Sign in: the name shows for a beat, then the cookie is taken and the request appears. */
  server.poll = [() => jsonResponse({ state: "code_sent" })];
  server.confirm = () => jsonResponse({ state: "confirmed", name: "Owner" });
  await click(host.querySelector('[data-telegram-step="sign-in"]'));
  expect(posts("/api/team/session/telegram").at(-1)).toEqual({ purpose: "sign-in" });
  await advance(POLL_MS);
  expect(stage(host)).toBe("code");
  typeInto(host.querySelector<HTMLInputElement>("[data-telegram-code]")!, "654321");
  await act(async () => { host.querySelector<HTMLFormElement>("[data-telegram-code-form]")!.requestSubmit(); await settle(); });
  expect(stage(host)).toBe("confirmed");
  expect(host.textContent).toContain(translate("en", "team.signIn.signingInAs", { name: "Owner" }));
  /* The name stays for the beat; the cookie is taken only when it ends. */
  await advance(CONFIRM_MS - 1);
  expect(posts("/api/team/session/telegram/tg-1").some(body => (body as { action?: string }).action === "complete")).toBe(false);
  await advance(1);
  expect(posts("/api/team/session/telegram/tg-1").some(body => (body as { action?: string }).action === "complete")).toBe(true);
  expect(reads()).toHaveLength(3);
  expect(gate(host)).toBeNull();
  expect(host.querySelector("[data-file-confirmation-refuse]")).not.toBeNull();
  expect(host.querySelector("[data-file-confirmation-send]")).not.toBeNull();
  staysPut(host);
});

test("a Telegram account the owner has not linked is told so, nothing is left behind, and the step starts over", async () => {
  server.reads = [refused("telegram_session")];
  server.poll = [() => jsonResponse({ state: "code_sent" })];
  server.confirm = () => jsonResponse({ state: "needs_approval", firstName: "Stranger", ownerName: "Owner" });
  const host = await mount();
  await click(host.querySelector('[data-telegram-step="sign-in"]'));
  await advance(POLL_MS);
  typeInto(host.querySelector<HTMLInputElement>("[data-telegram-code]")!, "111111");
  await act(async () => { host.querySelector<HTMLFormElement>("[data-telegram-code-form]")!.requestSubmit(); await settle(); });
  expect(posts("/api/team/session/telegram/tg-1").some(body => (body as { action?: string }).action === "not-me")).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(fileConfirmationText.en.notLinked);
  expect(host.querySelector('[data-telegram-step="sign-in"]')).not.toBeNull();
  expect(reads()).toHaveLength(1);
  staysPut(host);
});

test.each([
  ["a Telegram account another member already linked", { state: "taken" }, "team.error.telegramTaken"],
  ["a request that expired", { state: "expired" }, "team.signIn.expired"],
] as const)("linking %s says why and offers the step again", async (_label, answer, key) => {
  server.reads = [refused("telegram_link")];
  server.poll = [() => jsonResponse({ state: "code_sent" })];
  server.confirm = () => jsonResponse(answer);
  const host = await mount();
  await click(host.querySelector('[data-telegram-step="link"]'));
  await advance(POLL_MS);
  typeInto(host.querySelector<HTMLInputElement>("[data-telegram-code]")!, "222222");
  await act(async () => { host.querySelector<HTMLFormElement>("[data-telegram-code-form]")!.requestSubmit(); await settle(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(translate("en", key));
  expect(host.querySelector('[data-telegram-step="link"]')).not.toBeNull();
  expect(reads()).toHaveLength(1);
});

test("a install without a connected bot says so instead of failing silently", async () => {
  server.reads = [refused("telegram_link")];
  server.start = () => jsonResponse({ error: "no Telegram bot is connected", code: "telegram_unavailable" }, 409);
  const host = await mount("uk");
  await click(host.querySelector('[data-telegram-step="link"]'));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(translate("uk", "team.telegram.unavailable"));
  expect(opened).toEqual([]);
});

test("a decision refused for a missing step shows that step instead of sending the browser away", async () => {
  server.reads = [pending];
  server.decide = () => jsonResponse({ code: "OPERATOR_REQUIRED", missing: "telegram_session" }, 401);
  const host = await mount();
  expect(host.querySelector("[data-file-confirmation-send]")).not.toBeNull();
  await click(host.querySelector("[data-file-confirmation-send]"));
  expect(posts("/api/telegram/bot/confirmation")).toHaveLength(1);
  expect(gate(host)?.getAttribute("data-file-confirmation-gap")).toBe("telegram_session");
  expect(host.querySelector('[data-telegram-step="sign-in"]')).not.toBeNull();
  staysPut(host);
});
