import { fixtureBoardReads } from "./boardReads.fixture";
import { afterAll, afterEach, beforeEach, expect, jest, test, spyOn } from "bun:test";
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
const { shutdownTranscriptSearchWorker } = await import("@/lib/search/transcriptSearchWorker");
const { replaceConversationCatalog, conversationCatalogSnapshot } = await import("@/lib/scanner/conversationCatalog");
const { saveTasks: clearTaskRows } = await import("@/lib/tasks/store");
const taskFiles = new Set<string>();
function taskStoreFixture(...parts: string[]) {
  const filename = path.join(root, ...parts);
  taskFiles.add(filename);
  return filename;
}
function completedCatalogFixture() {
  return {
    projectCatalog: conversationCatalogSnapshot().map(row => ({
      project: row.project, displayName: row.projectName, smt: row.mtime, conversations: 1,
    })),
    files: [],
  };
}
// The real search cases start the leased query worker; it must not outlive the file.
afterAll(async () => {
  await shutdownTranscriptSearchWorker();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  replaceConversationCatalog([]);
});
afterEach(() => {
  // Clear both persisted tasks and the membership their public writer retains.
  for (const filename of taskFiles) clearTaskRows([], filename);
  taskFiles.clear();
  replaceConversationCatalog([]);
});

const noReads = () => fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
function fixture(key = "synthetic-credential", prototype?: import("@/lib/tasks/types").BoardTask, now = Date.now) {
  const storage = new CompanionStorage(now);
  storage.updateSettings({ enabled: true });
  let sends = 0;
  const reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
    send: async () => { sends++; return { status: "queued", operationId: "operation_fixture" }; }, reports: () => reports }, now);
  const reads = fixtureBoardReads({ tasks: () => [prototype ?? { id: "task_fixture", project: "fixture", text: "Review the plan", status: "inbox" }],
    pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => key, closeTimeoutMs: 20, timers: false, now });
  return { storage, admission, provider, reads, service, reports, sends: () => sends };
}
/** Answers a first round with the given calls and every later round with speech. */
const calling = (...calls: Array<ReturnType<typeof functionCall>>) => (request: BackendRequest, index: number) =>
  request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Here is what I found.")]) : backendResponse(`resp_${index}`, calls);
const said = (delta: string, at: number, speaker: "input" | "output" = "input") =>
  ({ type: `session.${speaker}_transcript.delta`, event_id: `${speaker}-${at}-${delta}`, delta, start_ms: at, end_ms: at + 400 });
const spoken = (f: ReturnType<typeof fixture>) => f.provider.commands.filter(row => row.type === "session.commentary.append");
const large = { input_tokens: 1_050_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 512 };

async function seatVoiceFixture(lines: unknown[], engine: "claude" | "codex" = "claude", credential = "synthetic-credential") {
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const project = "voice-seat";
  const filename = path.join(root, `seat-${engine}.jsonl`);
  fs.writeFileSync(filename, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  beginOrchestratorSeatIntent({ project, mandate: "Own this board", clientRequestId: "voice-seat", mode: "spawn", promptVersion: null });
  completeOrchestratorSeatIntent({ project, clientRequestId: "voice-seat", conversationId: "conversation_voice_seat", path: filename });
  const paths = createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies, taskSelectionSource: undefined,
    pipelineSelectionSource: undefined, listTaskRecords: () => [], listPipelineRecords: () => [],
  }, transcript: {
    selectedContext: { selectedConversation: () => ({ resolve: id => id === "conversation_voice_seat" ? { conversationId: id, engine, path: filename, project } : null,
      readTail: () => { throw new Error("No whole transcript read"); } }), pathAllowed: candidate => candidate === filename },
    pinnedTranscript: candidate => { expect(candidate).toBe(filename); const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true }; },
  } });
  const f = fixture(credential);
  const reads = new CompanionBoardReads(paths);
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => credential, timers: false });
  const s = await service.start({ project, locale: "en", sdp: "v=0" });
  let turn = 0;
  return { ...f, reads, service, s, filename, async tool(name: string, args: Record<string, unknown> = {}) {
    const id = `seat-read-${++turn}`;
    f.provider.responder = calling(functionCall(id, name, args));
    f.provider.replay(s.providerId, delegationCreated(id, turn * 1000));
    await service.drain(s.sessionId);
    return JSON.parse(String(f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").at(-1)!.output));
  } };
}
const seatLine = (role: "user" | "assistant", text: string, second: number) => ({ type: role,
  timestamp: `2026-10-12T06:37:${String(second).padStart(2, "0")}.000Z`, message: { role, content: [{ type: "text", text }] } });

test("October 12: the second latest orchestrator message is whole in one voice tool round and older handles survive appends", async () => {
  const reply = "Перевірка повідомлення.\n".repeat(80);
  const f = await seatVoiceFixture([seatLine("user", "Earlier question", 0), seatLine("assistant", "Earlier answer", 1),
    seatLine("user", "[Voice Delegatus reply: read the answer]", 2), seatLine("assistant", "One short note", 3),
    seatLine("assistant", reply, 4), seatLine("assistant", "Reply options below the message.", 5)]);
  try {
    const result = await f.tool("orchestrator_messages", { project: null, message: null, offset: null, at: null, before: null, limit: null, refresh: null });
    expect(result.rows[1]).toMatchObject({ text: reply, after: "voice" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16000);
    expect(f.provider.requests).toHaveLength(2);
    fs.appendFileSync(f.filename, [seatLine("user", "Seat tick — check progress", 6), seatLine("assistant", "Wake bulletin", 7)].map(line => JSON.stringify(line)).join("\n") + "\n");
    const older = await f.tool("orchestrator_messages", { before: result.rows[2].handle });
    expect(older.rows.map((row: { text: string }) => row.text)).toEqual(["Earlier answer"]);
  } finally { await f.service.close(f.s.sessionId); }
});

test.each(["claude", "codex"] as const)("%s latest reads and shows reach a reply behind incoming-only pages within the descriptor budget", async (engine) => {
  const reply = "The latest complete answer.\n".repeat(110).trimEnd();
  const lines = [seatLine("user", "Read the answer", 0), seatLine("assistant", reply, 1),
    ...Array.from({ length: 25 }, (_, index) => seatLine("user", `Seat tick — incoming ${index}`, index + 2))];
  const f = await seatVoiceFixture(engine === "claude" ? lines : lines.map(line => ({ type: "response_item", timestamp: line.timestamp,
    payload: { type: "message", role: line.type, content: [{ type: line.type === "user" ? "input_text" : "output_text", text: line.message.content[0].text }] } })), engine);
  const read = fs.readSync;
  let bytes = 0;
  const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
    const count = read(...args); bytes += count; return count;
  }) as typeof read);
  try {
    const result = await f.tool("orchestrator_messages");
    expect(result.rows).toMatchObject([{ text: reply }]);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    bytes = 0;
    expect(await f.tool("show_orchestrator_message", { read_aloud: false })).toMatchObject({ status: "shown" });
    expect(f.service.transcriptRecord(f.s.sessionId).entries.filter(row => row.kind === "report")).toMatchObject([{ data: { text: reply } }]);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { reads.mockRestore(); await f.service.close(f.s.sessionId); }
});

