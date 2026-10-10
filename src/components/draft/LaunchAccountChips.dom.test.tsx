import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { resetEngineAccountsStoresForTests } from "@/hooks/useEngineAccounts";
import { setLocale } from "@/lib/i18n";
import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The launch account chips the operator chose on 2026-10-10 (variant 2,
 * «Чипи без відкриття»): every account of the engine is one chip with what is
 * left of its weekly limit, read from the same per-account readings the
 * sidebar footer draws, and the new agent's runtime pill lists the same bar in
 * its account rows.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

const NOW = Math.round(Date.now() / 1000);
const DAY = 86_400;

/** A reading whose weekly window is the tightest, so the footer's line names the same window the chip does. */
const reading = (weeklyUsed: number | null, sessionUsed = 5) => ({
  state: "fresh",
  checkedAt: new Date((NOW - 60) * 1000).toISOString(),
  session: { usedPercent: sessionUsed, resetsAt: NOW + 3 * 3600, windowMinutes: 300 },
  weekly: weeklyUsed === null ? null : { usedPercent: weeklyUsed, resetsAt: NOW + 3 * DAY - 3600, windowMinutes: 10_080 },
});
const account = (id: string, label: string, limits: unknown, signedOut = false) => ({
  id, label, kind: "managed", authPresent: !signedOut, loginPending: false, loginState: signedOut ? "idle" : "authenticated", deviceAuth: null,
  auth: { state: signedOut ? "signed_out" : "authenticated", plan: "Max" }, limits,
});
/** The brief's fixture: Main 92 % (active), Work 41 %, Backup 7 %, a signed-out login and a long label; Codex 78 %, 23 % and one with no weekly reading. */
const ACCOUNTS = {
  claude: {
    active: "main", migration: null, autoBalance: null,
    accounts: [
      account("main", "Main", reading(8)),
      account("work", "Work", reading(59, 30)),
      account("backup", "Backup", reading(93, 70)),
      account("old", "Old login", null, true),
      account("team", "Review lanes · shared team workspace", reading(50, 10)),
    ],
  },
  codex: {
    active: "personal", migration: null, autoBalance: null,
    accounts: [
      account("personal", "Personal", reading(22, 20)),
      account("review", "Review", reading(77, 51)),
      account("fresh", "Fresh", reading(null, 4)),
    ],
  },
};

const realFetch = globalThis.fetch;
const desktopMatchMedia = dom.matchMedia;
let roots: Root[] = [];

beforeEach(() => {
  setLocale("en");
  resetEngineAccountsStoresForTests();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/accounts") return Response.json(ACCOUNTS);
    if (url === "/api/limits") return Response.json({ claude: null, codex: null, copilot: null, claudeAccountId: "main", codexAccountId: "personal", provenance: { source: "live" }, staleSince: null });
    if (url === "/api/accounts/copilot") return Response.json({ cli: { present: false, reason: null }, active: "", accounts: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.replaceChildren();
  sessionStorage.clear();
  (dom as unknown as { matchMedia: unknown }).matchMedia = desktopMatchMedia;
  setLocale("en");
  globalThis.fetch = realFetch;
});

function phone(): void {
  (dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
    matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
}

const { AgentLaunchControls, revealScrollLeft, useAgentLaunchDraft } = await import("./AgentLaunchControls");
const { DraftRuntimePill } = await import("./DraftRuntimePill");
const { LimitsFooter } = await import("@/components/LimitsFooter");

type Draft = ReturnType<typeof useAgentLaunchDraft>;

function Launch({ onDraft, pill = false, disabled = false, storedAccount = "" }: { onDraft: (draft: Draft) => void; pill?: boolean; disabled?: boolean; storedAccount?: string }) {
  const draft = useAgentLaunchDraft({ initialEngine: "claude", ...(storedAccount ? { storage: { read: (name: string) => (name === "accountId" ? storedAccount : ""), write() {} } } : {}) });
  onDraft(draft);
  return pill ? <DraftRuntimePill launch={draft} /> : <AgentLaunchControls draft={draft} disabled={disabled} stacked />;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(node); });
  await settle();
  return host as unknown as HTMLElement;
}

async function mountLaunch(pill = false, options: { disabled?: boolean; storedAccount?: string } = {}): Promise<{ host: HTMLElement; draft: () => Draft }> {
  let latest: Draft | null = null;
  const host = await mount(<Launch pill={pill} {...options} onDraft={(draft) => { latest = draft; }} />);
  return { host, draft: () => latest! };
}

const group = (host: HTMLElement, engine = "Claude") => host.querySelector(`[role="radiogroup"][aria-label*="${engine}"][aria-label*="account"]`) as HTMLElement;
const chip = (host: HTMLElement, id: string) => host.querySelector(`[data-launch-account="${id}"]`) as HTMLButtonElement;
const chosen = (host: HTMLElement) => host.querySelector('[data-launch-account][aria-checked="true"]')?.getAttribute("data-launch-account") ?? null;
const percent = (element: Element) => element.querySelector("[data-weekly-percent]")?.textContent ?? null;
const bar = (element: Element) => element.querySelector("[data-meter-bar]") as HTMLElement | null;
const barFill = (element: Element) => (bar(element)?.firstElementChild as HTMLElement | null)?.style.backgroundColor ?? null;

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
}
async function key(element: Element, name: string): Promise<void> {
  await act(async () => { element.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as Event); });
}

