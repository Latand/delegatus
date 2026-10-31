import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { MobileNav } from "@/components/mobile/mobileNav";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";

/*
 * What a saved OpenAI key serves (docs/design/openai-key-services.md, variant 3):
 * the list under the OpenAI row and each feature's page, over the real
 * `/api/openai-services`, `/api/keys` and voice settings routes and the real
 * provider policy, in a throw-away config directory. The page's requests go
 * to the route handlers with the operator's own session cookie, so what a row
 * names is what the policy resolves for the next request.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.Event, localStorage: dom.localStorage,
});

const { createRoot } = await import("react-dom/client");
const { NextRequest } = await import("next/server");
const { KeysMenuPage } = await import("./KeysSection");
const { OpenAiFeaturePage, SERVICE_FEATURES, resetOpenAiServicesForTests } = await import("./OpenAiServices");
const { HeaderMenuPanel, HeaderMenuSheet } = await import("@/components/headerMenu/HeaderMenu");
const { OPEN_KEYS_EVENT, settleKeys } = await import("./openKeys");
const { invalidateLiveToken, prewarmLiveToken, useDictation } = await import("@/hooks/useDictation");
const transcribeToken = await import("@/app/api/transcribe/token/route");
const transcribeBackend = await import("@/app/api/transcribe/backend/route");
const { MicButtonView } = await import("@/components/MicButton");
const { VoiceStep } = await import("@/components/onboarding/VoiceStep");
const { VoiceCompanionSetting } = await import("@/components/voiceCompanion/VoiceCompanionSetting");
const services = await import("@/app/api/openai-services/route");
const keysList = await import("@/app/api/keys/route");
const keyWrite = await import("@/app/api/keys/[id]/route");
const voiceSettings = await import("@/app/api/voice-companion/settings/route");
const asksYouRoute = await import("@/app/api/asks-you/route");
const memorySettings = await import("@/app/api/memory/settings/route");
const { AsksYouRow, usd } = await import("@/components/AsksYouRow");
const { resetAsksYouSettingForTests } = await import("@/components/asksYouSetting");
const { MemoryPanel, MemoryReadingProvider } = await import("@/components/memory/MemoryPage");
const { asksYouSettingView } = await import("@/lib/asks/view");
const { writeAsksYouSettings } = await import("@/lib/asks/settings");
const { setSharedMemoryEnabled } = await import("@/lib/memory/settings");
const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
const { configFilePath } = await import("@/lib/configDir");
const { resolveService } = await import("@/lib/openaiServices/policy");
const { writeTtsBackend } = await import("@/lib/ttsBackend");
const { writeTranscribeBackend } = await import("@/lib/transcribeBackend");
const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
const { resetTeamStoreForTests } = await import("@/lib/team/store");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");

/* Placeholders built at run time from runs of one character; a row shows only a masked tail. */
const OPENAI = ["sk", "proj", "2".repeat(48)].join("-");
const OPENAI_NEXT = ["sk", "proj", "3".repeat(48)].join("-");
const OPENROUTER = ["sk", "or", "v1", "0".repeat(64)].join("-");

const variables = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "LLV_STAGING", "LLV_TTS_BACKEND", "LLV_TRANSCRIBE_BACKEND",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "SONIOX_API_KEY", "FISH_AUDIO_API_KEY"];
let tmp: string, saved: Record<string, string | undefined>;
const file = (name: string, value: string) => { const target = configFilePath(name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value, { mode: 0o600 }); };
/* The invented installation: OpenRouter, ElevenLabs and Soniox keys saved; dictation on Soniox, read aloud on ElevenLabs, voice on Codex V3. */
function seed() {
  file("openrouter-api-key", OPENROUTER);
  file("elevenlabs-api-key", `sk_${"1".repeat(48)}\n`);
  file("soniox-api-key", `${"4".repeat(64)}\n`);
  writeTtsBackend("elevenlabs");
  writeTranscribeBackend("soniox");
  new CompanionStorage().updateSettings({ backend: "codex" });
}
beforeEach(() => {
  saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openai-services-dom-"));
  for (const name of ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) process.env[name] = path.join(tmp, name);
  resetTeamStoreForTests();
  seed();
});

/* `presented`: the token a request carried in its bearer header, to name the key it was minted from. */
type Call = { url: string; method: string; body: unknown; presented: string | null };
let calls: Call[] = [];
/* A choice's save held until the test lets it go, to see the optimistic choice and to answer out of order. */
let holdPut: ((release: () => void) => void) | null = null;
let refuse: ((call: Call) => Response | null) | null = null;
/* A vendor's token answer held the same way: the token route has already read the policy, and a key or a choice changes before the mint lands. */
let holdMint: ((release: () => void) => void) | null = null;
/* Every request the pages or the mic send, from the call until its answer has been read whole, and how many holds it waits on now:
   a vendor call a route makes is the route's child, so holding it holds the route's request too. */
