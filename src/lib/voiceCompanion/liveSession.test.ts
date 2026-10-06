import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLiveProvider } from "./fakeProvider";
import { CompanionBoardReads } from "./boardReads";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-live-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { CompanionLiveSessions } = await import("./liveSession");
const { SESSION_RESERVE_USD, BACKEND_RESPONSE_RESERVE_USD } = await import("./usage");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));

function fixture() {
  const storage = new CompanionStorage();
  storage.updateSettings({ enabled: true });
  let sends = 0;
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued", operationId: "operation_fixture" }; }, reports: () => [] });
  const reads = new CompanionBoardReads({ tasks: () => [{ id: "task_fixture", project: "fixture", text: "Review the plan", status: "open" }],
    pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", closeTimeoutMs: 20, timers: false });
  return { storage, admission, provider, service, sends: () => sends };
}
const created = (delegation: string, response: string) => ({ type: "response.event", event_id: `created-${response}`, delegation_id: delegation,
  event: { type: "response.created", response: { id: response, output: [], tools: [], instructions: null } } });
const done = (delegation: string, call: string, name: string, args = {}) => ({ type: "response.event", event_id: `done-${call}`, delegation_id: delegation,
  event: { type: "response.output_item.done", output_index: 0, sequence_number: 2, item: { id: `item-${call}`, type: "function_call", call_id: call, name, arguments: JSON.stringify(args) } } });
const completed = (delegation: string, response: string) => ({ type: "response.event", event_id: `completed-${response}`, delegation_id: delegation,
  event: { type: "response.completed", response: { id: response, status: "completed", output: [], tools: [], instructions: null, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 20 } } } });

test("minting is server configured, a model proposal sends nothing, and tap delivery survives a closed media call", async () => {
  const f = fixture();
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0\r\n" });
  f.provider.replay(session.providerId, created("delegation-a", "response-a"), done("delegation-a", "call-a", "request_orchestrator_delegation", { instruction: "Review the plan" }), completed("delegation-a", "response-a"));
  await f.service.drain(session.sessionId);
  const proposal = Object.values(f.admission.session(session.sessionId).proposals)[0].proposal;
  expect(f.sends()).toBe(0);
  expect(f.provider.commands.filter(row => row.type === "response.item.create")).toHaveLength(1);
  await f.service.command(session.sessionId, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  expect(f.sends()).toBe(1);
  await f.service.close(session.sessionId);
  expect(f.provider.attached).toBe(0);
  expect(f.storage.settings()).toMatchObject({ reservedUsd: 0, incomplete: false });
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.015016, 6);
});

test("parallel backend streams and reordered completion events retain their own call identities", async () => {
  const f = fixture();
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, created("a", "response-a"), created("b", "response-b"),
    completed("b", "response-b"), done("a", "read-a", "list_tasks"), done("b", "read-b", "agent_activity"), completed("a", "response-a"),
    done("a", "read-a", "list_tasks"));
  await f.service.drain(s.sessionId);
  const calls = f.provider.commands.filter(row => row.type === "response.item.create");
  expect(calls).toHaveLength(2);
  expect(calls.map(row => (row.item as { call_id: string }).call_id).sort()).toEqual(["read-a", "read-b"]);
  expect(f.provider.commands.filter(row => row.type === "response.create")).toHaveLength(2);
  await f.service.close(s.sessionId);
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.015031, 6);
});

test("session closure drains a later backend final before releasing the reservation", async () => {
  const f = fixture();
  f.provider.autoClose = false;
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, created("a", "response-a"));
  await f.service.drain(s.sessionId);
  const closing = f.service.close(s.sessionId);
  f.provider.replay(s.providerId, { type: "session.closed", event_id: "closed-first", usage: { seconds: 21 } });
  await f.service.drain(s.sessionId);
  expect(f.provider.attached).toBe(1);
  f.provider.replay(s.providerId, completed("a", "response-a"));
  await closing;
  expect(f.provider.attached).toBe(0);
  expect(f.storage.settings()).toMatchObject({ incomplete: false, reservedUsd: 0 });
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.017516, 6);
  expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "session.closed")).toHaveLength(1);
});

