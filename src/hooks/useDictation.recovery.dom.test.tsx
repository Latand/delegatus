import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { dictationTraceSchema } from "@/lib/transcribe/dictationTraceStore";
import { invalidateLiveToken, useDictation, type UseDictationResult } from "./useDictation";

const dom = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalNow = Date.now;
let now = 1_800_000_000_000;
let nextTimer = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const originalWindowTimeout = dom.setTimeout.bind(dom);
const originalWindowClear = dom.clearTimeout.bind(dom);
dom.setTimeout = ((run: () => void, ms = 0) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id; }) as unknown as typeof dom.setTimeout;
dom.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof dom.clearTimeout;
Date.now = () => now;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) break;
    now = entry[1].at; timers.delete(entry[0]); entry[1].run(); await tick();
  }
  now = end; await tick();
}
const track = { enabled: true, stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const mediaDevices = { getUserMedia: async () => stream };
Object.defineProperty(dom.navigator, "mediaDevices", { value: mediaDevices });
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
  drop() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "untrusted reason" })); }
}
const uploads: File[] = [];
const traces: Record<string, unknown>[] = [];
let tokenAnswer: () => Promise<Response> = async () => Response.json({ provider: "soniox", token: "fixture" });
let batchAnswer: () => Response = () => Response.json({ text: "recovered tail" });
const fakeFetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).endsWith("/diagnostics")) { traces.push(dictationTraceSchema.parse(JSON.parse(String(init?.body)))); return new Response(null, { status: 204 }); }
  if (String(url).endsWith("/token")) return tokenAnswer();
  if (String(url).endsWith("/backend")) return Response.json({ backend: "soniox" });
  if (String(url).endsWith("/transcribe")) { uploads.push((init!.body as FormData).get("file") as File); return batchAnswer(); }
  throw new Error("Unexpected fixture request");
}) as typeof fetch;
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, AudioContext: AudioFixture, WebSocket: Socket, fetch: fakeFetch })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let root: Root | undefined;
let current: UseDictationResult;
const commits: string[] = []; const unclaimed: string[] = []; const errors: string[] = [];
function Harness() { const result = useDictation({ onError: e => errors.push(e), onLiveCommit: text => commits.push(text), onUnclaimedText: text => unclaimed.push(text) }); useLayoutEffect(() => { current = result; }); return null; }
function mount() {
  invalidateLiveToken(); AudioFixture.processors = []; Socket.latest = undefined; uploads.length = traces.length = commits.length = unclaimed.length = errors.length = 0;
  tokenAnswer = async () => Response.json({ provider: "soniox", token: "fixture" }); batchAnswer = () => Response.json({ text: "recovered tail" });
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host as unknown as HTMLElement); flushSync(() => root!.render(<Harness />));
}
function audio(samples = 1600, value = 0.25) {
  const p = AudioFixture.processors.at(-1); expect(p).toBeDefined();
  p!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(value) } });
}
function segment(text: string, start: number, end: number) { return { tokens: [{ text, start_ms: start, end_ms: end, is_final: true }, { text: "<end>", is_final: true }] }; }
afterEach(() => { flushSync(() => root?.unmount()); root = undefined; timers.clear(); dom.document.body.replaceChildren(); });
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 20)); Date.now = originalNow; dom.setTimeout = originalWindowTimeout; dom.clearTimeout = originalWindowClear; for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); } });

test("acceptance 1: Stop drains delayed finals through finished, exactly once", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio();
  let settled = false; const stopped = current.stop().then(text => { settled = true; return text; }); await tick();
  expect(ws.readyState).toBe(Socket.OPEN); expect(settled).toBe(false); expect(ws.sent.at(-1)).toBe("");
  await advance(500); const final = segment("last words", 0, 100); ws.emit(final); ws.emit(final);
  expect(commits).toEqual(["last words"]); expect(settled).toBe(false);
  ws.emit({ finished: true }); expect(await stopped).toBe(""); expect(ws.readyState).toBe(3); expect(errors).toEqual([]);
});

test("acceptance 2: close uploads only audio after the committed boundary", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("kept draft", 0, 100)); ws.drop(); await tick();
  expect(commits).toEqual(["kept draft"]); expect(uploads).toHaveLength(0);
  audio(1600, 0.5); const stopped = current.stop(); await tick();
  expect(await stopped).toBe("recovered tail"); expect(uploads).toHaveLength(1);
  const wav = await uploads[0].arrayBuffer(); expect(wav.byteLength).toBe(44 + 3200 * 2);
  expect(new Int16Array(wav, 44).at(-1)).toBe(16383);
  expect(unclaimed).toEqual([]);
});

