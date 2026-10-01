import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { translate, type MessageKey } from "@/lib/i18n";
import { installActEnv } from "@/test-helpers/actEnv";

import { LinkedSettingsDialog } from "./LinkedSettingsDialog";
import { MINT_REFUSALS, mintRefusalMessage } from "./mintRefusal";

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
});
installActEnv();

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

type View = ReturnType<typeof view>;
const view = (check: string, vouches = false, publicUrl: string | null = "https://board.example.test:8443") => ({
  self: { label: "stage", publicUrl, check: publicUrl ? { code: check, at: "2026-09-29T08:00:00.000Z" } : null },
  state: publicUrl ? check : null, entry: { port: 8898, publishable: true, localVouches: vouches }, keyOn: true, tailnetUrl: null,
});
const peer = (over: object = {}) => ({ id: "peer-1", label: "home-pc", url: "https://home.example.test", state: "active", error: null, lastCall: null, ...over });
const grant = (over: object = {}) => ({ id: "grant-1", label: "home-pc", created: 100, requests: 0, today: 3, sevenDays: 41, lastUsed: null, ...over });

type Fixture = {
  mint: { status: number; body: object };
  links: View;
  codes: object[];
  peers: object[];
  grants: object[];
  connect: { status: number; body: object };
  known: { key: string; name: string }[];
};
type Sent = { method: string; url: string; body: unknown };

