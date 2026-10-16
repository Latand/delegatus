import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureBoardReads } from "./boardReads.fixture";
import { FakeLiveProvider, backendResponse, functionCall, message, delegationCreated } from "./fakeProvider";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { COMPANION_TOOL_REGISTRY } from "./tools";
import type { ToolProperty } from "./readSchemas";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-voice-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const sentinels = ["Qx7 title", "Qx7 message", "Qx7 member", "Qx7chat"];
const historyArgs = { action: "messages", chat: "Qx7chat", from: null, to: null, cursor: null, limit: null };
const sendArgs = (instruction: string) => ({ project: null, instruction, confirmation_reason: null, pending_request: null, asked_again: null });
let sequence = 0;
function fixture(backend: "api" | "codex") {
  const directory = path.join(root, String(++sequence));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.XDG_CONFIG_HOME = path.join(directory, "config");
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true, backend });
  const sent: Array<{ text: string }> = [];
  const now = () => Date.parse("2026-10-16T12:00:00Z");
  const admission = new CompanionAdmission(storage, {
    recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }), reports: () => [],
    send: async input => { sent.push(input); return { status: "queued", operationId: "operation_fixture" }; },
  }, now);
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  // Exercise registry dispatch and recording with valid hostile text in every
  // schema field, independently of project and object lookup admission.
  spyOn(reads, "resolveProject").mockReturnValue("fixture");
  spyOn(reads, "normalize").mockImplementation((_project, _name, args) => args);
  const read = spyOn(reads, "read").mockImplementation(async (_project, _name, args) => ({ status: "done", truncated: false, speech: `Qx7 private read ${JSON.stringify(args)}` }));
  const provider = new FakeLiveProvider();
  if (backend === "codex") Object.defineProperty(provider, "backend", { value: "codex" });
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", now, closeTimeoutMs: 20, timers: false,
    ownerHistory: async () => ({ available: true, chat: sentinels[3], title: sentinels[0], timeZone: "UTC", start: "2026-10-16T00:00:00Z", end: "2026-10-17T00:00:00Z", oldestStoredAt: null,
      messages: [{ messageId: 1, sentAt: "2026-10-16T09:00:00Z", author: { name: sentinels[2], username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, text: sentinels[1], media: null, truncated: false }],
      nextCursor: null, privacy: OWNER_HISTORY_PRIVACY }),
  });
  return { storage, admission, reads, read, provider, service, sent, directory };
}
function hostile(property: ToolProperty): unknown {
  if (property.enum) return property.enum.find(value => value !== null);
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (types.includes("string")) return "Qx7 hostile text".slice(0, property.maxLength ?? 100);
  if (types.includes("boolean")) return true;
  if (types.includes("integer") || types.includes("number")) return property.minimum ?? 1;
  if (types.includes("array")) return [hostile(property.items!)];
  return null;
}
function publicProjections(f: ReturnType<typeof fixture>, sessionId: string) {
  return [JSON.stringify(f.service.transcriptRecord(sessionId)), JSON.stringify(f.admission.events(sessionId, 0)),
    fs.readFileSync(path.join(f.directory, "state", "voice-companion.json"), "utf8"),
    fs.readFileSync(path.join(f.directory, "state", "voice-companion", "transcripts", `${sessionId}.jsonl`), "utf8"), JSON.stringify(f.sent)];
}
for (const backend of ["api", "codex"] as const) for (const entry of COMPANION_TOOL_REGISTRY) {
  test(`${backend}: private ${entry.name} dispatches only local tools and records no model text`, async () => {
    const f = fixture(backend);
    const args = Object.fromEntries(Object.entries(entry.parameters.properties).map(([key, property]) => [key, hostile(property)]));
    let result: unknown;
    f.provider.responder = (_request, index) => backendResponse(`response_${index}`, index === 0
      ? [functionCall("history-call", "relay_owner_history", historyArgs)] : index === 1
        ? [functionCall("Qx7-call", entry.name, args)] : [message(entry.egress ? "Yes, I passed it to the orchestrator." : "Here is the answer.")]);
    const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(session.providerId, delegationCreated("history-delegation", 600));
    if (backend === "api") await f.service.drain(session.sessionId);
    else {
      expect(await f.provider.callTool(session.providerId, "relay_owner_history", historyArgs, "history-call", "history-turn")).toMatchObject({ status: "done" });
      result = await f.provider.callTool(session.providerId, entry.name, args, "Qx7-call", "history-turn");
    }
    const record = f.service.transcriptRecord(session.sessionId);
    const row = record.entries.findLast(row => row.kind === "tool")!;
    if (entry.egress) {
      expect(row.data).toMatchObject({ name: "private_history_blocked", code: "private_history_boundary" });
      const refusal = JSON.parse(row.data.result as string);
      expect(refusal).toMatchObject({ status: "refused", sent: false });
      expect(refusal.speech).toStartWith("Nothing was sent.");
      expect(refusal.speech).toContain(backend === "api" ? "their own words" : "start a new one");
      expect(refusal.reason).toContain(backend === "api" ? "this turn" : "until the call ends");
      if (backend === "api") {
        expect(f.provider.requests).toHaveLength(2); // No paid retry after the boundary.
        expect(f.provider.commands.at(-1)?.content).toBe(refusal.speech);
        expect(f.provider.commands.at(-1)?.content).not.toContain("I passed it");
      } else expect(result).toMatchObject({ code: "private_history_boundary", sent: false });
    } else {
      expect(row.data.name).toBe(entry.name);
      expect(row.data.arguments).toBe("[arguments omitted: a Telegram group was read in this call]");
      expect(Object.keys(JSON.parse(row.data.result as string)).every(key => ["status", "code"].includes(key))).toBe(true);
      if (entry.class === "board-read") {
        expect(f.read).toHaveBeenCalledTimes(1);
        if (backend === "api") expect(JSON.stringify(f.provider.requests[2])).toContain("Qx7 private read");
        else expect(JSON.stringify(result)).toContain("Qx7 private read");
      }
    }
    expect(f.sent).toHaveLength(0);
    expect(f.admission.session(session.sessionId).proposals).toEqual({});
    for (const projection of publicProjections(f, session.sessionId)) expect(projection, entry.name).not.toContain("Qx7");
    await f.service.close(session.sessionId);
  });
}