test("a capped incoming-only read returns progress that reaches the latest reply on its next call", async () => {
  const f = await seatVoiceFixture([seatLine("assistant", "Answer before the incoming pages", 0),
    ...Array.from({ length: 36 }, (_, index) => seatLine("user", `Seat tick — ${index} ${"x".repeat(50000)}`, 1))]);
  try {
    const first = await f.tool("orchestrator_messages");
    expect(first).toMatchObject({ rows: [], more: true, truncated: true });
    expect(first.before).toBeString();
    expect(first.scanned.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    fs.appendFileSync(f.filename, JSON.stringify(seatLine("user", "Seat tick — appended after the read", 2)) + "\n");
    const next = await f.tool("orchestrator_messages", { before: first.before });
    expect(next.rows).toMatchObject([{ text: "Answer before the incoming pages" }]);
    expect(next.scanned.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await f.tool("show_orchestrator_message", { message: next.rows[0].handle, read_aloud: false })).toMatchObject({ status: "shown" });
    const stale = first.before.replace(/[0-9a-f]{6}$/u, "000000");
    expect(await f.tool("orchestrator_messages", { before: stale })).toMatchObject({ status: "stale_handle" });
  } finally { await f.service.close(f.s.sessionId); }
});

test("voice reads a long Unicode message in two calls and targets stable handles or times", async () => {
  const long = ("Їжак 🎙 перевіряє рядок.\n".repeat(400));
  expect(Buffer.byteLength(long)).toBeGreaterThan(12000);
  expect(Buffer.byteLength(long)).toBeLessThan(24000);
  const f = await seatVoiceFixture([seatLine("user", "Typed request", 0), seatLine("assistant", "Earlier reply", 1), seatLine("assistant", long, 3)]);
  try {
    const first = await f.tool("orchestrator_messages");
    const row = first.rows[0];
    expect(row.text.endsWith("\n")).toBe(true);
    expect(row.text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(row.text)).toBeLessThanOrEqual(12000);
    const second = await f.tool("orchestrator_messages", { message: row.rest.message, offset: row.rest.offset });
    expect(second.item.next).toBeNull();
    expect(row.text + second.item.text).toBe(long);
    const timed = await f.tool("orchestrator_messages", { at: "2026-10-12T06:37:02Z" });
    expect(timed.item.text).toBe("Earlier reply");
    const exact = await f.tool("orchestrator_messages", { message: timed.item.handle });
    expect(exact.item.text).toBe("Earlier reply");
    const stale = row.handle.replace(/[0-9a-f]{6}$/u, "000000");
    expect(await f.tool("orchestrator_messages", { message: stale })).toMatchObject({ status: "stale_handle" });
    const invalid = row.handle.replace(/^m([^.]+)/u, (_whole: string, seq: string) => `m${(parseInt(seq, 36) + 1).toString(36)}`);
    expect(await f.tool("orchestrator_messages", { message: invalid })).toMatchObject({ status: "not_found" });
    expect(await f.tool("orchestrator_messages", { before: invalid })).toMatchObject({ status: "not_found" });
    expect(await f.tool("orchestrator_messages", { before: row.handle.replace(/\.\d+\./u, ".999.") })).toMatchObject({ status: "not_found" });
    for (const value of [first, second, timed, exact]) expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(16000);
  } finally { await f.service.close(f.s.sessionId); }
});

test("voice labels the opening prompts and Codex commentary and final replies match Claude", async () => {
  const { relayMessageText } = await import("@/lib/orchestrator/relayText");
  const { prototypeTask } = await import("./prototypeRead.fixture");
  const { prototypeDecisionText } = await import("@/lib/prototypeReview/decision");
  const { composeSpawnNotice } = await import("@/lib/spawnNotice/sweep");
  const task = prototypeTask();
  const producer = fixture(); const request = producer.admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  await producer.admission.delegate(request.id, "voice-envelope", "voice-envelope", "Read the answer");
  const voiceText = Object.values(producer.admission.session(request.id).proposals)[0].text!;
  const form = prototypeDecisionText(task, { ...task.prototypeReviews![0], questions: [] }, { chosen: [1], comment: "Use the first", answers: [] });
  const notice = composeSpawnNotice({ child: "conversation_worker", title: "Checks", final: { text: "All checks pass", error: null }, turns: [{ kind: "turn", childConversationId: "conversation_worker", turnId: "worker-turn", launcherConversationId: "conversation_seat", outcome: "completed", startedAt: null, endedAt: "2026-10-15T12:00:00Z", state: "pending", reason: null, recipientConversationId: null, clientMessageId: null, operationId: null, settledAt: null }] });
  const prompts = ["Seat tick — progress", voiceText, form, relayMessageText("Please inspect the lane", "Another project"), notice, "Typed question"];
  for (const engine of ["claude", "codex"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const lines = prompts.flatMap<unknown>((prompt, index) => engine === "claude"
      ? [seatLine("user", prompt, index * 2), seatLine("assistant", `Answer ${index}`, index * 2 + 1)]
      : [{ type: "response_item", timestamp: seatLine("user", "", index * 2).timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
        { type: "response_item", timestamp: seatLine("assistant", "", index * 2 + 1).timestamp, payload: { type: "agentMessage", phase: index % 2 ? "final_answer" : "commentary", text: `Answer ${index}` } }]);
    const f = await seatVoiceFixture(lines, engine);
    try {
      const result = await f.tool("orchestrator_messages", { limit: 12 });
      expect(result.rows.map((row: { text: string; after: string }) => [row.text, row.after])).toEqual([
        ["Answer 5", "other"], ["Answer 4", "agent"], ["Answer 3", "relay"], ["Answer 2", "form"], ["Answer 1", "voice"], ["Answer 0", "wake"]]);
      expect(new Set(result.rows.map((row: { handle: string }) => row.handle)).size).toBe(6);
    } finally { await f.service.close(f.s.sessionId); }
  }
});

test("an early line break followed by one long Unicode line still takes only two reads", async () => {
  const text = "Короткий вступ.\n" + "ї🎙".repeat(3300);
  const f = await seatVoiceFixture([seatLine("assistant", text, 0)]);
  try {
    const first = await f.tool("orchestrator_messages");
    const rest = first.rows[0].rest;
    const second = await f.tool("orchestrator_messages", { message: rest.message, offset: rest.offset });
    expect(second.item.next).toBeNull();
    expect(first.rows[0].text + second.item.text).toBe(text);
    expect(f.provider.requests).toHaveLength(4);
  } finally { await f.service.close(f.s.sessionId); }
});

test("a long second reply reserves enough of the page to finish in its next voice read", async () => {
  const target = "ї".repeat(10000), newest = "n".repeat(8000);
  const f = await seatVoiceFixture([seatLine("assistant", target, 0), seatLine("assistant", newest, 1)]);
  try {
    const first = await f.tool("orchestrator_messages");
    expect(first.rows).toHaveLength(2);
    const row = first.rows[1];
    const second = await f.tool("orchestrator_messages", { message: row.rest.message, offset: row.rest.offset });
    expect(second.item.next).toBeNull();
    expect(row.text + second.item.text).toBe(target);
    const newerRest = first.rows[0].rest;
    const newer = await f.tool("orchestrator_messages", { message: newerRest.message, offset: newerRest.offset });
    expect(newer.item.next).toBeNull();
    expect(first.rows[0].text + newer.item.text).toBe(newest);
    for (const answer of [first, second, newer]) {
      expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(16000);
      expect(Buffer.byteLength(answer.item?.text ?? answer.rows.map((row: { text: string }) => row.text).join(""))).toBeLessThanOrEqual(12000);
    }
  } finally { await f.service.close(f.s.sessionId); }
});

test.each([80, 160])("voice action pages advance through %i read-only calls without skipping or duplicating mutations", async (noise) => {
  const calls = Array.from({ length: noise + 2 }, (_, index) => {
    const mutation = index === 0 || index === 161;
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id: `noise-${index}`, name: `mcp__viewer__${mutation ? "create_pipeline" : "list_tasks"}`, input: mutation ? { task: `Lane ${index}` } : {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `noise-${index}`, content: '{"ok":true}' }] } },
    ];
  }).flat();
  const f = await seatVoiceFixture(calls);
  try {
    const actions: unknown[] = [];
    let before: string | null = null;
    let empty = false;
    for (let count = 0; count < 5; count++) {
      const page = await f.tool("orchestrator_actions", { before, limit: 1 });
      actions.push(...page.rows);
      expect(page.scanned.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(6000);
      if (!page.more) break;
      empty ||= page.rows.length === 0;
      expect(page.before).not.toBeNull();
      expect(page.before).not.toBe(before);
      before = page.before;
    }
    expect(empty).toBe(true);
    expect(actions).toEqual((noise === 160 ? [161, 0] : [0]).map(index => ({ time: null, action: `Started lane «Lane ${index}»`, outcome: "done" })));
  } finally { await f.service.close(f.s.sessionId); }
});

