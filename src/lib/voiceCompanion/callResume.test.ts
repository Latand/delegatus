import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallMemory, type CallSummarizer } from "./callMemory";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { FakeLiveProvider, delegationCreated, backendResponse, functionCall, message } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";
import { voiceClock } from "./voiceClock";

/*
 * A call that drops (the provider's session ends, the browser's connection is lost, the Viewer restarts) keeps
 * its conversation in the call journal, and a reconnect continues the same conversation: the new provider session
 * starts with what was said, bounded by the call-memory budget, with a marker where older lines were left out.
 * Synthetic speech only.
 */

/** The call-memory budget a new provider session was proven to start with (docs/design/voice-call-memory.md). */
const CONTINUATION_BUDGET = 2400;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "call-resume-"));
let sequence = 0;
beforeEach(() => { const directory = path.join(root, String(++sequence)); process.env.LLV_STATE_DIR = path.join(directory, "state"); process.env.XDG_CONFIG_HOME = path.join(directory, "config"); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const summary = { asked: ["Review the build."], done: ["Passed the request on."], decided: ["Keep the layout."], open: ["Wait for the report."] };
function harness(backend: "api" | "codex" = "api", model: CallSummarizer = async () => ({ answer: summary, durationMs: 1, inputTokens: 1, outputTokens: 1, model: "fixture-haiku" })) {
  let now = Date.UTC(2026, 9, 22, 12);
  const storage = new CompanionStorage(() => now); storage.updateSettings({ enabled: true, backend });
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, () => now);
  const provider = new FakeLiveProvider(); if (backend === "codex") Object.defineProperty(provider, "backend", { value: "codex" });
  const memory = new CallMemory(storage, admission.records, model, () => now, 1000);
  /* A restarted Viewer brings its own state, records and call memory: one writer per journal, as in production. */
  const build = (state = storage, gate = admission) => new CompanionLiveSessions(state, gate, fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), provider,
    { memory: gate === admission ? memory : new CallMemory(state, gate.records, model, () => now, 1000), key: () => "synthetic-credential", timers: false, now: () => now, closeTimeoutMs: 10,
      ownerHistory: async () => ({ available: true, title: "private title sentinel", chat: "private-sentinel", timeZone: "UTC", start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", oldestStoredAt: null,
        messages: [{ messageId: 1, sentAt: "2026-10-22T09:00:00Z", author: { name: "private member sentinel", username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, text: "private message sentinel", media: null, truncated: false }], nextCursor: null, privacy: OWNER_HISTORY_PRIVACY }) });
  return { storage, admission, provider, memory, service: build(), build, advance: (ms: number) => { now += ms; }, now: () => now };
}
type Harness = ReturnType<typeof harness>;
type Starter = { operator: true } | { memberId: string };
const operator: Starter = { operator: true };
const start = (h: Harness, extra: { resume?: string; startedBy?: Starter } = {}) =>
  h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy: extra.startedBy ?? operator, ...(extra.resume ? { resume: extra.resume } : {}) });
/** Operator and voice speech as the provider sends it: each turn its own timed fragment, settled by the next speaker. */
function say(h: Harness, providerId: string, turns: Array<["operator" | "voice", string]>, from = 0) {
  turns.forEach(([speaker, text], index) => h.provider.replay(providerId, { type: speaker === "operator" ? "session.input_transcript.delta" : "session.output_transcript.delta",
    event_id: `${providerId}-turn-${from + index}`, delta: text, start_ms: (from + index) * 4000, end_ms: (from + index) * 4000 + 3000 }));
}
const ending = (h: Harness, id: string) => h.admission.transcriptRecord(id).entries.find(row => row.kind === "session_end")?.data.reason;

test("retry schedule, ticks and End are bounded by the store's runnable clock; reload only offers", async () => {
  const { createCompanionStore } = await import("@/hooks/useVoiceCompanion");
  let now = 0, seq = 0, starts = 0, runnable = true;
  const timers = new Map<number, { at: number; run: () => void }>(); let timerId = 0;
  const schedule = (run: () => void, ms: number) => { const id = ++timerId; timers.set(id, { at: now + ms, run }); return () => { timers.delete(id); }; };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async (ms: number) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].run(); await flush(); } now = end; await flush(); };
  let listener: (event: import("./contract").CompanionEvent) => void = () => {};
  const sounds: string[] = []; const attempts: number[] = []; const ticks: number[] = [];
  const adapter: import("./contract").VoiceCompanionAdapter = { mode: "official-realtime", subscribe: cb => { listener = cb; return () => {}; },
    start: async options => { starts++; if (options.resume) { attempts.push(now); throw new Error("PROVIDER_ERROR"); } emit({ type: "session.ready", mode: "official-realtime" }); },
    command: async () => {}, close: async () => {}, resumable: async () => ({ sessionId: "part", project: "fixture" }), reconnect: status => { sounds.push(status); if (status === "tick") ticks.push(now); } };
  const emit = (payload: import("./contract").Payload) => listener({ ...payload, version: 1, sessionId: "part", generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: now } as import("./contract").CompanionEvent);
  const store = createCompanionStore(adapter, { now: () => now, random: () => 0.5, schedule, runnable: () => runnable });
  const dispose = store.connect(); await flush(); await advance(60_000);
  expect(starts).toBe(0); expect(store.get().resumable?.sessionId).toBe("part");
  await store.start({ project: "fixture", locale: "en" });
  emit({ type: "transcript.snapshot", speaker: "companion", itemId: "reply", text: "The build passed.", final: true });
  emit({ type: "error", code: "CONNECTION_LOST", recoverable: false });
  expect(store.get().phase).toBe("reconnecting");
  await advance(3_150);
  expect(attempts).toEqual([60_150, 61_150, 63_150]);
  runnable = false; await advance(90_000); expect(attempts).toHaveLength(3);
  runnable = true; await advance(60_000);
  expect(attempts).toHaveLength(8); expect(store.get().phase).toBe("offline");
  expect(store.get().error).toBe("RECONNECT_GAVE_UP"); expect(sounds.filter(x => x === "gave-up")).toHaveLength(1);
  expect(sounds).toContain("tick"); expect(store.get().resumable?.sessionId).toBe("part");
  expect(ticks.slice(1).every((time, index) => time - ticks[index] === 5_000)).toBe(true);
  await store.stop(); dispose(); expect(timers.size).toBe(0);
});

