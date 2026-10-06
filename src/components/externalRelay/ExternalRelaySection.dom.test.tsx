import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { TFunction } from "@/lib/i18n";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";

/*
 * The external relay's operator surface (docs/design/relay.md §B.9), every
 * state it draws: the connect form, the code and link while the owner acts in
 * the relay service, the identity to confirm, a pairing that ended there, a
 * paired relay with its targets, poller state, last outcome and last
 * progress, and the setup guide's step that pairs only once an account of the
 * chosen engine is signed in.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { ExternalRelaySection } = await import("./ExternalRelaySection");
const { RelayStep } = await import("@/components/onboarding/RelayStep");
const { resetEngineAccountsStoresForTests } = await import("@/hooks/useEngineAccounts");
const { setLocale } = await import("@/lib/i18n");

const OWNER = { namespace: "example", id: "owner-1", display_name: "Person A", handle: "@person_a" };
const target = (over: Record<string, unknown> = {}) => ({
  id: "bot-1", name: "Support bot", answered_by: "service", fallback: "service", enabled: true,
  engine: null, model: null, effort: null, project: null, concurrency: 1, hardCapMinutes: 30, ...over,
});
const relay = (over: Record<string, unknown> = {}) => ({
  id: "relay-1", origin: "https://relay.example", name: "Example relay", description: "Answers chat questions.",
  owner: OWNER, pairedAt: "2026-09-28T10:00:00.000Z", paused: false, targets: [target()], ...over,
});
const pending = (over: Record<string, unknown> = {}) => ({
  id: "pair-1", origin: "https://relay.example", name: "Example relay", description: "Answers chat questions.",
  code: "ABCD-EFGH", verify_url: "https://relay.example/pair?c=ABCD-EFGH", expires_at: new Date(Date.now() + 600_000).toISOString(),
  poll_interval_s: 3, ...over,
});
const signedIn = (id: string) => ({ id, label: id, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null });

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
});
async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(node));
  await act(async () => settle());
  return host;
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};
function accounts(body: { claude?: unknown[]; codex?: unknown[] }): void {
  resetEngineAccountsStoresForTests();
  answers.accounts = { claude: { active: "", accounts: body.claude ?? [] }, codex: { active: "", accounts: body.codex ?? [] } };
}
const answers: { accounts: unknown; relay: unknown; relayStatus: number; pairing: unknown } = {
  accounts: { claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } },
  relay: { relays: [], pending: [], status: [] },
  relayStatus: 200,
  pairing: { status: "pending" },
};
function route(extra?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined) {
  harness.setRoute((url, init) => {
    const answer = extra?.(url, init);
    if (answer) return answer;
    if (url.endsWith("/api/accounts")) return jsonResponse(answers.accounts);
    if (url.includes("/api/accounts/")) return jsonResponse({ cli: { present: false, reason: null }, active: "", accounts: [] });
    if (url === "/api/external-relay") return jsonResponse(answers.relay, answers.relayStatus);
    if (url.startsWith("/api/external-relay/pairings/") && (init?.method ?? "GET") === "GET") return jsonResponse({ pairing: answers.pairing });
    return undefined;
  });
}

test("a custom address, reached behind the disclosure, pairs and shows the code and the link while the owner acts in the service", async () => {
  accounts({ codex: [signedIn("work")] });
  answers.relay = { relays: [], pending: [], status: [] };
  answers.pairing = { status: "pending" };
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ pairing: pending() }, 201) : undefined);
  const host = await mount(<ExternalRelaySection pairEngine="codex" />);
  expect(host.querySelector("[data-external-relay-connect]")).toBeNull();
  await click(host.querySelector("[data-external-relay-other-toggle]"));
  const form = host.querySelector("[data-external-relay-connect]")!;
  expect(form.textContent).toContain("Connect a relay service");
  await act(async () => typeInto(form.querySelector("input")!, "https://relay.example"));
  await act(async () => (form.querySelector("button[type=submit]") as HTMLButtonElement).click());
  await act(async () => settle());
  expect(harness.calls.find((call) => call.url === "/api/external-relay/pairings")?.body).toEqual({ url: "https://relay.example" });

  const waiting = host.querySelector("[data-external-relay-pairing]")!;
  expect(waiting.getAttribute("data-external-relay-pairing")).toBe("pending");
  expect(waiting.querySelector("[data-external-relay-code]")?.textContent).toBe("ABCD-EFGH");
  expect(waiting.querySelector("a")?.getAttribute("href")).toBe("https://relay.example/pair?c=ABCD-EFGH");
  expect(waiting.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(waiting.textContent).toContain("Waiting for you to confirm in the relay service");

});

test("a pending pairing resumes on open: the identity to confirm, confirm sends its id, and unset targets take the chosen engine", async () => {
  accounts({ codex: [signedIn("work")] });
  answers.relay = { relays: [], pending: [pending()], status: [] };
  answers.pairing = { status: "awaiting_install", owner: OWNER, targets: [] };
  route((url, init) => {
    if (url === "/api/external-relay/pairings/pair-1" && init?.method === "POST") {
      answers.relay = { relays: [relay({ targets: [target({ engine: "codex", model: "gpt-6-astra" })] })], pending: [], status: [] };
      return jsonResponse({ relay: relay() });
    }
    if (url === "/api/external-relay/relays/relay-1" && init?.method === "PATCH") return jsonResponse({ relay: relay() });
    return undefined;
  });
  const paired: string[] = [];
  const host = await mount(<ExternalRelaySection pairEngine="codex" onPaired={(value) => paired.push(value.id)} />);
  const owner = host.querySelector("[data-external-relay-owner]");
  expect(owner?.textContent).toBe("The relay service says this is Person A (@person_a). Is this you?");
  await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Yes, pair"));
  expect(harness.calls.find((call) => call.url === "/api/external-relay/pairings/pair-1" && call.method === "POST")?.body).toEqual({ ownerId: "owner-1" });
  expect(harness.calls.find((call) => call.method === "PATCH")?.body).toEqual({ target: { id: "bot-1", engine: "codex", model: "gpt-6.1-sol" } });
  expect(paired).toEqual(["relay-1"]);
  expect(host.querySelector("[data-external-relay=relay-1]")).toBeTruthy();
  expect(host.querySelector("[data-external-relay-connect-area]")).toBeTruthy();
});

test("a pairing the service declined shows its reason as text and starts again", async () => {
  accounts({});
  answers.relay = { relays: [], pending: [pending({ verify_url: "javascript:alert(1)" })], status: [] };
  answers.pairing = { status: "denied", reason: "<b>not admitted</b>" };
  route();
  const host = await mount(<ExternalRelaySection />);
  const ended = host.querySelector("[data-external-relay-pairing]")!;
  expect(ended.getAttribute("data-external-relay-pairing")).toBe("denied");
  expect(ended.textContent).toContain("The relay service declined this pairing.");
  expect(ended.textContent).toContain("<b>not admitted</b>");
  expect(ended.querySelector("b")).toBeNull();
  await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Start again"));
  expect(host.querySelector("[data-external-relay-connect-area]")).toBeTruthy();
});

test("a relay-provided link that is not a web address is never rendered as one", async () => {
  accounts({});
  answers.relay = { relays: [], pending: [pending({ verify_url: "javascript:alert(1)" })], status: [] };
  answers.pairing = { status: "pending" };
  route();
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelector("[data-external-relay-code]")?.textContent).toBe("ABCD-EFGH");
  expect(host.querySelector("a")).toBeNull();
});

test("a paired relay: poller state, last outcome and progress, per-target settings, and no answering without a signed-in account", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = {
    relays: [relay({ targets: [
      target({ engine: "claude", model: "opus", effort: "low", concurrency: 2, answered_by: "install" }),
      target({ id: "bot-2", name: "Sales bot", engine: "codex", model: "gpt-6-astra" }),
      target({ id: "bot-3", name: "New bot" }),
    ] })],
    pending: [],
    status: [{ id: "relay-1", state: { state: "unreachable", lastOutcome: "declined:busy", lastOutcomeAt: "2026-09-28T10:05:00.000Z", lastProgress: { targetId: "bot-1", label: "Reading the thread", at: "2026-09-28T10:04:00.000Z" } }, running: { "bot-1": 1, "bot-2": 0, "bot-3": 0 } }],
  };
  route((url, init) => url === "/api/external-relay/relays/relay-1" && init?.method === "PATCH" ? jsonResponse({ relay: relay() }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  const card = host.querySelector("[data-external-relay=relay-1]")!;
  expect(card.textContent).toContain("Paired as Person A (@person_a)");
  expect(card.querySelector("[data-external-relay-state]")?.getAttribute("data-external-relay-state")).toBe("unreachable");
  expect(card.querySelector("[data-external-relay-state]")?.className).toContain("text-warning");
  expect(card.querySelector("[data-external-relay-last-outcome]")?.textContent).toContain("Declined: the target was at its concurrency");
  expect(card.querySelector("[data-external-relay-last-progress]")?.textContent).toContain("Support bot: Reading the thread");

  const first = card.querySelector("[data-external-relay-target=bot-1]")!;
  expect(first.textContent).toContain("1 of 2 running");
  const selects = Array.from(first.querySelectorAll("select")).map((select) => (select as HTMLSelectElement).value);
  expect(selects).toEqual(["claude", "opus", "low", "2"]);
  expect((first.querySelector("[data-external-relay-answered-by]") as HTMLInputElement).checked).toBe(true);

  /* Codex has no signed-in account: its target cannot be switched to this install. */
  const second = card.querySelector("[data-external-relay-target=bot-2]")!;
  expect((second.querySelector("[data-external-relay-answered-by]") as HTMLInputElement).disabled).toBe(true);
  expect(second.querySelector("[data-external-relay-no-account]")?.textContent).toBe("No Codex account is signed in here. Sign one in first.");

  /* A target with no engine yet says what it needs and cannot answer. */
  const third = card.querySelector("[data-external-relay-target=bot-3]")!;
  expect((third.querySelector("[data-external-relay-answered-by]") as HTMLInputElement).disabled).toBe(true);
  expect(third.textContent).toContain("Choose an engine and a model before this install can answer.");

  /* Changing the engine sends that engine's default model and clears the effort. */
  const engine = first.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    engine.value = "codex";
    engine.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
  });
  await act(async () => settle());
  expect(harness.calls.find((call) => call.method === "PATCH")?.body).toEqual({ target: { id: "bot-1", engine: "codex", model: "gpt-6.1-sol", effort: null } });
});

