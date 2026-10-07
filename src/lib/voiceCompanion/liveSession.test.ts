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

test("minting is server configured, a model request is delivered at once with no tap, and a later tap or a closed media call adds nothing", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("call-a", "request_orchestrator_delegation", { instruction: "Review the plan" }));
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0\r\n" });
  f.provider.replay(session.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("delegation-a", 600));
  await f.service.drain(session.sessionId);
  const [held] = Object.values(f.admission.session(session.sessionId).proposals);
  const proposal = held.proposal;
  expect(f.sends()).toBe(1);
  expect(held).toMatchObject({ state: "admitted", status: "queued", via: "auto" });
  const types = f.admission.events(session.sessionId, 0).map(event => event.type).filter(type => type.startsWith("delegation."));
  expect(types).toEqual(["delegation.tool.called", "delegation.sending", "delegation.tool.result"]);
  expect(f.provider.requests).toHaveLength(2);
  expect(JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string)).toMatchObject({ status: "sent", delivery: "queued" });
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

test("a repeated logical delegation in a later backend round reuses its stored send", async () => {
  const f = fixture();
  f.provider.responder = (_request, index) => index === 0
    ? backendResponse("resp_first", [functionCall("call-first", "request_orchestrator_delegation", { instruction: "Review the plan" })])
      : index === 1 ? backendResponse("resp_retry", [functionCall("call-retry", "request_orchestrator_delegation", { instruction: "Review the plan" })])
        : backendResponse("resp_done", [message("The request was already sent.")]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("same-logical-delegation", 10));
  await f.service.drain(s.sessionId);
  const rows = Object.values(f.admission.session(s.sessionId).proposals);
  expect(rows).toHaveLength(1);
  expect(f.sends()).toBe(1);
  expect(f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").map(item => JSON.parse(item.output as string)))
    .toEqual([{ status: "sent", delivery: "queued", speech: "Sent. It is queued for the orchestrator." },
      { status: "sent", delivery: "queued", speech: "Sent. It is queued for the orchestrator." }]);
  await f.service.close(s.sessionId);
});

test("a delayed yes from one backend turn cannot confirm a newer proposal", async () => {
  const f = fixture();
  let releaseAnswer!: () => void;
  f.provider.responder = (_request, index) => index === 0
    ? backendResponse("resp_a", [functionCall("call-a", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "A needs confirmation." })])
      : index === 2 ? new Promise(resolve => { releaseAnswer = () => resolve(backendResponse("resp_yes", [functionCall("call-yes", "resolve_orchestrator_confirmation", { decision: "send" })])); })
        : index === 3 ? backendResponse("resp_b", [functionCall("call-b", "request_orchestrator_delegation", { instruction: "Deploy the new release", confirmation_reason: "B needs confirmation." })])
          : backendResponse(`resp_${index}`, [message("Waiting for confirmation.")]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("delegation-a", 10));
  await f.service.drain(s.sessionId);
  f.provider.replay(s.providerId, delegationCreated("answer-turn-a", 20));
  for (let waited = 0; waited < 50 && f.provider.requests.length < 3; waited++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(f.provider.requests).toHaveLength(3);
  f.provider.replay(s.providerId, delegationCreated("delegation-b", 30));
  for (let waited = 0; waited < 50 && Object.values(f.admission.session(s.sessionId).proposals).length < 2; waited++) await new Promise(resolve => setTimeout(resolve, 2));
  const proposals = Object.values(f.admission.session(s.sessionId).proposals);
  expect(proposals).toHaveLength(2);
  expect(proposals.map(row => row.state)).toEqual(["pending", "pending"]);
  releaseAnswer();
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);
  expect(f.admission.outcome(s.sessionId, proposals[0]!.proposal.proposalId)).toMatchObject({ state: "sent", status: "queued" });
  expect(f.admission.outcome(s.sessionId, proposals[1]!.proposal.proposalId)).toMatchObject({ state: "awaiting" });
  await f.service.close(s.sessionId);
});

