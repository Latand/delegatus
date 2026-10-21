import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import type { TurboAnswer } from "@/lib/monitor/turboRuntime";
import type { TurboSetting } from "@/lib/monitor/turbo";

/*
 * Turbo's «Форсаж» control in the seat tick panel (docs/design/turbo-mode.md
 * §2.3, §6): the switch beside Full autonomy, the confirmation with its
 * separate paid-credit approval, the optimistic save with rollback, the
 * immediate off, the disabled reason, the status line and the dock mark.
 */

const dom = new HappyWindow({ innerWidth: 1280, innerHeight: 800 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLSelectElement: dom.HTMLSelectElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const { SeatTickChip } = await import("./SeatTickChip");
const { resetSeatTickSettingsCacheForTests } = await import("./useSeatTickSettings");
const { resetMaintainerRoleCacheForTests } = await import("./useMaintainerRole");
const { setLocale } = await import("@/lib/i18n");

const PROJECT = "viewer";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const operator = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };

function episode(overrides: Partial<TurboSetting> = {}): TurboSetting {
  return { enabled: true, startedAt: ago(5), until: later(115), endedAt: null, endReason: null, updatedAt: ago(5), setBy: operator, why: null,
    plan: [{ accountId: "acct-a", label: "Account A", plan: "promax", tiers: { "gpt-6.1-sol": "ultrafast" }, hadCredits: true },
      { accountId: "acct-b", label: "Account B", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: true }],
    credits: { approved: false, accounts: [], approvedAt: null, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
    switches: [], ...overrides };
}
const progress = (pending: number, switched: number) => ({ total: pending + switched, switched, armed: 0, skipped: 0, failed: 0, pending, reverted: 0 });
const turboOff = (overrides: Partial<TurboAnswer> = {}): TurboAnswer => ({ active: false, episode: null, history: [], available: true, unavailableReason: null, progress: null, ...overrides });
const turboOn = (setting = episode(), overrides: Partial<TurboAnswer> = {}): TurboAnswer => ({ active: true, episode: setting, history: [], available: true, unavailableReason: null, progress: progress(0, 7), ...overrides });
const PREVIEW: NonNullable<TurboAnswer["preview"]> = {
  accounts: [
    { accountId: "acct-a", label: "Account A", plan: "promax", tiers: { "gpt-6.1-sol": "ultrafast", "gpt-6-astra": "ultrafast", "gpt-6-luna": "priority" }, weeklyPercent: 36, weeklyResetsAt: Math.floor(Date.parse("2026-10-27T00:00:00Z") / 1000), balance: "412", holdsCredits: true, otherProjects: 0, unavailable: null },
    { accountId: "acct-b", label: "Account B", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, weeklyPercent: 58, weeklyResetsAt: null, balance: "75", holdsCredits: true, otherProjects: 2, unavailable: null },
    { accountId: "acct-c", label: "Account C", plan: "prolite", tiers: { "gpt-6.1-sol": "priority" }, weeklyPercent: 12, weeklyResetsAt: null, balance: null, holdsCredits: false, otherProjects: 0, unavailable: null },
  ],
  conversations: { total: 7, stages: 3, agents: 4 },
};

function record(turbo: TurboAnswer): SeatTickSettingsAnswer {
  return {
    autoRotate: { enabled: false, thresholdPercent: 50, defaultPercent: 50, minPercent: 50, maxPercent: 90, windowKnown: true, lastAttempt: null, setBy: null, updatedAt: null, why: null },
    maintenance: { enabled: false, intervalHours: 3, defaultIntervalHours: 3, minIntervalHours: 1, maxIntervalHours: 168, updatedAt: null, setBy: null, live: null, lastRun: null,
      nextEligibleAt: null, nextRunAt: null, waitingOn: "off", pauseReason: null, runsError: null },
    project: PROJECT, changed: false, at: new Date().toISOString(), actor: operator,
    settings: { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    effective: { enabled: true, wakeIntervalMinutes: 60, reason: null, monitorPrompt: null, until: null, isDefault: true, configured: false, lapsed: false, updatedAt: null },
    defaults: { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    defaultWakeIntervalMinutes: 60, monitorPromptLength: 0, cardText: null,
    policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
    state: { lastCheckAt: ago(3), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
    stateError: null, lastRun: null, lastDelivery: null, journalError: null,
    turbo,
  } as SeatTickSettingsAnswer;
}

interface Recorded { url: string; method: string; body: Record<string, unknown> }
const realFetch = globalThis.fetch;
const requests: Recorded[] = [];
let getAnswer: SeatTickSettingsAnswer;
let putAnswers: Array<{ status: number; body: unknown }>;
let previewFails = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/roles")) return json({ revision: "rev-1", health: "ok", launchChoices: [], roles: [{ id: "maintainer", name: "Maintainer", config: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" } }] });
  if (!url.startsWith("/api/monitor/seat-tick/settings")) return json({});
  if (method === "PUT") { const next = putAnswers.length > 1 ? putAnswers.shift()! : putAnswers[0]!; return json(next.body, next.status); }
  if (url.includes("turboPreview=1")) return previewFails ? json({ error: "unreadable" }, 500) : json({ ...getAnswer, turbo: { ...getAnswer.turbo!, preview: PREVIEW } });
  return json(getAnswer);
}) as typeof fetch;