test.each([5000, 20000])("acceptance 3: capture flows during a %i ms token delay", async delay => {
  mount(); let resolve!: (r: Response) => void; tokenAnswer = () => new Promise(r => { resolve = r; });
  const started = current.start(); await tick();
  try {
    for (let elapsed = 0; elapsed < delay; elapsed += 100) { audio(1600, 0.25); await advance(100); }
    audio(1600, 0.5);
  } finally { resolve(Response.json({ provider: "soniox", token: "fixture" })); }
  await started; await tick();
  if (Socket.latest) {
    Socket.latest.open();
    const pcm = Socket.latest.sent.filter((v): v is ArrayBuffer => v instanceof ArrayBuffer);
    expect(pcm.reduce((n, v) => n + v.byteLength, 0)).toBe((delay * 16 + 1600) * 2);
    expect(new Int16Array(pcm[0])[0]).toBe(8191);
    expect(new Int16Array(pcm.at(-1)!)[0]).toBe(16383);
    const stopped = current.stop(); Socket.latest.emit({ finished: true }); await stopped; }
  else { expect(await current.stop()).toBe("recovered tail"); expect(uploads[0].size).toBe(44 + (delay * 16 + 1600) * 2); }
  if (delay === 20000) expect(Socket.latest).toBeUndefined();
});

test("acceptance 4: replayed finals commit once; identical later speech survives", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(6400);
  const first = segment("again again", 0, 100); ws.emit(first); ws.emit(first); ws.emit(segment("again again", 100, 200));
  expect(commits).toEqual(["again again", "again again"]);
  const stopped = current.stop(); ws.emit({ finished: true }); await stopped;
});


test("Stop deadline preserves commits, reports missing tail and blocks send", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("kept", 0, 100)); ws.emit({ tokens: [{ text: "unconfirmed", is_final: false }] });
  const stopped = current.stop(); await advance(8000);
  expect(await stopped).toBeNull(); expect(commits).toEqual(["kept"]); expect(errors).toHaveLength(1);
  expect(traces.at(-1)).toMatchObject({ drainOutcome: "deadline", outcome: "incomplete", commits: 1 });
  ws.emit(segment("late", 100, 200)); ws.emit({ finished: true }); expect(commits).toEqual(["kept"]);
});

test("connect deadline batches first and last samples and ignores a late open", async () => {
  mount(); await current.start(); const ws = Socket.latest!; audio(1600); await advance(10000);
  expect(uploads).toHaveLength(0); audio(1600, 0.5);
  expect(await current.stop()).toBe("recovered tail");
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44 + 6400);
  ws.open(); expect(ws.sent).toEqual([]);
  expect(traces.at(-1)).toMatchObject({ connectOutcome: "deadline", batchOutcome: "ok" });
});

test("a long session stops at the bounded buffer and recovers without eviction", async () => {
  mount(); await current.start(); Socket.latest!.open();
  for (let i = 0; i < 120; i++) audio(16000);
  audio(16000); await tick();
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44 + 1920000 * 2);
  expect(unclaimed).toEqual(["recovered tail"]); expect(errors).toHaveLength(1);
  expect(traces.at(-1)).toMatchObject({ capturedSamples: 1920000, peakBufferedSamples: 1920000, outcome: "buffer-limit" });
});

test.each(["error", "close"])("%s plus close causes one recovery, even while Stop waits", async kind => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("kept", 0, 100)); const stopped = current.stop();
  if (kind === "error") ws.dispatchEvent(new Event("error"));
  ws.drop(); await tick(); expect(await stopped).toBe("recovered tail"); expect(uploads).toHaveLength(1); expect(commits).toEqual(["kept"]);
});

test("failed recovery preserves the committed draft and reports an incomplete tail", async () => {
  mount(); batchAnswer = () => new Response(null, { status: 503 }); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("kept", 0, 100)); ws.drop(); await tick();
  expect(await current.stop()).toBeNull();
  expect(commits).toEqual(["kept"]); expect(errors).toHaveLength(1); expect(unclaimed).toEqual([]);
  expect(traces.at(-1)).toMatchObject({ batchOutcome: "error", outcome: "incomplete" });
});

test("discard after the batch fetch await never inserts its late result", async () => {
  mount(); let resolve!: (r: Response) => void;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url).endsWith("/transcribe") ? new Promise<Response>(r => { resolve = r; }) : oldFetch(url as string, init)) as typeof fetch;
  try {
    await current.start(); Socket.latest!.open(); audio(); const stopped = current.stop(); Socket.latest!.drop(); await tick();
    current.discard(); resolve(Response.json({ text: "late batch" })); await tick();
    expect(await stopped).toBeNull(); expect(commits).toEqual([]); expect(unclaimed).toEqual([]); expect(errors).toEqual([]);
  } finally { globalThis.fetch = oldFetch; }
});

