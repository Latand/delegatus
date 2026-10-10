import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OfficialVoiceCompanionAdapter } from "./liveAdapter";
import { INITIAL_COMPANION_STATE, reduceCompanion } from "./reducer";
import type { CompanionEvent } from "./contract";
import type { MediaCallbacks, CompanionMedia } from "./media";
import { FakeLiveProvider } from "./fakeProvider";
import { CompanionBoardReads } from "./boardReads";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-adapter-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(extra: ConstructorParameters<typeof OfficialVoiceCompanionAdapter>[0] = {}) {
  let callbacks!: MediaCallbacks;
  let opens = 0, closes = 0, muted = false, interrupts = 0;
  const requests: Record<string, unknown>[] = [];
  let serverEvents: CompanionEvent[] = [];
  let usage: import("./contract").CompanionUsage | undefined;
  let contextFailures = 0;
  let contextGate: { promise: Promise<Response>; release: (response: Response) => void } | null = null;
  let servedProject: string | null = null;
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ ...payload, sessionId: "fixture-session", version: 1, generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: seq }) as CompanionEvent;
  const media: CompanionMedia = { open: async () => { opens++; return "v=0"; }, answer: async () => {}, mute: value => { muted = value; },
    interrupt: () => { interrupts++; }, close: async () => { closes++; } };
  let clock = 0;
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, now: () => clock, media: cb => { callbacks = cb; return media; }, ...extra,
    fetch: (async (_url, init) => {
      if (!init?.body) return String(_url).includes("view=transcript") ? Response.json({ entries: [], truncated: false, usage }) : Response.json({ events: serverEvents, usage });
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (body.action === "context") {
        if (contextFailures-- > 0) return Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 });
        servedProject = body.project;
        if (contextGate) { const held = contextGate; contextGate = null; return held.promise; }
      }
      if (body.action === "start") { servedProject = body.project; serverEvents = [event({ type: "session.ready", mode: "official-realtime" })]; return Response.json({ sessionId: "fixture-session", sdp: "fake-answer" }); }
      if (body.action === "close") serverEvents.push(event({ type: "session.closed", reason: "operator", incomplete: false }));
      return Response.json({ ok: true });
    }) as typeof fetch });
  return { adapter, requests, media, event, holdContextOnce: () => {
    let release!: (response: Response) => void;
    const promise = new Promise<Response>(resolve => { release = resolve; });
    contextGate = { promise, release };
    return (failed = false) => release(failed ? Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 }) : Response.json({ ok: true }));
  }, failContextOnce: () => { contextFailures = 1; }, get servedProject() { return servedProject; }, usage: (value: import("./contract").CompanionUsage) => { usage = value; }, push: (value: CompanionEvent) => serverEvents.push(value), advance: (ms: number) => { clock += ms; jest.advanceTimersByTime(ms); }, get callbacks() { return callbacks; },
    get opens() { return opens; }, get closes() { return closes; }, get muted() { return muted; }, get interrupts() { return interrupts; } };
}
test("media starts on request, mouth follows played output, microphone echo preserves playback, and awaited hangup releases media", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  const events: CompanionEvent[] = [];
  const unsubscribe = f.adapter.subscribe(event => { events.push(event); state = reduceCompanion(state, event); });
  expect(f.opens).toBe(0);
  await f.adapter.start({ project: "fixture", locale: "uk" });
  expect(state.phase).toBe("idle");
  f.callbacks.playback({ rms: 0.7, playedMs: 80, speaking: true });
  expect(state.mouth).toBe(0.7);
  f.callbacks.input(true);
  expect(state.mouth).toBe(0.7);
  expect(f.interrupts).toBe(0);
  expect(events.some(event => event.type === "playback.stopped" && event.reason === "interrupted")).toBe(false);
  await f.adapter.command({ type: "mute", muted: true });
  expect(f.muted).toBe(true);
  await f.adapter.close();
  expect(f.closes).toBeGreaterThan(0);
  expect(state.closure).toEqual({ reason: "operator", incomplete: false });
  expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
  expect(JSON.stringify(f.requests)).not.toContain("api_key");
  unsubscribe();
});

