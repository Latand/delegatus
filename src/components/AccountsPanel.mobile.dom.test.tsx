import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import { getLocale, setLocale, translate } from "@/lib/i18n";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

import { MobileAccountsBody, mobileAccountState, ProjectAwareMobileAccountsBody } from "./AccountsPanel";
import { createReceiptStore, type ReceiptStore } from "./mobile/MobileReceipt";
import { formatResetClock } from "./rateLimit";

/*
 * The Accounts & limits screen on the phone (issue #1439, lane 9;
 * docs/design/mobile-v2/README.md §4.8): the same row as the desktop dialog,
 * every window on the row, a press that opens the row and selects nothing,
 * Make default as its own control inside it (with the Switch back receipt),
 * a row that is not signed in with Sign in on its head, and the add row last.
 *
 * The number the design fixes is asserted here because it used to mean the
 * opposite: every bar fills with what REMAINS, coloured by what remains (§5, P2-4).
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

test("a Codex phone row with paid credits near its limit can change paid spending without switching the active account", async () => {
  const writes: Array<{ id: string; enabled: boolean }> = [];
  let selections = 0;
  const paidCredits = { balance: "49695.72", checkedAt: null };
  const nearLimit = (id: string, usedPercent: number) => account({ id, label: id, paidCredits,
    limits: { freshness: "fresh", session: window5h(20, NOW + HOUR), weekly: windowWeek(usedPercent, NOW + DAY) } });
  const near = nearLimit("cx-near", 96);
  const ready = nearLimit("cx-ready", 20);
  const state = engineState("codex", [codexMain, near, ready, codexSpare], codexMain.id, {
    setSpendCredits: async (id, enabled) => { writes.push({ id, enabled }); return true; },
    select: async () => { selections++; return true; },
  });
  const view = await mount([state]);
  const blockOf = (id: string) => view.host.querySelector(`[data-mobile2-account="${id}"] [data-account-spend-credits="${id}"]`);
  for (const id of [codexMain.id, ready.id, codexSpare.id]) expect(blockOf(id)).toBeNull();
  const toggle = blockOf(near.id)?.querySelector('[role="switch"]');
  expect(toggle).not.toBeNull();
  await act(async () => { (toggle as HTMLElement).click(); });
  expect(writes).toEqual([{ id: near.id, enabled: true }]);
  expect(selections).toBe(0);
});

test("phone provider credential damage shows repair and never offers sign-in", async () => {
  const damaged = account({ id: "cl-provider", label: "Provider", authPresent: false, authHealth: "error",
    provider: { baseUrl: "https://example.invalid/anthropic", model: "large", smallFastModel: null } });
  const view = await mount([engineState("claude", [damaged], damaged.id)]);
  const row = view.host.querySelector('[data-mobile2-account="cl-provider"]') as HTMLElement;
  expect(mobileAccountState(damaged, damaged.id)).toBe("error");
  expect(row.getAttribute("data-mobile2-account-state")).toBe("error");
  expect(row.querySelector("[data-account-status]")?.getAttribute("aria-label")).toBe("Provider: Provider credential error");
  await open(view.host, "cl-provider");
  expect(row.textContent).toContain("Edit provider");
  expect(row.textContent).not.toContain("Needs sign-in");
  expect(row.textContent).not.toContain("Not logged in");
  expect(row.querySelector("[data-account-signin-start]")).toBeNull();
  const repaired = { ...damaged, authPresent: true, authHealth: "unknown" as const };
  await view.rerender([engineState("claude", [repaired], repaired.id)]);
  expect(view.host.querySelector('[data-mobile2-account="cl-provider"]')?.getAttribute("data-mobile2-account-state")).toBe("active");
});

test("the phone provider editor takes the row's full width and room for its longest placeholder", async () => {
  const provider = account({ id: "cl-provider", label: "Provider", authPresent: true,
    provider: { baseUrl: "https://example.invalid/anthropic", model: "large", smallFastModel: null } });
  const view = await mount([engineState("claude", [provider], provider.id)]);
  await open(view.host, "cl-provider");
  await click(view.host.querySelector('[data-mobile2-account="cl-provider"] [data-account-provider-edit]'));
  const editor = view.host.querySelector('[data-claude-provider-editor="cl-provider"]') as HTMLElement;
  expect(editor.className).toContain("-ml-8");
  expect((editor.querySelector("textarea") as HTMLTextAreaElement).getAttribute("rows")).toBe("5");
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
  const otherCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/account-project-bindings")) {
      reads += 1;
      return Response.json({ engines: { claude: { nextChosenAccountId: selected } } });
    }
    /* The screen also reads the install transfer's checklist rows; none here, and not the call under test. */
    if (String(input).startsWith("/api/transfer/accounts")) return Response.json({ ok: true, result: [] });
    otherCalls.push(String(input));
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const a = account({ id: "a", label: "Account A", limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY * 2) } });
  const b = account({ id: "b", label: "Account B", limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY) } });
  const initial = engineState("claude", [a, b], "a");
  const view = await mount([initial], createReceiptStore(), undefined, "project-p");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["b", "a"]);
  const noteOf = async (id: string) => {
    await click(view.host.querySelector(`[data-mobile2-account="${id}"] [data-account-status]`));
    const note = document.body.querySelector(`[data-account-status-popover="${id}"]`)?.textContent ?? "";
    await click(view.host.querySelector(`[data-mobile2-account="${id}"] [data-account-status]`));
    return note;
  };
  expect(await noteOf("b")).toContain(translate(getLocale(), "accounts.nextForUnpinned"));

  selected = "a";
  await view.rerender([engineState("claude", [
    { ...a, limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY) } },
    { ...b, limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY * 2) } },
  ], "a", { limitsVersion: 1 })]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads).toBe(2);
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["a", "b"]);
  expect(await noteOf("a")).toContain(translate(getLocale(), "accounts.nextForUnpinned"));
  expect(await noteOf("b")).not.toContain(translate(getLocale(), "accounts.nextForUnpinned"));

  selected = "b";
  await view.rerender([engineState("claude", [
    { ...a, limits: { freshness: "fresh", session: null, weekly: windowWeek(30, NOW + DAY) } },
    { ...b, limits: { freshness: "fresh", session: null, weekly: windowWeek(50, NOW + DAY * 2) } },
  ], "a", { limitsVersion: 1 })], NOW + DAY);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads).toBe(3);
  expect([...view.host.querySelectorAll("[data-mobile2-account]")].map((row) => row.getAttribute("data-mobile2-account"))).toEqual(["b", "a"]);
  expect(otherCalls).toEqual([]);
});

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
/** A press on a row's name opens it in place. */
const open = (host: HTMLElement, id: string) => click(host.querySelector(`[data-account-toggle="${id}"]`));

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
      expect(block.querySelector('[data-limit-row="weekly"]')?.textContent).toContain(formatResetClock(reset, NOW));
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
    await click(rows[0]!.querySelector("[data-account-status]"));
    expect(document.body.querySelector('[data-account-status-popover="b"]')?.textContent).toContain(translate(locale, "accounts.nextForUnpinned"));
    expect(rows[0]?.getAttribute("data-mobile2-account-state")).toBe("ready");
    expect(rows[1]?.getAttribute("data-mobile2-account-state")).toBe("active");
  } finally { setLocale(previous); }
});

