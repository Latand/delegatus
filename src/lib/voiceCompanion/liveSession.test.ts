import { fixtureBoardReads } from "./boardReads.fixture";
import { afterAll, beforeEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendResponse, delegationCreated, FakeLiveProvider, functionCall, message } from "./fakeProvider";
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

const noReads = () => fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
function fixture(key = "synthetic-credential") {
  const storage = new CompanionStorage();
  storage.updateSettings({ enabled: true });
  let sends = 0;
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued", operationId: "operation_fixture" }; }, reports: () => [] });
  const reads = fixtureBoardReads({ tasks: () => [{ id: "task_fixture", project: "fixture", text: "Review the plan", status: "inbox" }],
    pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => key, closeTimeoutMs: 20, timers: false });
  return { storage, admission, provider, reads, service, sends: () => sends };
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

test("cap and disabled settings refuse minting before key access or provider calls", async () => {
  const f = fixture();
  f.storage.updateSettings({ monthlyCapUsd: 0 });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("CAP_REACHED");
  expect(f.provider.sessions).toHaveLength(0);
  f.storage.updateSettings({ enabled: false });
  await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("COMPANION_DISABLED");
  expect(f.provider.sessions).toHaveLength(0);
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

test("a correlated orchestrator report is replayed to its own card and sent for speech; concurrent unrelated reports are spoken once", async () => {
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
  reports = [{ ...report, id: "unrelated", seq:2, correlatesDirective: "other-message" }, report];
  expect((await service.events(s.sessionId, 0)).filter(row => row.type === "orchestrator.answer")).toMatchObject([{ reportId: "report-a" }]);
  await service.events(s.sessionId, 0);
  const commentary = provider.commands.filter(row => row.type === "session.commentary.append");
  expect(commentary).toHaveLength(2);
  expect(commentary[0]).toMatchObject({ delegation_id: null });
  expect(commentary[0].content).toContain("The plan has been reviewed");
  await service.close(s.sessionId);
});

test("reports name their own project's orchestrator after the view switches", async () => {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  let reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const recipient = (project: string) => ({ project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "codex" as const });
  const admission = new CompanionAdmission(storage, { recipient, reports: project => reports.filter(report => report.project === project),
    send: async () => ({ status: "queued", operationId: "operation-project-report" }) });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, noReads(), provider, { key: () => "synthetic-credential", timers: false });
  const session = await service.start({ project: "Alpha", locale: "en", sdp: "v=0" });
  const proposal = admission.propose(session.sessionId, "project-report", "source", "Review the plan")!;
  await service.command(session.sessionId, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" });
  const delivery = admission.session(session.sessionId).proposals[proposal.proposalId].delivery!;
  await service.context(session.sessionId, "Beta");
  const report = (project: string, seq: number, directive?: string) => ({ id: `report-${project}`, project, seq, class: "completed" as const,
    at: "2026-10-10T00:00:00Z", body: "The plan has been reviewed.", ...(directive ? { correlatesDirective: directive } : {}),
    origin: { kind: "manager" as const, conversationId: recipient(project).conversationId, role: "orchestrator" as const } });
  reports = [report("Alpha", 1, delivery.clientMessageId), report("Beta", 2)];
  await service.events(session.sessionId, 0);
  await service.events(session.sessionId, 0);
  const commentary = provider.commands.filter(command => command.type === "session.commentary.append");
  expect(commentary).toHaveLength(2);
  expect(commentary[0]!.content).toContain('project "Alpha"');
  expect(commentary[1]!.content).toContain('project "Beta"');
  await service.close(session.sessionId);
});

test("a spoken answer stays within the 500 tokens one commentary append takes, keeps its delegation and ends on a whole sentence", async () => {
  const sentence = "Оркестратор отримав запит, перевірив план і погодився з ним. ";
  const answers: Record<string, { text: string; tokens: number }> = {
    "505 tokens": { text: " a".repeat(505), tokens: 505 },
    "512 tokens": { text: "The board shows one open task. ".repeat(80), tokens: 512 },
    "dense Ukrainian": { text: sentence.repeat(12), tokens: 512 },
    "one unbroken word": { text: "ї".repeat(600), tokens: 501 },
  };
  for (const [name, answer] of Object.entries(answers)) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (_request, index) => backendResponse(`resp_${index}`, [message(answer.text)],
      { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: answer.tokens });
    const s = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0\r\n" });
    f.provider.replay(s.providerId, said("What is on the board?", 0), delegationCreated(`long-${answer.tokens}`, 600));
    await f.service.drain(s.sessionId);
    await Promise.resolve();
    expect(f.provider.refused, name).toEqual([]);
    const said_ = spoken(f);
    expect(said_, name).toHaveLength(1);
    expect(said_[0].delegation_id, name).toBe(`long-${answer.tokens}`);
    // A token holds at least one byte: 500 UTF-8 bytes are at most 500 tokens.
    expect(Buffer.byteLength(String(said_[0].content)), name).toBeLessThanOrEqual(500);
    expect(String(said_[0].content), name).toMatch(/The rest of the answer was left out\.$/);
    expect(f.admission.events(s.sessionId, 0).filter(row => row.type === "error" || row.type === "session.closed"), name).toEqual([]);
    if (name === "dense Ukrainian") expect(String(said_[0].content)).toMatch(new RegExp(`^(${sentence.trim()} )+The rest`));
    await f.service.close(s.sessionId);
  }
});

const KEY = "synthetic-credential";
const stateFile = () => fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8");
const transcriptFiles = () => fs.readdirSync(path.join(root, "state", "voice-companion", "transcripts"))
  .filter(name => name.endsWith(".jsonl")).map(name => fs.readFileSync(path.join(root, "state", "voice-companion", "transcripts", name), "utf8")).join("");

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
  for (const surface of [JSON.stringify(provider.requests), answered, stateFile(), transcriptFiles(), JSON.stringify(service.transcriptRecord(s.sessionId)), JSON.stringify(await service.events(s.sessionId, 0)), JSON.stringify(provider.commands.filter(row => row.type === "session.commentary.append"))])
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
    const surfaces = [[...latest.values()].join(""), all.join(""), stateFile(), transcriptFiles(), JSON.stringify(f.service.transcriptRecord(s.sessionId)), f.service.transcriptRecord(s.sessionId).entries.map(entry => entry.data.text ?? "").join(""), JSON.stringify(events)];
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

test("the Live backend answers board questions with read tools and the prompt keeps talk-first", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("read", "list_tasks", {}));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("What is on the board?", 0), delegationCreated("question", 900));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(0);
  expect(f.provider.requests[0].instructions).toContain("Send only an explicit operator request");
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
    const surfaces = [stored.inputs.map(row => row.text).join(""), texts([...latest.values()]), texts(events), JSON.stringify(stored), stateFile(), transcriptFiles(), JSON.stringify(f.service.transcriptRecord(s.sessionId)), f.service.transcriptRecord(s.sessionId).entries.map(entry => entry.data.text ?? "").join(""), JSON.stringify(events)]
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

test("a finished withdrawal takes a waiting confirmation off: the old tap, a retry and a restart send nothing", async () => {
  const withdrawals = [["Never mind. Cancel that request."], ["Never mind."], ["Cancel that request."], ["Забудь."], ["Скасуй."], ["Передумав."], ["Забудь. Скасуй це."]];
  for (const [withdrawal] of withdrawals) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    const proposal = backendResponse("resp_0", [functionCall("call-a", "request_orchestrator_delegation", { instruction: "Review the plan", confirmation_reason: "Two plans exist." })]);
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Shown.")]) : proposal;
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("request", 600));
    await f.service.drain(s.sessionId);
    expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.state), withdrawal).toEqual(["pending"]);
    f.provider.replay(s.providerId, said(withdrawal, 3_000), said("All right.", 4_000, "output"));
    await f.service.drain(s.sessionId);
    const session = f.admission.session(s.sessionId);
    expect(session.inputs.at(-1), withdrawal).toMatchObject({ text: withdrawal, final: true });
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