type Owned = { held: number; parent: Owned | null };
const within = new AsyncLocalStorage<Owned>();
const owned = new Map<Promise<unknown>, Owned>();
const holds = new Set<() => void>();
let parked = () => {};
function own<T>(work: Promise<T>, state: Owned = { held: 0, parent: null }): Promise<T> {
  owned.set(work, state);
  work.then(() => owned.delete(work), () => owned.delete(work));
  return work;
}
/* The page reads an answer through these; each read is owned too, so the step after it starts while a request is still counted. */
function owning(response: Response): Response {
  for (const read of ["json", "text", "arrayBuffer"] as const) {
    const original = response[read].bind(response);
    Object.defineProperty(response, read, { value: () => own(original()) });
  }
  return response;
}
const hold = (state: Owned, gate: (release: () => void) => void) => new Promise<void>((resolve) => {
  const go = () => { holds.delete(go); for (let at: Owned | null = state; at; at = at.parent) at.held--; resolve(); };
  holds.add(go);
  for (let at: Owned | null = state; at; at = at.parent) at.held++;
  parked();
  gate(go);
});
/* The live tokens the token route minted at the vendors, each with the key it was minted from. */
const minted = new Map<string, string>();
const bearer = (init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return (headers.authorization ?? headers.Authorization ?? "").replace(/^Bearer /, "");
};
const origin = "http://127.0.0.1";
const asOperator = (url: string, init?: RequestInit) => new NextRequest(origin + url, {
  method: init?.method ?? "GET",
  headers: { host: "127.0.0.1", origin, cookie: `llv_operator=${soloBrowserSession()}`, "content-type": String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "application/json") },
  body: typeof init?.body === "string" ? init.body : undefined,
});
async function route(url: string, call: Call, state: Owned, init?: RequestInit): Promise<Response> {
  const refused = refuse?.(call);
  if (refused) return refused;
  if (url === "/api/openai-services") return call.method === "PUT" ? services.PUT(asOperator(url, init)) : services.GET(asOperator(url, init));
  if (url === "/api/keys") return keysList.GET(asOperator(url, init));
  if (url.startsWith("/api/keys/")) {
    const params = { params: Promise.resolve({ id: url.slice("/api/keys/".length) }) };
    return call.method === "DELETE" ? keyWrite.DELETE(asOperator(url, init), params) : keyWrite.PUT(asOperator(url, init), params);
  }
  if (url === "/api/voice-companion/settings") return call.method === "PUT" ? voiceSettings.PUT(asOperator(url, init)) : voiceSettings.GET(asOperator(url, init));
  if (url === "/api/transcribe/token") return transcribeToken.POST(asOperator(url, init));
  if (url === "/api/asks-you") return call.method === "PUT" ? asksYouRoute.PUT(asOperator(url, init)) : asksYouRoute.GET();
  if (url.startsWith("/api/memory/settings")) return call.method === "PUT" ? memorySettings.PUT(asOperator(url, init)) : memorySettings.GET(asOperator(url, init));
  if (url === "/api/transcribe/backend") return call.method === "POST" ? transcribeBackend.POST(asOperator(url, init)) : transcribeBackend.GET();
  /* Vendor stand-ins: only the transports leave this process in production. */
  if (holdMint && (url === "https://api.openai.com/v1/realtime/client_secrets" || url.startsWith("https://api.elevenlabs.io/"))) await hold(state, holdMint);
  if (url === "https://api.openai.com/v1/realtime/client_secrets") {
    const value = ["client", "secret", String(minted.size + 1)].join("-");
    minted.set(value, bearer(init));
    return Response.json({ value, expires_at: Math.floor(Date.now() / 1000) + 120 });
  }
  if (url === "https://api.openai.com/v1/realtime/calls") return new Response("v=0 answer-fixture");
  if (url.startsWith("https://api.elevenlabs.io/")) {
    const token = ["elevenlabs", "token", String(minted.size + 1)].join("-");
    minted.set(token, ((init?.headers ?? {}) as Record<string, string>)["xi-api-key"] ?? "");
    return Response.json({ token });
  }
  if (url === "/api/transcribe") return Response.json({ text: "recorded speech" });
  return Response.json({ error: "not_found" }, { status: 404 });
}
async function answer(url: string, call: Call, state: Owned, init?: RequestInit): Promise<Response> {
  if (holdPut && (url === "/api/openai-services" && call.method === "PUT" || url === "/api/transcribe/backend" && call.method === "POST")) await hold(state, holdPut);
  return (await route(url, call, state, init).then(owning));
}
function serve() {
  calls = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const call = { url, method: init?.method ?? "GET", body, presented: bearer(init) || null };
    calls.push(call);
    const state: Owned = { held: 0, parent: within.getStore() ?? null };
    return own(within.run(state, () => answer(url, call, state, init)), state);
  }) as typeof fetch;
}
/* Settled once every owned request has finished or is held by the test, after the code each answer resumed has run: one task turn lets that code send its next request. */
async function drain() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const running = [...owned].filter(([, state]) => state.held === 0).map(([work]) => work);
    if (running.length === 0) return;
    await Promise.race([Promise.allSettled(running), new Promise<void>((resolve) => { parked = resolve; })]);
  }
}