test("slow attempts stop at sixty runnable seconds before reaching eight attempts", async () => {
  const { createCompanionStore } = await import("@/hooks/useVoiceCompanion");
  let now = 0, attempts = 0, seq = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const schedule = (run: () => void, ms: number) => { const timer = { run, at: now + ms }; timers.add(timer); return () => { timers.delete(timer); }; };
  let listener: (event: import("./contract").CompanionEvent) => void = () => {};
  const emit = (payload: import("./contract").Payload) => listener({ ...payload, version: 1, sessionId: "part", generation: 1, seq: ++seq, eventId: `event-${seq}`, atMs: now } as import("./contract").CompanionEvent);
  const adapter: import("./contract").VoiceCompanionAdapter = { mode: "official-realtime", subscribe: cb => { listener = cb; return () => {}; }, command: async () => {}, close: async () => {},
    start: async options => {
      if (options.resume) { attempts++; await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error("PROVIDER_ERROR")), { once: true })); }
      else emit({ type: "session.ready", mode: "official-realtime" });
    } };
  const store = createCompanionStore(adapter, { now: () => now, schedule, random: () => 0.5 }); const dispose = store.connect();
  try {
    await store.start({ project: "fixture", locale: "en" }); emit({ type: "transcript.final", speaker: "companion", itemId: "reply", text: "The build passed." }); emit({ type: "error", code: "CONNECTION_LOST", recoverable: false });
    for (now = 100; now <= 60_000; now += 100) {
      for (const timer of [...timers].filter(timer => timer.at <= now)) { timers.delete(timer); timer.run(); }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (now < 60_000) expect(store.get().phase).toBe("reconnecting");
    }
    expect(attempts).toBe(4); expect(store.get().phase).toBe("offline"); expect(store.get().error).toBe("RECONNECT_GAVE_UP");
  } finally { await store.stop(); dispose(); }
  expect(timers.size).toBe(0);
});

test("same-key replay keeps the minted resume open; a new key leases the newest unpolled part across restart", async () => {
  const h = harness();
  const p = await start(h);
  say(h, p.providerId, [["voice", "The build passed."]]); await h.service.drain(p.sessionId);
  await h.service.close(p.sessionId, "transport", "ice-failed");
  const input = { project: "fixture", locale: "en" as const, sdp: "v=0", startedBy: operator, resume: p.sessionId, requestId: "resume-one" };
  const n = await h.service.start(input);
  expect(await h.service.start(input)).toEqual(n);
  expect(h.admission.session(n.sessionId).closed).toBe(false);
  const n2 = await h.service.start({ ...input, requestId: "resume-two" });
  expect(h.provider.attached).toBe(1);
  expect(h.admission.transcriptRecord(n.sessionId).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "answer-lost" });
  expect(h.admission.transcriptRecord(n2.sessionId).entries.find(row => row.kind === "session_start")?.data.resumes).toBe(n.sessionId);
  expect(h.storage.read().sessions[p.sessionId].resumedBy).toBe(n.sessionId);
  await expect(h.service.start(input)).rejects.toThrow("SESSION_CLOSED");
  await h.service.close(n2.sessionId, "transport");
  const state = new CompanionStorage(h.now);
  const gate = new CompanionAdmission(state, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, h.now);
  const restarted = h.build(state, gate);
  const n3 = await restarted.start({ ...input, requestId: "resume-three" });
  expect(gate.transcriptRecord(n3.sessionId).entries.find(row => row.kind === "session_start")?.data.resumes).toBe(n2.sessionId);
  await restarted.close(n3.sessionId);
});

test("concurrent same-key resumes join the pending mint after recovery", async () => {
  const h = harness(); const p = await start(h);
  say(h, p.providerId, [["voice", "The build passed."]]); await h.service.drain(p.sessionId); await h.service.close(p.sessionId, "transport");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const create = h.provider.create.bind(h.provider);
  h.provider.create = async (...args) => { entered(); await held; return create(...args); };
  const input = { project: "fixture", locale: "en" as const, sdp: "v=0", requestId: "concurrent", resume: p.sessionId, startedBy: operator };
  const one = h.service.start(input), two = h.service.start(input).then(answer => ({ answer }), error => ({ error: (error as Error).message }));
  try {
    await reached; expect(Object.keys(h.storage.read().sessions)).toHaveLength(2); release();
    const first = await one; expect(await two).toEqual({ answer: first }); expect(h.provider.sessions).toHaveLength(2); expect(h.provider.attached).toBe(1);
    await h.service.close(first.sessionId);
  } finally { release(); }
});

