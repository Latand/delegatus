import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import { getLocale, setLocale, translate } from "@/lib/i18n";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

import { MobileAccountsBody, mobileAccountCorner, mobileAccountState, ProjectAwareMobileAccountsBody } from "./AccountsPanel";
import { createReceiptStore, type ReceiptStore } from "./mobile/MobileReceipt";
import { formatResetClock, formatResetEta } from "./rateLimit";

/*
 * The Accounts & limits screen on the phone (issue #1439, lane 9;
 * docs/design/mobile-v2/README.md §4.8): the active account as a card with its
 * windows and the actions that act ON THE TAP, the other authenticated
 * accounts as quiet rows that switch future launches, a row that is not signed
 * in that opens the device sign-in and stays inactive, and the add row last.
 *
 * The two numbers the design fixes are asserted here because both used to mean
 * the opposite: every meter fills with what REMAINS, coloured by what remains,
 * and the card's corner names the window its number belongs to (§5, P2-4).
 */

/** An archive under an invented home, composed so the `~` fold is exercised
    without a home path written out in a published source. */
const archiveUnderHome = (id: string) => ["", "home", "someone", ".config", "agent-log-viewer", "shared", "claude", "retired", id].join("/");
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
installActEnv();

const NOW = 1_800_000_000;
const HOUR = 3_600;
const DAY = 24 * HOUR;

function account(over: Partial<AccountOption> & { id: string; label: string }): AccountOption {
  return {
    kind: "managed",
    authPresent: true,
    authHealth: "authenticated",
    loginPending: false,
    loginState: "authenticated",
    deviceAuth: null,
    login: null,
    ...over,
  } as AccountOption;
}

const window5h = (usedPercent: number, resetsAt: number) => ({ usedPercent, resetsAt, windowMinutes: 300 });
const windowWeek = (usedPercent: number, resetsAt: number) => ({ usedPercent, resetsAt, windowMinutes: 10_080 });

/** «Main» holds the seat: a 5h window with room, a week nearly spent, and the
    tier weeks #1358/#1796 added — three rows, three meters, one corner. */
const claudeMain = account({
  id: "cl-main",
  label: "Main",
  plan: "max",
  limits: {
    freshness: "fresh",
    session: window5h(28, NOW + 2 * HOUR),
    weekly: windowWeek(92, NOW + 3 * DAY),
    tiers: [{ ...windowWeek(29, NOW + 3 * DAY), tier: "opus" }],
    plan: "max",
    capturedAt: NOW - 600,
    checkedAt: new Date((NOW - 600) * 1000).toISOString(),
  },
} as Partial<AccountOption> & { id: string; label: string });

const claudeLab = account({
  id: "cl-lab",
  label: "Lab",
  plan: "pro",
  limits: { freshness: "fresh", session: window5h(12, NOW + 4 * HOUR), weekly: windowWeek(36, NOW + 6 * DAY), plan: "pro", capturedAt: NOW - 900, checkedAt: new Date((NOW - 900) * 1000).toISOString() },
} as Partial<AccountOption> & { id: string; label: string });

const claudeSecond = account({ id: "cl-second", label: "Second", authPresent: false, authHealth: "signed_out" });

const codexMain = account({
  id: "cx-main",
  label: "Main",
  plan: "pro",
  limits: { freshness: "fresh", session: window5h(40, NOW + HOUR), weekly: windowWeek(55, NOW + 2 * DAY), plan: "pro", capturedAt: NOW - 300, checkedAt: new Date((NOW - 300) * 1000).toISOString() },
  resetCredits: { availableCount: 1, expiresAt: NOW + 20 * DAY },
} as Partial<AccountOption> & { id: string; label: string });

const codexSpare = account({ id: "cx-spare", label: "Spare", authPresent: false, authHealth: "signed_out" });