test("a server-admitted Live proposal is displayed with missing input and remains pending during partial duplex speech", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
  await f.adapter.start({ project: "fixture", locale: "en" });
  const proposal = { proposalId: "proposal", callId: "call", sourceItemId: "delegation", instruction: "Review the plan", authority: "live-model",
    recipient: { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" } };
  f.push(f.event({ type: "delegation.tool.called", callId: "call", sourceItemId: "delegation", instruction: "Review the plan" }));
  f.push(f.event({ type: "delegation.confirmation.required", proposal }));
  await f.adapter.command({ type: "mute", muted: false });
  expect(state.delegation?.stage).toBe("awaiting-confirmation");
  f.push(f.event({ type: "transcript.snapshot", speaker: "operator", itemId: "fragment", text: "and please", final: false }));
  await f.adapter.command({ type: "mute", muted: false });
  expect(state.delegation?.stage).toBe("awaiting-confirmation");
  f.push(f.event({ type: "session.closed", reason: "tool", incomplete: false }));
  await f.adapter.command({ type: "mute", muted: false });
  expect(state.closure).toEqual({ reason: "tool", incomplete: false });
  await f.adapter.close();
});

test("microphone refusal produces a normalized plain error and no mint", async () => {
  const f = fixture();
  f.media.open = async () => { throw new Error("MICROPHONE_REFUSED"); };
  const events: CompanionEvent[] = [];
  f.adapter.subscribe(event => events.push(event));
  await expect(f.adapter.start({ project: "fixture", locale: "en" })).rejects.toThrow("MICROPHONE_REFUSED");
  expect(f.requests.filter(row => row.action === "start")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "MICROPHONE_REFUSED" });
  await f.adapter.close();
});