test("a backend failure after autosend reports the recorded delivery state", async () => {
  const f = fixture();
  f.provider.responder = (_request, index) => index === 0
    ? backendResponse("resp_send", [functionCall("call-send", "request_orchestrator_delegation", { instruction: "Review the plan" })])
      : Promise.reject(new Error("backend unavailable"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("delegation-after-send", 10));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);
  expect(spoken(f).at(-1)).toMatchObject({ delegation_id: "delegation-after-send", content: "The board could not be read just now. The request is queued for the orchestrator." });
  expect(spoken(f).at(-1)?.content).not.toContain("Nothing was sent");
  await f.service.close(s.sessionId);
});

test("an autosend proposal committed before a process stop keeps its admission and recovers with its delivery key", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("call-crash", "request_orchestrator_delegation", { instruction: "Review the plan" }));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const originalChange = f.storage.change.bind(f.storage);
  let interruptAfterCommit = true;
  f.storage.change = operation => {
    const result = originalChange(operation);
    const held = Object.values(f.storage.read().sessions[s.sessionId]?.proposals ?? {})[0];
    if (interruptAfterCommit && held?.state === "admitted" && held.via === "auto") {
      interruptAfterCommit = false;
      throw new Error("simulated process stop after durable proposal commit");
    }
    return result;
  };
  f.provider.replay(s.providerId, delegationCreated("delegation-crash", 10));
  await f.service.drain(s.sessionId);
  const [committed] = Object.values(f.storage.read().sessions[s.sessionId]!.proposals);
  expect(committed).toMatchObject({ state: "admitted", status: "unknown", via: "auto", delivery: { clientMessageId: expect.any(String) } });
  expect(f.sends()).toBe(0);

  const restartedStorage = new CompanionStorage();
  const recoveredKeys: string[] = [];
  const restartedAdmission = new CompanionAdmission(restartedStorage, {
    recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async ({ delivery }) => { recoveredKeys.push(delivery.clientMessageId); return { status: "queued", operationId: "recovered-operation" }; },
    reports: () => [],
  });
  const restarted = new CompanionLiveSessions(restartedStorage, restartedAdmission, noReads(), f.provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  await restarted.recover();
  await restarted.events(s.sessionId, 0);
  expect(recoveredKeys).toEqual([committed.delivery!.clientMessageId]);
  expect(restartedAdmission.outcome(s.sessionId, committed.proposal.proposalId)).toEqual({ state: "sent", status: "queued" });
  expect(f.storage.read().sessions[s.sessionId]!.proposals[committed.proposal.proposalId]).toMatchObject({ state: "admitted", status: "queued" });
  await f.provider.disconnect(s.providerId);
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

test("a completed board question never becomes a delegation, even when the model raises one", async () => {
  for (const question of ["What is on the board?", "Що зараз на дошці?", "If the build is green, ask the orchestrator to merge it."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("wrong", "request_orchestrator_delegation", { instruction: "Report the state of the board" }));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said(question, 0), delegationCreated("question", 900));
    await f.service.drain(s.sessionId);
    expect(f.admission.session(s.sessionId).inputs.at(-1)).toMatchObject({ text: question, final: true });
    expect(Object.values(f.admission.session(s.sessionId).proposals), question).toEqual([]);
    expect(f.admission.events(s.sessionId, 0).some(event => event.type === "delegation.confirmation.required" || event.type === "delegation.sending")).toBe(false);
    await f.service.close(s.sessionId);
    expect(f.sends()).toBe(0);
  }
  // The explicit request is sent at once, and a request split by a backchannel too.
  for (const parts of [["Ask the orchestrator to review the plan."], ["Ask the orchestrator", "to review the plan."]]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("right", "request_orchestrator_delegation", { instruction: "Review the plan" }));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said(parts[0], 0), ...(parts[1] ? [said("Mm-hm.", 2_000, "output"), said(parts[1], 2_600)] : []), delegationCreated("request", 3_500));
    await f.service.drain(s.sessionId);
    const [held] = Object.values(f.admission.session(s.sessionId).proposals);
    expect(held?.state, parts.join(" / ")).toBe("admitted");
    expect(f.sends()).toBe(1);
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    expect(f.sends()).toBe(1);
    await f.service.close(s.sessionId);
  }
  // With no transcript at all, the model's reading stands and the request is sent.
  const f = fixture();
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  f.storage.updateSettings({ enabled: true });
  f.provider.responder = calling(functionCall("bare", "request_orchestrator_delegation", { instruction: "Review the plan" }));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, delegationCreated("bare", 100));
  await f.service.drain(s.sessionId);
  expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.state)).toEqual(["admitted"]);
  expect(f.sends()).toBe(1);
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