test("a relay whose credential was refused reads as an error, and a paused one offers Resume and its failed targets refresh", async () => {
  accounts({});
  answers.relay = {
    relays: [relay(), relay({ id: "relay-2", name: "Second relay", paused: true })],
    pending: [],
    status: [
      { id: "relay-1", state: { state: "credential_rejected", lastOutcome: null, lastOutcomeAt: null, lastProgress: null }, running: {} },
      { id: "relay-2", state: { state: "paused", lastOutcome: "targets:unreachable", lastOutcomeAt: null, lastProgress: null }, running: {} },
    ],
  };
  route((url, init) => url === "/api/external-relay/relays/relay-2" && init?.method === "PATCH" ? jsonResponse({ relay: relay() }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  const refused = host.querySelector("[data-external-relay=relay-1] [data-external-relay-state]")!;
  expect(refused.textContent).toBe("The service no longer accepts this pairing. Disconnect and pair again.");
  expect(refused.className).toContain("text-danger");
  expect(host.querySelector("[data-external-relay=relay-1] [data-external-relay-last-outcome]")?.textContent).toBe("None yet");
  const paused = host.querySelector("[data-external-relay=relay-2]")!;
  expect(paused.querySelector("[data-external-relay-state]")?.getAttribute("data-external-relay-state")).toBe("paused");
  // A targets refresh that failed keeps the list and says why.
  expect(paused.querySelector("[data-external-relay-last-outcome]")?.textContent).toBe("Could not refresh the targets. The relay service could not be reached.");
  await click(Array.from(paused.querySelectorAll("button")).find((button) => button.textContent === "Resume"));
  expect(harness.calls.find((call) => call.method === "PATCH")?.body).toEqual({ paused: false });
});

test("a staging Viewer says relays are off there", async () => {
  accounts({});
  answers.relayStatus = 409;
  answers.relay = { error: "staging" };
  route();
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelector("[role=alert]")?.textContent).toBe("This is a staging Delegatus, where relays stay off.");
  answers.relayStatus = 200;
});

const engineState = (engine: "claude" | "codex", list: ReturnType<typeof signedIn>[]) => ({
  engine, accounts: list, active: list[0]?.id ?? "", identityVersion: 0, status: "ready", notice: null, challenge: null, mutation: null, migration: null, autoBalance: null,
}) as unknown as Parameters<typeof RelayStep>[0]["claude"];

test("the setup guide's step pairs only when an account of the chosen engine is signed in", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  route();
  const gone: string[] = [];
  const reported: boolean[] = [];
  const props = { claude: engineState("claude", [signedIn("main")]), codex: engineState("codex", []), onGoEngines: () => gone.push("engines"), onPaired: () => {}, onHasRelay: (paired: boolean) => reported.push(paired), onSkip: () => gone.push("skip") };
  const host = await mount(<RelayStep {...props} />);
  expect(host.querySelector("[data-onboarding-relay-engine=claude]")?.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-onboarding-relay-account]")?.getAttribute("data-onboarding-relay-account")).toBe("signed-in");
  expect((host.querySelector("[data-external-relay-connect-known=celestia]") as HTMLButtonElement).disabled).toBe(false);
  await click(host.querySelector("[data-external-relay-other-toggle]"));
  expect((host.querySelector("[data-external-relay-connect] input") as HTMLInputElement).disabled).toBe(false);

  await click(host.querySelector("[data-onboarding-relay-engine=codex]"));
  expect(host.querySelector("[data-onboarding-relay-account]")?.getAttribute("data-onboarding-relay-account")).toBe("signed-out");
  expect(host.textContent).toContain("No Codex account is signed in here. Sign one in first.");
  expect((host.querySelector("[data-external-relay-connect] input") as HTMLInputElement).disabled).toBe(true);
  expect((host.querySelector("[data-external-relay-connect-known=celestia]") as HTMLButtonElement).disabled).toBe(true);
  await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Go to Engines"));
  await click(host.querySelector("[data-onboarding-relay-skip]"));
  expect(gone).toEqual(["engines", "skip"]);
  expect(reported.at(-1)).toBe(false);
});

