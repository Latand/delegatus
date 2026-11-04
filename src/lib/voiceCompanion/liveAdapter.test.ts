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
  let pollsFail = false;
  let contextGate: { promise: Promise<Response>; release: (response: Response) => void } | null = null;
  let servedProject: string | null = null;
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ ...payload, sessionId: "fixture-session", version: 1, generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: seq }) as CompanionEvent;
  const media: CompanionMedia = { open: async () => { opens++; return "v=0"; }, answer: async () => {}, mute: value => { muted = value; },
    interrupt: () => { interrupts++; }, close: async () => { closes++; } };
  let clock = 0;
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, now: () => clock, media: cb => { callbacks = cb; return media; }, ...extra,
    fetch: (async (_url, init) => {
      if (!init?.body && pollsFail) throw new TypeError("Failed to fetch");
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
  }, failContextOnce: () => { contextFailures = 1; }, failPolls: () => { pollsFail = true; }, healPolls: () => { pollsFail = false; }, get servedProject() { return servedProject; }, usage: (value: import("./contract").CompanionUsage) => { usage = value; }, push: (value: CompanionEvent) => serverEvents.push(value), advance: (ms: number) => { clock += ms; jest.advanceTimersByTime(ms); }, get callbacks() { return callbacks; },
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
  // The browser's own zone travels with the start; the server resolves the call's clock from it.
  expect(f.requests.find(row => row.action === "start")?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(JSON.stringify(f.requests)).not.toContain("api_key");
  unsubscribe();
});