test("phone provider credential damage shows repair and never offers sign-in", async () => {
  const damaged = account({ id: "cl-provider", label: "Provider", authPresent: false, authHealth: "error",
    provider: { baseUrl: "https://example.invalid/anthropic", model: "large", smallFastModel: null } });
  const view = await mount([engineState("claude", [damaged], damaged.id)]);
  const row = view.host.querySelector('[data-mobile2-account="cl-provider"]') as HTMLElement;
  expect(mobileAccountState(damaged, damaged.id)).toBe("error");
  expect(row.getAttribute("data-mobile2-account-state")).toBe("error");
  expect(row.textContent).toContain("Provider credential error");
  expect(row.textContent).toContain("Edit provider");
  expect(row.textContent).not.toContain("Needs sign-in");
  expect(row.textContent).not.toContain("Not logged in");
  expect(row.querySelector('[data-mobile2-account-signin="cl-provider"]')).toBeNull();
  const repaired = { ...damaged, authPresent: true, authHealth: "unknown" as const };
  await view.rerender([engineState("claude", [repaired], repaired.id)]);
  expect(view.host.querySelector('[data-mobile2-account="cl-provider"]')?.getAttribute("data-mobile2-account-state")).toBe("active");
});

function engineState(engine: "claude" | "codex", accounts: AccountOption[], active: string, over: Partial<EngineAccountsState> = {}): EngineAccountsState {
  return {
    engine,
    hidden: [],
    accounts,
    active,
    identityVersion: 0,
    status: "ready",
    notice: null,
    challenge: null,
    mutation: null,
    migration: null,
    autoBalance: null,
    refresh: async () => true,
    add: async () => true,
    retryNotice: async () => true,
    select: async () => true,
    submitLoginCode: async () => true,
    cancelLogin: async () => true,
    retryLogin: async () => true,
    remove: async () => true,
    restore: async () => true,
    cleanupOrphans: async () => true,
    copyTerminalCommand: async () => true,
    refreshLimits: async () => true,
    useResetCredit: async () => true,
    limitsBusy: null,
    limitsVersion: 0,
    removing: null,
    removal: null,
    dismissRemoval: () => {},
    ...over,
  };
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
const realFetch = globalThis.fetch;
afterEach(async () => {
  await Promise.all(mounted.splice(0).map(async ({ root, host }) => {
    await act(async () => root.unmount());
    host.remove();
  }));
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});

async function mount(engines: EngineAccountsState[], receipts: ReceiptStore = createReceiptStore(), nextChosenAccountIds?: Partial<Record<"claude" | "codex", string | null>>, project?: string): Promise<{ host: HTMLDivElement; receipts: ReceiptStore; rerender(next: EngineAccountsState[], now?: number): Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = async (next: EngineAccountsState[], nextNow = NOW) => {
    await act(async () => root.render(project
      ? <ProjectAwareMobileAccountsBody engines={next} now={nextNow} project={project} receipts={receipts} />
      : <MobileAccountsBody engines={next} now={nextNow} receipts={receipts} nextChosenAccountIds={nextChosenAccountIds} />));
  };
  await render(engines);
  return { host, receipts, rerender: render };
}

test("phone next choice follows refreshed quota selection while the project stays mounted", async () => {
  let selected = "b";
  let reads = 0;
  let otherCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/account-project-bindings")) {
      reads += 1;
      return Response.json({ engines: { claude: { nextChosenAccountId: selected } } });
    }
    otherCalls += 1;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const a = account({ id: "a", label: "Account A", limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY * 2) } });
  const b = account({ id: "b", label: "Account B", limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY) } });
  const initial = engineState("claude", [a, b], "a");
  const view = await mount([initial], createReceiptStore(), undefined, "project-p");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["b", "a"]);
  expect(view.host.querySelector('[data-mobile2-account="b"]')?.textContent).toContain(translate(getLocale(), "accounts.nextForUnpinnedShort"));

  selected = "a";
  await view.rerender([engineState("claude", [
    { ...a, limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY) } },
    { ...b, limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY * 2) } },
  ], "a", { limitsVersion: 1 })]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads).toBe(2);
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["a", "b"]);
  expect(view.host.querySelector('[data-mobile2-account="a"]')?.textContent).toContain(translate(getLocale(), "accounts.nextForUnpinnedShort"));
  expect(view.host.querySelector('[data-mobile2-account="b"]')?.textContent).not.toContain(translate(getLocale(), "accounts.nextForUnpinnedShort"));

  selected = "b";
  await view.rerender([engineState("claude", [
    { ...a, limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY) } },
    { ...b, limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY * 2) } },
  ], "a", { limitsVersion: 1 })], NOW + DAY);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads).toBe(3);
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["b", "a"]);
  expect(otherCalls).toBe(0);
});

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};