test("a restart between a send and its recorded outcome recovers that very send with its key, once", async () => {
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
    void admission.delegate(s.sessionId, "call", "delegation", "Review the plan");
    await new Promise(resolve => setTimeout(resolve, 5));
    const [held] = Object.values(storage.read().sessions[s.sessionId].proposals);
    const proposal = held.proposal;
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

test("a credential said in pieces with separators between them cannot be put back together from anything stored or answered", async () => {
  const key = `sk-proj-${"Q7vLm2Xr9TbW4nZc8KpY3dHs6FgJ1aE5uR0oNiVx".repeat(2)}`;
  for (const speaker of ["input", "output"] as const) for (const gap of [" ", "\t", "\n", " \r\n "]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture(key);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    const pieces = key.match(/.{1,10}/g)!;
    f.provider.replay(s.providerId, ...pieces.map((piece, at) => ({ type: `session.${speaker}_transcript.delta`, event_id: `piece-${at}`, delta: (at ? gap : "") + piece, start_ms: at * 2_300, end_ms: at * 2_300 + 400 })));
    await f.service.drain(s.sessionId);
    await f.service.close(s.sessionId);
    const events = await f.service.events(s.sessionId, 0);
    const texts = (rows: typeof events) => rows.map(event => event.type === "transcript.snapshot" ? event.text : "").join("");
    const latest = new Map<string, typeof events[number]>();
    for (const event of events) if (event.type === "transcript.snapshot") latest.set(event.itemId, event);
    const stored = f.admission.session(s.sessionId);
    const surfaces = [stored.inputs.map(row => row.text).join(""), texts([...latest.values()]), texts(events), JSON.stringify(stored), stateFile(), JSON.stringify(events)]
      .map(surface => surface.replace(/\s|\\[tnr]/gu, ""));
    for (const surface of surfaces) {
      expect(surface.includes(key), `${speaker} ${JSON.stringify(gap)}`).toBe(false);
      for (const piece of pieces.slice(1)) expect(surface.includes(piece), `${speaker} ${JSON.stringify(gap)} ${piece}`).toBe(false);
    }
    // The beginning, once withheld, was never shown by a later piece.
    expect(surfaces[2].includes(pieces[0]), `${speaker} ${JSON.stringify(gap)}`).toBe(false);
  }
});

test("documented cache-write receipts never let the month spend past the cap, in parallel, reordered and across a shutdown", async () => {
  const written = { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_000_000 }, output_tokens: 512 };
  const official = 1_000_000 * 0.25 / 1_000_000 + 512 * 0.75 / 1_000_000;
  const cap = 1.40;
  for (const order of ["serial", "parallel-reordered", "shutdown"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.autoClose = false;
    f.storage.updateSettings({ monthlyCapUsd: cap });
    const waiting: Array<() => void> = [];
    f.provider.responder = (_request, index) => order === "serial" ? backendResponse(`resp_${index}`, [message("Read.")], written)
      : new Promise(resolve => { waiting.push(() => resolve(backendResponse(`resp_${index}`, [message("Read.")], written))); });
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    for (let at = 0; at < 7; at += 1) {
      f.provider.replay(s.providerId, delegationCreated(`d${at}`, at * 10));
      if (order === "serial") await f.service.drain(s.sessionId);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
    const asked = f.provider.requests.length;
    if (order === "parallel-reordered") for (const answer of waiting.reverse()) answer();
    if (order === "shutdown") await new Promise(resolve => setTimeout(resolve, 60)); // the cap close times out and hangs up
    else {
      f.provider.replay(s.providerId, { type: "session.closed", event_id: "closed", reason: "close_requested", usage: { seconds: 300 } });
      await f.service.drain(s.sessionId);
    }
    expect(f.admission.session(s.sessionId).closed, order).toBe(true);
    // What the provider bills by its documented rates, for every response this server asked.
    expect(0.25 + asked * official, order).toBeLessThanOrEqual(cap);
    expect(f.storage.settings().usageUsd, order).toBeLessThanOrEqual(cap);
    expect(f.storage.settings().reservedUsd, order).toBe(0);
    if (order !== "shutdown") {
      expect(f.storage.settings().usageUsd, order).toBeCloseTo(0.25 + asked * official, 6);
      expect(Object.values(f.admission.session(s.sessionId).usage!.responses).every(row => row.complete && row.usd !== null && Math.abs(row.usd - official) < 1e-9), order).toBe(true);
    } else expect(f.storage.settings().usageUsd, order).toBeGreaterThanOrEqual(0.25 + asked * official);
  }
});

test("a finished withdrawal stops a request not yet raised and takes a waiting confirmation off: the old tap, a retry and a restart send nothing", async () => {
  const withdrawals = [["Never mind. Cancel that request."], ["Never mind."], ["Cancel that request."], ["Забудь."], ["Скасуй."], ["Передумав."], ["Забудь. Скасуй це."]];
  for (const [withdrawal] of withdrawals) for (const late of [false, true]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    let answer!: () => void;
    // Raised late, the request would go at once: the withdrawal said before it stops the send. Raised early, the model asked first.
    const proposal = backendResponse("resp_0", [functionCall("call-a", "request_orchestrator_delegation", { instruction: "Review the plan", ...(late ? {} : { confirmation_reason: "Two plans exist." }) })]);
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Shown.")])
      : late ? new Promise(resolve => { answer = () => resolve(proposal); }) : proposal;
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("request", 600));
    if (!late) {
      await f.service.drain(s.sessionId);
      expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.state), withdrawal).toEqual(["pending"]);
    } else await new Promise(resolve => setTimeout(resolve, 5));
    // The withdrawal, then the companion's own next words complete it.
    f.provider.replay(s.providerId, said(withdrawal, 3_000), said("All right.", 4_000, "output"));
    if (late) { await new Promise(resolve => setTimeout(resolve, 5)); answer(); }
    await f.service.drain(s.sessionId);
    const session = f.admission.session(s.sessionId);
    expect(session.inputs.at(-1), withdrawal).toMatchObject({ text: withdrawal, final: true });
    if (late) {
      expect(Object.values(session.proposals), withdrawal).toEqual([]);
      expect(f.admission.events(s.sessionId, 0).some(event => event.type === "delegation.confirmation.required" || event.type === "delegation.sending"), withdrawal).toBe(false);
      await f.service.close(s.sessionId);
      expect(f.sends(), withdrawal).toBe(0);
      continue;
    }
    const [held] = Object.values(session.proposals);
    expect(held.state, withdrawal).toBe("cancelled");
    expect(f.admission.events(s.sessionId, 0), withdrawal).toContainEqual(expect.objectContaining({ type: "delegation.tool.result", proposalId: held.proposal.proposalId, result: { status: "cancelled", code: "source_changed" } }));
    const tap = { type: "confirmation" as const, proposalId: held.proposal.proposalId, decision: "send" as const, via: "tap" as const };
    await f.service.command(s.sessionId, tap);
    await f.service.command(s.sessionId, tap);
    // The model raising the same call again revives nothing.
    expect(f.admission.propose(s.sessionId, "call-a", "request", "Review the plan", { sourceTurn: 1 })).toBeNull();
    const storage = new CompanionStorage();
    const restarted = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
      send: async () => { throw new Error("unexpected delivery"); }, reports: () => [] }), noReads(), f.provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
    await restarted.recover();
    await restarted.command(s.sessionId, tap);
    await restarted.events(s.sessionId, 0);
    expect(storage.read().sessions[s.sessionId].proposals[held.proposal.proposalId].state, withdrawal).toBe("cancelled");
    expect(f.sends(), withdrawal).toBe(0);
    f.provider.disconnect(s.providerId);
  }
});