test.each([true, false])("Claude actions keep their completed outcome across scan pages (ok=%j)", async (ok) => {
  const pair = (id: string, tool: string, input: Record<string, unknown>, value: unknown) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__viewer__${tool}`, input }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(value) }] } },
  ];
  const f = await seatVoiceFixture([
    ...pair("older", "create_task", { text: "Earlier task" }, { ok: true }),
    ...pair("boundary", "create_pipeline", { task: "Boundary lane" }, { ok }),
    ...Array.from({ length: 59 }, (_, index) => pair(`read-${index}`, "list_tasks", {}, { ok: true })).flat(),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "pending-read", name: "mcp__viewer__list_tasks", input: {} }] } },
  ]);
  const read = fs.readSync;
  let bytes = 0;
  const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
    const count = read(...args); bytes += count; return count;
  }) as typeof read);
  try {
    const first = await f.tool("orchestrator_actions");
    expect(first).toMatchObject({ rows: [], more: true });
    expect(first.before).toBeString();
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    bytes = 0;
    const next = await f.tool("orchestrator_actions", { before: first.before, limit: 1 });
    expect(next.rows).toEqual([{ time: null, action: "Started lane «Boundary lane»", outcome: ok ? "done" : "failed" }]);
    expect(next.before).not.toBe(first.before);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    bytes = 0;
    const last = await f.tool("orchestrator_actions", { before: next.before, limit: 1 });
    expect(last).toMatchObject({ rows: [{ action: "Created task «Earlier task»", outcome: "done" }], more: false });
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(new Set([...next.rows, ...last.rows].map((row: { action: string }) => row.action)).size).toBe(2);
  } finally { reads.mockRestore(); await f.service.close(f.s.sessionId); }
});

test("showing the newest reply keeps its whole turn on one card, speaks every line and supports silent show and reread", async () => {
  const reply = Array.from({ length: 35 }, (_, index) => `**Fact ${index + 1}:** the release check passed on every platform with recorded results.`).join("\n");
  const f = await seatVoiceFixture([seatLine("user", "[Voice Delegatus reply: whole answer]", 0), seatLine("assistant", "Opening note", 1),
    seatLine("assistant", reply, 2), seatLine("assistant", "Closing note", 3), seatLine("user", "Seat tick — new work has not answered yet", 4)]);
  try {
    const result = await f.tool("show_orchestrator_message", { message: null, read_aloud: true });
    expect(result.status).toBe("reading");
    const events = f.admission.events(f.s.sessionId, 0).filter(row => row.type === "orchestrator.report");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "message", text: `Opening note\n\n${reply}\n\nClosing note` });
    const entries = f.service.transcriptRecord(f.s.sessionId).entries.filter(row => row.kind === "report");
    expect(entries).toHaveLength(1);
    expect(entries[0].data.text).toBe(`Opening note\n\n${reply}\n\nClosing note`);
    const speech = f.provider.commands.filter(row => row.type === "session.commentary.append").map(row => String(row.content));
    for (const part of speech) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(500);
    const joined = speech.join("\n");
    expect(joined).not.toContain("**");
    let previous = -1;
    for (const line of ["Opening note", ...reply.split("\n").map(line => line.replaceAll("**", "")), "Closing note"]) {
      const at = joined.indexOf(line); expect(at).toBeGreaterThan(previous); previous = at;
    }
    const count = f.provider.commands.length;
    expect(await f.tool("show_orchestrator_message", { message: null, read_aloud: false })).toMatchObject({ status: "shown" });
    expect(f.admission.events(f.s.sessionId, 0).filter(row => row.type === "orchestrator.report")).toHaveLength(1);
    expect(f.provider.commands.slice(count).filter(row => row.type === "session.commentary.append" && !row.delegation_id)).toHaveLength(0);
    expect(await f.tool("reread_orchestrator_report", { report: null })).toMatchObject({ status: "reading" });
    expect(f.provider.commands.slice(count).filter(row => row.type === "session.commentary.append" && !row.delegation_id).map(row => row.content).join("\n")).toContain("Fact 35:");
  } finally { await f.service.close(f.s.sessionId); }
});

test("the panel tool record keeps a 15000 character read whole", async () => {
  const f = fixture();
  const service = new CompanionLiveSessions(f.storage, f.admission, f.reads, f.provider, { key: () => "synthetic-credential", timers: false });
  const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const original = { speech: "One message", rows: [{ text: "a".repeat(15000) }], truncated: false };
  const read = spyOn(f.reads, "read").mockResolvedValue(original);
  try {
    f.provider.responder = calling(functionCall("whole-panel", "orchestrator_messages", {}));
    f.provider.replay(s.providerId, delegationCreated("whole-panel", 100)); await service.drain(s.sessionId);
    const entry = service.transcriptRecord(s.sessionId).entries.find(row => row.kind === "tool")!;
    expect(JSON.parse(String(entry.data.result))).toEqual(original);
  } finally { read.mockRestore(); await service.close(s.sessionId); }
});

test("voice actions pair real Claude results and Codex MCP items, exclude reads and shell, and page by stable call position", async () => {
  const call = (id: string, tool: string, input: Record<string, unknown>, second: number) => ({ ...seatLine("assistant", "", second),
    message: { content: [{ type: "tool_use", id, name: tool, input }] } });
  const result = (id: string, value: unknown, second: number) => ({ ...seatLine("user", "", second),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(value) }] } });
  const f = await seatVoiceFixture([
    call("start", "mcp__viewer__create_pipeline", { task: "Ship the parser" }, 0), result("start", { ok: true }, 1),
    call("merge", "mcp__delegatus__pipeline_action", { pipelineId: "lane-fixture", action: "retry-merge" }, 2), result("merge", { ok: true }, 3),
    call("task", "mcp__viewer__update_task", { taskId: "task-fixture", status: "done" }, 4), result("task", { ok: false, code: "REFUSED" }, 5),
    call("deploy", "mcp__viewer__deploy_exact_sha", { sha: "0123456789abcdef" }, 6), result("deploy", { ok: true }, 7),
    call("read", "mcp__viewer__list_tasks", {}, 8), result("read", { ok: true }, 9),
    call("bash", "Bash", { command: "status" }, 10), result("bash", {}, 11),
    call("settings", "mcp__viewer__account_project_binding", { action: "list" }, 12), result("settings", {}, 13),
    call("pending", "mcp__viewer__bridge_report", { summary: "Checks finished" }, 14),
  ]);
  try {
    const actions = await f.tool("orchestrator_actions");
    expect(actions.rows.map((row: { outcome: string }) => row.outcome)).toEqual(["running", "done", "failed", "done", "done"]);
    expect(actions.rows[0].action).toContain("Checks finished");
    expect(actions.rows[3].action).toContain("merge queue");
    expect(Buffer.byteLength(JSON.stringify(actions))).toBeLessThanOrEqual(6000);
    const first = await f.tool("orchestrator_actions", { limit: 2 });
    const older = await f.tool("orchestrator_actions", { before: first.before });
    expect(older.rows).toEqual(actions.rows.slice(2));
    const invalid = first.before.replace(/^m([^.]+)/u, (_whole: string, seq: string) => `m${(parseInt(seq, 36) + 1).toString(36)}`);
    expect(await f.tool("orchestrator_actions", { before: invalid })).toMatchObject({ status: "not_found" });
    const since = await f.tool("orchestrator_actions", { since: "2026-10-12T06:37:06Z" });
    expect(since.rows).toHaveLength(2);
  } finally { await f.service.close(f.s.sessionId); }
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const codex = await seatVoiceFixture(["completed", "failed"].map((status, index) => ({ type: "response_item", timestamp: seatLine("assistant", "", index).timestamp,
    payload: { type: "McpToolCall", id: `codex-${index}`, server: "viewer", tool: "create_pipeline", arguments: { task: `Lane ${index}` }, status, result: { content: [{ type: "text", text: JSON.stringify({ ok: status === "completed" }) }] } } })), "codex");
  try {
    const actions = await codex.tool("orchestrator_actions");
    expect(actions.rows).toMatchObject([{ action: "Started lane «Lane 1»", outcome: "failed" }, { action: "Started lane «Lane 0»", outcome: "done" }]);
  } finally { await codex.service.close(codex.s.sessionId); }
});

test("whole orchestrator reads and speech mask credentials before the byte cutoff and across newlines", async () => {
  const key = ["Zr9QvB", "voice", "private", "0123456789abcdef"].join("-");
  const text = "ї".repeat(5997) + key + " tail\n" + key.slice(0, 6) + "\n" + key.slice(6) + " safe end";
  const f = await seatVoiceFixture([seatLine("user", "Read it whole", 0), seatLine("assistant", text, 1)], "claude", key);
  try {
    const result = await f.tool("orchestrator_messages");
    expect(result.rows[0].rest).toBeDefined();
    const next = await f.tool("orchestrator_messages", { message: result.rows[0].rest.message, offset: result.rows[0].rest.offset });
    expect(result.rows[0].text + next.item.text).toContain("[redacted] tail\n[redacted] safe end");
    await f.tool("show_orchestrator_message", { message: result.rows[0].handle, read_aloud: true });
    const { withoutSeparators } = await import("./redaction");
    for (const surface of [JSON.stringify(f.provider.requests), JSON.stringify(f.admission.events(f.s.sessionId, 0)),
      JSON.stringify(f.service.transcriptRecord(f.s.sessionId)), JSON.stringify(f.provider.commands)]) {
      expect(withoutSeparators(surface)).not.toContain(key.slice(0, 6));
      expect(withoutSeparators(surface)).not.toContain(key);
    }
  } finally { await f.service.close(f.s.sessionId); }
});

test("voice project labels select the seated project over a legacy key, handles select one namesake and no internal key reaches the model", async () => {
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { CompanionBoardReads } = await import("./boardReads");
  const a = `repo-${"1".repeat(32)}`, b = `repo-${"2".repeat(32)}`, unnamed = `repo-${"3".repeat(32)}`;
  persistProjectAliases([{ source: "old-orion", target: a, displayName: "Orion Works" }, { source: "old-beta", target: b, displayName: "Beta" }]);
  for (const project of [a, b, unnamed]) {
    beginOrchestratorSeatIntent({ project, mandate: "Own the board", clientRequestId: project, mode: "spawn", promptVersion: null });
    completeOrchestratorSeatIntent({ project, clientRequestId: project, conversationId: `conversation_${project}`, path: null });
  }
  const tasks = [a, b, "Orion Works"].map((project, index) => ({ id: `name-task-${index}`, project, text: `Task ${index}`, status: "inbox" }));
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies, taskSelectionSource: undefined, pipelineSelectionSource: undefined,
    listTaskRecords: () => tasks as import("@/lib/tasks/types").BoardTask[], listPipelineRecords: () => [] } }));
  const f = fixture(); const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => "synthetic-credential", timers: false });
  const s = await service.start({ project: a, locale: "en", sdp: "v=0" }); let turn = 0;
  const read = async (name: string, args: Record<string, unknown>) => {
    const id = `name-read-${++turn}`; f.provider.responder = calling(functionCall(id, name, args));
    f.provider.replay(s.providerId, delegationCreated(id, turn * 1000)); await service.drain(s.sessionId);
    return JSON.parse(String(f.provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output));
  };
  try {
    expect(await read("list_tasks", { project: "Orion Works" })).toMatchObject({ rows: [{ handle: "name-task-0" }] });
    await service.context(s.sessionId, b);
    expect(await read("list_tasks", { project: "Orion Works", refresh: true })).toMatchObject({ rows: [{ handle: "name-task-0" }] });
    const list = await read("list_projects", {});
    expect(list.rows.map((row: { name: string }) => row.name)).toEqual(["Beta", "Orion Works", "Unnamed project"]);
    expect(list.rows[0].inView).toBe(true);
    expect(await read("list_tasks", { project: list.rows[1].handle })).toMatchObject({ rows: [{ handle: "name-task-0" }] });
    await service.context(s.sessionId, unnamed);
    expect(await read("list_tasks", { project: "Unnamed project" })).toMatchObject({ total: 0 });
    expect(await read("list_tasks", { project: "Проєкт без назви" })).toMatchObject({ total: 0 });
    for (const surface of [JSON.stringify(list), JSON.stringify(f.provider.requests), JSON.stringify(f.provider.sessions), JSON.stringify(f.provider.commands)])
      expect(surface).not.toMatch(/\b(?:repo|dir)-[0-9a-f]{16,}\b/u);
  } finally { await service.close(s.sessionId); }
});

test("show deduplicates within a delegation before reading and refuses a full speech queue without a partial card", async () => {
  const f = fixture(); const session = f.admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  let reads = 0;
  const read = async () => { reads++; return { handle: "m1.0.123456", text: "The complete message", time: "2026-10-15T12:00:00Z" }; };
  const args = [session.id, "same-turn", "fixture", null, true, read] as const;
  const [first, second] = await Promise.all([f.admission.showMessage(...args), f.admission.showMessage(...args)]);
  expect([first.status, second.status, reads]).toEqual(["reading", "reading", 1]);
  expect(f.admission.events(session.id, 0).filter(row => row.type === "orchestrator.report")).toHaveLength(1);
  f.storage.change(document => { document.sessions[session.id].reportSpeech = Array.from({ length: 64 }, (_, index) => ({ reportId: `queued-${index}`, project: "fixture", status: "result", text: "Queued", handed: 0 })); });
  expect(await f.admission.showMessage(session.id, "busy-turn", "fixture", null, true, read)).toMatchObject({ status: "busy" });
  expect(reads).toBe(1);
  expect(f.admission.events(session.id, 0).filter(row => row.type === "orchestrator.report")).toHaveLength(1);
});

test("real voice scope refusals explain that nothing was read and PR cache follows the project in view", async () => {
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const at = "2026-10-10T12:00:00.000Z";
  const tasks = ["board-a", "board-b"].map(project => ({ id: `task-${project}`, project, text: `${project} cards`, status: "done" as const, placement: "unplaced" as const, assignments: [], createdAt: at, updatedAt: at,
    workLinks: [{ repository: "acme/widgets", number: 2800, kind: "pr" as const, addedAt: at, addedBy: "operator" as const }] }));
  replaceConversationCatalog(["board-a", "board-b", "empty-board"].map(project => ({ path: path.join(root, `${project}.jsonl`), root: "claude-projects" as const, name: "fixture", project, projectName: project === "empty-board" ? "Empty" : "Duplicate", title: "Fixture", firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const, mtime: 0, size: 0 })));
  const paths = createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    lastCompletedCatalog: completedCatalogFixture,
    taskSelectionSource: undefined, pipelineSelectionSource: undefined, listTaskRecords: () => tasks, listPipelineRecords: () => [] } });
  let dispatched = 0;
  const reads = new CompanionBoardReads({ ...paths, call: (name, args, redact) => { dispatched++; return paths.call(name, args, redact); } });
  const f = fixture();
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => "synthetic-credential", timers: false });
  const s = await service.start({ project: "board-a", locale: "en", sdp: "v=0" });
  let next = 0;
  const read = async (args: Record<string, unknown>) => {
    const id = `scope-read-${next++}`;
    f.provider.responder = calling(functionCall(id, "list_tasks", args));
    f.provider.replay(s.providerId, delegationCreated(id, next * 100));
    await service.drain(s.sessionId);
    return JSON.parse(f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").at(-1)!.output as string);
  };
  try {
    expect(await read({ project: null, query: "PR 2800", openOnly: null })).toMatchObject({ total: 1, rows: [{ handle: "task-board-a" }] });
    expect(await read({ query: "#2800" })).toMatchObject({ repeated: true, total: 1 });
    expect(dispatched).toBe(1);
    await service.context(s.sessionId, "board-b");
    expect(await read({ query: "2800" })).toMatchObject({ total: 1, rows: [{ handle: "task-board-b" }] });
    expect(dispatched).toBe(2);
    await service.context(s.sessionId, null);
    for (const [project, code] of [["Unknown", "PROJECT_REFUSED"], ["Duplicate", "PROJECT_AMBIGUOUS"]]) {
      const answer = await read({ project, query: "PR 2800" });
      expect(answer).toMatchObject({ status: "refused", code });
      expect(answer.speech).toContain("Nothing was read");
      expect(answer.speech).not.toContain("0 tasks");
      expect(answer.total).toBeUndefined();
    }
    await service.context(s.sessionId, "stale-context");
    expect(await read({ project: null })).toMatchObject({ status: "refused", code: "PROJECT_REFUSED" });
    await service.context(s.sessionId, null);
    expect(await read({ project: null })).toMatchObject({ status: "refused", code: "PROJECT_REQUIRED" });
    expect(dispatched).toBe(2);
    expect(await read({ project: "Empty" })).toMatchObject({ total: 0, speech: "0 tasks. " });
  } finally { await service.close(s.sessionId); replaceConversationCatalog([]); }
});

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
  expect(spoken(f)).toMatchObject([{ delegation_id: "delegation-a", content: "Here is what I found. The request is queued for the orchestrator." }]);
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
  expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "transport", incomplete: true }));
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
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.provider.autoClose = false;
    const cap = 1.33;
    f.storage.updateSettings({ monthlyCapUsd: cap });
    f.provider.responder = () => new Promise(() => undefined);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, ...Array.from({ length: 7 }, (_, at) => delegationCreated(`d${at}`, at * 10)));
    // Process all delegations before advancing the timeout they schedule.
    await f.service.events(s.sessionId, 0);
    expect(f.provider.commands.filter(row => row.type === "session.close")).toHaveLength(1);
    const fits = Math.floor((cap - VOICE_SESSION_RESERVE_USD) / BACKEND_RESPONSE_RESERVE_USD);
    expect(f.provider.requests).toHaveLength(fits);
    expect(f.admission.session(s.sessionId).closed).toBe(false);
    jest.advanceTimersByTime(19);
    expect(f.provider.hangups).toEqual([]);
    expect(f.admission.session(s.sessionId).closed).toBe(false);
    jest.advanceTimersByTime(1);
    await f.service.close(s.sessionId);
    await f.service.drain(s.sessionId);
    expect(f.admission.session(s.sessionId).closed).toBe(true);
    expect(f.provider.requests.length).toBeLessThanOrEqual(Math.floor((cap - VOICE_SESSION_RESERVE_USD) / BACKEND_RESPONSE_RESERVE_USD));
    expect(f.storage.settings()).toMatchObject({ incomplete: true, reservedUsd: 0 });
    expect(f.storage.settings().usageUsd).toBeLessThanOrEqual(cap);
    const responses = Object.values(f.admission.session(s.sessionId).usage!.responses);
    expect(responses).toHaveLength(fits);
    expect(responses.every(row => !row.complete && row.usd === null)).toBe(true);
    expect(f.provider.hangups).toEqual([s.providerId]);
    expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap", incomplete: true }));
  } finally { jest.useRealTimers(); }
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

test("an explicit send request with no tool or fresh receipt never hands a fabricated delivery to speech", async () => {
  const f = fixture();
  f.provider.responder = () => backendResponse("fabricated-delivery", [message("Yes, I passed it to the orchestrator.")]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("no-send", 500));
  await f.service.drain(s.sessionId);

  expect(f.sends()).toBe(0);
  expect(f.admission.callReports(s.sessionId).requests).toHaveLength(0);
  expect(f.service.transcriptRecord(s.sessionId).entries.filter(entry => entry.kind === "tool")).toHaveLength(0);
  expect(spoken(f).at(-1)?.content).toBe("Nothing was sent: this call has no delivery confirmation.");
  expect(spoken(f).at(-1)?.content).not.toContain("passed it to the orchestrator");
  await f.service.close(s.sessionId);
});

for (const utterance of ["Send it to him.", "Отправь ему проверить план.", "Did you send my earlier request to the orchestrator?", "What did you find?"]) {
  test(`a delivery claim without a send or fresh receipt is suppressed for ${utterance}`, async () => {
    const f = fixture();
    f.provider.responder = () => backendResponse("fabricated-delivery", [message("Yes, I passed it to the orchestrator.")]);
    const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(s.providerId, said(utterance, 0), delegationCreated("no-send", 500));
    await f.service.drain(s.sessionId);

    expect(f.sends()).toBe(0);
    expect(f.admission.callReports(s.sessionId).requests).toHaveLength(0);
    expect(f.service.transcriptRecord(s.sessionId).entries.filter(entry => entry.kind === "tool")).toHaveLength(0);
    expect(spoken(f).at(-1)?.content).toBe("Nothing was sent: this call has no delivery confirmation.");
    await f.service.close(s.sessionId);
  });
}

test("a repeated request speaks its fresh awaiting-report receipt without sending again", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
    ? backendResponse(`repeat-answer-${index}`, [message("The request is already queued; its report is pending.")])
    : backendResponse(`repeat-call-${index}`, [functionCall(`repeat-${index}`, "request_orchestrator_delegation", {
      instruction: "Ask the orchestrator to review the plan.", ...(index ? { pending_request: "r1" } : {}),
    })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Ask the orchestrator to review the plan.", 0), delegationCreated("first", 500));
  await f.service.drain(s.sessionId);
  expect(f.sends()).toBe(1);

  f.provider.replay(s.providerId, said("Done.", 1_000, "output"), said("Ask the orchestrator to review the plan.", 3_000), delegationCreated("repeat", 3_500));
  await f.service.drain(s.sessionId);

  const receipt = JSON.parse(String(f.provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output));
  expect(receipt).toMatchObject({ status: "awaiting_report", request: "r1" });
  expect(f.sends()).toBe(1);
  expect(spoken(f).at(-1)?.content).toContain("The request is already queued; its report is pending.");
  expect(spoken(f).at(-1)?.content).not.toContain("Nothing was sent");
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
  jest.useFakeTimers();
  try {
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
      await f.service.events(s.sessionId, 0);
      const asked = f.provider.requests.length;
      if (order === "parallel-reordered") for (const answer of waiting.reverse()) answer();
      if (order === "shutdown") {
        expect(f.provider.commands.filter(row => row.type === "session.close")).toHaveLength(1);
        jest.advanceTimersByTime(20);
        await f.service.close(s.sessionId);
        await f.service.drain(s.sessionId);
        expect(f.provider.hangups).toEqual([s.providerId]);
        expect(f.admission.events(s.sessionId, 0)).toContainEqual(expect.objectContaining({ type: "session.closed", reason: "cap", incomplete: true }));
      } else {
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
  } finally { jest.useRealTimers(); }
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
    // The operator saying it again in a completed turn of their own is a new request, also while the first waits for its report; the model alone repeating one is not.
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
    // The first request still waits for its report, so the same words are answered as waiting.
    expect((await again.delegate(s.sessionId, "call-restart", "delegation-restart", "Review the plan", { sourceTurn: thanksTurn })).state).toBe("awaiting_report");
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
    // The model judges that the operator asked again, also while the first still waits for its report: each wording sends once more.
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
      else expect(result.reason).toContain(mode === "no_seat" ? "no designated orchestrator" : "conversation is closed");
      return backendResponse(`resp_${index}`, [message(result.speech)]);
    };
    const session = await service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
    f.provider.replay(session.providerId, said("Передай только... попроси ничего не делать, я хочу сам продолжить", 0), said("Хорошо.", 700, "output"),
      said("Не, всё-таки отошли, да, отошли", 2000), said("Да.", 2700, "output"),
      said("А, ну, да, отправь ему все проблемы, которые я озвучил, скажи ему, чтобы он ничего не делал", 4000), delegationCreated("send-delegation", 4500));
    await service.drain(session.sessionId);
    for (let poll = 0; poll < 3; poll++) await service.events(session.sessionId, 0);
    expect(sent).toBe(mode === "no_seat" ? 0 : 1);
    expect(spoken(f).at(-1)?.content).toContain(mode === "sent" ? "Sent" : mode === "no_seat" ? "no designated orchestrator" : "conversation is closed");
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
  const taskFile = taskStoreFixture("refresh-tasks.json");
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
  const { prototypeTask, storePrototypePictures } = await import("./prototypeRead.fixture");
  const task = prototypeTask("task_fixture"); await storePrototypePictures(task);
  const f = fixture("synthetic-credential", task);
  f.provider.responder = calling(functionCall("frame-call","view_prototype_frame",{taskId:task.id,variants:[1],view:"Board",width:1440,lang:"uk"}));
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  f.provider.replay(s.providerId,delegationCreated("frame-request",1));
  await f.service.drain(s.sessionId);
  const vision = f.provider.requests[1].input.find(item=>Array.isArray(item.content))!;
  expect((vision.content as Array<Record<string,unknown>>)[1]).toMatchObject({type:"input_image",image_url:expect.stringContaining("data:image/png;base64,"),detail:"high"});
  const output = f.provider.requests[1].input.find(item=>item.type === "function_call_output")!.output as string;
  expect(output).toContain("Board"); expect(output).not.toContain("base64");
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
  const taskFile = taskStoreFixture("credential-reads.json");
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
    expect(output.item).toMatchObject({ variants: [{ number: 1, name: "Safe variant", description: f.description }],
      questions: f.round.questions.map(q => ({ id: q.id, text: q.text, options: q.options.map(o => o.label), recommended: q.options.findIndex(o => o.recommended) })),
      decision: { chosen: [{ number: 1, name: "Safe variant" }], comment: "Keep this safe decision. [redacted] Keep the final sentence." } });
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

test("refused provider arguments scrub parameter names as well as values before replay and storage", async () => {
  const f = await credentialReadFixture();
  const parameter = f.key.slice(0,6)+"\n"+f.key.slice(6);
  f.provider.responder = (request,index) => {
    const call = request.input.find(item=>item.type === "function_call");
    return backendResponse(`resp_parameter_${index}`,call ? [message(call.arguments as string)]
      : [functionCall("untrusted-parameter","list_tasks",{openOnly:true,[parameter]:parameter})]);
  };
  const s = await f.service.start({project:"fixture",locale:"en",sdp:"v=0"});
  try {
    f.provider.replay(s.providerId,delegationCreated("parameter-mask",1)); await f.service.drain(s.sessionId);
    const call = f.provider.requests[1].input.find(item=>item.type === "function_call")!;
    const output = f.provider.requests[1].input.find(item=>item.type === "function_call_output")!;
    expect(JSON.parse(call.arguments as string)).toEqual({openOnly:true,"[redacted]":"[redacted]"});
    expect(JSON.parse(output.output as string)).toMatchObject({code:"INVALID_TOOL_ARGUMENTS"});
    expect(f.sends()).toBe(0);
    await expectCredentialReadSurfacesSafe(f,s.sessionId);
  } finally { await f.service.close(s.sessionId); }
});

test("4,000-scalar tasks survive literal and Unicode-escaped JSON arguments; decoded overflow is refused", async () => {
  const prefix = "Перевір задачу. 🙂";
  const task = prefix + "ї".repeat(4_000 - [...prefix].length);
  expect([...task]).toHaveLength(4_000);
  const escaped = [...task].map(char => {
    const point = char.codePointAt(0)!;
    if (point <= 0x7f) return char;
    if (point <= 0xffff) return `\\u${point.toString(16).padStart(4, "0")}`;
    const value = point - 0x10000;
    return `\\u${(0xd800 + (value >> 10)).toString(16)}\\u${(0xdc00 + (value & 0x3ff)).toString(16)}`;
  }).join("");

  for (const [label, argumentsText] of [["literal", JSON.stringify({ instruction: task })], ["escaped", `{"instruction":"${escaped}"}`]] as const) {
    const f = fixture();
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
      ? backendResponse(`resp_${label}_${index}`, [message("The request was sent.")])
      : backendResponse(`resp_${label}_${index}`, [{ ...functionCall(`call_${label}`, "request_orchestrator_delegation"), arguments: argumentsText }]);
    const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
    try {
      f.provider.replay(session.providerId, delegationCreated(`delegation_${label}`, 1));
      await f.service.drain(session.sessionId);
      expect(f.sends()).toBe(1);
      const [proposal] = Object.values(f.admission.session(session.sessionId).proposals);
      expect(proposal.proposal.instruction).toBe(task);
    } finally { await f.service.close(session.sessionId); }
  }

  const f = fixture();
  const overflow = task + "ї";
  f.provider.responder = calling(functionCall("decoded-overflow", "request_orchestrator_delegation", { instruction: overflow }));
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  try {
    f.provider.replay(session.providerId, delegationCreated("decoded-overflow", 2));
    await f.service.drain(session.sessionId);
    expect(f.sends()).toBe(0);
    const result = JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string);
    expect(result).toMatchObject({ status: "too_long" });
    expect(result.speech).toContain("Nothing was sent");
  } finally { await f.service.close(session.sessionId); }
});

test("tool argument payloads beyond the independent wire bound produce an explicit refusal", async () => {
  const f = fixture();
  f.provider.responder = (_request, index) => backendResponse(`oversized_${index}`, [{
    ...functionCall("oversized", "request_orchestrator_delegation"), arguments: `{"instruction":"${"ї".repeat(64_001)}"}`,
  }]);
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  try {
    f.provider.replay(session.providerId, delegationCreated("oversized-wire", 3));
    await f.service.drain(session.sessionId);
    expect(f.sends()).toBe(0);
    expect(spoken(f).map(row => row.content).join(" ")).toContain("Запит не надіслано");
  } finally { await f.service.close(session.sessionId); }
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
  const { saveTasks, loadTasks, taskSelectionSource } = await import("@/lib/tasks/store");
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  for (const project of ["project-0", "project-1"]) {
    beginOrchestratorSeatIntent({ project, mandate: "Own the board", clientRequestId: project, mode: "spawn", promptVersion: null });
    completeOrchestratorSeatIntent({ project, clientRequestId: project, conversationId: `conversation_${project}`, path: null });
  }
  const at = "2026-10-10T12:00:00.000Z";
  const taskFile = taskStoreFixture("context-store", "tasks.json");
  replaceConversationCatalog(["Alpha","Beta"].map((projectName,index)=>({path:path.join(root,`${index}.jsonl`),root:"claude-projects" as const,name:"fixture",project:`project-${index}`,projectName,title:"Fixture",firstPrompt:"",engine:"claude" as const,kind:"session",fmt:"claude" as const,mtime:0,size:0})));
  saveTasks([0,1].map(index=>({id:`task-${index}`,project:`project-${index}`,text:`Project ${index} task`,status:"inbox" as const,placement:"unplaced" as const,assignments:[],createdAt:at,updatedAt:at})), taskFile);
  const storage = new CompanionStorage(); storage.updateSettings({enabled:true});
  const sent:string[]=[];
  const admission = new CompanionAdmission(storage,{recipient:project=>({project,conversationId:`conversation_${project}`,seatEpoch:1,engine:"claude"}),send:async binding=>{sent.push(binding.delivery.recipient.project);return {status:"delivered",operationId:"operation-a"};},reports:()=>[]});
  const provider = new FakeLiveProvider();
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    lastCompletedCatalog: completedCatalogFixture,
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

test("the backend turn sees the operator's latest turn and what waits for a report; rewordings it names send nothing, a new question goes through", async () => {
  for (const locale of ["uk", "en"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    const first = locale === "uk" ? "Спитай оркестратора, що з ревʼю голосу." : "Ask the orchestrator how the voice review is going.";
    const again = locale === "uk" ? ["Ну то що з ревʼю?", "А ревʼю як?", "Перевір ревʼю голосу.", "Ревʼю вже готове?"]
      : ["So what about the review?", "And the review?", "Check the voice review.", "Is the review done yet?"];
    const fresh = locale === "uk" ? "Спитай, яку модель обрати для голосу." : "Ask which model the voice should use.";
    let next: Record<string, unknown> = { instruction: first, pending_request: null };
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Done.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", next)]);
    const s = await f.service.start({ project: "fixture", locale, sdp: "v=0" });
    f.provider.replay(s.providerId, said(first, 0), delegationCreated("first", 600));
    await f.service.drain(s.sessionId);
    expect(f.sends()).toBe(1);
    let at = 1_000;
    for (const words of again) {
      next = { instruction: words, pending_request: "r1" };
      f.provider.replay(s.providerId, said("Done.", at, "output"), said(words, at + 2_000), delegationCreated(`again-${at}`, at + 2_600));
      await f.service.drain(s.sessionId);
      const context = String(f.provider.requests.findLast(request => !request.input.some(item => item.type === "function_call_output"))!.input[0].content);
      expect(context).toContain(`- r1, project "fixture", sent 0 min ago, 0 progress report(s): ${JSON.stringify(first)}`);
      expect(context).toContain(`The operator's latest turn, which this delegation answers: ${JSON.stringify(words)}`);
      expect(JSON.parse(String(f.provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output))).toMatchObject({ status: "awaiting_report", request: "r1" });
      at += 5_000;
    }
    expect([locale, f.sends()]).toEqual([locale, 1]);
    next = { instruction: fresh, pending_request: null };
    f.provider.replay(s.providerId, said("Done.", at, "output"), said(fresh, at + 2_000), delegationCreated("fresh", at + 2_600));
    await f.service.drain(s.sessionId);
    expect([locale, f.sends()]).toEqual([locale, 2]);
    await f.service.close(s.sessionId);
  }
});

