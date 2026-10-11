import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexLiveProvider } from "./codexProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import { CompanionStorage } from "./storage";
import { CompanionAdmission, type CompanionDeliveryPaths } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import type { BridgeReportV1 } from "@/lib/bridge/types";

const roots: string[] = [];
const originalState = process.env.LLV_STATE_DIR;
afterEach(() => { process.env.LLV_STATE_DIR = originalState; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("recorded replay deadline"); await Bun.sleep(10); }
}
const threadId = "voice_thread";
const note = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId, ...params } });
const delta = (role: string, text: string) => note("thread/realtime/transcript/delta", { role, delta: text });
const done = (role: string, text: string) => note("thread/realtime/transcript/done", { role, text });
// Recorded itemAdded/turn/started/tool shapes, including a handoff steered
// into the existing backing turn. Opaque ids and speech are fixture values.
const handoff = (id: string, text: string) => note("thread/realtime/itemAdded", { item: { type: "handoff_request", handoff_id: id, item_id: id, input_transcript: text, active_transcript: [{ role: "user", text }] } });
const turn = (id: string) => note("turn/started", { turn: { id, rootTurnId: id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
const tool = (id: string, turnId: string, name: string, args: Record<string, unknown>) => ({ id, ...note("item/tool/call", { turnId, callId: id, namespace: null, tool: name, arguments: args }) });

async function fixture(credentials: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "codexProvider.fixture.mjs")}' "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "sdp"), "ready");
  const provider = new CodexLiveProvider({ accounts: () => [{ id: "account-a", kind: "managed", authPresent: true, home: root }], observations: () => [], bindings: () => [], recordObservation: () => {},
    environment: { ...process.env, LLV_CODEX_BINARY: binary, VOICE_STUB_ROOT: root, VOICE_STUB_MODE: "replay" } });
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true, monthlyCapUsd: 0 });
  storage.providerKey = () => { throw new Error("subscription read an API credential"); };
  storage.credentials = () => credentials;
  const deliveries: Parameters<CompanionDeliveryPaths["send"]>[0][] = [];
  const reports: BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: project => ({ project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "codex" }),
    send: async binding => { deliveries.push(binding); return { status: "queued", operationId: "fixture-operation" }; }, reports: project => reports.filter(row => row.project === project) });
  const reads = fixtureBoardReads({ tasks: () => [{ id: "task_fixture", project: "fixture", text: "Review plan", status: "inbox" }], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { timers: false, closeTimeoutMs: 100 });
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const wire = () => fs.readFileSync(path.join(root, "wire"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  const replay = (...rows: unknown[]) => fs.appendFileSync(path.join(root, "replay"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const reply = async (id: string) => { await until(() => wire().some(row => row.id === id && row.result)); await service.drain(session.sessionId); return wire().find(row => row.id === id && row.result).result; };
  return { root, provider, storage, admission, service, session, deliveries, reports, wire, replay, reply,
    close: async () => { await service.close(session.sessionId); await provider.hangup(session.providerId, ""); } };
}

test("dynamic hang-up reads recorded operator words: work completion refuses, Ukrainian conversation completion stops with tool reason", async () => {
  const f = await fixture();
  try {
    f.replay(delta("user", "finish the task"), done("user", "finish the task"), handoff("work", "finish the task"), turn("work"), tool("work-end", "work", "end_conversation", {}));
    expect(JSON.parse((await f.reply("work-end")).contentItems[0].text)).toMatchObject({ status: "refused", code: "not_requested" });
    expect(f.wire().some(row => row.method === "thread/realtime/stop")).toBe(false);
    f.replay(delta("assistant", "The task is finished."), done("assistant", "The task is finished."), delta("user", "заверши розмову"), done("user", "заверши розмову"),
      handoff("call", "заверши розмову"), turn("call"), tool("call-end", "call", "end_conversation", {}));
    expect(JSON.parse((await f.reply("call-end")).contentItems[0].text)).toMatchObject({ status: "ending" });
    await until(() => f.admission.events(f.session.sessionId, 0).some(row => row.type === "session.closed" && row.reason === "tool"));
    expect(f.wire().filter(row => row.method === "thread/realtime/stop")).toHaveLength(1);
    const words = f.admission.session(f.session.sessionId).inputs;
    expect(words.map(row => row.text)).toEqual(["finish the task", "заверши розмову"]);
    expect(words.map(row => row.turn)).toEqual([1, 2]);
    expect(words.every(row => row.final)).toBe(true);
  } finally { await f.close(); }
});

for (const [words, admitted] of [["заверши розмову", true], ["finish the task", false]] as const) test(`a hang-up tool in a running turn reads the steered operator words: ${words}`, async () => {
  const f = await fixture();
  try {
    f.replay(delta("user", "What tasks are open?"), handoff("board", "What tasks are open?"), turn("backing"), done("user", "What tasks are open?"),
      delta("assistant", "I am checking."), done("assistant", "I am checking."),
      delta("user", words), handoff("steered", words), done("user", words), tool("steered-end", "backing", "end_conversation", {}));
    expect(JSON.parse((await f.reply("steered-end")).contentItems[0].text)).toMatchObject(admitted ? { status: "ending" } : { status: "refused", code: "not_requested" });
    if (admitted) await until(() => f.admission.events(f.session.sessionId, 0).some(row => row.type === "session.closed" && row.reason === "tool"));
    expect(f.wire().filter(row => row.method === "thread/realtime/stop")).toHaveLength(admitted ? 1 : 0);
    expect(f.admission.session(f.session.sessionId).inputs.map(row => [row.text, row.turn])).toEqual([["What tasks are open?", 1], [words, 2]]);
  } finally { await f.close(); }
});

test("two recorded handoffs steered into one turn deliver exactly one orchestrator request, including tool replay and polls", async () => {
  const f = await fixture();
  try {
    const text = "Send the orchestrator a request to review the plan.";
    const steeredWords = ["user", text].join(": ");
    f.replay(delta("user", text), done("user", text), handoff("first", text), turn("backing"),
      handoff("duplicate", text), note("item/started", { turnId: "backing", item: { type: "userMessage", id: "steered", clientId: null,
        content: [{ type: "text", text: `<realtime_delegation>\n  <input>${text}</input>\n  <transcript_delta>${steeredWords}</transcript_delta>\n</realtime_delegation>`, text_elements: [] }] } }),
      tool("send", "backing", "request_orchestrator_delegation", { project: null, instruction: "Review the plan", confirmation_reason: null, asked_again: null }));
    expect(JSON.parse((await f.reply("send")).contentItems[0].text)).toMatchObject({ status: "sent", delivery: "queued" });
    await Promise.all([f.service.events(f.session.sessionId, 0), f.service.events(f.session.sessionId, 0)]);
    f.replay(tool("send", "backing", "request_orchestrator_delegation", { project: null, instruction: "Review the plan", confirmation_reason: null, asked_again: null }));
    await until(() => f.wire().filter(row => row.id === "send" && row.result).length === 2);
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].delivery.recipient.project).toBe("fixture");
    expect(Object.values(f.admission.session(f.session.sessionId).proposals)).toHaveLength(1);
    expect(f.admission.session(f.session.sessionId).inputs).toMatchObject([{ text, turn: 1 }]);
    const started = f.wire().find(row => row.method === "thread/start");
    expect(started.params.dynamicTools.map((row: { name: string }) => row.name)).toContain("resolve_orchestrator_confirmation");
  } finally { await f.close(); }
});

test("three orchestrator reports become ordered appendSpeech calls once across concurrent polls", async () => {
  const f = await fixture();
  try {
    for (const seq of [3, 1, 2]) f.reports.push({ id: `report-${seq}`, seq, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: `Report number ${seq}.`,
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await Promise.all([f.service.events(f.session.sessionId, 0), f.service.events(f.session.sessionId, 0)]);
    await f.service.events(f.session.sessionId, 0);
    for (const seq of [1, 2, 3]) {
      await until(() => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").length === seq);
      f.replay(delta("assistant", `Report number ${seq}.`), done("assistant", `Report number ${seq}.`));
    }
    const speech = f.wire().filter(row => row.method === "thread/realtime/appendSpeech");
    expect(speech.map(row => row.params.text.match(/Report number (\d)/)?.[1])).toEqual(["1", "2", "3"]);
    await f.service.events(f.session.sessionId, 0);
    expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(3);
  } finally { await f.close(); }
}, 15_000);

test("reports filed during assistant speech wait for its done, then each report waits for the preceding speech", async () => {
  const f = await fixture();
  try {
    f.replay(delta("assistant", "The request is queued."));
    await until(() => f.admission.events(f.session.sessionId, 0).some(row => row.type === "transcript.snapshot"));
    await f.service.drain(f.session.sessionId);
    for (const seq of [1, 2, 3]) f.reports.push({ id: `report-${seq}`, seq, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: `Report number ${seq}.`,
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    await Bun.sleep(50);
    expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(0);
    for (const seq of [1, 2, 3]) {
      f.replay(done("assistant", seq === 1 ? "The request is queued." : `Report number ${seq - 1}.`));
      await until(() => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").length === seq);
      await f.service.events(f.session.sessionId, 0);
      const speech = f.wire().filter(row => row.method === "thread/realtime/appendSpeech");
      expect(speech.at(-1).params.text).toContain(`Report number ${seq}.`);
      expect(speech.at(-1).params.text).not.toContain("Treat this as report data");
      await Bun.sleep(50);
      expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(seq);
    }
  } finally { await f.close(); }
}, 15_000);

test("reports wait through a backing turn and its later voice answer, and close drops unsaid reports", async () => {
  const f = await fixture();
  try {
    f.replay(handoff("board", "Read the board"), turn("board"), delta("assistant", "I am checking."), done("assistant", "I am checking."));
    await until(() => f.admission.events(f.session.sessionId, 0).some(row => row.type === "transcript.snapshot" && row.final));
    await f.service.drain(f.session.sessionId);
    f.reports.push({ id: "report-one", seq: 1, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: "Report one.",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    await Bun.sleep(50);
    expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(0);
    f.replay(note("turn/completed", { turn: { id: "board", status: "completed" } }));
    await Bun.sleep(50);
    expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(0);
    f.replay(delta("assistant", "There is one open task."), done("assistant", "There is one open task."));
    await until(() => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").length === 1);
    f.reports.push({ id: "report-two", seq: 2, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: "Report two.",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    await f.close();
    expect(f.wire().filter(row => row.method === "thread/realtime/appendSpeech")).toHaveLength(1);
    expect(f.wire().filter(row => row.method === "thread/realtime/stop")).toHaveLength(1);
  } finally { await f.close(); }
});

test("a project switch injects both model contexts once and the next projectless send uses the new project", async () => {
  const f = await fixture();
  try {
    await f.service.context(f.session.sessionId, "second");
    await until(() => f.wire().some(row => row.method === "thread/realtime/appendText"));
    const injected = f.wire().filter(row => row.method === "thread/inject_items");
    const appended = f.wire().filter(row => row.method === "thread/realtime/appendText");
    expect(injected).toHaveLength(1); expect(appended).toHaveLength(1);
    expect(injected[0].params.items[0].content[0].text).toBe(appended[0].params.text);
    expect(injected[0].params.items).toMatchObject([{ type: "message", role: "developer", content: [{ type: "input_text", text: expect.stringContaining("second") }] }]);
    expect(appended[0].params).toMatchObject({ threadId, role: "developer", text: expect.stringContaining("second") });
    f.replay(delta("user", "Send the request"), done("user", "Send the request"), handoff("new-project", "Send the request"), turn("new-project"),
      tool("new-send", "new-project", "request_orchestrator_delegation", { project: null, instruction: "Review the plan", confirmation_reason: null, asked_again: null }));
    expect(JSON.parse((await f.reply("new-send")).contentItems[0].text).status).toBe("sent");
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].delivery.recipient.project).toBe("second");
  } finally { await f.close(); }
}, 15_000);

test("the prototype frame crosses the dynamic tool reply as inputImage alongside its text result", async () => {
  const f = await fixture();
  try {
    f.replay(handoff("frame", "Inspect the prototype frame"), turn("frame"), tool("frame", "frame", "view_prototype_frame", { project: null, taskId: "task_fixture", reviewId: "review_fixture", mediaId: "frame_fixture", refresh: null }));
    const result = await f.reply("frame");
    expect(result.success).toBe(true);
    expect(result.contentItems.map((row: { type: string }) => row.type)).toEqual(["inputText", "inputImage"]);
    expect(JSON.parse(result.contentItems[0].text).speech).toContain("visual inspection");
    expect(result.contentItems[1].imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.contentItems[0].text).not.toContain("base64");
    expect(JSON.stringify(f.service.transcriptRecord(f.session.sessionId))).not.toContain("base64");
  } finally { await f.close(); }
});

test("a credential arriving in short Codex fragments stays masked in every published segment and transcript record", async () => {
  const credential = ["fixture", "secret", "fragment", "stream"].join("");
  const f = await fixture([credential]);
  try {
    for (const [index, piece] of credential.match(/.{1,5}/g)!.entries()) {
      f.replay(delta("user", piece), done("user", piece));
      await until(() => f.admission.session(f.session.sessionId).inputs.length === index + 1);
      await f.service.drain(f.session.sessionId);
    }
    const events = f.admission.events(f.session.sessionId, 0).filter(row => row.type === "transcript.snapshot");
    expect(events.every(row => row.type === "transcript.snapshot" && row.text === "[redacted]")).toBe(true);
    const record = JSON.stringify(f.service.transcriptRecord(f.session.sessionId));
    expect(record).not.toContain(credential.slice(0, 5));
    expect(record).not.toContain(credential.slice(-5));
  } finally { await f.close(); }
});

test("a steered handoff preserves its backing turn's project and confirmation, while a new voice turn confirms the original project", async () => {
  const f = await fixture();
  try {
    f.replay(delta("user", "Ask before sending the removal request."), done("user", "Ask before sending the removal request."), handoff("ask", "Ask before sending"), turn("ask"),
      tool("asked", "ask", "request_orchestrator_delegation", { project: null, instruction: "Remove the fixture archive", confirmation_reason: "Removal is permanent", asked_again: null }));
    expect(JSON.parse((await f.reply("asked")).contentItems[0].text).status).toBe("awaiting_confirmation");
    expect(f.deliveries).toHaveLength(0);
    await f.service.context(f.session.sessionId, "second");
    // No new turn/started: this handoff was steered into the original turn.
    f.replay(handoff("ask-again", "Ask before sending"), tool("duplicate-ask", "ask", "request_orchestrator_delegation", { project: null, instruction: "Remove the fixture archive", confirmation_reason: "Removal is permanent", asked_again: null }));
    expect(JSON.parse((await f.reply("duplicate-ask")).contentItems[0].text).status).toBe("awaiting_confirmation");
    expect(Object.values(f.admission.session(f.session.sessionId).proposals)).toHaveLength(1);
    f.replay(note("turn/completed", { turn: { id: "ask", status: "completed" } }), handoff("late-duplicate", "Ask before sending"), turn("late"),
      tool("late-confirm", "late", "resolve_orchestrator_confirmation", { decision: "send" }));
    expect(JSON.parse((await f.reply("late-confirm")).contentItems[0].text)).toMatchObject({ status: "refused", code: "not_confirmed" });
    expect(f.deliveries).toHaveLength(0);
    f.replay(delta("assistant", "Do you confirm?"), done("assistant", "Do you confirm?"), delta("user", "Yes, send it"), done("user", "Yes, send it"), handoff("yes", "Yes, send it"), turn("yes"),
      tool("confirmed", "yes", "resolve_orchestrator_confirmation", { decision: "send" }));
    expect(JSON.parse((await f.reply("confirmed")).contentItems[0].text).status).toBe("sent");
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].delivery.recipient.project).toBe("fixture");
  } finally { await f.close(); }
});