test("a confirmed delivery receives its correlated card after hangup without opening more media", async () => {
  const f = fixture();
  const events: CompanionEvent[] = [];
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { events.push(event); state = reduceCompanion(state, event); });
  await f.adapter.start({ project: "fixture", locale: "en" });
  const delivery = { proposalId: "proposal", callId: "call", clientMessageId: "voice-fixture", operationId: "operation",
    recipient: { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" } };
  for (const row of [delivery, { ...delivery, callId: "call-next", proposalId: "proposal-next", clientMessageId: "voice-next", operationId: "operation-next" }]) {
    f.push(f.event({ type: "delegation.tool.called", callId: row.callId, sourceItemId: "delegation", instruction: "Review the plan" }));
    f.push(f.event({ type: "delegation.confirmation.required", proposal: { ...row, instruction: "Review the plan", sourceItemId: "delegation", authority: "live-model" } }));
    f.push(f.event({ type: "delegation.confirmed", proposalId: row.proposalId, via: "tap" }));
    f.push(f.event({ type: "delegation.tool.result", callId: row.callId, result: { status: "queued", delivery: row } }));
  }
  await f.adapter.command({ type: "mute", muted: false });
  await f.adapter.close();
  f.push(f.event({ type: "orchestrator.answer", delivery, reportId: "report", status: "result", text: "The plan is ready." }));
  await f.adapter.refresh();
  expect(events.at(-1)).toMatchObject({ type: "orchestrator.answer", reportId: "report" });
  expect(state.deliveryCards.find(row => row.delivery?.clientMessageId === delivery.clientMessageId)?.answer?.text).toBe("The plan is ready.");
  expect(state.delegation?.stage).toBe("queued");
  expect(f.opens).toBe(1);
  expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
  await f.adapter.dispose();
});

/** Every cue the adapter asked for, in order. */
function countingCues() {
  const played: string[] = [];
  return { played, cues: { prepare: () => { played.push("prepare"); }, connect: () => { played.push("connect"); }, disconnect: () => { played.push("disconnect"); }, dispose: () => { played.push("dispose"); } } };
}
const heard = (played: string[]) => played.filter(name => name === "connect" || name === "disconnect");

test("a connected session plays one connect cue and one disconnect cue, whichever way it ends", async () => {
  const endings: Array<[string, (f: ReturnType<typeof fixture>) => Promise<void>]> = [
    ["the operator hangs up", f => f.adapter.close()],
    ["the model ends it", async f => { f.push(f.event({ type: "session.closed", reason: "tool", incomplete: false })); await f.adapter.refresh(); }],
    ["the cap ends it", async f => { f.push(f.event({ type: "session.closed", reason: "cap", incomplete: false })); await f.adapter.refresh(); }],
    ["the provider errors", async f => { f.push(f.event({ type: "session.closed", reason: "error", incomplete: false })); await f.adapter.refresh(); }],
    ["the transport drops", async f => { f.push(f.event({ type: "session.closed", reason: "transport", incomplete: false })); await f.adapter.refresh(); }],
    ["the media is lost", async f => { f.callbacks.lost("PROVIDER_ERROR"); await f.adapter.close(); }],
    ["the server closes it and then the operator hangs up", async f => { f.push(f.event({ type: "session.closed", reason: "tool", incomplete: false })); await f.adapter.refresh(); await f.adapter.close(); }],
    ["the page leaves", f => f.adapter.dispose()],
  ];
  for (const [label, end] of endings) {
    const { played, cues } = countingCues();
    const f = fixture({ cues });
    await f.adapter.start({ project: "fixture", locale: "en" });
    expect(heard(played), `${label}: connected`).toEqual(["connect"]);
    await end(f);
    await f.adapter.close();
    expect(heard(played), label).toEqual(["connect", "disconnect"]);
  }
});

test("a start that never connects plays no cue, and two sessions in a row play two and two", async () => {
  const refused = countingCues();
  const f = fixture({ cues: refused.cues });
  f.media.open = async () => { throw new Error("MICROPHONE_REFUSED"); };
  await expect(f.adapter.start({ project: "fixture", locale: "en" })).rejects.toThrow("MICROPHONE_REFUSED");
  await f.adapter.close();
  expect(heard(refused.played)).toEqual([]);
  expect(refused.played).toContain("prepare");

  const twice = countingCues();
  const g = fixture({ cues: twice.cues });
  await g.adapter.start({ project: "fixture", locale: "en" });
  await g.adapter.close();
  await g.adapter.start({ project: "fixture", locale: "en" });
  await g.adapter.close();
  expect(heard(twice.played)).toEqual(["connect", "disconnect", "connect", "disconnect"]);
  /* A new Talk while one is live ends the first before the second connects. */
  const over = countingCues();
  const h = fixture({ cues: over.cues });
  await h.adapter.start({ project: "fixture", locale: "en" });
  await h.adapter.start({ project: "fixture", locale: "en" });
  expect(heard(over.played)).toEqual(["connect", "disconnect", "connect"]);
  await h.adapter.close();
  expect(heard(over.played)).toEqual(["connect", "disconnect", "connect", "disconnect"]);
});

/** The production adapter against the production session service, with fake media and a fake provider. */
async function served() {
  const { CompanionStorage } = await import("./storage");
  const { CompanionAdmission } = await import("./admission");
  const { CompanionLiveSessions } = await import("./liveSession");
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ call: async () => ({}), projectFor: async () => "fixture", recipient: () => "conversation_fixture",
    resolveProject: current => current ?? "fixture", review: () => { throw new Error("REVIEW_NOT_FOUND"); }, frame: async () => { throw new Error("FRAME_NOT_FOUND"); } }),
    provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  let callbacks!: MediaCallbacks;
  let clock = 1_000;
  const media: CompanionMedia = { open: async () => "v=0", answer: async () => {}, mute: () => {}, interrupt: () => {}, close: async () => {} };
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, now: () => clock, media: cb => { callbacks = cb; return media; },
    fetch: (async (url: string, init?: RequestInit) => {
      if (!init?.body) {
        const query = new URL(url, "http://127.0.0.1").searchParams;
        return Response.json({ events: await service.events(query.get("sessionId")!, Number(query.get("after"))) });
      }
      const body = JSON.parse(String(init.body));
      if (body.action === "start") return Response.json(await service.start(body), { status: 201 });
      if (body.action === "close") await (body.sessionId ? service.close(body.sessionId) : service.closeRequest(body.requestId));
      if (body.action === "command") await service.command(body.sessionId, body.command);
      return Response.json({ ok: true });
    }) as typeof fetch });
  let state = INITIAL_COMPANION_STATE;
  adapter.subscribe(event => { state = reduceCompanion(state, event); });
  await adapter.start({ project: "fixture", locale: "en" });
  const sessionId = Object.keys(storage.read().sessions)[0];
  const providerId = storage.read().sessions[sessionId].providerId!;
  let at = 0;
  return {
    adapter, get state() { return state; }, get callbacks() { return callbacks; },
    advance(ms: number) { clock += ms; jest.advanceTimersByTime(ms); },
    /** One companion line from the provider, then the next poll; each starts after a display pause. */
    async says(text: string) {
      at += 3_000;
      provider.replay(providerId, { type: "session.output_transcript.delta", event_id: `out-${at}`, delta: text, start_ms: at, end_ms: at + 400 });
      await service.drain(sessionId);
      await adapter.refresh();
    },
    lines: () => state.lines.filter(line => line.speaker === "companion").map(line => [line.text, line.playback, line.playedMs]),
  };
}

