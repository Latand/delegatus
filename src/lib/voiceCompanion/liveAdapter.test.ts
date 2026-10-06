import { expect, test } from "bun:test";
import { OfficialVoiceCompanionAdapter } from "./liveAdapter";
import { INITIAL_COMPANION_STATE, reduceCompanion } from "./reducer";
import type { CompanionEvent } from "./contract";
import type { MediaCallbacks, CompanionMedia } from "./media";

function fixture() {
  let callbacks!: MediaCallbacks;
  let opens = 0, closes = 0, muted = false, interrupts = 0;
  const requests: Record<string, unknown>[] = [];
  let serverEvents: CompanionEvent[] = [];
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ ...payload, sessionId: "fixture-session", version: 1, generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: seq }) as CompanionEvent;
  const media: CompanionMedia = { open: async () => { opens++; return "v=0"; }, answer: async () => {}, mute: value => { muted = value; },
    interrupt: () => { interrupts++; }, close: async () => { closes++; } };
  const adapter = new OfficialVoiceCompanionAdapter({ pollMs: 100_000, media: cb => { callbacks = cb; return media; },
    fetch: (async (_url, init) => {
      if (!init?.body) return Response.json({ events: serverEvents });
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (body.action === "start") { serverEvents = [event({ type: "session.ready", mode: "official-realtime" })]; return Response.json({ sessionId: "fixture-session", sdp: "fake-answer" }); }
      if (body.action === "close") serverEvents.push(event({ type: "session.closed", reason: "operator", incomplete: false }));
      return Response.json({ ok: true });
    }) as typeof fetch });
  return { adapter, requests, media, event, push: (value: CompanionEvent) => serverEvents.push(value), get callbacks() { return callbacks; },
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