const originalFetch = globalThis.fetch;
let roots: Root[] = [];
afterEach(async () => {
  /* Nothing the test sent may still write into its directory once the environment goes back. */
  holdPut = null; holdMint = null;
  for (const go of [...holds]) go();
  await act(drain);
  act(() => { for (const root of roots) root.unmount(); }); roots = [];
  await act(drain);
  invalidateLiveToken(); minted.clear(); resetAsksYouSettingForTests(); resetOpenAiServicesForTests();
  /* An «Open Keys» request no menu took would open the next test's menu on «Keys». */
  settleKeys();
  document.body.innerHTML = ""; setLocale("en");
  globalThis.fetch = originalFetch; refuse = null;
  resetTeamStoreForTests();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const settle = () => act(drain);
async function mount(node: React.ReactNode) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(node); });
  await settle();
  return host;
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};
/* Visible words with every space, the no-break ones included, as one space. */
const norm = (text: string) => text.replace(/\s+/g, " ").trim();
const words = (element: Element | null | undefined) => norm(element?.textContent ?? "");
const say = (lang: "en" | "uk", key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => norm(translate(lang, key, params));
/** Each feature row as «feature: what serves it now», with «!» for a held choice. */
const listed = (host: HTMLElement) => [...host.querySelectorAll("[data-openai-service]")].map((row) =>
  `${row.getAttribute("data-openai-service")}: ${words(row.querySelector("[data-openai-service-now]"))}${row.hasAttribute("data-held") ? "!" : ""}`);
const option = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-openai-option='${id}']`)!;
const radio = (host: HTMLElement, id: string) => option(host, id).querySelector<HTMLInputElement>("input[type=radio]")!;
async function saveOpenAiKey(host: HTMLElement, value = OPENAI, id = "openai") {
  if (host.querySelector(`[data-keys-add='${id}']`)) await click(host.querySelector(`[data-keys-add='${id}']`));
  else { await click(host.querySelector(`[data-keys-more='${id}']`)); await click(host.querySelector(`[data-keys-row='${id}'] [data-keys-menu-item='replace']`)); }
  const input = host.querySelector<HTMLInputElement>(`[data-keys-field='${id}'] input`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => { host.querySelector(`[data-keys-field='${id}'] form`)!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
  await settle();
}
async function removeOpenAiKey(host: HTMLElement) {
  await click(host.querySelector("[data-keys-more='openai']"));
  await click(host.querySelector("[data-keys-menu-item='remove']"));
  expect(words(host.querySelector("[data-keys-remove] p"))).toBe(say("en", "keys.removeConfirm"));
  await click(host.querySelector("[data-keys-remove-go]"));
  await settle();
}

for (const lang of ["en", "uk"] as const) for (const size of ["menu", "sheet"] as const) test(`${lang} ${size}: the six features list under the OpenAI row and name what serves each now; saving a key moves none`, async () => {
  setLocale(lang);
  serve();
  const opened: string[] = [];
  const host = await mount(<KeysMenuPage size={size} onImport={() => {}} onOpenService={(feature) => opened.push(feature)} />);
  /* Directly under the OpenAI row, inside the key list. */
  expect(host.querySelector("[data-keys-row='openai']")!.nextElementSibling?.hasAttribute("data-openai-services")).toBe(true);
  expect(words(host.querySelector("[data-openai-services] p"))).toBe(say(lang, "openaiServices.group"));
  expect(listed(host)).toEqual(["asks: OpenRouter", "memory: OpenRouter", "rules: OpenRouter", "dictation: Soniox", "read: ElevenLabs", "voice: Codex V3"]);
  expect(host.querySelector("[data-openai-services-codex]")).toBeNull();
  await saveOpenAiKey(host);
  expect(host.querySelector("[data-keys-row='openai']")!.getAttribute("data-keys-source")).toBe("file");
  expect(listed(host)).toEqual(["asks: OpenRouter", "memory: OpenRouter", "rules: OpenRouter", "dictation: Soniox", "read: ElevenLabs", "voice: Codex V3"]);
  expect(words(host.querySelector("[data-openai-services-codex]"))).toBe(say(lang, "openaiServices.codex"));
  /* No feature was moved: the choices document holds no OpenAI opt-in. */
  expect(JSON.parse(fs.readFileSync(configFilePath("openai-services.json"), "utf8")).openai).toEqual({});
  await click(host.querySelector("[data-openai-service='dictation']"));
  expect(opened).toEqual(["dictation"]);
  expect(host.innerHTML).not.toContain("2".repeat(16));
});

test("pick OpenAI, remove the key, save it again: the list, the page and the policy agree at every step", async () => {
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await saveOpenAiKey(keys);
  for (const feature of ["asks", "dictation", "voice"] as const) {
    const page = await mount(<OpenAiFeaturePage feature={feature} />);
    const id = feature === "voice" ? "api" : "openai";
    expect(radio(page, id).disabled).toBe(false);
    /* Optimistic: the choice and «Now» move before the server answers. */
    let release = () => {};
    holdPut = (go) => { release = go; };
    await click(radio(page, id));
    expect(words(page.querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");
    expect(radio(page, id).checked).toBe(true);
    holdPut = null;
    await act(async () => { release(); });
    await settle();
    expect(calls.filter((call) => call.method === "PUT" && call.url === "/api/openai-services").at(-1)!.body).toEqual({ feature, provider: id });
    expect(resolveService(feature).effective).toBe(id);
  }
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  await settle();
  expect(listed(keys)).toEqual(["asks: OpenAI", "memory: OpenRouter", "rules: OpenRouter", "dictation: OpenAI", "read: ElevenLabs", "voice: OpenAI"]);

  await removeOpenAiKey(keys);
  expect(keys.querySelector("[data-keys-row='openai']")!.getAttribute("data-keys-source")).toBe("missing");
  expect(words(keys.querySelector("[data-keys-row='openai'] [data-keys-note='removed']"))).toBe(say("en", "keys.removedNote"));
  expect(listed(keys)).toEqual(["asks: OpenRouter, no key!", "memory: OpenRouter", "rules: OpenRouter", "dictation: Soniox, no key!", "read: ElevenLabs", "voice: Codex V3, no key!"]);
  expect(keys.querySelector("[data-openai-services-codex]")).toBeNull();
  const dictation = resolveService("dictation");
  expect(dictation).toMatchObject({ requested: "openai", effective: "soniox", held: true });
  /* The baseline's own credential, read in the same resolution. */
  expect(typeof dictation.apiKey).toBe("string");

  /* The page of a held feature: its previous provider serves it, and OpenAI waits for the key, amber, with the way to it. */
  const held = await mount(<OpenAiFeaturePage feature="dictation" />);
  expect(words(held.querySelector("[data-openai-feature-now]"))).toBe("Now Soniox");
  expect(radio(held, "soniox").checked).toBe(true);
  expect(radio(held, "openai").disabled).toBe(true);
  expect(words(option(held, "openai").querySelector("[data-openai-option-reason='held']"))).toBe(say("en", "openaiServices.held"));
  const asked: unknown[] = [];
  window.addEventListener(OPEN_KEYS_EVENT, (event) => asked.push((event as CustomEvent).detail));
  const addKey = option(held, "openai").querySelector("[data-openai-add-key]")!;
  /* Beside the label, never inside it. */
  expect(addKey.closest("label")).toBeNull();
  await click(addKey);
  expect(asked).toEqual([{ key: "openai" }]);

  await saveOpenAiKey(keys);
  expect(listed(keys)).toEqual(["asks: OpenAI", "memory: OpenRouter", "rules: OpenRouter", "dictation: OpenAI", "read: ElevenLabs", "voice: OpenAI"]);
  expect(resolveService("voice").effective).toBe("api");
});

test("without a key the OpenAI choice is disabled with its reason and the way to the key, and a key-less provider says which key", async () => {
  serve();
  fs.rmSync(configFilePath("elevenlabs-api-key"));
  writeTtsBackend("soniox");
  const page = await mount(<OpenAiFeaturePage feature="read" />);
  expect([...page.querySelectorAll("[data-openai-option]")].map((node) => node.getAttribute("data-openai-option"))).toEqual(["elevenlabs", "soniox", "fishaudio", "openai"]);
  expect(words(page.querySelector("[data-openai-feature-now]"))).toBe("Now Soniox");
  expect(radio(page, "openai").disabled).toBe(true);
  expect(words(option(page, "openai").querySelector("[data-openai-option-reason='unavailable']"))).toBe("No OpenAI key yet");
  expect(option(page, "openai").querySelector("[data-openai-add-key]")).not.toBeNull();
  expect(radio(page, "elevenlabs").disabled).toBe(true);
  expect(words(option(page, "elevenlabs").querySelector("[data-openai-option-reason]"))).toBe("No ElevenLabs key yet");
  expect(option(page, "elevenlabs").querySelector("[data-openai-add-key]")).toBeNull();
  expect(radio(page, "soniox").checked).toBe(true);
});

test("read aloud on its legacy OpenAI default with no key: OpenAI stays checked and disabled, and no other provider is claimed", async () => {
  serve();
  fs.rmSync(configFilePath("tts-backend"));
  const page = await mount(<OpenAiFeaturePage feature="read" />);
  expect(words(page.querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");
  expect(radio(page, "openai").checked).toBe(true);
  expect(radio(page, "openai").disabled).toBe(true);
  expect(words(option(page, "openai").querySelector("[data-openai-option-reason]"))).toBe("No OpenAI key yet");
});

test("a refused choice goes back to what the server last confirmed and says so in place", async () => {
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  const page = await mount(<OpenAiFeaturePage feature="memory" />);
  refuse = (call) => call.method === "PUT" ? Response.json({ error: "write_failed", code: "write_failed" }, { status: 500 }) : null;
  await click(radio(page, "openai"));
  expect(radio(page, "openrouter").checked).toBe(true);
  expect(words(page.querySelector("[data-openai-feature-now]"))).toBe("Now OpenRouter");
  expect(words(page.querySelector("[data-openai-feature-error][role=alert]"))).toBe(say("en", "openaiServices.saveFailed"));
  expect(resolveService("memory").effective).toBe("openrouter");
});

test("two quick choices reach the server in the order pressed: the page and the policy end on the last one", async () => {
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  const releases: Array<() => void> = [];
  holdPut = (go) => { releases.push(go); };
  await click(radio(page, "openai"));
  await click(radio(page, "elevenlabs"));
  expect(radio(page, "elevenlabs").checked).toBe(true);
  /* The second choice waits for the first: one write at a time. */
  expect(releases.length).toBe(1);
  await act(async () => { releases[0](); });
  await settle();
  expect(radio(page, "elevenlabs").checked).toBe(true);
  expect(releases.length).toBe(2);
  await act(async () => { releases[1](); });
  await settle();
  expect(calls.filter((call) => call.method === "PUT").map((call) => (call.body as { provider: string }).provider)).toEqual(["openai", "elevenlabs"]);
  expect(radio(page, "elevenlabs").checked).toBe(true);
  expect(words(page.querySelector("[data-openai-feature-now]"))).toBe("Now ElevenLabs");
  expect(resolveService("dictation").effective).toBe("elevenlabs");
});

/* The ⋯ menu itself, on the desktop and in the phone's sheet: «Back» from a feature's page unmounts it, and the Keys list or the page opened again must still know the choice it made. */
const surfaces = {
  desktop: {
    node: () => <HeaderMenuPanel project={null} onClose={() => {}} />,
    keys: ["[data-rail-menu-settings]", "[data-rail-menu-keys]"],
    back: "[data-rail-menu-back]",
  },
  phone: {
    node: () => <HeaderMenuSheet title="atlas" project={null} nav={{ closeSheet: () => {}, leave: () => {} } as unknown as MobileNav} board={[]} onClose={() => {}} />,
    keys: ["[data-mobile2-menu-row='settings']", "[data-mobile2-menu-row='keys']"],
    back: "[data-mobile2-menu-row='back']",
  },
} as const;
async function openMenuOnKeys(where: keyof typeof surfaces) {
  await mount(surfaces[where].node());
  for (const selector of surfaces[where].keys) await click(document.querySelector(selector));
  expect(document.querySelector("[data-openai-services]")).not.toBeNull();
}
const back = (where: keyof typeof surfaces) => click(document.querySelector(surfaces[where].back));
const openFeature = (feature: string) => click(document.querySelector(`[data-openai-service='${feature}']`));
const asksRow = () => words(document.querySelector("[data-openai-service='asks'] [data-openai-service-now]"));
const page = () => document.querySelector<HTMLElement>("[data-openai-feature-page]")!;
const puts = () => calls.filter((call) => call.method === "PUT" && call.url === "/api/openai-services").map((call) => (call.body as { provider: string }).provider);

for (const where of ["desktop", "phone"] as const) test(`${where}: a choice still saving when «Back» is pressed shows in the Keys row, which names the provider the server confirmed once it lands or is refused`, async () => {
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  await openMenuOnKeys(where);
  expect(asksRow()).toBe("OpenRouter");
  const releases: Array<() => void> = [];
  holdPut = (go) => { releases.push(go); };
  await openFeature("asks");
  await click(radio(page(), "openai"));
  await back(where);
  /* Pending: the list names the choice made on the page it left. */
  expect(asksRow()).toBe("OpenAI");
  expect(releases.length).toBe(1);
  await act(async () => { releases.shift()!(); });
  await settle();
  expect(resolveService("asks").effective).toBe("openai");
  expect(asksRow()).toBe("OpenAI");
  await openFeature("asks");
  expect(words(page().querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");

  /* A refused choice after «Back»: the list goes back to what the server confirmed. */
  refuse = (call) => call.method === "PUT" ? Response.json({ error: "write_failed", code: "write_failed" }, { status: 500 }) : null;
  await click(radio(page(), "openrouter"));
  await back(where);
  expect(asksRow()).toBe("OpenRouter");
  await act(async () => { releases.shift()!(); });
  await settle();
  expect(resolveService("asks").effective).toBe("openai");
  expect(asksRow()).toBe("OpenAI");
  await openFeature("asks");
  expect(words(page().querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");
  expect(radio(page(), "openai").checked).toBe(true);
});

for (const where of ["desktop", "phone"] as const) test(`${where}: choices made before and after «Back» and reopening reach the server in the order pressed, whatever order their saves are let go`, async () => {
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  await openMenuOnKeys(where);
  const releases: Array<() => void> = [];
  holdPut = (go) => { releases.push(go); };
  await openFeature("asks");
  await click(radio(page(), "openai"));
  await click(radio(page(), "openrouter"));
  await back(where);
  expect(asksRow()).toBe("OpenRouter");
  await openFeature("asks");
  /* The reopened page shows the last press, still on its way. */
  expect(words(page().querySelector("[data-openai-feature-now]"))).toBe("Now OpenRouter");
  await click(radio(page(), "openai"));
  expect(words(page().querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");
  /* Let the saves go newest first, as far as any is held. */
  while (releases.length) {
    await act(async () => { releases.pop()!(); });
    await settle();
    expect(words(page().querySelector("[data-openai-feature-now]"))).toBe("Now OpenAI");
  }
  expect(puts()).toEqual(["openai", "openrouter", "openai"]);
  expect(resolveService("asks").effective).toBe("openai");
  expect(radio(page(), "openai").checked).toBe(true);
  await back(where);
  expect(asksRow()).toBe("OpenAI");
});

test("a choice fixed by its variable disables every radio and shows that feature's lock sentence", async () => {
  process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  expect(words(page.querySelector("[data-openai-feature-locked]"))).toBe(say("en", "onboarding.voice.locked"));
  expect([...page.querySelectorAll<HTMLInputElement>("[data-openai-option] input")].every((input) => input.disabled)).toBe(true);
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

test("Voice Delegatus keeps its own «Show the voice» switch on its page", async () => {
  serve();
  const page = await mount(<OpenAiFeaturePage feature="voice" />);
  const enable = page.querySelector<HTMLButtonElement>("[data-openai-voice-enable]")!;
  expect(enable.getAttribute("aria-checked")).toBe("false");
  await click(enable);
  expect(new CompanionStorage().settings().enabled).toBe(true);
  expect(enable.getAttribute("aria-checked")).toBe("true");
  /* The switch shows the voice; it does not move the backend. */
  expect(resolveService("voice").effective).toBe("codex");
});

test("a team member's page has no list: the route refuses and the rest of «Keys» stays", async () => {
  serve();
  refuse = (call) => call.url === "/api/openai-services" ? Response.json({ error: "only the owner can do this", code: "owner_required" }, { status: 403 }) : null;
  const host = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  expect(host.querySelectorAll("[data-keys-row]").length).toBe(6);
  expect(host.querySelector("[data-openai-services]")).toBeNull();
});

test("a removal the server refuses keeps the key and says so in place", async () => {
  serve();
  file("openai-api-key", `${OPENAI}\n`);
  refuse = (call) => call.method === "DELETE" ? Response.json({ error: "the key could not be removed", code: "write_failed" }, { status: 500 }) : null;
  const host = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await removeOpenAiKey(host);
  expect(host.querySelector("[data-keys-row='openai']")!.getAttribute("data-keys-source")).toBe("file");
  expect(words(host.querySelector("[data-keys-remove-error][role=alert]"))).toBe(say("en", "keys.removeFailed"));
  expect(fs.readFileSync(configFilePath("openai-api-key"), "utf8")).toBe(`${OPENAI}\n`);
});

test("only a key saved here can be removed: a key set by its variable offers no Remove", async () => {
  process.env.OPENAI_API_KEY = OPENAI;
  serve();
  const host = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await click(host.querySelector("[data-keys-more='openai']"));
  expect([...host.querySelectorAll("[data-keys-row='openai'] [data-keys-menu-item]")].map((item) => item.getAttribute("data-keys-menu-item"))).toEqual(["masked"]);
  await click(host.querySelector("[data-keys-more='openrouter']"));
  expect([...host.querySelectorAll("[data-keys-row='openrouter'] [data-keys-menu-item]")].map((item) => item.getAttribute("data-keys-menu-item"))).toEqual(["masked", "replace"]);
});

/* ---- A held choice can be let go --------------------------------------- */

const fallbacks = { asks: "openrouter", memory: "openrouter", rules: "openrouter", dictation: "soniox", read: "elevenlabs", voice: "codex" } as const;
const fallbackNames = { asks: "OpenRouter", memory: "OpenRouter", rules: "OpenRouter", dictation: "Soniox", read: "ElevenLabs", voice: "Codex V3" } as const;
const openaiOf = (feature: keyof typeof fallbacks) => feature === "voice" ? "api" : "openai";

test("on every feature page a held choice can be let go: the provider serving it now is kept, and a saved key moves nothing back", async () => {
  /* Voice Delegatus's previous provider needs a Codex sign-in to be chosen. */
  fs.writeFileSync(path.join(createManagedCodexAccount("Fixture").home, "auth.json"), "{}\n");
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await saveOpenAiKey(keys);
  for (const feature of SERVICE_FEATURES) await click(radio(await mount(<OpenAiFeaturePage feature={feature} />), openaiOf(feature)));
  await removeOpenAiKey(keys);
  expect(listed(keys).every((row) => row.endsWith("!"))).toBe(true);

  for (const feature of SERVICE_FEATURES) {
    const page = await mount(<OpenAiFeaturePage feature={feature} />);
    const previous = fallbacks[feature];
    expect(words(page.querySelector("[data-openai-feature-now]"))).toBe(`Now ${fallbackNames[feature]}`);
    expect(radio(page, previous).checked).toBe(true);
    expect(page.querySelector("[data-openai-option-reason='held']")).not.toBeNull();
    const puts = calls.filter((call) => call.method === "PUT").length;
    /* The provider already serving it is the one pressed: that is the decision to stay, so it goes to the server. */
    await click(radio(page, previous));
    expect(calls.filter((call) => call.method === "PUT").slice(puts).map((call) => call.body)).toEqual([{ feature, provider: previous }]);
    expect(resolveService(feature)).toMatchObject({ requested: previous, effective: previous, held: false });
    expect(radio(page, previous).checked).toBe(true);
    expect(page.querySelector("[data-openai-option-reason='held']")).toBeNull();
    expect(page.querySelector("[data-openai-feature-error]")).toBeNull();
    /* Pressed again, a choice already kept sends nothing. */
    await click(radio(page, previous));
    expect(calls.filter((call) => call.method === "PUT").length).toBe(puts + 1);
  }
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  await settle();
  expect(listed(keys)).toEqual(["asks: OpenRouter", "memory: OpenRouter", "rules: OpenRouter", "dictation: Soniox", "read: ElevenLabs", "voice: Codex V3"]);
  expect(JSON.parse(fs.readFileSync(configFilePath("openai-services.json"), "utf8")).openai).toEqual({});

  await saveOpenAiKey(keys);
  expect(listed(keys)).toEqual(["asks: OpenRouter", "memory: OpenRouter", "rules: OpenRouter", "dictation: Soniox", "read: ElevenLabs", "voice: Codex V3"]);
  for (const feature of SERVICE_FEATURES) expect(resolveService(feature)).toMatchObject({ requested: fallbacks[feature], effective: fallbacks[feature], held: false });
});

test("the voice settings dialog lets a held API choice go: its checked Codex is sent, and a saved key keeps the call on Codex", async () => {
  fs.writeFileSync(path.join(createManagedCodexAccount("Fixture").home, "auth.json"), "{}\n");
  new CompanionStorage().updateSettings({ enabled: true });
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await saveOpenAiKey(keys);
  const voicePuts = () => calls.filter((call) => call.method === "PUT" && call.url === "/api/voice-companion/settings").map((call) => call.body);
  const backendRadio = (dialog: HTMLElement, id: "api" | "codex") => dialog.querySelector<HTMLInputElement>(`[data-voice-backend='${id}'] input[type=radio]`)!;
  const stored = () => { const { backend, requestedBackend, held } = new CompanionStorage().settings(); return { backend, requestedBackend, held }; };

  /* Unheld, the radios behave as before: the checked one sends nothing, the other is the choice. */
  let dialog = await mount(<VoiceCompanionSetting />);
  expect(backendRadio(dialog, "codex").checked).toBe(true);
  await click(backendRadio(dialog, "codex"));
  expect(voicePuts()).toEqual([]);
  await click(backendRadio(dialog, "api"));
  expect(voicePuts()).toEqual([{ backend: "api" }]);
  expect(stored()).toEqual({ backend: "api", requestedBackend: "api", held: false });

  await removeOpenAiKey(keys);
  expect(stored()).toEqual({ backend: "codex", requestedBackend: "api", held: true });
  dialog = await mount(<VoiceCompanionSetting />);
  expect(backendRadio(dialog, "codex").checked).toBe(true);
  /* The Codex serving it now is the one pressed: that is the decision to stay, so it goes to the server. */
  await click(backendRadio(dialog, "codex"));
  expect(voicePuts()).toEqual([{ backend: "api" }, { backend: "codex" }]);
  expect(stored()).toEqual({ backend: "codex", requestedBackend: "codex", held: false });
  expect(backendRadio(dialog, "codex").checked).toBe(true);
  expect(dialog.querySelector("[data-voice-companion-setting-error]")).toBeNull();
  /* Pressed again, a choice already kept sends nothing. */
  await click(backendRadio(dialog, "codex"));
  expect(voicePuts()).toHaveLength(2);

  await saveOpenAiKey(keys);
  expect(stored()).toEqual({ backend: "codex", requestedBackend: "codex", held: false });
  dialog = await mount(<VoiceCompanionSetting />);
  expect(backendRadio(dialog, "codex").checked).toBe(true);
  expect(backendRadio(dialog, "api").checked).toBe(false);
});

/* ---- The mic spends no token minted under an earlier key or choice ------ */

/* Built on the page's own events: the hook listens with happy-dom's Event, which a native EventTarget refuses. */
const Target = dom.EventTarget as unknown as typeof EventTarget;
class ChannelFixture extends Target {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.dispatchEvent(new dom.Event("close") as unknown as Event); }
  emit(value: unknown) { this.dispatchEvent(new dom.MessageEvent("message", { data: JSON.stringify(value) }) as unknown as Event); }
}
/* Set to keep the offer, or the microphone, waiting while the test changes a key or a choice. */
let offerGate: Promise<void> | null = null;
let micGate: Promise<void> | null = null;
const gate = () => { let open = () => {}; const shut = new Promise<void>((resolve) => { open = resolve; }); return { shut, open }; };
class PeerFixture extends Target {
  static all: PeerFixture[] = [];
  channel = new ChannelFixture();
  closed = false;
  connectionState = "new";
  constructor() { super(); PeerFixture.all.push(this); }
  createDataChannel() { return this.channel; }
  addTrack() {}
  async createOffer() { await offerGate; return { type: "offer", sdp: "v=0 offer-fixture" }; }
  async setLocalDescription() {}
  async setRemoteDescription() { queueMicrotask(() => this.channel.dispatchEvent(new dom.Event("open") as unknown as Event)); }
  close() { this.closed = true; }
}
class SocketFixture extends Target {
  static CONNECTING = 0; static OPEN = 1;
  static urls: string[] = [];
  static latest: SocketFixture | null = null;
  readyState = 0;
  constructor(url: string) { super(); SocketFixture.urls.push(url); SocketFixture.latest = this; }
  send() {}
  close() { this.readyState = 3; }
}
class AudioFixture {
  sampleRate = 16000;
  destination = {};
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createAnalyser() { return { frequencyBinCount: 64, getByteFrequencyData() {} }; }
  async close() {}
}
class RecorderFixture {
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() { this.state = "recording"; }
  constructor(readonly stream: unknown) {}
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["a".repeat(3000)]) }); this.onstop?.(); }
}
const track = { enabled: true, stop() {} };
const micStream = { getTracks: () => [track], getAudioTracks: () => [track] };
/* The browser media a press reaches, present for one test only. */
async function withMic(run: (mic: () => ReturnType<typeof useDictation>) => Promise<void>) {
  const fixtures: Record<string, unknown> = {
    RTCPeerConnection: PeerFixture, WebSocket: SocketFixture, AudioContext: AudioFixture, MediaRecorder: RecorderFixture,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  };
  const before = new Map(Object.keys(fixtures).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(fixtures)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { await micGate; return micStream; } } });
  PeerFixture.all = []; SocketFixture.urls = []; SocketFixture.latest = null; offerGate = null; micGate = null;
  const observed: { current?: ReturnType<typeof useDictation> } = {};
  function Mic() { observed.current = useDictation({ onError() {}, onUnclaimedText() {}, onLiveCommit() {} }); return null; }
  try {
    await mount(<Mic />);
    await run(() => observed.current!);
  } finally {
    await act(drain);
    act(() => { for (const root of roots) root.unmount(); }); roots = [];
    for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(dom.navigator, "mediaDevices");
  }
}
const press = async (mic: () => ReturnType<typeof useDictation>) => { await act(async () => { await mic().start(); }); await settle(); };
/* A press whose microphone or offer is held: it starts now and is awaited by `finish` once the gate opens. */
async function pressHeld(mic: () => ReturnType<typeof useDictation>) {
  let started: Promise<void> = Promise.resolve();
  await act(async () => { started = mic().start(); });
  await settle();
  return async (open: () => void) => { await act(async () => { open(); await started; }); await settle(); };
}
const release = async (mic: () => ReturnType<typeof useDictation>) => {
  let text = null as string | null;
  await act(async () => {
    const stopped = mic().stop();
    const peer = PeerFixture.all.at(-1);
    if (peer && !peer.closed) {
      peer.channel.emit({ type: "input_audio_buffer.committed", item_id: "item" });
      peer.channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item", transcript: "live speech" });
    }
    text = await stopped;
  });
  await settle();
  return text;
};
/* Each OpenAI session the mic opened, and each ElevenLabs socket, named by the key its token was minted from. */
const openAiSessions = () => calls.filter((call) => call.url === "https://api.openai.com/v1/realtime/calls").map((call) => minted.get(call.presented ?? "") ?? "unminted");
const elevenLabsSessions = () => SocketFixture.urls.map((url) => minted.get(new URL(url).searchParams.get("token") ?? "") ?? "unminted");
const prewarm = async () => { await act(async () => { prewarmLiveToken(); }); await settle(); };
const ELEVENLABS = `sk_${"1".repeat(48)}`;
const ELEVENLABS_NEXT = `sk_${"5".repeat(48)}`;
async function onOpenAi() {
  file("openai-api-key", `${OPENAI}\n`);
  await services.PUT(asOperator("/api/openai-services", { method: "PUT", body: JSON.stringify({ feature: "dictation", provider: "openai" }) }));
  expect(resolveService("dictation").effective).toBe("openai");
}
async function onElevenLabs() {
  file("openai-api-key", `${OPENAI}\n`);
  writeTranscribeBackend("elevenlabs");
  expect(resolveService("dictation").effective).toBe("elevenlabs");
}
const keyRoute = (id: string, init: RequestInit) => own(keyWrite[init.method === "DELETE" ? "DELETE" : "PUT"](asOperator(`/api/keys/${id}`, init), { params: Promise.resolve({ id }) }));

for (const where of ["here", "on another tab"] as const) {
  test(`a key removed ${where} after the mic warmed a secret: the next press records instead of reaching OpenAI`, () => withMic(async (mic) => {
    await onOpenAi();
    serve();
    const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
    await prewarm();
    expect([...minted.values()]).toEqual([OPENAI]);
    if (where === "here") await removeOpenAiKey(keys);
    else await keyRoute("openai", { method: "DELETE" });
    expect(resolveService("dictation")).toMatchObject({ effective: "soniox", held: true });
    await press(mic);
    expect(openAiSessions()).toEqual([]);
    expect(await release(mic)).toBe("recorded speech");
  }));

  test(`a key replaced ${where} after the mic warmed a secret: the next press speaks to OpenAI with the new key only`, () => withMic(async (mic) => {
    await onOpenAi();
    serve();
    const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
    await prewarm();
    if (where === "here") await saveOpenAiKey(keys, OPENAI_NEXT);
    else await keyRoute("openai", { method: "PUT", body: JSON.stringify({ value: OPENAI_NEXT }) });
    expect(fs.readFileSync(configFilePath("openai-api-key"), "utf8").trim()).toBe(OPENAI_NEXT);
    await press(mic);
    expect(openAiSessions()).toEqual([OPENAI_NEXT]);
    expect(await release(mic)).toBe("live speech");
  }));
}

test("an ElevenLabs key replaced here after the mic warmed its token: the press uses a token from the new key", () => withMic(async (mic) => {
  await onElevenLabs();
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await prewarm();
  expect([...minted.values()]).toEqual([ELEVENLABS]);
  await saveOpenAiKey(keys, ELEVENLABS_NEXT, "elevenlabs");
  await press(mic);
  expect(elevenLabsSessions()).toEqual([ELEVENLABS_NEXT]);
}));

test("dictation moved off OpenAI on its page after the mic warmed a secret: the press goes to the provider chosen", () => withMic(async (mic) => {
  await onOpenAi();
  serve();
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  await prewarm();
  await click(radio(page, "elevenlabs"));
  expect(resolveService("dictation").effective).toBe("elevenlabs");
  await press(mic);
  expect(openAiSessions()).toEqual([]);
  expect(elevenLabsSessions()).toEqual([ELEVENLABS]);
}));

test("dictation moved onto OpenAI on its page while the mic's ElevenLabs mint is still on its way: the press speaks to OpenAI", () => withMic(async (mic) => {
  await onElevenLabs();
  serve();
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  let letGo = () => {};
  holdMint = (go) => { letGo = go; };
  await prewarm();
  holdMint = null;
  await click(radio(page, "openai"));
  expect(resolveService("dictation").effective).toBe("openai");
  await act(async () => { letGo(); });
  await settle();
  await press(mic);
  expect(elevenLabsSessions()).toEqual([]);
  expect(openAiSessions()).toEqual([OPENAI]);
  expect(await release(mic)).toBe("live speech");
}));

/* Every place dictation's provider is chosen drops the warm token, before its save and again once the save lands. */
const selectors = {
  "on its page": async () => {
    const host = await mount(<OpenAiFeaturePage feature="dictation" />);
    await click(radio(host, "openai"));
  },
  "in the mic's own menu": async () => {
    const host = await mount(<MicButtonView phase="idle" elapsed={0} maxSeconds={300} remaining={300} capStopped={false} srMessage="" liveText=""
      canvasRef={{ current: null }} start={async () => {}} stop={async () => null} discard={() => {}} onText={() => {}} />);
    const button = host.querySelector<HTMLButtonElement>("button[data-mic-phase]")!;
    await act(async () => { button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
    await settle();
    await click([...document.querySelectorAll<HTMLElement>("[data-mic-backend-menu] [role=menuitemradio]")].find((item) => words(item).startsWith("OpenAI")));
  },
  "in the setup guide's voice step": async () => {
    const host = await mount(<VoiceStep onSkip={() => {}} />);
    await click(host.querySelector("[data-voice-backend=openai] input[type=radio]"));
  },
};
for (const [where, choose] of Object.entries(selectors)) for (const when of ["after the mic warmed", "while the choice is saved, when the mic warms"] as const) {
  test(`dictation moved onto OpenAI ${where} ${when} an ElevenLabs token: the press speaks to OpenAI`, () => withMic(async (mic) => {
    await onElevenLabs();
    serve();
    let save = () => {};
    if (when === "after the mic warmed") await prewarm();
    else holdPut = (go) => { save = go; };
    await choose();
    if (when !== "after the mic warmed") {
      holdPut = null;
      /* The server still serves ElevenLabs: the warm token is minted from the choice being replaced. */
      await prewarm();
      await act(async () => { save(); });
      await settle();
    }
    /* The first token was ElevenLabs'; the mic's own button may warm another once it has focus. */
    expect([...minted.values()][0]).toBe(ELEVENLABS);
    expect(resolveService("dictation").effective).toBe("openai");
    await press(mic);
    expect(elevenLabsSessions()).toEqual([]);
    expect(openAiSessions()).toEqual([OPENAI]);
  }));
}

test("dictation moved onto OpenAI while a press waits on the mic's pending ElevenLabs mint: the press speaks to OpenAI", () => withMic(async (mic) => {
  await onElevenLabs();
  serve();
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  let letGo = () => {};
  holdMint = (go) => { letGo = go; };
  await prewarm();
  holdMint = null;
  const finish = await pressHeld(mic);
  await click(radio(page, "openai"));
  await finish(letGo);
  expect(elevenLabsSessions()).toEqual([]);
  expect(openAiSessions()).toEqual([OPENAI]);
  expect(await release(mic)).toBe("live speech");
}));

/* A held OpenAI choice over a baseline, and the key saved again by another tab or device: its route runs, and no event reaches this page. */
async function heldOn(baseline: "elevenlabs" | "local") {
  file("openai-api-key", `${OPENAI}\n`);
  writeTranscribeBackend(baseline);
  await services.PUT(asOperator("/api/openai-services", { method: "PUT", body: JSON.stringify({ feature: "dictation", provider: "openai" }) }));
  await keyRoute("openai", { method: "DELETE" });
  expect(resolveService("dictation")).toMatchObject({ effective: baseline, requested: "openai", held: true });
}
const restoreElsewhere = async () => {
  await act(async () => { expect((await keyRoute("openai", { method: "PUT", body: JSON.stringify({ value: OPENAI }) })).status).toBe(200); });
  expect(resolveService("dictation")).toMatchObject({ effective: "openai", held: false });
};

test("the OpenAI key saved again on another tab after the mic warmed the held choice's ElevenLabs token: the press speaks to OpenAI", () => withMic(async (mic) => {
  await heldOn("elevenlabs");
  serve();
  await prewarm();
  expect([...minted.values()]).toEqual([ELEVENLABS]);
  await restoreElsewhere();
  await press(mic);
  expect(elevenLabsSessions()).toEqual([]);
  expect(openAiSessions()).toEqual([OPENAI]);
  expect(await release(mic)).toBe("live speech");
}));

test("the OpenAI key saved again on another tab while the mic's ElevenLabs mint is on its way: the press waiting on it speaks to OpenAI", () => withMic(async (mic) => {
  await heldOn("elevenlabs");
  serve();
  let letGo = () => {};
  holdMint = (go) => { letGo = go; };
  await prewarm();
  holdMint = null;
  const finish = await pressHeld(mic);
  await restoreElsewhere();
  await finish(letGo);
  expect([...minted.values()][0]).toBe(ELEVENLABS);
  expect(elevenLabsSessions()).toEqual([]);
  expect(openAiSessions()).toEqual([OPENAI]);
  expect(await release(mic)).toBe("live speech");
}));

test("the OpenAI key saved again on another tab after the mic learned the held choice has no live mode: the press speaks to OpenAI live", () => withMic(async (mic) => {
  await heldOn("local");
  serve();
  await prewarm();
  expect(calls.filter((call) => call.url === "/api/transcribe/token")).toHaveLength(1);
  expect(minted.size).toBe(0);
  await restoreElsewhere();
  await press(mic);
  expect(openAiSessions()).toEqual([OPENAI]);
  expect(await release(mic)).toBe("live speech");
}));

test("with the OpenAI choice still held, the press spends the warm ElevenLabs token and mints nothing more", () => withMic(async (mic) => {
  await heldOn("elevenlabs");
  serve();
  await prewarm();
  await press(mic);
  expect(elevenLabsSessions()).toEqual([ELEVENLABS]);
  expect(minted.size).toBe(1);
  expect(openAiSessions()).toEqual([]);
}));

test("an ElevenLabs dictation already speaking keeps its socket when the OpenAI key is saved again on another tab", () => withMic(async (mic) => {
  await heldOn("elevenlabs");
  serve();
  await press(mic);
  const socket = SocketFixture.latest!;
  expect(elevenLabsSessions()).toEqual([ELEVENLABS]);
  await restoreElsewhere();
  expect(socket.readyState).not.toBe(3);
  expect(SocketFixture.urls).toHaveLength(1);
  expect(openAiSessions()).toEqual([]);
}));

test("a mint retired by a key change lands after the next prewarm's: the press spends the newer token and mints nothing more", () => withMic(async (mic) => {
  await onElevenLabs();
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  const letGo: Array<() => void> = [];
  holdMint = (go) => { letGo.push(go); };
  await prewarm();
  await saveOpenAiKey(keys, ELEVENLABS_NEXT, "elevenlabs");
  await prewarm();
  holdMint = null;
  expect([...minted.values()]).toEqual([]);
  await act(async () => { letGo[1](); }); await settle();
  await act(async () => { letGo[0](); }); await settle();
  expect([...minted.values()]).toEqual([ELEVENLABS_NEXT, ELEVENLABS]);
  await press(mic);
  expect(elevenLabsSessions()).toEqual([ELEVENLABS_NEXT]);
  expect(minted.size).toBe(2);
}));

test("dictation moved onto OpenAI while the press waits for the microphone: the ElevenLabs token it took is not spent", () => withMic(async (mic) => {
  await onElevenLabs();
  serve();
  const page = await mount(<OpenAiFeaturePage feature="dictation" />);
  const microphone = gate();
  micGate = microphone.shut;
  const finish = await pressHeld(mic);
  expect([...minted.values()]).toEqual([ELEVENLABS]);
  await click(radio(page, "openai"));
  await finish(microphone.open);
  expect(elevenLabsSessions()).toEqual([]);
  expect(await release(mic)).toBe("recorded speech");
}));

test("the key removed while the press prepares its OpenAI offer: the offer never reaches OpenAI", () => withMic(async (mic) => {
  await onOpenAi();
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  const offer = gate();
  offerGate = offer.shut;
  const finish = await pressHeld(mic);
  expect([...minted.values()]).toEqual([OPENAI]);
  await removeOpenAiKey(keys);
  await finish(offer.open);
  expect(openAiSessions()).toEqual([]);
  expect(await release(mic)).toBe("recorded speech");
}));

test("a dictation already speaking to OpenAI keeps going when the key is removed, and ends with its transcript", () => withMic(async (mic) => {
  await onOpenAi();
  serve();
  const keys = await mount(<KeysMenuPage onImport={() => {}} onOpenService={() => {}} />);
  await press(mic);
  expect(openAiSessions()).toEqual([OPENAI]);
  await removeOpenAiKey(keys);
  expect(PeerFixture.all.at(-1)!.closed).toBe(false);
  expect(await release(mic)).toBe("live speech");
  expect(PeerFixture.all.at(-1)!.closed).toBe(true);
}));

/* ---- The classifiers' own explanations name the provider the next message goes to ---- */

const PROJECT = "fixture-project";
/* The muted line each switch is described by. */
const hintOf = (host: HTMLElement, switchSelector: string) =>
  words(document.getElementById(host.querySelector(switchSelector)?.getAttribute("aria-describedby") ?? ""));
/* «Asks you» and the memory page as the menu draws them, each from its own route read. */
async function explanations() {
  resetAsksYouSettingForTests();
  const host = await mount(<><AsksYouRow variant="menu" /><MemoryReadingProvider project={PROJECT}><MemoryPanel /></MemoryReadingProvider></>);
  const shown = { asks: hintOf(host, "[data-asks-you-switch]"), memory: hintOf(host, "[data-memory-switch]") };
  act(() => { roots.pop()!.unmount(); });
  host.remove();
  return shown;
}
for (const lang of ["en", "uk"] as const) for (const enabled of [false, true]) test(`${lang}, ${enabled ? "on" : "off"}: «Asks you» and the memory page name OpenAI once it serves them, and OpenRouter again after the key is removed`, async () => {
  setLocale(lang);
  writeAsksYouSettings({ enabled });
  setSharedMemoryEnabled(PROJECT, enabled);
  file("openai-api-key", `${OPENAI}\n`);
  serve();
  const expected = (provider: "openrouter" | "openai") => {
    const view = asksYouSettingView();
    expect(view.provider).toBe(provider);
    const values = { spent: usd(view.spentUsd, lang), cap: usd(view.capUsd, lang) };
    const asks = provider === "openai" ? (enabled ? "asksYou.openai.on" : "asksYou.openai.off") : (enabled ? "asksYou.on" : "asksYou.off");
    return { asks: say(lang, asks, values), memory: say(lang, provider === "openai" ? "memoryPage.openai.explains" : "memoryPage.explains") };
  };

  expect(await explanations()).toEqual(expected("openrouter"));

  for (const feature of ["asks", "memory"]) await services.PUT(asOperator("/api/openai-services", { method: "PUT", body: JSON.stringify({ feature, provider: "openai" }) }));
  const onOpenAi = await explanations();
  expect(onOpenAi).toEqual(expected("openai"));
  expect(`${onOpenAi.asks} ${onOpenAi.memory}`).not.toMatch(/OpenRouter|Jev/);

  await keyRoute("openai", { method: "DELETE" });
  expect(resolveService("asks")).toMatchObject({ effective: "openrouter", held: true });
  expect(await explanations()).toEqual(expected("openrouter"));

  await keyRoute("openai", { method: "PUT", body: JSON.stringify({ value: OPENAI }) });
  expect(await explanations()).toEqual(expected("openai"));
});