test("a report reaches the voice whole: every item in order over appends within 500 bytes, none of it left out", async () => {
  const f = fixture();
  const s = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  const items = Array.from({ length: 8 }, (_, index) => `пункт ${index + 1}: ${index % 2 ? "ревʼю пройшло обидва раунди" : "деплой чекає на рішення оператора"}, ${"деталі перевірки ".repeat(index === 3 ? 20 : 3).trim()}`);
  f.reports.push({ id: "whole-1", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "short display copy",
    complete: { summary: "Два факти, кожен зі своїм субʼєктом.", sections: [{ heading: "В роботі", items }] },
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  await f.service.events(s.sessionId, 0);
  await f.service.events(s.sessionId, 0);
  const parts = spoken(f).map(row => String(row.content));
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(500);
  expect(parts[0]).toContain('project "fixture"');
  expect(parts.join("\n")).not.toContain("left out");
  const body = parts.map(part => part.split("\n").slice(1).join("\n")).join("\n").replace(/\s+/gu, "");
  expect(body).toBe(["Два факти, кожен зі своїм субʼєктом.", "В роботі:", ...items.map(item => `- ${item}`)].join("").replace(/\s+/gu, ""));
  const record = f.service.transcriptRecord(s.sessionId).entries;
  expect(record.filter(entry => entry.kind === "handoff").map(entry => entry.data.text)).toEqual(parts);
  expect(record.find(entry => entry.kind === "report")!.data.text).toContain(items[3]);
  await f.service.close(s.sessionId);
});

test("after four tool rounds the backend answers once more with tools off, so what it read is spoken rather than lost", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => request.tool_choice === "none" ? backendResponse(`resp_${index}`, [message("One open task: review the plan. Its stage is unknown.")])
    : backendResponse(`resp_${index}`, [functionCall(`read-${index}`, "list_tasks", { openOnly: true, query: `round ${index}` })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("What is open on the board?", 0), delegationCreated("reads", 600));
  await f.service.drain(s.sessionId);
  expect(f.provider.requests.map(request => request.tool_choice)).toEqual(["auto", "auto", "auto", "auto", "none"]);
  expect(f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output")).toHaveLength(4);
  expect(spoken(f)).toMatchObject([{ delegation_id: "reads", content: "One open task: review the plan. Its stage is unknown." }]);
  await f.service.close(s.sessionId);
});

test("a failed prototype read tells the backend exactly that nothing was read", async () => {
  const f = fixture();
  f.provider.responder = calling(functionCall("failed-review", "read_prototype_review", { taskId: "foreign-task" }));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, delegationCreated("failed-review", 1));
    await f.service.drain(s.sessionId);
    const result = JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string);
    expect(result).toMatchObject({ status: "refused", code: "PROJECT_REFUSED", speech: "The read failed: project refused. Nothing was read by this call. Say that you could not read it and what you tried." });
    expect(f.provider.requests[1].input.some(item => Array.isArray(item.content))).toBe(false);
  } finally { await f.service.close(s.sessionId); }
});