test("the setup guide's step reports a relay paired earlier and offers no Skip while one is paired", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [relay()], pending: [], status: [] };
  route();
  const reported: boolean[] = [];
  const props = { claude: engineState("claude", [signedIn("main")]), codex: engineState("codex", []), onGoEngines: () => {}, onPaired: () => {}, onHasRelay: (paired: boolean) => reported.push(paired), onSkip: () => {} };
  const host = await mount(<RelayStep {...props} />);
  expect(host.querySelector("[data-external-relay=relay-1]")).not.toBeNull();
  expect(reported.at(-1)).toBe(true);
  expect(host.querySelector("[data-onboarding-relay-skip]")).toBeNull();
});

test("in Ukrainian the relay surface writes times and dates as uk-UA does, on a 24-hour clock", async () => {
  accounts({ claude: [signedIn("main")] });
  const outcomeAt = "2026-09-28T17:08:43.000Z";
  const progressAt = "2026-09-28T17:07:10.000Z";
  const pairedAt = "2026-09-27T17:27:16.000Z";
  answers.relay = {
    relays: [relay({ pairedAt, targets: [target({ engine: "claude", model: "opus", effort: "low" })] })],
    pending: [pending({ id: "pair-2", expires_at: new Date(Date.now() + 600_000).toISOString() })],
    status: [{ id: "relay-1", state: { state: "polling", lastOutcome: "answered", lastOutcomeAt: outcomeAt, lastProgress: { targetId: "bot-1", label: "Пишу відповідь", at: progressAt } }, running: {} }],
  };
  answers.pairing = { status: "pending" };
  route();
  setLocale("uk");
  try {
    const host = await mount(<ExternalRelaySection />);
    const card = host.querySelector("[data-external-relay=relay-1]")!;
    expect(card.querySelector("[data-external-relay-last-outcome]")?.textContent).toBe(`Відповіли · ${new Date(outcomeAt).toLocaleTimeString("uk-UA")}`);
    expect(card.querySelector("[data-external-relay-last-progress]")?.textContent).toContain(new Date(progressAt).toLocaleTimeString("uk-UA"));
    expect(card.textContent).toContain(new Date(pairedAt).toLocaleString("uk-UA"));
    const pairing = host.querySelector("[data-external-relay-pairing]")!;
    expect(pairing.textContent).not.toMatch(/AM|PM/);
    expect(card.textContent).not.toMatch(/AM|PM/);
    expect(card.textContent).toMatch(/\d{2}\.\d{2}\.2026/);
    const effort = card.querySelector<HTMLSelectElement>('select[aria-label^="Зусилля"]')!;
    expect(effort.value).toBe("low");
    expect(effort.selectedOptions[0]?.textContent).toBe("низькі");
    expect(Array.from(effort.options).map((option) => option.value)).toContain("xhigh");
    expect(Array.from(effort.options).map((option) => option.textContent)).toContain("дуже високі");
  } finally {
    setLocale("en");
  }
});

