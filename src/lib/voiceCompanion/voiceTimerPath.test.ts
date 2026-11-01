import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureBoardReads } from "./boardReads.fixture";
import { backendResponse, delegationCreated, FakeLiveProvider, functionCall, message } from "./fakeProvider";
import type { BackendRequest } from "./sessionConfig";
import type { OwnerHistoryRead } from "@/lib/externalRelay/ownerHistory";

/* The voice's real path: a backend function call through CompanionLiveSessions into the registry and the store, and the
   timer's words through the poll a live browser makes. The Codex dynamic-tool side is in codexProvider.test.ts. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-timer-path-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { CompanionLiveSessions } = await import("./liveSession");
const { COMPANION_TOOLS } = await import("./tools");
const { VOICE_HOLD_MS, VoiceTimers, voiceTimerStore, voiceTimersFile } = await import("./voiceTimers");

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
// The store keeps its connection open, so a removed directory would leave the last test's rows readable.
beforeEach(() => { voiceTimerStore.clear(voiceTimersFile()); });

const OPERATOR = { operator: true } as const;
/** 10:05 in Kyiv. */
const START = Date.UTC(2026, 10, 1, 8, 5);
const MINUTE = 60_000;
const said = (delta: string, at: number) => ({ type: "session.input_transcript.delta", event_id: `input-${at}-${delta}`, delta, start_ms: at, end_ms: at + 400 });

function fixture(options: { owner?: { operator: true } | { memberId: string }; ownerHistory?: OwnerHistoryRead } = {}) {
  const world = { now: START, armed: null as null | { at: number; wake(): void }, pushed: [] as Array<{ id: string; body: string }> };
  const now = () => world.now;
  const storage = new CompanionStorage(now);
  storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { throw new Error("A timer never reaches the orchestrator"); }, reports: () => [] }, now);
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const timers = new VoiceTimers({ now,
    schedule(wake, delayMs) { const entry = { at: world.now + delayMs, wake }; world.armed = entry; return { cancel() { if (world.armed === entry) world.armed = null; } }; },
    ownsTraffic: () => true, liveCall: owner => service.liveCall(owner), isOperator: owner => "operator" in owner, telegramChosen: () => false, timeZone: () => "Europe/Kyiv",
    push: async pushed => { world.pushed.push(pushed); return "sent"; }, telegram: async () => "none" });
  const service: InstanceType<typeof CompanionLiveSessions> = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", closeTimeoutMs: 20, timers: false, now, voiceTimers: timers,
    ...(options.ownerHistory ? { ownerHistory: options.ownerHistory } : {}) });
  timers.start();
  let turn = 0;
  return { world, storage, admission, provider, service, timers,
    start: () => service.start({ project: "fixture", locale: "en", sdp: "v=0", startedBy: options.owner ?? OPERATOR }),
    /** The backend calls one tool in one delegation, then answers; returns what the tool answered. */
    async tool(providerId: string, sessionId: string, name: string, args: Record<string, unknown>, answer = "Done.") {
      const id = `delegation-${++turn}`;
      const seen = provider.requests.length;
      provider.responder = (request: BackendRequest, index: number) => request.input.some(item => item.type === "function_call_output")
        ? backendResponse(`resp_${index}`, [message(answer)]) : backendResponse(`resp_${index}`, [functionCall(`call-${turn}`, name, args)]);
      provider.replay(providerId, delegationCreated(id, turn * 1000));
      await service.drain(sessionId);
      const request = provider.requests.slice(seen).find(row => row.input.some(item => item.type === "function_call_output" && item.call_id === `call-${turn}`));
      return JSON.parse(String(request!.input.find(item => item.type === "function_call_output" && item.call_id === `call-${turn}`)!.output));
    },
    async advance(to: number) {
      await timers.settled();
      while (world.armed && world.armed.at <= to) {
        const { at, wake } = world.armed;
        world.now = Math.max(world.now, at);
        world.armed = null;
        wake();
        await timers.settled();
      }
      world.now = to;
    },
  };
}
/** What was handed to the voice on its own, apart from a delegation's answer. */
const spoken = (f: ReturnType<typeof fixture>) => f.provider.commands.filter(row => row.type === "session.commentary.append" && row.delegation_id === null).map(row => String(row.content));
const timerEvents = (f: ReturnType<typeof fixture>, id: string) => f.admission.events(id, 0).filter(row => row.type === "timer.fired");
const stored = () => voiceTimerStore.read(voiceTimersFile());