test("a withdrawal still arriving takes a waiting confirmation off, and ordinary speech leaves it for the answer", async () => {
  for (const [later, state] of [["Never mind, cancel that", "cancelled"], ["Забудь", "cancelled"], ["It is in the docs folder", "pending"]] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("call-a", "request_orchestrator_delegation", { instruction: "Review the plan", confirmation_reason: "Two plans exist." }));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("request", 600));
    await f.service.drain(s.sessionId);
    expect(f.sends(), later).toBe(0);
    f.provider.replay(s.providerId, said(later, 3_000));
    await f.service.drain(s.sessionId);
    const [held] = Object.values(f.admission.session(s.sessionId).proposals);
    expect(f.admission.session(s.sessionId).inputs.at(-1), later).toMatchObject({ text: later, final: false });
    expect(held.state, later).toBe(state);
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    expect(f.sends(), later).toBe(state === "pending" ? 1 : 0);
    await f.service.close(s.sessionId);
  }
});

test("no new session is minted while the provider has not confirmed an earlier one closed; the hangup is asked again until it is", async () => {
  const f = fixture();
  f.provider.autoClose = false;
  f.provider.hangupFailures = 3;
  const old = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "first" });
  await f.service.close(old.sessionId); // no session.closed arrives: the close times out and the hangup is refused
  expect(f.storage.read().sessions[old.sessionId]).toMatchObject({ closed: true, remoteOpen: true });
  const held = f.storage.settings().usageUsd;
  expect(held).toBeCloseTo(VOICE_SESSION_RESERVE_USD);
  // Refused twice more: each start asks the provider again and mints nothing.
  for (let attempt = 0; attempt < 2; attempt += 1) await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=1", requestId: "second" })).rejects.toThrow("PROVIDER_ERROR");
  expect(f.provider.sessions).toHaveLength(1);
  expect(f.provider.hangups).toEqual([old.providerId, old.providerId, old.providerId]);
  expect(f.storage.read().sessions[old.sessionId].remoteOpen).toBe(true);
  expect(Object.values(f.storage.read().sessions)).toHaveLength(1);
  // A restart keeps the obligation, and the same request then mints once the provider confirms.
  const storage = new CompanionStorage();
  const restarted = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    noReads(), f.provider, { key: () => KEY, timers: false, closeTimeoutMs: 20 });
  const next = await restarted.start({ project: "fixture", locale: "en", sdp: "v=1", requestId: "second" });
  expect(f.provider.hangups).toHaveLength(4);
  expect(f.provider.sessions.map(row => row.id)).toEqual([old.providerId, next.providerId]);
  expect(storage.read().sessions[old.sessionId]).toMatchObject({ closed: true, remoteOpen: false });
  expect(storage.read().sessions[old.sessionId].events.filter(event => event.type === "session.closed")).toHaveLength(1);
  expect(storage.settings().incomplete).toBe(true);
  await restarted.close(next.sessionId);
  f.provider.disconnect(next.providerId);
});