test("Stop during token wait batches captured audio and a late token cannot open a socket", async () => {
  mount(); let resolve!: (r: Response) => void; tokenAnswer = () => new Promise(r => { resolve = r; });
  const starting = current.start(); await tick(); audio(); expect(await current.stop()).toBe("recovered tail");
  resolve(Response.json({ token: "fixture", provider: "soniox" })); await starting;
  expect(Socket.latest).toBeUndefined(); expect(uploads).toHaveLength(1);
});

test("finished flushes final tokens even without an endpoint", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio();
  const stopped = current.stop(); ws.emit({ tokens: [{ text: "tail", start_ms: 0, end_ms: 100, is_final: true }], finished: true });
  expect(await stopped).toBe(""); expect(commits).toEqual(["tail"]);
});


test("ambiguous pending finals recover from audio without comparing words", async () => {
  mount(); batchAnswer = () => Response.json({ text: "first" }); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  const tokens = { tokens: [{ text: "first", start_ms: 0, end_ms: 100, is_final: true }] };
  ws.emit(tokens); ws.emit(tokens); ws.emit({ tokens: [{ text: "<end>", is_final: true }] });
  expect(commits).toEqual([]); expect(await current.stop()).toBe("first"); expect(uploads).toHaveLength(1);
});

test("the batch deadline ends Stop explicitly and ignores a later response", async () => {
  mount(); let resolve!: (r: Response) => void; const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url).endsWith("/transcribe") ? new Promise<Response>(r => { resolve = r; }) : oldFetch(url as string, init)) as typeof fetch;
  try {
    tokenAnswer = async () => new Response(null, { status: 409 });
    await current.start(); audio(); const stopped = current.stop(); await tick();
    await advance(120000); expect(await stopped).toBeNull(); expect(errors).toHaveLength(1);
    expect(traces.at(-1)).toMatchObject({ batchOutcome: "deadline", outcome: "incomplete" });
    resolve(Response.json({ text: "late tail" })); await tick(); expect(unclaimed).toEqual([]);
  } finally { globalThis.fetch = oldFetch; }
});

test("discard after the response body await ignores the late decoded transcript", async () => {
  mount(); let resolve!: (value: unknown) => void;
  batchAnswer = () => { const response = Response.json({}); response.json = () => new Promise(r => { resolve = r; }); return response; };
  await current.start(); Socket.latest!.open(); audio(); const stopped = current.stop(); Socket.latest!.drop(); await tick();
  current.discard(); resolve({ text: "late decoded tail" }); await tick();
  expect(await stopped).toBeNull(); expect(unclaimed).toEqual([]); expect(errors).toEqual([]);
});


test("a close during Stop shares its original eight-second deadline", async () => {
  mount(); let resolve!: (r: Response) => void; const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url).endsWith("/transcribe") ? new Promise<Response>(r => { resolve = r; }) : oldFetch(url as string, init)) as typeof fetch;
  try {
    await current.start(); Socket.latest!.open(); audio(); const stopped = current.stop(); await advance(7000);
    Socket.latest!.drop(); await tick(); await advance(1000);
    expect(await stopped).toBeNull(); expect(errors).toHaveLength(1);
    expect(traces.at(-1)).toMatchObject({ batchOutcome: "deadline", outcome: "incomplete" });
    resolve(Response.json({ text: "too late" })); await tick(); expect(unclaimed).toEqual([]);
  } finally { globalThis.fetch = oldFetch; }
});


test("a full buffer whose batch fails reports missing words and cannot claim recovery", async () => {
  mount(); batchAnswer = () => new Response(null, { status: 503 }); await current.start(); Socket.latest!.open();
  audio(1920000); await tick(); expect(unclaimed).toEqual([]); expect(errors).toHaveLength(1);
  expect(traces.at(-1)).toMatchObject({ batchOutcome: "error", outcome: "incomplete", peakBufferedSamples: 1920000 });
});


test("a socket error keeps capturing subsequent speech until Stop", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio();
  ws.dispatchEvent(new Event("error")); await tick(); expect(uploads).toHaveLength(0);
  audio(1600, 0.5); expect(await current.stop()).toBe("recovered tail");
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44 + 6400);
  expect(traces.at(-1)).toMatchObject({ path: "live-batch", capturedSamples: 3200, commits: 1 });
});

test("concurrent Stop callers consume a batch tail once", async () => {
  mount(); tokenAnswer = async () => new Response(null, { status: 409 }); await current.start(); audio();
  const first = current.stop(); const second = current.stop();
  expect(await Promise.all([first, second])).toEqual(["recovered tail", null]); expect(uploads).toHaveLength(1);
});