test("a three-second ICE episode mid-reply posts one connection row and keeps the call up", async () => {
  const f = fixture();
  await f.adapter.start({ project: "fixture", locale: "en" });
  f.callbacks.playback({ speaking: true, rms: 0.6, playedMs: 800 });
  f.callbacks.connection("disconnected");
  f.callbacks.connection("disconnected");
  f.advance(3000);
  f.callbacks.connection("connected");
  f.callbacks.connection("connected");
  await f.adapter.refresh();
  expect(f.requests.filter(row => row.action === "command")).toEqual([
    { action: "command", sessionId: "fixture-session", command: { type: "episode", ms: 3000, speaking: "voice" } },
  ]);
  expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
  expect(f.requests.filter(row => row.action === "close")).toHaveLength(0);
  await f.adapter.dispose();
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

test("a Viewer that stops answering mid-call is a drop: the close says so, and only a real session is closed as one", async () => {
  const f = fixture({ pollMs: 500 });
  const events: CompanionEvent[] = [];
  f.adapter.subscribe(event => events.push(event));
  await f.adapter.start({ project: "fixture", locale: "en" });
  f.failPolls();
  f.advance(600);
  await f.adapter.close();
  expect(events.filter(event => event.type === "error").map(event => (event as { code: string }).code)).toContain("CONNECTION_LOST");
  expect(f.requests.filter(row => row.action === "close")).toEqual([{ action: "close", sessionId: "fixture-session", reason: "transport", cause: "viewer-unreachable" }]);
  /* An operator's own hang-up of the next call carries no reason. */
  f.healPolls();
  await f.adapter.start({ project: "fixture", locale: "en" });
  await f.adapter.close();
  expect(f.requests.filter(row => row.action === "close").at(-1)).toEqual({ action: "close", sessionId: "fixture-session" });
  /* A microphone or audio refusal is no drop. */
  await f.adapter.start({ project: "fixture", locale: "en" });
  f.callbacks.lost("AUDIO_REFUSED");
  await f.adapter.close();
  expect(f.requests.filter(row => row.action === "close").at(-1)).toEqual({ action: "close", sessionId: "fixture-session" });
  await f.adapter.dispose();
});

/** Every cue the adapter asked for, in order. */
function countingCues() {
  const played: string[] = [];
  return { played, cues: { prepare: () => { played.push("prepare"); }, connect: () => { played.push("connect"); }, disconnect: () => { played.push("disconnect"); }, timer: () => { played.push("timer"); }, dispose: () => { played.push("dispose"); } } };
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

test("a fired timer the server reports plays the timer cue once, however often the poll returns", async () => {
  const { played, cues } = countingCues();
  const f = fixture({ cues });
  await f.adapter.start({ project: "fixture", locale: "en" });
  f.push(f.event({ type: "timer.fired", timerId: "vt_fixture" }));
  await f.adapter.refresh();
  await f.adapter.refresh();
  expect(played.filter(name => name === "timer")).toEqual(["timer"]);
  await f.adapter.close();
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
      if (body.action === "close") await (body.sessionId ? service.close(body.sessionId, body.reason, body.cause, body.episode) : service.closeRequest(body.requestId));
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
    /* Another retained call opened from the history keeps its usage in its own record. */
    f.usage({ ...usage, callUsd: 3.5, callFinal: true, monthUsd: 0.73 });
    expect(await f.adapter.transcript("earlier-call")).toMatchObject({ usage: { callUsd: 3.5 } });
    expect(state.usage).toMatchObject({ callUsd: 0.41 });
  } finally { await f.adapter.dispose(); }
});


test("a Codex call's usage updates carry its length and plan window, and an unchanged reading renders nothing", async () => {
  const f = fixture();
  let state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
  try {
    await f.adapter.start({ project: "fixture", locale: "en" });
    const seen = state.seen;
    const plan = { type: "pro", primary: { usedPercent: 23, resetsAt: 2000000100, windowMinutes: 300 }, secondary: null, limitReached: false, observedAt: 1 };
    const usage = { backend: "codex" as const, callSeconds: 41, callFinal: false, plan, planStartPercent: 21 };
    f.usage(usage);
    await f.adapter.refresh();
    expect(state.usage).toEqual(usage);
    expect(state.seen).toBe(seen);
    const revision = state.revision;
    f.usage(structuredClone(usage));
    await f.adapter.refresh();
    expect(state.revision).toBe(revision);
    f.usage({ ...usage, callSeconds: 96, callFinal: true });
    await f.adapter.close();
    expect(state.usage).toMatchObject({ callSeconds: 96, callFinal: true });
    expect(state.phase).toBe("offline");
    f.usage({ ...usage, callSeconds: 96, callFinal: true, plan: { ...plan, primary: { ...plan.primary, usedPercent: 24 } } });
    await f.adapter.transcript();
    expect(state.usage).toMatchObject({ callSeconds: 96, callFinal: true, plan: { primary: { usedPercent: 24 } } });
  } finally { await f.adapter.dispose(); }
});

test("a start refused at the plan limit names its reset; a call the limit ended says so", async () => {
  let state = INITIAL_COMPANION_STATE;
  const media: CompanionMedia = { open: async () => "v=0", answer: async () => {}, mute: () => {}, interrupt: () => {}, close: async () => {} };
  const refused = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, media: () => media,
    fetch: (async () => Response.json({ code: "CODEX_LIMIT_REACHED", resetsAt: 2000000100 }, { status: 409 })) as unknown as typeof fetch });
  refused.subscribe(event => { state = reduceCompanion(state, event); });
  await expect(refused.start({ project: "fixture", locale: "en" })).rejects.toThrow("CODEX_LIMIT_REACHED");
  expect([state.error, state.errorResetsAt]).toEqual(["CODEX_LIMIT_REACHED", 2000000100]);
  await refused.dispose();
  const f = fixture();
  state = INITIAL_COMPANION_STATE;
  f.adapter.subscribe(event => { state = reduceCompanion(state, event); });
  try {
    await f.adapter.start({ project: "fixture", locale: "en" });
    f.push(f.event({ type: "session.closed", reason: "limit" }));
    await f.adapter.refresh();
    expect([state.phase, state.error, state.closure]).toEqual(["offline", "CODEX_LIMIT_ENDED", { reason: "limit", incomplete: false }]);
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
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 1_000, cues: { prepare() {}, connect() {}, disconnect() {}, timer() {}, dispose() {} },
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


/** Loss occurs after the real service minted. Other requests, especially close, still reach it. */
async function reconnecting(options: { lostAnswers?: number; failFirstPoll?: boolean; audioRefused?: boolean; answerError?: string; holdAnswer?: boolean; holdOffer?: boolean; closeAfterLost?: boolean; refusal?: string; contentClose?: boolean } = {}) {
  const { createCompanionStore } = await import("@/hooks/useVoiceCompanion");
  const { CompanionStorage } = await import("./storage");
  const { CompanionAdmission } = await import("./admission");
  const { CompanionLiveSessions } = await import("./liveSession");
  let now = Date.UTC(2026, 10, 4, 12);
  process.env.LLV_STATE_DIR = path.join(root, `reconnect-${++reconnectFixture}`);
  const storage = new CompanionStorage(() => now); storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, () => now);
  const provider = new FakeLiveProvider();
  const liveAtMint: number[] = [];
  const create = provider.create.bind(provider);
  provider.create = async (...args: Parameters<typeof create>) => { liveAtMint.push(provider.attached); return create(...args); };
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ call: async () => ({}), projectFor: async () => "fixture", recipient: () => null,
    resolveProject: current => current!, review: () => { throw new Error("unused"); }, frame: async () => { throw new Error("unused"); } }),
    provider, { now: () => now, key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  let callbacks!: MediaCallbacks;
  let opens = 0, peers = 0, muted = false, failures = options.lostAnswers ?? 0, failPoll = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, unknown>[] = [];
  const sounds: string[] = [];
  const cues = { prepare() {}, connect() { sounds.push("connect"); }, disconnect() { sounds.push("disconnect"); }, timer() {}, tick() { sounds.push("tick"); }, giveUp() { sounds.push("give-up"); }, dispose() {} };
  const media: CompanionMedia = { open: async () => { opens++; peers++; return "v=0"; }, restart: async cb => { callbacks = cb; peers++; if (options.holdOffer) await held; return "v=0"; },
    answer: async () => {
      if (peers > 1 && (options.audioRefused || options.answerError)) { const code = options.audioRefused ? "AUDIO_REFUSED" : options.answerError; options.audioRefused = false; options.answerError = undefined; throw new Error(code); }
    }, mute: value => { muted = value; }, interrupt() {}, close: async () => {} };
  const adapter = new OfficialVoiceCompanionAdapter({ now: () => now, pollMs: 100_000, media: cb => { callbacks = cb; return media; }, cues,
    fetch: (async (url, init) => {
      if (String(url).includes("/resume")) return Response.json({ resumable: service.resumable({ operator: true }) });
      if (!init?.body) {
        if (failPoll) { failPoll = false; throw new TypeError("lost poll"); }
        const query = new URL(String(url), "http://127.0.0.1").searchParams;
        return Response.json({ events: await service.events(query.get("sessionId")!, Number(query.get("after"))) });
      }
      const body = JSON.parse(String(init.body)); requests.push(body);
      try {
        if (body.action === "start") {
          if (body.resume && options.refusal) return Response.json({ code: options.refusal }, { status: 409 });
          const answer = await service.start(body);
          if (body.resume && options.contentClose) {
            options.contentClose = false;
            provider.replay(answer.providerId, { type: "session.closed", event_id: "content-close", reason: "content", usage: { seconds: 1 } });
            await service.drain(answer.sessionId);
          }
          if (body.resume && options.holdAnswer) await held;
          if (body.resume && failures-- > 0) {
            if (options.closeAfterLost) { options.closeAfterLost = false; await service.close(answer.sessionId, "transport", "watchdog"); }
            throw new TypeError("lost start answer");
          }
          if (body.resume && options.failFirstPoll) { options.failFirstPoll = false; failPoll = true; }
          return Response.json(answer);
        }
        if (body.action === "close") await (body.sessionId ? service.close(body.sessionId, body.reason, body.cause, body.episode) : service.closeRequest(body.requestId));
        if (body.action === "command") await service.command(body.sessionId, body.command);
        return Response.json({ ok: true });
      } catch (error) { if (error instanceof TypeError) throw error; return Response.json({ code: (error as Error).message }, { status: 409 }); }
    }) as typeof fetch });
  const store = createCompanionStore(adapter, { now: () => now, random: () => 0.5 });
  const disconnect = store.connect();
  await store.start({ project: "fixture", locale: "en" });
  const first = Object.values(storage.read().sessions).at(-1)!;
  provider.replay(first.providerId!, { type: "session.output_transcript.delta", event_id: "reply", delta: "The build passed.", start_ms: 0, end_ms: 1000 });
  await service.drain(first.id); await adapter.refresh();
  callbacks.playback({ speaking: true, rms: 0.5, playedMs: 400 });
  const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
  return { adapter, store, service, provider, storage, requests, sounds, liveAtMint, first, release,
    get callbacks() { return callbacks; }, get opens() { return opens; }, get muted() { return muted; },
    async drop(poll = false) { if (poll) { failPoll = true; jest.advanceTimersByTime(100_000); } else callbacks.lost("PROVIDER_ERROR", "ice-failed"); await flush(); },
    async tick(ms: number) { now += ms; jest.advanceTimersByTime(ms); await flush(); },
    async dispose() { release(); await store.stop(); disconnect(); await flush(); },
  };
}
let reconnectFixture = 0;

test("notice-to-request timing includes the replacement offer's preparation", async () => {
  const f = await reconnecting({ holdOffer: true });
  try {
    await f.drop(); await f.tick(150);
    expect(f.requests.filter(row => row.action === "start")).toHaveLength(1);
    await f.tick(2000); f.release(); await f.tick(0);
    expect(f.requests.filter(row => row.action === "start").at(-1)?.reconnect).toMatchObject({ noticedToStartMs: 2150 });
    expect(f.store.get().reconnected).toBe(true);
  } finally { await f.dispose(); }
});

for (const poll of [false, true]) test(`${poll ? "failed poll" : "failed peer"} mid-reply resumes within 300ms, keeps mute and one microphone, and sounds one cue each`, async () => {
  const f = await reconnecting();
  try {
    await f.store.command({ type: "mute", muted: true });
    await f.drop(poll);
    expect(f.store.get().phase).toBe("reconnecting");
    expect(f.store.get().reconnected).toBe(false);
    await f.tick(150);
    expect(f.provider.sessions).toHaveLength(2);
    expect(f.store.get().reconnected).toBe(true);
    expect(f.opens).toBe(1); expect(f.muted).toBe(true);
    expect(f.sounds).toEqual(["connect", "disconnect", "connect"]);
    expect(f.requests.filter(row => row.action === "start").at(-1)).toMatchObject({ resume: f.first.id, reconnect: { attempts: 1, automatic: true, tier: 2 } });
  } finally { await f.dispose(); }
});

for (const lostAnswers of [1, 4]) test(`${lostAnswers} lost start answers recover with same-key retries and a single unbranched call`, async () => {
  const f = await reconnecting({ lostAnswers });
  try {
    await f.drop(); await f.tick(150);
    if (lostAnswers === 4) {
      expect(f.store.get().reconnected).toBe(false);
      await f.tick(1000); expect(f.store.get().reconnected).toBe(false);
      await f.tick(2000);
    }
    expect(f.store.get().reconnected).toBe(true);
    expect(f.sounds).not.toContain("give-up");
    expect(f.provider.sessions).toHaveLength(lostAnswers === 1 ? 2 : 4);
    expect(f.liveAtMint.every(count => count === 0)).toBe(true);
    const starts = f.requests.filter(row => row.action === "start");
    expect(starts[1].requestId).toBe(starts[2].requestId);
    expect(starts[1].sdp).toBe(starts[2].sdp);
    const parts = Object.values(f.storage.read().sessions);
    for (let i = 1; i < parts.length; i++) {
      const start = f.service.admission.transcriptRecord(parts[i].id).entries.find(row => row.kind === "session_start")!;
      expect(start.data.resumes).toBe(parts[i - 1].id);
      if (i < parts.length - 1) expect(f.service.admission.transcriptRecord(parts[i].id).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "answer-lost" });
    }
  } finally { await f.dispose(); }
});