test("a chip's percent and bar are the sidebar footer's for the same account", async () => {
  const footer = await mount(<LimitsFooter density="line" />);
  const { host } = await mountLaunch();
  for (const [id, left] of [["main", 92], ["work", 41], ["backup", 7]] as const) {
    const line = footer.querySelector(`[data-engine-limits="claude"] [data-footer-account="${id}"]`)!;
    expect(line).not.toBeNull();
    expect(line.querySelector("[data-meter-value]")!.textContent).toBe(`left ${left}%`);
    expect(percent(chip(host, id))).toBe(`${left}%`);
    expect(bar(chip(host, id))!.getAttribute("data-meter-bar")).toBe(bar(line)!.getAttribute("data-meter-bar"));
    expect(barFill(chip(host, id))).toBe(barFill(line));
  }
  /* The number takes the warning colour the footer gives it once the limit is nearly spent. */
  expect((chip(host, "backup").querySelector("[data-weekly-percent]") as HTMLElement).style.color).toBe("var(--color-danger)");
  expect((chip(host, "main").querySelector("[data-weekly-percent]") as HTMLElement).style.color).toBe("var(--color-primary)");
  /* The screen reader hears the percent in the chip's name; the reset waits in the hint. */
  expect(chip(host, "main").getAttribute("aria-label")).toBe("Main · active · 92% of the weekly limit left");
  expect(chip(host, "main").getAttribute("title")).toContain("Week left 92% · reset in 3d");
  expect(chip(host, "main").textContent).not.toContain("reset");
});

test("an account with no weekly reading shows no bar and no percent", async () => {
  const { host, draft } = await mountLaunch();
  await act(async () => { draft().setEngine("codex"); });
  await settle();
  expect(percent(chip(host, "personal"))).toBe("78%");
  expect(percent(chip(host, "review"))).toBe("23%");
  const fresh = chip(host, "fresh");
  expect(fresh).not.toBeNull();
  expect(percent(fresh)).toBeNull();
  expect(bar(fresh)).toBeNull();
  expect(fresh.textContent).toBe("Fresh");
  expect(fresh.getAttribute("aria-label")).toBe("Fresh");
});