test("a new dictation can start after early Stop while the old token is still pending", async () => {
  mount(); let resolve!: (r: Response) => void; tokenAnswer = () => new Promise(r => { resolve = r; });
  const firstStart = current.start(); await tick(); audio(); expect(await current.stop()).toBe("recovered tail");
  tokenAnswer = async () => Response.json({ token: "fixture", provider: "soniox" });
  await current.start(); const secondSocket = Socket.latest!; expect(secondSocket).toBeDefined(); secondSocket.open(); audio();
  resolve(Response.json({ token: "fixture", provider: "soniox" })); await firstStart;
  expect(Socket.latest).toBe(secondSocket);
  const stopped = current.stop(); secondSocket.emit(segment("new dictation", 0, 100)); secondSocket.emit({ finished: true });
  expect(await stopped).toBe(""); expect(commits).toEqual(["new dictation"]);
});


test("a final without timestamps falls back before inserting or acknowledging that segment", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(6400);
  ws.emit(segment("kept", 0, 100)); ws.emit({ tokens: [{ text: "untimed", is_final: true }, { text: "<end>", is_final: true }] });
  expect(commits).toEqual(["kept"]); audio(1600, 0.5);
  expect(await current.stop()).toBe("recovered tail"); expect(uploads[0].size).toBe(44 + 6400 * 2);
  expect(commits).toEqual(["kept"]);
});


test("distinct subwords sharing a timestamp range are recovered without dropping letters", async () => {
  mount(); batchAnswer = () => Response.json({ text: "Hello" }); await current.start(); const ws = Socket.latest!; ws.open(); audio();
  ws.emit({ tokens: [
    { text: "Hel", start_ms: 0, end_ms: 100, is_final: true },
    { text: "lo", start_ms: 0, end_ms: 100, is_final: true }, { text: "<end>", is_final: true },
  ] });
  expect(commits).toEqual([]); expect(await current.stop()).toBe("Hello"); expect(uploads[0].size).toBe(44 + 3200);
});

test.each([false, true])("a replayed standalone endpoint recovers the whole next word (close=%s)", async close => {
  mount(); batchAnswer = () => Response.json({ text: "Hello" });
  await current.start(); const ws = Socket.latest!; ws.open(); audio(6400);
  const endpoint = { tokens: [{ text: "<end>", is_final: true }] };
  ws.emit({ tokens: [{ text: "first", start_ms: 0, end_ms: 100, is_final: true }] }); ws.emit(endpoint);
  ws.emit({ tokens: [{ text: "Hel", start_ms: 100, end_ms: 200, is_final: true }] }); ws.emit(endpoint);
  expect(commits).toEqual(["first"]);
  if (close) ws.drop();
  ws.emit({ tokens: [{ text: "lo", start_ms: 200, end_ms: 300, is_final: true }, { text: "<end>", is_final: true }] });
  const stopped = current.stop(); ws.emit({ finished: true });
  expect([...commits, await stopped].join(" ")).toBe("first Hello");
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44 + 4800 * 2);
  expect(traces.at(-1)).toMatchObject({ capturedSamples: 6400, bufferedSamples: 4800, commits: 2, batchOutcome: "ok" });
});

test.each(["elevenlabs", "openai"])("early PCM stays owned through a delayed %s token", async provider => {
  mount(); let resolve!: (r: Response) => void; tokenAnswer = () => new Promise(r => { resolve = r; });
  const started = current.start(); await tick(); audio(1600); await advance(5000);
  resolve(Response.json({ provider, token: "fixture" })); await started;
  Socket.latest?.open(); audio(1600, 0.5);
  expect(await current.stop()).toBe("recovered tail"); expect(uploads).toHaveLength(1);
  const pcm = new Int16Array(await uploads[0].arrayBuffer(), 44);
  expect(pcm.length).toBe(3200); expect(pcm[0]).toBe(8191); expect(pcm.at(-1)).toBe(16383);
  expect(commits).toEqual([]); expect(Socket.latest).toBeUndefined();
  expect(traces.at(-1)).toMatchObject({ path: "batch", capturedSamples: 3200, commits: 1, outcome: "complete" });
});

test("an abort-aware token fetch records its native timeout as a deadline", async () => {
  mount(); const oldTimeout = AbortSignal.timeout; const oldFetch = globalThis.fetch;
  AbortSignal.timeout = ((ms: number) => {
    const controller = new AbortController();
    dom.setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/token")) return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    return oldFetch(url as string, init);
  }) as typeof fetch;
  try {
    const started = current.start(); await tick(); audio(); await advance(10000); await started;
    expect(await current.stop()).toBe("recovered tail");
    expect(traces.at(-1)).toMatchObject({ tokenMs: 10000, tokenOutcome: "deadline", batchOutcome: "ok" });
  } finally { AbortSignal.timeout = oldTimeout; globalThis.fetch = oldFetch; }
});

