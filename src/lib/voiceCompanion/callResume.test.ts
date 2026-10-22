import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallMemory, type CallSummarizer } from "./callMemory";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { FakeLiveProvider, delegationCreated, backendResponse, functionCall } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

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
  const build = () => new CompanionLiveSessions(storage, admission, fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), provider,
    { memory, key: () => "synthetic-credential", timers: false, now: () => now, closeTimeoutMs: 10,
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
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const ending = (h: Harness, id: string) => h.admission.transcriptRecord(id).entries.find(row => row.kind === "session_end")?.data.reason;

for (const backend of ["api", "codex"] as const) test(`${backend}: a call whose provider session drops resumes with its conversation in both contexts and one record`, async () => {
  const h = harness(backend);
  const first = await start(h);
  say(h, first.providerId, [["operator", "Check the search lane."], ["voice", "The search lane passed its verifier."], ["operator", "And the phone review?"]]);
  await h.service.drain(first.sessionId);
  h.provider.disconnect(first.providerId);
  await settle();
  expect(ending(h, first.sessionId)).toBe("transport");
  /* The dropped call is offered back to the operator who had it, and its whole record is still readable. */
  expect(h.service.resumable(operator)).toMatchObject({ sessionId: first.sessionId, project: "fixture" });
  expect(h.service.transcriptRecord(first.sessionId).entries.filter(row => row.kind === "utterance").map(row => row.data.text)).toEqual(["Check the search lane.", "And the phone review?"]);

  const second = await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;
  expect(memory).toContain("connection dropped");
  expect(memory).toContain("operator: Check the search lane.");
  expect(memory).toContain("voice: The search lane passed its verifier.");
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
  await settle();
  expect(h.service.resumable(operator)?.sessionId).toBe(second.sessionId);
  const third = await start(h, { resume: second.sessionId });
  const again = h.provider.sessions.at(-1)!.memory!;
  expect(again).toContain("operator: Check the search lane.");
  expect(again).toContain("operator: Then deploy it.");
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
  await settle(); await h.memory.drain();
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
  await settle();
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
  await settle();
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
  await settle();
  expect(h.service.resumable({ memberId: "member-b" })).toBeNull();
  expect(h.service.resumable(operator)).toBeNull();
  expect(h.service.resumable({ memberId: "member-a" })?.sessionId).toBe(first.sessionId);
  await expect(start(h, { resume: first.sessionId, startedBy: { memberId: "member-b" } })).rejects.toThrow("SESSION_UNAVAILABLE");
  expect(h.provider.sessions).toHaveLength(1);
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
  expect(h.provider.sessions.at(-1)!.memory).toContain("operator: Still here.");
  expect(h.provider.sessions.at(-1)!.memory).toContain("operator: Are you there?");
  await h.service.close(next.sessionId);

  /* The offer lasts the drop window, then a new call starts fresh. */
  const late = await start(h);
  say(h, late.providerId, [["operator", "Late."]]);
  await h.service.drain(late.sessionId);
  h.provider.disconnect(late.providerId);
  await settle();
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
  await settle();
  expect(h.service.resumable(operator)).toBeNull();
});

test("after a Viewer restart the call it held is offered from its journal and resumes with its words", async () => {
  const h = harness();
  const first = await start(h);
  say(h, first.providerId, [["operator", "Before the restart."], ["voice", "Heard you."], ["operator", "Keep going."]]);
  await h.service.drain(first.sessionId);
  /* The previous Viewer died: its process owned the call, and nothing closed it. */
  h.storage.change(document => { document.sessions[first.sessionId].owner = { pid: 2 ** 22 + 17, instance: "previous-viewer" }; });
  const restarted = h.build();
  h.service = restarted;
  expect(restarted.resumable(operator)?.sessionId).toBe(first.sessionId);
  await restarted.recover();
  expect(ending(h, first.sessionId)).toBe("transport");
  expect(restarted.resumable(operator)?.sessionId).toBe(first.sessionId);
  const second = await start(h, { resume: first.sessionId });
  const memory = h.provider.sessions.at(-1)!.memory!;
  expect(memory).toContain("operator: Before the restart.");
  expect(memory).toContain("voice: Heard you.");
  await restarted.close(second.sessionId);
});