const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

test("every bar on the default row fills with what remains, coloured by what remains, and no percentage is said twice", async () => {
  const { host } = await mount([engineState("claude", [claudeMain, claudeLab], "cl-main")]);

  const card = host.querySelector('[data-mobile2-account="cl-main"]')!;
  expect(card.getAttribute("data-mobile2-account-state")).toBe("active");

  const fills = [...card.querySelectorAll<HTMLElement>("[data-limit-row] [data-meter-fill]")];
  // 28 / 92 / 29 percent used ⇒ 72 / 8 / 71 percent left, in the design's order.
  expect(fills.map((fill) => fill.getAttribute("data-meter-fill"))).toEqual(["72", "8", "71"]);
  // Coloured by what remains: the nearly spent week is danger, the rest the engine's tint.
  expect(fills.map((fill) => fill.getAttribute("data-meter-tone"))).toEqual(["engine", "danger", "engine"]);
  expect(text(card.querySelector('[data-limit-row="session"]'))).toContain("72%");
  expect(text(card.querySelector('[data-limit-row="weekly"]'))).toContain("8%");
  expect(text(card.querySelector('[data-limit-row="tier:opus"]'))).toContain("71%");
  expect(card.querySelector('[data-limit-row="weekly"] [data-limit-number]')?.getAttribute("aria-label")).toBe("8% left of the Week window");

  // The row lists its windows and has no summary figure beside them, and the
  // caption says once what the numbers mean.
  expect(card.querySelector("[data-mobile2-account-corner]")).toBeNull();
  expect(text(card).match(/8%/g)).toHaveLength(1);
  expect(text(host.querySelector("[data-accounts-caption]"))).toBe("% left · reset");
  // The other row carries its windows too, so a closed row says everything at a glance.
  expect(text(host.querySelector('[data-mobile2-account="cl-lab"] [data-limit-row="weekly"]'))).toContain("64%");
});