test("a page following an older part cannot close a successor another page polls", async () => {
  const h = harness(); const p = await start(h);
  say(h, p.providerId, [["voice", "The build passed."]]); await h.service.drain(p.sessionId);
  await h.service.close(p.sessionId, "transport");
  const n = await start(h, { resume: p.sessionId }); await h.service.events(n.sessionId, 0);
  await expect(start(h, { resume: p.sessionId })).rejects.toThrow("SESSION_UNAVAILABLE");
  expect(h.admission.session(n.sessionId).closed).toBe(false); expect(h.provider.sessions).toHaveLength(2);
  await h.service.close(n.sessionId);
});

test("a fresh process offers the persisted call without retrying, then a manual start follows its persisted lease", async () => {
  const h = harness(); const p = await start(h);
  say(h, p.providerId, [["voice", "The build passed."]]); await h.service.drain(p.sessionId); await h.service.close(p.sessionId, "transport");
  const n = await start(h, { resume: p.sessionId }); await h.service.close(n.sessionId, "transport"); await h.memory.drain();
  const child = Bun.spawn([process.execPath, "-e", `
    import { CompanionStorage } from "./src/lib/voiceCompanion/storage";
    import { CompanionAdmission } from "./src/lib/voiceCompanion/admission";
    import { CompanionLiveSessions } from "./src/lib/voiceCompanion/liveSession";
    import { FakeLiveProvider } from "./src/lib/voiceCompanion/fakeProvider";
    import { fixtureBoardReads } from "./src/lib/voiceCompanion/boardReads.fixture";
    import { createCompanionStore } from "./src/hooks/useVoiceCompanion";
    const now = () => Number(process.env.VOICE_FIXTURE_NOW);
    const storage = new CompanionStorage(now);
    const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, now);
    const service = new CompanionLiveSessions(storage, admission, fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), new FakeLiveProvider(), { now, timers: false, key: () => "synthetic-credential" });
    let starts = 0, current = null; const listeners = new Set();
    const store = createCompanionStore({ mode: "official-realtime", subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      resumable: async () => service.resumable({ operator: true }), command: async () => {},
      start: async input => { starts++; current = await service.start({ ...input, sdp: "v=0", startedBy: { operator: true } }); for (const event of await service.events(current.sessionId, 0)) for (const listener of listeners) listener(event); },
      close: async () => { if (current) await service.close(current.sessionId); }
    }, { schedule: () => () => {} });
    const dispose = store.connect(); for (let i = 0; i < 30; i++) await Promise.resolve();
    const offered = store.get().resumable?.sessionId; const automaticStarts = starts;
    await store.start({ project: "fixture", locale: "en", resume: process.env.VOICE_FIXTURE_RESUME });
    const resumedFrom = admission.transcriptRecord(current.sessionId).entries.find(row => row.kind === "session_start").data.resumes;
    await store.stop(); dispose();
    console.log(JSON.stringify({ offered, automaticStarts, manualStarts: starts, resumedFrom }));
  `], { cwd: process.cwd(), env: { ...process.env, VOICE_FIXTURE_NOW: String(h.now()), VOICE_FIXTURE_RESUME: p.sessionId }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(), diagnostic = await new Response(child.stderr).text();
  expect({ exit: await child.exited, diagnostic }).toEqual({ exit: 0, diagnostic: "" });
  expect(JSON.parse(output)).toEqual({ offered: n.sessionId, automaticStarts: 0, manualStarts: 1, resumedFrom: n.sessionId });
});

for (const reason of ["connection_lost", "expired", "remote_hangup", "content"] as const) test(`provider close ${reason}: final usage preserves the close cause and resume eligibility`, async () => {
  const h = harness();
  const first = await start(h);
  say(h, first.providerId, [["operator", "Check the build."], ["voice", "The build passed."]]);
  await h.service.drain(first.sessionId);
  h.provider.replay(first.providerId, { type: "session.closed", event_id: `closed-${reason}`, reason, usage: { seconds: 24 } });
  await h.service.drain(first.sessionId);
  const end = h.admission.transcriptRecord(first.sessionId).entries.find(row => row.kind === "session_end")!;
  expect(end.data).toMatchObject({ reason: reason === "content" ? "content" : "transport", cause: `provider-${reason}`, seconds: 24 });
  expect(h.service.resumable(operator)?.sessionId ?? null).toBe(reason === "content" ? null : first.sessionId);
  // Both the persisted state and the journal reader retain the same end after restart.
  const state = new CompanionStorage(h.now);
  const gate = new CompanionAdmission(state, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, h.now);
  const restarted = h.build(state, gate);
  expect(restarted.transcriptRecord(first.sessionId).entries.find(row => row.kind === "session_end")?.data).toEqual(end.data);
  expect(restarted.resumable(operator)?.sessionId ?? null).toBe(reason === "content" ? null : first.sessionId);
});

test("an unsolicited native Codex close is a resumable sideband drop; an operator close stays a hang-up", async () => {
  const h = harness("codex"); const part = await start(h);
  say(h, part.providerId, [["voice", "The build passed."]]); await h.service.drain(part.sessionId);
  h.provider.replay(part.providerId, { type: "session.closed", event_id: "native-close" }); await h.service.drain(part.sessionId);
  expect(h.admission.transcriptRecord(part.sessionId).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "sideband" });
  expect(h.service.resumable(operator)?.sessionId).toBe(part.sessionId);
  const next = await start(h, { resume: part.sessionId }); await h.service.close(next.sessionId);
  expect(ending(h, next.sessionId)).toBe("operator"); expect(h.service.resumable(operator)).toBeNull();
});

test("a provider drop final arriving after End cannot turn the hang-up into a resumable call", async () => {
  const h = harness(); const part = await start(h);
  say(h, part.providerId, [["voice", "The build passed."]]); await h.service.drain(part.sessionId);
  h.provider.autoClose = false;
  const ended = h.service.close(part.sessionId, "operator");
  h.provider.replay(part.providerId, { type: "session.closed", event_id: "late-drop-final", reason: "connection_lost", usage: { seconds: 18 } });
  await h.service.drain(part.sessionId); await ended;
  expect(ending(h, part.sessionId)).toBe("operator"); expect(h.service.resumable(operator)).toBeNull();
});
/** Waits until the dropped part is closed and its journal ends, however long the close chain takes under load. */
async function closed(h: Harness, id: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (h.admission.session(id).closed && ending(h, id) !== undefined) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`session ${id} never closed`);
}