test("a refusal made by this install, or its own failure, never reads as the relay service's refusal", async () => {
  const { relayErrorText } = await import("./ExternalRelaySection");
  const { translate } = await import("@/lib/i18n");
  for (const locale of ["en", "uk"] as const) {
    const t: TFunction = (key, params) => translate(locale, key, params);
    for (const code of ["refused_here", "local_error"]) {
      const text = relayErrorText(t, code);
      expect(text).toContain("Delegatus");
      expect(text).not.toBe(t("externalRelay.error.other", { code }));
      expect(text).not.toMatch(/relay service|Сервіс/i);
    }
  }
});

const CELESTIA = "https://chatmoderator.botfather.dev";
const celestiaPending = (over: Record<string, unknown> = {}) => pending({
  origin: CELESTIA, name: "Celestia Connect", description: "", verify_url: "https://t.me/celestia_bot?start=pair-ABCD", ...over,
});
type FakeWindow = { opener: unknown; closed: boolean; location: { href: string }; document: { body: { textContent: string } }; close: () => void };
/** Stands in for `window.open` and records what the click did with the window it opened. */
function windowOpen(mode: "opens" | "blocked") {
  const opened: { url: string | undefined; target: string | undefined; win: FakeWindow }[] = [];
  const win: FakeWindow = { opener: "page", closed: false, location: { href: "about:blank" }, document: { body: { textContent: "" } }, close() { this.closed = true; } };
  (harness.dom as unknown as { open: unknown }).open = (url?: string, target?: string) => {
    if (mode === "blocked") return null;
    opened.push({ url, target, win });
    return win;
  };
  return { opened, win };
}
const knownButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-external-relay-connect-known=celestia]");