test("End behind an unanswered mint closes it as operator and cancels all later retries", async () => {
  const f = await reconnecting({ holdAnswer: true });
  try {
    await f.drop(); await f.tick(150);
    expect(f.provider.sessions).toHaveLength(2);
    const stopping = f.store.stop(); f.release(); await stopping;
    await f.tick(60_000);
    expect(f.provider.sessions).toHaveLength(2);
    const last = Object.values(f.storage.read().sessions).at(-1)!;
    expect(f.service.admission.transcriptRecord(last.id).entries.find(row => row.kind === "session_end")?.data.reason).toBe("operator");
    expect(f.store.get().phase).toBe("offline");
    expect(f.store.get().resumable).toBeNull();
  } finally { await f.dispose(); }
});

test("a manual reconnect losing both answers sends no close; the next tap follows the unanswered part", async () => {
  const f = await reconnecting({ lostAnswers: 2 });
  try {
    await f.drop(); await f.store.stop();
    await expect(f.store.start({ project: "fixture", locale: "en", resume: f.first.id })).rejects.toThrow("lost start answer");
    const unanswered = Object.values(f.storage.read().sessions).at(-1)!;
    expect(unanswered.closed).toBe(false);
    expect(f.requests.filter(row => row.action === "close" && row.requestId === unanswered.mintRequestId)).toHaveLength(0);
    await f.store.start({ project: "fixture", locale: "en", resume: f.first.id });
    expect(f.store.get().reconnected).toBe(true);
    expect(f.service.admission.transcriptRecord(unanswered.id).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "answer-lost" });
    expect(f.provider.attached).toBe(1);
  } finally { await f.dispose(); }
});

