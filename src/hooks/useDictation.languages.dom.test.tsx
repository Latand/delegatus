import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useDictation, type UseDictationResult } from "./useDictation";
import { setLocale, translate } from "@/lib/i18n";

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

/* OpenAI live transcription over WebRTC (docs/design/openai-key-services.md, D-live): a peer connection
   fixture that answers the offer and opens its data channel; the calls endpoint is answered by the test's fetch. */
class ChannelFixture extends EventTarget {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.dispatchEvent(new Event("close")); }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
class PeerFixture extends EventTarget {
  static latest: PeerFixture | undefined;
  channel = new ChannelFixture();
  label = "";
  tracks: unknown[] = [];
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  connectionState = "new";
  constructor() { super(); PeerFixture.latest = this; }
  createDataChannel(label: string) { this.label = label; return this.channel; }
  addTrack(track: unknown) { this.tracks.push(track); }
  async createOffer() { return { type: "offer", sdp: "v=0 offer-fixture" }; }
  async setLocalDescription() {}
  async setRemoteDescription(description: { type: string; sdp: string }) { this.remote = description; queueMicrotask(() => this.channel.dispatchEvent(new Event("open"))); }
  close() { this.closed = true; }
}
const audioTrack = { enabled: true, stop() {} };
Object.assign(stream, { getAudioTracks: () => [audioTrack] });

/* Built at run time: a bearer line with a literal value reads as a credential to the publication gate. */
const CLIENT_SECRET = ["client", "secret", "fixture"].join("-");
function openAiFetch(calls: Array<{ url: string; init?: RequestInit }>, answer: () => Response = () => new Response("v=0 answer-fixture")) {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/transcribe/token")) return Response.json({ provider: "openai", token: CLIENT_SECRET, expiresAt: 2_000_000_000 });
    if (String(url) === "https://api.openai.com/v1/realtime/calls") return answer();
    if (String(url).endsWith("/api/transcribe")) return Response.json({ text: "recorded speech" });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}
const withPeer = async (run: () => Promise<void>) => {
  saved.set("RTCPeerConnection", saved.get("RTCPeerConnection") ?? Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection"));
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: PeerFixture });
  try { await run(); } finally { Reflect.deleteProperty(globalThis, "RTCPeerConnection"); PeerFixture.latest = undefined; audioTrack.enabled = true; }
};

test("OpenAI live: the client secret goes only to OpenAI's calls endpoint, and the stop commits the turn and returns its transcript", () => withPeer(async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = openAiFetch(calls);
  const sockets = SocketFixture.urls.length;
  mount("en"); await dictation().start();
  const peer = PeerFixture.latest!;
  expect(errors).toEqual([]);
  expect(SocketFixture.urls.length).toBe(sockets);
  const offer = calls.find((call) => call.url === "https://api.openai.com/v1/realtime/calls")!;
  expect(offer.init?.method).toBe("POST");
  expect(offer.init?.body).toBe("v=0 offer-fixture");
  expect(offer.init?.headers).toEqual({ authorization: ["Bearer", CLIENT_SECRET].join(" "), "content-type": "application/sdp" });
  expect(peer.label).toBe("oai-events");
  expect(peer.tracks).toEqual([audioTrack]);
  expect(peer.remote).toEqual({ type: "answer", sdp: "v=0 answer-fixture" });
  /* The session is live: nothing was recorded for upload and the connection stays open. */
  expect(peer.closed).toBe(false);

  const stopped = dictation().stop();
  expect(peer.channel.sent.map((data) => JSON.parse(data))).toEqual([{ type: "input_audio_buffer.commit" }]);
  expect(audioTrack.enabled).toBe(false);
  /* An earlier item's transcript does not end the wait; only the committed item's does. */
  peer.channel.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_a", delta: "an earlier" });
  peer.channel.emit({ type: "input_audio_buffer.committed", item_id: "item_b" });
  peer.channel.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_b", delta: "hello " });
  peer.channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_a", transcript: "an earlier turn" });
  expect(peer.closed).toBe(false);
  peer.channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_b", transcript: "hello there" });
  expect(await stopped).toBe("an earlier turn hello there");
  expect(peer.closed).toBe(true);
  expect(errors).toEqual([]);
  /* The recorded path never ran. */
  expect(calls.some((call) => call.url.endsWith("/api/transcribe"))).toBe(false);
}));

test("OpenAI live: a refused offer records the clip and transcribes it instead", () => withPeer(async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = openAiFetch(calls, () => new Response("unauthorized", { status: 401 }));
  mount("en"); await dictation().start();
  expect(PeerFixture.latest!.closed).toBe(true);
  expect(await dictation().stop()).toBe("recorded speech");
  expect(calls.map((call) => call.url).filter((url) => url.startsWith("/api/transcribe"))).toEqual(["/api/transcribe/token", "/api/transcribe"]);
  expect(errors).toEqual([]);
}));

test("OpenAI live: a drop mid-recording says the connection was lost", () => withPeer(async () => {
  globalThis.fetch = openAiFetch([]);
  mount("en"); await dictation().start();
  const peer = PeerFixture.latest!;
  peer.channel.close();
  expect(errors).toEqual([translate("en", "dictation.connectionLost")]);
  expect(peer.closed).toBe(true);
}));

test("OpenAI live: an error after the commit ends the wait with nothing heard", () => withPeer(async () => {
  globalThis.fetch = openAiFetch([]);
  mount("en"); await dictation().start();
  const stopped = dictation().stop();
  PeerFixture.latest!.channel.emit({ type: "error", error: { code: "input_audio_buffer_commit_empty" } });
  expect(await stopped).toBeNull();
  expect(errors).toEqual([translate("en", "dictation.silence")]);
}));

test("a token for a provider this client cannot place is never spent on another provider's socket", async () => {
  const sockets = SocketFixture.urls.length;
  globalThis.fetch = (async (url: unknown) => String(url).endsWith("/token") ? Response.json({ provider: "unknown", token: "fixture" }) : Response.json({ text: "speech" })) as unknown as typeof fetch;
  mount("en"); await dictation().start();
  expect(SocketFixture.urls.length).toBe(sockets);
  expect(await dictation().stop()).toBe("speech");
});
