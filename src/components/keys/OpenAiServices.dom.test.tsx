import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

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
const { OpenAiFeaturePage } = await import("./OpenAiServices");
const { OPEN_KEYS_EVENT } = await import("./openKeys");
const services = await import("@/app/api/openai-services/route");
const keysList = await import("@/app/api/keys/route");
const keyWrite = await import("@/app/api/keys/[id]/route");
const voiceSettings = await import("@/app/api/voice-companion/settings/route");
const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
const { configFilePath } = await import("@/lib/configDir");
const { resolveService } = await import("@/lib/openaiServices/policy");
const { writeTtsBackend } = await import("@/lib/ttsBackend");
const { writeTranscribeBackend } = await import("@/lib/transcribeBackend");
const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
const { resetTeamStoreForTests } = await import("@/lib/team/store");

/* Placeholders built at run time from runs of one character; a row shows only a masked tail. */
const OPENAI = ["sk", "proj", "2".repeat(48)].join("-");
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

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
/* A PUT held until the test lets it go, to see the optimistic choice and to answer out of order. */
let holdPut: ((release: () => void) => void) | null = null;
let refuse: ((call: Call) => Response | null) | null = null;
const origin = "http://127.0.0.1";
const asOperator = (url: string, init?: RequestInit) => new NextRequest(origin + url, {
  method: init?.method ?? "GET",
  headers: { host: "127.0.0.1", origin, cookie: `llv_operator=${soloBrowserSession()}`, "content-type": String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "application/json") },
  body: typeof init?.body === "string" ? init.body : undefined,
});
function serve() {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const refused = refuse?.(call);
    if (refused) return refused;
    if (url === "/api/openai-services") {
      if (call.method === "PUT") {
        if (holdPut) await new Promise<void>((resolve) => holdPut!(resolve));
        return services.PUT(asOperator(url, init));
      }
      return services.GET(asOperator(url, init));
    }
    if (url === "/api/keys") return keysList.GET(asOperator(url, init));
    if (url === "/api/keys/openai") {
      const params = { params: Promise.resolve({ id: "openai" }) };
      return call.method === "DELETE" ? keyWrite.DELETE(asOperator(url, init), params) : keyWrite.PUT(asOperator(url, init), params);
    }
    if (url === "/api/voice-companion/settings") return call.method === "PUT" ? voiceSettings.PUT(asOperator(url, init)) : voiceSettings.GET(asOperator(url, init));
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
let roots: Root[] = [];
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); }); roots = [];
  document.body.innerHTML = ""; setLocale("en");
  globalThis.fetch = originalFetch; holdPut = null; refuse = null;
  resetTeamStoreForTests();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
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
async function saveOpenAiKey(host: HTMLElement) {
  await click(host.querySelector("[data-keys-add='openai']"));
  const input = host.querySelector<HTMLInputElement>("[data-keys-field='openai'] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, OPENAI);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => { host.querySelector("[data-keys-field='openai'] form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
  await settle(); await settle();
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