const roots = new Set<Root>();
beforeEach(() => {
  resetSeatTickSettingsCacheForTests(); resetMaintainerRoleCacheForTests();
  requests.length = 0; previewFails = false;
  getAnswer = record(turboOff());
  putAnswers = [{ status: 200, body: record(turboOn()) }];
});
afterEach(() => {
  for (const root of [...roots]) { roots.delete(root); flushSync(() => root.unmount()); }
  dom.document.body.replaceChildren();
  setLocale("en");
});
afterAll(() => { globalThis.fetch = realFetch; });

const view = () => <SeatTickChip project={PROJECT} projectName="Viewer" />;

test.each(["en", "uk"] as const)("switch failures remain visible in the existing Details section (%s)", async lang => {
  setLocale(lang);
  const setting = episode();
  setting.switches = [{ conversationId: "conversation_failed", accountId: "acct-a", model: "gpt-6.1-sol", from: "default", to: "ultrafast", state: "failed", reason: "native tier update refused", at: ago(1) }];
  getAnswer = record(turboOn(setting));
  await mountOpen();
  const details = dom.document.querySelector("[data-turbo-switch-details]");
  expect(details).not.toBeNull();
  expect(details!.textContent).toContain(lang === "uk" ? "Деталі перемикань турбо" : "Turbo switch details");
  expect(details!.textContent).toContain("Account A");
  expect(details!.textContent).toContain("native tier update refused");
});
async function settle(root: Root, rounds = 5) {
  for (let round = 0; round < rounds; round += 1) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => root.render(view())); }
}
async function mountOpen(): Promise<Root> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(view()));
  await settle(root);
  const chip = body().querySelector("[data-seat-tick-chip]") as HTMLElement;
  chip.focus(); flushSync(() => chip.click());
  await settle(root);
  return root;
}
const body = () => dom.document.body as unknown as HTMLElement;
const q = <T extends HTMLElement = HTMLElement>(selector: string) => body().querySelector(selector) as T | null;
const control = () => q<HTMLButtonElement>("[data-turbo-control]")!;
const dialog = () => q("[data-turbo-dialog]");
const puts = () => requests.filter(entry => entry.method === "PUT" && entry.url.startsWith("/api/monitor/seat-tick/settings"));
const click = (element: HTMLElement | null) => flushSync(() => element!.click());
function check(input: HTMLInputElement, checked: boolean) {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
  input.checked = checked;
  flushSync(() => (input as unknown as Record<string, { onChange(event: unknown): void }>)[key]!.onChange({ target: input }));
}
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  flushSync(() => select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
}

test("the control sits on the Full autonomy row, above the wakes; off, it says what Turbo does", async () => {
  await mountOpen();
  const section = q("[data-seat-tick-autonomy-section]")!;
  expect(section.contains(control())).toBe(true);
  expect(section.querySelector("[data-turbo-head]")?.textContent).toBe("Turbo");
  expect(control().getAttribute("role")).toBe("switch");
  expect(control().getAttribute("aria-checked")).toBe("false");
  expect(control().getAttribute("aria-haspopup")).toBe("dialog");
  expect(q("[data-turbo-about]")?.textContent).toBe("Turbo: Codex agents run at their account's fastest speed. Limits are spent faster.");
  // The section moved above the wakes so it stays on the popover's first screen.
  const order = [...body().querySelectorAll("[data-seat-tick-autonomy-section], [data-seat-tick-enabled]")].map(node => node.hasAttribute("data-seat-tick-autonomy-section") ? "autonomy" : "wakes");
  expect(order).toEqual(["autonomy", "wakes"]);
});