test("played audio reaches its own line in any order: audio before text, text before audio, text after the audio stopped, the next answer and an explicit interruption", async () => {
  const f = await served();
  // Audio before its words: the mouth moves at once, and the line it belongs to plays when its words arrive.
  f.callbacks.playback({ speaking: true, rms: 0.6, playedMs: 0 });
  expect(f.state.mouth).toBe(0.6);
  await f.says("Hello, I can help with the board.");
  expect(f.lines()).toEqual([["Hello, I can help with the board.", "playing", null]]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 1_000 });
  f.advance(1500);
  expect(f.lines()).toEqual([["Hello, I can help with the board.", "played", null]]);
  expect(f.state.mouth).toBe(0);
  // The next answer, words first: its audio is its own and leaves the first line alone.
  f.advance(2_000);
  await f.says("The plan is ready.");
  expect(f.lines().at(-1)).toEqual(["The plan is ready.", "pending", null]);
  f.callbacks.playback({ speaking: true, rms: 0.4, playedMs: 0 });
  expect(f.lines().map(line => line[1])).toEqual(["played", "playing"]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 700 });
  f.advance(1500);
  expect(f.lines().map(line => line[1])).toEqual(["played", "played"]);
  // Words that arrive after their audio stopped are shown as played.
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
  f.advance(1500);
  await f.says("Done.");
  expect(f.lines().map(line => line[1])).toEqual(["played", "played", "played"]);
  // An explicit interruption cuts audio whose words have not arrived; they arrive marked cut where it stopped.
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 300 });
  await f.adapter.command({ type: "interrupt", responseId: "current" });
  expect(f.state.mouth).toBe(0);
  await f.says("Here is a long answer that was cut.");
  expect(f.lines().at(-1)).toEqual(["Here is a long answer that was cut.", "cut", 300]);
  f.callbacks.input(false);
  // A short pause inside one line continues that line's audio; nothing else takes it.
  f.advance(2_000);
  await f.says("First part. Second part.");
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 600 });
  f.advance(1_400);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 200 });
  expect([f.lines().at(-1)![1], f.state.playedMs]).toEqual(["playing", 800]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 300 });
  f.advance(1500);
  expect(f.lines().map(line => line[1])).toEqual(["played", "played", "played", "cut", "played"]);
  // No line without words carries playback.
  expect(f.state.lines.filter(line => line.speaker === "companion" && !line.text)).toEqual([]);
  await f.adapter.dispose();
});