test("end_conversation is a registry tool and closes with final usage, without orchestrator delivery", async () => {
  const f = fixture();
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, created("ending", "response-end"), done("ending", "end-call", "end_conversation"), completed("ending", "response-end"));
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId); // await the tool's idempotent close
  expect(f.sends()).toBe(0);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "tool", incomplete: false }));
  expect(f.provider.attached).toBe(0);
});

test("cap and disabled/demo settings refuse minting before key access or provider calls", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: 0 });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("CAP_REACHED");
  expect(f.provider.sessions).toHaveLength(0);
  f.storage.updateSettings({ enabled: false });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("COMPANION_DISABLED");
  f.storage.updateSettings({ enabled: true, backend: "demo" });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("DEMO_MODE");
});

test("voice duration renews its reservation while cap room remains and otherwise ends the call", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_RESERVE_USD + 0.26 });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, { type: "session.usage.updated", event_id: "duration-first-window", usage: { seconds: 280 } });
  await f.service.drain(s.sessionId);
  expect(f.admission.session(s.sessionId).closed).toBe(false);
  expect(f.storage.settings().usageUsd + f.storage.settings().reservedUsd).toBeCloseTo(SESSION_RESERVE_USD + 0.25);
  f.provider.replay(s.providerId, { type: "session.usage.updated", event_id: "duration-next-window", usage: { seconds: 580 } });
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap", incomplete: false }));
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.483333, 6);
});

test("cumulative duration is monotonic; transport loss keeps the reservation as incomplete usage", async () => {
  const f = fixture();
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, { type: "session.usage.updated", event_id: "u1", usage: { seconds: 30 } },
    { type: "session.usage.updated", event_id: "u2", usage: { seconds: 12 } });
  await f.service.drain(s.sessionId);
  expect(f.admission.session(s.sessionId).usage!.seconds).toBe(30);
  f.provider.disconnect(s.providerId);
  await f.service.drain(s.sessionId);
  expect(f.storage.settings()).toMatchObject({ reservedUsd: 0, incomplete: true });
  expect(f.storage.settings().usageUsd).toBeCloseTo(SESSION_RESERVE_USD);
  expect(new CompanionStorage().settings().incomplete).toBe(true);
  expect(f.provider.hangups).toEqual([s.providerId]);
});

test("uncorrelated provider responses are billed, duplicate finals are idempotent, and cap exhaustion closes before further tool execution", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_RESERVE_USD + 0.01 });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const final = completed("", "uncorrelated");
  f.provider.replay(s.providerId, { ...final, delegation_id: null }, { ...final, delegation_id: null, event_id: "another-copy" },
    created("next", "next-response"), done("next", "next-call", "request_orchestrator_delegation", { instruction: "Review" }));
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId);
  expect(f.admission.session(s.sessionId).proposals).toEqual({});
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "error", code: "CAP_REACHED" }));
  expect(f.storage.settings().incomplete).toBe(true); // the canceled response lacked final backend usage
  expect(f.provider.commands.filter(row => row.type === "session.close")).toHaveLength(1);
});

test("a correlated orchestrator report is replayed to its own card and sent for speech; concurrent unrelated reports are ignored", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const recipient = { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "codex" as const };
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => reports,
    send: async () => ({ status: "queued", operationId: "operation-report" }) });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
    provider, { key: () => "synthetic-credential", timers: false });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const proposal = admission.propose(s.sessionId, "report-call", "report-delegation", "Review the plan")!;
  await service.command(s.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const delivery = admission.session(s.sessionId).proposals[proposal.proposalId].delivery!;
  const report = { id: "report-a", seq: 1, project: "fixture", at: "2026-10-06T00:00:00Z", class: "completed" as const, body: "The plan has been reviewed",
    correlatesDirective: delivery.clientMessageId, origin: { kind: "manager" as const, conversationId: recipient.conversationId, role: "orchestrator" as const } };
  reports = [{ ...report, id: "unrelated", correlatesDirective: "other-message" }, report];
  expect((await service.events(s.sessionId, 0)).filter(row => row.type === "orchestrator.answer")).toMatchObject([{ reportId: "report-a" }]);
  await service.events(s.sessionId, 0);
  expect(provider.commands.filter(row => row.type === "session.commentary.append")).toHaveLength(1);
  expect(provider.commands.find(row => row.type === "session.commentary.append")!.content).toContain("The plan has been reviewed");
  await service.close(s.sessionId);
});