for (const backend of ["api", "codex"] as const) test(`${backend}: a call whose provider session drops resumes with its conversation in both contexts and one record`, async () => {
  const h = harness(backend);
  const first = await start(h);
  say(h, first.providerId, [["operator", "Check the search lane."], ["voice", "The search lane passed its verifier."], ["operator", "And the phone review?"]]);
  await h.service.drain(first.sessionId);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  expect(ending(h, first.sessionId)).toBe("transport");
  /* The dropped call is offered back to the operator who had it, and its whole record is still readable. */
  expect(h.service.resumable(operator)).toMatchObject({ sessionId: first.sessionId, project: "fixture" });
  expect(h.service.transcriptRecord(first.sessionId).entries.filter(row => row.kind === "utterance").map(row => row.data.text)).toEqual(["Check the search lane.", "And the phone review?"]);

  const second = await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;

  expect(memory).toContain("operator: Check the search lane.");
  expect(memory).toContain("voice (cut; the operator heard up to «»): The search lane passed its verifier.");
  expect(memory).toContain("operator: And the phone review?");
  expect(memory.indexOf("Check the search lane.")).toBeLessThan(memory.indexOf("And the phone review?"));
  expect(memory.length).toBeLessThanOrEqual(CONTINUATION_BUDGET);
  if (backend === "api") {
    h.provider.replay(second.providerId, delegationCreated("after-reconnect", 100));
    await h.service.drain(second.sessionId);
    expect(JSON.stringify(h.provider.requests.at(-1)!.input)).toContain("And the phone review?");
  }
  /* The same call goes on: its record holds both parts, the reconnect between them, and a resumed call is not offered again. */
  const record = h.service.transcriptRecord(second.sessionId);
  expect(record.entries.filter(row => row.kind === "utterance").map(row => row.data.text)).toEqual(["Check the search lane.", "And the phone review?"]);
  expect(record.entries.some(row => row.kind === "session_start" && row.data.resumes === first.sessionId)).toBe(true);
  expect(record.entries.filter(row => row.kind === "session_end")).toHaveLength(0);
  expect(new Set(record.entries.map(row => row.id)).size).toBe(record.entries.length);
  expect(h.service.resumable(operator)).toBeNull();

  /* A second drop resumes the whole conversation, both earlier parts. */
  say(h, second.providerId, [["operator", "Then deploy it."]], 10);
  await h.service.drain(second.sessionId);
  h.provider.disconnect(second.providerId);
  await closed(h, second.sessionId);
  expect(h.service.resumable(operator)?.sessionId).toBe(second.sessionId);
  const third = await start(h, { resume: second.sessionId });
  const again = h.provider.sessions.at(-1)!.memory!;
  expect(again).toContain("operator: Check the search lane.");
  expect(again).toContain("operator (unanswered): Then deploy it.");
  expect(h.service.transcriptRecord(third.sessionId).entries.filter(row => row.kind === "utterance").map(row => row.data.text))
    .toEqual(["Check the search lane.", "And the phone review?", "Then deploy it."]);
  await h.service.close(third.sessionId);
});

test("a long call is trimmed from its oldest lines with a marker and the newest lines kept, inside the call-memory budget", async () => {
  const h = harness();
  const first = await start(h);
  say(h, first.providerId, Array.from({ length: 60 }, (_, at) => [at % 2 ? "voice" : "operator", `Line ${at} of the synthetic call, long enough to fill the budget soon.`] as ["operator" | "voice", string]));
  await h.service.drain(first.sessionId);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId); await h.memory.drain();
  await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;
  expect(memory.length).toBeLessThanOrEqual(CONTINUATION_BUDGET);
  expect(memory).toContain("Line 59 of the synthetic call");
  expect(memory).not.toContain("Line 0 of the synthetic call");
  expect(memory).toMatch(/\d+ earlier lines of this call are not repeated here/u);
  /* A stored summary of the call stands for the lines left out. */
  expect(memory).toContain("Keep the layout.");
});