test("a session the provider never confirmed closed is charged for the time it may have run, and the timer asks again by itself", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  let now = Date.parse("2026-10-06T12:00:00Z");
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }, () => now);
  const provider = new FakeLiveProvider();
  provider.autoClose = false;
  provider.hangupFailures = 2;
  const service = new CompanionLiveSessions(new CompanionStorage(() => now), admission, noReads(), provider, { key: () => KEY, now: () => now, closeTimeoutMs: 10 });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  await service.close(s.sessionId);
  expect(storage.read().sessions[s.sessionId]).toMatchObject({ closed: true, remoteOpen: true });
  now += 20 * 60_000; // twenty minutes with the provider session possibly open
  await expect(service.start({ project: "fixture", locale: "en", sdp: "v=1" })).rejects.toThrow("PROVIDER_ERROR");
  expect(storage.read().charges[s.sessionId]).toMatchObject({ reserved: false, incomplete: true });
  expect(storage.read().charges[s.sessionId].usd).toBeCloseTo(20 * 0.05, 6);
  // The retry timer of the forced close confirms the hangup with no further call.
  for (let waited = 0; waited < 40 && storage.read().sessions[s.sessionId].remoteOpen; waited += 1) await new Promise(resolve => setTimeout(resolve, 100));
  expect(storage.read().sessions[s.sessionId].remoteOpen).toBe(false);
  expect(provider.hangups).toHaveLength(3);
  expect(provider.sessions).toHaveLength(1);
  const next = await service.start({ project: "fixture", locale: "en", sdp: "v=1" });
  expect(provider.sessions).toHaveLength(2);
  provider.autoClose = true;
  await service.close(next.sessionId);
});

