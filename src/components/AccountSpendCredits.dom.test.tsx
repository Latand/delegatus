import { afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createEngineAccountsStore } from "@/hooks/useEngineAccounts";
import { setLocale, translate } from "@/lib/i18n";
import { AccountSpendCredits, formatPaidBalance } from "./AccountSpendCredits";
import { formatReadClock } from "./rateLimit";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event, MouseEvent: dom.MouseEvent });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); document.body.replaceChildren(); });

test.each(["en", "uk"] as const)("paid spending flips before the reply and rolls back locally in %s", async locale => {
  setLocale(locale);
  const writes: Array<{ body: { accountId: string; spendCredits: boolean }; resolve: (response: Response) => void }> = [];
  const store = createEngineAccountsStore("codex", { fetcher: async (_url, init) => {
    if (init?.method === "PATCH") return new Promise<Response>(resolve => writes.push({ body: JSON.parse(String(init.body)), resolve }));
    return Response.json({ codex: { active: "account-a", accounts: ["account-a", "account-b"].map(id => ({ id, label: id, authPresent: true,
      spendCredits: false, paidCredits: { balance: "12.50", checkedAt: "2026-11-03T12:00:00Z" }, loginPending: false, loginState: "authenticated", deviceAuth: null })) } });
  } });
  await store.refresh();
  function Harness() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return <>{snapshot.accounts.map(account => <AccountSpendCredits key={account.id} account={account} state={{ ...store, ...snapshot, engine: "codex" }} />)}</>;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  flushSync(() => root.render(<Harness />));
  const switches = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
  const on = (index: number) => switches[index]!.getAttribute("aria-checked") === "true";
  expect(switches).toHaveLength(2);
  expect(on(0)).toBe(false);
  expect(host.textContent).toContain(formatPaidBalance("12.50", locale));
  expect(host.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T|\dZ\b|\.000/);
  expect(host.querySelector('[data-account-spend-credits="account-a"]')!.textContent).not.toContain(translate(locale, "accounts.spendCreditsOn"));
  flushSync(() => switches[0]!.click());
  expect(on(0)).toBe(true);
  expect(on(1)).toBe(false);
  expect(host.querySelector('[data-account-spend-credits="account-a"]')!.textContent).toContain(translate(locale, "accounts.spendCreditsOn"));
  expect(host.querySelector('[data-account-spend-credits="account-b"]')!.textContent).not.toContain(translate(locale, "accounts.spendCreditsOn"));
  expect(writes[0]!.body).toEqual({ accountId: "account-a", spendCredits: true });
  const rolledBack = new Promise<void>(resolve => {
    const unsubscribe = store.subscribe(() => { if (store.accounts[0]?.spendCreditsError) { unsubscribe(); resolve(); } });
  });
  writes[0]!.resolve(Response.json({ error: "refused" }, { status: 503 }));
  await rolledBack;
  flushSync(() => {});
  expect(on(0)).toBe(false);
  expect(host.querySelector('[data-account-spend-credits="account-a"] [role="alert"]')?.textContent)
    .toBe(translate(locale, "accounts.spendCreditsFailed"));
  expect(host.querySelector('[data-account-spend-credits="account-b"] [role="alert"]')).toBeNull();
  let saved!: Promise<boolean>;
  flushSync(() => { saved = store.setSpendCredits!("account-a", true); });
  writes[1]!.resolve(Response.json(writes[1]!.body));
  expect(await saved).toBe(true);
  flushSync(() => {});
  expect(on(0)).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test.each(["en", "uk"] as const)("an account with no paid balance shows one line in %s", locale => {
  setLocale(locale);
  const account = { id: "account-c", label: "C", authPresent: true, spendCredits: false, paidCredits: { balance: null, checkedAt: null } } as never;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  flushSync(() => root.render(<AccountSpendCredits account={account} state={{ engine: "codex" } as never} />));
  expect(host.querySelectorAll("p")).toHaveLength(1);
  expect(host.querySelector("p")!.textContent).toBe(translate(locale, "accounts.paidNone"));
});

test("a failed save scrolls its alert into view at the nearest edge", () => {
  setLocale("en");
  const calls: unknown[] = [];
  const proto = dom.HTMLElement.prototype as unknown as { scrollIntoView?: (options?: unknown) => void };
  proto.scrollIntoView = options => { calls.push(options); };
  cleanup.push(() => { delete proto.scrollIntoView; });
  const account = { id: "account-d", label: "D", authPresent: true, spendCredits: false } as never;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  const state = { engine: "codex" } as never;
  flushSync(() => root.render(<AccountSpendCredits account={account} state={state} />));
  expect(calls).toEqual([]);
  flushSync(() => root.render(<AccountSpendCredits account={{ ...(account as object), spendCreditsError: true } as never} state={state} />));
  expect(calls).toEqual([{ block: "nearest" }]);
});

test("queued clicks survive a poll and only the failed intent is rolled back", async () => {
  const writes: Array<{ body: unknown; resolve: (response: Response) => void }> = [];
  const store = createEngineAccountsStore("codex", { fetcher: async (_url, init) => init?.method === "PATCH"
    ? new Promise<Response>(resolve => writes.push({ body: JSON.parse(String(init.body)), resolve }))
    : Response.json({ codex: { active: "account-a", accounts: [{ id: "account-a", label: "A", authPresent: true, spendCredits: false }] } }) });
  await store.refresh();
  const first = store.setSpendCredits!("account-a", true);
  const second = store.setSpendCredits!("account-a", false);
  await store.refresh();
  expect(store.accounts[0]!.spendCredits).toBe(false);
  expect(writes).toHaveLength(1);
  writes[0]!.resolve(Response.json(writes[0]!.body));
  expect(await first).toBe(true);
  expect(writes).toHaveLength(2);
  writes[1]!.resolve(Response.json({}, { status: 409 }));
  expect(await second).toBe(false);
  expect(store.accounts[0]!.spendCredits).toBe(true);
  expect(store.accounts[0]!.spendCreditsError).toBe(true);
});

test.each(["en", "uk"] as const)("blank space beside the label never flips the switch in %s", locale => {
  setLocale(locale);
  const flips: boolean[] = [];
  const account = { id: "account-e", label: "E", authPresent: true, spendCredits: false } as never;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  const state = { engine: "codex", setSpendCredits: async (_id: string, next: boolean) => { flips.push(next); return true; } } as never;
  flushSync(() => root.render(<AccountSpendCredits account={account} state={state} />));
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  const label = document.getElementById(toggle.getAttribute("aria-labelledby")!)!;
  expect(label.textContent).toBe(translate(locale, "accounts.spendCredits"));
  expect(host.querySelector("label")).toBeNull();
  flushSync(() => label.click());
  flushSync(() => label.parentElement!.click());
  expect(flips).toEqual([]);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  flushSync(() => toggle.click());
  expect(flips).toEqual([true]);
});

test.each(["en", "uk"] as const)("the balance reads as whole credits in the locale's grouping in %s", locale => {
  const grouped = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
  expect(formatPaidBalance("49695.719750", locale)).toBe(grouped(49696));
  expect(formatPaidBalance("49695.719750", locale)).toMatch(locale === "en" ? /^49,696$/ : /^49\s696$/);
  expect(formatPaidBalance("12.50", locale)).toBe("13");
  expect(formatPaidBalance("100", locale)).toBe("100");
  expect(formatPaidBalance("0.4", locale)).toBe("<1");
  expect(formatPaidBalance("0.999999", locale)).toBe("<1");
  expect(formatPaidBalance("0", locale)).toBe("0");
  expect(formatPaidBalance("0.000000", locale)).toBe("0");
  expect(formatPaidBalance("n/a", locale)).toBe("n/a");
});

test.each(["en", "uk"] as const)("the row shows a fractional, a sub-credit and a zero balance without fractions in %s", locale => {
  setLocale(locale);
  const shown = (balance: string) => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
    const account = { id: "account-w", label: "W", authPresent: true, spendCredits: false, paidCredits: { balance, checkedAt: null } } as never;
    flushSync(() => root.render(<AccountSpendCredits account={account} state={{ engine: "codex" } as never} />));
    return host.querySelector("p.text-muted")!.textContent!;
  };
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(49696);
  expect(shown("49695.719750")).toBe(translate(locale, "accounts.paidBalance", { balance: grouped }));
  expect(shown("49695.719750")).not.toContain("719");
  expect(shown("0.35")).toBe(translate(locale, "accounts.paidBalance", { balance: "<1" }));
  expect(shown("0.000000")).toBe(translate(locale, "accounts.paidBalance", { balance: "0" }));
});

test("turning the switch on brings the warning and the balance into view, once", () => {
  setLocale("en");
  const shown: Array<{ text: string; options: unknown }> = [];
  const proto = dom.HTMLElement.prototype as unknown as { scrollIntoView?: (this: HTMLElement, options?: unknown) => void };
  proto.scrollIntoView = function (options) { shown.push({ text: this.textContent ?? "", options }); };
  cleanup.push(() => { delete proto.scrollIntoView; });
  const paidCredits = { balance: "49695.72", checkedAt: null };
  const off = { id: "account-f", label: "F", authPresent: true, spendCredits: false, paidCredits } as never;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  const state = { engine: "codex" } as never;
  flushSync(() => root.render(<AccountSpendCredits account={off} state={state} />));
  expect(shown).toEqual([]);
  flushSync(() => root.render(<AccountSpendCredits account={{ ...(off as object), spendCredits: true } as never} state={state} />));
  expect(shown).toHaveLength(1);
  expect(shown[0]!.options).toEqual({ block: "nearest" });
  expect(shown[0]!.text).toContain(translate("en", "accounts.spendCreditsOn"));
  expect(shown[0]!.text).toContain("49,696");
  flushSync(() => root.render(<AccountSpendCredits account={{ ...(off as object), spendCredits: true, label: "again" } as never} state={state} />));
  expect(shown).toHaveLength(1);
});

test("an account already on does not scroll when it first appears", () => {
  setLocale("en");
  const shown: unknown[] = [];
  const proto = dom.HTMLElement.prototype as unknown as { scrollIntoView?: (options?: unknown) => void };
  proto.scrollIntoView = options => { shown.push(options); };
  cleanup.push(() => { delete proto.scrollIntoView; });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
  flushSync(() => root.render(<AccountSpendCredits account={{ id: "g", label: "G", authPresent: true, spendCredits: true } as never} state={{ engine: "codex" } as never} />));
  expect(shown).toEqual([]);
});

test.each([["en", false], ["en", true], ["uk", false], ["uk", true]] as const)("a balance read on the previous day names its date in %s (phone: %p)", (locale, phone) => {
  setLocale(locale);
  const now = new Date(2026, 10, 3, 18, 4).getTime();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  cleanup.push(() => clock.mockRestore());
  const lateLastNight = new Date(2026, 10, 2, 23, 14);
  const earlierToday = new Date(2026, 10, 3, 9, 30);
  const render = (checkedAt: Date) => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); cleanup.push(() => flushSync(() => root.unmount()));
    const account = { id: "account-r", label: "R", authPresent: true, spendCredits: true, paidCredits: { balance: "49390.66", checkedAt: checkedAt.toISOString() } } as never;
    flushSync(() => root.render(<AccountSpendCredits account={account} state={{ engine: "codex" } as never} phone={phone} />));
    return host.querySelector("p.text-muted")!.textContent!;
  };
  const clockOf = (d: Date) => d.toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = render(lateLastNight);
  expect(yesterday).toContain(clockOf(lateLastNight));
  expect(yesterday).toContain(lateLastNight.toLocaleDateString(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "short" }));
  const today = render(earlierToday);
  expect(today).toContain(clockOf(earlierToday));
  expect(today).not.toContain(earlierToday.toLocaleDateString(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "short" }));
});

test("a reading is dated by calendar day, not by age", () => {
  setLocale("en");
  const now = new Date(2026, 10, 3, 0, 20).getTime();
  const justBeforeMidnight = new Date(2026, 10, 2, 23, 50).toISOString();
  expect(formatReadClock(justBeforeMidnight, now)).toMatch(/\d.*23:50/);
  expect(formatReadClock(justBeforeMidnight, now)).not.toBe("23:50");
  expect(formatReadClock(new Date(2026, 10, 3, 0, 5).toISOString(), now)).toBe("00:05");
});