test("a reconnect within the drop window starts before the dropped call's summary exists", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = harness("codex", async () => { await held; return { answer: summary, durationMs: 1, inputTokens: 1, outputTokens: 1, model: "fixture-haiku" }; });
  const first = await start(h);
  say(h, first.providerId, [["operator", "Keep the release for tonight."], ["voice", "Noted."]]);
  await h.service.drain(first.sessionId);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  await start(h, { resume: first.sessionId });
  expect(h.provider.sessions.at(-1)!.memory).toContain("operator: Keep the release for tonight.");
  release(); await h.memory.drain();
});

for (const backend of ["api", "codex"] as const) test(`${backend}: private group history read in the call is never carried into the reconnected session`, async () => {
  const h = harness(backend);
  const first = await start(h);
  say(h, first.providerId, [["operator", "Review step one."], ["voice", "Step one is done."]]);
  h.provider.replay(first.providerId, { type: "session.input_transcript.delta", event_id: "private-ask", delta: "Read private-sentinel today.", start_ms: 9000, end_ms: 9500 }, delegationCreated("private-delegation", 9600));
  if (backend === "api") { h.provider.responder = (_request, index) => backendResponse(`answer-${index}`, index === 0 ? [functionCall("history", "relay_owner_history", { action: "messages", chat: "private-sentinel", from: null, to: null, cursor: null, limit: null })] : []); await h.service.drain(first.sessionId); }
  else { await h.service.drain(first.sessionId); await h.provider.callTool(first.providerId, "relay_owner_history", { action: "messages", chat: "private-sentinel", from: null, to: null, cursor: null, limit: null }, "history", "native-private-turn"); }
  h.admission.record(first.sessionId, { id: "private-reply", kind: "reply", atMs: 9900, data: { final: true, text: "private title sentinel, private member sentinel: private message sentinel" } });
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;
  expect(memory).toContain("operator: Review step one.");
  expect(memory).not.toContain("sentinel");
  expect(memory).not.toContain("Read private");
  expect(memory).toContain("A private part of this call is not repeated here.");
});

test("only the operator who had the call can see or resume it", async () => {
  const h = harness();
  const first = await start(h, { startedBy: { memberId: "member-a" } });
  say(h, first.providerId, [["operator", "Member A speaking."]]);
  await h.service.drain(first.sessionId);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  expect(h.service.resumable({ memberId: "member-b" })).toBeNull();
  expect(h.service.resumable(operator)).toBeNull();
  expect(h.service.resumable({ memberId: "member-a" })?.sessionId).toBe(first.sessionId);
  await expect(start(h, { resume: first.sessionId, startedBy: { memberId: "member-b" } })).rejects.toThrow("SESSION_UNAVAILABLE");
  expect(h.provider.sessions).toHaveLength(1);

  /* Another member naming a live call never cuts it off. */
  const live = await start(h, { startedBy: { memberId: "member-a" } });
  say(h, live.providerId, [["operator", "Still talking."]]);
  await h.service.drain(live.sessionId);
  await expect(start(h, { resume: live.sessionId, startedBy: { memberId: "member-b" } })).rejects.toThrow("SESSION_UNAVAILABLE");
  expect(ending(h, live.sessionId)).toBeUndefined();
  await h.service.close(live.sessionId);
});

test("a hang-up is not offered back; a stale browser and a browser that lost its media are drops", async () => {
  const h = harness();
  const hungUp = await start(h);
  say(h, hungUp.providerId, [["operator", "That is all."]]);
  await h.service.drain(hungUp.sessionId);
  await h.service.close(hungUp.sessionId);
  expect(ending(h, hungUp.sessionId)).toBe("operator");
  expect(h.service.resumable(operator)).toBeNull();
  await expect(start(h, { resume: hungUp.sessionId })).rejects.toThrow("SESSION_UNAVAILABLE");

  /* The browser's own media failed and it asked the Viewer to end the call as a drop. */
  const lost = await start(h);
  say(h, lost.providerId, [["operator", "Are you there?"]]);
  await h.service.drain(lost.sessionId);
  await h.service.close(lost.sessionId, "transport");
  expect(ending(h, lost.sessionId)).toBe("transport");
  expect(h.service.resumable(operator)?.sessionId).toBe(lost.sessionId);

  /* An open call whose browser stopped polling is offered, and resuming it ends the old provider session first. */
  const silent = await start(h, { resume: lost.sessionId });
  say(h, silent.providerId, [["operator", "Still here."]], 5);
  await h.service.drain(silent.sessionId);
  expect(h.service.resumable(operator)).toBeNull();
  h.advance(6_000);
  expect(h.service.resumable(operator)?.sessionId).toBe(silent.sessionId);
  const next = await start(h, { resume: silent.sessionId });
  expect(ending(h, silent.sessionId)).toBe("transport");
  expect(h.provider.sessions.at(-1)!.memory).toContain("operator (unanswered): Still here.");
  expect(h.provider.sessions.at(-1)!.memory).toContain("operator: Are you there?");
  await h.service.close(next.sessionId);

  /* The offer lasts the drop window, then a new call starts fresh. */
  const late = await start(h);
  say(h, late.providerId, [["operator", "Late."]]);
  await h.service.drain(late.sessionId);
  h.provider.disconnect(late.providerId);
  await closed(h, late.sessionId);
  h.advance(31 * 60_000);
  expect(h.service.resumable(operator)).toBeNull();
});