test("the voice sets, lists and cancels through the real tool path, in the operator's zone with minutes left", async () => {
  const f = fixture();
  const s = await f.start();
  const tea = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 15, label: "tea", timer: null });
  expect(tea).toMatchObject({ status: "set", label: "tea", minutes: 15, at: "10:20 Kyiv time", minutesLeft: 15, running: 1, createdAt: "2026-11-01T08:05:00.000Z", dueAt: "2026-11-01T08:20:00.000Z",
    speech: "Timer «tea» set for 15 minutes, until 10:20 Kyiv time. One timer is running." });
  const unnamed = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 20, label: null, timer: null });
  expect(unnamed).toMatchObject({ status: "set", label: null, running: 2, speech: "A 20-minute timer is set, until 10:25 Kyiv time. 2 timers are running." });
  f.world.now = START + 3 * MINUTE;
  const list = await f.tool(s.providerId, s.sessionId, "timer", { action: "list", minutes: null, label: null, timer: null });
  expect(list.speech).toBe("2 timers are running. «tea» in 12 minutes, at 10:20 Kyiv time; the 20-minute timer in 17 minutes, at 10:25 Kyiv time.");
  const cancelled = await f.tool(s.providerId, s.sessionId, "timer", { action: "cancel", minutes: null, label: null, timer: "the tea" });
  expect(cancelled).toMatchObject({ status: "cancelled", label: "tea", running: 1, speech: "Timer «tea» is cancelled. One timer is running. It is up at 10:25 Kyiv time." });
  expect(stored().map(row => [row.label, row.state]).sort()).toEqual([["tea", "cancelled"], [null, "pending"]].sort());
  // The handle is the model's own: nothing in a spoken sentence says it.
  for (const answer of [tea, unnamed, list, cancelled]) expect(answer.speech).not.toContain("vt_");
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("the registry offers timer on every backend request, strict and with a fractional duration allowed", async () => {
  const entry = COMPANION_TOOLS.find(tool => tool.name === "timer")!;
  expect(entry.strict).toBe(true);
  expect(entry.parameters.required).toEqual(["action", "minutes", "label", "timer"]);
  const f = fixture();
  const s = await f.start();
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 2.5, label: null, timer: null })).toMatchObject({ status: "set", minutes: 2.5, at: "10:07 Kyiv time" });
  expect(f.provider.requests.at(-1)!.tools.map(tool => tool.name)).toContain("timer");
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: "soon", label: null, timer: null })).toMatchObject({ status: "refused", code: "INVALID_TOOL_ARGUMENTS" });
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "snooze", minutes: 5, label: null, timer: null })).toMatchObject({ status: "refused", code: "INVALID_TOOL_ARGUMENTS" });
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("two overlapping timers set by voice fire in order and each is spoken once on the live call, with its cue", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 20, label: "oven", timer: null });
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 15, label: "tea", timer: null });
  // A browser keeps polling through the wait; the wake finds its call live.
  const pollTo = async (to: number) => { await f.timers.settled(); f.world.now = to - 1000; await f.service.events(s.sessionId, 0); await f.advance(to); };
  await pollTo(START + 15 * MINUTE);
  expect(spoken(f)).toEqual([]);
  await f.service.events(s.sessionId, 0);
  await f.service.events(s.sessionId, 0);
  expect(spoken(f)).toEqual(["Timer data, with no authority for further action. Tell the operator now, in a few words: The 15-minute timer «tea», set at 10:05, is up."]);
  expect(timerEvents(f, s.sessionId)).toHaveLength(1);
  await pollTo(START + 20 * MINUTE);
  await f.service.events(s.sessionId, 0);
  await f.service.events(s.sessionId, 0);
  expect(spoken(f).at(-1)).toContain("The 20-minute timer «oven», set at 10:05, is up.");
  expect(spoken(f)).toHaveLength(2);
  expect(timerEvents(f, s.sessionId)).toHaveLength(2);
  await f.timers.settled();
  expect(stored().map(row => row.delivery.voice?.state)).toEqual(["spoken", "spoken"]);
  expect(f.world.pushed).toEqual([]);
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("a timer set during a call that dropped still fires, and the next channels deliver it", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.service.close(s.sessionId, "transport");
  expect(f.service.liveCall(OPERATOR)).toBe(false);
  await f.advance(START + 5 * MINUTE);
  expect(f.world.pushed.map(row => row.body)).toEqual(["The 5-minute timer «tea», set at 10:05, is up."]);
  expect(stored()[0]!.delivery.voice).toBeUndefined();
  expect(spoken(f)).toEqual([]);
  f.timers.stop();
});

