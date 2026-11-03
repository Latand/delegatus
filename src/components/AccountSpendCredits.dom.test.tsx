import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createEngineAccountsStore } from "@/hooks/useEngineAccounts";
import { setLocale, translate } from "@/lib/i18n";
import { AccountSpendCredits } from "./AccountSpendCredits";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent });
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
  const switches = [...host.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
  expect(switches).toHaveLength(2);
  expect(switches[0]!.checked).toBe(false);
  expect(host.textContent).toContain("12.50");
  expect(host.textContent).toContain("2026-11-03T12:00:00Z");
  flushSync(() => switches[0]!.click());
  expect(switches[0]!.checked).toBe(true);
  expect(switches[1]!.checked).toBe(false);
  expect(writes[0]!.body).toEqual({ accountId: "account-a", spendCredits: true });
  const rolledBack = new Promise<void>(resolve => {
    const unsubscribe = store.subscribe(() => { if (store.accounts[0]?.spendCreditsError) { unsubscribe(); resolve(); } });
  });
  writes[0]!.resolve(Response.json({ error: "refused" }, { status: 503 }));
  await rolledBack;
  flushSync(() => {});
  expect(switches[0]!.checked).toBe(false);
  expect(host.querySelector('[data-account-spend-credits="account-a"] [role="alert"]')?.textContent)
    .toBe(translate(locale, "accounts.spendCreditsFailed"));
  expect(host.querySelector('[data-account-spend-credits="account-b"] [role="alert"]')).toBeNull();
  let saved!: Promise<boolean>;
  flushSync(() => { saved = store.setSpendCredits!("account-a", true); });
  writes[1]!.resolve(Response.json(writes[1]!.body));
  expect(await saved).toBe(true);
  flushSync(() => {});
  expect(switches[0]!.checked).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
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