test("late words reach their own audio oldest first: a finished answer keeps its words when the next one is already playing, and an explicit interruption cuts only the next", async () => {
  for (const interrupt of [false, true]) {
    const f = await served();
    // Answer A plays and ends with no words yet; after a pause answer B starts.
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
    f.advance(2_000);
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 200 });
    await f.says("First answer.");
    await f.says("Second answer.");
    expect(f.lines()).toEqual([["First answer.", "played", null], ["Second answer.", "playing", null]]);
    expect(f.state.playedMs).toBe(200);
    if (interrupt) {
      await f.adapter.command({ type: "interrupt", responseId: "current" });
      expect(f.lines()).toEqual([["First answer.", "played", null], ["Second answer.", "cut", 200]]);
    } else {
      f.callbacks.playback({ speaking: false, rms: 0, playedMs: 700 });
  f.advance(1500);
      expect(f.lines().map(line => line[1])).toEqual(["played", "played"]);
    }
    await f.adapter.dispose();
  }
});

test("an explicit interruption during the next answer, before either answer's words arrive, leaves the earlier one played and the next one cut", async () => {
  const f = await served();
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 250 });
  await f.adapter.command({ type: "interrupt", responseId: "current" });
  await f.says("First answer.");
  await f.says("Second answer.");
  expect(f.lines()).toEqual([["First answer.", "played", null], ["Second answer.", "cut", 250]]);
  await f.adapter.dispose();
});

test("finals in another order than the lines began change nothing: each line keeps the audio that played it", async () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const f = fixture();
    let state = INITIAL_COMPANION_STATE;
    f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
    await f.adapter.start({ project: "fixture", locale: "en" });
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
    f.advance(2_000);
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 200 });
    const line = (id: string, text: string, final: boolean, startMs: number) => f.event({ type: "transcript.snapshot", speaker: "companion", itemId: id, text, final, startMs, endMs: startMs + 400 });
    f.push(line("a", "First answer", false, 3_000));
    f.push(line("b", "Second answer", false, 6_000));
    await f.adapter.refresh();
    for (const id of order) f.push(id === "a" ? line("a", "First answer.", true, 3_000) : line("b", "Second answer.", true, 6_000));
    await f.adapter.refresh();
    const rows = () => state.lines.filter(row => row.speaker === "companion").map(row => [row.text, row.playback]);
    expect(rows()).toEqual([["First answer.", "played"], ["Second answer.", "playing"]]);
    await f.adapter.command({ type: "interrupt", responseId: "current" });
    expect(rows()).toEqual([["First answer.", "played"], ["Second answer.", "cut"]]);
    await f.adapter.dispose();
  }
});


test("paced chunk gaps from 600 to 1400 ms keep one played line even with microphone echo", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  const events: CompanionEvent[] = [];
  f.adapter.subscribe(event => { events.push(event); state = reduceCompanion(state, event); });
  await f.adapter.start({ project: "fixture", locale: "en" });
  let text = "First words.", timeline = 0;
  for (const gap of [600, 800, 1200, 1400]) {
    text += " More words.";
    f.push(f.event({ type: "transcript.snapshot", speaker: "companion", itemId: "paced-line", text, final: false, startMs: 0, endMs: timeline + 400 }));
    await f.adapter.refresh();
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.input(true);
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 400 });
    f.callbacks.playback({ speaking: false, rms: 0, playedMs: 400 });
    f.advance(gap); timeline += 400 + gap;
  }
  expect(state.lines.filter(line => line.speaker === "companion")).toHaveLength(1);
  expect(state.lines[0]).toMatchObject({ itemId: "paced-line", playback: "playing", text });
  f.advance(1500);
  expect(state.lines[0]).toMatchObject({ playback: "played" });
  expect(f.interrupts).toBe(0);
  expect(events.filter(event => event.type === "playback.stopped" && event.reason === "interrupted")).toEqual([]);
  await f.adapter.dispose();
});