const KEY = "synthetic-credential";
const large = (delegation: string, response: string) => ({ type: "response.event", event_id: `large-${response}`, delegation_id: delegation,
  event: { type: "response.completed", response: { id: response, status: "completed", output: [], usage: { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 512 } } } });
const stateFile = () => fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8");

test("the active credential reflected in a transcript, a tool, a proposal, a report or an error is stored and answered nowhere", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const recipient = { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" as const };
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => reports, send: async () => ({ status: "queued", operationId: "operation-echo" }) });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
    provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  provider.replay(s.providerId,
    { type: "session.output_transcript.delta", event_id: "echo-out", delta: `The key is ${KEY}.`, start_ms: 0, end_ms: 100 },
    // One credential across two fragments: its beginning is never stored alone either.
    { type: "session.input_transcript.delta", event_id: "echo-in-1", delta: `Read ${KEY.slice(0, 14)}`, start_ms: 200, end_ms: 300 });
  await service.drain(s.sessionId);
  expect(stateFile()).not.toContain(KEY.slice(0, 14));
  provider.replay(s.providerId,
    { type: "session.input_transcript.delta", event_id: "echo-in-2", delta: KEY.slice(14), start_ms: 300, end_ms: 400 },
    created("echo", "response-echo"), done("echo", `call-${KEY}`, `tool_${KEY}`),
    done("echo", "call-proposal", "request_orchestrator_delegation", { instruction: `Send ${KEY} to the plan` }));
  await service.drain(s.sessionId);
  const proposal = Object.values(admission.session(s.sessionId).proposals)[0];
  expect(proposal.proposal.instruction).toBe("Send [redacted] to the plan");
  await service.command(s.sessionId, { type: "confirmation", proposalId: proposal.proposal.proposalId, decision: "send", via: "tap" });
  const delivery = admission.session(s.sessionId).proposals[proposal.proposal.proposalId].delivery!;
  reports = [{ id: "report-echo", seq: 1, project: "fixture", at: "2026-10-06T00:00:00Z", class: "completed", body: `Done with ${KEY}`,
    correlatesDirective: delivery.clientMessageId, origin: { kind: "manager", conversationId: recipient.conversationId, role: "orchestrator" } }];
  const answered = JSON.stringify(await service.events(s.sessionId, 0));
  provider.replay(s.providerId, { type: "error", event_id: "echo-error", error: { message: `Invalid ${KEY}` } });
  await service.drain(s.sessionId);
  await service.close(s.sessionId);
  expect(answered).toContain("orchestrator.answer");
  expect(answered).toContain("tool.called");
  for (const surface of [answered, stateFile(), JSON.stringify(await service.events(s.sessionId, 0)), JSON.stringify(provider.commands.filter(row => row.type === "session.commentary.append"))])
    expect(surface).not.toContain(KEY);
});

test("a cap that cannot pay for every backend response Live may start refuses before any provider call", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: 0.67 });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("CAP_REACHED");
  expect(f.provider.sessions).toHaveLength(0);
  expect(f.storage.settings()).toMatchObject({ usageUsd: 0, reservedUsd: 0 });
});