test("a same-key replay after its part closed retries from that part; End in backoff leaves the drop offered", async () => {
  const f = await reconnecting({ lostAnswers: 1, closeAfterLost: true });
  try {
    await f.drop(); await f.tick(150);
    expect(f.store.get().reconnected).toBe(false);
    await f.tick(1000);
    expect(f.store.get().reconnected).toBe(true);
    expect(f.provider.sessions).toHaveLength(3);
  } finally { await f.dispose(); }
  const stopped = await reconnecting({ lostAnswers: 8 });
  try {
    await stopped.drop(); await stopped.tick(150); await stopped.store.stop();
    await stopped.tick(60_000);
    expect(stopped.requests.filter(row => row.action === "start")).toHaveLength(3);
    expect(stopped.store.get().resumable?.sessionId).toBe(stopped.first.id);
  } finally { await stopped.dispose(); }
});

for (const code of ["SESSION_UNAVAILABLE", "MINT_UNCERTAIN"]) test(`${code} stops automatic attempts immediately with one give-up cue`, async () => {
  const f = await reconnecting({ refusal: code });
  try {
    await f.drop(); await f.tick(150); await f.tick(60_000);
    expect(f.requests.filter(row => row.action === "start")).toHaveLength(2);
    expect(f.store.get().phase).toBe("offline"); expect(f.store.get().error).toBe(code);
    expect(f.sounds.filter(row => row === "give-up")).toHaveLength(1);
  } finally { await f.dispose(); }
});

