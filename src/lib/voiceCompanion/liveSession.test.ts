import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendResponse, delegationCreated, FakeLiveProvider, functionCall, message } from "./fakeProvider";
import { CompanionBoardReads } from "./boardReads";
import type { BackendRequest } from "./sessionConfig";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-live-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { CompanionLiveSessions } = await import("./liveSession");
const { SESSION_START_ROOM_USD, VOICE_SESSION_RESERVE_USD, BACKEND_RESPONSE_RESERVE_USD } = await import("./usage");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));

const noReads = () => new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
function fixture(key = "synthetic-credential") {
  const storage = new CompanionStorage();
  storage.updateSettings({ enabled: true });
  let sends = 0;
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued", operationId: "operation_fixture" }; }, reports: () => [] });
  const reads = new CompanionBoardReads({ tasks: () => [{ id: "task_fixture", project: "fixture", text: "Review the plan", status: "open" }],
    pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => key, closeTimeoutMs: 20, timers: false });
  return { storage, admission, provider, service, sends: () => sends };
}
/** Answers a first round with the given calls and every later round with speech. */
const calling = (...calls: Array<ReturnType<typeof functionCall>>) => (request: BackendRequest, index: number) =>
  request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Here is what I found.")]) : backendResponse(`resp_${index}`, calls);
const said = (delta: string, at: number, speaker: "input" | "output" = "input") =>
  ({ type: `session.${speaker}_transcript.delta`, event_id: `${speaker}-${at}-${delta}`, delta, start_ms: at, end_ms: at + 400 });
const spoken = (f: ReturnType<typeof fixture>) => f.provider.commands.filter(row => row.type === "session.commentary.append");
const large = { input_tokens: 1_050_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 512 };

test("minting is server configured, a model proposal sends nothing, and tap delivery survives a closed media call", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("call-a", "request_orchestrator_delegation", { instruction: "Review the plan" }));
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0\r\n" });
  f.provider.replay(session.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("delegation-a", 600));
  await f.service.drain(session.sessionId);
  const proposal = Object.values(f.admission.session(session.sessionId).proposals)[0].proposal;
  expect(f.sends()).toBe(0);
  expect(f.provider.requests).toHaveLength(2);
  expect(f.provider.requests[0].input[0].content).toContain("Operator: Ask the orchestrator to review the plan.");
  expect(f.provider.requests[1].input.filter(item => item.type === "function_call_output")).toHaveLength(1);
  expect(spoken(f)).toMatchObject([{ delegation_id: "delegation-a", content: "Here is what I found." }]);
  await f.service.command(session.sessionId, { type: "confirmation", proposalId: proposal.proposalId, via: "tap", decision: "send" });
  expect(f.sends()).toBe(1);
  await f.service.close(session.sessionId);
  expect(f.provider.attached).toBe(0);
  expect(f.storage.settings()).toMatchObject({ reservedUsd: 0, incomplete: false });
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.015031, 6);
});

test("parallel delegations keep their own calls, outputs and spoken answers", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
    ? backendResponse(`resp_${index}`, [message(`answer ${(request.input.at(-1)!.call_id as string)}`)])
    : backendResponse(`resp_${index}`, [functionCall(`read-${index}`, index === 0 ? "list_tasks" : "agent_activity")]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("a", 10), delegationCreated("b", 20), delegationCreated("a", 10));
  await f.service.drain(s.sessionId);
  expect(f.provider.requests).toHaveLength(4);
  expect(spoken(f).map(row => [row.delegation_id, row.content]).sort()).toEqual([["a", "answer read-0"], ["b", "answer read-1"]]);
  expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "tool.called").map(event => event.type === "tool.called" && event.name).sort()).toEqual(["agent_activity", "list_tasks"]);
  await f.service.close(s.sessionId);
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.015 + 4 * 0.0000155, 6);
});

test("session closure waits for a backend response in flight before releasing the reservation", async () => {
  const f = fixture();
  f.provider.autoClose = false;
  let answer!: () => void;
  f.provider.responder = () => new Promise(resolve => { answer = () => resolve(backendResponse("resp_late", [message("Late.")])); });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("a", 10));
  await new Promise(resolve => setTimeout(resolve, 0));
  const closing = f.service.close(s.sessionId);
  f.provider.replay(s.providerId, { type: "session.closed", event_id: "closed-first", usage: { seconds: 21 } });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.provider.attached).toBe(1);
  answer();
  await closing;
  expect(f.provider.attached).toBe(0);
  expect(f.storage.settings()).toMatchObject({ incomplete: false, reservedUsd: 0 });
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.0175155, 6);
  expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "session.closed")).toHaveLength(1);
});