test("end_conversation closes nothing unless the operator asked to end the call; an explicit request and the hang-up close it once", async () => {
  for (const question of ["What is on the board?", "Що зараз на дошці?", "If the review is done, end the call.", "Заверши завдання.", "Do I say “end the call”?", "Не завершуй розмову."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("end-call", "end_conversation"));
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, { ...said(question, 0), end_ms: 100 }, delegationCreated("ending", 200));
    await f.service.drain(s.sessionId);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.admission.session(s.sessionId).closed, question).toBe(false);
    expect(f.provider.commands.some(row => row.type === "session.close"), question).toBe(false);
    expect(f.admission.events(s.sessionId, 0), question).toContainEqual(expect.objectContaining({ type: "tool.result", callId: "end-call", status: "failed" }));
    expect(spoken(f), question).toHaveLength(1); // the model still answers the operator
    await f.service.close(s.sessionId); // the hang-up control
    await f.service.close(s.sessionId);
    const closed = f.admission.events(s.sessionId, 0).filter(event => event.type === "session.closed");
    expect(closed, question).toMatchObject([{ reason: "operator", incomplete: false }]);
    expect(f.storage.settings(), question).toMatchObject({ reservedUsd: 0, incomplete: false });
  }
  for (const request of ["End the call.", "Заверши розмову.", "Закончим."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = calling(functionCall("end-call", "end_conversation"));
    const s = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
    f.provider.replay(s.providerId, { ...said(request, 0), end_ms: 100 }, delegationCreated("ending", 200));
    await f.service.drain(s.sessionId);
    await f.service.close(s.sessionId);
    expect(f.admission.events(s.sessionId, 0).filter(event => event.type === "session.closed"), request).toMatchObject([{ reason: "tool", incomplete: false }]);
    expect(f.provider.commands.filter(row => row.type === "session.close"), request).toHaveLength(1);
    expect(f.storage.settings(), request).toMatchObject({ reservedUsd: 0, incomplete: false });
    expect(f.provider.attached).toBe(0);
    expect(f.sends()).toBe(0);
  }
});

test("a confirmation the model asked for is answered hands-free: the next delegation learns what waits, and the spoken yes sends once", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Spoken.")])
    : String(request.input[0].content).includes("waiting for the operator's answer") ? backendResponse(`resp_${index}`, [functionCall("call-yes", "resolve_orchestrator_confirmation", { decision: "send" })])
    : backendResponse(`resp_${index}`, [functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
  await f.service.drain(s.sessionId);
  const output = (request: number) => JSON.parse(f.provider.requests[request].input.find(item => item.type === "function_call_output")!.output as string);
  expect(f.sends()).toBe(0);
  expect(output(1)).toMatchObject({ status: "awaiting_confirmation", reason: "Deleting cannot be undone." });
  expect(f.provider.requests[0].input[0].content).not.toContain("waiting for the operator's answer");
  const [held] = Object.values(f.admission.session(s.sessionId).proposals);
  expect(held).toMatchObject({ state: "pending", proposal: { confirmation: { reason: "Deleting cannot be undone." } } });
  // The companion asks aloud, the operator answers aloud, and Live delegates the answer.
  f.provider.replay(s.providerId, said("Deleting cannot be undone. Shall I send it?", 1_500, "output"), said("Yes, send it.", 4_000), delegationCreated("answer", 4_600));
  await f.service.drain(s.sessionId);
  expect(f.provider.requests[2].input[0].content).toContain('has not been sent: "Delete the old presets"');
  expect(output(3)).toMatchObject({ status: "sent", delivery: "queued" });
  expect(f.sends()).toBe(1);
  const events = f.admission.events(s.sessionId, 0);
  expect(events.map(event => event.type).filter(type => type.startsWith("delegation."))).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result"]);
  expect(events.find(event => event.type === "delegation.confirmed")).toMatchObject({ via: "speech" });
  // A tap after the answer, and the same tool call again, add nothing.
  await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
  f.provider.replay(s.providerId, said("Send it.", 9_000), delegationCreated("again", 9_500));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);
  await f.service.close(s.sessionId);
});