function serve(mint: { status: number; body: object }, over: Partial<Fixture> = {}) {
  const fixture: Fixture = { mint, links: view("unverified"), codes: [], peers: [], grants: [], connect: { status: 200, body: { peer: peer() } }, known: [], ...over };
  const requests: Sent[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    requests.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/links/codes" && method === "POST") return Response.json(fixture.mint.body, { status: fixture.mint.status });
    if (url === "/api/links/peers" && method === "POST") return Response.json(fixture.connect.body, { status: fixture.connect.status });
    if (url === "/api/links" && method === "POST") return Response.json(fixture.links);
    if (url === "/api/links") return Response.json(fixture.links);
    if (url === "/api/links/codes") return Response.json({ codes: fixture.codes });
    if (url === "/api/links/shared") return Response.json({ shared: { v: 1, all: false, projects: [] }, known: fixture.known, states: [] });
    if (url === "/api/links/peers") return Response.json({ peers: fixture.peers });
    if (url === "/api/links/grants") return Response.json({ grants: fixture.grants });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return Object.assign(calls, { fixture, requests });
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => { root!.render(<LinkedSettingsDialog onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element) => { await act(async () => { node.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); }); await settle(); };
const byText = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text) as HTMLElement | undefined;
const byLabel = (key: MessageKey) => document.querySelector(`[aria-label="${translate("en", key)}"]`) as HTMLElement | null;
/* A keydown between the value write and the input event is what makes happy-dom's keystroke reach React's onChange. */
const type = async (input: Element, text: string) => {
  await act(async () => {
    (input as HTMLElement).focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "a", bubbles: true }) as unknown as Event);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const en = (key: MessageKey, params?: Record<string, string | number>) => translate("en", key, params);
const panel = (role: "accept" | "connect") => document.querySelector(`[data-linked-panel="${role}"]`) as HTMLElement;
const roleRadio = (role: "accept" | "connect") => document.querySelector(`[data-linked-role="${role}"]`) as HTMLElement;

async function allow() {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === translate("en", "links.allow"));
  expect(button).toBeDefined();
  await act(async () => { button!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("a refused mint says why next to the button", async () => {
  const calls = serve({ status: 409, body: { error: "unverified" } });
  await mount();
  await allow();
  const refusal = document.querySelector("[data-linked-mint-refusal]");
  expect(refusal?.getAttribute("role")).toBe("alert");
  expect(refusal?.getAttribute("data-linked-mint-refusal")).toBe("unverified");
  expect(refusal?.textContent).toBe(translate("en", "links.mint.unverified"));
  expect(document.querySelector("[data-pair-code]")).toBeNull();
  // The mint ran a fresh check, so the saved state is read again.
  expect(calls.filter((call) => call === "GET /api/links").length).toBe(2);
});

test("a refusal from the route, not mintCode, is named too", async () => {
  serve({ status: 403, body: { error: "owner-required" } });
  await mount();
  await allow();
  expect(document.querySelector("[data-linked-mint-refusal]")?.textContent).toBe(translate("en", "links.mint.owner-required"));
});

test("a minted code replaces an earlier refusal", async () => {
  serve({ status: 409, body: { error: "tls-failure" } });
  await mount();
  await allow();
  expect(document.querySelector("[data-linked-mint-refusal]")?.textContent).toBe(translate("en", "links.mint.tls-failure"));
  serve({ status: 200, body: { code: "ABCDEF-GHJKM-NPQRS", expiresAt: Date.now() + 600_000 } });
  await allow();
  expect(document.querySelector("[data-linked-mint-refusal]")).toBeNull();
  expect(document.querySelector("[data-pair-code] code")?.textContent).toBe("ABCDEF-GHJKM-NPQRS");
});

test("every refusal has its own sentence in both languages, and an unknown one is still named", () => {
  for (const refusal of MINT_REFUSALS) {
    for (const locale of ["en", "uk"] as const) {
      const key = `links.mint.${refusal}` as MessageKey;
      expect(translate(locale, key)).not.toBe(key);
    }
  }
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate("uk", key, params);
  expect(mintRefusalMessage(t, "something-new")).toContain("something-new");
});

test("the code field's placeholder does not look like a code", async () => {
  serve({ status: 409, body: { error: "unverified" } });
  await mount();
  const input = document.querySelector(`input[aria-label="${translate("en", "links.peerCode")}"]`);
  const placeholder = input?.getAttribute("placeholder") ?? "";
  expect(placeholder).toBe(translate("en", "links.peerCodePlaceholder"));
  expect(placeholder).not.toMatch(/[0-9A-Z]{5,}-/);
});

test("the role defaults from the saved address, and switching keeps a half-typed form", async () => {
  serve({ status: 200, body: {} });
  await mount();
  expect(roleRadio("accept").getAttribute("aria-checked")).toBe("true");
  expect(roleRadio("connect").getAttribute("aria-checked")).toBe("false");
  expect(panel("accept").hasAttribute("hidden")).toBe(false);
  expect(panel("connect").hasAttribute("hidden")).toBe(true);
  act(() => root?.unmount()); root = null; document.body.innerHTML = "";

  serve({ status: 200, body: {} }, { links: view("ok", false, null) });
  await mount();
  expect(roleRadio("connect").getAttribute("aria-checked")).toBe("true");
  expect(panel("accept").hasAttribute("hidden")).toBe(true);
  await type(byLabel("links.peerAddress")!, "https://peer.example.test");
  await click(roleRadio("accept"));
  expect(roleRadio("accept").getAttribute("aria-checked")).toBe("true");
  expect(panel("connect").hasAttribute("hidden")).toBe(true);
  await click(roleRadio("connect"));
  await click(roleRadio("accept"));
  await click(roleRadio("connect"));
  expect((byLabel("links.peerAddress") as HTMLInputElement).value).toBe("https://peer.example.test");
  act(() => root?.unmount()); root = null; document.body.innerHTML = "";

  serve({ status: 200, body: {} }, { links: view("ok", false, null), grants: [grant()] });
  await mount();
  expect(roleRadio("accept").getAttribute("aria-checked")).toBe("true");
});

test("an address the server cannot open itself reads as a warning that does not block a code", async () => {
  serve({ status: 200, body: {} });
  await mount();
  const line = document.querySelector('[data-linked-state="unverified"]')!;
  expect(line.getAttribute("data-linked-severity")).toBe("warning");
  expect(line.getAttribute("role")).toBe("status");
  expect(line.textContent).toContain("https://board.example.test:8443");
  expect(line.textContent).toContain(en("links.state.unverified"));
  expect(line.textContent).toContain(en("links.checkFromOther", { address: "https://board.example.test:8443" }));
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[data-linked-severity="blocking"]')).toBeNull();
  expect((byText(en("links.allow")) as HTMLButtonElement).disabled).toBe(false);
});

test("an unverified address blocks when the local entry vouches for local requests", async () => {
  serve({ status: 200, body: {} }, { links: view("unverified", true) });
  await mount();
  const line = document.querySelector('[data-linked-state="unverified"]')!;
  expect(line.getAttribute("data-linked-severity")).toBe("blocking");
  expect(line.textContent).toContain(en("links.state.unverifiedBlocking", { port: 8898 }));
  expect(line.textContent).toContain(en("links.severity.blocking"));
});

test("genuine blockers stay blocking and a passing check reads ok", async () => {
  for (const code of ["needs-remote-entry", "http-public", "open-to-internet", "host-rewritten", "tls-failure"]) {
    serve({ status: 200, body: {} }, { links: view(code) });
    await mount();
    const line = document.querySelector(`[data-linked-state="${code}"]`);
    expect(line?.getAttribute("data-linked-severity")).toBe("blocking");
    expect(line?.textContent).toContain(en(`links.state.${code}` as MessageKey));
    expect(document.querySelector("[data-linked-banner]") !== null).toBe(code === "open-to-internet");
    act(() => root?.unmount()); root = null; document.body.innerHTML = "";
  }
  serve({ status: 200, body: {} }, { links: { ...view("ok"), state: "needs-access-key", keyOn: false } });
  await mount();
  expect(document.querySelector('[data-linked-state="needs-access-key"]')?.getAttribute("data-linked-severity")).toBe("blocking");
  act(() => root?.unmount()); root = null; document.body.innerHTML = "";
  serve({ status: 200, body: {} }, { links: view("ok") });
  await mount();
  expect(document.querySelector('[data-linked-state="ok"]')?.getAttribute("data-linked-severity")).toBe("ok");
});

test("a saved address that fails to save is a blocker on the address line", async () => {
  serve({ status: 200, body: {} });
  await mount();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/links" && init?.method === "POST") return Response.json({ error: "invalid-address" }, { status: 409 });
    return Response.json({ shared: { v: 1, all: false, projects: [] }, known: [], states: [], peers: [], grants: [] });
  }) as typeof fetch;
  await click(byText(en("links.save"))!);
  expect(document.querySelector('[data-linked-state="invalid-address"]')?.getAttribute("data-linked-severity")).toBe("blocking");
});

test("the code is shown with the exact saved address, each with a copy button", async () => {
  const written: string[] = [];
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  serve({ status: 200, body: { code: "ABCDEF-GHJKM-NPQRS", expiresAt: Date.now() + 600_000 } }, { links: view("ok") });
  await mount();
  await allow();
  const panelNode = document.querySelector("[data-pair-code]")!;
  expect(panelNode.querySelector("[data-pair-address]")?.textContent).toBe("https://board.example.test:8443");
  expect(panelNode.querySelector("[data-pair-code-value]")?.textContent).toBe("ABCDEF-GHJKM-NPQRS");
  await click(panelNode.querySelector(`[aria-label="${en("links.copyAddress")}"]`)!);
  await click(panelNode.querySelector(`[aria-label="${en("links.copyCode")}"]`)!);
  expect(written).toEqual(["https://board.example.test:8443", "ABCDEF-GHJKM-NPQRS"]);
  expect(panelNode.textContent).toContain(en("links.copied"));
});

test("a used code names the machine that connected, and the grant row says who connects to whom", async () => {
  const fx = serve({ status: 200, body: { code: "ABCDEF-GHJKM-NPQRS", expiresAt: Date.now() + 600_000 } }, { links: view("ok") });
  await mount();
  fx.fixture.codes = [{ id: "ABCDEF", expiresAt: Date.now() + 600_000, wrongAttempts: 0, used: true, burned: false }];
  fx.fixture.grants = [grant({ id: "old", label: "laptop", created: 50 }), grant({ id: "new", label: "home-pc", created: 200 })];
  await allow();
  await settle();
  expect(document.querySelector("[data-linked-connected]")?.textContent).toBe(en("links.connectedHere", { name: "home-pc" }));
  const rows = [...document.querySelectorAll("[data-linked-grant]")].map((row) => row.textContent);
  expect(rows.some((row) => row?.includes(en("links.grantRow", { name: "home-pc" })))).toBe(true);
});

test("a code used with no new grant keeps the plain sentence", async () => {
  const fx = serve({ status: 200, body: { code: "ABCDEF-GHJKM-NPQRS", expiresAt: Date.now() + 600_000 } }, { links: view("ok") });
  await mount();
  fx.fixture.codes = [{ id: "ABCDEF", expiresAt: Date.now() + 600_000, wrongAttempts: 0, used: true, burned: false }];
  await allow();
  await settle();
  expect(document.querySelector("[data-linked-connected]")).toBeNull();
  expect(document.querySelector('[data-code-state="used"]')?.textContent).toBe(en("links.codeUsed"));
});

async function connectWith(fx: ReturnType<typeof serve>) {
  await click(roleRadio("connect"));
  await type(byLabel("links.peerAddress")!, "https://peer.example.test");
  await type(byLabel("links.peerCode")!, "ABCDEFGHJKMNPQRS");
  await act(async () => { byLabel("links.peerCode")!.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
  await settle();
  return fx;
}

test("connecting names the machine it reached and lists it", async () => {
  const fx = serve({ status: 200, body: {} }, { links: view("ok", false, null) });
  await mount();
  await connectWith(fx);
  expect(fx.requests.find((sent) => sent.method === "POST" && sent.url === "/api/links/peers")?.body).toEqual({ url: "https://peer.example.test", code: "ABCDEFGHJKMNPQRS", name: "" });
  expect(panel("connect").querySelector("[data-linked-connected]")?.textContent).toBe(en("links.connectedThere", { name: "home-pc" }));
});

test("a failed connect is answered under the form and never as this install's address state", async () => {
  const expected: [string, string][] = [
    ["version", en("links.error.version")],
    ["not-delegatus", en("links.error.notDelegatus")],
    ["http-public", en("links.error.peerHttp")],
    ["invalid-address", en("links.error.peerAddress")],
    ["unreachable", en("links.error.unreachable")],
  ];
  for (const [code, sentence] of expected) {
    const fx = serve({ status: 200, body: {} }, { links: view("ok", false, null), connect: { status: 409, body: { error: code } } });
    await mount();
    await connectWith(fx);
    const failure = panel("connect").querySelector("[data-linked-connect-error]");
    expect(failure?.textContent).toBe(sentence);
    expect(failure?.getAttribute("role")).toBe("alert");
    expect(document.querySelector('[data-linked-state="http-public"], [data-linked-state="invalid-address"]')).toBeNull();
    act(() => root?.unmount()); root = null; document.body.innerHTML = "";
  }
  const fx = serve({ status: 200, body: {} }, { links: view("ok", false, null), connect: { status: 409, body: { error: "something-new" } } });
  await mount();
  await connectWith(fx);
  expect(panel("connect").querySelector("[data-linked-connect-error]")?.textContent).toBe(en("links.error.other", { reason: "something-new" }));
});

test("a peer's failing sync reads as a sentence, and an unknown code is named", async () => {
  serve({ status: 200, body: {} }, { peers: [peer({ state: "failing", error: "malformed" }), peer({ id: "peer-2", label: "office", state: "failing", error: "brand-new" })] });
  await mount();
  const errors = [...document.querySelectorAll("[data-linked-peer-error]")].map((node) => node.textContent);
  expect(errors[0]).toBe(en("links.peerError.version", { name: "home-pc" }));
  expect(errors[1]).toBe(en("links.peerError.other", { reason: "brand-new" }));
  expect(errors.every((text) => text !== "malformed" && text !== "brand-new")).toBe(true);
});

test("everything that worked before still calls the same routes", async () => {
  const fx = serve({ status: 200, body: { code: "ABCDEF-GHJKM-NPQRS", expiresAt: Date.now() + 600_000 } },
    { links: { ...view("ok"), keyOn: false }, peers: [peer()], grants: [grant()], known: [{ key: "repo-1", name: "Board" }] });
  await mount();
  const posted = (method: string, url: string) => fx.requests.filter((sent) => sent.method === method && sent.url === url).map((sent) => sent.body);
  await click(byText(en("links.save"))!);
  await click(byText(en("links.check"))!);
  fx.fixture.links = view("ok");
  await click(byText(en("links.turnOnKey"))!);
  expect(posted("POST", "/api/links")).toEqual([{ action: "save", publicUrl: "https://board.example.test:8443", label: "stage" }, { action: "check" }, { action: "key" }]);
  await click(byText(en("links.syncNow"))!);
  await click(byText(en("links.remove"))!);
  await click(byText(en("links.revoke"))!);
  expect(posted("POST", "/api/links/peers/peer-1").length).toBe(1);
  expect(posted("DELETE", "/api/links/peers/peer-1").length).toBe(1);
  expect(posted("DELETE", "/api/links/grants?id=grant-1").length).toBe(1);
  await click(document.querySelector('label input[type="checkbox"]')!);
  expect(posted("PATCH", "/api/links/shared")).toEqual([{ all: true }]);
  await allow();
  await click(byText(en("links.cancelCode"))!);
  expect(posted("DELETE", "/api/links/codes?id=ABCDEF").length).toBe(1);
});


test("sync state is visible for outgoing and incoming links, including waiting and errors", async () => {
  const minutes = (count: number) => Date.now() - count * 60_000;
  serve({ status: 200, body: {} }, { peers: [peer({ lastCall: minutes(30), state: "failing", error: "unreachable" })], grants: [grant({ lastCall: minutes(2) }), grant({ id: "pending", lastCall: null }), grant({ id: "failed", lastCall: null, error: "malformed" }), grant({ id: "old", lastCall: minutes(40) })] });
  await mount();
  const lines = [...document.querySelectorAll("[data-linked-sync]")];
  expect(lines.map((node) => node.getAttribute("data-linked-sync"))).toEqual(["failing", "synced", "waiting", "failing", "stale"]);
  expect(lines.map((node) => node.textContent)).toEqual([
    en("links.syncFailing", { ago: "30 minutes ago" }),
    en("links.syncedAgo", { ago: "2 minutes ago" }),
    en("links.syncWaiting"),
    en("links.syncFailingNever"),
    en("links.syncStale", { ago: "40 minutes ago" }),
  ]);
  expect(lines.map((node) => ["text-danger", "text-success", "text-muted", "text-warning"].find((tone) => node.classList.contains(tone)))).toEqual(["text-danger", "text-success", "text-muted", "text-danger", "text-warning"]);
  expect(document.querySelector('[data-linked-grant-error="malformed"]')!.textContent).toBe(en("links.peerError.version", { name: "home-pc" }));
});

test("the connected machines come before the pairing steps once a link exists, and after them when none does", async () => {
  const position = () => {
    const machines = document.querySelector(`section[aria-label="${en("links.connectedMachines")}"]`)!;
    return machines.compareDocumentPosition(document.querySelector('[role="radiogroup"]')!);
  };
  serve({ status: 200, body: {} }, { peers: [peer({ lastCall: Date.now() })] });
  await mount();
  expect(position() & 4).toBe(4);
  act(() => root?.unmount()); root = null; document.body.innerHTML = "";
  serve({ status: 200, body: {} });
  await mount();
  expect(position() & 2).toBe(2);
});

test("successful link polling cannot hide an initial settings read failure", async () => {
  serve({ status: 200, body: {} });
  const read = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => String(input) === "/api/links" ? Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 })) : read(input, init)) as typeof fetch;
  await mount();
  expect(document.querySelector('[data-linked-state="unavailable"]')!.textContent).toBe(en("links.state.unavailable"));
});

test("failed link metadata reads keep an honest error beside the settings", async () => {
  serve({ status: 200, body: {} });
  const read = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => String(input) === "/api/links/peers" ? Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 })) : read(input, init)) as typeof fetch;
  await mount();
  expect(document.querySelector('[data-linked-state="unavailable"]')!.textContent).toBe(en("links.state.unavailable"));
});