test("a 300 ms output pause rests the mouth and keeps one playback until 1500 ms of silence", async () => {
  const f = fixture();
  const events: CompanionEvent[] = [];
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { events.push(event); state = reduceCompanion(state, event); });
  try {
    await f.adapter.start({ project: "fixture", locale: "en" });
    f.push(f.event({ type: "transcript.snapshot", speaker: "companion", itemId: "line", text: "First phrase. Next phrase.", final: true }));
    await f.adapter.refresh();
    f.callbacks.playback({ speaking: true, rms: 0.6, playedMs: 400 });
    f.callbacks.playback({ speaking: false, rms: 0, playedMs: 400 });
    f.advance(300);
    expect(state.mouth).toBe(0);
    expect(events.filter(event => event.type === "playback.stopped")).toHaveLength(0);
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
    f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 200 });
    expect(events.filter(event => event.type === "playback.started")).toHaveLength(1);
    expect(state.playedMs).toBe(600);
    f.callbacks.playback({ speaking: false, rms: 0, playedMs: 300 });
    f.advance(1499);
    expect(events.filter(event => event.type === "playback.stopped")).toHaveLength(0);
    f.advance(101);
    expect(events.filter(event => event.type === "playback.stopped")).toMatchObject([{ reason: "ended", playedMs: 700 }]);
  } finally { await f.adapter.dispose(); }
});


test("context changes during microphone start reach the minted session without another start or hangup", async () => {
  const f = fixture();
  let opened!: (sdp: string) => void;
  f.media.open = () => new Promise(resolve => { opened = resolve; });
  const started = f.adapter.start({ project: "first", locale: "en" });
  await Promise.resolve();
  await f.adapter.setProject("second");
  await f.adapter.setProject(null);
  opened("v=0");
  await started;
  expect(f.requests.filter(row => row.action === "context")).toEqual([{ action: "context", sessionId: "fixture-session", project: null }]);
  await f.adapter.setProject("third");
  expect(f.requests.at(-1)).toEqual({ action: "context", sessionId: "fixture-session", project: "third" });
  expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
  expect(f.requests.filter(row => row.action === "close")).toHaveLength(0);
  await f.adapter.dispose();
});


test("live and ended usage updates arrive even when no new persisted events were added", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
  try {
    await f.adapter.start({ project: "fixture", locale: "en" });
    const seen = state.seen;
    const usage = { callUsd: 0.19, callFinal: false, callIncomplete: false, month: "2026-10", monthUsd: 0.51, monthCapUsd: 20 };
    f.usage(usage);
    await f.adapter.refresh();
    expect(state.usage).toEqual(usage);
    expect(state.seen).toBe(seen);
    f.usage({ ...usage, callUsd: 0.4, callFinal: true, monthUsd: 0.72 });
    await f.adapter.close();
    expect(state.usage).toMatchObject({ callUsd: 0.4, callFinal: true, monthUsd: 0.72 });
    expect(state.phase).toBe("offline");
    f.usage({ ...usage, callUsd: 0.41, callFinal: true, monthUsd: 0.73 });
    await f.adapter.transcript();
    expect(state.usage).toMatchObject({ callUsd: 0.41, callFinal: true, monthUsd: 0.73 });
  } finally { await f.adapter.dispose(); }
});


test("failed context updates pause input and retry on the same call before another project can receive speech", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
  try {
    await f.adapter.start({ project: "project-a", locale: "en" });
    for (const project of ["project-b", null]) {
      f.failContextOnce();
      await expect(f.adapter.setProject(project)).rejects.toThrow("COMPANION_UNAVAILABLE");
      expect(f.muted).toBe(true);
      expect(f.servedProject).not.toBe(project);
      expect(state.error).toBe("CONTEXT_UNCONFIRMED");
      await f.adapter.refresh();
      expect(f.servedProject).toBe(project);
      expect(f.muted).toBe(false);
      expect(state.error).toBeNull();
    }
    await f.adapter.command({ type: "mute", muted: true });
    await f.adapter.setProject("project-a");
    expect(f.muted).toBe(true);
    expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
    expect(f.requests.filter(row => row.action === "close")).toHaveLength(0);
  } finally { await f.adapter.dispose(); }
});