test.each(["http", "network"])("a token %s refusal remains unavailable and preserves capture", async kind => {
  mount(); tokenAnswer = async () => {
    if (kind === "network") throw new TypeError("fixture network failure");
    return new Response(null, { status: 503 });
  };
  await current.start(); audio();
  expect(await current.stop()).toBe("recovered tail");
  expect(traces.at(-1)).toMatchObject({ tokenOutcome: "unavailable", batchOutcome: "ok" });
});

test("untimed final overflow recovers PCM while retaining the committed draft", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("kept", 0, 100));
  ws.emit({ tokens: Array.from({ length: 100000 }, () => ({ text: "x", is_final: true })) });
  audio(1600, 0.5);
  const stopped = current.stop(); ws.emit({ finished: true });
  expect(await stopped).toBe("recovered tail"); expect(commits).toEqual(["kept"]);
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44 + 6400);
});


class ReviewChannel extends EventTarget {
  closed = false;
  send(_data: string) {}
  close() { this.closed = true; this.dispatchEvent(new Event("close")); }
}
class ReviewPeer extends EventTarget {
  static all: ReviewPeer[] = [];
  static barrier = async (_peer: ReviewPeer, _step: string) => {};
  channel = new ReviewChannel();
  connectionState = "new";
  closed = false;
  constructor() { super(); ReviewPeer.all.push(this); }
  createDataChannel(_label: string) { return this.channel; }
  addTrack(_track: unknown, _stream: unknown) {}
  async createOffer() { await ReviewPeer.barrier(this, "offer-created"); return { type: "offer", sdp: "v=0 review-offer" }; }
  async setLocalDescription(_value: unknown) { await ReviewPeer.barrier(this, "local-description"); }
  async setRemoteDescription(_value: unknown) {
    await ReviewPeer.barrier(this, "remote-description");
    this.connectionState = "connected";
    await ReviewPeer.barrier(this, "channel-open");
    queueMicrotask(() => this.channel.dispatchEvent(new Event("open")));
  }
  close() { this.closed = true; }
}
test("review: a retired OpenAI offer cannot close the next dictation socket", async () => {
  mount();
  const peerBefore = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: ReviewPeer });
  Object.assign(stream, { getAudioTracks: () => [track] });
  const previousFetch = globalThis.fetch;
  let answer!: (response: Response) => void;
  let offered!: () => void;
  const atOffer = new Promise<void>(resolve => { offered = resolve; });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "https://api.openai.com/v1/realtime/calls") {
      offered(); return new Promise<Response>(resolve => { answer = resolve; });
    }
    return previousFetch(url as string, init);
  }) as typeof fetch;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    const firstStart = current.start(); await atOffer; audio();
    expect(await current.stop()).toBe("recovered tail");
    tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
    await current.start(); const secondSocket = Socket.latest!; secondSocket.open();
    expect(secondSocket.readyState).toBe(Socket.OPEN);
    answer(new Response("v=0 review-answer")); await firstStart;
    secondSocket.emit({ message_type: "committed_transcript", text: "new words" });
    expect({ state: secondSocket.readyState, commits }).toEqual({ state: Socket.OPEN, commits: ["new words"] });
  } finally {
    current.discard(); globalThis.fetch = previousFetch;
    if (peerBefore) Object.defineProperty(globalThis, "RTCPeerConnection", peerBefore); else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  }
});

test("review: a retired OpenAI offer cannot orphan the next OpenAI recording", async () => {
  mount();
  const peerBefore = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: ReviewPeer });
  Object.assign(stream, { getAudioTracks: () => [track] });
  const previousFetch = globalThis.fetch;
  let answer!: (response: Response) => void;
  let offered!: () => void;
  let calls = 0;
  const atOffer = new Promise<void>(resolve => { offered = resolve; });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "https://api.openai.com/v1/realtime/calls") {
      if (++calls === 1) { offered(); return new Promise<Response>(resolve => { answer = resolve; }); }
      return new Response("v=0 second-answer");
    }
    return previousFetch(url as string, init);
  }) as typeof fetch;
  let secondPeer: ReviewPeer | undefined;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    const firstStart = current.start(); await atOffer; audio();
    expect(await current.stop()).toBe("recovered tail");
    await current.start(); secondPeer = ReviewPeer.all.at(-1)!;
    expect(secondPeer.closed).toBe(false);
    answer(new Response("v=0 first-answer")); await firstStart;
    const stopped = current.stop();
    secondPeer.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "new words" }) }));
    expect({ result: await stopped, closed: secondPeer.closed }).toEqual({ result: "new words", closed: true });
  } finally {
    current.discard(); secondPeer?.close(); globalThis.fetch = previousFetch;
    if (peerBefore) Object.defineProperty(globalThis, "RTCPeerConnection", peerBefore); else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  }
});