test("the Celestia button leads, shows its icon and description from the descriptor, and the address field stays behind a disclosure", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [relay()], pending: [], status: [] };
  route((url) => url === "/api/external-relay/known" ? jsonResponse({ known: [{ id: "celestia", name: "Celestia", origin: CELESTIA, description: "Answers on your own machine.", iconUrl: `${CELESTIA}/.well-known/celestia-connect.jpg` }] }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  const section = host.querySelector("[data-external-relay-section]")!;
  expect(section.firstElementChild?.getAttribute("data-external-relay-connect-area")).toBe("");
  const block = host.querySelector("[data-external-relay-known=celestia]")!;
  expect(knownButton(host)?.textContent).toBe("Connect Celestia");
  expect(block.textContent).toContain("Answers on your own machine.");
  expect(block.querySelector("img")?.getAttribute("src")).toBe(`${CELESTIA}/.well-known/celestia-connect.jpg`);
  expect(host.querySelector("[data-external-relay-connect]")).toBeNull();
  const toggle = host.querySelector("[data-external-relay-other-toggle]")!;
  expect(toggle.textContent).toBe("Other address…");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-external-relay-connect] input")).toBeTruthy();
  await click(toggle);
  expect(host.querySelector("[data-external-relay-connect]")).toBeNull();
});

test("with no descriptor the button still works under the listed name, and a connected Celestia replaces the button", async () => {
  accounts({});
  answers.relay = { relays: [], pending: [], status: [] };
  route();
  const host = await mount(<ExternalRelaySection />);
  expect(knownButton(host)?.textContent).toBe("Connect Celestia");
  expect(host.querySelector("[data-external-relay-monogram]")?.textContent).toBe("C");
  answers.relay = { relays: [relay({ origin: CELESTIA, name: "Celestia Connect" })], pending: [], status: [] };
  const connected = await mount(<ExternalRelaySection />);
  expect(knownButton(connected)).toBeNull();
  expect(connected.querySelector("[data-external-relay]")?.textContent).toContain("Celestia Connect");
  expect(connected.querySelector("[data-external-relay-other-toggle]")).toBeTruthy();
});

test("one click pairs with the built-in origin, opens the window inside the click and points it at the verify link", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  answers.pairing = { status: "pending" };
  const { opened, win } = windowOpen("opens");
  let release: (value: Response) => void = () => {};
  const held = new Promise<Response>((resolve) => { release = resolve; });
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? held : undefined);
  const host = await mount(<ExternalRelaySection />);
  // The click itself: the window is already open while the pairing request is still in flight.
  await act(async () => knownButton(host)!.click());
  expect(opened).toHaveLength(1);
  expect(opened[0]!.url).toBe("about:blank");
  expect(opened[0]!.target).toBe("_blank");
  expect(win.opener).toBeNull();
  expect(win.location.href).toBe("about:blank");
  expect(harness.calls.find((call) => call.url === "/api/external-relay/pairings")?.body).toEqual({ url: CELESTIA });

  await act(async () => { release(jsonResponse({ pairing: celestiaPending() }, 201)); await settle(); });
  expect(win.location.href).toBe("https://t.me/celestia_bot?start=pair-ABCD");
  expect(win.closed).toBe(false);
  expect(opened).toHaveLength(1);
  const card = host.querySelector("[data-external-relay-pairing]")!;
  expect(card.querySelector("[data-external-relay-code]")?.textContent).toBe("ABCD-EFGH");
  expect(card.textContent).toContain("Waiting for you to confirm in the relay service");
  expect(card.querySelector("a")?.getAttribute("data-external-relay-link")).toBe("again");
  expect(card.querySelector("a")?.textContent).toBe("Open the pairing page again");
});