test.each(["en", "uk"] as const)("phone reset rows show Claude beside Codex in %s", async (locale) => {
  const previous = getLocale();
  setLocale(locale);
  try {
    const reset = NOW + DAY;
    const engines = (["claude", "codex"] as const).map(engine => {
      const candidate = account({ id: `${engine}-windows`, label: "Account A", limits: {
        freshness: "fresh", checkedAt: new Date(NOW * 1000).toISOString(),
        session: window5h(20, NOW + HOUR), weekly: windowWeek(40, reset),
        tiers: engine === "claude" ? [{ tier: "opus", ...windowWeek(50, reset + DAY) }] : [],
      } });
      return engineState(engine, [candidate], candidate.id);
    });
    const view = await mount(engines);
    for (const engine of ["claude", "codex"] as const) {
      const block = view.host.querySelector(`[data-account-limits="${engine}-windows"]`)!;
      expect(block.querySelector('[data-limit-row="weekly"]')?.textContent).toContain(translate(locale, "limits.reset", {
        eta: formatResetEta(reset, NOW), at: formatResetClock(reset, NOW),
      }));
      if (engine === "claude") expect(block.querySelector('[data-limit-row="tier:opus"]')?.textContent).toContain(formatResetClock(reset + DAY, NOW));
    }
  } finally { setLocale(previous); }
});

test.each(["en", "uk"] as const)("phone panel marks and leads with the reset-aware next choice in %s", async (locale) => {
  const previous = getLocale();
  setLocale(locale);
  try {
    const now = NOW * 1_000;
    const observation = (accountId: string, usedPercent: number, resetDays: number): DurableQuotaObservation => ({
      engine: "claude", accountId, authenticated: true,
      authCheckedAt: new Date(now - 60_000).toISOString(), observedAt: new Date(now - 60_000).toISOString(),
      provenance: { source: "live", reason: null, staleSince: null }, bootId: "phone-reset-choice",
      limits: {
        session: { usedPercent, resetsAt: NOW + resetDays * DAY },
        weekly: { usedPercent, resetsAt: NOW + resetDays * DAY },
        plan: "max", capturedAt: NOW - 60,
      },
    });
    const selected = selectProjectAccount({
      project: "project-fixture", engine: "claude",
      accounts: [{ id: "a", authPresent: true }, { id: "b", authPresent: true }],
      observations: [observation("a", 10, 2), observation("b", 50, 1)],
      bindings: [], preferredId: "a", model: "sonnet", now,
    });
    expect(selected).toEqual({ kind: "available", accountId: "b" });
    const selectedId = selected.kind === "available" ? selected.accountId : null;
    const a = account({ id: "a", label: "Account A" });
    const b = account({ id: "b", label: "Account B" });
    const view = await mount([engineState("claude", [a, b], "a")], createReceiptStore(), { claude: selectedId });
    const rows = [...view.host.querySelectorAll('[data-mobile2-account]')];
    expect(rows.map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["b", "a"]);
    expect(rows[0]?.textContent).toContain(translate(locale, "accounts.nextForUnpinnedShort"));
    expect(rows[0]?.getAttribute("data-mobile2-account-state")).toBe("ready");
    expect(rows[1]?.getAttribute("data-mobile2-account-state")).toBe("active");
  } finally { setLocale(previous); }
});

const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