test("a row with only a 5-hour window lists just that window", async () => {
  const fiveHourOnly = account({ id: "cl-5h", label: "Five", plan: "max", limits: { freshness: "fresh", session: window5h(64, NOW + 2 * HOUR), weekly: null, plan: "max", capturedAt: NOW - 60, checkedAt: new Date((NOW - 60) * 1000).toISOString() } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("claude", [fiveHourOnly], "cl-5h")]);

  expect([...host.querySelectorAll("[data-limit-row]")].map((row) => row.getAttribute("data-limit-row"))).toEqual(["session"]);
  expect(text(host.querySelector('[data-limit-row="session"]'))).toContain("36%");
});

test("a sign-in being verified shows no result of the attempt before it, and a failed one keeps its error", async () => {
  const verifying = account({ id: "cl-verify", label: "Verify", authPresent: true, authHealth: "error", loginPending: true, loginState: "pending",
    login: { operationId: "op-verify", phase: "verifying", loginUrl: null, acceptsCode: false, deadlineAt: "2026-10-12T12:00:00Z", result: null } } as Partial<AccountOption> & { id: string; label: string });
  const failed = account({ id: "cl-failed", label: "Failed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "failed",
    login: { operationId: "op-failed", phase: "failed", loginUrl: null, acceptsCode: false, deadlineAt: "2026-10-12T12:00:00Z", result: { status: "failure", code: "timed_out", message: "fixture timed out" } } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("claude", [claudeMain, verifying, failed], "cl-main")]);

  const pending = host.querySelector('[data-mobile2-account="cl-verify"]')!;
  expect(pending.getAttribute("data-mobile2-account-state")).toBe("pending");
  expect(pending.querySelector("[data-account-status]")?.getAttribute("aria-label")).toBe("Verify: signing in…");
  expect(text(pending)).toContain("Verifying…");
  expect(text(pending)).not.toContain("Auth error");
  expect(text(pending)).not.toContain("No data yet");
  const failedCard = host.querySelector('[data-mobile2-account="cl-failed"]')!;
  expect(text(failedCard)).toContain("Retry");
  expect(text(failedCard)).toContain("Sign-in timed out.");
});

test("a tap on a row opens it and switches nothing; Make default switches future launches, and the receipt carries Switch back", async () => {
  const selected: string[] = [];
  const state = engineState("claude", [claudeMain, claudeLab], "cl-main", {
    select: async (id: string) => { selected.push(id); return true; },
  });
  const { host, receipts } = await mount([state]);

  const toggle = host.querySelector('[data-account-toggle="cl-lab"]');
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(selected).toEqual([]);
  expect(receipts.getState()).toBeNull();

  const make = host.querySelector('[data-account-make-default="cl-lab"]');
  expect(make?.getAttribute("aria-label")).toBe("Make Lab the default account");
  await click(make);

  // One tap, no confirmation step, one selection.
  expect(selected).toEqual(["cl-lab"]);
  expect(host.querySelector("button[data-confirm]")).toBeNull();
  const receipt = receipts.getState()!;
  expect(receipt.text).toBe("Future launches use Lab");
  expect(receipt.inverse?.kind).toBe("switchBack");

  await act(async () => receipt.inverse!.run());
  expect(selected).toEqual(["cl-lab", "cl-main"]);
});

