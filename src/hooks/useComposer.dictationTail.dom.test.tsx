import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer, type UseComposerReturn } from "@/hooks/useComposer";
import { invalidateLiveToken } from "@/hooks/useDictation";
import { en } from "@/lib/i18n/en";

/*
 * An incomplete stop always leaves a visible missing-tail warning.
 *
 * Every case drives the real `useComposer` over fake transports (a fake
 * peer connection for OpenAI, a fake socket for Soniox) and reads the composer's
 * own `status` after the received text has been inserted: inserting text clears
 * the status, so a warning raised before the insert is lost.
 */

const dom = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let now = 1_800_000_000_000;
let nextTimer = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const originalWindowTimeout = dom.setTimeout.bind(dom);
const originalWindowClear = dom.clearTimeout.bind(dom);
dom.setTimeout = ((run: () => void, ms = 0) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id; }) as unknown as typeof dom.setTimeout;
dom.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof dom.clearTimeout;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});
Date.now = () => now;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/* React commits state through its own scheduler; a real timer lets it drain. */
const settleReact = () => new Promise<void>((resolve) => realSetTimeout(resolve, 20));
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) break;
    now = entry[1].at; timers.delete(entry[0]); entry[1].run(); await tick();
  }
  now = end; await tick(); await settleReact();
}

const track = { enabled: true, stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
Object.defineProperty(dom.navigator, "mediaDevices", { value: { getUserMedia: async () => stream } });
class AudioFixture {
  static processors: Array<{ onaudioprocess: ((e: unknown) => void) | null; connect(): void; disconnect(): void }> = [];
  sampleRate = 16000; destination = {};
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { const p = { onaudioprocess: null, connect() {}, disconnect() {} }; AudioFixture.processors.push(p); return p; }
  createAnalyser() { return { frequencyBinCount: 64, getByteFrequencyData() {} }; }
  async close() {}
}
class Socket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1;
  static latest: Socket | undefined;
  readyState = 0; bufferedAmount = 0; sent: Array<string | ArrayBuffer> = [];
  constructor() { super(); Socket.latest = this; }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
class FakeChannel extends EventTarget {
  send() {}
  close() { this.dispatchEvent(new Event("close")); }
}
class FakePeer extends EventTarget {
  static all: FakePeer[] = [];
  channel = new FakeChannel();
  connectionState = "new";
  constructor() { super(); FakePeer.all.push(this); }
  createDataChannel() { return this.channel; }
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.connectionState = "connected";
    queueMicrotask(() => this.channel.dispatchEvent(new Event("open")));
  }
  close() {}
}
let provider = "openai";
const fakeFetch = (async (url: unknown) => {
  const target = String(url);
  if (target.endsWith("/diagnostics")) return new Response(null, { status: 204 });
  if (target.endsWith("/token")) return Response.json({ provider, token: "fixture" });
  if (target.endsWith("/backend")) return Response.json({ backend: provider });
  if (target === "https://api.openai.com/v1/realtime/calls") return new Response("v=0 answer");
  throw new Error(`Unexpected fixture request ${target}`);
}) as typeof fetch;
for (const [key, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node,
  requestAnimationFrame: () => 1, cancelAnimationFrame() {}, AudioContext: AudioFixture, WebSocket: Socket,
  RTCPeerConnection: FakePeer, fetch: fakeFetch,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let root: Root | undefined;
let composer: UseComposerReturn;
function Harness() {
  const result = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {} });
  useLayoutEffect(() => { composer = result; });
  return null;
}
function mount(which: string) {
  provider = which;
  invalidateLiveToken(); AudioFixture.processors = []; Socket.latest = undefined; FakePeer.all = [];
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement); flushSync(() => root!.render(<Harness />));
}
function audio() {
  AudioFixture.processors.at(-1)!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.25) } });
}
function completed(peer: FakePeer, text: string) {
  peer.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: text,
  }) }));
}
const draft = () => composer.textRef.current;
/* The existing message in the active language; no new copy. */
const missingTail = () => ({ kind: "err" as const, text: en["dictation.tailMissing"] });

afterEach(() => { flushSync(() => root?.unmount()); root = undefined; timers.clear(); dom.document.body.replaceChildren(); });
afterAll(async () => {
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  Date.now = originalNow; dom.setTimeout = originalWindowTimeout; dom.clearTimeout = originalWindowClear;
  for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
});

test("OpenAI: Stop, then ten seconds without the final, keeps the draft and says the tail is missing", async () => {
  mount("openai");
  await composer.dictation.start(); await tick(); const peer = FakePeer.all.at(-1)!; audio();
  completed(peer, "received words");
  const stopped = composer.dictation.stop(); await tick();
  await advance(10000);
  expect(await stopped).toBeNull();
  expect(draft()).toBe("received words");
  expect(composer.status).toEqual(missingTail());
});

test("OpenAI: a close after Stop and before the final keeps the draft and says the tail is missing", async () => {
  mount("openai");
  await composer.dictation.start(); await tick(); const peer = FakePeer.all.at(-1)!; audio();
  completed(peer, "received words");
  const stopped = composer.dictation.stop(); await tick();
  peer.channel.close();
  expect(await stopped).toBeNull();
  await settleReact();
  expect(draft()).toBe("received words");
  expect(composer.status).toEqual(missingTail());
});

test("OpenAI: a close after Stop with nothing received still says the tail is missing", async () => {
  mount("openai");
  await composer.dictation.start(); await tick(); const peer = FakePeer.all.at(-1)!; audio();
  const stopped = composer.dictation.stop(); await tick();
  peer.channel.close();
  expect(await stopped).toBeNull();
  await settleReact();
  expect(draft()).toBe("");
  expect(composer.status).toEqual(missingTail());
});

test("Soniox control: the Stop deadline keeps the committed draft and says the tail is missing", async () => {
  mount("soniox");
  await composer.dictation.start(); await tick(); const ws = Socket.latest!; ws.open(); audio();
  ws.emit({ tokens: [{ text: "kept", start_ms: 0, end_ms: 100, is_final: true }, { text: "<end>", is_final: true }] });
  ws.emit({ tokens: [{ text: "unconfirmed", is_final: false }] });
  const stopped = composer.dictation.stop(); await tick();
  await advance(8000);
  expect(await stopped).toBeNull();
  expect(draft()).toBe("kept");
  expect(composer.status).toEqual(missingTail());
});