test("an empty final answer names the searches tried and admits that no frame was viewed", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => backendResponse(`spent-${index}`, request.tool_choice === "none" ? []
    : [functionCall(`search-${index}`, "list_tasks", { query: `unknown ${index}` })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, delegationCreated("spent-review", 1));
    await f.service.drain(s.sessionId);
    const speech = String(spoken(f).at(-1)!.content);
    expect(speech).toContain("I could not finish within the allowed steps. I tried:");
    expect(speech).toContain("searched the tasks for «unknown 0»: 0 tasks");
    expect(speech).toContain("No prototype frame was viewed. Nothing more was done.");
    expect(Buffer.byteLength(speech)).toBeLessThanOrEqual(480);
    expect(speech).not.toContain("task_fixture");
  } finally { await f.service.close(s.sessionId); }
});

test("a report due during dictation waits for the request's tool and answer before its commentary", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.responder = async (request, index) => {
    if (index === 0) { started(); await held; }
    return calling(functionCall("dictated-read", "list_tasks"))(request, index);
  };
  try {
    f.provider.replay(s.providerId, said("What is open", 100));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "during-dictation", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ reportId: "during-dictation", handed: 0 }]);
    f.provider.replay(s.providerId, said(" on the board?", 500), delegationCreated("dictated-request", 1000));
    await ready;
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    release();
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "dictated-request" }, { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
    const entries = f.service.transcriptRecord(s.sessionId).entries;
    expect(entries.findIndex(entry => entry.kind === "tool" && entry.data.callId === "dictated-read"))
      .toBeLessThan(entries.findIndex(entry => entry.kind === "handoff" && String(entry.data.text).includes("HELD_REPORT")));
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(2);
  } finally { release(); await f.service.drain(s.sessionId); await f.service.close(s.sessionId); }
});

test("barge-in during a backend await keeps reports held when the older request finishes", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.responder = async (_request, index) => {
    if (index === 0) { started(); await held; }
    return backendResponse(`answer-${index}`, [message(index === 0 ? "Earlier answer." : "Newer answer.")]);
  };
  try {
    f.provider.replay(s.providerId, said("Read the board", 100), delegationCreated("earlier", 600));
    await ready;
    f.reports.push({ id: "while-waiting", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    // The sideband receives newer input while the old backend is awaiting I/O.
    f.provider.replay(s.providerId, said("Actually, read the pipelines", 2000));
    await f.service.events(s.sessionId, 0);
    await f.service.command(s.sessionId, { type: "interrupt", responseId: "earlier" });
    expect(f.provider.commands.at(-1)).toMatchObject({ type: "session.instructions.append", content: expect.stringContaining("Yield to the operator") });
    release();
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }]);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ handed: 0 }]);
    // The voice speaking the earlier answer is not an answer to the newer input.
    f.provider.replay(s.providerId, said("Earlier answer.", 3000, "output"));
    await f.service.drain(s.sessionId);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }]);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ handed: 0 }]);
    f.provider.replay(s.providerId, delegationCreated("newer", 3600));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }, { delegation_id: "newer" }, { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
    expect(spoken(f)).toHaveLength(3);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(3);
  } finally { release(); await f.service.drain(s.sessionId); await f.service.close(s.sessionId); }
});

test("every display segment of an older answer, spoken after newer input, keeps reports held", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.responder = async (_request, index) => {
    if (index === 0) { started(); await held; }
    return backendResponse(`answer-${index}`, [message(index === 0 ? "Earlier answer." : "Newer answer.")]);
  };
  try {
    f.provider.replay(s.providerId, said("Read the board", 100), delegationCreated("earlier", 600));
    await ready;
    f.reports.push({ id: "while-waiting", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    f.provider.replay(s.providerId, said("Actually, read the pipelines", 2000));
    await f.service.events(s.sessionId, 0);
    release();
    await f.service.drain(s.sessionId);
    // The transcript starts a new display item after a pause of 1,500 ms: both are the earlier answer's speech.
    f.provider.replay(s.providerId, said("Earlier answer.", 3000, "output"), said("It continues.", 5000, "output"));
    await f.service.drain(s.sessionId);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }]);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ handed: 0 }]);
    f.provider.replay(s.providerId, delegationCreated("newer", 6000));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }, { delegation_id: "newer" }, { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(3);
  } finally { release(); await f.service.drain(s.sessionId); await f.service.close(s.sessionId); }
});

test("an older answer already speaking when newer input interrupts it keeps reports held as it continues", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.responder = (_request, index) => backendResponse(`answer-${index}`, [message(index === 0 ? "Earlier answer." : "Newer answer.")]);
  try {
    f.provider.replay(s.providerId, said("Read the board", 100), delegationCreated("earlier", 600));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }]);
    f.provider.replay(s.providerId, said("Earlier answer", 1000, "output"));
    f.provider.replay(s.providerId, said("Actually, read the pipelines", 2000));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "while-speaking", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.command(s.sessionId, { type: "interrupt", responseId: "earlier" });
    f.provider.replay(s.providerId, said(" goes on.", 2500, "output"));
    await f.service.drain(s.sessionId);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }]);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ handed: 0 }]);
    f.provider.replay(s.providerId, delegationCreated("newer", 3000));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "earlier" }, { delegation_id: "newer" }, { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(3);
  } finally { await f.service.close(s.sessionId); }
});