test("a backend failure after spoken confirmation reports the queued delivery", async () => {
  const f = fixture();
  f.provider.responder = (_request, index) => index === 0
    ? backendResponse("resp_ask", [functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })])
      : index === 1 ? backendResponse("resp_prompt", [message("Please confirm before I send it.")])
        : index === 2 ? backendResponse("resp_yes", [functionCall("call-yes", "resolve_orchestrator_confirmation", { decision: "send" })])
          : Promise.reject(new Error("backend unavailable"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask-confirmation", 600));
  await f.service.drain(s.sessionId);
  f.provider.replay(s.providerId, said("Please confirm before I send it.", 1_500, "output"), said("Yes, send it.", 4_000), delegationCreated("answer-confirmation", 4_600));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);
  expect(Object.values(f.admission.session(s.sessionId).proposals)[0]).toMatchObject({ state: "admitted", via: "speech", status: "queued" });
  expect(spoken(f).at(-1)).toMatchObject({ delegation_id: "answer-confirmation", content: "The board could not be read just now. The request is queued for the orchestrator." });
  expect(spoken(f).at(-1)?.content).not.toContain("Nothing was sent");
  await f.service.close(s.sessionId);
});

test("a spoken no, a request taken back and an unanswered confirmation each send nothing, and the companion is told to say so", async () => {
  for (const [answer, code] of [["Leave it for today.", "operator_cancelled"], ["No, don't send it.", "source_changed"], ["Ні, не треба.", "source_changed"]] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Spoken.")])
      : index === 0 ? backendResponse(`resp_${index}`, [functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })])
      : backendResponse(`resp_${index}`, [functionCall("call-no", "resolve_orchestrator_confirmation", { decision: "cancel" })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, said("Shall I send it?", 1_500, "output"), said(answer, 4_000), delegationCreated("answer", 4_600));
    await f.service.drain(s.sessionId);
    const [held] = Object.values(f.admission.session(s.sessionId).proposals);
    expect([answer, held.state, held.cancelCode]).toEqual([answer, "cancelled", code]);
    const said_ = JSON.parse(f.provider.requests[3].input.find(item => item.type === "function_call_output")!.output as string);
    expect(said_, answer).toMatchObject({ status: "refused", code });
    expect(said_.speech, answer).toContain("Nothing was sent");
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    await f.service.close(s.sessionId);
    expect(f.sends(), answer).toBe(0);
  }
  // Nobody answers: after its time the card ends with nothing sent and the companion is told once.
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  let now = Date.now();
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { throw new Error("unexpected delivery"); }, reports: () => [] }, () => now);
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, noReads(), provider, { key: () => KEY, timers: false, closeTimeoutMs: 20, now: () => now });
  provider.responder = calling(functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." }));
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
  await service.drain(s.sessionId);
  await service.events(s.sessionId, 0);
  const told = () => provider.commands.filter(row => row.type === "session.commentary.append" && String(row.content).includes("not answered in time"));
  expect(told()).toHaveLength(0);
  now += 121_000;
  const events = await service.events(s.sessionId, 0);
  await service.events(s.sessionId, 0);
  expect(events.at(-1)).toMatchObject({ type: "delegation.tool.result", result: { status: "cancelled", code: "confirmation_expired" } });
  expect(told()).toHaveLength(1);
  await service.close(s.sessionId);
});