test("when the browser blocks the window, the pairing card offers the link as the way in", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  answers.pairing = { status: "pending" };
  windowOpen("blocked");
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ pairing: celestiaPending() }, 201) : undefined);
  const host = await mount(<ExternalRelaySection />);
  await click(knownButton(host));
  const link = host.querySelector("[data-external-relay-pairing] a")!;
  expect(link.getAttribute("href")).toBe("https://t.me/celestia_bot?start=pair-ABCD");
  expect(link.getAttribute("data-external-relay-link")).toBe("open");
  expect(link.textContent).toBe("Open the relay service's pairing page");
  expect(host.querySelector("[data-external-relay-code]")?.textContent).toBe("ABCD-EFGH");
});

test("a pairing with no usable link closes the window it opened, and a failed start closes it too", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  answers.pairing = { status: "pending" };
  const first = windowOpen("opens");
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ pairing: celestiaPending({ verify_url: "javascript:alert(1)" }) }, 201) : undefined);
  const host = await mount(<ExternalRelaySection />);
  await click(knownButton(host));
  expect(first.win.closed).toBe(true);
  expect(first.win.location.href).toBe("about:blank");
  expect(host.querySelector("[data-external-relay-pairing] a")).toBeNull();
  expect(host.querySelector("[data-external-relay-code]")?.textContent).toBe("ABCD-EFGH");
});

test("the window follows only an https verify link on the relay's origin or its verify channel; any other link closes it and stays in the card", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.pairing = { status: "pending" };
  const cases: { verify: string; navigates: boolean }[] = [
    { verify: "https://t.me/celestia_bot?start=pair-ABCD", navigates: true },
    { verify: `${CELESTIA}/pair?c=ABCD-EFGH`, navigates: true },
    { verify: `${CELESTIA.replace(/^https:/, "http:")}/pair`, navigates: false },
    { verify: "https://elsewhere.example/pair", navigates: false },
    { verify: "http://elsewhere.example/pair", navigates: false },
  ];
  for (const { verify, navigates } of cases) {
    answers.relay = { relays: [], pending: [], status: [] };
    const { win } = windowOpen("opens");
    route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ pairing: celestiaPending({ verify_url: verify }) }, 201) : undefined);
    const host = await mount(<ExternalRelaySection />);
    await click(knownButton(host));
    expect(win.location.href).toBe(navigates ? verify : "about:blank");
    expect(win.closed).toBe(!navigates);
    const link = host.querySelector("[data-external-relay-pairing] a");
    expect(link?.getAttribute("data-external-relay-link")).toBe(navigates ? "again" : "open");
    if (!navigates) expect(link?.getAttribute("href")).toBe(verify);
  }
});

test("a service that is not available over https yet reads as that, in English and Ukrainian, and closes the window", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  const { win } = windowOpen("opens");
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ error: "http_public" }, 409) : undefined);
  const host = await mount(<ExternalRelaySection />);
  await click(knownButton(host));
  const block = host.querySelector("[data-external-relay-known=celestia]")!;
  expect(block.querySelector("[role=alert]")?.textContent).toBe("This service is not available over a secure connection yet. Try again later.");
  expect(win.closed).toBe(true);
  expect(block.querySelector("[role=alert]")?.textContent).not.toMatch(/http_public|refused \(/);
  expect(knownButton(host)?.disabled).toBe(false);
  const { relayErrorText } = await import("./ExternalRelaySection");
  const { translate } = await import("@/lib/i18n");
  expect(relayErrorText((key, params) => translate("uk", key, params), "http_public")).toBe("Сервіс поки що недоступний через захищене з’єднання. Спробуйте пізніше.");
});

