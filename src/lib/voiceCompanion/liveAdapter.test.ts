import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OfficialVoiceCompanionAdapter } from "./liveAdapter";
import { INITIAL_COMPANION_STATE, reduceCompanion } from "./reducer";
import type { CompanionEvent } from "./contract";
import type { MediaCallbacks, CompanionMedia } from "./media";
import { FakeLiveProvider } from "./fakeProvider";
import { CompanionBoardReads } from "./boardReads";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-adapter-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  let callbacks!: MediaCallbacks;
  let opens = 0, closes = 0, muted = false, interrupts = 0;
  const requests: Record<string, unknown>[] = [];
  let serverEvents: CompanionEvent[] = [];
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ ...payload, sessionId: "fixture-session", version: 1, generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: seq }) as CompanionEvent;
  const media: CompanionMedia = { open: async () => { opens++; return "v=0"; }, answer: async () => {}, mute: value => { muted = value; },
    interrupt: () => { interrupts++; }, close: async () => { closes++; } };
  let clock = 0;
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, now: () => clock, media: cb => { callbacks = cb; return media; },
    fetch: (async (_url, init) => {
      if (!init?.body) return Response.json({ events: serverEvents });
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (body.action === "start") { serverEvents = [event({ type: "session.ready", mode: "official-realtime" })]; return Response.json({ sessionId: "fixture-session", sdp: "fake-answer" }); }
      if (body.action === "close") serverEvents.push(event({ type: "session.closed", reason: "operator", incomplete: false }));
      return Response.json({ ok: true });
    }) as typeof fetch });
  return { adapter, requests, media, event, push: (value: CompanionEvent) => serverEvents.push(value), advance: (ms: number) => { clock += ms; }, get callbacks() { return callbacks; },
    get opens() { return opens; }, get closes() { return closes; }, get muted() { return muted; }, get interrupts() { return interrupts; } };
}
test("media starts on request, mouth follows played output, barge-in cuts playback, and awaited hangup releases media", async () => {
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
  expect(state.mouth).toBe(0);
  expect(f.interrupts).toBe(1);
  expect(events.some(event => event.type === "playback.stopped" && event.reason === "interrupted")).toBe(true);
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

/** The production adapter against the production session service, with fake media and a fake provider. */
async function served() {
  const { CompanionStorage } = await import("./storage");
  const { CompanionAdmission } = await import("./admission");
  const { CompanionLiveSessions } = await import("./liveSession");
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
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
    advance(ms: number) { clock += ms; },
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

test("played audio reaches its own line in any order: audio before text, text before audio, text after the audio stopped, the next answer and a barge-in", async () => {
  const f = await served();
  // Audio before its words: the mouth moves at once, and the line it belongs to plays when its words arrive.
  f.callbacks.playback({ speaking: true, rms: 0.6, playedMs: 0 });
  expect(f.state.mouth).toBe(0.6);
  await f.says("Hello, I can help with the board.");
  expect(f.lines()).toEqual([["Hello, I can help with the board.", "playing", null]]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 1_000 });
  expect(f.lines()).toEqual([["Hello, I can help with the board.", "played", null]]);
  expect(f.state.mouth).toBe(0);
  // The next answer, words first: its audio is its own and leaves the first line alone.
  f.advance(2_000);
  await f.says("The plan is ready.");
  expect(f.lines().at(-1)).toEqual(["The plan is ready.", "pending", null]);
  f.callbacks.playback({ speaking: true, rms: 0.4, playedMs: 0 });
  expect(f.lines().map(line => line[1])).toEqual(["played", "playing"]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 700 });
  expect(f.lines().map(line => line[1])).toEqual(["played", "played"]);
  // Words that arrive after their audio stopped are shown as played.
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
  await f.says("Done.");
  expect(f.lines().map(line => line[1])).toEqual(["played", "played", "played"]);
  // A barge-in cuts audio whose words have not arrived; they arrive marked cut where it stopped.
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 300 });
  f.callbacks.input(true);
  expect(f.state.mouth).toBe(0);
  await f.says("Here is a long answer that was cut.");
  expect(f.lines().at(-1)).toEqual(["Here is a long answer that was cut.", "cut", 300]);
  f.callbacks.input(false);
  // A short pause inside one line continues that line's audio; nothing else takes it.
  f.advance(2_000);
  await f.says("First part. Second part.");
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 600 });
  f.advance(400);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 200 });
  expect([f.lines().at(-1)![1], f.state.playedMs]).toEqual(["playing", 800]);
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 300 });
  expect(f.lines().map(line => line[1])).toEqual(["played", "played", "played", "cut", "played"]);
  // No line without words carries playback.
  expect(f.state.lines.filter(line => line.speaker === "companion" && !line.text)).toEqual([]);
  await f.adapter.dispose();
});

test("late words reach their own audio oldest first: a finished answer keeps its words when the next one is already playing, and a barge-in cuts only the next", async () => {
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
      f.callbacks.input(true);
      expect(f.lines()).toEqual([["First answer.", "played", null], ["Second answer.", "cut", 200]]);
    } else {
      f.callbacks.playback({ speaking: false, rms: 0, playedMs: 700 });
      expect(f.lines().map(line => line[1])).toEqual(["played", "played"]);
    }
    await f.adapter.dispose();
  }
});

test("a barge-in during the next answer, before either answer's words arrive, leaves the earlier one played and the next one cut", async () => {
  const f = await served();
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: false, rms: 0, playedMs: 900 });
  f.advance(2_000);
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 0 });
  f.callbacks.playback({ speaking: true, rms: 0.5, playedMs: 250 });
  f.callbacks.input(true);
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
    f.callbacks.input(true);
    expect(rows()).toEqual([["First answer.", "played"], ["Second answer.", "cut"]]);
    await f.adapter.dispose();
  }
});
