import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionStorage, type SessionStarter, type StoredSession } from "./storage";
import { CompanionAdmission, type CompanionDeliveryPaths } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { FakeLiveProvider, backendResponse, delegationCreated, functionCall, message } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import { retainedCalls } from "./callHistory";
import { sameCallOwner } from "./callMemory";
import { delegationReason } from "./delegationOutcome";
import { reportHeaderName } from "@/lib/projects/settings";

/*
 * After a call the owner reads what the voice did: each retained call with its actions, from the call journals
 * the Viewer already keeps (GitHub #2975). The list is read again after a reload and after a restart.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-call-history-"));
let sequence = 0;
beforeEach(() => { const directory = path.join(root, String(++sequence)); process.env.LLV_STATE_DIR = path.join(directory, "state"); process.env.XDG_CONFIG_HOME = path.join(directory, "config"); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const START = Date.UTC(2026, 9, 22, 10);
const SECRET_WORDS = ["Synthetic instruction about the garden lane", "Synthetic instruction about the review", "Synthetic instruction that fails", "Synthetic answer text", "Synthetic operator words"];
function harness(sends: Array<{ status: "queued" | "failed"; code?: string }> = []) {
  let now = START;
  const storage = new CompanionStorage(() => now); storage.updateSettings({ enabled: true });
  const reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const sent: string[] = [];
  const paths: CompanionDeliveryPaths = {
    recipient: project => project === "garden" ? null : { project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "claude" },
    send: async binding => { sent.push(binding.delivery.clientMessageId); const next = sends.shift() ?? { status: "queued" }; return { ...next, operationId: next.status === "queued" ? `operation-${sent.length}` : null }; },
    reports: () => reports,
  };
  const admission = new CompanionAdmission(storage, paths, () => now);
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, fixtureBoardReads({ tasks: () => [{ id: "task-a", project: "fixture", text: "A task", status: "inbox" }], pipelines: () => [], activity: async () => [], messages: async () => [] }),
    provider, { key: () => "synthetic-credential", timers: false, now: () => now, closeTimeoutMs: 10 });
  return { storage, admission, provider, service, reports, sent, advance: (ms: number) => { now += ms; } };
}
type Harness = ReturnType<typeof harness>;
/** A call in which the operator speaks and the backend raises one request, as Live delegates it. */
async function callWithRequest(h: Harness, project: string, instruction: string, startedBy: SessionStarter = { operator: true }, read = false) {
  const call = await h.service.start({ project, locale: "en", sdp: "v=0\r\n", startedBy });
  h.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Done.")])
    : backendResponse(`resp_${index}`, [...(read ? [functionCall(`read-${index}`, "list_tasks", { project: null })] : []), functionCall(`call-${instruction.length}`, "request_orchestrator_delegation", { instruction, confirmation_reason: null })]);
  h.provider.replay(call.providerId, { type: "session.input_transcript.delta", event_id: `said-${instruction.length}`, delta: "Synthetic operator words.", start_ms: 0, end_ms: 900 },
    delegationCreated(`delegation-${instruction.length}`, 1_000));
  await h.service.drain(call.sessionId);
  return call;
}
const operatorOwns = (starter: SessionStarter) => (session: StoredSession) => sameCallOwner(starter, session.startedBy);

test("each retained call lists its actions with time, kind, project, delivery state, reason and links, newest call first, without private content", async () => {
  const h = harness([{ status: "queued" }, { status: "failed", code: "conversation_busy" }]);
  const garden = await callWithRequest(h, "garden", SECRET_WORDS[0]);
  await h.service.close(garden.sessionId);
  h.advance(60_000);
  const review = await callWithRequest(h, "fixture", SECRET_WORDS[1], { operator: true }, true);
  h.reports.push({ id: "answer-1", seq: 1, project: "fixture", at: new Date(START + 70_000).toISOString(), class: "completed", body: SECRET_WORDS[3], correlatesDirective: h.sent[0],
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } } as import("@/lib/bridge/types").BridgeReportV1);
  h.advance(5_000);
  await h.service.events(review.sessionId, 0);
  await h.service.close(review.sessionId);
  h.advance(60_000);
  const failing = await callWithRequest(h, "fixture", SECRET_WORDS[2]);
  await h.service.close(failing.sessionId);

  const calls = retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), project => `Name of ${project}`);
  expect(calls.map(call => call.sessionId)).toEqual([failing.sessionId, review.sessionId, garden.sessionId]);
  expect(calls.every(call => !call.live && call.endedAt !== null && call.actions !== null)).toBe(true);
  expect(calls[2]).toMatchObject({ startedAt: START, project: "Name of garden" });

  const [refused] = calls[2].actions!;
  expect(refused).toMatchObject({ kind: "request", status: "refused", code: "no_orchestrator", reason: delegationReason("no_orchestrator", "refused", "en"), project: null, conversationId: null });
  expect(refused.at).toBeGreaterThanOrEqual(START);

  const actions = calls[1].actions!;
  expect(actions.map(action => [action.kind, action.name, action.status])).toEqual([["tool", "list_tasks", "done"], ["request", null, "queued"], ["report", null, "result"]]);
  const request = actions[1]!;
  /* A request names its project as it was recorded when sent; a record without that name is named by the list. */
  expect(request).toMatchObject({ project: reportHeaderName("fixture", "en"), conversationId: "conversation_fixture", reason: null, requestId: null });
  expect(actions[2]).toMatchObject({ requestId: request.id, conversationId: "conversation_fixture", project: "Name of fixture" });
  expect(actions[2]!.at).toBeGreaterThan(request.at);

  expect(calls[0].actions!).toEqual([expect.objectContaining({ kind: "request", status: "failed", code: "conversation_busy", reason: delegationReason("conversation_busy", "failed", "en"), conversationId: "conversation_fixture" })]);
  /* The list names what happened; what was said, sent, read or answered stays in the call's own record. */
  const text = JSON.stringify(calls);
  for (const words of SECRET_WORDS) expect(text).not.toContain(words);
  expect(text).not.toContain("synthetic-credential");
});