test("barge-in between report parts preserves speechHanded and resumes in order after the request", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const attach = f.provider.attach.bind(f.provider);
  let interrupt = true;
  f.provider.attach = async (...args: Parameters<typeof attach>) => {
    const connection = await attach(...args);
    return { ...connection, send: command => {
      connection.send(command);
      if (command.type === "session.commentary.append" && command.delegation_id === null && interrupt) {
        interrupt = false;
        f.provider.replay(args[0], said("What is open?", 1000));
      }
    } };
  };
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    for (const seq of [1, 2]) f.reports.push({ id: `parts-${seq}`, seq, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed",
      body: seq === 1 ? Array.from({ length: 8 }, (_, at) => `FACT_${at}: ${"The check passed. ".repeat(8)}`).join("\n") : "LATER_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    await f.service.drain(s.sessionId);
    const first = String(spoken(f)[0]!.content);
    expect(spoken(f)).toHaveLength(1);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ reportId: "parts-1", handed: 1 }, { reportId: "parts-2", handed: 0 }]);
    f.provider.responder = calling(functionCall("barge-read", "list_tasks"));
    f.provider.replay(s.providerId, delegationCreated("barge-request", 1600));
    await f.service.drain(s.sessionId);
    const speech = spoken(f);
    expect(speech[0]!.content).toBe(first);
    expect(speech[1]!.delegation_id).toBe("barge-request");
    const parts = speech.filter(row => row.delegation_id === null).map(row => String(row.content));
    expect(new Set(parts).size).toBe(parts.length);
    const text = parts.join("\n");
    for (let at = 1; at < 8; at++) expect(text.indexOf(`FACT_${at - 1}:`)).toBeLessThan(text.indexOf(`FACT_${at}:`));
    expect(parts.at(-1)).toContain("LATER_REPORT");
    expect(f.admission.reportSpeech(s.sessionId)).toEqual([]);
  } finally { await f.service.close(s.sessionId); }
});

test("a direct voice answer releases reports, while overlapping older output and invalid deltas do not", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, said("Explain the plan", 1000));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "direct-answer", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    f.provider.replay(s.providerId, said("Earlier output", 500, "output"), { type: "session.output_transcript.delta", delta: "bad", start_ms: NaN, end_ms: 2000 },
      { type: "session.output_transcript.delta", delta: "bad", start_ms: 3000, end_ms: 2000 });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    f.provider.replay(s.providerId, said("Here is the plan", 1600, "output"));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ content: expect.stringContaining("HELD_REPORT") }]);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(1);
  } finally { await f.service.close(s.sessionId); }
});

test("a failed request answers its failure before releasing a held report", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, said("Read the board", 100));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "failed-request", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    f.provider.responder = async () => { throw new Error("PROVIDER_ERROR"); };
    f.provider.replay(s.providerId, delegationCreated("failed-request", 600));
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "failed-request", content: expect.stringContaining("could not be read") },
      { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
  } finally { await f.service.close(s.sessionId); }
});

test("late transcript repair of an answered request cannot hold later reports", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, said("Read the board", 100), delegationCreated("answered", 600));
    await f.service.drain(s.sessionId);
    f.provider.replay(s.providerId, { type: "session.input_transcript.delta", event_id: "late-repair", delta: ", please", start_ms: 300, end_ms: 500 });
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "after-repair", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "REPORT_AFTER_REPAIR",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toMatchObject([{ delegation_id: "answered" }, { content: expect.stringContaining("REPORT_AFTER_REPAIR") }]);
    f.provider.replay(s.providerId, said("Read the pipelines too", 2000));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "new-request", seq: 2, project: "fixture", at: "2026-10-11T12:01:00Z", class: "completed", body: "NEXT_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(2);
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ reportId: "new-request", handed: 0 }]);
  } finally { await f.service.close(s.sessionId); }
});

test("a late fragment of words already handed off, arriving during the request, does not keep reports held after its answer", async () => {
  const f = fixture("synthetic-credential", undefined, () => Date.parse("2026-10-11T12:05:00Z"));
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.responder = async (_request, index) => {
    if (index === 0) { started(); await held; }
    return backendResponse(`answer-${index}`, [message("Here is the board.")]);
  };
  try {
    f.provider.replay(s.providerId, said("Read the board", 100), delegationCreated("handed", 600));
    await ready;
    f.reports.push({ id: "repair-during-request", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "HELD_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    f.provider.replay(s.providerId, { type: "session.input_transcript.delta", event_id: "repair-in-flight", delta: ", please", start_ms: 300, end_ms: 500 });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    release();
    await f.service.drain(s.sessionId);
    expect(spoken(f)).toMatchObject([{ delegation_id: "handed" }, { delegation_id: null, content: expect.stringContaining("HELD_REPORT") }]);
  } finally { release(); await f.service.drain(s.sessionId); await f.service.close(s.sessionId); }
});

test("input the voice never answers holds reports for 15 seconds after its last fragment, and the next poll hands them", async () => {
  let clock = Date.parse("2026-10-11T12:05:00Z");
  const f = fixture("synthetic-credential", undefined, () => clock);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    f.provider.replay(s.providerId, said("Hmm", 100));
    await f.service.drain(s.sessionId);
    f.reports.push({ id: "unanswered", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "LAPSED_REPORT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    clock += 14_999;
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    // A further fragment starts the window again.
    f.provider.replay(s.providerId, said(" and the pipelines", 900));
    await f.service.drain(s.sessionId);
    clock += 14_999;
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toEqual([]);
    clock += 1;
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toMatchObject([{ delegation_id: null, content: expect.stringContaining("LAPSED_REPORT") }]);
    await f.service.events(s.sessionId, 0);
    expect(spoken(f)).toHaveLength(1);
  } finally { await f.service.close(s.sessionId); }
});

test("a process restart retires a call with held reports and a fresh call inherits no input hold", async () => {
  const directory = fs.mkdtempSync(path.join(root, "held-restart-"));
  const source = `
    import { CompanionStorage } from ${JSON.stringify(path.join(import.meta.dir, "storage.ts"))};
    import { CompanionAdmission } from ${JSON.stringify(path.join(import.meta.dir, "admission.ts"))};
    import { CompanionLiveSessions } from ${JSON.stringify(path.join(import.meta.dir, "liveSession.ts"))};
    import { fixtureBoardReads } from ${JSON.stringify(path.join(import.meta.dir, "boardReads.fixture.ts"))};
    import { FakeLiveProvider } from ${JSON.stringify(path.join(import.meta.dir, "fakeProvider.ts"))};
    const now = () => Date.parse("2026-10-11T12:05:00Z");
    const storage = new CompanionStorage(now); storage.updateSettings({ enabled: true });
    const reports = [];
    const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
      send: async () => ({ status: "failed", operationId: null }), reports: () => reports }, now);
    const provider = new FakeLiveProvider();
    const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
    const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", timers: false, now });
    const before = Object.keys(storage.read().sessions)[0];
    if (before) await service.recover();
    const s = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    if (!before) { provider.replay(s.providerId, { type: "session.input_transcript.delta", delta: "Read the board", start_ms: 100, end_ms: 500 }); await service.drain(s.sessionId); }
    reports.push({ id: before ? "fresh-report" : "held-report", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "REPORT_FACT",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await service.events(s.sessionId, 0);
    const result = { handed: provider.commands.filter(row => row.type === "session.commentary.append").length,
      owed: admission.reportSpeech(s.sessionId).map(row => row.handed), retired: before ? admission.session(before).closed : false };
    if (before) await service.close(s.sessionId);
    console.log(JSON.stringify(result));
  `;
  const run = async () => {
    const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
      LLV_STATE_DIR: path.join(directory, "state"), TMPDIR: directory, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9" }, stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      return JSON.parse(stdout);
    } finally { child.kill(); await child.exited; }
  };
  expect(await run()).toEqual({ handed: 0, owed: [0], retired: false });
  expect(await run()).toEqual({ handed: 1, owed: [], retired: true });
});

test("a report hand-off that fails part-way resumes at the failed part on the next poll: every fact once, in order, and a later report waits behind it", async () => {
  for (const locale of ["uk", "en"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    const attach = f.provider.attach.bind(f.provider);
    let appends = 0;
    // The transport refuses the second report append once, then takes every send.
    f.provider.attach = async (...args: Parameters<typeof attach>) => {
      const connection = await attach(...args);
      return { ...connection, send: command => {
        if (command.type === "session.commentary.append" && ++appends === 2) throw new Error("PROVIDER_ERROR");
        connection.send(command);
      } };
    };
    const s = await f.service.start({ project: "fixture", locale, sdp: "v=0" });
    const items = Array.from({ length: 6 }, (_, index) => `${locale === "uk" ? "пункт" : "item"} ${index + 1}: ${(locale === "uk" ? "перевірка звіту пройшла, деталі " : "the report check passed, details ").repeat(index === 2 ? 12 : 3).trim()}`);
    const manager = { kind: "manager" as const, conversationId: "conversation_fixture", role: "orchestrator" };
    f.reports.push({ id: "whole-1", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "short display copy",
      complete: { summary: "FIRST_REPORT", sections: [{ heading: "Done", items }] }, origin: manager });
    await f.service.events(s.sessionId, 0);
    const first = spoken(f).map(row => String(row.content));
    expect([locale, first.length]).toEqual([locale, 1]);
    // The failed part and everything after it are still owed; a second report is filed meanwhile.
    expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ reportId: "whole-1", handed: 1 }]);
    f.reports.push({ id: "whole-2", seq: 2, project: "fixture", at: "2026-10-11T12:01:00Z", class: "completed", body: "SECOND_REPORT", origin: manager });
    await f.service.events(s.sessionId, 0);
    await f.service.events(s.sessionId, 0);
    const parts = spoken(f).map(row => String(row.content));
    expect(parts.length).toBeGreaterThan(2);
    expect(new Set(parts).size).toBe(parts.length);
    const text = parts.join("\n");
    expect(text.indexOf("FIRST_REPORT")).toBeLessThan(text.indexOf("SECOND_REPORT"));
    const body = parts.slice(0, -1).map(part => part.split("\n").slice(1).join("\n")).join("\n").replace(/\s+/gu, "");
    expect(body).toBe(["FIRST_REPORT", "Done:", ...items.map(item => `- ${item}`)].join("").replace(/\s+/gu, ""));
    expect(parts.at(-1)).toContain("SECOND_REPORT");
    expect(f.admission.reportSpeech(s.sessionId)).toEqual([]);
    expect(f.service.transcriptRecord(s.sessionId).entries.filter(entry => entry.kind === "handoff").map(entry => entry.data.text)).toEqual(parts);
    await f.service.close(s.sessionId);
  }
});