test("parallel and reordered backend responses at the dearest price stay under the cap, and every receipt is kept", async () => {
  const f = fixture();
  const cap = SESSION_RESERVE_USD + 0.01;
  f.storage.updateSettings({ monthlyCapUsd: cap });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  // The fourth is finished before it is announced.
  f.provider.replay(s.providerId, created("a", "r1"), created("b", "r2"), created("c", "r3"), large("d", "r4"), created("d", "r4"),
    large("a", "r1"), large("b", "r2"), large("c", "r3"), large("d", "r4"));
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId);
  const usage = f.admission.session(s.sessionId).usage!;
  expect(Object.keys(usage.responses).sort()).toEqual(["r1", "r2", "r3", "r4"]);
  expect(Object.values(usage.responses).every(row => row.complete && row.usd !== null && row.usd <= BACKEND_RESPONSE_RESERVE_USD)).toBe(true);
  expect(f.storage.settings().usageUsd).toBeCloseTo(4 * 0.200384 + 18 * 0.05 / 60, 6);
  expect(f.storage.settings().usageUsd).toBeLessThanOrEqual(cap);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap", incomplete: false }));
  expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "error" && event.code === "CAP_REACHED")).toHaveLength(1);
});

test("a continuation the cap cannot pay for is never requested", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_RESERVE_USD + 0.01 });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, created("a", "r1"), done("a", "read-a", "list_tasks"), completed("a", "r1"));
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId);
  expect(f.provider.commands.filter(row => row.type === "response.create")).toHaveLength(0);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap" }));
});

test("a backend response named only by its delegation is owed a final: counted once when it comes late, incomplete when it never does", async () => {
  const late = { type: "session.delegation.created", event_id: "delegation-late", offset_ms: 5,
    delegation: { id: "d-late", type: "delegation", target: "responses", response_id: "late" } };
  for (const arrives of [true, false]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.autoClose = false;
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, created("known", "known"), completed("known", "known"), late,
      { type: "session.closed", event_id: "closed-early", reason: "remote_hangup", usage: { seconds: 18 } });
    await f.service.drain(s.sessionId);
    expect(f.provider.attached).toBe(1);
    expect(f.admission.session(s.sessionId).closed).toBe(false);
    if (arrives) {
      f.provider.replay(s.providerId, large("d-late", "late"), { ...large("d-late", "late"), event_id: "late-again" });
      await f.service.drain(s.sessionId);
      expect(f.storage.settings()).toMatchObject({ incomplete: false, reservedUsd: 0 });
      expect(f.storage.settings().usageUsd).toBeCloseTo(0.015 + 0.000016 + 0.200384, 6);
    } else {
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(f.storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
      expect(f.storage.settings().usageUsd).toBeGreaterThanOrEqual(SESSION_RESERVE_USD);
      expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", incomplete: true }));
    }
    expect(f.provider.attached).toBe(0);
    expect(f.admission.session(s.sessionId).usage!.responses.late.complete).toBe(arrives);
  }
});

test("a restarted service closes the session it no longer owns before anything else, once, and keeps the admitted delivery", async () => {
  const f = fixture();
  const old = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "before-restart" });
  const proposal = f.admission.propose(old.sessionId, "call-kept", "delegation-kept", "Review the plan")!;
  await f.service.command(old.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const storage = new CompanionStorage();
  const restarted = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), f.provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
  await Promise.all([restarted.recover(), restarted.recover()]);
  await restarted.recover();
  expect(f.provider.hangups).toEqual([old.providerId]);
  const stored = storage.read().sessions[old.sessionId];
  expect(stored.closed).toBe(true);
  expect(stored.events.filter(event => event.type === "session.closed")).toHaveLength(1);
  expect(stored.proposals[proposal.proposalId]).toMatchObject({ state: "admitted", status: "queued" });
  expect(storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
  expect(storage.settings().usageUsd).toBeCloseTo(SESSION_RESERVE_USD);
  // A session another living process owns is left to it.
  storage.change(document => { const row = document.sessions[old.sessionId]; row.closed = false; row.owner = { pid: process.ppid, instance: "another-viewer" }; });
  await restarted.recover();
  expect(storage.read().sessions[old.sessionId].closed).toBe(false);
  expect(f.provider.hangups).toHaveLength(1);
  f.provider.disconnect(old.providerId);
});
