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
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver });

/** Resolves on React's next commit into `host`: the barrier the tests wait on instead of a timer. */
function nextCommit(host: Element): Promise<void> {
  return new Promise(resolve => {
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

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
  row({ sourceId: "broken", targetId: "broken", label: "Broken", state: "not_created", detail: "create-failed", retry: true }),
  row({ sourceId: "unread", targetId: "unread", label: "Unread", state: "read_failed", detail: "identity-unreadable" }),
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
    ["en", ["Signed out", "Different account", "Limits not read", "Ready", "Not created", "Not checked yet", "Active on the other install", "quota-probe-timeout",
      "A custom provider account needs its token", "Could not read which login this is", "The account could not be set up here"]],
    ["uk", ["Не ввійдено", "Інший акаунт", "Ліміти не прочитано", "Готовий", "Не створено", "Ще не перевірено", "Активний на іншій інсталяції",
      "Акаунту власного провайдера потрібен його токен", "Не вдалося прочитати, який це вхід", "Не вдалося налаштувати акаунт тут"]],
  ] as const) {
    setLocale(locale);
    const host = render(<TransferAccountsChecklist engine="codex" rows={ROWS} onSignIn={async () => {}} onAction={async () => {}} />);
    const text = host.textContent ?? "";
    for (const words of expected) expect(text).toContain(words);
    expect(text).not.toMatch(/signed_out|different_account|read_failed|not_created|unchecked|provider-account|identity-unreadable|create-failed/);
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
  /* Each press waits on a promise the test settles, and the test waits on the
     commit that follows it, never on a timer. */
  let pending = deferred();
  const host = render(<TransferAccountsChecklist engine="codex" rows={ROWS} onSignIn={async id => { signIns.push(id); await pending.promise; }} onAction={async body => { actions.push(body); await pending.promise; }} />);
  const item = (id: string) => host.querySelector(`[data-transfer-account="${id}"]`)!;
  expect(buttons(item("team"))).toEqual(["Sign in", "Not needed here"]);
  expect(buttons(item("work"))).toEqual(["Sign in again", "This is the right account", "Not needed here"]);
  expect(buttons(item("main"))).toEqual(["Sign in again", "Not needed here"]);
  expect(buttons(item("spare"))).toEqual([]);
  // A row whose account could not be made can still be settled, and retried when its setup can be.
  expect(buttons(item("old"))).toEqual(["Not needed here"]);
  expect(buttons(item("broken"))).toEqual(["Try again", "Not needed here"]);
  expect(buttons(item("unread"))).toEqual(["Sign in again", "This is the right account", "Not needed here"]);
  expect(buttons(item("here"))).toEqual(["Not needed here"]);
  // One action at a time: each settles before the next press.
  const press = async (button: Element | null | undefined) => {
    click(button);
    expect([...host.querySelectorAll("button")].every(candidate => (candidate as HTMLButtonElement).disabled)).toBe(true);
    const committed = nextCommit(host);
    pending.resolve();
    await committed;
    pending = deferred();
    expect([...host.querySelectorAll("button")].some(candidate => (candidate as HTMLButtonElement).disabled)).toBe(false);
  };
  await press(item("team").querySelector("button"));
  await press([...item("work").querySelectorAll("button")][1]);
  await press(item("broken").querySelector("button"));
  await press(item("old").querySelector("button"));
  await press([...host.querySelectorAll("button")].find(button => button.textContent === "Check all"));
  expect(signIns).toEqual(["team-2"]);
  expect(actions).toEqual([
    { action: "confirm_identity", engine: "codex", sourceId: "work" },
    { action: "retry", engine: "codex", sourceId: "broken" },
    { action: "not_needed", engine: "codex", sourceId: "old" },
    { action: "verify", engine: "codex" },
  ]);
});

test("the Copilot list's checklist names the missing limit read", () => {
  setLocale("en");
  const host = render(<TransferAccountsChecklist engine="copilot" rows={[row({ engine: "copilot", sourceId: "gh", label: "GitHub" })]} onSignIn={async () => {}} onAction={async () => {}} />);
  expect(host.textContent).toContain("Copilot has no limit read, so an account is ready once it shows as signed in.");
  expect(host.querySelector("[data-transfer-checklist]")?.getAttribute("data-transfer-checklist")).toBe("copilot");
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
  /* The barrier is the hook's own answer: the render that says the read came back. */
  let loaded = deferred();
  function Probe({ fetcher }: { fetcher: (input: string) => Promise<Response> }) {
    const { rows, loaded: answered } = useImportedAccounts("codex", "v1", fetcher);
    seen.push(rows);
    if (answered) loaded.resolve();
    return null;
  }
  render(<Probe fetcher={ok} />);
  await loaded.promise;
  expect(asked).toEqual(["/api/transfer/accounts?engine=codex"]);
  expect(seen.at(-1)).toEqual([ROWS[0]!]);
  flushSync(() => mounted!.root.unmount());
  mounted = null;
  seen.length = 0;
  loaded = deferred();
  render(<Probe fetcher={down} />);
  await loaded.promise;
  expect(seen.at(-1)).toEqual([]);
});