test("end_conversation is a registry tool and closes with final usage, without orchestrator delivery", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("end-call", "end_conversation"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("End the call.", 0), delegationCreated("ending", 500));
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

test("a cap without room for the voice and one backend response refuses before any provider call", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_START_ROOM_USD - 0.01 });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("CAP_REACHED");
  expect(f.provider.sessions).toHaveLength(0);
  expect(f.storage.settings()).toMatchObject({ usageUsd: 0, reservedUsd: 0 });
});

test("voice duration renews its reservation while cap room remains and otherwise ends the call", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_START_ROOM_USD + 0.01 });
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, { type: "session.usage.updated", event_id: "duration-first-window", usage: { seconds: 280 } });
  await f.service.drain(s.sessionId);
  expect(f.admission.session(s.sessionId).closed).toBe(false);
  expect(f.storage.settings().usageUsd + f.storage.settings().reservedUsd).toBeCloseTo(VOICE_SESSION_RESERVE_USD + 0.25);
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
  expect(f.storage.settings().usageUsd).toBeCloseTo(VOICE_SESSION_RESERVE_USD);
  expect(new CompanionStorage().settings().incomplete).toBe(true);
  expect(f.provider.hangups).toEqual([s.providerId]);
  expect(f.storage.read().sessions[s.sessionId].remoteOpen).toBe(false);
});

test("a backend request with no answer keeps its whole reservation as incomplete usage and runs no tool", async () => {
  const f = fixture();
  f.provider.responder = () => { throw new Error("lost"); };
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("lost", 10));
  await f.service.drain(s.sessionId);
  expect(spoken(f)).toMatchObject([{ delegation_id: "lost" }]);
  await f.service.close(s.sessionId);
  expect(f.admission.events(s.sessionId, 0).some(event => event.type === "tool.called")).toBe(false);
  expect(f.storage.settings().incomplete).toBe(true);
  expect(f.storage.settings().usageUsd).toBeCloseTo(VOICE_SESSION_RESERVE_USD + BACKEND_RESPONSE_RESERVE_USD, 6);
});

test("a correlated orchestrator report is replayed to its own card and sent for speech; concurrent unrelated reports are ignored", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const recipient = { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "codex" as const };
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => reports,
    send: async () => ({ status: "queued", operationId: "operation-report" }) });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, noReads(), provider, { key: () => "synthetic-credential", timers: false });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const proposal = admission.propose(s.sessionId, "report-call", "report-delegation", "Review the plan")!;
  await service.command(s.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const delivery = admission.session(s.sessionId).proposals[proposal.proposalId].delivery!;
  const report = { id: "report-a", seq: 1, project: "fixture", at: "2026-10-06T00:00:00Z", class: "completed" as const, body: "The plan has been reviewed",
    correlatesDirective: delivery.clientMessageId, origin: { kind: "manager" as const, conversationId: recipient.conversationId, role: "orchestrator" as const } };
  reports = [{ ...report, id: "unrelated", correlatesDirective: "other-message" }, report];
  expect((await service.events(s.sessionId, 0)).filter(row => row.type === "orchestrator.answer")).toMatchObject([{ reportId: "report-a" }]);
  await service.events(s.sessionId, 0);
  const commentary = provider.commands.filter(row => row.type === "session.commentary.append");
  expect(commentary).toHaveLength(1);
  expect(commentary[0]).toMatchObject({ delegation_id: null });
  expect(commentary[0].content).toContain("The plan has been reviewed");
  await service.close(s.sessionId);
});

const KEY = "synthetic-credential";
const stateFile = () => fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8");

