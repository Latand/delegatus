import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureBoardReads } from "./boardReads.fixture";
import { FakeLiveProvider, backendResponse, functionCall, message, delegationCreated } from "./fakeProvider";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-voice-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
for (const backend of ["api", "codex"] as const) test(`${backend} backend can answer privately and cannot forward history to another tool`, async () => {
  process.env.LLV_STATE_DIR = path.join(root, backend, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, backend, "config");
  const title = "Synthetic private group sentinel";
  const text = "Synthetic private message sentinel";
  const secondPageText = "Synthetic private second page sentinel";
  const member = "Synthetic private member sentinel";
  const chat = "synthetic-chat";
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const sent: unknown[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }), reports: () => [], send: async input => { sent.push(input); throw new Error("unexpected send"); } });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  if (backend === "codex") {
    Object.defineProperty(provider, "backend", { value: "codex" });
    storage.updateSettings({ enabled: true, backend: "codex" });
  }
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", closeTimeoutMs: 20, timers: false,
    ownerHistory: async args => {
      const query = args as Record<string, unknown>;
      return { available: true, chat, title, timeZone: "Europe/Kyiv", start: "2026-10-12T00:00:00+03:00", end: "2026-10-13T00:00:00+03:00", oldestStoredAt: null,
        messages: [{ messageId: query.cursor ? 2 : 1, sentAt: "2026-10-12T09:00:00Z", author: { name: member, username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, text: query.cursor ? secondPageText : text, media: null, truncated: false }],
        nextCursor: query.cursor ? null : "synthetic-cursor", privacy: OWNER_HISTORY_PRIVACY };
    } });
  if (backend === "api") provider.responder = (request, index) => {
    if (request.input.some(item => item.type === "function_call" && item.name === "private_history_blocked"))
      return backendResponse(`response_${index}`, [message("I can only use that history to answer you here.")]);
    if (request.input.some(item => item.type === "function_call_output" && JSON.stringify(item).includes(secondPageText)))
      return backendResponse(`response_${index}`, [functionCall(`attempt-${text}`, "request_orchestrator_delegation", { instruction: `Review ${title}, ${member}, ${chat}: ${text}`, confirmation_reason: null })]);
    if (request.input.some(item => item.type === "function_call_output" && JSON.stringify(item).includes(text)))
      return backendResponse(`response_${index}`, [functionCall("continuation-call", "relay_owner_history", { action: "messages", chat: null, from: null, to: null, cursor: "synthetic-cursor", limit: null })]);
    if (request.input.some(item => item.type === "function_call_output")) return backendResponse(`response_${index}`, [message("I can only use that history to answer you here.")]);
    return backendResponse(`response_${index}`, [functionCall("history-call", "relay_owner_history", { action: "messages", chat, from: null, to: null, cursor: null, limit: null })]);
  };
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n" });
  provider.replay(session.providerId, delegationCreated("history-delegation", 600));
  if (backend === "api") {
    await service.drain(session.sessionId);
    expect(provider.requests.length).toBe(4);
    expect(JSON.stringify(provider.requests[1])).toContain(text); // The history page is available to answer this operator.
    expect(JSON.stringify(provider.requests[2])).toContain(secondPageText); // A continuation remains available in the private context.
    const nextTurn = provider.requests[3].input.filter(item => item.type === "function_call" && item.name === "private_history_blocked");
    expect(nextTurn).toHaveLength(1);
    expect(nextTurn[0]).toMatchObject({ name: "private_history_blocked", arguments: "{}" });
    for (const sentinel of [title, text, member, chat]) expect(JSON.stringify(nextTurn)).not.toContain(sentinel);

    provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
      ? backendResponse(`later_answer_${index}`, [message("I can only use that history to answer you here.")])
      : backendResponse(`later_call_${index}`, [functionCall("later-send", "request_orchestrator_delegation", { instruction: `Forward ${text}` })]);
    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "later-operator-turn", delta: "Please pass that along.", start_ms: 700, end_ms: 900 },
      delegationCreated("later-delegation", 1_000));
    await service.drain(session.sessionId);
    const laterBlocked = admission.events(session.sessionId, 0).find(event => event.type === "tool.called" && event.name === "private_history_blocked");
    expect(laterBlocked).toBeDefined();
    expect(admission.session(session.sessionId).proposals).toEqual({});
    expect(sent).toHaveLength(0);

    provider.responder = (_request, index) => index % 2 === 0
      ? backendResponse(`end_call_${index}`, [functionCall("end-after-history", "end_conversation")])
      : backendResponse(`end_answer_${index}`, [message("The call is ending.")]);
    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "no-end-request", delta: "What should we do next?", start_ms: 1_100, end_ms: 1_300 },
      delegationCreated("unrequested-end-delegation", 1_400));
    await service.drain(session.sessionId);
    expect(admission.session(session.sessionId).closed).toBe(false);
    expect(admission.events(session.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "tool.result", status: "failed" }));

    provider.responder = (_request, index) => index % 2 === 0
      ? backendResponse(`end_call_${index}`, [functionCall("end-after-history", "end_conversation")])
      : backendResponse(`end_answer_${index}`, [message("The call is ending.")]);
    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "explicit-end", delta: "End the call.", start_ms: 1_500, end_ms: 1_700 },
      delegationCreated("end-delegation", 1_800));
    await service.drain(session.sessionId);
    expect(admission.session(session.sessionId).closed).toBe(true);
  } else {
    const history = await provider.callTool(session.providerId, "relay_owner_history", { action: "messages", chat, from: null, to: null, cursor: null, limit: null }, "history-call", "history-turn");
    expect(JSON.stringify(history)).toContain(text); // The Codex turn can use the page to answer its operator.
    const continuation = await provider.callTool(session.providerId, "relay_owner_history", { action: "messages", chat: null, from: null, to: null, cursor: "synthetic-cursor", limit: null }, "continuation-call", "history-turn");
    expect(JSON.stringify(continuation)).toContain(secondPageText);
    const blockedResult = await provider.callTool(session.providerId, "request_orchestrator_delegation", {
      project: null, instruction: `Review ${title}, ${member}, ${chat}: ${text}`, confirmation_reason: null, pending_request: null, asked_again: null,
    }, `attempt-${text}`, "history-turn");
    expect(blockedResult).toMatchObject({ status: "refused", code: "private_history_boundary" });

    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "codex-later-turn", delta: "Please pass that along.", start_ms: 700, end_ms: 900 },
      { type: "session.input_transcript.done", event_id: "codex-later-turn-done", offset_ms: 1_000 },
      delegationCreated("codex-later-delegation", 1_000),
      { type: "codex.turn.started", event_id: "codex-later-started", turnId: "later-turn" });
    const laterBlockedResult = await provider.callTool(session.providerId, "request_orchestrator_delegation", {
      project: null, instruction: `Forward ${text}`, confirmation_reason: null, pending_request: null, asked_again: null,
    }, "later-attempt", "later-turn");
    expect(laterBlockedResult).toMatchObject({ status: "refused", code: "private_history_boundary" });
    expect(sent).toHaveLength(0);

    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "codex-no-end-request", delta: "What should we do next?", start_ms: 1_100, end_ms: 1_300 },
      { type: "session.input_transcript.done", event_id: "codex-no-end-request-done", offset_ms: 1_400 },
      delegationCreated("codex-unrequested-end-delegation", 1_400),
      { type: "codex.turn.started", event_id: "codex-unrequested-end-started", turnId: "unrequested-end-turn" });
    const unrequestedEnd = await provider.callTool(session.providerId, "end_conversation", {}, "unrequested-end", "unrequested-end-turn");
    expect(unrequestedEnd).toMatchObject({ status: "refused" });
    expect(admission.session(session.sessionId).closed).toBe(false);

    provider.replay(session.providerId,
      { type: "session.input_transcript.delta", event_id: "codex-explicit-end", delta: "End the call.", start_ms: 1_500, end_ms: 1_700 },
      { type: "session.input_transcript.done", event_id: "codex-explicit-end-done", offset_ms: 1_800 },
      delegationCreated("codex-end-delegation", 1_800),
      { type: "codex.turn.started", event_id: "codex-end-started", turnId: "end-turn" });
    const endResult = await provider.callTool(session.providerId, "end_conversation", {}, "end-after-history", "end-turn");
    expect(endResult).toMatchObject({ status: "ending" });
  }
  const rootState = path.join(root, backend, "state");
  const record = service.transcriptRecord(session.sessionId);
  const tool = record.entries.find(entry => entry.kind === "tool" && entry.data.name === "relay_owner_history")!;
  expect(JSON.parse(tool.data.result as string)).toEqual({ status: "done", speech: "1 messages, oldest first. More follow: call again with cursor set to nextCursor." });
  const projections = [JSON.stringify(record), JSON.stringify(admission.events(session.sessionId, 0)),
    fs.readFileSync(path.join(rootState, "voice-companion.json"), "utf8"),
    fs.readFileSync(path.join(rootState, "voice-companion", "transcripts", `${session.sessionId}.jsonl`), "utf8")];
  for (const projection of projections) for (const sentinel of [title, text, secondPageText, member, chat]) expect(projection).not.toContain(sentinel);
  const blocked = record.entries.find(entry => entry.kind === "tool" && entry.data.name === "private_history_blocked")!;
  expect(blocked.data.arguments).toBe("[private owner history arguments omitted]");
  for (const sentinel of [title, text, secondPageText, member, chat]) expect(JSON.stringify(blocked)).not.toContain(sentinel);
  expect(sent).toHaveLength(0);
  if (backend === "api") expect(provider.commands.some(command => command.type === "session.commentary.append" && String(command.content).includes("I can only use that history to answer you here."))).toBe(true);
  if (backend === "codex") {
    for (let waited = 0; waited < 20 && !admission.session(session.sessionId).closed; waited += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(admission.session(session.sessionId).closed).toBe(true);
  }
  await service.close(session.sessionId);
});