test("healthy event polling keeps the real watchdog alive while a project acknowledgement is held", async () => {
  const { CompanionStorage } = await import("./storage");
  const { CompanionAdmission } = await import("./admission");
  const { CompanionLiveSessions } = await import("./liveSession");
  let now = Date.parse("2026-10-10T00:00:00Z");
  const storage = new CompanionStorage(() => now); storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unused"); } }, () => now);
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ call: async () => ({}), projectFor: async () => "first",
    recipient: () => null, resolveProject: current => current!, review: () => { throw new Error("unused"); }, frame: async () => { throw new Error("unused"); } }),
    provider, { now: () => now, key: () => "synthetic-credential", closeTimeoutMs: 20 });
  let muted = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let gets = 0;
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 1_000, cues: { prepare() {}, connect() {}, disconnect() {}, dispose() {} },
    media: () => ({ open: async () => "v=0", answer: async () => {}, mute: value => { muted = value; }, interrupt() {}, close: async () => {} }),
    fetch: (async (url, init) => {
      if (!init?.body) {
        gets++;
        const query = new URL(String(url), "http://127.0.0.1").searchParams;
        return Response.json({ events: await service.events(query.get("sessionId")!, Number(query.get("after"))) });
      }
      const body = JSON.parse(String(init.body));
      if (body.action === "start") return Response.json(await service.start(body));
      if (body.action === "context") { await service.context(body.sessionId, body.project); await held; }
      if (body.action === "close") await service.close(body.sessionId);
      return Response.json({ ok: true });
    }) as typeof fetch });
  await adapter.start({ project: "first", locale: "en" });
  const session = Object.values(storage.read().sessions).at(-1)!;
  const update = adapter.setProject("second");
  try {
    for (let second = 0; second < 36; second++) {
      now += 1_000; jest.advanceTimersByTime(1_000);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    }
    expect(gets).toBeGreaterThan(30);
    expect(storage.read().sessions[session.id].closed).toBe(false);
    expect(provider.attached).toBe(1);
    expect(provider.commands.some(command => command.type === "session.close")).toBe(false);
    expect(muted).toBe(true);
    release(); await update;
    expect(muted).toBe(false);
    expect(provider.sessions).toHaveLength(1);
  } finally { release(); await update; await adapter.dispose(); }
});

for (const lost of [false, true]) test(`returning to the acknowledged project keeps input paused until reconciliation${lost ? " after a lost response" : ""}`, async () => {
  const f = fixture();
  let releaseB = (_failed = false) => {};
  let releaseA = (_failed = false) => {};
  try {
    await f.adapter.start({ project: "project-a", locale: "en" });
    releaseB = f.holdContextOnce();
    const toB = f.adapter.setProject("project-b").catch(error => error);
    expect(f.servedProject).toBe("project-b");
    expect(f.muted).toBe(true);
    const toA = f.adapter.setProject("project-a").catch(error => error);
    expect(f.muted).toBe(true);
    releaseA = f.holdContextOnce();
    releaseB(lost);
    if (lost) {
      await Promise.all([toB, toA]);
      expect(f.servedProject).toBe("project-b");
      expect(f.muted).toBe(true);
    }
    const refreshing = lost ? f.adapter.refresh() : Promise.all([toB, toA]);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(f.requests.filter(row => row.action === "context").map(row => row.project)).toEqual(["project-b", "project-a"]);
    expect(f.servedProject).toBe("project-a");
    expect(f.muted).toBe(true);
    releaseA();
    await refreshing;
    await f.adapter.setProject("project-a");
    expect(f.muted).toBe(false);
    expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
    expect(f.requests.filter(row => row.action === "close")).toHaveLength(0);
  } finally { releaseB(); releaseA(); await f.adapter.dispose(); }
});