test("review: successful ElevenLabs live reports its actual audio and commit counters", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!; ws.open(); audio();
  ws.emit({ message_type: "committed_transcript", text: "recognized words" });
  expect(commits).toEqual(["recognized words"]);
  expect(await current.stop()).toBe("");
  expect(traces.at(-1)).toMatchObject({ provider: "elevenlabs", path: "live", outcome: "complete", connectOutcome: "ok", capturedSamples: 1600, sentSamples: 1600, commits: 1, finalSegments: 1 });
});


test("review: Stop twice and a start during drain do not replace the old owner", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  const first = current.stop(); const second = current.stop();
  await current.start(); expect(Socket.latest).toBe(ws);
  ws.emit(segment("old final", 0, 100)); ws.emit({ finished: true });
  expect(await Promise.all([first, second])).toEqual(["", null]); expect(commits).toEqual(["old final"]);
  await current.start(); expect(Socket.latest).not.toBe(ws);
  const next = Socket.latest!; next.open(); audio();
  ws.emit(segment("stale", 100, 200)); next.emit(segment("next", 0, 100));
  const third = current.stop(); next.emit({ finished: true }); expect(await third).toBe("");
  expect(commits).toEqual(["old final", "next"]);
});

test("review: close while CONNECTING retains first and last PCM", async () => {
  mount(); await current.start(); const ws = Socket.latest!; audio(); ws.drop(); audio(1600,0.5);
  expect(await current.stop()).toBe("recovered tail"); expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44+6400);
  ws.open(); expect(ws.sent).toEqual([]);
});

test("review: close between partial and final excludes already acknowledged PCM", async () => {
  mount(); await current.start(); const ws = Socket.latest!; ws.open(); audio(3200);
  ws.emit(segment("opening",0,100)); ws.emit({tokens:[{text:"tail",is_final:false}]}); ws.drop();
  const sentBeforeReopen = ws.sent.length; ws.open();
  ws.emit(segment("late live tail",100,200)); audio(1600,0.5);
  expect(ws.sent.length).toBe(sentBeforeReopen);
  expect(await current.stop()).toBe("recovered tail"); expect(commits).toEqual(["opening"]);
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44+6400);
  expect(Socket.latest).toBe(ws);
});

test("review: never answering token has a deadline while capture continues", async () => {
  mount(); tokenAnswer = () => new Promise(() => undefined);
  const started=current.start(); await tick(); audio(); await advance(10000); await started;
  audio(1600,0.5); expect(Socket.latest).toBeUndefined(); expect(await current.stop()).toBe("recovered tail");
  expect(uploads[0].size).toBe(44+6400); expect(traces.at(-1)).toMatchObject({tokenOutcome:"deadline",outcome:"complete"});
});

test("review: socket backpressure preserves bounded PCM for one batch", async () => {
  mount(); await current.start(); const ws=Socket.latest!; ws.open(); ws.bufferedAmount=300000; audio(3200);
  audio(1600,0.5); expect(await current.stop()).toBe("recovered tail");
  expect(uploads).toHaveLength(1); expect(uploads[0].size).toBe(44+9600);
  expect(ws.sent.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
});




async function withReviewPeer(run: () => Promise<void>) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: ReviewPeer });
  ReviewPeer.all = []; track.enabled = true;
  try { await run(); } finally {
    current.discard(); ReviewPeer.barrier = async () => {};
    if (before) Object.defineProperty(globalThis, "RTCPeerConnection", before); else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  }
}
function completed(peer: ReviewPeer, text = "new words") {
  peer.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: text,
  }) }));
}

test.each(["close", "error"])("ElevenLabs %s checkpoints preserve live audio and commits", async kind => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!;
  audio(); await advance(200); ws.open(); audio();
  ws.emit({ message_type: "committed_transcript", text: "kept" });
  if (kind === "close") ws.drop(); else ws.dispatchEvent(new Event("error"));
  expect(commits).toEqual(["kept"]); expect(errors).toHaveLength(1);
  expect(traces.at(-1)).toMatchObject({ provider: "elevenlabs", capturedSamples: 3200, sentSamples: 3200,
    bufferedSamples: 0, peakBufferedSamples: 1600, finalSegments: 1, commits: 1, connectMs: 200,
    connectOutcome: "ok", closeCode: kind === "close" ? 1006 : null,
    closeReason: kind === "close" ? "abnormal" : "error", outcome: "incomplete" });
  const snapshot = traces.at(-1); audio(); ws.emit({ message_type: "committed_transcript", text: "late" });
  expect(traces.at(-1)).toEqual(snapshot); expect(commits).toEqual(["kept"]);
});