test("every meter on the active card fills with what remains, and the corner names its weekly window", async () => {
  const { host } = await mount([engineState("claude", [claudeMain, claudeLab], "cl-main")]);

  const card = host.querySelector('[data-mobile2-account="cl-main"]')!;
  expect(card.getAttribute("data-mobile2-account-state")).toBe("active");

  const meters = [...card.querySelectorAll('[data-limit-row] [role="meter"]')];
  // 28 / 92 / 29 percent used ⇒ 72 / 8 / 71 percent left, in the design's order.
  expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual(["72", "8", "71"]);
  expect(meters.map((meter) => (meter.firstElementChild as HTMLElement).style.width)).toEqual(["72%", "8%", "71%"]);
  // Coloured by what remains: the nearly spent week is danger, the rest accent.
  expect(meters.map((meter) => meter.getAttribute("data-mobile2-meter-tone"))).toEqual(["accent", "danger", "accent"]);
  expect(text(card.querySelector('[data-limit-row="session"]'))).toContain("72% left");
  expect(text(card.querySelector('[data-limit-row="weekly"]'))).toContain("8% left");
  expect(text(card.querySelector('[data-limit-row="tier:opus"]'))).toContain("71% left");

  // The card lists its windows, so its header carries no second weekly figure;
  // the collapsed card below keeps the corner, where it is the only figure.
  expect(card.querySelector("[data-mobile2-account-corner]")).toBeNull();
  expect(text(card).match(/8% left/g)).toHaveLength(1);
  const quietCorner = host.querySelector('[data-mobile2-account="cl-lab"] [data-mobile2-account-corner]')!;
  expect(quietCorner.getAttribute("data-mobile2-account-window")).toBe("Week");
  expect(text(quietCorner)).toBe("64% leftWeek");
  expect(quietCorner.getAttribute("aria-label")).toBe("64% left of the Week window");
  // The number the corner shows is the weekly window's headroom, never the
  // first window's and never what was used.
  expect(mobileAccountCorner({ session: null, weekly: null, tiers: [], plan: null }, (key: string) => key)).toBeNull();
});

test("the corner names the week even when the 5-hour window is tighter, and says so when there is no week", async () => {
  // The operator's reading: 77 % of the week left, 36 % of the 5-hour window.
  const both = account({ id: "cl-both", label: "Both", plan: "max", limits: { freshness: "fresh", session: window5h(64, NOW + 2 * HOUR), weekly: windowWeek(23, NOW + 3 * DAY), plan: "max", capturedAt: NOW - 60, checkedAt: new Date((NOW - 60) * 1000).toISOString() } } as Partial<AccountOption> & { id: string; label: string });
  const fiveHourOnly = account({ id: "cl-5h", label: "Five", plan: "max", limits: { freshness: "fresh", session: window5h(64, NOW + 2 * HOUR), weekly: null, plan: "max", capturedAt: NOW - 60, checkedAt: new Date((NOW - 60) * 1000).toISOString() } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("claude", [both, fiveHourOnly], "cl-both")]);

  // The active card names the week once, in its rows; its header repeats nothing.
  expect(host.querySelector('[data-mobile2-account="cl-both"] [data-mobile2-account-corner]')).toBeNull();
  expect(text(host.querySelector('[data-mobile2-account="cl-both"] [data-limit-row="weekly"]'))).toContain("77% left");
  const bare = host.querySelector('[data-mobile2-account="cl-5h"] [data-mobile2-account-corner]')!;
  expect(text(bare)).toBe("no weekly data");
  expect(text(bare)).not.toContain("36");
});

test("a sign-in being verified shows no result of the attempt before it, and a failed one keeps its error", async () => {
  const verifying = account({ id: "cl-verify", label: "Verify", authPresent: true, authHealth: "error", loginPending: true, loginState: "pending",
    login: { operationId: "op-verify", phase: "verifying", loginUrl: null, acceptsCode: false, deadlineAt: "2026-10-12T12:00:00Z", result: null } } as Partial<AccountOption> & { id: string; label: string });
  const failed = account({ id: "cl-failed", label: "Failed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "failed",
    login: { operationId: "op-failed", phase: "failed", loginUrl: null, acceptsCode: false, deadlineAt: "2026-10-12T12:00:00Z", result: { status: "failure", code: "timed_out", message: "fixture timed out" } } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("claude", [claudeMain, verifying, failed], "cl-main")]);

  const pending = host.querySelector('[data-mobile2-account="cl-verify"]')!;
  expect(pending.getAttribute("data-mobile2-account-state")).toBe("pending");
  expect(text(pending)).toContain("signing in");
  expect(text(pending)).toContain("Verifying…");
  expect(text(pending)).not.toContain("Auth error");
  expect(text(pending)).not.toContain("no data yet");
  const failedCard = host.querySelector('[data-mobile2-account="cl-failed"]')!;
  expect(text(failedCard)).toContain("Retry");
  expect(text(failedCard)).toContain("Sign-in timed out.");
});