test("every recorded tool call reaches the transcript view with its own arguments and result: the request, a spoken send, a spoken cancel and a retry", async () => {
  const { transcriptRows } = await import("../../components/voiceCompanion/CompanionTranscript");
  for (const decision of ["send", "cancel"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Spoken.")])
      : String(request.input[0].content).includes("waiting for the operator's answer") ? backendResponse(`resp_${index}`, [functionCall("call-answer", "resolve_orchestrator_confirmation", { decision })])
      : backendResponse(`resp_${index}`, [functionCall(`call-ask-${index}`, "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Tell the orchestrator to delete the old presets.", 0), delegationCreated("ask", 600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, said("Shall I send it?", 1_500, "output"), said(decision === "send" ? "Yes, send it." : "Leave it for now.", 4_000), delegationCreated("answer", 4_600));
    await f.service.drain(s.sessionId);
    // The model asks the same request once more under another call id.
    f.provider.replay(s.providerId, said("Spoken.", 6_000, "output"), delegationCreated("retry", 6_600));
    await f.service.drain(s.sessionId);
    const entries = f.service.transcriptRecord(s.sessionId).entries;
    const tools = entries.filter(entry => entry.kind === "tool");
    expect(tools.map(entry => entry.data.name), decision).toContain("resolve_orchestrator_confirmation");
    expect(tools.find(entry => entry.data.name === "resolve_orchestrator_confirmation")!.data.arguments, decision).toContain(decision);
    const rows = transcriptRows(entries);
    const shown = rows.flatMap(row => row.kind === "call" ? [{ args: row.args, result: row.result }] : row.kind === "request" ? [{ args: row.args, result: row.result }] : []);
    for (const tool of tools) expect(shown, `${decision} ${String(tool.data.callId)}`).toContainEqual({ args: tool.data.arguments as string, result: (tool.data.result as string | undefined) ?? null });
    await f.service.close(s.sessionId);
  }
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

test("the Live model's decision resolves spoken confirmation without a server-side phrase list", async () => {
  for (const answer of ["Please proceed with that.", "Можеш надсилати."]) {
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

test("one completed request reaches the orchestrator once whatever Live delegation ids name it, and a repeated model request adds nothing", async () => {
  for (const parallel of [false, true]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    let askedAgain: string | null = null;
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", { instruction: "Review the plan", asked_again: askedAgain })]);
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
    // The operator saying it again in a completed turn of their own is a new request; the model alone repeating one is not.
    askedAgain = "Asks to send the review request again.";
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 3_000), delegationCreated("new-turn", 3_500));
    await f.service.drain(s.sessionId);
    expect([parallel, f.sends()]).toEqual([parallel, 2]);
    await f.service.close(s.sessionId);
  }
});

test("a request already acted on never authorizes a later turn through the lookback: thanks, a greeting, other speech and model repeats add no send, also after a restart", async () => {
  for (const after of ["Thanks.", "Hello again.", "The weather is nice today.", "Дякую."]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", { instruction: "Review the plan" })]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("delegation_first", 600));
    await f.service.drain(s.sessionId);
    expect(f.sends()).toBe(1);
    f.provider.replay(s.providerId, said("Sent.", 1_000, "output"), said(after, 3_000), delegationCreated("delegation_thanks", 3_600));
    await f.service.drain(s.sessionId);
    const rows = Object.values(f.admission.session(s.sessionId).proposals);
    expect([after, f.sends(), new Set(rows.map(row => row.delivery?.clientMessageId)).size]).toEqual([after, 1, 1]);
    // A restarted admission over the same record, asked for the later turn, sends nothing either.
    const thanksTurn = f.admission.session(s.sessionId).inputs.at(-1)!.turn;
    const again = new CompanionAdmission(f.storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
      send: async () => { throw new Error("unexpected delivery"); }, reports: () => [] });
    expect((await again.delegate(s.sessionId, "call-restart", "delegation-restart", "Review the plan", { sourceTurn: thanksTurn })).state).toBe("refused");
    // Admission does not judge the meaning of a different model instruction.
    // A different model instruction is its own request.
    f.provider.responder = calling(functionCall("merge-call", "request_orchestrator_delegation", { instruction: "Merge the branch" }));
    f.provider.replay(s.providerId, said("Sure.", 4_000, "output"), said("Ask the orchestrator to merge the branch.", 6_000), delegationCreated("delegation_new", 6_600));
    await f.service.drain(s.sessionId);
    expect([after, f.sends()]).toEqual([after, 2]);
    await f.service.close(s.sessionId);
  }
});

test("the model's judgment renews a request: natural wordings in three languages send once more, also after cancelling; a repeat the model does not mark, thanks and board questions add none", async () => {
  const cases = [
    { locale: "en" as const, instruction: "Review the plan", first: "Ask the orchestrator to review the plan.",
      again: ["Yes, send it again.", "I want you to send it again.", "Please, one more time."], quiet: ["Thanks.", "Tell me how the review went.", "Get the current task status."] },
    { locale: "uk" as const, instruction: "Проверить план", first: "Попроси оркестратора проверить план.",
      again: ["Отсылай.", "Не, всё-таки отошли, да, отошли.", "Ще раз, будь ласка."], quiet: ["Спасибо.", "Расскажи, как прошла проверка."] },
  ];
  for (const c of cases) for (const cancelled of [false, true]) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    let call = 0;
    let askedAgain: string | null = null;
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Done.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}-${call++}`, "request_orchestrator_delegation", cancelled && call === 1
        ? { instruction: c.instruction, confirmation_reason: "Confirm?", asked_again: null } : { instruction: c.instruction, asked_again: askedAgain })]);
    const s = await f.service.start({ project: "fixture", locale: c.locale, sdp: "v=0" });
    f.provider.replay(s.providerId, said(c.first, 0), delegationCreated("first", 500));
    await f.service.drain(s.sessionId);
    if (cancelled) {
      const [held] = Object.values(f.admission.session(s.sessionId).proposals);
      expect(held.state).toBe("pending");
      await f.service.command(s.sessionId, { type: "confirmation", proposalId: held.proposal.proposalId, via: "tap", decision: "cancel" });
      expect(f.sends()).toBe(0);
    } else expect(f.sends()).toBe(1);
    let at = 1_000;
    const baseline = cancelled ? 0 : 1;
    // The model raises the same words again without marking them as the operator's: thanks or a question about the board.
    for (const quiet of c.quiet) {
      f.provider.replay(s.providerId, said("Done.", at, "output"), said(quiet, at + 2_000), delegationCreated(`repeat-${at}`, at + 2_600));
      await f.service.drain(s.sessionId);
      expect([c.locale, cancelled, quiet, f.sends()]).toEqual([c.locale, cancelled, quiet, baseline]);
      at += 5_000;
    }
    // The model judges that the operator asked again: each wording sends once more.
    let expected = baseline;
    for (const again of c.again) {
      askedAgain = `Asks again: ${again}`;
      f.provider.replay(s.providerId, said("Done.", at, "output"), said(again, at + 2_000), delegationCreated(`again-${at}`, at + 2_600));
      await f.service.drain(s.sessionId);
      expected += 1;
      expect([c.locale, cancelled, again, f.sends()]).toEqual([c.locale, cancelled, again, expected]);
      at += 5_000;
    }
    await f.service.close(s.sessionId);
  }
});

test("a model repeat of a sent request while the next turn is still arriving adds no send", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
    : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", { instruction: "Review the plan" })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("delegation_first", 600));
  await f.service.drain(s.sessionId);
  f.provider.replay(s.providerId, said("Sent.", 1_000, "output"),
    { type: "session.input_transcript.delta", event_id: "unfinished", delta: "Thanks", start_ms: 3_000, end_ms: 3_400 }, delegationCreated("delegation_repeat", 3_200));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);
  await f.service.close(s.sessionId);
});


test("Russian send-it requests reach the orchestrator once and return the actual missing-seat or route refusal", async () => {
  for (const mode of ["sent", "no_seat", "refused"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    let sent = 0;
    const { sendCompanionMessage } = await import("./deliveryPaths");
    const admission = new CompanionAdmission(f.storage, {
      recipient: () => mode === "no_seat" ? null : { project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" },
      reports: () => [],
      send: async binding => { sent++; expect(binding.text).toContain("Пока ничего не делайте");
        return mode === "refused" ? sendCompanionMessage(binding, async () => Response.json({ code: "CONVERSATION_CLOSED" }, { status: 409 })) : { status: "queued", operationId: "operation_fixture" }; },
    });
    const service = new CompanionLiveSessions(f.storage, admission, noReads(), f.provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
    f.provider.responder = (request, index) => {
      const output = request.input.find(item => item.type === "function_call_output");
      if (!output) return backendResponse(`resp_${index}`, [functionCall("send-call", "request_orchestrator_delegation", { instruction: "Пока ничего не делайте с проблемами. Оператор хочет сам продолжить." })]);
      const result = JSON.parse(String(output.output));
      if (mode === "sent") expect(result).toMatchObject({ status: "sent", delivery: "queued" });
      else expect(result.reason).toContain(mode === "no_seat" ? "no designated orchestrator" : "conversation closed");
      return backendResponse(`resp_${index}`, [message(result.speech)]);
    };
    const session = await service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
    f.provider.replay(session.providerId, said("Передай только... попроси ничего не делать, я хочу сам продолжить", 0), said("Хорошо.", 700, "output"),
      said("Не, всё-таки отошли, да, отошли", 2000), said("Да.", 2700, "output"),
      said("А, ну, да, отправь ему все проблемы, которые я озвучил, скажи ему, чтобы он ничего не делал", 4000), delegationCreated("send-delegation", 4500));
    await service.drain(session.sessionId);
    for (let poll = 0; poll < 3; poll++) await service.events(session.sessionId, 0);
    expect(sent).toBe(mode === "no_seat" ? 0 : 1);
    expect(spoken(f).at(-1)?.content).toContain(mode === "sent" ? "Sent" : mode === "no_seat" ? "no designated orchestrator" : "conversation closed");
    if (mode === "refused") expect(Object.values(admission.session(session.sessionId).proposals)[0]).toMatchObject({ status: "failed", failureCode: "CONVERSATION_CLOSED" });
    await service.close(session.sessionId);
  }
});


test("the session record survives 800 fragments, keeps each segment once, and stores cleaned tool arguments, results and handoffs", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("record-call", "get_task", { taskId: "synthetic-credential" }), functionCall("record-read", "list_tasks", {}));
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  // More segments than LiveTranscript retains and more events than the replay ring.
  for (let group = 0; group < 80; group++) {
    for (let fragment = 0; fragment < 10; fragment++) {
      const at = group * 6000 + fragment * 300;
      f.provider.replay(session.providerId, said(`word-${group}-${fragment} ${group === 0 && fragment === 0 ? root + "/private.txt " : ""}`, at, group % 2 ? "input" : "output"));
    }
    await f.service.drain(session.sessionId);
  }
  f.provider.replay(session.providerId, delegationCreated("record-delegation", 500000));
  await f.service.drain(session.sessionId);
  const open = f.service.transcriptRecord(session.sessionId);
  const speech = open.entries.filter(entry => entry.kind === "utterance" || entry.kind === "reply");
  expect(speech).toHaveLength(80);
  expect(new Set(speech.map(entry => entry.id)).size).toBe(80);
  expect(speech[0].data.text).toContain("word-0-0");
  expect(speech[0].data.text).not.toContain(root);
  expect(speech[0].data.text).toContain("[path]");
  expect(speech[0].data.fragments).toHaveLength(10);
  const tool = open.entries.find(entry => entry.kind === "tool")!;
  expect(tool.data.arguments).toContain("[redacted]");
  expect(tool.data.result).toContain("PROJECT_REFUSED");
  expect(tool.data.status).toBe("failed");
  const read = open.entries.find(entry => entry.id === "tool-record-read")!;
  expect(read.data.status).toBe("done");
  expect(read.data.arguments).toBe("{}");
  expect(read.data.result).toContain("Review the plan");
  expect(open.entries.some(entry => entry.kind === "delegation")).toBe(true);
  expect(open.entries.some(entry => entry.kind === "handoff")).toBe(true);
  expect(JSON.stringify(open)).not.toContain("synthetic-credential");
  expect(f.admission.session(session.sessionId).events).toHaveLength(512);
  await f.service.close(session.sessionId);
  const fresh = new CompanionLiveSessions(f.storage, new CompanionAdmission(f.storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unused"); } }), noReads(), f.provider, { key: () => "synthetic-credential", timers: false });
  const closed = fresh.transcriptRecord(session.sessionId);
  expect(closed.entries.map(entry => entry.id)).toEqual(f.service.transcriptRecord(session.sessionId).entries.map(entry => entry.id));
  expect(closed.entries.filter(entry => entry.kind === "utterance" || entry.kind === "reply")).toHaveLength(80);
  expect(closed.entries.at(-1)?.kind).toBe("session_end");
  const file = path.join(root, "state", "voice-companion", "transcripts", `${session.sessionId}.jsonl`);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(stateFile()).not.toContain('"arguments"');
}, 20_000);


test("open work takes two reads and repeated reads across backend delegations use the call ledger", async () => {
  const f = fixture();
  const actual = spyOn(f.reads,"read");
  f.provider.responder = (request,index) => request.input.some(item=>item.type === "function_call_output")
    ? backendResponse(`resp_${index}`,[message("One open task.")])
    : backendResponse(`resp_${index}`, index === 0 ? [functionCall("open-tasks","list_tasks",{openOnly:true}),functionCall("open-pipelines","list_pipelines",{state:["open"]})] : [functionCall("tasks-again","list_tasks",{openOnly:true})]);
  const s = await f.service.start({project:"fixture",locale:"uk",sdp:"v=0"});
  f.provider.replay(s.providerId,said("Що зараз відкрито?",0),delegationCreated("board-open",600));
  await f.service.drain(s.sessionId);
  expect(actual).toHaveBeenCalledTimes(2);
  const first = f.provider.requests[1].input.filter(item=>item.type === "function_call_output").map(item=>JSON.parse(item.output as string));
  expect(first[0]).toMatchObject({total:1,shown:1,rows:[{title:"Review the plan",state:"inbox"}]});
  f.provider.replay(s.providerId,said("А які задачі відкриті?",1000),delegationCreated("board-followup",1600));
  await f.service.drain(s.sessionId);
  expect(actual).toHaveBeenCalledTimes(2);
  expect(f.provider.requests[2].input[0].content).toContain("Reads earlier in this call");
  expect(f.provider.requests[2].input[0].content).toContain("Review the plan: inbox");
  expect(JSON.parse(f.provider.requests[3].input.find(item=>item.type === "function_call_output")!.output as string)).toMatchObject({repeated:true});
  await f.service.close(s.sessionId); actual.mockRestore();
});


test("an explicit refresh reads changed persisted tasks immediately and repeated refreshes reuse that observation", async () => {
  const { saveTasks, loadTasks, taskSelectionSource } = await import("@/lib/tasks/store");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { CompanionBoardReads } = await import("./boardReads");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const at = "2026-10-10T00:00:00.000Z";
  const taskFile = path.join(root, "refresh-tasks.json");
  saveTasks([{ id: "task-refresh", project: "fixture", text: "Review the plan", status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at }], taskFile);
  const f = fixture();
  const paths = createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    loadTasks: () => loadTasks(taskFile), listTaskRecords: () => loadTasks(taskFile), taskSelectionSource: () => taskSelectionSource(taskFile),
    pipelineSelectionSource: undefined, listPipelineRecords: () => [] } });
  const reads = new CompanionBoardReads({ ...paths, resolveProject: () => "fixture" });
  const actual = spyOn(reads, "read");
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => "synthetic-credential", timers: false });
  let refresh = false;
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
    ? backendResponse(`resp_refresh_${index}`, [message("Here is the current board.")])
    : backendResponse(`resp_refresh_${index}`, [functionCall(`tasks-${index}`, "list_tasks", { openOnly: true, refresh }),
      functionCall(`tasks-repeat-${index}`, "list_tasks", { openOnly: true, refresh })]);
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const read = async (id: string) => {
    f.provider.replay(s.providerId, delegationCreated(id, 1));
    await service.drain(s.sessionId);
    return f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").map(item => JSON.parse(item.output as string));
  };
  try {
    expect((await read("initial"))[0]).toMatchObject({ total: 1 });
    saveTasks(loadTasks(taskFile).map(task => ({ ...task, status: "done" })), taskFile);
    expect((await read("ordinary-repeat"))[0]).toMatchObject({ total: 1, repeated: true });
    refresh = true;
    const fresh = await read("operator-refresh");
    expect(fresh[0]).toMatchObject({ total: 0, rows: [] });
    expect(fresh[1]).toMatchObject({ total: 0, repeated: true });
    expect(actual).toHaveBeenCalledTimes(2);
  } finally { await service.close(s.sessionId); actual.mockRestore(); }
});

test("prototype frame bytes reach backend vision while tool output and transcript carry only references", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("frame-call","view_prototype_frame",{taskId:"task_fixture",reviewId:"review-a",mediaId:"frame-a"}));
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  f.provider.replay(s.providerId,delegationCreated("frame-request",1));
  await f.service.drain(s.sessionId);
  const vision = f.provider.requests[1].input.find(item=>Array.isArray(item.content))!;
  expect((vision.content as Array<Record<string,unknown>>)[1]).toMatchObject({type:"input_image",image_url:expect.stringContaining("data:image/png;base64,"),detail:"high"});
  const output = f.provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string;
  expect(output).toContain("frame-a"); expect(output).not.toContain("base64");
  expect(JSON.stringify(f.service.transcriptRecord(s.sessionId))).not.toContain("iVBORw");
  expect(f.sends()).toBe(0); await f.service.close(s.sessionId);
});

async function credentialReadFixture(options: { taskText?: (key: string) => string; messages?: (key: string) => string[] } = {}) {
  const { saveTasks, loadTasks, taskSelectionSource } = await import("@/lib/tasks/store");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { CompanionBoardReads } = await import("./boardReads");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const key = ["Zr9QvB", "private", "credential", "Q7vLm2Xr9TbW4nZc8KpY3dHs6FgJ1aE5"].join("-");
  const pieces = key.match(/.{1,6}/g)!.join(" ");
  const at = "2026-10-10T00:00:00.000Z";
  const taskFile = path.join(root, "credential-reads.json");
  const description = "Keep the complete safe description. ".repeat(160);
  const round = { id: `pr_${"a".repeat(32)}`, taskId: "task-credential", project: "fixture", title: "Safe prototype review", createdAt: at,
    source: { conversationId: null }, publicationKey: "fixture-publication", inputDigest: "b".repeat(64),
    variants: [{ number: 1, name: "Safe variant", description, frames: [], videos: [] }],
    questions: [{ id: "choice", text: "Which variant?", options: [{ label: "Safe variant", recommended: true }] }],
    decision: { chosen: [1], comment: `Keep this safe decision. ${pieces} Keep the final sentence.`, at,
      delivery: { state: "sent" as const, clientMessageId: "fixture-choice", conversationId: null, text: "Private delivery context" } } };
  saveTasks([{ id: round.taskId, project: "fixture", text: options.taskText?.(key) ?? `Safe task ${pieces} ready`, status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, prototypeReviews: [round] },
    { id: "task-closed", project: "fixture", text: "Closed task", status: "done", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at }], taskFile);
  const transcriptPath = path.join(root, "clipping-reads.jsonl");
  const texts = options.messages?.(key) ?? [];
  fs.writeFileSync(transcriptPath, texts.map((text,index) => JSON.stringify({ type: "assistant", uuid: `clipping-${index}`, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text }] } })).join("\n") + "\n");
  const f = fixture(key);
  const paths = createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    loadTasks: () => loadTasks(taskFile), listTaskRecords: () => loadTasks(taskFile), taskSelectionSource: () => taskSelectionSource(taskFile),
    pipelineSelectionSource: undefined, listPipelineRecords: () => [] }, transcript: {
      selectedContext: { selectedConversation: () => ({ resolve: id => id === "conversation_clipping" ? { conversationId: id, engine: "claude", path: transcriptPath, project: "fixture" } : null,
        readTail: () => null }), pathAllowed: candidate => candidate === transcriptPath },
      pinnedTranscript: candidate => {
        if (candidate !== transcriptPath) return undefined;
        const descriptor = fs.openSync(candidate,"r");
        return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true };
      },
    } });
  const reads = new CompanionBoardReads({ ...paths, resolveProject: () => "fixture" });
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => key, timers: false, closeTimeoutMs: 20 });
  return { ...f, service, reads, key, description, round, transcriptPath, taskFile, paths };
}

async function expectCredentialReadSurfacesSafe(f: Awaited<ReturnType<typeof credentialReadFixture>>, sessionId: string) {
  const { withoutSeparators } = await import("./redaction");
  const surfaces = [JSON.stringify(f.provider.requests), JSON.stringify(f.provider.commands),
    JSON.stringify(await f.service.events(sessionId, 0)), JSON.stringify(f.service.transcriptRecord(sessionId)), stateFile(), transcriptFiles()];
  for (const surface of surfaces) {
    expect(withoutSeparators(surface)).not.toContain(f.key);
    expect(withoutSeparators(surface)).not.toContain(f.key.slice(0,6));
  }
}

test("whole prototype review masks active credential fragments before backend input and keeps the complete safe review", async () => {
  const f = await credentialReadFixture();
  f.provider.responder = (request, index) => {
    const output = request.input.find(item => item.type === "function_call_output");
    return backendResponse(`resp_review_${index}`, output ? [message(String(output.output))]
      : [functionCall("review-credential", "read_prototype_review", { taskId: f.round.taskId })]);
  };
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, delegationCreated("review-credential", 1));
    await f.service.drain(s.sessionId);
    const output = JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string);
    expect(output.item.rounds[0]).toMatchObject({ variants: [{ number: 1, name: "Safe variant", description: f.description }], questions: f.round.questions,
      decision: { chosen: [1], comment: "Keep this safe decision. [redacted] Keep the final sentence." } });
    expect(output.truncated).toBe(false);
    await expectCredentialReadSurfacesSafe(f, s.sessionId);
  } finally { await f.service.close(s.sessionId); }
});

test("filtered task reads mask active credential fragments before backend input, speech, browser events and transcripts", async () => {
  const f = await credentialReadFixture();
  f.provider.responder = (request, index) => {
    const output = request.input.find(item => item.type === "function_call_output");
    return backendResponse(`resp_filtered_${index}`, output ? [message(JSON.parse(output.output as string).speech)]
      : [functionCall("filtered-credential", "list_tasks", { statuses: ["inbox"], openOnly: true, query: "Safe task", ids: [f.round.taskId] })]);
  };
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, delegationCreated("filtered-credential", 1));
    await f.service.drain(s.sessionId);
    const output = JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string);
    expect(output).toMatchObject({ total: 1, shown: 1, rows: [{ title: "Safe task [redacted] ready", state: "inbox" }] });
    expect(spoken(f).at(-1)?.content).toContain("Safe task [redacted] ready");
    await expectCredentialReadSurfacesSafe(f, s.sessionId);
  } finally { await f.service.close(s.sessionId); }
});

test("cached follow-up context and repeated reads retain safe speech without reconstructing active credentials", async () => {
  const f = await credentialReadFixture();
  const actual = spyOn(f.reads, "read");
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
    ? backendResponse(`resp_cached_${index}`, [message("Safe task ready.")])
    : backendResponse(`resp_cached_${index}`, [functionCall(`cached-${index}`, "list_tasks", { openOnly: true })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    for (const id of ["first-read", "cached-follow-up"]) {
      f.provider.replay(s.providerId, delegationCreated(id, 1));
      await f.service.drain(s.sessionId);
    }
    expect(actual).toHaveBeenCalledTimes(1);
    expect(f.provider.requests[2].input[0].content).toContain("Safe task [redacted] ready: inbox");
    expect(JSON.parse(f.provider.requests[3].input.find(item => item.type === "function_call_output")!.output as string)).toMatchObject({ repeated: true });
    await expectCredentialReadSurfacesSafe(f, s.sessionId);
  } finally { await f.service.close(s.sessionId); actual.mockRestore(); }
});

for (const boundary of ["clip", "newline"] as const) test(`task ${boundary} boundaries mask complete source before shared compact projections and cached follow-ups`, async () => {
  const f = await credentialReadFixture({ taskText: key => "x".repeat(154) + (boundary === "clip" ? key : key.slice(0,6) + "\n" + key.slice(6)) + " tail" });
  const actual = spyOn(f.reads,"read");
  f.provider.responder = (request,index) => {
    const output = request.input.find(item=>item.type === "function_call_output");
    return backendResponse(`resp_boundary_${index}`, output ? [message(JSON.parse(output.output as string).speech)]
      : [functionCall(`boundary-${index}`,"list_tasks",{openOnly:true,statuses:["inbox"],query:"tail",ids:[f.round.taskId],limit:1})]);
  };
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  try {
    for (const id of ["boundary-first","boundary-cached"]) {
      f.provider.replay(s.providerId,delegationCreated(id,1)); await f.service.drain(s.sessionId);
    }
    expect(actual).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string)).toMatchObject({total:1,shown:1,more:0,rows:[{state:"inbox"}]});
    expect(f.provider.requests[2].input[0].content).toContain("Reads earlier in this call");
    expect(JSON.parse(f.provider.requests[3].input.find(item=>item.type === "function_call_output")!.output as string)).toMatchObject({repeated:true});
    await expectCredentialReadSurfacesSafe(f,s.sessionId);
    const { loadTasks } = await import("@/lib/tasks/store");
    expect(loadTasks(f.taskFile)[0].text).toContain(boundary === "clip" ? f.key : f.key.slice(0,6)+"\n"+f.key.slice(6));
  } finally { await f.service.close(s.sessionId); actual.mockRestore(); }
});

test("paged real conversation reads mask keys across maxChars and newline boundaries on every voice surface", async () => {
  const f = await credentialReadFixture({messages:key=>["Earlier safe reply", "x".repeat(314)+key+" tail", key.slice(0,6)+"\n"+key.slice(6)+" safe reply"]});
  f.provider.responder = (request,index) => {
    const output = request.input.find(item=>item.type === "function_call_output");
    return backendResponse(`resp_messages_${index}`,output ? [message(JSON.parse(output.output as string).speech)]
      : [functionCall(`messages-${index}`,"conversation_messages",{conversationId:"conversation_clipping",roles:["assistant"],since:"2026-10-10T00:00:00Z",limit:2})]);
  };
  const s = await f.service.start({project:"fixture",locale:"uk",sdp:"v=0"});
  try {
    for (const id of ["messages-first","messages-cached"]) {
      f.provider.replay(s.providerId,delegationCreated(id,1)); await f.service.drain(s.sessionId);
    }
    const output = JSON.parse(f.provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string);
    const nextCursor = output.nextCursor;
    expect(typeof nextCursor).toBe("string");
    expect(nextCursor.length).toBeLessThanOrEqual(3000);
    expect(output).toMatchObject({shown:2,truncated:true,rows:[{excerpt:"[redacted] safe reply"},{}]});
    const next = await f.reads.read("fixture","conversation_messages",f.reads.normalize("fixture","conversation_messages",{conversationId:"conversation_clipping",roles:["assistant"],since:"2026-10-10T00:00:00Z",limit:2,cursor:nextCursor}),[f.key]);
    expect(next).toMatchObject({shown:1,truncated:false,rows:[{excerpt:"Earlier safe reply"}]});
    await expectCredentialReadSurfacesSafe(f,s.sessionId);
  } finally { await f.service.close(s.sessionId); }
});

for (const order of ["newest","relevance"] as const) test(`real ${order} search masks full source before match windows, titles and voice excerpts`, async () => {
  const f = await credentialReadFixture({messages:key=>["cobalt "+"z".repeat(481)+key.slice(0,6)+"\n"+key.slice(6)+" tail", "cobalt "+key.slice(0,6)+"\n"+key.slice(6)+" end"]});
  const { indexTranscriptSources } = await import("@/lib/search/transcriptSearch");
  const { replaceConversationCatalog } = await import("@/lib/scanner/conversationCatalog");
  const stat = fs.statSync(f.transcriptPath);
  await indexTranscriptSources([{path:f.transcriptPath,project:"fixture",engine:"claude",size:stat.size,mtimeMs:stat.mtimeMs}],{complete:true});
  replaceConversationCatalog([{path:f.transcriptPath,root:"claude-projects",name:"fixture",project:"fixture",projectName:"Fixture",title:"x".repeat(93)+f.key,firstPrompt:"",engine:"claude",kind:"session",fmt:"claude",mtime:0,size:stat.size}]);
  f.provider.responder = (request,index) => {
    const output = request.input.find(item=>item.type === "function_call_output");
    return backendResponse(`resp_search_${index}`,output ? [message(JSON.parse(output.output as string).speech)]
      : [functionCall(`search-${index}`,"search_transcripts",{query:"cobalt",order})]);
  };
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  try {
    for (const id of ["search-first","search-cached"]) {
      f.provider.replay(s.providerId,delegationCreated(id,1)); await f.service.drain(s.sessionId);
    }
    const { withoutCredentials, withoutLocalPaths } = await import("./redaction");
    const projected = await f.paths.call("search_transcripts",{project:"fixture",query:"cobalt",order,limit:6},text=>withoutLocalPaths(withoutCredentials(text,[f.key])));
    expect(JSON.stringify(projected)).not.toContain(f.key.slice(0,6));
    expect(JSON.stringify(projected)).toContain("[redacted]");
    const output = JSON.parse(f.provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string);
    expect(output.shown).toBeGreaterThan(0); expect(output.total).toBeGreaterThan(0);
    expect(JSON.stringify(output)).toContain("cobalt");
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(4000);
    await expectCredentialReadSurfacesSafe(f,s.sessionId);
  } finally { await f.service.close(s.sessionId); replaceConversationCatalog([]); }
});

test("tool replay masks parsed newline fragments and pairs opaque call references while the original filter still selects", async () => {
  const f = await credentialReadFixture({taskText:key=>`Safe task ${key.slice(0,6)}\n${key.slice(6)} ready`});
  f.provider.responder = (request,index) => {
    const output = request.input.find(item=>item.type === "function_call_output");
    return backendResponse(`resp_replay_${index}`,output ? [message(JSON.parse(output.output as string).speech)]
      : [functionCall(`call-${f.key}`,"list_tasks",{query:f.key.slice(0,6)+"\n"+f.key.slice(6),openOnly:true})]);
  };
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  try {
    f.provider.replay(s.providerId,delegationCreated("replay-mask",1)); await f.service.drain(s.sessionId);
    const call = f.provider.requests[1].input.find(item=>item.type === "function_call")!;
    const output = f.provider.requests[1].input.find(item=>item.type === "function_call_output")!;
    expect(call.call_id).toMatch(/^voice_call_[a-f0-9]{32}$/);
    expect(output.call_id).toBe(call.call_id);
    expect(JSON.parse(call.arguments as string)).toEqual({query:"[redacted]",openOnly:true});
    expect(JSON.parse(output.output as string)).toMatchObject({total:1,shown:1,rows:[{title:"Safe task [redacted] ready"}]});
    await expectCredentialReadSurfacesSafe(f,s.sessionId);
  } finally { await f.service.close(s.sessionId); }
});

for (const locale of ["en","uk"] as const) test(`${locale} starting and switched project labels are scrubbed before backend context and echoed speech`, async () => {
  const key = ["Zr9QvB","label","private","0123456789abcdef"].join("-");
  const privatePath = ["","home","fixture-private","label.txt"].join("/");
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  for (const project of ["fixture","project-label"]) expect(persistProjectAliases([{source:project,target:project,displayName:`Project ${key} ${key.slice(0,6)}\n${key.slice(6)} ${privatePath}`}])).toBe(true);
  const f = fixture(key);
  f.provider.responder = (request,index) => backendResponse(`resp_label_${index}`,[message(String(request.input[0].content))]);
  const s = await f.service.start({project:"fixture",locale,sdp:"v=0"});
  try {
    f.provider.replay(s.providerId,delegationCreated("starting-label",1)); await f.service.drain(s.sessionId);
    await f.service.context(s.sessionId,"project-label");
    f.provider.replay(s.providerId,delegationCreated("switched-label",2)); await f.service.drain(s.sessionId);
    expect(f.admission.session(s.sessionId)).toMatchObject({project:"fixture",currentProject:"project-label"});
    for (const request of f.provider.requests) expect(request.input[0].content).toContain("Project currently in view: Project [redacted] [redacted] [path].");
    const surfaces = [JSON.stringify(f.provider.requests),JSON.stringify(f.provider.commands),JSON.stringify(await f.service.events(s.sessionId,0)),JSON.stringify(f.service.transcriptRecord(s.sessionId)),stateFile(),transcriptFiles()];
    for (const surface of surfaces) { expect(surface).not.toContain(key);expect(surface).not.toContain(key.slice(0,6));expect(surface).not.toContain("fixture-private"); }
  } finally { await f.service.close(s.sessionId); }
});

test("current-view context updates the same provider call and a named project targets its own orchestrator", async () => {
  const { replaceConversationCatalog } = await import("@/lib/scanner/conversationCatalog");
  const { saveTasks, loadTasks, taskSelectionSource } = await import("@/lib/tasks/store");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const at = "2026-10-10T12:00:00.000Z";
  const taskFile = path.join(root, "context-store", "tasks.json");
  replaceConversationCatalog(["Alpha","Beta"].map((projectName,index)=>({path:path.join(root,`${index}.jsonl`),root:"claude-projects" as const,name:"fixture",project:`project-${index}`,projectName,title:"Fixture",firstPrompt:"",engine:"claude" as const,kind:"session",fmt:"claude" as const,mtime:0,size:0})));
  saveTasks([0,1].map(index=>({id:`task-${index}`,project:`project-${index}`,text:`Project ${index} task`,status:"inbox" as const,placement:"unplaced" as const,assignments:[],createdAt:at,updatedAt:at})), taskFile);
  const storage = new CompanionStorage(); storage.updateSettings({enabled:true});
  const sent:string[]=[];
  const admission = new CompanionAdmission(storage,{recipient:project=>({project,conversationId:`conversation_${project}`,seatEpoch:1,engine:"claude"}),send:async binding=>{sent.push(binding.delivery.recipient.project);return {status:"delivered",operationId:"operation-a"};},reports:()=>[]});
  const provider = new FakeLiveProvider();
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    loadTasks: () => loadTasks(taskFile), listTaskRecords: () => loadTasks(taskFile), taskSelectionSource: () => taskSelectionSource(taskFile),
    pipelineSelectionSource: undefined, listPipelineRecords: () => [] } }));
  const service = new CompanionLiveSessions(storage,admission,reads,provider,{key:()=>"synthetic-credential",timers:false});
  provider.responder = (request,index)=>request.input.some(item=>item.type === "function_call_output") ? backendResponse(`resp_${index}`,[message("Done.")]) : backendResponse(`resp_${index}`,[functionCall(`tasks-${index}`,"list_tasks",{openOnly:true})]);
  const s = await service.start({project:"project-0",locale:"en",sdp:"v=0"});
  await service.context(s.sessionId,"project-1");
  provider.replay(s.providerId,delegationCreated("read-beta",1));await service.drain(s.sessionId);
  expect(JSON.parse(provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string)).toMatchObject({rows:[{title:"Project 1 task"}]});
  await service.context(s.sessionId,null);
  provider.responder = calling(functionCall("send-alpha","request_orchestrator_delegation",{project:"Alpha",instruction:"Review the Alpha plan"}));
  provider.replay(s.providerId,said("Ask Alpha's orchestrator to review the plan.",1000),delegationCreated("send-named",1600));await service.drain(s.sessionId);
  expect(sent).toEqual(["project-0"]);
  expect(provider.sessions).toHaveLength(1);expect(provider.attached).toBe(1);
  expect(admission.session(s.sessionId)).toMatchObject({project:"project-0",currentProject:null});
  expect(provider.commands.filter(row=>row.type === "session.instructions.append")).toHaveLength(2);
  expect(provider.refused).toEqual([]);
  await service.close(s.sessionId);replaceConversationCatalog([]);
});

test("backend response ids are counted once and retained token receipts reprice exactly", async () => {
  const { backendUsageUsd } = await import("./usage");
  const f = fixture();
  f.provider.responder = ()=>backendResponse("resp_same",[message("Done.")]);
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  f.provider.replay(s.providerId,delegationCreated("first",1));await f.service.drain(s.sessionId);
  f.provider.replay(s.providerId,delegationCreated("second",2));await f.service.drain(s.sessionId);
  const receipts = Object.values(f.admission.session(s.sessionId).usage!.responses);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({responseId:"resp_same",tokens:{input:100,cached:50,cacheWrite:0,output:20}});
  const tokens = receipts[0].tokens!;
  expect(receipts[0].usd).toBe(backendUsageUsd({input_tokens:tokens.input,input_tokens_details:{cached_tokens:tokens.cached,cache_write_tokens:tokens.cacheWrite},output_tokens:tokens.output}));
  await f.service.close(s.sessionId);
});


test("an older read refreshes after the reuse window and missing usage for a known response is upgraded once", async () => {
  let now = 0;
  const storage = new CompanionStorage(()=>now);storage.updateSettings({enabled:true});
  const admission = new CompanionAdmission(storage,{recipient:()=>null,reports:()=>[],send:async()=>{throw new Error("unexpected send");}},()=>now);
  const provider = new FakeLiveProvider();
  const reads = fixtureBoardReads({tasks:()=>[],pipelines:()=>[],activity:async()=>[],messages:async()=>[]});
  const actual = spyOn(reads,"read");
  const service = new CompanionLiveSessions(storage,admission,reads,provider,{key:()=>"synthetic-credential",now:()=>now,timers:false});
  provider.responder = calling(functionCall("tasks","list_tasks",{openOnly:true}));
  const s = await service.start({project:"fixture",locale:"en",sdp:"v=0"});
  provider.replay(s.providerId,delegationCreated("first-read",1));await service.drain(s.sessionId);
  now = 120001;
  provider.replay(s.providerId,delegationCreated("later-read",120002));await service.drain(s.sessionId);
  expect(actual).toHaveBeenCalledTimes(2);
  provider.responder = (_request,index)=>backendResponse("resp_recovered",[message("Done.")],index === 4 ? {} : {input_tokens:100,output_tokens:20});
  provider.replay(s.providerId,delegationCreated("incomplete-receipt",120003));await service.drain(s.sessionId);
  provider.replay(s.providerId,delegationCreated("recovered-receipt",120004));await service.drain(s.sessionId);
  const receipts=Object.values(admission.session(s.sessionId).usage!.responses).filter(row=>row.responseId === "resp_recovered");
  expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({complete:true,tokens:{input:100,cached:0,cacheWrite:0,output:20}});
  await service.close(s.sessionId);actual.mockRestore();
  expect(storage.settings().incomplete).toBe(false);
});
