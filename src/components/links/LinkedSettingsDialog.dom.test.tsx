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

const view = (check: string) => ({
  self: { label: "stage", publicUrl: "https://board.example.test:8443", check: { code: check, at: "2026-09-29T08:00:00.000Z" } },
  state: check, entry: { port: 8898, publishable: true }, keyOn: true, tailnetUrl: null,
});

function serve(mint: { status: number; body: object }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/links/codes" && init?.method === "POST") return Response.json(mint.body, { status: mint.status });
    if (url === "/api/links") return Response.json(view("unverified"));
    if (url === "/api/links/codes") return Response.json({ codes: [] });
    if (url === "/api/links/shared") return Response.json({ shared: { v: 1, all: false, projects: [] }, known: [], states: [] });
    if (url === "/api/links/peers") return Response.json({ peers: [] });
    if (url === "/api/links/grants") return Response.json({ grants: [] });
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => { root!.render(<LinkedSettingsDialog onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

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
