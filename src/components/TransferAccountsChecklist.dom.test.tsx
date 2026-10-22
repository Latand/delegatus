import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { resetLocaleForTests, setLocale } from "@/lib/i18n";
import type { AccountReportRow } from "@/lib/transfer/types";

import { TransferAccountsChecklist, useImportedAccounts } from "./TransferAccountsChecklist";

/* The install transfer's sign-in checklist in the accounts panel
   (install-memory-transfer §3.4): every state reads as words in both
   languages, each row offers the actions its state allows, and the rows come
   from the transfer route for the panel's engine. */

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent });

const row = (over: Partial<AccountReportRow>): AccountReportRow => ({
  engine: "codex", sourceId: "team", targetId: "team-2", label: "Team", state: "signed_out", bindings: [], activeOnSource: false, ...over,
});

const ROWS: AccountReportRow[] = [
  row({ sourceId: "team", label: "Team", activeOnSource: true, bindings: ["repo-a", "repo-b"] }),
  row({ sourceId: "work", targetId: "work", label: "Work", state: "different_account" }),
  row({ sourceId: "main", targetId: "default", label: "Main", state: "read_failed", detail: "quota-probe-timeout" }),
  row({ sourceId: "spare", label: "Spare", state: "usable" }),
  row({ sourceId: "old", targetId: null, label: "Old", state: "not_created", detail: "provider-account" }),
  row({ sourceId: "here", targetId: "here", label: "Here", state: "unchecked" }),
];

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(() => {
  if (mounted) flushSync(() => mounted!.root.unmount());
  mounted?.host.remove();
  mounted = null;
  resetLocaleForTests();
});

function render(element: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(element));
  mounted = { root, host };
  return host;
}

const click = (element: Element | null | undefined) => { flushSync(() => (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
const buttons = (host: Element) => [...host.querySelectorAll("button")].map(button => button.textContent?.trim());

test("every state and the source facts read as words, in English and Ukrainian", () => {
  for (const [locale, expected] of [
    ["en", ["Signed out", "Different account", "Limits not read", "Ready", "Not created", "Not checked yet", "Active on the other install", "quota-probe-timeout"]],
    ["uk", ["Не ввійдено", "Інший акаунт", "Ліміти не прочитано", "Готовий", "Не створено", "Ще не перевірено", "Активний на іншій інсталяції"]],
  ] as const) {
    setLocale(locale);
    const host = render(<TransferAccountsChecklist engine="codex" rows={ROWS} onSignIn={async () => {}} onAction={async () => {}} />);
    const text = host.textContent ?? "";
    for (const words of expected) expect(text).toContain(words);
    expect(text).not.toMatch(/signed_out|different_account|read_failed|not_created|unchecked/);
    // The accounts dialog carries no «Bound to» (#1418); the bindings still apply.
    expect(text).not.toMatch(/Bound to|Прив'язаний/);
    flushSync(() => mounted!.root.unmount());
    mounted!.host.remove();
    mounted = null;
  }
});

test("each row offers what its state allows and the actions name the account", async () => {
  setLocale("en");
  const signIns: string[] = [];
  const actions: unknown[] = [];
  const host = render(<TransferAccountsChecklist engine="codex" rows={ROWS} onSignIn={async id => { signIns.push(id); }} onAction={async body => { actions.push(body); }} />);
  const item = (id: string) => host.querySelector(`[data-transfer-account="${id}"]`)!;
  expect(buttons(item("team"))).toEqual(["Sign in", "Not needed here"]);
  expect(buttons(item("work"))).toEqual(["Sign in again", "This is the right account", "Not needed here"]);
  expect(buttons(item("main"))).toEqual(["Sign in again", "Not needed here"]);
  expect(buttons(item("spare"))).toEqual(["Not needed here"]);
  expect(buttons(item("old"))).toEqual([]);
  expect(buttons(item("here"))).toEqual(["Not needed here"]);
  // One action at a time: each settles before the next press.
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  click(item("team").querySelector("button"));
  expect((item("work").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  await settle();
  click([...item("work").querySelectorAll("button")][1]);
  await settle();
  click([...host.querySelectorAll("button")].find(button => button.textContent === "Check all"));
  await settle();
  expect(signIns).toEqual(["team-2"]);
  expect(actions).toEqual([{ action: "confirm_identity", engine: "codex", sourceId: "work" }, { action: "verify", engine: "codex" }]);
});

test("hides itself once every account is ready or not needed", () => {
  setLocale("en");
  const host = render(<TransferAccountsChecklist engine="claude" rows={[row({ state: "usable" }), row({ sourceId: "b", state: "not_needed" })]} onSignIn={async () => {}} onAction={async () => {}} />);
  expect(host.querySelector("[data-transfer-checklist]")).toBeNull();
});

test("reads the rows for the panel's engine and keeps none when the route is unavailable", async () => {
  const asked: string[] = [];
  const ok = async (input: string) => {
    asked.push(input);
    return new Response(JSON.stringify({ ok: true, result: [ROWS[0]] }), { status: 200 });
  };
  const down = async (): Promise<Response> => { throw new TypeError("offline"); };
  const seen: AccountReportRow[][] = [];
  function Probe({ fetcher }: { fetcher: (input: string) => Promise<Response> }) {
    const { rows } = useImportedAccounts("codex", "v1", fetcher);
    seen.push(rows);
    return null;
  }
  render(<Probe fetcher={ok} />);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(asked).toEqual(["/api/transfer/accounts?engine=codex"]);
  expect(seen.at(-1)).toEqual([ROWS[0]!]);
  flushSync(() => mounted!.root.unmount());
  mounted = null;
  seen.length = 0;
  render(<Probe fetcher={down} />);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(seen.at(-1)).toEqual([]);
});