test("an opened phone row carries Copy CLI and Remove, and the removal keeps its two steps", async () => {
  const removed: string[] = [];
  const copied: string[] = [];
  const { host } = await mount([engineState("claude", [claudeMain, claudeLab], "cl-main", {
    remove: async (id: string) => { removed.push(id); return true; },
    copyTerminalCommand: async (id: string) => { copied.push(id); return true; },
  })]);
  await open(host, "cl-lab");
  const target = (selector: string) => host.querySelector<HTMLElement>(`[data-mobile2-account="cl-lab"] ${selector}`);
  expect(target('[data-account-copy-cli="cl-lab"]')?.className).toContain("min-h-11");
  await click(target('[data-account-copy-cli="cl-lab"]'));
  expect(copied).toEqual(["cl-lab"]);
  await click(target('[data-account-remove="cl-lab"]'));
  expect(removed).toEqual([]);
  await click(target('[data-account-remove-confirm="cl-lab"]'));
  expect(removed).toEqual(["cl-lab"]);
});

test("Refresh acts on the tap and Use one reset on its confirm, each answering with a receipt; the reset is offered only where a credit exists", async () => {
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

  // Refresh lives in the opened row.
  await open(host, "cl-main");
  await click(host.querySelector('[data-account-refresh-limits="cl-main"]'));
  expect(refreshed).toEqual(["cl-main"]);
  expect(receipts.getState()?.text).toBe("Limits re-read for Main");

  // The first tap arms the confirmation in the row and spends nothing; the confirm spends once.
  await click(reset);
  expect(redeemed).toEqual([]);
  expect(host.querySelector('[data-account-reset-armed="cx-main"]')).not.toBeNull();
  expect(receipts.getState()?.text).toBe("Limits re-read for Main");
  await click(host.querySelector('[data-account-reset-confirm="cx-main"]'));
  expect(redeemed).toEqual(["cx-main"]);
  expect(receipts.getState()?.text).toBe("Reset used on Main");
});

test("a Codex row with no reset credit offers Refresh in the opened row and says there is no reset to use", async () => {
  const spent = account({ ...codexMain, resetCredits: { availableCount: 0, expiresAt: null } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("codex", [spent], "cx-main")]);

  expect(host.querySelector('[data-account-use-reset="cx-main"]')).toBeNull();
  await open(host, "cx-main");
  expect((host.querySelector('[data-account-refresh-limits="cx-main"]') as HTMLButtonElement).disabled).toBe(false);
  expect(text(host.querySelector('[data-account-reset-credits="cx-main"]'))).toContain("No resets available");
});