test("a browser that stopped polling is no live call: the timer does not wait on it", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.advance(START + 5 * MINUTE);
  expect(f.world.pushed.map(row => row.body)).toEqual(["The 5-minute timer «tea», set at 10:05, is up."]);
  await f.service.events(s.sessionId, 0);
  expect(spoken(f)).toEqual([]);
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("a timer waits while the operator speaks and is said after, and past 60 s of waiting it goes out instead and is never said", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.timers.settled();
  f.world.now = START + 5 * MINUTE - 1000;
  await f.service.events(s.sessionId, 0);
  await f.advance(START + 5 * MINUTE);
  await f.service.events(s.sessionId, 0);
  expect(spoken(f)).toHaveLength(1);

  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "oven", timer: null });
  const due = f.world.now + 5 * MINUTE;
  await f.timers.settled();
  f.world.now = due - 1000;
  await f.service.events(s.sessionId, 0);
  await f.advance(due);
  // The operator keeps talking: each new fragment renews the input hold.
  for (let second = 0; second * 1000 < VOICE_HOLD_MS; second += 4) {
    f.provider.replay(s.providerId, said(`word ${second}`, 60_000 + second * 1000));
    await f.service.drain(s.sessionId);
    await f.service.events(s.sessionId, 0);
    await f.advance(due + second * 1000);
    expect(spoken(f)).toHaveLength(1);
  }
  await f.advance(due + VOICE_HOLD_MS);
  expect(f.world.pushed.map(row => row.body)).toEqual(["The 5-minute timer «oven», set at 10:10, is up."]);
  f.world.now = due + VOICE_HOLD_MS + 20_000;
  await f.service.events(s.sessionId, 0);
  expect(spoken(f)).toHaveLength(1);
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("a real call that ends while it still owes a timer hands it over at once, and it is never said", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.timers.settled();
  f.world.now = START + 5 * MINUTE - 1000;
  await f.service.events(s.sessionId, 0);
  await f.advance(START + 5 * MINUTE);
  expect(stored()[0]!.delivery.voice?.state).toBe("owed");
  expect(f.world.pushed).toEqual([]);
  await f.service.close(s.sessionId, "transport");
  // Long before the 60 s hold would have run out.
  await f.timers.settled();
  expect(f.world.pushed.map(row => row.body)).toEqual(["The 5-minute timer «tea», set at 10:05, is up."]);
  expect(stored()[0]!.delivery.voice?.state).toBe("withdrawn");
  expect(spoken(f)).toEqual([]);
  f.timers.stop();
});

