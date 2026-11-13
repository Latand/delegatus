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
const track = { stop() {} };
const stream = { getTracks: () => [track] };
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