test("the quiet row of an authenticated account switches future launches on the tap, and the receipt carries Switch back", async () => {
  const selected: string[] = [];
  const state = engineState("claude", [claudeMain, claudeLab], "cl-main", {
    select: async (id: string) => { selected.push(id); return true; },
  });
  const { host, receipts } = await mount([state]);

  const row = host.querySelector('[data-mobile2-account-switch="cl-lab"]');
  expect(row?.getAttribute("aria-label")).toBe("Use Lab for future launches");
  expect(text(host.querySelector('[data-mobile2-account="cl-lab"]'))).toContain("ready");

  await click(row);

  // One tap, no confirmation step, one selection.
  expect(selected).toEqual(["cl-lab"]);
  expect(host.querySelector("button[data-confirm]")).toBeNull();
  const receipt = receipts.getState()!;
  expect(receipt.text).toBe("Future launches use Lab");
  expect(receipt.inverse?.kind).toBe("switchBack");

  await act(async () => receipt.inverse!.run());
  expect(selected).toEqual(["cl-lab", "cl-main"]);
});

test("Refresh and Use one reset act on the tap and answer with a receipt; the reset is offered only where a credit exists", async () => {
  const refreshed: string[] = [];
  const redeemed: string[] = [];
  const claude = engineState("claude", [claudeMain], "cl-main", {
    refreshLimits: async (id: string) => { refreshed.push(id); return true; },
  });
  const codex = engineState("codex", [codexMain], "cx-main", {
    refreshLimits: async (id: string) => { refreshed.push(id); return true; },
    useResetCredit: async (id: string) => { redeemed.push(id); return true; },
  });
  const { host, receipts } = await mount([claude, codex]);

  // A Claude card carries no reset control at all; Codex carries one.
  expect(host.querySelector('[data-mobile2-accounts-engine="claude"] [data-account-use-reset]')).toBeNull();
  const reset = host.querySelector('[data-account-use-reset="cx-main"]') as HTMLButtonElement;
  expect(reset.disabled).toBe(false);
  expect(text(host.querySelector('[data-account-reset-credits="cx-main"]'))).toContain("1 reset available");

  await click(host.querySelector('[data-account-refresh-limits="cl-main"]'));
  expect(refreshed).toEqual(["cl-main"]);
  expect(receipts.getState()?.text).toBe("Limits re-read for Main");

  await click(reset);
  expect(redeemed).toEqual(["cx-main"]);
  expect(receipts.getState()?.text).toBe("Reset used on Main");
});

test("a Codex card with no reset credit still shows Refresh, with the reset control disabled", async () => {
  const spent = account({ ...codexMain, resetCredits: { availableCount: 0, expiresAt: null } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("codex", [spent], "cx-main")]);

  expect((host.querySelector('[data-account-refresh-limits="cx-main"]') as HTMLButtonElement).disabled).toBe(false);
  expect((host.querySelector('[data-account-use-reset="cx-main"]') as HTMLButtonElement).disabled).toBe(true);
  expect(text(host.querySelector('[data-account-reset-credits="cx-main"]'))).toContain("No resets available");
});