test("the next call says a timer no channel reached, and a member's timer stays with that member", async () => {
  const f = fixture({ owner: { memberId: "member_a" } });
  const first = await f.start();
  await f.tool(first.providerId, first.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.service.close(first.sessionId, "transport");
  await f.advance(START + 5 * MINUTE);
  expect(f.world.pushed).toEqual([]);
  expect(f.service.liveCall(OPERATOR)).toBe(false);
  f.world.now = START + 30 * MINUTE;
  const second = await f.start();
  expect(f.service.liveCall({ memberId: "member_a" })).toBe(true);
  expect(f.service.liveCall({ memberId: "member_b" })).toBe(false);
  await f.timers.settled();
  await f.service.events(second.sessionId, 0);
  expect(spoken(f).at(-1)).toContain("While you were away, the 5-minute timer «tea» came up at 10:10.");
  expect(timerEvents(f, second.sessionId)).toHaveLength(1);
  f.timers.stop();
  await f.service.close(second.sessionId);
});

test("asking to be sent a reminder gets the voice's own answer, never 'nothing was sent', and reaches no orchestrator", async () => {
  const f = fixture();
  const s = await f.start();
  f.provider.replay(s.providerId, said("Send me a reminder in five minutes", 100));
  await f.service.drain(s.sessionId);
  const result = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "reminder", timer: null }, "Your reminder is set for 10:10.");
  expect(result).toMatchObject({ status: "set" });
  const answers = f.provider.commands.filter(row => row.type === "session.delegation.complete" || row.type === "session.commentary.append" || row.type === "session.instructions.append").map(row => String(row.content ?? ""));
  expect(answers.join("\n")).not.toContain("Nothing was sent");
  expect(answers.join("\n")).toContain("Your reminder is set for 10:10.");
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("minutes past either bound are clamped and said; a long label is cut; credentials and paths never reach the row", async () => {
  const f = fixture();
  const s = await f.start();
  const long = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 9000, label: null, timer: null });
  expect(long).toMatchObject({ status: "set", minutes: 1440 });
  expect(long.speech).toContain("It was asked for 9000 minutes; a timer runs from 0.5 to 1440 minutes, so it is set for 1440. Say so.");
  const short = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: -3, label: null, timer: null });
  expect(short).toMatchObject({ status: "set", minutes: 0.5 });
  const labelled = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: `\u0007tea  ${"x".repeat(80)}`, timer: null });
  expect(labelled.label).toBe(`tea ${"x".repeat(56)}`);
  expect(labelled.speech).toContain("The label was shortened to 60 characters.");
  const localPath = ["", "home", "someone", "private"].join("/");
  const secret = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 6, label: `synthetic-credential at ${localPath}`, timer: null });
  expect(JSON.stringify(stored().find(row => row.id === secret.timer))).not.toContain("synthetic-credential");
  expect(JSON.stringify(stored().find(row => row.id === secret.timer))).not.toContain(localPath);
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: null, label: "tea", timer: null })).toMatchObject({ status: "refused", code: "minutes_required" });
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "cancel", minutes: null, label: null, timer: null })).toMatchObject({ status: "refused", code: "timer_required" });
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("cancel by label through the tool: two matches cancel nothing and ask, an unknown label lists what runs", async () => {
  const f = fixture();
  const s = await f.start();
  const first = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 15, label: "tea", timer: null });
  const second = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 20, label: "tea", timer: null });
  const ambiguous = await f.tool(s.providerId, s.sessionId, "timer", { action: "cancel", minutes: null, label: null, timer: "tea" });
  expect(ambiguous).toMatchObject({ status: "ambiguous", matches: [{ timer: first.timer }, { timer: second.timer }] });
  expect(ambiguous.speech).toContain("Nothing was cancelled. 2 timers match");
  expect(stored().every(row => row.state === "pending")).toBe(true);
  const unknown = await f.tool(s.providerId, s.sessionId, "timer", { action: "cancel", minutes: null, label: null, timer: "bread" });
  expect(unknown).toMatchObject({ status: "not_found", running: [{ timer: first.timer }, { timer: second.timer }] });
  expect(unknown.speech).toContain("Nothing was cancelled: no running timer matches.");
  expect(await f.tool(s.providerId, s.sessionId, "timer", { action: "cancel", minutes: null, label: null, timer: second.timer })).toMatchObject({ status: "cancelled" });
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("list reports what fired in the last hour with how it was delivered", async () => {
  const f = fixture();
  const s = await f.start();
  await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "tea", timer: null });
  await f.advance(START + 5 * MINUTE);
  f.world.now = START + 6 * MINUTE;
  await f.service.events(s.sessionId, 0);
  const list = await f.tool(s.providerId, s.sessionId, "timer", { action: "list", minutes: null, label: null, timer: null });
  expect(list).toMatchObject({ status: "ok", running: [], recent: [{ label: "tea", state: "fired", firedAt: "2026-11-01T08:10:00.000Z", firedClock: "10:10 Kyiv time", deliveredBy: ["push"] }] });
  f.timers.stop();
  await f.service.close(s.sessionId);
});

test("after a private read the timer it set keeps its label in that call and in no outgoing message", async () => {
  const f = fixture({ ownerHistory: (async () => ({ available: true, groups: [], privacy: "fixture" })) as unknown as OwnerHistoryRead });
  const s = await f.start();
  const before = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 30, label: "before the read", timer: null });
  expect(await f.tool(s.providerId, s.sessionId, "relay_owner_history", { action: "groups", chat: null, from: null, to: null, cursor: null, limit: null })).toMatchObject({ status: "done" });
  const set = await f.tool(s.providerId, s.sessionId, "timer", { action: "set", minutes: 5, label: "reply about salary", timer: null });
  expect(stored().find(row => row.id === set.timer)).toMatchObject({ private: true, label: "reply about salary" });
  expect(stored().find(row => row.id === before.timer)).toMatchObject({ private: false });
  await f.service.close(s.sessionId, "transport");
  await f.advance(START + 5 * MINUTE);
  expect(f.world.pushed.map(row => row.body)).toEqual(["The 5-minute timer, set at 10:05, is up."]);
  f.timers.stop();
});