test("API later turns withhold every private source, including a straddling voice segment, and send clean operator words", async () => {
  const f = fixture("api");
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.responder = (_request, index) => backendResponse(`response_${index}`, index === 0
    ? [functionCall("history", "relay_owner_history", historyArgs)] : index === 1
      ? [functionCall("private-read", "list_tasks", { ...Object.fromEntries(Object.keys(COMPANION_TOOL_REGISTRY.find(row => row.name === "list_tasks")!.parameters.properties).map(key => [key, null])), query: sentinels.join(" ") })]
      : [message(`Private backend answer ${sentinels.join(" ")}`)]);
  f.provider.replay(session.providerId,
    { type: "session.output_transcript.delta", event_id: "safe", delta: "Safe earlier voice answer.", start_ms: 0, end_ms: 100 },
    { type: "session.output_transcript.delta", event_id: "straddle-before", delta: "Before the read:", start_ms: 2_000, end_ms: 2_100 },
    { type: "session.input_transcript.delta", event_id: "read-ask", delta: "Read the group.", start_ms: 2_200, end_ms: 2_300 },
    delegationCreated("reading", 2_400));
  await f.service.drain(session.sessionId);
  expect(JSON.stringify(f.provider.requests[2])).toContain("Qx7 private read");
  expect(String(f.provider.commands.at(-1)?.content)).toContain(sentinels[1]);
  const mark = f.provider.requests.length;
  f.provider.replay(session.providerId,
    { type: "session.output_transcript.delta", event_id: "straddle-after", delta: sentinels.join(" "), start_ms: 2_050, end_ms: 2_100 },
    { type: "session.output_transcript.delta", event_id: "private-later", delta: sentinels.join(" "), start_ms: 5_000, end_ms: 5_100 });
  f.provider.responder = (request, index) => backendResponse(`response_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Done.")] : [functionCall("clean-send", "request_orchestrator_delegation", sendArgs("Review the build checks"))]);
  f.provider.replay(session.providerId,
    { type: "session.input_transcript.delta", event_id: "new-ask", delta: "Ask the orchestrator to review the build checks.", start_ms: 7_000, end_ms: 7_100 },
    delegationCreated("clean-delegation", 7_200));
  await f.service.drain(session.sessionId);
  const later = JSON.stringify(f.provider.requests.slice(mark));
  expect(later).not.toContain("Qx7");
  expect(later).not.toContain("Before the read:");
  expect(later).not.toContain("Private backend answer");
  expect(later).toContain("Safe earlier voice answer.");
  expect(later).toContain("withheld from you");
  expect(later).toContain("their own words");
  expect(later).toContain("review the build checks");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text).toContain("Review the build checks");
  expect(f.sent[0].text).not.toContain("Qx7");
  expect(f.provider.commands.at(-1)?.content).toBe("Done. The request is queued for the orchestrator.");
  await f.service.close(session.sessionId);
});

for (const backend of ["api", "codex"] as const) test(`${backend}: earlier confirmation works after history, and only an explicit hang-up ends the call`, async () => {
  const f = fixture(backend);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const replay = (id: string, words: string, at: number) => f.provider.replay(session.providerId,
    { type: "session.input_transcript.delta", event_id: `${id}-input`, delta: words, start_ms: at, end_ms: at + 100 },
    { type: "session.input_transcript.done", event_id: `${id}-done`, offset_ms: at + 200 }, delegationCreated(id, at + 300));
  f.provider.responder = (request, index) => backendResponse(`response_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Shall I send it?")] : [functionCall("prepare", "request_orchestrator_delegation", { ...sendArgs("Review the earlier plan"), confirmation_reason: "Confirm the scope." })]);
  replay("prepare", "Ask the orchestrator to review the plan.", 0);
  if (backend === "api") await f.service.drain(session.sessionId);
  else expect(await f.provider.callTool(session.providerId, "request_orchestrator_delegation", { ...sendArgs("Review the earlier plan"), confirmation_reason: "Confirm the scope." }, "prepare", "prepare")).toMatchObject({ status: "awaiting_confirmation" });
  f.provider.responder = (request, index) => backendResponse(`response_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Here is the group.")] : [functionCall("history", "relay_owner_history", historyArgs)]);
  replay("read", "Read the group.", 2_000);
  if (backend === "api") await f.service.drain(session.sessionId);
  else await f.provider.callTool(session.providerId, "relay_owner_history", historyArgs, "history", "read");
  f.provider.responder = (request, index) => backendResponse(`response_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Done.")] : [functionCall("confirm", "resolve_orchestrator_confirmation", { decision: "send" })]);
  replay("confirm", "Yes, send it.", 4_000);
  if (backend === "api") await f.service.drain(session.sessionId);
  else expect(await f.provider.callTool(session.providerId, "resolve_orchestrator_confirmation", { decision: "send" }, "confirm", "confirm")).toMatchObject({ status: "sent" });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text).toContain("Review the earlier plan");
  expect(f.sent[0].text).not.toContain("Qx7");
  if (backend === "codex") {
    replay("later-send", "Please send another request.", 6_000);
    expect(await f.provider.callTool(session.providerId, "request_orchestrator_delegation", sendArgs("Qx7 attempted leak"), "later-send", "later-send"))
      .toMatchObject({ code: "private_history_boundary", sent: false, speech: expect.stringContaining("rest of this call") });
    expect(f.sent).toHaveLength(1);
  }
  f.provider.responder = (request, index) => backendResponse(`response_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Done.")] : [functionCall("end", "end_conversation")]);
  replay("no-end", "What should we do next?", 8_000);
  if (backend === "api") await f.service.drain(session.sessionId);
  else expect(await f.provider.callTool(session.providerId, "end_conversation", {}, "no-end", "no-end")).toMatchObject({ status: "refused" });
  expect(f.admission.session(session.sessionId).closed).toBe(false);
  replay("end", "End the call.", 10_000);
  if (backend === "api") await f.service.drain(session.sessionId);
  else expect(await f.provider.callTool(session.providerId, "end_conversation", {}, "end", "end")).toMatchObject({ status: "ending" });
  await f.service.close(session.sessionId);
  expect(f.admission.session(session.sessionId).closed).toBe(true);
});

for (const backend of ["api", "codex"] as const) test(`${backend}: private continuation pages remain readable without recording their selectors`, async () => {
  const f = fixture(backend);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const continuation = { ...historyArgs, chat: null, cursor: "Qx7-next-page" };
  f.provider.responder = (_request, index) => backendResponse(`page_${index}`, index < 2
    ? [functionCall(`page_${index}`, "relay_owner_history", index === 0 ? historyArgs : continuation)] : [message("Here is the group.")]);
  f.provider.replay(session.providerId, delegationCreated("pages", 100));
  if (backend === "api") {
    await f.service.drain(session.sessionId);
    expect(JSON.stringify(f.provider.requests[2])).toContain(sentinels[1]);
  } else {
    await f.provider.callTool(session.providerId, "relay_owner_history", historyArgs, "page_0", "pages");
    expect(JSON.stringify(await f.provider.callTool(session.providerId, "relay_owner_history", continuation, "page_1", "pages"))).toContain(sentinels[1]);
  }
  for (const projection of publicProjections(f, session.sessionId)) expect(projection).not.toContain("Qx7");
  await f.service.close(session.sessionId);
});

for (const backend of ["api", "codex"] as const) test(`${backend}: a private read failure reaches the model but keeps candidate names out of public records`, async () => {
  const f = fixture(backend);
  f.read.mockRejectedValue(Object.assign(new Error("PROJECT_AMBIGUOUS"), { candidates: [{ name: "Qx7 candidate", openTasks: 1 }] }));
  const args = Object.fromEntries(Object.keys(COMPANION_TOOL_REGISTRY.find(row => row.name === "list_tasks")!.parameters.properties).map(key => [key, null]));
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.responder = (_request, index) => backendResponse(`failure_${index}`, index === 0
    ? [functionCall("history", "relay_owner_history", historyArgs)] : index === 1
      ? [functionCall("failed-read", "list_tasks", args)] : [message("The read failed.")]);
  f.provider.replay(session.providerId, delegationCreated("failure", 100));
  if (backend === "api") {
    await f.service.drain(session.sessionId);
    expect(JSON.stringify(f.provider.requests[2])).toContain("Qx7 candidate");
  } else {
    await f.provider.callTool(session.providerId, "relay_owner_history", historyArgs, "history", "failure");
    expect(await f.provider.callTool(session.providerId, "list_tasks", args, "failed-read", "failure")).toMatchObject({ code: "PROJECT_AMBIGUOUS" });
  }
  const row = f.service.transcriptRecord(session.sessionId).entries.findLast(row => row.kind === "tool")!;
  expect(JSON.parse(row.data.result as string)).toEqual({ status: "refused", code: "PROJECT_AMBIGUOUS" });
  for (const projection of publicProjections(f, session.sessionId)) expect(projection).not.toContain("Qx7");
  await f.service.close(session.sessionId);
});

test("API concurrent delegations keep their own privacy context when another delegation reads", async () => {
  const f = fixture("api");
  let releaseSend!: () => void;
  let started!: () => void;
  let readAnswered!: () => void;
  const sendHeld = new Promise<void>(resolve => { releaseSend = resolve; });
  const sendStarted = new Promise<void>(resolve => { started = resolve; });
  const readDone = new Promise<void>(resolve => { readAnswered = resolve; });
  f.provider.responder = async (_request, index) => {
    if (index === 0) { started(); await sendHeld; return backendResponse("clean-send", [functionCall("concurrent-send", "request_orchestrator_delegation", sendArgs("Review the earlier plan"))]); }
    if (index === 1) return backendResponse("read", [functionCall("concurrent-read", "relay_owner_history", historyArgs)]);
    if (index === 2) { readAnswered(); return backendResponse("private-answer", [message(sentinels.join(" "))]); }
    return backendResponse("clean-answer", [message("Done.")]);
  };
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(session.providerId, delegationCreated("clean-first", 100));
  await sendStarted;
  f.provider.replay(session.providerId, delegationCreated("private-second", 200));
  await readDone;
  releaseSend();
  await f.service.drain(session.sessionId);
  expect(f.sent).toHaveLength(1);
  for (const index of [0, 3]) expect(JSON.stringify(f.provider.requests[index])).not.toContain("Qx7");
  expect(f.provider.commands.find(command => command.delegation_id === "clean-first")?.content).toBe("Done. The request is queued for the orchestrator.");
  await f.service.close(session.sessionId);
});

for (const backend of ["api", "codex"] as const) test(`${backend}: an invented private tool name cannot carry group text into events or records`, async () => {
  const f = fixture(backend);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.responder = (_request, index) => backendResponse(`invented_${index}`, index === 0
    ? [functionCall("history", "relay_owner_history", historyArgs)] : index === 1
      ? [functionCall("Qx7-call", "Qx7 invented tool", { text: "Qx7 private argument" })] : [message("The tool is unavailable.")]);
  f.provider.replay(session.providerId, delegationCreated("invented", 100));
  if (backend === "api") await f.service.drain(session.sessionId);
  else {
    await f.provider.callTool(session.providerId, "relay_owner_history", historyArgs, "history", "invented");
    expect(await f.provider.callTool(session.providerId, "Qx7 invented tool", { text: "Qx7 private argument" }, "Qx7-call", "invented"))
      .toMatchObject({ status: "refused", code: "TOOL_NOT_ALLOWED" });
  }
  expect(f.service.transcriptRecord(session.sessionId).entries.findLast(row => row.kind === "tool")!.data.name).toBe("unavailable_tool");
  for (const projection of publicProjections(f, session.sessionId)) expect(projection).not.toContain("Qx7");
  await f.service.close(session.sessionId);
});