test("the active credential reflected in a transcript, a tool, a proposal, a report or an error is stored and answered nowhere", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const recipient = { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" as const };
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => reports, send: async () => ({ status: "queued", operationId: "operation-echo" }) });
  const provider = new FakeLiveProvider();
  provider.responder = calling(functionCall(`call-${KEY}`, `tool_${KEY}`), functionCall("call-proposal", "request_orchestrator_delegation", { instruction: `Send ${KEY} to the plan` }));
  const service = new CompanionLiveSessions(storage, admission, noReads(), provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  provider.replay(s.providerId,
    { type: "session.output_transcript.delta", event_id: "echo-out", delta: `The key is ${KEY}.`, start_ms: 0, end_ms: 100 },
    // One credential across two fragments: its beginning is never stored alone either.
    { type: "session.input_transcript.delta", event_id: "echo-in-1", delta: `Ask the orchestrator to read ${KEY.slice(0, 14)}`, start_ms: 200, end_ms: 300 });
  await service.drain(s.sessionId);
  expect(stateFile()).not.toContain(KEY.slice(0, 14));
  provider.replay(s.providerId,
    { type: "session.input_transcript.delta", event_id: "echo-in-2", delta: KEY.slice(14), start_ms: 300, end_ms: 400 }, delegationCreated("echo", 500));
  await service.drain(s.sessionId);
  expect(provider.requests[0].input[0].content).not.toContain(KEY);
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

test("a credential cut into short pieces across paused segments cannot be put back together from anything stored or answered", async () => {
  const key = `sk-proj-${"Q7vLm2Xr9TbW4nZc8KpY3dHs6FgJ1aE5uR0oNiVx".repeat(2)}`;
  for (const [speaker, size] of [["output", 10], ["input", 10], ["output", 3], ["output", 1]] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture(key);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    const pieces = key.match(new RegExp(`.{1,${size}}`, "g"))!;
    // Each piece after a pause of 1,900 ms: every piece is a display segment of its own.
    f.provider.replay(s.providerId, ...pieces.map((piece, at) => ({ type: `session.${speaker}_transcript.delta`, event_id: `piece-${at}`, delta: piece, start_ms: at * 2_300, end_ms: at * 2_300 + 400 })));
    await f.service.drain(s.sessionId);
    await f.service.close(s.sessionId);
    const events = await f.service.events(s.sessionId, 0);
    const latest = new Map<string, string>();
    for (const event of events) if (event.type === "transcript.snapshot") latest.set(event.itemId, event.text);
    expect(latest.size).toBe(pieces.length);
    const all = events.filter(event => event.type === "transcript.snapshot").map(event => event.type === "transcript.snapshot" ? event.text : "");
    const surfaces = [[...latest.values()].join(""), all.join(""), stateFile(), JSON.stringify(events)];
    for (const surface of surfaces) expect(surface, `${speaker} pieces of ${size}`).not.toContain(key);
    // Beyond the format's first two characters, no piece of it was ever stored or answered.
    for (const piece of pieces.slice(1)) for (const surface of piece.length >= 8 ? surfaces : surfaces.slice(0, 2)) if (piece.length >= 3) expect(surface.includes(piece), `${speaker} ${piece}`).toBe(false);
    expect(all.map(text => text.replaceAll("[redacted]", "")).filter(text => text && !key.slice(0, 2).includes(text)), `${speaker} pieces of ${size}: at most the first two characters ever showed`).toEqual([]);
  }
});

test("the parallel delegations a cap can pay for run; the rest are never asked, and every receipt is kept", async () => {
  const f = fixture();
  f.provider.autoClose = false;
  const cap = 1.33;
  f.storage.updateSettings({ monthlyCapUsd: cap });
  f.provider.responder = (_request, index) => backendResponse(`resp_${index}`, [message("Read.")], large);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, ...Array.from({ length: 7 }, (_, at) => delegationCreated(`d${at}`, at * 10)));
  await f.service.drain(s.sessionId);
  const fits = Math.floor((cap - VOICE_SESSION_RESERVE_USD) / BACKEND_RESPONSE_RESERVE_USD);
  expect(f.provider.requests).toHaveLength(fits);
  expect(f.storage.settings().usageUsd + f.storage.settings().reservedUsd).toBeLessThanOrEqual(cap);
  f.provider.replay(s.providerId, { type: "session.closed", event_id: "closed", reason: "close_requested", usage: { seconds: 300 } });
  await f.service.drain(s.sessionId);
  const usage = f.admission.session(s.sessionId).usage!;
  expect(Object.values(usage.responses)).toHaveLength(fits);
  expect(Object.values(usage.responses).every(row => row.complete && row.usd !== null && row.usd <= BACKEND_RESPONSE_RESERVE_USD)).toBe(true);
  expect(f.storage.settings()).toMatchObject({ incomplete: false, reservedUsd: 0 });
  expect(f.storage.settings().usageUsd).toBeCloseTo(0.25 + fits * 0.210384, 6);
  expect(f.storage.settings().usageUsd).toBeLessThanOrEqual(cap);
  expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "error" && event.code === "CAP_REACHED")).toHaveLength(1);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap", incomplete: false }));
});