test("a Codex row that is not signed in opens the device sign-in, shows its code, and stays inactive", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    /* The screen also reads the install transfer's checklist rows; none here, and not the call under test. */
    if (String(url).startsWith("/api/transfer/accounts")) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ account: { id: "cx-spare" }, deviceAuth: { url: "https://example.invalid/device", code: "ABCD-EFGH" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const selected: string[] = [];
  try {
    const state = engineState("codex", [codexMain, codexSpare], "cx-main", {
      select: async (id: string) => { selected.push(id); return true; },
    });
    const { host, receipts } = await mount([state]);

    const row = host.querySelector('[data-account-signin-start="cx-spare"]')!;
    expect(host.querySelector('[data-mobile2-account="cx-spare"] [data-account-status]')?.getAttribute("aria-label")).toBe("Spare: Signed out");
    expect(text(row)).toBe("Sign in");
    // The row is a sign-in, never a switch: nothing here can make it active.
    expect(host.querySelector('[data-mobile2-account-switch="cx-spare"]')).toBeNull();

    await click(row);

    expect(calls).toEqual([{ url: "/api/accounts/codex", body: { action: "retry", id: "cx-spare" } }]);
    expect(selected).toEqual([]);
    expect(host.querySelector('[data-mobile2-account="cx-spare"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
    expect(host.querySelector('[data-mobile2-account="cx-main"]')?.getAttribute("data-mobile2-account-state")).toBe("active");
    const challenge = host.querySelector('[data-account-signin="cx-spare"]')!;
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
    /* The screen also reads the install transfer's checklist rows; none here, and not the call under test. */
    if (String(url).startsWith("/api/transfer/accounts")) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ account: { id: "default" }, deviceAuth: { url: "https://example.invalid/device", code: "WXYZ-1234" }, cancelled: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const main = account({ id: "default", label: "Main", kind: "legacy", authPresent: false, authHealth: "signed_out" } as Partial<AccountOption> & { id: string; label: string });
    const { host } = await mount([engineState("codex", [main], "default")]);
    const row = host.querySelector('[data-account-signin-start="default"]')!;
    expect(text(row)).toBe("Sign in");
    await click(row);
    expect(calls).toEqual([{ url: "/api/accounts/codex", body: { action: "retry", id: "default" } }]);
    const challenge = host.querySelector('[data-account-signin="default"]')!;
    expect(text(challenge)).toContain("WXYZ-1234");
    await click(host.querySelector('[data-account-signin-cancel="default"]'));
    expect(calls.at(-1)).toEqual({ url: "/api/accounts/codex", body: { action: "cancel", id: "default" } });
    expect(host.querySelector('[data-account-signin="default"]')).toBeNull();
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

  await click(host.querySelector('[data-account-signin-start="cl-second"]'));

  expect(retried).toEqual(["cl-second"]);
  expect(selected).toEqual([]);
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(receipts.getState()?.text).toBe("Device sign-in opened for Second — it becomes active once signed in");
});

test("a signed-out account is never the active card, even while the registry still names it active", async () => {
  const { host } = await mount([engineState("claude", [claudeSecond, claudeLab], "cl-second")]);

  expect(mobileAccountState(claudeSecond, "cl-second")).toBe("needsSignIn");
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(host.querySelector('[data-mobile2-account="cl-second"] [data-account-limits]')).toBeNull();
  expect(host.querySelector('[data-account-signin-start="cl-second"]')).toBeTruthy();
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
  // The plan is the status popover's.
  await click(claude.querySelector('[data-mobile2-account="cl-main"] [data-account-status]'));
  expect(document.body.querySelector('[data-account-status-popover="cl-main"]')?.textContent).toContain("Max plan");
});

test("an account with no reading says so instead of drawing an empty meter", async () => {
  const bare = account({ id: "cl-bare", label: "Bare" });
  const { host } = await mount([engineState("claude", [bare], "cl-bare")]);

  expect(host.querySelector('[data-mobile2-account="cl-bare"] [role="meter"]')).toBeNull();
  expect(host.querySelector("[data-mobile2-account-corner]")).toBeNull();
  expect(host.querySelector("[data-account-limits]")).toBeNull();
  await open(host, "cl-bare");
  expect(text(host.querySelector('[data-mobile2-account="cl-bare"]'))).toContain(translate(getLocale(), "accounts.noDataYet"));
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
  expect(close.className).toContain("min-h-11");
  expect(close.className).not.toContain("min-h-6");
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

test("the phone's device sign-in line shows until the next read says the account is authenticated or signed out", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/transfer/accounts")) return Response.json({ ok: true, result: [] });
    return Response.json({ account: { id: "cx-spare" }, deviceAuth: { url: "https://example.invalid/device", code: "ABCD-EFGH" } });
  }) as typeof fetch;
  const view = await mount([engineState("codex", [codexMain, codexSpare], "cx-main")]);
  const line = () => view.host.querySelector('[data-account-signin="cx-spare"]');
  const pressed = async () => {
    await click(view.host.querySelector('[data-account-signin-start="cx-spare"]'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await pressed();
  expect(text(line())).toContain("ABCD-EFGH");
  await view.rerender([engineState("codex", [codexMain, { ...codexSpare, authPresent: true, authHealth: "authenticated" }], "cx-main")]);
  expect(line()).toBeNull();
  // Signed out again with no pending login: pressed anew, then a read that leaves it so.
  await view.rerender([engineState("codex", [codexMain, codexSpare], "cx-main")]);
  await pressed();
  expect(line()).not.toBeNull();
  await view.rerender([engineState("codex", [codexMain, { ...codexSpare }], "cx-main")]);
  expect(line()).toBeNull();
});