test("turning on opens the confirmation: what changes, accounts, the separate unticked credit box, Claude, duration 2 h", async () => {
  const root = await mountOpen();
  click(control());
  await settle(root);
  expect(requests.some(entry => entry.url.includes("turboPreview=1"))).toBe(true);
  expect(dialog()?.getAttribute("aria-modal")).toBe("true");
  expect(dom.document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Turn Turbo on?");
  expect(dialog()!.textContent).toContain("Limits will be spent several times faster.");
  expect(q("[data-turbo-now]")?.textContent).toBe("Codex conversations moving to the new speed: 7 (3 pipeline stages, 4 agents). Those working finish their current step, stop and continue faster at once.");
  expect(dialog()!.textContent).toContain("The orchestrator decides which upcoming pipeline stages to speed up.");
  const accountA = q("[data-turbo-account=\"acct-a\"]")!.textContent!;
  expect(accountA).toContain("Ultrafast for GPT-6.1-Sol, GPT-6-Astra, Fast for the others");
  expect(accountA).toContain("week 36 %");
  expect(q("[data-turbo-account=\"acct-a\"] [data-account-credit]")?.textContent).toBe("Without credits: Turbo only up to 90 % of the limit");
  expect(q("[data-turbo-account=\"acct-b\"]")!.textContent).toContain("2 other projects also use it");
  expect(q("[data-turbo-account=\"acct-c\"] [data-account-credit]")?.textContent).toBe("No credits");
  const toggle = q<HTMLInputElement>("[data-turbo-credits-toggle]")!;
  expect(toggle.checked).toBe(false);
  expect(q("[data-turbo-credits]")?.getAttribute("data-turbo-credits")).toBe("off");
  expect([...q("[data-turbo-payers]")!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Account A · Ultrafast and Fast · balance 412", "Account B · Fast · balance 75"]);
  expect(q("[data-turbo-claude]")?.textContent).toContain("Claude's fast mode is billed separately");
  expect(q<HTMLSelectElement>("[data-turbo-duration]")!.value).toBe("2");
  expect(dom.document.activeElement?.hasAttribute("data-turbo-cancel")).toBe(true);
  expect(control().getAttribute("data-turbo")).toBe("dialog");
});

test("confirm never ticks the credit approval: optimistic on at once, then the record's caption", async () => {
  const root = await mountOpen();
  click(control()); await settle(root);
  click(q("[data-turbo-confirm]"));
  expect(dialog()).toBeNull();
  expect(control().getAttribute("aria-checked")).toBe("true");
  await settle(root);
  expect(puts().map(entry => entry.body.turbo)).toEqual([{ enabled: true, hours: 2 }]);
  expect(q("[data-turbo-about]")?.getAttribute("data-turbo-credits-outcome")).toBe("off");
  expect(q("[data-turbo-about]")?.textContent).toBe("Turbo without credits: only the accounts' included limits. Turn it off any time; conversations return to their previous speed from their next turn.");
});

test("the approval names the paying accounts, removes «until turned off» and is cleared by cancel", async () => {
  const root = await mountOpen();
  click(control()); await settle(root);
  choose(q<HTMLSelectElement>("[data-turbo-duration]")!, "off");
  // A press inside the dialog is not a press outside the popover it was opened from.
  flushSync(() => q("[data-turbo-credits-toggle]")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event));
  await settle(root);
  expect(q("[data-seat-tick-popover]")).not.toBeNull();
  expect(dialog()).not.toBeNull();
  check(q<HTMLInputElement>("[data-turbo-credits-toggle]")!, true);
  expect(q("[data-turbo-credits]")?.getAttribute("data-turbo-credits")).toBe("on");
  expect(q<HTMLSelectElement>("[data-turbo-duration]")!.value).toBe("2");
  expect((q<HTMLSelectElement>("[data-turbo-duration]")!.querySelector("option[value=\"off\"]") as HTMLOptionElement).disabled).toBe(true);
  expect(q("[data-turbo-duration-note]")?.textContent).toBe("With credits Turbo has an end: 1 to 8 h.");
  expect(q("[data-turbo-account=\"acct-a\"] [data-account-credit]")?.textContent).toBe("With credits: after the limit it pays with credits from its balance");
  click(q("[data-turbo-cancel]"));
  expect(dialog()).toBeNull();
  expect(puts()).toHaveLength(0);
  click(control()); await settle(root);
  expect(q<HTMLInputElement>("[data-turbo-credits-toggle]")!.checked).toBe(false);
  check(q<HTMLInputElement>("[data-turbo-credits-toggle]")!, true);
  choose(q<HTMLSelectElement>("[data-turbo-duration]")!, "4");
  putAnswers = [{ status: 200, body: record(turboOn(episode({ credits: { approved: true, accounts: ["acct-a", "acct-b"], approvedAt: ago(0), withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null } }))) }];
  click(q("[data-turbo-confirm]"));
  await settle(root);
  expect(puts().map(entry => entry.body.turbo)).toEqual([{ enabled: true, hours: 4, credits: true, creditAccounts: ["acct-a", "acct-b"] }]);
  expect(q("[data-turbo-about]")?.getAttribute("data-turbo-credits-outcome")).toBe("on");
  expect(q("[data-turbo-about]")?.textContent).toContain("Turbo with credits: after the limit, accounts Account A, Account B pay with credits.");
  expect(q("[data-seat-tick-turbo-mark]")?.getAttribute("data-seat-tick-turbo-mark")).toBe("credits");
});

test("Escape cancels; a failed save rolls back in place and leaves the panel's Save alone", async () => {
  const root = await mountOpen();
  click(control()); await settle(root);
  flushSync(() => dialog()!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(dialog()).toBeNull();
  putAnswers = [{ status: 400, body: { error: "only the operator may turn Turbo on or extend it; the seat may only shorten or turn it off" } }];
  click(control()); await settle(root);
  click(q("[data-turbo-confirm]"));
  expect(control().getAttribute("aria-checked")).toBe("true");
  await settle(root);
  expect(control().getAttribute("aria-checked")).toBe("false");
  expect(q("[data-turbo-error]")?.textContent).toContain("only the operator may turn Turbo on");
  expect(q("[data-seat-tick-error]")).toBeNull();
});

test("off is immediate, with no dialog; the status line counts the sweep and the minutes left", async () => {
  getAnswer = record(turboOn(episode({ until: later(95) }), { progress: progress(5, 2) }));
  putAnswers = [{ status: 200, body: record(turboOff()) }];
  const root = await mountOpen();
  expect(control().getAttribute("aria-checked")).toBe("true");
  expect(control().getAttribute("data-turbo")).toBe("switching");
  expect(q("[data-turbo-status]")?.textContent).toMatch(/^Turbo until \d\d:\d\d · switching conversations: 2 of 7$/);
  const chip = q("[data-seat-tick-chip]")!;
  expect(chip.getAttribute("aria-valuetext")).toMatch(/^Turbo until \d\d:\d\d, without credits\. /);
  expect(chip.querySelector("[data-seat-tick-turbo-mark]")).not.toBeNull();
  click(control());
  expect(dialog()).toBeNull();
  await settle(root);
  expect(puts().map(entry => entry.body.turbo)).toEqual([{ enabled: false }]);
  expect(control().getAttribute("aria-checked")).toBe("false");
  expect(q("[data-turbo-status]")).toBeNull();
});

test("ending soon says the minutes left; disabled says why and cannot be pressed", async () => {
  getAnswer = record(turboOn(episode({ until: later(8) })));
  let root = await mountOpen();
  expect(control().getAttribute("data-turbo")).toBe("ending");
  expect(q("[data-turbo-status]")?.textContent).toMatch(/ · 8 min left$/);
  roots.delete(root); flushSync(() => root.unmount()); dom.document.body.replaceChildren();
  resetSeatTickSettingsCacheForTests();
  getAnswer = record(turboOff({ available: false, unavailableReason: "no-faster-tier" }));
  root = await mountOpen();
  expect(control().disabled).toBe(true);
  expect(control().getAttribute("data-turbo")).toBe("disabled");
  expect(q("[data-turbo-about]")?.textContent).toBe("Turbo unavailable: the allowed Codex accounts offer no faster tier.");
});

test("Ukrainian: the control, the caption and the dialog read in the operator's language", async () => {
  setLocale("uk");
  const root = await mountOpen();
  expect(q("[data-turbo-head]")?.textContent).toBe("Турбо");
  expect(q("[data-turbo-about]")?.textContent).toBe("Турбо: агенти Codex працюють на найшвидшій швидкості свого акаунта. Ліміти витрачаються швидше.");
  click(control()); await settle(root);
  expect(dialog()!.textContent).toContain("Увімкнути турбо?");
  expect(dialog()!.textContent).toContain("Дозволити платні кредити");
  expect(dialog()!.textContent).toContain("Без кредитів: турбо лише до 90 % ліміту");
  expect(dialog()!.textContent).toContain("Його також використовують ще 2 проєкти");
  expect(q("[data-turbo-confirm]")?.textContent).toBe("Увімкнути турбо");
});