test("a start that failed before anything was said is not offered as a call to resume", async () => {
  const h = harness();
  h.provider.createFailures.push("refused");
  await expect(start(h)).rejects.toThrow();
  expect(h.service.resumable(operator)).toBeNull();
  const empty = await start(h);
  h.provider.disconnect(empty.providerId);
  await closed(h, empty.sessionId);
  expect(h.service.resumable(operator)).toBeNull();
});

test("a reconnected call counts from its first part, and each part's turns from that part's own start", async () => {
  const h = harness();
  const create = h.provider.create.bind(h.provider);
  /* Each provider start takes three seconds. */
  h.provider.create = (...args) => create(...args).then(answer => { h.advance(3_000); return answer; });
  const startedAt = h.now();
  const first = await h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy: operator, timeZone: "Europe/Kyiv" });
  say(h, first.providerId, [["operator", "First part."], ["voice", "Heard it."]]);
  await h.service.drain(first.sessionId);
  h.advance(10_000);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  h.advance(60_000);
  const resumedAt = h.now();
  const second = await h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy: operator, timeZone: "Europe/Kyiv", resume: first.sessionId });
  expect(h.provider.sessions.at(-1)!.clock).toContain("Thursday, October 22, 2026, 15:00:00 Kyiv time");
  h.provider.replay(second.providerId, { type: "session.input_transcript.delta", event_id: "second-turn", delta: "Second part.", start_ms: 2_000, end_ms: 2_500 });
  h.advance(5_000);
  h.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Done.")]) : backendResponse(`resp_${index}`, [functionCall("clock-parts", "call_clock", { from: "t1", to: "t3" })]);
  h.provider.replay(second.providerId, delegationCreated("clock-parts-delegation", 5_000));
  await h.service.drain(second.sessionId);
  expect(String(h.provider.requests[0]!.input.findLast(item => item.role === "user")!.content)).toContain("This call has run for 1 minute 21 seconds.");
  const answer = JSON.parse(String(h.provider.requests.at(-1)!.input.findLast(item => item.type === "function_call_output")!.output));
  const { iso } = voiceClock("Europe/Kyiv");
  expect(answer.callStarted).toBe(iso(startedAt));
  expect(answer.turns.filter((row: { who: string }) => row.who !== "reconnected").map((row: { who: string; time: string }) => [row.who, row.time])).toEqual([
    ["operator", iso(startedAt + 3_000)], ["voice", iso(startedAt + 3_000 + 4_000)], ["operator", iso(resumedAt + 3_000 + 2_000)]]);
  await h.service.close(second.sessionId);
});

test("after a Viewer restart the call it held is offered from its journal and resumes with its words", async () => {
  const h = harness();
  const first = await start(h);
  /* Settled speech is in the journal on disk; the voice's last line was still growing when the Viewer died. */
  say(h, first.providerId, [["operator", "Before the restart."], ["voice", "Heard you."], ["operator", "Keep going."], ["voice", "Still growing"]]);
  await h.service.drain(first.sessionId);
  /* The previous Viewer died: its process owned the call, and nothing closed it. The next one reads only the disk. */
  h.storage.change(document => { document.sessions[first.sessionId].owner = { pid: 2 ** 22 + 17, instance: "previous-viewer" }; });
  const storage = new CompanionStorage(h.now);
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } }, h.now);
  expect(admission.transcriptRecord(first.sessionId).entries.filter(row => row.kind === "utterance").map(row => row.data.text)).toEqual(["Before the restart.", "Keep going."]);
  const restarted = h.build(storage, admission);
  h.service = restarted;
  expect(restarted.resumable(operator)?.sessionId).toBe(first.sessionId);
  await restarted.recover();
  expect(admission.transcriptRecord(first.sessionId).entries.find(row => row.kind === "session_end")?.data).toMatchObject({ reason: "transport", cause: "viewer-restart" });
  expect(restarted.resumable(operator)?.sessionId).toBe(first.sessionId);
  const second = await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;
  expect(memory).toContain("operator: Before the restart.");
  expect(memory).toContain("voice (cut; the operator heard up to «»): Heard you.");
  expect(memory).toContain("operator: Keep going.");
  await restarted.close(second.sessionId);
});

/*
 * The page's store against the session service: a reload mid-call asks while the Viewer still counts the old page as
 * live, and a part resumed after a reload holds no lines of its own. The adapter is a stand-in for the browser's.
 */