test("a first Celestia connection takes the signed-in engine's default model and is answered by this install", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [celestiaPending()], status: [] };
  answers.pairing = { status: "awaiting_install", owner: OWNER, targets: [] };
  const celestia = relay({ origin: CELESTIA, name: "Celestia Connect", targets: [target(), target({ id: "bot-2", name: "Other chat", answered_by: "install" })] });
  route((url, init) => {
    if (url === "/api/external-relay/pairings/pair-1" && init?.method === "POST") return jsonResponse({ relay: celestia });
    if (init?.method === "PATCH") return jsonResponse({ relay: celestia, target: {} });
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelector("[data-external-relay-owner]")?.textContent).toBe("The relay service says this is Person A (@person_a). Is this you?");
  await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Yes, pair"));
  const patches = harness.calls.filter((call) => call.method === "PATCH");
  const { defaultModelFor } = await import("@/lib/agent/models");
  expect(patches.map((call) => [call.url, call.body])).toEqual([
    ["/api/external-relay/relays/relay-1", { target: { id: "bot-1", engine: "claude", model: defaultModelFor("claude") } }],
    ["/api/external-relay/relays/relay-1/targets/bot-1", { answered_by: "install" }],
    ["/api/external-relay/relays/relay-1", { target: { id: "bot-2", engine: "claude", model: defaultModelFor("claude") } }],
  ]);
});

test("a first Celestia connection with no signed-in account leaves the targets for the operator", async () => {
  accounts({});
  answers.relay = { relays: [], pending: [celestiaPending()], status: [] };
  answers.pairing = { status: "awaiting_install", owner: OWNER, targets: [] };
  const celestia = relay({ origin: CELESTIA, name: "Celestia Connect" });
  route((url, init) => url === "/api/external-relay/pairings/pair-1" && init?.method === "POST" ? jsonResponse({ relay: celestia }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Yes, pair"));
  expect(harness.calls.filter((call) => call.method === "PATCH")).toEqual([]);
});

test("in Ukrainian the button, its lead and the disclosure are written in Ukrainian", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [], pending: [], status: [] };
  route();
  setLocale("uk");
  try {
    const host = await mount(<ExternalRelaySection />);
    expect(knownButton(host)?.textContent).toBe("Під’єднати Celestia");
    expect(host.querySelector("[data-external-relay-known]")?.textContent).toContain("Celestia відкриється в новій вкладці.");
    expect(host.querySelector("[data-external-relay-other-toggle]")?.textContent).toBe("Інша адреса…");
  } finally {
    setLocale("en");
  }
});

const ANSWERS_URL = "/api/external-relay/relays/relay-1/targets/bot-1/answers";
const exchanges = {
  answers: [
    { requestId: "rq_2", startedAt: "2026-10-06T09:05:00.000Z", finishedAt: "2026-10-06T09:05:04.000Z", durationMs: 4200, state: "finished", outcome: "declined:handoff", delivery: "accepted", request: "@helper mute him for an hour", answer: null },
    { requestId: "rq_1", startedAt: "2026-10-06T09:00:00.000Z", finishedAt: "2026-10-06T09:00:06.000Z", durationMs: 6100, state: "finished", outcome: "answered", delivery: "accepted", request: "When is the <b>meetup</b>?", answer: "Thursday at 18:30." },
  ],
  retentionDays: 30,
};
const handoffRecord = {
  requestId: "rq_2", startedAt: "2026-10-06T09:05:00.000Z", finishedAt: "2026-10-06T09:05:04.000Z", durationMs: 4200, state: "finished",
  outcome: "declined:handoff", delivery: "accepted", engine: "claude", model: "opus", answer: { action: "handoff", text: "", reply_to: null },
  input: {
    conversation: [{ id: "m9", author: { key: "u_a", name: "Admin A", self: false }, text: "@helper mute him for an hour", reply_to: null }],
    respond_to: "m9", request_text: null,
    requester: { author_key: "u_a", role: "admin", is_owner: false, anonymous: false },
    tools: [{ name: "mute_participant", summary: "Mute a participant", mode: "handoff" }],
  },
};
function answersRoute(list: unknown = exchanges) {
  route((url) => {
    if (url === ANSWERS_URL) return jsonResponse(list);
    if (url === `${ANSWERS_URL}/rq_2`) return jsonResponse({ answer: handoffRecord });
    if (url === `${ANSWERS_URL}/rq_gone`) return jsonResponse({ error: "not_found" }, 404);
    return undefined;
  });
}