for (const manual of [false, true]) test(`a content close during ${manual ? "manual" : "automatic"} resume removes the call's continuation offer`, async () => {
  const f = await reconnecting({ contentClose: true });
  try {
    await f.drop();
    if (manual) {
      await f.store.stop();
      await expect(f.store.start({ project: "fixture", locale: "en", resume: f.first.id })).rejects.toThrow("CONTENT_BLOCKED");
    } else await f.tick(150);
    expect(f.store.get().error).toBe("CONTENT_BLOCKED");
    expect(f.store.get().resumable).toBeNull();
    expect(f.service.resumable({ operator: true })).toBeNull();
    await f.tick(60_000);
    expect(f.provider.sessions).toHaveLength(2);
    expect(f.sounds.filter(sound => sound === "give-up")).toHaveLength(manual ? 0 : 1);
  } finally { await f.dispose(); }
});

test("an uncertain provider mint stops the loop without creating a second replacement", async () => {
  const f = await reconnecting();
  try {
    f.provider.createFailures.push("lost"); await f.drop(); await f.tick(150); await f.tick(1000); await f.tick(60_000);
    expect(f.store.get().error).toBe("MINT_UNCERTAIN"); expect(f.provider.sessions).toHaveLength(2);
    expect(f.sounds.filter(row => row === "give-up")).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("six automatic reconnects in ten minutes cap a flapping call; the final disconnect precedes give-up", async () => {
  const f = await reconnecting();
  try {
    for (let i = 0; i < 6; i++) { await f.drop(); await f.tick(150); expect(f.store.get().reconnected).toBe(true); }
    await f.drop(); await f.tick(60_000);
    expect(f.provider.sessions).toHaveLength(7); expect(f.store.get().error).toBe("RECONNECT_GAVE_UP");
    expect(f.sounds.slice(-2)).toEqual(["disconnect", "give-up"]);
    await f.store.start({ project: "fixture", locale: "en" });
    const fresh = Object.values(f.storage.read().sessions).at(-1)!;
    f.provider.replay(fresh.providerId!, { type: "session.output_transcript.delta", event_id: "fresh-reply", delta: "The next check passed.", start_ms: 0, end_ms: 1000 });
    await f.service.drain(fresh.id); await f.adapter.refresh(); await f.drop(); await f.tick(150);
    expect(f.provider.sessions).toHaveLength(9); expect(f.store.get().reconnected).toBe(true);
  } finally { await f.dispose(); }
});

for (const failFirstPoll of [true, false]) test(`resumed ${failFirstPoll ? "first poll fails and retries" : "playback refusal stops with a resumable drop"}`, async () => {
  const f = await reconnecting({ failFirstPoll, audioRefused: !failFirstPoll });
  try {
    await f.drop(); await f.tick(150);
    const failed = Object.values(f.storage.read().sessions).at(-1)!;
    expect(f.service.admission.transcriptRecord(failed.id).entries.find(row => row.kind === "session_end")?.data.reason).toBe("transport");
    expect(f.service.admission.transcriptRecord(failed.id).entries.find(row => row.kind === "session_end")?.data.cause).toBe(failFirstPoll ? "viewer-unreachable" : "audio-refused");
    if (failFirstPoll) { await f.tick(1000); expect(f.store.get().reconnected).toBe(true); }
    else {
      expect(f.store.get().phase).toBe("offline"); expect(f.store.get().resumable?.sessionId).toBe(failed.id); expect(f.sounds.filter(sound => sound === "give-up")).toHaveLength(1);
      await f.store.start({ project: "fixture", locale: "en", resume: failed.id }); expect(f.store.get().reconnected).toBe(true);
      expect(f.requests.filter(row => row.action === "start").at(-1)?.resume).toBe(failed.id);
    }
  } finally { await f.dispose(); }
});

test("a resumed SDP answer that cannot be applied closes as a peer drop and the next attempt continues it", async () => {
  const f = await reconnecting({ answerError: "PROVIDER_ERROR" });
  try {
    await f.drop(); await f.tick(150);
    const failed = Object.values(f.storage.read().sessions).at(-1)!;
    expect(f.service.admission.transcriptRecord(failed.id).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "ice-failed" });
    await f.tick(1000); expect(f.store.get().reconnected).toBe(true);
  } finally { await f.dispose(); }
});