test("ElevenLabs connect deadline is explicit and retires late socket callbacks", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!; audio(); await advance(10000);
  expect(traces.at(-1)).toMatchObject({ connectOutcome: "deadline", connectMs: 10000, outcome: "incomplete", capturedSamples: 1600, sentSamples: 0 });
  expect(errors).toHaveLength(1); ws.open(); expect(ws.sent).toEqual([]);
});

test.each(["complete", "drop", "deadline"])("OpenAI handoff retains capture and final counters through %s", mode => withReviewPeer(async () => {
  mount(); const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url) === "https://api.openai.com/v1/realtime/calls"
    ? new Response("v=0 answer") : previousFetch(url as string, init)) as typeof fetch;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    await current.start(); const peer = ReviewPeer.all.at(-1)!; audio();
    // A completed item is counted once even if the provider repeats its frame.
    completed(peer); completed(peer);
    let result: string | null = null;
    if (mode === "drop") peer.channel.close();
    else { const stopped = current.stop(); if (mode === "complete") completed(peer); else await advance(10000); result = await stopped; }
    expect(result).toBe(mode === "complete" ? "new words" : null);
    expect(traces.at(-1)).toMatchObject({ provider: "openai", capturedSamples: 1600, sentSamples: 1600,
      finalSegments: 1, commits: 1, connectOutcome: "ok", connectMs: 0,
      drainOutcome: mode === "complete" ? "ok" : mode === "drop" ? "unused" : "deadline",
      outcome: mode === "complete" ? "complete" : "incomplete" });
    expect(peer.closed).toBe(true); expect(peer.channel.closed).toBe(true);
    const snapshot = traces.at(-1); audio(); completed(peer); expect(traces.at(-1)).toEqual(snapshot);
  } finally { globalThis.fetch = previousFetch; }
}));

test.each(["offer-created", "local-description", "offer-response", "answer-body", "remote-description", "channel-open"])(
  "retiring an OpenAI start at %s preserves the next peer and its own tracks", seam => withReviewPeer(async () => {
    mount();
    const previousFetch = globalThis.fetch; const previousMic = mediaDevices.getUserMedia;
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    let entered!: () => void; const atBarrier = new Promise<void>(r => { entered = r; });
    const pause = async (step: string) => { if (step === seam) { entered(); await held; } };
    const tracks = [0, 1].map(() => ({ enabled: true, stops: 0, stop() { this.stops++; } }));
    let mic = 0; let offers = 0;
    mediaDevices.getUserMedia = (async () => { const t = tracks[mic++]; return { getTracks: () => [t], getAudioTracks: () => [t] }; }) as unknown as typeof previousMic;
    ReviewPeer.barrier = (peer, step) => peer === ReviewPeer.all[0] ? pause(step) : Promise.resolve();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url) !== "https://api.openai.com/v1/realtime/calls") return previousFetch(url as string, init);
      if (++offers > 1) return new Response("v=0 next answer");
      await pause("offer-response");
      const response = new Response("v=0 old answer");
      response.text = async () => { await pause("answer-body"); return "v=0 old answer"; };
      return response;
    }) as typeof fetch;
    try {
      tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
      const first = current.start(); await atBarrier; const oldPeer = ReviewPeer.all[0]; audio();
      expect(await current.stop()).toBe("recovered tail"); expect(tracks[0].stops).toBe(1);
      await current.start(); const next = ReviewPeer.all[1];
      expect(oldPeer.closed).toBe(true); expect(next.closed).toBe(false); expect(tracks[1].stops).toBe(0);
      release(); await first; await tick();
      expect(next.closed).toBe(false); expect(tracks[1].stops).toBe(0);
      const stopped = current.stop(); completed(next); completed(next);
      expect(await stopped).toBe("new words"); expect(next.closed).toBe(true); expect(next.channel.closed).toBe(true);
      expect(tracks[1].stops).toBe(1); expect(unclaimed).toEqual([]);
    } finally { release(); globalThis.fetch = previousFetch; mediaDevices.getUserMedia = previousMic; }
  }),
);


test("ElevenLabs queue overflow records its bound and stops explicitly", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!; audio(1920000); audio();
  expect(traces.at(-1)).toMatchObject({ capturedSamples: 1921600, bufferedSamples: 1920000,
    peakBufferedSamples: 1920000, sentSamples: 0, outcome: "incomplete" });
  expect(errors).toHaveLength(1); expect(ws.readyState).toBe(3);
});

test("ElevenLabs failed send counts captured samples without claiming they were sent", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!; ws.open(); ws.send = () => { throw new Error("fixture send failed"); }; audio();
  expect(traces.at(-1)).toMatchObject({ capturedSamples: 1600, sentSamples: 0, closeReason: "error", outcome: "incomplete" });
  expect(errors).toHaveLength(1);
});