test("recent answers open from the target row, list the kept exchanges and show one read-only", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [relay({ targets: [target({ engine: "claude", model: "opus", answered_by: "install" })] })], pending: [], status: [] };
  answersRoute();
  const host = await mount(<ExternalRelaySection />);
  const row = host.querySelector("[data-external-relay-target=bot-1]")!;
  const toggle = row.querySelector("[data-external-relay-answers-toggle]")!;
  expect(toggle.textContent).toBe("Recent answers");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(harness.calls.some((call) => call.url === ANSWERS_URL)).toBe(false);
  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const list = row.querySelector("[data-external-relay-answer-list]")!;
  const items = Array.from(list.querySelectorAll("[data-external-relay-answer]"));
  expect(items.map((item) => item.getAttribute("data-external-relay-answer"))).toEqual(["rq_2", "rq_1"]);
  expect(items[0]!.textContent).toContain("Handed off to the service");
  expect(items[1]!.textContent).toContain("Answered");
  expect(items[1]!.textContent).toContain("When is the <b>meetup</b>?");
  expect(items[1]!.querySelector("b")).toBeNull();
  expect(row.textContent).toContain("Each exchange is kept for 30 days and can only be read.");

  await click(items[0]);
  const exchange = row.querySelector("[data-external-relay-exchange=rq_2]")!;
  expect(exchange.querySelector("[data-external-relay-exchange-outcome]")?.textContent).toBe("Handed off to the service");
  expect(exchange.querySelector("[data-external-relay-exchange-request]")?.textContent).toBe("@helper mute him for an hour");
  expect(exchange.querySelector("[data-external-relay-exchange-answer]")?.textContent).toBe("Handed back to the service, whose own assistant answers it.");
  expect(exchange.textContent).toContain("Admin A · Admin");
  expect(exchange.textContent).toContain("Claude · Opus 5.5");
  expect(exchange.textContent).toContain("Received the result");
  expect(exchange.querySelector("[data-external-relay-exchange-input]")?.textContent).toContain("\"mute_participant\"");
  // Read-only: no composer, no field to type into.
  expect(exchange.querySelector("textarea, input")).toBeNull();
  await click(Array.from(exchange.querySelectorAll("button")).find((button) => button.textContent === "Back to recent answers"));
  expect(row.querySelector("[data-external-relay-answer-list]")).toBeTruthy();
});

test("recent answers in Ukrainian, empty and expired", async () => {
  setLocale("uk");
  try {
    accounts({ claude: [signedIn("main")] });
    answers.relay = { relays: [relay({ targets: [target({ engine: "claude", model: "opus", answered_by: "install" })] })], pending: [], status: [] };
    answersRoute({ answers: [], retentionDays: 30 });
    const host = await mount(<ExternalRelaySection />);
    const row = host.querySelector("[data-external-relay-target=bot-1]")!;
    const toggle = row.querySelector("[data-external-relay-answers-toggle]")!;
    expect(toggle.textContent).toBe("Останні відповіді");
    await click(toggle);
    expect(row.querySelector("[data-external-relay-answers-empty]")?.textContent).toBe("За останні 30 днів відповідей немає.");
    await click(toggle);
    answersRoute({ ...exchanges, answers: [{ ...exchanges.answers[0], requestId: "rq_gone" }] });
    await click(toggle);
    await click(row.querySelector("[data-external-relay-answer=rq_gone]"));
    expect(row.querySelector("[data-external-relay-exchange]")?.textContent).toContain("Цей обмін більше не зберігається.");
  } finally {
    setLocale("en");
  }
});

test("the member limit shows the default, saves a number on leaving the field, and saves an empty field as no limit", async () => {
  accounts({ claude: [signedIn("main")] });
  answers.relay = { relays: [relay({ targets: [target({ engine: "claude", model: "opus", answered_by: "install" })] })], pending: [], status: [] };
  route((url, init) => url === "/api/external-relay/relays/relay-1" && init?.method === "PATCH" ? jsonResponse({ relay: relay() }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  const row = host.querySelector("[data-external-relay-target=bot-1]")!;
  const field = row.querySelector("[data-external-relay-member-limit]") as HTMLInputElement;
  expect(field.value).toBe("10");
  expect(row.textContent).toContain("Answers per member per hour");
  expect(row.textContent).toContain("The owner and chat admins are not counted.");
  const patches = () => harness.calls.filter((call) => call.method === "PATCH").map((call) => call.body);
  await act(async () => { field.focus(); });
  await act(async () => typeInto(field, "3"));
  await act(async () => { field.blur(); });
  await act(async () => settle());
  expect(patches()).toEqual([{ target: { id: "bot-1", memberLimitPerHour: 3 } }]);
  await act(async () => { field.focus(); });
  await act(async () => typeInto(field, ""));
  await act(async () => { field.blur(); });
  await act(async () => settle());
  expect(patches().at(-1)).toEqual({ target: { id: "bot-1", memberLimitPerHour: null } });
});