test("a restart keeps a report owed until it is handed: the next service hands every part once, and a closed call owes nothing", async () => {
  const f = fixture();
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.reports.push({ id: "owed-1", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "OWED_FACT",
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  // The scan finds the report in the same commit that records it as owed; nothing has been handed yet.
  f.admission.pollReports(s.sessionId);
  expect(f.admission.reportSpeech(s.sessionId)).toMatchObject([{ reportId: "owed-1", handed: 0 }]);
  expect(new CompanionAdmission(f.storage, { recipient: () => null, send: async () => ({ status: "failed", operationId: null }), reports: () => [] })
    .reportSpeech(s.sessionId)).toMatchObject([{ reportId: "owed-1", handed: 0 }]);
  await f.service.events(s.sessionId, 0);
  await f.service.events(s.sessionId, 0);
  expect(spoken(f).filter(row => String(row.content).includes("OWED_FACT"))).toHaveLength(1);
  f.reports.push({ id: "owed-2", seq: 2, project: "fixture", at: "2026-10-11T12:01:00Z", class: "completed", body: "UNSAID_FACT",
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  f.admission.pollReports(s.sessionId);
  await f.service.close(s.sessionId);
  expect(f.admission.reportSpeech(s.sessionId)).toEqual([]);
  expect(f.service.transcriptRecord(s.sessionId).entries.find(entry => entry.kind === "report" && String(entry.data.text).includes("UNSAID_FACT"))).toBeDefined();
});

/* A report over one append, asked for again: the words are written for this test. */
const REREAD = {
  en: { ask: "Read the whole last report again", fact: (n: number) => `fact ${n}: the check passed on every platform`, intro: "Here is the last report again." },
  uk: { ask: "Прочитай ще раз увесь останній звіт", fact: (n: number) => `факт ${n}: перевірку пройдено`, intro: "Ось останній звіт ще раз." },
};
for (const [locale, words] of Object.entries(REREAD) as Array<["en" | "uk", typeof REREAD.en]>) test(`${locale}: a report asked for again is read whole from its own text, every fact in order to its last, with nothing sent`, async () => {
  const f = fixture();
  let reread: Record<string, unknown> = { report: null };
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message(words.intro)])
    : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "reread_orchestrator_report", reread)]);
  const s = await f.service.start({ project: "fixture", locale, sdp: "v=0" });
  const lines = [...Array.from({ length: 14 }, (_, index) => `- ${words.fact(index + 1)}`), "- TAIL_FACT"];
  f.reports.push({ id: "long-1", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: lines.join("\n"),
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  await f.service.events(s.sessionId, 0);
  const first = spoken(f).length;
  expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(500);
  f.provider.replay(s.providerId, said(words.ask, 1_000), delegationCreated("reread", 1_600));
  await f.service.drain(s.sessionId);
  const again = spoken(f).slice(first);
  // The backend's own short introduction first, tied to its delegation, then the report from its text.
  expect(again[0]).toMatchObject({ delegation_id: "reread", content: words.intro });
  const parts = again.slice(1).map(row => String(row.content));
  expect(parts.length).toBeGreaterThan(1);
  expect(again.slice(1).every(row => row.delegation_id === null)).toBe(true);
  for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(500);
  expect(parts[0]).toContain("read again as the operator asked");
  expect(parts.join("\n")).not.toContain("left out");
  expect(parts.map(part => part.split("\n").slice(1).join("\n")).join("\n").split("\n")).toEqual(lines);
  // The same delegation answered once; a handle the call does not hold reads nothing.
  reread = { report: "k9" };
  f.provider.replay(s.providerId, said(words.ask, 3_000), delegationCreated("missing", 3_600));
  await f.service.drain(s.sessionId);
  expect(JSON.parse(String(f.provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output))).toMatchObject({ status: "not_found" });
  expect(spoken(f).slice(first + again.length).map(row => row.content)).toEqual([words.intro]);
  expect(f.sends()).toBe(0);
  await f.service.close(s.sessionId);
});

test("an answered question asked again is answered from its report read whole, and nothing is sent", async () => {
  const f = fixture();
  let keys = 0;
  f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Short intro.")])
    : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", keys++ ? { instruction: "And the review?", pending_request: "r1" } : { instruction: "Check the review" })]);
  const s = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(s.providerId, said("Ask the orchestrator to check the review.", 0), delegationCreated("first", 600));
  await f.service.drain(s.sessionId);
  const key = Object.values(f.admission.session(s.sessionId).proposals)[0]!.delivery!.clientMessageId;
  const lines = [...Array.from({ length: 14 }, (_, index) => `- review fact ${index + 1}: both rounds passed`), "- TAIL_FACT"];
  f.reports.push({ id: "answer-1", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: lines.join("\n"), correlatesDirective: key,
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  await f.service.events(s.sessionId, 0);
  const before = spoken(f).length;
  f.provider.replay(s.providerId, said("And the review?", 2_000), delegationCreated("again", 2_600));
  await f.service.drain(s.sessionId);
  const again = spoken(f).slice(before);
  expect(again[0]).toMatchObject({ delegation_id: "again", content: "Short intro. The orchestrator already received this request." });
  expect(again.slice(1).map(row => String(row.content).split("\n").slice(1).join("\n")).join("\n").split("\n")).toEqual(lines);
  expect(f.sends()).toBe(1);
  await f.service.close(s.sessionId);
});

test("more reports than the speech queue holds, filed while the hand-off is blocked, all reach the voice once and in order, across a restart", async () => {
  const f = fixture();
  const attach = f.provider.attach.bind(f.provider);
  let blocked = true;
  f.provider.attach = async (...args: Parameters<typeof attach>) => {
    const connection = await attach(...args);
    return { ...connection, send: command => { if (command.type === "session.commentary.append" && blocked) throw new Error("PROVIDER_ERROR"); connection.send(command); } };
  };
  const s = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  const manager = { kind: "manager" as const, conversationId: "conversation_fixture", role: "orchestrator" };
  for (let seq = 1; seq <= 70; seq += 1) f.reports.push({ id: `queued-${seq}`, seq, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: `REPORT_${seq}_FACT`, origin: manager });
  for (let poll = 0; poll < 3; poll += 1) await f.service.events(s.sessionId, 0);
  expect(spoken(f)).toHaveLength(0);
  expect(f.admission.reportSpeech(s.sessionId)[0]).toMatchObject({ reportId: "queued-1", handed: 0 });
  expect(f.admission.reportSpeech(s.sessionId)).toHaveLength(64);
  // A restart keeps the debt and the scan position; the transport recovers.
  const restarted = new CompanionAdmission(f.storage, { recipient: () => null, send: async () => ({ status: "failed", operationId: null }), reports: () => f.reports });
  expect(restarted.reportSpeech(s.sessionId).map(row => row.reportId)).toEqual(Array.from({ length: 64 }, (_, index) => `queued-${index + 1}`));
  blocked = false;
  for (let poll = 0; poll < 3; poll += 1) await f.service.events(s.sessionId, 0);
  const voiced = spoken(f).map(row => String(row.content).match(/REPORT_(\d+)_FACT/)?.[1]);
  expect(voiced).toEqual(Array.from({ length: 70 }, (_, index) => String(index + 1)));
  expect(f.admission.reportSpeech(s.sessionId)).toEqual([]);
  await f.service.close(s.sessionId);
});

test("explicit asks to send again in handoffs with no transcript send once each after the voice answered; a replayed call adds none", async () => {
  for (const locale of ["en", "uk"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    const ask = locale === "uk" ? "Переглянь план" : "Review the plan";
    let next: Record<string, unknown> = { instruction: ask, pending_request: null, asked_again: null };
    let replayed = false;
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", next), ...(replayed ? [functionCall(`call-${index}-again`, "request_orchestrator_delegation", { ...next, instruction: `${ask}!` })] : [])]);
    const s = await f.service.start({ project: "fixture", locale, sdp: "v=0" });
    f.provider.replay(s.providerId, said(ask, 0), delegationCreated("first", 600));
    await f.service.drain(s.sessionId);
    next = { instruction: ask, pending_request: "r1", asked_again: "Asks to send it again." };
    let at = 1_000;
    // The operator's turn is the one the first send came from; the voice has answered it, so each later handoff is its own attempt.
    for (const [index, handoff] of ["again-1", "again-2"].entries()) {
      replayed = index === 1;
      f.provider.replay(s.providerId, said("Sent.", at, "output"), delegationCreated(handoff, at + 2_000));
      await f.service.drain(s.sessionId);
      expect([locale, handoff, f.sends()]).toEqual([locale, handoff, index + 2]);
      next = { ...next, pending_request: `r${index + 2}` };
      at += 5_000;
    }
    expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => row.sourceTurn)).toEqual([1, undefined, undefined]);
    await f.service.close(s.sessionId);
  }
});

test("targets that differ only in their opening capital each send once; a handle-named rephrasing and a duplicate handoff of an ask again send nothing", async () => {
  const WORDS = {
    en: { opening: "Release: what changed?", openingLower: "release: what changed?", openingReworded: "And release, what changed there?", again: "Send that once more" },
    uk: { opening: "Release: що змінилося?", openingLower: "release: що змінилося?", openingReworded: "А release, що там змінилося?", again: "Надішли це ще раз" },
  };
  for (const [locale, words] of Object.entries(WORDS) as Array<["en" | "uk", typeof WORDS.en]>) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    let next: Record<string, unknown> = { instruction: words.opening, pending_request: null, asked_again: null };
    f.provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Sent.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${index}`, "request_orchestrator_delegation", next)]);
    const s = await f.service.start({ project: "fixture", locale, sdp: "v=0" });
    const step = async (handoff: string, at: number, operator?: string) => {
      f.provider.replay(s.providerId, ...(operator ? [said(operator, at)] : []), delegationCreated(handoff, at + 600));
      await f.service.drain(s.sessionId);
    };
    await step("opening", 0, words.opening);
    f.provider.replay(s.providerId, said("Sent.", 1_000, "output"));
    next = { instruction: words.openingLower, pending_request: null, asked_again: null };
    await step("lower", 2_000, words.openingLower);
    expect([locale, f.sends()]).toEqual([locale, 2]);
    next = { instruction: words.openingReworded, pending_request: "r2", asked_again: null };
    await step("reworded", 4_000, words.openingReworded);
    expect([locale, f.sends()]).toEqual([locale, 2]);
    // An explicit ask again with no transcript, then a duplicate handoff of it before the voice answers: one attempt, one send.
    f.provider.replay(s.providerId, said("Sent.", 5_000, "output"));
    next = { instruction: words.openingLower, pending_request: "r2", asked_again: words.again };
    await step("again", 6_000);
    expect([locale, f.sends()]).toEqual([locale, 3]);
    next = { ...next, pending_request: "r3" };
    await step("again-duplicate", 6_100);
    expect([locale, f.sends()]).toEqual([locale, 3]);
    expect(Object.values(f.admission.session(s.sessionId).proposals).map(row => [row.proposal.instruction, row.sourceTurn]))
      .toEqual([[words.opening, 1], [words.openingLower, 2], [words.openingLower, undefined]]);
    await f.service.close(s.sessionId);
  }
});


test("voice start supplies the project directory and the cheap read refreshes it", async () => {
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  persistProjectAliases([{ source: "orion-old", target: "orion", displayName: "Orion Works" }]);
  const tasks = [{ id: "orion-task", project: "orion", text: "Synthetic", status: "assigned" as const }];
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies,
    taskSelectionSource: undefined, pipelineSelectionSource: undefined, listTaskRecords: () => tasks as import("@/lib/tasks/types").BoardTask[], listPipelineRecords: () => [] } }));
  const f = fixture();
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => "synthetic-credential", timers: false });
  const session = await service.start({ project: "orion", locale: "en", sdp: "v=0" });
  try {
    expect(f.provider.sessions[0].memory ?? "").not.toContain('"project":"orion"');

    f.provider.responder = calling(functionCall("directory-read", "list_projects", { all: true }));
    f.provider.replay(session.providerId, delegationCreated("directory-delegation", 100));
    await service.drain(session.sessionId);
    const output = f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").at(-1)!;
    expect(JSON.parse(output.output as string)).toMatchObject({ rows: [{ name: "Orion Works", orchestrator: false, openTasks: 1 }] });
    tasks.push({ id: "orion-next", project: "orion", text: "Next", status: "assigned" });
    await service.context(session.sessionId, null);
    f.provider.responder = calling(functionCall("directory-refresh", "list_projects", { all: true, refresh: true }));
    f.provider.replay(session.providerId, delegationCreated("directory-refresh-delegation", 200));
    await service.drain(session.sessionId);
    const refreshed = f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").at(-1)!;
    expect(JSON.parse(refreshed.output as string)).toMatchObject({ rows: [{ name: "Orion Works", openTasks: 2 }] });
  } finally { await service.close(session.sessionId); }
});


test("voice names both designated candidates on a genuine ambiguity and reads nothing", async () => {
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const { createCompanionBoardReadPaths } = await import("./readPaths");
  const { CompanionBoardReads } = await import("./boardReads");
  const f = fixture();
  for (const [project, name] of [["orion-first", "Orion Works"], ["orion-second", "ORION WORKS"]]) {
    persistProjectAliases([{ source: `${project}-old`, target: project, displayName: name }]);
    beginOrchestratorSeatIntent({ project, mandate: "Own the board", clientRequestId: project, mode: "spawn", promptVersion: null });
    completeOrchestratorSeatIntent({ project, clientRequestId: project, conversationId: `conversation_${project}`, path: null });
  }
  const { productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const paths = createCompanionBoardReadPaths({ domain: { ...productionDomainDependencies, taskSelectionSource: undefined, pipelineSelectionSource: undefined, listTaskRecords: () => [], listPipelineRecords: () => [] } }); let read = 0;
  const reads = new CompanionBoardReads({ ...paths, call: async (...args) => { read++; return paths.call(...args); } });
  const service = new CompanionLiveSessions(f.storage, f.admission, reads, f.provider, { key: () => "synthetic-credential", timers: false });
  const session = await service.start({ project: "unrelated", locale: "en", sdp: "v=0" });
  try {
    f.provider.responder = calling(functionCall("ambiguity-read", "list_tasks", { project: "orion works" }));
    f.provider.replay(session.providerId, delegationCreated("ambiguity", 100));
    await service.drain(session.sessionId);
    const result = JSON.parse(f.provider.requests.at(-1)!.input.filter(item => item.type === "function_call_output").at(-1)!.output as string);
    expect(result).toMatchObject({ status: "refused", code: "PROJECT_AMBIGUOUS", candidates: [
      { handle: expect.stringMatching(/^p[0-9a-f]{8}$/), name: "Orion Works (orchestrator 1)" }, { handle: expect.stringMatching(/^p[0-9a-f]{8}$/), name: "ORION WORKS (orchestrator 2)" },
    ] });
    expect(result.speech).toContain("Ask which project"); expect(read).toBe(0);
  } finally { await service.close(session.sessionId); }
});


test("an unreadable project directory refuses minting without a session or reservation", async () => {
  const f = fixture();
  const directory = spyOn(f.reads, "projects").mockImplementation(() => { throw new Error("PROJECT_DIRECTORY_UNAVAILABLE"); });
  try {
    await expect(f.service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("PROJECT_DIRECTORY_UNAVAILABLE");
    expect(f.provider.sessions).toHaveLength(0);
    expect(Object.values(f.storage.read().sessions)).toHaveLength(0);
  } finally { directory.mockRestore(); }
});


test("composed long tasks arrive whole and preserve pending handles, tool arguments and locale", async () => {
  const f = fixture();
  const session = await f.service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  try {
    const tasks = ["А", "Б", "В"].map(letter => letter + (letter === "В" ? "🎙" : "ї").repeat(3999));
    for (const [index, instruction] of tasks.entries()) {
      f.provider.responder = calling(functionCall(`long-call-${index}`, "request_orchestrator_delegation", { instruction }));
      f.provider.replay(session.providerId, said(`Передай задачу ${index}.`, index * 1000), delegationCreated(`long-turn-${index}`, index * 1000 + 600));
      await f.service.drain(session.sessionId);
      const held = Object.values(f.admission.session(session.sessionId).proposals);
      expect(held.map(row => row.proposal.instruction)).toEqual(tasks.slice(0, index + 1));
    }
    f.provider.responder = calling(functionCall("long-repeat", "request_orchestrator_delegation", { instruction: "Перша задача", pending_request: "r1" }));
    f.provider.replay(session.providerId, said("Як там перша задача?", 4000), delegationCreated("long-repeat-turn", 4600));
    await f.service.drain(session.sessionId);
    const request = f.provider.requests.at(-1)!;
    const context = String(request.input.find(item => item.role === "user")!.content);
    for (const handle of ["r1", "r2", "r3"]) expect(context).toContain(`- ${handle},`);
    expect(f.sends()).toBe(3);
    expect(request.max_output_tokens).toBe(2048);
    expect(request.instructions).toContain("The operator's interface language is Ukrainian.");
    const entries = f.service.transcriptRecord(session.sessionId).entries.filter(entry => entry.kind === "tool");
    for (const [index, instruction] of tasks.entries()) {
      const entry = entries.find(entry => entry.data.callId === `long-call-${index}`)!;
      expect(JSON.parse(String(entry.data.arguments))).toEqual({ instruction });
    }
    const reports = f.admission.callReports(session.sessionId);
    expect(reports.requests.map(row => row.request)).toEqual(["r1", "r2", "r3"]);
    expect(JSON.stringify(reports).length).toBeLessThan(3000);
  } finally { await f.service.close(session.sessionId); }
});

for (const mode of ["gate", "no-recipient", "project-refused", "delivery-failed", "too-long"] as const)
  test(`honest delivery: ${mode} replaces a backend's false success claim with server speech`, async () => {
    const f = fixture();
    if (mode === "no-recipient") spyOn(f.reads, "resolveProject").mockImplementation(() => { throw new Error("NO_ORCHESTRATOR"); });
    if (mode === "project-refused") spyOn(f.reads, "resolveProject").mockImplementation(() => { throw new Error("PROJECT_REFUSED"); });
    if (mode === "gate") spyOn(f.admission, "delegate").mockResolvedValue({ state: "refused", code: "not_requested" });
    if (mode === "delivery-failed") spyOn(f.admission, "delegate").mockResolvedValue({ state: "sent", status: "failed", failureCode: "RECIPIENT_REFUSED" });
    const instruction = mode === "too-long" ? "Long request ".repeat(310) : "Review the plan";
    f.provider.responder = (request, index) => backendResponse(`honest_${index}`, request.input.some(item => item.type === "function_call_output")
      ? [message("Yes, I passed it to the orchestrator.")]
      : [functionCall("honest-send", "request_orchestrator_delegation", { instruction })]);
    const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    f.provider.replay(session.providerId, delegationCreated("honest", 100));
    await f.service.drain(session.sessionId);
    expect(f.sends()).toBe(0);
    const output = JSON.parse(f.provider.requests[1].input.find(item => item.type === "function_call_output")!.output as string);
    expect(output.sent).toBe(false);
    expect(output.speech).toMatch(/^Nothing (was|has been|new was) sent/);
    expect(spoken(f).at(-1)?.content).toStartWith("Nothing was sent");
    expect(spoken(f).at(-1)?.content).not.toContain("I passed it");
    await f.service.close(session.sessionId);
  });

for (const delivery of ["queued", "delivered", "unknown"] as const) test(`honest delivery: successful ${delivery} state survives a long backend answer`, async () => {
  const f = fixture();
  spyOn(f.admission, "delegate").mockResolvedValue({ state: "sent", status: delivery });
  f.provider.responder = (request, index) => backendResponse(`sent_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("A long answer. ".repeat(60))] : [functionCall("send", "request_orchestrator_delegation", { instruction: "Review the plan" })]);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(session.providerId, delegationCreated("delivery", 100));
  await f.service.drain(session.sessionId);
  const speech = String(spoken(f).at(-1)?.content);
  expect(Buffer.byteLength(speech)).toBeLessThanOrEqual(500);
  const suffix = { queued: "The request is queued for the orchestrator.", delivered: "The orchestrator received the request.", unknown: "The request's delivery is not confirmed yet." };
  expect(speech.endsWith(suffix[delivery])).toBe(true);
  expect(f.provider.refused).toHaveLength(0);
  await f.service.close(session.sessionId);
});

test("honest delivery: pending confirmation speaks the server request instead of a false model claim", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => backendResponse(`confirm_${index}`, request.input.some(item => item.type === "function_call_output")
    ? [message("Yes, I passed it to the orchestrator.")] : [functionCall("prepare", "request_orchestrator_delegation", { instruction: "Review the plan", confirmation_reason: "Confirm the scope." })]);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(session.providerId, delegationCreated("confirmation", 100));
  await f.service.drain(session.sessionId);
  expect(spoken(f).at(-1)?.content).toBe("Nothing has been sent. I would send: Review the plan. Confirmation reason: Confirm the scope. Ask the operator whether to send it; their spoken yes or no or the card's buttons will confirm.");
  expect(f.sends()).toBe(0);
  await f.service.close(session.sessionId);
});

test("honest delivery: refused then awaiting confirmation suppresses a false delivery claim", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => {
    if (index === 0) return backendResponse("too_long", [functionCall("too-long", "request_orchestrator_delegation", { instruction: "Long request ".repeat(310) })]);
    if (index === 1) return backendResponse("awaiting", [functionCall("prepare", "request_orchestrator_delegation", {
      instruction: "Review the shortened plan", confirmation_reason: "Confirm the scope.",
    })]);
    return backendResponse("false-delivery", [message("Yes, I passed it to the orchestrator.")]);
  };
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(session.providerId, delegationCreated("refused-awaiting", 100));
  await f.service.drain(session.sessionId);
  expect(f.sends()).toBe(0);
  expect(spoken(f).at(-1)?.content).toBe("Nothing was sent: the task was too long. Ask the operator to say it more briefly. Nothing has been sent. I would send: Review the shortened plan. Confirmation reason: Confirm the scope. Ask the operator whether to send it; their spoken yes or no or the card's buttons will confirm.");
  await f.service.close(session.sessionId);
});

test("honest delivery: a refusal on the last tool round suppresses the budget answer's false success", async () => {
  const f = fixture();
  f.provider.responder = (request, index) => backendResponse(`budget_${index}`, index < 3
    ? [functionCall(`read_${index}`, "orchestrator_reports")]
    : request.tool_choice === "none" ? [message("Yes, I passed it to the orchestrator.")]
      : [functionCall("too_long", "request_orchestrator_delegation", { instruction: "Long request ".repeat(310) })]);
  const session = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  f.provider.replay(session.providerId, delegationCreated("budget", 100));
  await f.service.drain(session.sessionId);
  expect(f.provider.requests.at(-1)?.tool_choice).toBe("none");
  expect(spoken(f).at(-1)?.content).toBe("Nothing was sent: the task was too long. Ask the operator to say it more briefly.");
  expect(f.sends()).toBe(0);
  await f.service.close(session.sessionId);
});