test("a signed-out account is a marked chip that cannot be picked", async () => {
  const { host, draft } = await mountLaunch();
  const old = chip(host, "old");
  expect(old.getAttribute("aria-disabled")).toBe("true");
  expect(old.getAttribute("data-launch-account-pickable")).toBe("false");
  expect(old.className).toContain("border-dashed");
  expect(old.querySelector("[data-launch-account-signed-out]")!.textContent).toBe("signed out");
  expect(old.getAttribute("aria-label")).toBe("Old login · signed out");
  await click(old);
  expect(chosen(host)).toBe("main");
  expect(draft().launchAccountId).toBe("main");

  await act(async () => { setLocale("uk"); });
  await settle();
  const { host: uk } = await mountLaunch();
  expect(chip(uk, "old").querySelector("[data-launch-account-signed-out]")!.textContent).toBe("не ввійшли");
  expect(chip(uk, "main").getAttribute("aria-label")).toBe("Main · активний · лишилось 92% тижневого ліміту");
});

test("one tap picks a chip, and the radio group carries the choice", async () => {
  const { host, draft } = await mountLaunch();
  expect(group(host).getAttribute("role")).toBe("radiogroup");
  expect([...group(host).querySelectorAll('[role="radio"]')].map((node) => node.getAttribute("data-launch-account"))).toEqual(["main", "work", "backup", "old", "team"]);
  expect(chip(host, "main").querySelector("[data-launch-account-active]")).not.toBeNull();
  await click(chip(host, "work"));
  expect(chosen(host)).toBe("work");
  expect(draft().launchAccountId).toBe("work");
  /* The active account keeps its dot; the accent border moves with the pick. */
  expect(chip(host, "main").querySelector("[data-launch-account-active]")).not.toBeNull();
  expect(chip(host, "work").className).toContain("border-accent");
  expect(chip(host, "main").className).not.toContain("border-accent");
});

test("arrow keys move between chips and Space or Enter picks", async () => {
  const { host, draft } = await mountLaunch();
  /* One tab stop: the chosen chip. */
  expect([...group(host).querySelectorAll('[role="radio"]')].map((node) => node.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
  await act(async () => { chip(host, "main").focus(); });
  await key(chip(host, "main"), "ArrowRight");
  expect(document.activeElement).toBe(chip(host, "work"));
  /* Moving is not picking. */
  expect(draft().launchAccountId).toBe("main");
  await key(chip(host, "work"), "Enter");
  expect(draft().launchAccountId).toBe("work");
  await key(chip(host, "work"), "ArrowRight");
  await key(chip(host, "backup"), "ArrowRight");
  expect(document.activeElement).toBe(chip(host, "old"));
  /* A signed-out chip is reachable, named and not pickable. */
  await key(chip(host, "old"), " ");
  expect(draft().launchAccountId).toBe("work");
  await key(chip(host, "old"), "ArrowLeft");
  await key(chip(host, "backup"), " ");
  expect(draft().launchAccountId).toBe("backup");
  await key(chip(host, "backup"), "Home");
  expect(document.activeElement).toBe(chip(host, "main"));
  await key(chip(host, "main"), "End");
  expect(document.activeElement).toBe(chip(host, "team"));
});

test("flipping the engine re-defaults the account to that engine's active one", async () => {
  const { host, draft } = await mountLaunch();
  await click(chip(host, "work"));
  expect(draft().accountId).toBe("work");
  await act(async () => { draft().setEngine("codex"); });
  await settle();
  expect(group(host, "Codex")).not.toBeNull();
  expect(chosen(host)).toBe("personal");
  expect(draft().launchAccountId).toBe("personal");
  await act(async () => { draft().setEngine("claude"); });
  await settle();
  expect(chosen(host)).toBe("main");
});

test("a disabled draft disables every chip", async () => {
  const { host, draft } = await mountLaunch(false, { disabled: true });
  expect([...group(host).querySelectorAll('[role="radio"]')].every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
  await click(chip(host, "work"));
  expect(draft().launchAccountId).toBe("main");
});

test("the desktop wraps the row; the phone scrolls it and brings the chosen chip into view", async () => {
  const { host: desktop } = await mountLaunch();
  expect(group(desktop).getAttribute("data-launch-account-row")).toBe("wrap");
  expect(group(desktop).className).toContain("flex-wrap");
  expect(group(desktop).className).not.toContain("overflow-x-auto");

  phone();
  /* A 390 px sheet: the row is 342 px wide and each chip about 120 px, so the third one starts outside it. */
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON() {} });
  const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(): unknown };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute("role") === "radiogroup") return rect(24, 342);
    const id = this.getAttribute("data-launch-account");
    const index = ["main", "work", "backup", "old", "team"].indexOf(id ?? "");
    return index < 0 ? rect(0, 0) : rect(24 + index * 124 - (this.parentElement?.scrollLeft ?? 0), 120);
  };
  try {
    const { host, draft } = await mountLaunch(false, { storedAccount: "backup" });
    expect(draft().launchAccountId).toBe("backup");
    const row = group(host);
    expect(row.getAttribute("data-launch-account-row")).toBe("scroll");
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).not.toContain("flex-wrap");
    /* Backup spans 248..368 inside a row that ends at 342: the row scrolls until it stands 24 px clear. */
    expect(row.scrollLeft).toBe(revealScrollLeft({ left: 24, width: 342, scrollLeft: 0 }, { left: 24 + 2 * 124, width: 120 }));
    expect(row.scrollLeft).toBeGreaterThan(0);
  } finally {
    proto.getBoundingClientRect = original;
  }
});