test("a page reloaded two seconds after its last poll is offered the call without a remount, and so is a resumed part that drops before anything new is said", async () => {
  const { createCompanionStore, RESUME_RECHECK_MS } = await import("@/hooks/useVoiceCompanion");
  const h = harness();
  const timers = new Set<{ at: number; run: () => void }>();
  const schedule = (run: () => void, ms: number) => { const timer = { at: h.now() + ms, run }; timers.add(timer); return () => { timers.delete(timer); }; };
  const elapse = async (ms: number) => {
    h.advance(ms);
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= h.now()) { timers.delete(timer); timer.run(); }
    await flush();
  };
  const flush = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
  const listeners = new Set<(event: import("./contract").CompanionEvent) => void>();
  let seq = 0;
  const emit = (sessionId: string, payload: import("./contract").Payload) => {
    const event = { ...payload, version: 1, sessionId, generation: 1, eventId: `event-${seq}`, seq: seq += 1, atMs: seq } as import("./contract").CompanionEvent;
    for (const listener of [...listeners]) listener(event);
  };
  const answers: Array<string | null> = [];
  let live: { sessionId: string; providerId: string } | null = null;
  const adapter: import("./contract").VoiceCompanionAdapter = {
    mode: "official-realtime",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: async (options) => { live = await start(h, { resume: options.resume }); emit(live.sessionId, { type: "session.ready", mode: "official-realtime" }); },
    command: async () => undefined,
    close: async () => undefined,
    resumable: async () => { const call = h.service.resumable(operator); answers.push(call?.sessionId ?? null); return call ? { sessionId: call.sessionId, project: call.project } : null; },
  };

  const first = await start(h);
  say(h, first.providerId, [["operator", "Check the search lane."], ["voice", "It passed."], ["operator", "Good."]]);
  await h.service.drain(first.sessionId);
  await h.service.events(first.sessionId, 0);
  const lastPoll = h.now();
  /* The page reloads: the new one asks while the old one polled two seconds ago. */
  h.advance(2_000);
  const store = createCompanionStore(adapter, { schedule });
  const release = store.connect();
  await flush();
  expect([answers, store.get().resumable]).toEqual([[null], null]);
  await elapse(RESUME_RECHECK_MS);
  expect(answers).toEqual([null, first.sessionId]);
  expect(store.get().resumable).toEqual({ sessionId: first.sessionId, project: "fixture" });
  /* Well inside the watchdog's 30 s, before the call is even closed as a drop. */
  expect(h.now() - lastPoll).toBeLessThan(30_000);
  expect(ending(h, first.sessionId)).toBeUndefined();

  /* The reloaded page resumes; its part drops before anyone speaks. The store has no lines and asks the Viewer. */
  await store.start({ locale: "en", project: "fixture", resume: first.sessionId });
  const second = live!;
  expect([store.get().reconnected, store.get().lines.length]).toEqual([true, 0]);
  h.provider.disconnect(second.providerId);
  await closed(h, second.sessionId);
  emit(second.sessionId, { type: "session.closed", reason: "transport", incomplete: false });
  await flush();
  expect(store.get().resumable).toEqual({ sessionId: second.sessionId, project: "fixture" });
  expect(timers.size).toBe(0);

  /* A question still waiting for its recheck ends with the page. */
  release();
  const other = createCompanionStore({ ...adapter, resumable: async () => null }, { schedule });
  const gone = other.connect();
  await flush();
  expect(timers.size).toBe(1);
  gone();
  expect(timers.size).toBe(0);
});

test("a reconnect's resume note and its lines read in the browser's zone, and the journal's order stays", async () => {
  const h = harness();
  const first = await start(h);
  say(h, first.providerId, [["operator", "Check the build."], ["voice", "It is green."]]);
  await h.service.drain(first.sessionId);
  h.advance(60_000);
  h.provider.disconnect(first.providerId);
  await closed(h, first.sessionId);
  h.advance(120_000);
  await h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy: operator, resume: first.sessionId, timeZone: "Asia/Tokyo" });
  const memory = h.provider.sessions.at(-1)!.memory!;
  // The drop came at 12:01 UTC, which is 21:01 in Tokyo.

  expect(memory).toContain("[21:00 Tokyo time] operator: Check the build.");
  expect(memory).toContain("[21:00 Tokyo time] voice: It is green.");
  expect(memory).not.toContain("UTC");
  expect(h.provider.sessions.at(-1)!.clock).toContain("Asia/Tokyo");
});

for (const backend of ["api", "codex"] as const) test(`slice 2: ${backend} records a sentence-safe cursor and asks before continuing`, async () => {
  const h = harness(backend); const p = await start(h);
  const sentences = ["First sentence is finished. ", "Second sentence has several more words. ", "Third sentence is still ahead."];
  let offset = 0;
  for (let i = 0; i < sentences.length; i++) {
    h.provider.replay(p.providerId, { type: "session.output_transcript.delta", event_id: `sentence-${i}`, delta: sentences[i], start_ms: offset, end_ms: offset + [3000, 4000, 3000][i] });
    offset += [3000, 4000, 3000][i];
  }
  await h.service.drain(p.sessionId); h.advance(10_000); await h.service.close(p.sessionId, "transport");
  const item = h.admission.transcriptRecord(p.sessionId).entries.find(row => row.kind === "reply")!;
  const playedMs = backend === "api" ? 4000 : (sentences[0].length + 8) * 58;
  const n = await h.service.start({ project: "fixture", locale: "en", sdp: "v=0", resume: p.sessionId, cursor: { heard: { itemId: item.id, playedMs } } });
  const point = h.admission.transcriptRecord(n.sessionId).entries.find(row => row.kind === "session_start")?.data.resumePoint;
  expect(point).toMatchObject({ kind: "reply", offset: sentences[0].length, remaining: sentences.slice(1).join("") });
  const queued = h.admission.reportSpeech(n.sessionId);
  expect(queued).toMatchObject([{ kind: "resume", handed: 0, resumeOf: { part: p.sessionId, item: item.id } }]);
  expect(h.provider.commands.filter(row => row.type === "session.commentary.append")).toHaveLength(0);
  await h.service.events(n.sessionId, 0);
  if (backend === "codex") expect(h.provider.commands.find(row => row.type === "session.commentary.append")?.content).toBe(`The connection dropped at «${(sentences[0] + sentences[1].slice(0, 8)).trim()}». Shall I go on?`);
  await h.service.close(n.sessionId);
});