test("a shutdown with backend responses still in flight keeps them under the cap as incomplete usage", async () => {
  const f = fixture();
  f.provider.autoClose = false;
  const cap = 1.33;
  f.storage.updateSettings({ monthlyCapUsd: cap });
  f.provider.responder = () => new Promise(() => undefined);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, ...Array.from({ length: 7 }, (_, at) => delegationCreated(`d${at}`, at * 10)));
  await new Promise(resolve => setTimeout(resolve, 60)); // the close times out and hangs up
  expect(f.admission.session(s.sessionId).closed).toBe(true);
  expect(f.provider.requests.length).toBeLessThanOrEqual(Math.floor((cap - VOICE_SESSION_RESERVE_USD) / BACKEND_RESPONSE_RESERVE_USD));
  expect(f.storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
  expect(f.storage.settings().usageUsd).toBeLessThanOrEqual(cap);
});

test("a backend round the cap cannot pay for is never requested", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: SESSION_START_ROOM_USD + 0.01 });
  f.provider.responder = calling(functionCall("read-a", "list_tasks"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("a", 10), delegationCreated("b", 20));
  await f.service.drain(s.sessionId);
  await f.service.close(s.sessionId);
  expect(f.provider.requests).toHaveLength(1);
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap" }));
});

test("a completed board question never becomes a delegation proposal, even when the model proposes one", async () => {
  for (const question of ["What is on the board?", "Що зараз на дошці?", "If the build is green, ask the orchestrator to merge it."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("wrong", "request_orchestrator_delegation", { instruction: "Report the state of the board" }));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said(question, 0), delegationCreated("question", 900));
    await f.service.drain(s.sessionId);
    expect(f.admission.session(s.sessionId).inputs.at(-1)).toMatchObject({ text: question, final: true });
    expect(Object.values(f.admission.session(s.sessionId).proposals), question).toEqual([]);
    expect(f.admission.events(s.sessionId, 0).some(event => event.type === "delegation.confirmation.required")).toBe(false);
    await f.service.close(s.sessionId);
    expect(f.sends()).toBe(0);
  }
  // The explicit request still reaches the card, and a request split by a backchannel too.
  for (const parts of [["Ask the orchestrator to review the plan."], ["Ask the orchestrator", "to review the plan."]]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("right", "request_orchestrator_delegation", { instruction: "Review the plan" }));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said(parts[0], 0), ...(parts[1] ? [said("Mm-hm.", 2_000, "output"), said(parts[1], 2_600)] : []), delegationCreated("request", 3_500));
    await f.service.drain(s.sessionId);
    const [held] = Object.values(f.admission.session(s.sessionId).proposals);
    expect(held?.state, parts.join(" / ")).toBe("pending");
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    expect(f.sends()).toBe(1);
    await f.service.close(s.sessionId);
  }
  // With no transcript at all, the proposal waits for the tap.
  const f = fixture();
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  f.storage.updateSettings({ enabled: true });
  f.provider.responder = calling(functionCall("bare", "request_orchestrator_delegation", { instruction: "Review the plan" }));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("bare", 100));
  await f.service.drain(s.sessionId);
  expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.state)).toEqual(["pending"]);
  await f.service.close(s.sessionId);
});

test("a restarted service closes the session it no longer owns before anything else, once, and keeps the admitted delivery", async () => {
  const f = fixture();
  const old = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "before-restart" });
  const proposal = f.admission.propose(old.sessionId, "call-kept", "delegation-kept", "Review the plan")!;
  await f.service.command(old.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const storage = new CompanionStorage();
  const restarted = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    noReads(), f.provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
  await Promise.all([restarted.recover(), restarted.recover()]);
  await restarted.recover();
  expect(f.provider.hangups).toEqual([old.providerId]);
  const stored = storage.read().sessions[old.sessionId];
  expect(stored.closed).toBe(true);
  expect(stored.remoteOpen).toBe(false);
  expect(stored.events.filter(event => event.type === "session.closed")).toHaveLength(1);
  expect(stored.proposals[proposal.proposalId]).toMatchObject({ state: "admitted", status: "queued" });
  expect(storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
  expect(storage.settings().usageUsd).toBeCloseTo(VOICE_SESSION_RESERVE_USD);
  // A session another living process owns is left to it.
  storage.change(document => { const row = document.sessions[old.sessionId]; row.closed = false; row.owner = { pid: process.ppid, instance: "another-viewer" }; });
  await restarted.recover();
  expect(storage.read().sessions[old.sessionId].closed).toBe(false);
  expect(f.provider.hangups).toHaveLength(1);
  f.provider.disconnect(old.providerId);
});