test("revealing a chip scrolls only as far as it needs to", () => {
  const row = { left: 0, width: 300, scrollLeft: 100 };
  expect(revealScrollLeft(row, { left: 50, width: 100 })).toBe(100);
  expect(revealScrollLeft(row, { left: 250, width: 100 })).toBe(100 + 350 - 300 + 24);
  expect(revealScrollLeft(row, { left: -50, width: 100 })).toBe(100 - 50 - 24);
  expect(revealScrollLeft(row, { left: -150, width: 100 })).toBe(0);
  expect(revealScrollLeft({ left: 0, width: 300, scrollLeft: 0 }, { left: 10, width: 100 })).toBe(0);
});

test("the runtime pill's account rows carry the same weekly bar and percent", async () => {
  const { host: chips } = await mountLaunch();
  const { host } = await mountLaunch(true);
  await click(host.querySelector("[data-runtime-pill]")!);
  await click(document.querySelector('[data-runtime-popover] [data-runtime-value="account"]')!);
  await settle();
  const rows = [...document.querySelectorAll('[data-runtime-popover] [data-runtime-row="account"]')] as HTMLElement[];
  expect(rows.map((row) => row.getAttribute("data-runtime-value"))).toEqual(["account-main", "account-work", "account-backup", "account-team"]);
  for (const id of ["main", "work", "backup"]) {
    const row = rows.find((entry) => entry.getAttribute("data-runtime-value") === `account-${id}`)!;
    expect(percent(row)).toBe(percent(chip(chips, id)));
    expect(bar(row)!.getAttribute("data-meter-bar")).toBe(bar(chip(chips, id))!.getAttribute("data-meter-bar"));
    expect(barFill(row)).toBe(barFill(chip(chips, id)));
  }
  expect(rows[1]!.getAttribute("aria-label")).toBe("Work · 41% of the weekly limit left");
  expect(rows[1]!.getAttribute("title")).toContain("Week left 41%");
});

test("on the phone the runtime pill's account sheet carries the same weekly bar and percent", async () => {
  phone();
  const { host } = await mountLaunch(true);
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  const row = (id: string) => document.querySelector(`[data-runtime-sheet] [data-runtime-sheet-account="${id}"]`) as HTMLElement;
  expect(percent(row("main"))).toBe("92%");
  expect(bar(row("main"))!.getAttribute("data-meter-bar")).toBe("92");
  expect(percent(row("work"))).toBe("41%");
  expect(percent(row("backup"))).toBe("7%");
  expect(barFill(row("backup"))).toBe("var(--color-danger)");
  /* A signed-out account shows its state, no reading. */
  expect(percent(row("old"))).toBeNull();
  expect(row("work").getAttribute("aria-label")).toContain("41% of the weekly limit left");
});
