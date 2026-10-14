import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useDictation, type UseDictationResult } from "./useDictation";
import { setLocale } from "@/lib/i18n";

const dom = new Window();
const originalFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
};
for (const [key, value] of Object.entries(globals)) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const stream = { getTracks: () => [{ stop() {} }] };
Object.defineProperty(dom.navigator, "mediaDevices", { value: { getUserMedia: async () => stream } });
class AudioFixture {
  sampleRate = 16000;
  destination = {};
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createAnalyser() { return { frequencyBinCount: 64, getByteFrequencyData() {} }; }
  async close() {}
}
class SocketFixture extends EventTarget {
  static CONNECTING = 0; static OPEN = 1;
  static urls: string[] = [];
  static latest: SocketFixture;
  readyState = 0;
  constructor(url: string) { super(); SocketFixture.urls.push(url); SocketFixture.latest = this; }
  send() {}
  close() { this.readyState = 3; }
}
class RecorderFixture {
  static isTypeSupported() { return true; }
  state = "inactive";
  stream = stream;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["a".repeat(3000)]) }); this.onstop?.(); }
}
for (const [key, value] of Object.entries({ AudioContext: AudioFixture, WebSocket: SocketFixture, MediaRecorder: RecorderFixture })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let root: Root | undefined;
const observed: { current?: UseDictationResult } = {};
const dictation = () => observed.current!;
const errors: string[] = [];
const commits: Array<{ text: string; language?: string }> = [];
function Harness() { const result = useDictation({ onError: error => errors.push(error), onUnclaimedText() {}, onLiveCommit(text, language) { commits.push({ text, language }); } }); useLayoutEffect(() => { observed.current = result; }); return null; }
function mount(locale: "uk" | "en") {
  setLocale(locale); errors.length = 0; commits.length = 0;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement); flushSync(() => root!.render(<Harness />));
}
afterEach(() => { flushSync(() => root?.unmount()); root = undefined; globalThis.fetch = originalFetch; dom.document.body.replaceChildren(); });
// This file runs by explicit path in its own process; restore the fixture globals on exit.
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 20)); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test.each(["uk", "en"] as const)("ElevenLabs live carries the %s UI language and the other allowed languages", async locale => {
  globalThis.fetch = (async () => Response.json({ provider: "elevenlabs", token: "fixture" })) as unknown as typeof fetch;
  mount(locale); await dictation().start();
  expect(errors).toEqual([]);
  const url = new URL(SocketFixture.urls.at(-1)!);
  expect(url.searchParams.get("language_code")).toBe(locale);
  expect(url.searchParams.getAll("secondary_languages").sort()).toEqual(["uk", "ru", "en"].filter(code => code !== locale).sort());
  await dictation().stop();
});

test.each(["soniox", "elevenlabs"])("%s live tags an unexpected provider language deterministically", async provider => {
  globalThis.fetch = (async () => Response.json({ provider, token: "fixture" })) as unknown as typeof fetch;
  mount("en"); await dictation().start();
  const data = provider === "soniox"
    ? { tokens: [{ text: "speech", is_final: true, language: "be" }, { text: "<end>", is_final: true }] }
    : { message_type: "committed_transcript", text: "speech", language_code: "bel" };
  SocketFixture.latest.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  expect(commits).toEqual([{ text: "speech", language: provider === "soniox" ? "uk" : "en" }]);
  await dictation().stop();
});

test.each(["uk", "en"] as const)("batch fallback carries the %s UI language", async locale => {
  let language: FormDataEntryValue | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/token")) return new Response(null, { status: 409 });
    language = (init!.body as FormData).get("language");
    return Response.json({ text: "speech" });
  }) as unknown as typeof fetch;
  mount(locale); await dictation().start(); await dictation().stop();
  expect(errors).toEqual([]);
  expect(language as FormDataEntryValue | null).toBe(locale);
});