test("a spoken send needs the operator's own agreement in a later completed turn: a question, a condition, a negation or other speech sends nothing", async () => {
  const answers = ["What is on the board?", "Only if the tests pass.", "Not yet.", "Let's talk about the release notes.", "Що зараз на дошці?", "Так, якщо тести пройдуть.", "Да нет.", "Ну нет."];
  for (const answer of [...answers, null]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    // The model reads every answer, and none at all, as a yes.
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Spoken.")])
      : String(request.input[0].content).includes("waiting for the operator's answer") ? backendResponse(`resp_${index}`, [functionCall(`call-yes-${index}`, "resolve_orchestrator_confirmation", { decision: "send" })])
      : backendResponse(`resp_${index}`, [functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, said("Please confirm before I send it.", 1_500, "output"));
    // null: Live delegates again with no new operator speech, so the request itself is all there is.
    if (answer) f.provider.replay(s.providerId, said(answer, 4_000));
    f.provider.replay(s.providerId, delegationCreated("answer", 4_600));
    await f.service.drain(s.sessionId);
    const [held] = Object.values(f.admission.session(s.sessionId).proposals);
    expect([answer, f.sends(), held.state]).toEqual([answer, 0, "pending"]);
    const output = JSON.parse(f.provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output as string);
    expect(output, String(answer)).toMatchObject({ status: "awaiting_confirmation", code: "not_confirmed" });
    expect(output.speech, String(answer)).toContain("Nothing was sent");
    // The card's tap still answers the waiting confirmation, once.
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
    expect([answer, f.sends()]).toEqual([answer, 1]);
    expect(f.admission.session(s.sessionId).proposals[held.proposal.proposalId]).toMatchObject({ state: "admitted", via: "tap" });
    await f.service.close(s.sessionId);
  }
  // A plain spoken yes in a later turn sends the original request once, in either language, and so does a yes
  // opened by a filler word or said in the short forms speech uses ("Ну да.", "Окей.", "Угу.").
  for (const answer of ["Yes, send it.", "Так, надсилай.", "Ну да.", "Ну давай, отправляй.", "Окей.", "Угу.", "Well, yes, go ahead."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Spoken.")])
      : String(request.input[0].content).includes("waiting for the operator's answer") ? backendResponse(`resp_${index}`, [functionCall(`call-yes-${index}`, "resolve_orchestrator_confirmation", { decision: "send" })])
      : backendResponse(`resp_${index}`, [functionCall("call-ask", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, said("Please confirm before I send it.", 1_500, "output"), said(answer, 4_000), delegationCreated("answer", 4_600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, said("Sent.", 5_000, "output"), said(answer, 8_000), delegationCreated("answer-again", 8_600));
    await f.service.drain(s.sessionId);
    expect([answer, f.sends()]).toEqual([answer, 1]);
    expect(Object.values(f.admission.session(s.sessionId).proposals)[0]).toMatchObject({ state: "admitted", via: "speech" });
    await f.service.close(s.sessionId);
  }
});

test("one completed request reaches the orchestrator once whatever Live delegation ids name it, and the same words in a new turn are a new request", async () => {
  for (const parallel of [false, true]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", { instruction: "Review the plan" })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("first", 500));
    if (!parallel) await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, delegationCreated("retry-other-id", 500));
    await f.service.drain(s.sessionId);
    const rows = Object.values(f.admission.session(s.sessionId).proposals);
    expect([parallel, f.sends(), rows.length]).toEqual([parallel, 1, 1]);
    const outputs = f.provider.requests.filter(request => request.input.some(item => item.type === "function_call_output"))
      .map(request => JSON.parse(request.input.find(item => item.type === "function_call_output")!.output as string));
    expect(outputs).toEqual([{ status: "sent", delivery: "queued", speech: "Sent. It is queued for the orchestrator." }, { status: "sent", delivery: "queued", speech: "Sent. It is queued for the orchestrator." }]);
    // A restarted admission over the same record finds the same send and its key.
    const key = rows[0].delivery!.clientMessageId;
    const again = new CompanionAdmission(f.storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
      send: async () => { throw new Error("unexpected delivery"); }, reports: () => [] });
    expect(await again.delegate(s.sessionId, "call-after-restart", "delegation-after-restart", "Review the plan", { sourceTurn: rows[0].sourceTurn })).toEqual({ state: "sent", status: "queued" });
    expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.delivery?.clientMessageId)).toEqual([key]);
    // The operator asks the same thing again in a new turn: that is a new request.
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 3_000), delegationCreated("new-turn", 3_500));
    await f.service.drain(s.sessionId);
    expect([parallel, f.sends()]).toEqual([parallel, 2]);
    await f.service.close(s.sessionId);
  }
});