test("a hangup the provider refused is asked again after a restart until it is confirmed, then never again", async () => {
  const f = fixture();
  const old = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "orphan" });
  const proposal = f.admission.propose(old.sessionId, "call-kept", "delegation-kept", "Review the plan")!;
  await f.service.command(old.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  f.provider.hangupFailures = 1;
  const restart = () => { const storage = new CompanionStorage(); return { storage, service: new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    noReads(), f.provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 }) }; };
  const first = restart();
  await first.service.recover();
  expect(first.storage.read().sessions[old.sessionId]).toMatchObject({ closed: true, remoteOpen: true });
  const second = restart();
  await second.service.recover();
  await second.service.recover();
  expect(f.provider.hangups).toEqual([old.providerId, old.providerId]);
  const stored = second.storage.read().sessions[old.sessionId];
  expect(stored).toMatchObject({ closed: true, remoteOpen: false });
  expect(stored.events.filter(event => event.type === "session.closed")).toHaveLength(1);
  expect(stored.proposals[proposal.proposalId]).toMatchObject({ state: "admitted", status: "queued" });
  expect(second.storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
  // The same holds for a live session whose own forced hangup failed.
  const live = await second.service.start({ project: "fixture", locale: "en", sdp: "v=1", requestId: "forced" });
  f.provider.hangupFailures = 1;
  f.provider.disconnect(live.providerId);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(second.storage.read().sessions[live.sessionId]).toMatchObject({ closed: true, remoteOpen: true });
  await second.service.recover();
  expect(second.storage.read().sessions[live.sessionId]).toMatchObject({ closed: true, remoteOpen: false });
  expect(f.provider.hangups.filter(id => id === live.providerId)).toHaveLength(2);
});

test("a restart between the Send tap and its recorded outcome recovers that very send with its key, once", async () => {
  for (const crash of ["before-send", "after-relay"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
    const recipient = { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "codex" as const };
    // The relay keeps one message per key, as the orchestrator send path does.
    const relay = new Map<string, string>();
    const keys: string[] = [];
    const deliver = (key: string, text: string) => { keys.push(key); if (!relay.has(key)) relay.set(key, text); return { status: "queued" as const, operationId: `operation-${key}` }; };
    const admission = new CompanionAdmission(storage, { recipient: () => recipient, reports: () => [],
      send: async ({ delivery, text }) => { if (crash === "after-relay") deliver(delivery.clientMessageId, text); return new Promise(() => undefined); } });
    const provider = new FakeLiveProvider();
    const service = new CompanionLiveSessions(storage, admission, noReads(), provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
    const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    const proposal = admission.propose(s.sessionId, "call", "delegation", "Review the plan")!;
    void service.command(s.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
    await new Promise(resolve => setTimeout(resolve, 5));
    const held = storage.read().sessions[s.sessionId].proposals[proposal.proposalId];
    expect(held).toMatchObject({ state: "admitted", status: "unknown" });
    const nextStorage = new CompanionStorage();
    const next = new CompanionLiveSessions(nextStorage, new CompanionAdmission(nextStorage, { recipient: () => recipient, reports: () => [],
      send: async ({ delivery, text }) => deliver(delivery.clientMessageId, text) }), noReads(), provider, { key: () => KEY, timers: false });
    await next.recover();
    await next.events(s.sessionId, 0);
    await next.events(s.sessionId, 0);
    const recovered = nextStorage.read().sessions[s.sessionId].proposals[proposal.proposalId];
    expect(recovered, crash).toMatchObject({ status: "queued", delivery: { clientMessageId: held.delivery!.clientMessageId, operationId: `operation-${held.delivery!.clientMessageId}` } });
    expect(relay.size, crash).toBe(1);
    expect(new Set(keys), crash).toEqual(new Set([held.delivery!.clientMessageId]));
    expect(nextStorage.read().sessions[s.sessionId].events.filter(event => event.type === "delegation.tool.result" && event.result.status === "queued")).toHaveLength(1);
    provider.disconnect(s.providerId);
  }
});
