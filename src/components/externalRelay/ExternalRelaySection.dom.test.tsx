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
function route(extra?: (url: string, init: RequestInit | undefined) => Response | undefined) {
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

test("pairing starts from the address and shows the code and the link while the owner acts in the service", async () => {
  accounts({ codex: [signedIn("work")] });
  answers.relay = { relays: [], pending: [], status: [] };
  answers.pairing = { status: "pending" };
  route((url, init) => url === "/api/external-relay/pairings" && init?.method === "POST" ? jsonResponse({ pairing: pending() }, 201) : undefined);
  const host = await mount(<ExternalRelaySection pairEngine="codex" />);
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
  expect(harness.calls.find((call) => call.method === "PATCH")?.body).toEqual({ target: { id: "bot-1", engine: "codex", model: "gpt-6-astra" } });
  expect(paired).toEqual(["relay-1"]);
  expect(host.querySelector("[data-external-relay=relay-1]")).toBeTruthy();
  expect(host.querySelector("[data-external-relay-connect]")).toBeTruthy();
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
  expect(host.querySelector("[data-external-relay-connect]")).toBeTruthy();
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
  expect(harness.calls.find((call) => call.method === "PATCH")?.body).toEqual({ target: { id: "bot-1", engine: "codex", model: "gpt-6-astra", effort: null } });
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
  expect((host.querySelector("[data-external-relay-connect] input") as HTMLInputElement).disabled).toBe(false);

  await click(host.querySelector("[data-onboarding-relay-engine=codex]"));
  expect(host.querySelector("[data-onboarding-relay-account]")?.getAttribute("data-onboarding-relay-account")).toBe("signed-out");
  expect(host.textContent).toContain("No Codex account is signed in here. Sign one in first.");
  expect((host.querySelector("[data-external-relay-connect] input") as HTMLInputElement).disabled).toBe(true);
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