test.each(["refused", "deadline"])("OpenAI %s connection checkpoints survive batch recovery", mode => withReviewPeer(async () => {
  mount(); const previousFetch = globalThis.fetch; let release!: (r: Response) => void;
  let entered!: () => void; const offered = new Promise<void>(r => { entered = r; });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) !== "https://api.openai.com/v1/realtime/calls") return previousFetch(url as string, init);
    entered(); return mode === "refused" ? new Response(null, { status: 503 }) : new Promise<Response>(r => { release = r; });
  }) as typeof fetch;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    const started = current.start(); await offered; audio();
    if (mode === "deadline") await advance(10000);
    await started; expect(await current.stop()).toBe("recovered tail");
    expect(traces.at(-1)).toMatchObject({ capturedSamples: 1600, sentSamples: 0, commits: 1,
      connectOutcome: mode === "deadline" ? "deadline" : "error", connectMs: mode === "deadline" ? 10000 : 0,
      batchOutcome: "ok", outcome: "complete" });
    if (release) { release(new Response("v=0 late answer")); await tick(); }
    expect(ReviewPeer.all[0].closed).toBe(true);
  } finally { globalThis.fetch = previousFetch; }
}));

test("OpenAI unmount stops only its owned peer, microphone and sample observer", () => withReviewPeer(async () => {
  mount(); const previousFetch = globalThis.fetch; const previousMic = mediaDevices.getUserMedia;
  const owned = { enabled: true, stops: 0, stop() { this.stops++; } };
  mediaDevices.getUserMedia = (async () => ({ getTracks: () => [owned], getAudioTracks: () => [owned] })) as unknown as typeof previousMic;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url) === "https://api.openai.com/v1/realtime/calls"
    ? new Response("v=0 answer") : previousFetch(url as string, init)) as typeof fetch;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    await current.start(); audio(); const peer = ReviewPeer.all[0];
    flushSync(() => root!.unmount()); root = undefined;
    expect(peer.closed).toBe(true); expect(peer.channel.closed).toBe(true); expect(owned.stops).toBe(1);
    expect(traces.at(-1)).toMatchObject({ capturedSamples: 1600, sentSamples: 1600, outcome: "discarded" });
    const snapshot = traces.at(-1); audio(); completed(peer); expect(traces.at(-1)).toEqual(snapshot);
  } finally { globalThis.fetch = previousFetch; mediaDevices.getUserMedia = previousMic; }
}));


test("ElevenLabs queue flushing counts only frames accepted before a failed send", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const ws = Socket.latest!; audio(); audio();
  const send = ws.send.bind(ws); let calls = 0;
  ws.send = data => { if (++calls === 2) throw new Error("fixture send failed"); send(data); };
  ws.open();
  expect(traces.at(-1)).toMatchObject({ capturedSamples: 3200, sentSamples: 1600, bufferedSamples: 1600,
    peakBufferedSamples: 3200, closeReason: "error", outcome: "incomplete" });
  expect(errors).toHaveLength(1);
});


test("a delayed ElevenLabs close records its own code while the next socket keeps recording", async () => {
  mount(); tokenAnswer = async () => Response.json({ provider: "elevenlabs", token: "fixture" });
  await current.start(); const old = Socket.latest!; old.open(); audio();
  expect(await current.stop()).toBe(""); const oldId = traces.at(-1)!.id;
  await current.start(); const next = Socket.latest!; next.open(); audio();
  old.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "untrusted reason" }));
  expect(traces.at(-1)).toMatchObject({ id: oldId, closeCode: 1000, closeReason: "normal", capturedSamples: 1600 });
  expect(next.readyState).toBe(Socket.OPEN); next.emit({ message_type: "committed_transcript", text: "next words" });
  expect(await current.stop()).toBe(""); expect(commits).toEqual(["next words"]);
  expect(traces.at(-1)!.id).not.toBe(oldId);
});


test.each([false, true])("OpenAI Stop retains one waiter and reports commit send errors (sendError=%s)", sendError => withReviewPeer(async () => {
  mount(); const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => String(url) === "https://api.openai.com/v1/realtime/calls"
    ? new Response("v=0 answer") : previousFetch(url as string, init)) as typeof fetch;
  try {
    tokenAnswer = async () => Response.json({ provider: "openai", token: "fixture" });
    await current.start(); const peer = ReviewPeer.all[0]; audio();
    if (sendError) peer.channel.send = () => { throw new Error("fixture send failed"); };
    const first = current.stop(); const second = current.stop();
    if (!sendError) completed(peer);
    expect(await Promise.all([first, second])).toEqual([sendError ? null : "new words", null]);
    expect(errors).toHaveLength(sendError ? 1 : 0);
    expect(traces.at(-1)).toMatchObject({ drainOutcome: sendError ? "error" : "ok", outcome: sendError ? "incomplete" : "complete" });
  } finally { globalThis.fetch = previousFetch; }
}));