test("a Codex row that is not signed in opens the device sign-in, shows its code, and stays inactive", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ account: { id: "cx-spare" }, deviceAuth: { url: "https://example.invalid/device", code: "ABCD-EFGH" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const selected: string[] = [];
  try {
    const state = engineState("codex", [codexMain, codexSpare], "cx-main", {
      select: async (id: string) => { selected.push(id); return true; },
    });
    const { host, receipts } = await mount([state]);

    const row = host.querySelector('[data-mobile2-account-signin="cx-spare"]')!;
    expect(text(row)).toContain("needs sign-in");
    expect(text(row)).toContain("sign in");
    // The row is a sign-in, never a switch: nothing here can make it active.
    expect(host.querySelector('[data-mobile2-account-switch="cx-spare"]')).toBeNull();

    await click(row);

    expect(calls).toEqual([{ url: "/api/accounts/codex", body: { action: "retry", id: "cx-spare" } }]);
    expect(selected).toEqual([]);
    expect(host.querySelector('[data-mobile2-account="cx-spare"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
    expect(host.querySelector('[data-mobile2-account="cx-main"]')?.getAttribute("data-mobile2-account-state")).toBe("active");
    const challenge = host.querySelector("[data-mobile2-account-device-signin]")!;
    expect(challenge.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/device");
    expect(text(challenge)).toContain("ABCD-EFGH");
    expect(receipts.getState()?.text).toBe("Device sign-in opened for Spare — it becomes active once signed in");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("#2166: Codex Main signs in directly, with no label and no second account, and its sign-in has Cancel", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ account: { id: "default" }, deviceAuth: { url: "https://example.invalid/device", code: "WXYZ-1234" }, cancelled: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const main = account({ id: "default", label: "Main", kind: "legacy", authPresent: false, authHealth: "signed_out" } as Partial<AccountOption> & { id: string; label: string });
    const { host } = await mount([engineState("codex", [main], "default")]);
    const row = host.querySelector('[data-mobile2-account-signin="default"]')!;
    expect(text(row)).toContain("sign in");
    await click(row);
    expect(calls).toEqual([{ url: "/api/accounts/codex", body: { action: "retry", id: "default" } }]);
    const challenge = host.querySelector("[data-mobile2-account-device-signin]")!;
    expect(text(challenge)).toContain("WXYZ-1234");
    await click(host.querySelector('[data-mobile2-account-signin-cancel="default"]'));
    expect(calls.at(-1)).toEqual({ url: "/api/accounts/codex", body: { action: "cancel", id: "default" } });
    expect(host.querySelector("[data-mobile2-account-device-signin]")).toBeNull();
    /* Nothing asked for a label: the add row stays closed. */
    expect(host.querySelector("[data-mobile2-account-add-form]")).toBeNull();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Claude row that is not signed in restarts its login in place and stays inactive", async () => {
  const retried: string[] = [];
  const selected: string[] = [];
  const state = engineState("claude", [claudeMain, claudeSecond], "cl-main", {
    retryLogin: async (id: string) => { retried.push(id); return true; },
    select: async (id: string) => { selected.push(id); return true; },
  });
  const { host, receipts } = await mount([state]);

  await click(host.querySelector('[data-mobile2-account-signin="cl-second"]'));

  expect(retried).toEqual(["cl-second"]);
  expect(selected).toEqual([]);
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(receipts.getState()?.text).toBe("Device sign-in opened for Second — it becomes active once signed in");
});

test("a signed-out account is never the active card, even while the registry still names it active", async () => {
  const { host } = await mount([engineState("claude", [claudeSecond, claudeLab], "cl-second")]);

  expect(mobileAccountState(claudeSecond, "cl-second")).toBe("needsSignIn");
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(host.querySelector("[data-account-limits]")).toBeNull();
  expect(host.querySelector('[data-mobile2-account-signin="cl-second"]')).toBeTruthy();
});

test("the screen is one section per engine — the active card first, the add row last", async () => {
  const { host } = await mount([
    engineState("claude", [claudeLab, claudeMain, claudeSecond], "cl-main"),
    engineState("codex", [codexMain], "cx-main"),
  ]);

  const sections = [...host.querySelectorAll("[data-mobile2-accounts-engine]")];
  expect(sections.map((section) => section.getAttribute("data-mobile2-accounts-engine"))).toEqual(["claude", "codex"]);

  const claude = sections[0];
  expect([...claude.querySelectorAll("[data-mobile2-account]")].map((card) => card.getAttribute("data-mobile2-account"))).toEqual(["cl-main", "cl-lab", "cl-second"]);
  const add = claude.querySelector('[data-mobile2-account-add="claude"]');
  expect(add).toBeTruthy();
  expect(text(add)).toContain("Add a Claude account");
  expect(claude.lastElementChild?.getAttribute("data-claude-provider-editor")).toBe("new");
  expect(text(claude.querySelector('[data-mobile2-account="cl-main"]'))).toContain("Max plan");
  // A quiet row keeps its own reading line: plan and when it was last checked.
  expect(text(claude.querySelector('[data-mobile2-account="cl-lab"]'))).toContain("checked");
});

test("an account with no reading says so instead of drawing an empty meter", async () => {
  const bare = account({ id: "cl-bare", label: "Bare" });
  const { host } = await mount([engineState("claude", [bare], "cl-bare")]);

  expect(host.querySelector('[data-mobile2-account="cl-bare"] [role="meter"]')).toBeNull();
  expect(host.querySelector("[data-mobile2-account-corner]")).toBeNull();
  expect(text(host.querySelector("[data-account-limits]"))).toContain("no reading yet");
});

test("the account a badge steered here (#229) is ringed on the screen it lands on", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(
    <MobileAccountsBody engines={[engineState("claude", [claudeMain, claudeLab], "cl-main")]} now={NOW} focusAccountId="cl-lab" receipts={createReceiptStore()} />,
  ));

  expect(host.querySelector('[data-mobile2-account="cl-lab"]')?.className).toContain("ring-accent/50");
  expect(host.querySelector('[data-mobile2-account="cl-main"]')?.className).not.toContain("ring-accent/50");
});

test("a refusal sits inside the refused account's card with a 44 px close (#1857)", async () => {
  const { host } = await mount([engineState("claude", [claudeMain, claudeLab], "cl-main", {
    removal: { kind: "refused", refusal: { accountId: "cl-lab", label: "Lab", reasons: ["live_sessions"] } },
  })]);
  const block = host.querySelector('[data-mobile2-account="cl-lab"] [data-account-refusal="cl-lab"]');
  expect(text(block)).toContain("An agent is still running on Lab.");
  expect(host.querySelector('[data-mobile2-account="cl-main"] [data-account-refusal]')).toBeNull();
  const close = block!.querySelector('button[aria-label="Close this message"]')!;
  expect(close.className).toContain("h-11 w-11");
  expect(close.className).not.toContain("sm:h-5");
});

test("the removal summary is the first element of its engine section on the phone (#1857)", async () => {
  const { host } = await mount([engineState("claude", [claudeMain], "cl-main", {
    removal: {
      kind: "removed",
      summary: { accountId: "cl-lab", label: "Lab", archive: archiveUnderHome("cl-lab"), files: 12, bytes: 14_200_000, conversations: 3, pins: 0, deliveries: 0, migrations: 0, credential: "clean", bindings: 0, hiddenHome: null },
    },
  })]);
  const section = host.querySelector('[data-mobile2-accounts-engine="claude"]')!;
  const card = section.querySelector('[data-account-removal-card="removed"]')!;
  expect(text(card)).toContain("Lab removed");
  expect(text(card)).toContain("12 files · 14.2 MB");
  const first = section.querySelector("[data-mobile2-account]")!;
  expect(card.compareDocumentPosition(first) & 4).toBe(4);
});

/* Task d7759de2: on the phone (and the setup guide's Engines step, which
   draws this section) a hidden Main is offered back under the add row. */
test("a hidden Main is offered back under the add row on the phone", async () => {
  const restored: string[] = [];
  const { host } = await mount([engineState("claude", [claudeLab], "cl-lab", {
    hidden: [{ id: "default", label: "Main" }],
    restore: async (id) => { restored.push(id); return true; },
  })]);
  const section = host.querySelector('[data-mobile2-accounts-engine="claude"]')!;
  const offer = section.querySelector('[data-account-hidden-offer="default"]')!;
  expect(text(offer)).toContain("Main is removed from Delegatus");
  expect(section.querySelector('[data-mobile2-account-add="claude"]')!.compareDocumentPosition(offer) & 4).toBe(4);
  const button = offer.querySelector('[data-account-restore="default"]') as HTMLButtonElement;
  expect(button.className).toContain("min-h-[44px]");
  await act(async () => button.click());
  expect(restored).toEqual(["default"]);
});