test("the list is the caller's own: a member's calls are theirs, the operator's are not a member's, and an unreadable record is unknown, never empty", async () => {
  const h = harness();
  const own = await callWithRequest(h, "garden", SECRET_WORDS[0]);
  await h.service.close(own.sessionId);
  const member = await callWithRequest(h, "garden", SECRET_WORDS[1], { memberId: "member-a" });
  await h.service.close(member.sessionId);
  const other = await callWithRequest(h, "garden", SECRET_WORDS[2], { memberId: "member-b" });
  await h.service.close(other.sessionId);
  const names = (project: string) => project;
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), names).map(call => call.sessionId)).toEqual([own.sessionId]);
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ memberId: "member-a" }), names).map(call => call.sessionId)).toEqual([member.sessionId]);
  expect(retainedCalls(h.storage, h.admission.records, () => false, names)).toEqual([]);

  /* A restarted Viewer reads the same history from disk. */
  const storage = new CompanionStorage();
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] });
  const again = retainedCalls(storage, admission.records, operatorOwns({ memberId: "member-b" }), names);
  expect(again.map(call => call.sessionId)).toEqual([other.sessionId]);
  expect(again[0].actions).toEqual(retainedCalls(h.storage, h.admission.records, operatorOwns({ memberId: "member-b" }), names)[0].actions);

  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "voice-companion", "transcripts", `${own.sessionId}.jsonl`), "not json\n");
  const [broken] = retainedCalls(storage, admission.records, operatorOwns({ operator: true }), names);
  expect(broken).toMatchObject({ sessionId: own.sessionId, actions: null });
});

test("an open call is listed live with its actions so far, and a report that lands after the call ended is read on the next list", async () => {
  const h = harness();
  const call = await callWithRequest(h, "fixture", SECRET_WORDS[1]);
  const names = (project: string) => project;
  const open = retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), names);
  expect(open[0]).toMatchObject({ sessionId: call.sessionId, live: true, endedAt: null });
  expect(open[0].actions!.map(action => action.kind)).toEqual(["request"]);
  await h.service.close(call.sessionId);
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), names)[0]).toMatchObject({ live: false });
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), names)[0].actions!.map(action => action.kind)).toEqual(["request"]);
  h.advance(30_000);
  h.reports.push({ id: "late-answer", seq: 1, project: "fixture", at: new Date(START + 30_000).toISOString(), class: "completed", body: SECRET_WORDS[3], correlatesDirective: h.sent[0],
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } } as import("@/lib/bridge/types").BridgeReportV1);
  /* Opening the ended call's record is its report reconciliation, as before. */
  await h.service.events(call.sessionId, 0);
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), names)[0].actions!.map(action => action.kind)).toEqual(["request", "report"]);
});

test("a request recorded before requests named their project is named by the list from its recipient", async () => {
  const h = harness();
  const call = await h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy: { operator: true } });
  h.admission.record(call.sessionId, { id: "request-legacy", kind: "request", atMs: 500, data: { callId: "legacy", status: "sent",
    recipient: { project: "atlas", conversationId: "conversation_atlas", seatEpoch: 1, engine: "claude" } } });
  await h.service.close(call.sessionId);
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), project => `Name of ${project}`)[0].actions)
    .toEqual([expect.objectContaining({ id: "request-legacy", at: START + 500, project: "Name of atlas", status: "delivered", conversationId: "conversation_atlas" })]);
});

test("a call whose state row is gone is still listed from its owned journal, and a journal without an owner is not", async () => {
  const h = harness();
  const kept = await callWithRequest(h, "fixture", SECRET_WORDS[1]);
  await h.service.close(kept.sessionId);
  const legacy = await callWithRequest(h, "fixture", SECRET_WORDS[2]);
  await h.service.close(legacy.sessionId);
  const directory = path.join(process.env.LLV_STATE_DIR!, "voice-companion", "transcripts");
  /* A journal written before calls recorded who started them. */
  const file = path.join(directory, `${legacy.sessionId}.jsonl`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").map(line => line.includes('"kind":"session_start"') ? line.replace(/,"startedBy":\{"operator":true\}/u, "") : line).join("\n"));
  h.storage.change(document => { delete document.sessions[kept.sessionId]; delete document.sessions[legacy.sessionId]; });
  const calls = retainedCalls(h.storage, h.admission.records, operatorOwns({ operator: true }), project => project);
  expect(calls.map(call => call.sessionId)).toEqual([kept.sessionId]);
  expect(calls[0]).toMatchObject({ live: false, endedAt: expect.any(Number), actions: [expect.objectContaining({ kind: "request", status: "queued" })] });
  expect(retainedCalls(h.storage, h.admission.records, operatorOwns({ memberId: "member-a" }), project => project)).toEqual([]);
});

test("refusal and delivery reasons read in the owner's language, from the code the record keeps", () => {
  expect(delegationReason("no_orchestrator", "refused", "en")).toBe("This project has no designated orchestrator, so nothing was sent.");
  expect(delegationReason("no_orchestrator", "refused", "uk")).toContain("оркестратора");
  expect(delegationReason("conversation_busy", "failed", "uk")).toContain("conversation busy");
  expect(delegationReason(null, "failed", "uk")).toMatch(/[а-яіїєґ]/u);
  expect(delegationReason("unknown_code", "refused", "uk")).toBeNull();
  expect(delegationReason(null, "queued", "uk")).toBeNull();
});