test("slice 2: continuation keeps cut markers and every current open request within the shared budget", async () => {
  const { continuationBlock } = await import("./callResume");
  const entries: import("./transcriptRecord").TranscriptEntry[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, kind: "reply" as const, atMs: i, data: { text: `Old sentence ${i}. `.repeat(20), final: true } })),
    { id: "cut", kind: "reply", atMs: 21, data: { text: "Heard sentence. Unheard sentence.", final: true } },
    { id: "open", kind: "utterance", atMs: 22, data: { text: "Please check the", final: true } },
    { id: "request-a", kind: "request", atMs: 23, data: { callId: "a", instruction: "Build the search", status: "queued" } },
    { id: "request-b", kind: "request", atMs: 24, data: { callId: "b", instruction: "Check the layout", status: "delivered" } },
  ];
  entries.forEach((row, order) => { row.order = order; });
  const point = { kind: "reply" as const, resumeOf: { part: "part", item: "cut" }, offset: 16, heard: "Heard sentence. ", remaining: "Unheard sentence." };
  const block = continuationBlock([{ id: "part", createdAt: 0, entries }], { point, cursor: { operatorOpen: "open" }, now: 0 });
  expect(block.length).toBeLessThanOrEqual(CONTINUATION_BUDGET);
  for (const data of ["voice (cut;", "operator (cut off, unanswered)", "Build the search", "queued", "Check the layout", "delivered"]) expect(block).toContain(data);
});

for (const backend of ["api", "codex"] as const) test(`slice 2: ${backend} reload names the recent reply, but completed audio owes no line`, async () => {
  const h = harness(backend); const p = await start(h);
  say(h, p.providerId, [["voice", "A recent synthetic reply."]]); await h.service.drain(p.sessionId);
  h.advance(3000); await h.service.close(p.sessionId, "transport");
  const item = h.admission.transcriptRecord(p.sessionId).entries.find(row => row.kind === "reply")!;
  const n = await h.service.start({ project: "fixture", locale: "en", sdp: "v=0", resume: p.sessionId });
  expect(h.admission.reportSpeech(n.sessionId)[0]).toMatchObject({ kind: "resume", resumeOf: { part: p.sessionId, item: item.id } });
  await h.service.events(n.sessionId, 0);
  if (backend === "codex") expect(h.provider.commands.find(row => row.type === "session.commentary.append")?.content).toBe("The connection dropped at «A recent synthetic reply.». Shall I go on?");
  await h.service.close(n.sessionId);
});

test("slice 2: forged ids are ignored, playback is clamped, and the mint key binds the exact cursor", async () => {
  const h = harness(); const p = await start(h);
  say(h, p.providerId, [["voice", "An already heard reply."]]); await h.service.drain(p.sessionId); h.advance(3000); await h.service.close(p.sessionId, "transport");
  const item = h.admission.transcriptRecord(p.sessionId).entries.find(row => row.kind === "reply")!;
  const input = { project: "fixture", locale: "en" as const, sdp: "v=0", resume: p.sessionId, requestId: "bound-cursor",
    cursor: { heard: { itemId: item.id, playedMs: 99_999 }, unplayed: ["foreign-reply"], operatorOpen: "foreign-operator" } };
  const n = await h.service.start(input);
  const data = h.admission.transcriptRecord(n.sessionId).entries.find(row => row.kind === "session_start")!.data;
  expect(data).toMatchObject({ cursor: { heard: { itemId: item.id, playedMs: 3000 }, unplayed: [] }, cursorAdjusted: true });
  expect(data.resumePoint).toBeUndefined(); expect(h.admission.reportSpeech(n.sessionId)).toEqual([]);
  expect(await h.service.start(input)).toEqual(n);
  await expect(h.service.start({ ...input, cursor: {} })).rejects.toThrow("INVALID_REQUEST");
  await h.service.close(n.sessionId);
  for (const cursor of [{ heard: { itemId: item.id, playedMs: -1 } }, { heard: { itemId: item.id, playedMs: Infinity } }, { unplayed: Array(65).fill(item.id) }, { arbitrary: true }])
    await expect(h.service.start({ ...input, requestId: "bad-cursor", cursor: cursor as import("./contract").ResumeCursor })).rejects.toThrow("INVALID_REQUEST");
});

test("slice 2: many open requests each keep their current status inside the continuation budget", async () => {
  const { continuationBlock } = await import("./callResume");
  const requests: import("./transcriptRecord").TranscriptEntry[] = Array.from({ length: 8 }, (_, index) => ({
    id: `request-${index}`, kind: "request", atMs: index, order: index,
    data: { callId: `call-${index}`, status: index % 2 ? "delivered" : "queued", instruction: `PENDING_${index} ` + "details ".repeat(80) },
  }));
  requests.unshift({ id: "cut", kind: "reply", atMs: 0, order: -1, data: { text: "First. Second. Third.", final: true } });
  const block = continuationBlock([{ id: "part", createdAt: 0, entries: requests }], { now: 0,
    point: { kind: "reply", resumeOf: { part: "part", item: "cut" }, offset: 7, heard: "First. ", remaining: "Second. Third." } });
  expect(block.length).toBeLessThanOrEqual(CONTINUATION_BUDGET);
  expect(block).toContain("Second. Third.");
  for (let index = 0; index < 8; index++) {
    const line = block.split("\n").find(line => line.includes(`PENDING_${index}`));
    expect(line).toBeDefined(); expect(line).toContain(index % 2 ? "delivered" : "queued");
  }
});
