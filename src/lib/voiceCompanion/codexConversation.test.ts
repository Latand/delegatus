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
import { speechParts, voiceReportText } from "./reportSpeech";

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

async function fixture(credentials: string[] = [], prototype?: import("@/lib/tasks/types").BoardTask, now?: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "codexProvider.fixture.mjs")}' "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "sdp"), "ready");
  const provider = new CodexLiveProvider({ accounts: () => [{ id: "account-a", kind: "managed", authPresent: true, home: root }], observations: () => [], bindings: () => [], recordObservation: () => {},
    environment: { ...process.env, LLV_CODEX_BINARY: binary, VOICE_STUB_ROOT: root, VOICE_STUB_MODE: "replay" }, ...(now ? { now } : {}) });
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true, monthlyCapUsd: 0 });
  storage.providerKey = () => { throw new Error("subscription read an API credential"); };
  storage.credentials = () => credentials;
  const deliveries: Parameters<CompanionDeliveryPaths["send"]>[0][] = [];
  const reports: BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, { recipient: project => ({ project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "codex" }),
    send: async binding => { deliveries.push(binding); return { status: "queued", operationId: "fixture-operation" }; }, reports: project => reports.filter(row => row.project === project) });
  const reads = fixtureBoardReads({ tasks: () => [prototype ?? { id: "task_fixture", project: "fixture", text: "Review plan", status: "inbox" }], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { timers: false, closeTimeoutMs: 100, ...(now ? { now } : {}) });
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

test("a report filed while the operator dictates waits for the voice's answer, then is voiced once", async () => {
  // Provider offsets come from this clock, so each phase sits at a stated point on the call's timeline.
  let at = Date.parse("2026-10-11T00:00:00Z");
  const f = await fixture([], undefined, () => at);
  const appended = () => f.wire().filter(row => row.method === "thread/realtime/appendSpeech");
  const owed = () => f.admission.reportSpeech(f.session.sessionId);
  try {
    at += 100;
    f.replay(delta("user", "What tasks are"));
    await until(() => f.admission.session(f.session.sessionId).inputs.length > 0);
    await f.service.drain(f.session.sessionId);
    f.reports.push({ id: "during-dictation", seq: 1, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: "Held report.",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    // The receipt is written in the same turn as the hand-over, so handed 0 proves the session held it back.
    expect(owed()).toMatchObject([{ reportId: "during-dictation", handed: 0 }]);
    at += 100;
    f.replay(delta("user", " open?"), done("user", "What tasks are open?"));
    await until(() => f.admission.session(f.session.sessionId).inputs.some(row => row.final));
    await f.service.events(f.session.sessionId, 0);
    expect(owed()).toMatchObject([{ reportId: "during-dictation", handed: 0 }]);
    at += 100;
    f.replay(delta("assistant", "Nothing is open."), done("assistant", "Nothing is open."));
    await until(() => appended().length === 1);
    expect(appended()[0]!.params.text).toContain("Held report.");
    await f.service.events(f.session.sessionId, 0);
    expect(owed()).toEqual([]);
    // A context write goes through the provider's ordered writer: once it is on the wire, every earlier write is.
    await f.service.context(f.session.sessionId, "second");
    await until(() => f.wire().some(row => row.method === "thread/realtime/appendText"));
    expect(appended()).toHaveLength(1);
  } finally { await f.close(); }
}, 15_000);

test("an earlier backing turn's answer cannot release a report held for newer input; the newer turn's answer does", async () => {
  let at = Date.parse("2026-10-11T00:00:00Z");
  const f = await fixture([], undefined, () => at);
  const appended = () => f.wire().filter(row => row.method === "thread/realtime/appendSpeech");
  const owed = () => f.admission.reportSpeech(f.session.sessionId);
  const settle = async () => { await f.service.drain(f.session.sessionId); await f.service.events(f.session.sessionId, 0); };
  try {
    at += 100;
    f.replay(delta("user", "Read the board"), done("user", "Read the board"), handoff("A", "Read the board"), turn("A"));
    await until(() => f.admission.session(f.session.sessionId).inputs.some(row => row.final));
    await settle();
    at += 100;
    f.replay(delta("user", "Actually, read the pipelines"));
    await until(() => f.admission.session(f.session.sessionId).inputs.length > 1);
    f.reports.push({ id: "during-turns", seq: 1, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: "Held report.",
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await settle();
    expect(owed()).toMatchObject([{ reportId: "during-turns", handed: 0 }]);
    // The earlier turn finishes and its answer is spoken before the newer input is handed off.
    at += 100;
    f.replay(note("turn/completed", { turn: { id: "A", status: "completed" } }), delta("assistant", "Board answer."), done("assistant", "Board answer."));
    await until(() => f.admission.events(f.session.sessionId, 0).some(row => row.type === "transcript.snapshot" && row.final && JSON.stringify(row).includes("Board answer.")));
    await settle();
    expect(owed()).toMatchObject([{ reportId: "during-turns", handed: 0 }]);
    at += 100;
    f.replay(handoff("B", "Actually, read the pipelines"), turn("B"));
    await settle();
    expect(owed()).toMatchObject([{ reportId: "during-turns", handed: 0 }]);
    at += 100;
    f.replay(note("turn/completed", { turn: { id: "B", status: "completed" } }), delta("assistant", "Pipelines answer."), done("assistant", "Pipelines answer."));
    await until(() => appended().length === 1);
    expect(appended()[0]!.params.text).toContain("Held report.");
    await settle();
    expect(owed()).toEqual([]);
    await f.service.context(f.session.sessionId, "second");
    await until(() => f.wire().some(row => row.method === "thread/realtime/appendText"));
    expect(appended()).toHaveLength(1);
  } finally { await f.close(); }
}, 15_000);

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
  const { prototypeTask, storePrototypePictures } = await import("./prototypeRead.fixture");
  const task = prototypeTask("task_fixture");
  const f = await fixture([], task); await storePrototypePictures(task);
  try {
    f.replay(handoff("frame", "Inspect the prototype frames"), turn("frame"), tool("frame", "frame", "view_prototype_frame", { project: null, taskId: "task_fixture", reviewId: null, query: null, variants: [1, 2, 3], view: "Board dark", width: 1440, lang: "uk", original: false, refresh: null }));
    const result = await f.reply("frame");
    expect(result.success).toBe(true);
    expect(result.contentItems.map((row: { type: string }) => row.type)).toEqual(["inputText", "inputImage", "inputImage", "inputImage"]);
    expect(JSON.parse(result.contentItems[0].text).speech).toContain("Attached 3 picture(s)");
    for (const image of result.contentItems.slice(1)) expect(image.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.contentItems[0].text).not.toContain("base64");
    expect(JSON.stringify(f.service.transcriptRecord(f.session.sessionId))).not.toContain("base64");
  } finally { await f.close(); }
});

test("a credential arriving in short Codex fragments stays masked in every published segment and transcript record", async () => {
  const credential = ["Zr9QvB", "synthetic", "fragment", "stream"].join("");
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

/* The lean-delegation sequence on the real adapter and its native stub. The words are written for this test. */
const LEAN = {
  en: { first: "Ask the orchestrator to review the plan", again: "So what about the plan review?", resend: "Send the plan review to the orchestrator again",
    items: ["The review lane passed both rounds", "The deploy lane still waits for the operator", "The plan has two open notes"] },
  uk: { first: "Попроси оркестратора переглянути план", again: "То що там з переглядом плану?", resend: "Надішли оркестратору перегляд плану ще раз",
    items: ["Лінія ревʼю пройшла обидва раунди", "Лінія деплою досі чекає на оператора", "У плані дві відкриті примітки"] },
};
for (const [locale, words] of Object.entries(LEAN) as Array<["en" | "uk", typeof LEAN.en]>) test(`${locale}: on the real Codex adapter a new ask is sent, an unmarked rewording sends nothing, an explicit ask to send again goes once more, and the answer is voiced whole and in order`, async () => {
  const f = await fixture();
  const send = (id: string, turnId: string, instruction: string, pending: string | null, again: string | null = null) =>
    tool(id, turnId, "request_orchestrator_delegation", { project: null, instruction, pending_request: pending, confirmation_reason: null, asked_again: again });
  const answered = async (id: string) => JSON.parse((await f.reply(id)).contentItems[0].text);
  try {
    f.replay(delta("user", words.first), done("user", words.first), handoff("first", words.first), turn("first"), send("send-first", "first", words.first, null));
    expect(await answered("send-first")).toMatchObject({ status: "sent" });
    f.replay(note("turn/completed", { turn: { id: "first", status: "completed" } }), delta("assistant", "Sent."), done("assistant", "Sent."),
      delta("user", words.again), done("user", words.again), handoff("again", words.again), turn("again"), send("send-again", "again", words.again, null));
    expect(await answered("send-again")).toMatchObject({ status: "check_waiting", waiting: [{ request: "r1", ask: words.first }] });
    f.replay(send("send-again-named", "again", words.again, "r1"));
    expect(await answered("send-again-named")).toMatchObject({ status: "awaiting_report", request: "r1" });
    // The same call replayed adds nothing.
    f.replay(send("send-again-named", "again", words.again, "r1"));
    await until(() => f.wire().filter(row => row.id === "send-again-named" && row.result).length === 2);
    expect(f.deliveries).toHaveLength(1);
    f.replay(note("turn/completed", { turn: { id: "again", status: "completed" } }), delta("assistant", "On its way."), done("assistant", "On its way."),
      delta("user", words.resend), done("user", words.resend), handoff("resend", words.resend), turn("resend"), send("send-resend", "resend", words.first, "r1", words.resend));
    expect(await answered("send-resend")).toMatchObject({ status: "sent" });
    f.replay(send("send-resend-twice", "resend", words.resend, "r1", words.resend));
    expect(await answered("send-resend-twice")).toMatchObject({ status: "sent" });
    expect(f.deliveries.map(row => row.text.split("\n")[0])).toEqual([words.first, words.first]);
    expect(new Set(f.deliveries.map(row => row.delivery.clientMessageId)).size).toBe(2);
    f.replay(note("turn/completed", { turn: { id: "resend", status: "completed" } }), delta("assistant", "Sent again."), done("assistant", "Sent again."));
    // The answer: longer than one append, every item spoken as written and in order, through native appendSpeech.
    const items = words.items.map((item, index) => `${item}. ${(locale === "uk" ? "Деталі перевірки. " : "Check details. ").repeat(index === 1 ? 24 : 4).trim()}`);
    const report: BridgeReportV1 = { id: "answer", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: "short display copy", correlatesDirective: f.deliveries[0]!.delivery.clientMessageId,
      complete: { summary: "SUMMARY", sections: [{ heading: "Done", items }] }, origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } };
    f.reports.push(report);
    await f.service.events(f.session.sessionId, 0);
    const expected = speechParts('The orchestrator for project "fixture" reports result.', voiceReportText(report), "", 500);
    expect(expected.length).toBeGreaterThan(1);
    // Each part waits for the previous one to be voiced.
    const speech = () => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").map(row => row.params.text as string);
    for (const [index, part] of expected.entries()) {
      await until(() => speech().length === index + 1);
      await Bun.sleep(30);
      expect(speech()).toHaveLength(index + 1);
      f.replay(delta("assistant", part), done("assistant", part));
    }
    const parts = speech();
    expect(parts).toEqual(expected);
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(500);
    expect(parts[0]!.startsWith('The orchestrator for project "fixture" reports result.\n')).toBe(true);
    expect(parts.join("\n")).not.toMatch(/Report data|read the lines|continues|left out/);
    expect(parts.join("\n").split("\n").slice(1).join("").replace(/\s+/gu, "")).toBe(["SUMMARY", "Done:", ...items.map(item => `- ${item}`)].join("").replace(/\s+/gu, ""));
    // Asked about once more without an explicit resend, the answer comes from the report and nothing is sent.
    f.replay(delta("user", words.again), done("user", words.again), handoff("later", words.again), turn("later"), send("send-later", "later", words.again, "r1"));
    expect(await answered("send-later")).toMatchObject({ status: "answered", request: "r1", report: { status: "result" } });
    expect(f.deliveries).toHaveLength(2);
  } finally { await f.close(); }
}, 20_000);

/* Case-sensitive targets, explicit asks again with no transcript and switched handles, then a report read again, on the real adapter. The words are written for this test. */
const TARGETS = {
  en: { upper: "What changed on branch Release?", lower: "What changed on branch release?", reworded: "So what about branch Release?", ask: "Review the plan", again: "Send the plan review once more",
    reread: "Read the whole last report again", fact: (n: number) => `fact ${n}: the check passed on every platform` },
  uk: { upper: "Що змінилося у гілці Release?", lower: "Що змінилося у гілці release?", reworded: "То що там з гілкою Release?", ask: "Переглянь план", again: "Надішли перегляд плану ще раз",
    reread: "Прочитай ще раз увесь останній звіт", fact: (n: number) => `факт ${n}: перевірку пройдено` },
};
for (const [locale, words] of Object.entries(TARGETS) as Array<["en" | "uk", typeof TARGETS.en]>) test(`${locale}: on the real Codex adapter two case-distinct targets send once each, explicit asks again without a transcript send once per handoff whatever handle, and a report asked for again is voiced whole`, async () => {
  const f = await fixture();
  const send = (id: string, turnId: string, instruction: string, pending: string | null, again: string | null = null) =>
    tool(id, turnId, "request_orchestrator_delegation", { project: null, instruction, pending_request: pending, confirmation_reason: null, asked_again: again });
  const answered = async (id: string) => JSON.parse((await f.reply(id)).contentItems[0].text);
  const finish = (turnId: string, text: string) => [note("turn/completed", { turn: { id: turnId, status: "completed" } }), delta("assistant", text), done("assistant", text)];
  const speech = () => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").map(row => row.params.text as string);
  try {
    f.replay(delta("user", words.upper), done("user", words.upper), handoff("upper", words.upper), turn("upper"), send("send-upper", "upper", words.upper, null));
    expect(await answered("send-upper")).toMatchObject({ status: "sent" });
    f.replay(...finish("upper", "Sent."), delta("user", words.lower), done("user", words.lower), handoff("lower", words.lower), turn("lower"), send("send-lower", "lower", words.lower, null));
    expect(await answered("send-lower")).toMatchObject({ status: "check_waiting", waiting: [{ request: "r1", ask: words.upper }] });
    f.replay(send("send-lower-new", "lower", words.lower, null));
    expect(await answered("send-lower-new")).toMatchObject({ status: "sent" });
    f.replay(...finish("lower", "Sent."), delta("user", words.reworded), done("user", words.reworded), handoff("reworded", words.reworded), turn("reworded"), send("send-reworded", "reworded", words.reworded, "r1"));
    expect(await answered("send-reworded")).toMatchObject({ status: "awaiting_report", request: "r1" });
    expect(f.deliveries.map(row => row.text.split("\n")[0])).toEqual([words.upper, words.lower]);
    // Handoffs with no input transcript: each explicit ask again sends once, whichever handle of the request it names.
    f.replay(...finish("reworded", "On its way."), handoff("plan", words.ask), turn("plan"), send("send-plan", "plan", words.ask, null));
    expect(await answered("send-plan")).toMatchObject({ status: "check_waiting" });
    f.replay(send("send-plan-new", "plan", words.ask, null));
    expect(await answered("send-plan-new")).toMatchObject({ status: "sent" });
    let handle = "r3";
    for (const attempt of ["again-1", "again-2"]) {
      f.replay(...finish(attempt === "again-1" ? "plan" : "again-1", "Sent."), handoff(attempt, words.again), turn(attempt), send(`${attempt}-a`, attempt, words.ask, handle, words.again));
      expect(await answered(`${attempt}-a`)).toMatchObject({ status: "sent" });
      handle = attempt === "again-1" ? "r4" : "r5";
      for (const [suffix, named] of [["b", handle], ["c", "r3"]] as const) {
        f.replay(send(`${attempt}-${suffix}`, attempt, `${words.again} ${suffix}`, named, words.again));
        expect(await answered(`${attempt}-${suffix}`)).toMatchObject({ status: "sent" });
      }
    }
    expect(f.deliveries.map(row => row.text.split("\n")[0])).toEqual([words.upper, words.lower, words.ask, words.ask, words.ask]);
    expect(new Set(f.deliveries.map(row => row.delivery.clientMessageId)).size).toBe(5);
    f.replay(...finish("again-2", "Sent."));
    // A report over one append, voiced when it arrives, then asked for again: read from its text, every fact to its last.
    const lines = [...Array.from({ length: 14 }, (_, index) => `- ${words.fact(index + 1)}`), "- TAIL_FACT"];
    f.reports.push({ id: "long", seq: 1, project: "fixture", at: "2026-10-11T12:00:00Z", class: "completed", body: lines.join("\n"),
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    const expected = speechParts('The orchestrator for project "fixture" reports result.', lines.join("\n"), "", 500);
    expect(expected.length).toBeGreaterThan(1);
    for (const [index, part] of expected.entries()) {
      await until(() => speech().length === index + 1);
      f.replay(delta("assistant", part), done("assistant", part));
    }
    f.replay(delta("user", words.reread), done("user", words.reread), handoff("reread", words.reread), turn("reread"), tool("reread-call", "reread", "reread_orchestrator_report", { report: null }));
    expect(await answered("reread-call")).toMatchObject({ status: "reading", report: "k1" });
    f.replay(...finish("reread", "Here it is again."));
    const again = speechParts('Once more, the orchestrator for project "fixture" reports result.', lines.join("\n"), "", 500);
    for (const [index, part] of again.entries()) {
      await until(() => speech().length === expected.length + index + 1);
      f.replay(delta("assistant", part), done("assistant", part));
    }
    const reread = speech().slice(expected.length);
    expect(reread).toEqual(again);
    expect(reread.join("\n").split("\n").slice(1)).toEqual(lines);
    expect(f.deliveries).toHaveLength(5);
  } finally { await f.close(); }
}, 30_000);

test("on the real Codex adapter more reports than the speech queue holds are all voiced once and in order", async () => {
  const f = await fixture();
  const speech = () => f.wire().filter(row => row.method === "thread/realtime/appendSpeech").map(row => row.params.text as string);
  try {
    for (let seq = 1; seq <= 66; seq += 1) f.reports.push({ id: `queued-${seq}`, seq, project: "fixture", at: "2026-10-11T00:00:00Z", class: "completed", body: `Report number ${seq}.`,
      origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
    await f.service.events(f.session.sessionId, 0);
    for (let seq = 1; seq <= 66; seq += 1) {
      await f.service.events(f.session.sessionId, 0);
      await until(() => speech().length === seq);
      f.replay(delta("assistant", `Report number ${seq}.`), done("assistant", `Report number ${seq}.`));
    }
    expect(speech().map(text => text.match(/Report number (\d+)/)?.[1])).toEqual(Array.from({ length: 66 }, (_, index) => String(index + 1)));
    expect(f.admission.reportSpeech(f.session.sessionId)).toEqual([]);
  } finally { await f.close(); }
}, 30_000);

/* A target at the start of an ask, and explicit asks again steered into a backing turn that is still running. The words are written for this test. */
const STEERED = {
  en: { opening: "Release: what changed?", openingLower: "release: what changed?", openingReworded: "And release, what changed there?",
    ask: "Review the plan", again: "Send the plan review once more", third: "Send it to the orchestrator again" },
  uk: { opening: "Release: що змінилося?", openingLower: "release: що змінилося?", openingReworded: "А release, що там змінилося?",
    ask: "Переглянь план", again: "Надішли перегляд плану ще раз", third: "Надішли це оркестратору знову" },
};
for (const [locale, words] of Object.entries(STEERED) as Array<["en" | "uk", typeof STEERED.en]>) {
  const send = (id: string, turnId: string, instruction: string, pending: string | null, again: string | null = null) =>
    tool(id, turnId, "request_orchestrator_delegation", { project: null, instruction, pending_request: pending, confirmation_reason: null, asked_again: again });
  const operator = (text: string) => [delta("user", text), done("user", text)];
  const finish = (turnId: string, text: string) => [note("turn/completed", { turn: { id: turnId, status: "completed" } }), delta("assistant", text), done("assistant", text)];

  test(`${locale}: on the real Codex adapter two targets that differ only in their opening capital each send once; a rephrasing named by its handle sends nothing`, async () => {
    const f = await fixture();
    const answered = async (id: string) => JSON.parse((await f.reply(id)).contentItems[0].text);
    try {
      f.replay(...operator(words.opening), handoff("opening", words.opening), turn("opening"), send("send-opening", "opening", words.opening, null));
      expect(await answered("send-opening")).toMatchObject({ status: "sent" });
      f.replay(...finish("opening", "Sent."), ...operator(words.openingLower), handoff("lower", words.openingLower), turn("lower"), send("send-lower", "lower", words.openingLower, null));
      // Different words from the waiting request: the backend is shown it first and judges.
      expect(await answered("send-lower")).toMatchObject({ status: "check_waiting", waiting: [{ request: "r1", ask: words.opening }] });
      f.replay(send("send-lower-new", "lower", words.openingLower, null));
      expect(await answered("send-lower-new")).toMatchObject({ status: "sent" });
      f.replay(...finish("lower", "Sent."), ...operator(words.openingReworded), handoff("reworded", words.openingReworded), turn("reworded"), send("send-reworded", "reworded", words.openingReworded, "r2"));
      expect(await answered("send-reworded")).toMatchObject({ status: "awaiting_report", request: "r2" });
      expect(f.deliveries.map(row => row.text.split("\n")[0])).toEqual([words.opening, words.openingLower]);
    } finally { await f.close(); }
  }, 20_000);

  for (const replied of [false, true]) test(`${locale}: an explicit ask again steered into the running backing turn ${replied ? "after" : "before"} the voice answered sends once per operator attempt; a replay or duplicate handoff adds none`, async () => {
    const f = await fixture();
    const answered = async (id: string) => JSON.parse((await f.reply(id)).contentItems[0].text);
    const reply = replied ? [delta("assistant", "Sent."), done("assistant", "Sent.")] : [];
    try {
      f.replay(...operator(words.ask), handoff("first", words.ask), turn("backing"), send("send-1", "backing", words.ask, null));
      expect(await answered("send-1")).toMatchObject({ status: "sent" });
      // A later operator turn steered into the same backing turn, which keeps running.
      f.replay(...reply, ...operator(words.again), handoff("steered-again", words.again), send("send-2", "backing", words.ask, "r1", words.again));
      expect(await answered("send-2")).toMatchObject({ status: "sent" });
      expect(f.deliveries).toHaveLength(2);
      // The tool call replayed, a duplicate handoff of that turn, and the request named by either handle: that same attempt.
      f.replay(send("send-2", "backing", words.ask, "r1", words.again), handoff("steered-again-duplicate", words.again),
        send("send-2b", "backing", `${words.again}.`, "r2", words.again), send("send-2c", "backing", words.ask, "r1", words.again));
      for (const id of ["send-2b", "send-2c"]) expect(await answered(id)).toMatchObject({ status: "sent" });
      await until(() => f.wire().filter(row => row.id === "send-2" && row.result).length === 2);
      expect(f.deliveries).toHaveLength(2);
      // A third operator turn, still in the same backing turn, is a later attempt: once more, under its own key.
      f.replay(...reply, ...operator(words.third), handoff("steered-third", words.third), send("send-3", "backing", words.ask, "r2", words.third),
        send("send-3b", "backing", words.ask, "r1", words.third));
      for (const id of ["send-3", "send-3b"]) expect(await answered(id)).toMatchObject({ status: "sent" });
      expect(f.deliveries.map(row => row.text.split("\n")[0])).toEqual([words.ask, words.ask, words.ask]);
      expect(new Set(f.deliveries.map(row => row.delivery.clientMessageId)).size).toBe(3);
      expect(f.admission.session(f.session.sessionId).inputs.map(row => row.turn)).toEqual([1, 2, 3]);
      expect(Object.values(f.admission.session(f.session.sessionId).proposals).map(row => row.sourceTurn)).toEqual([1, 2, 3]);
      // The backing turn's own sends stay bound to the turn it was raised for: the same words, not asked again, send nothing.
      f.replay(send("send-plain", "backing", words.ask, null));
      expect(await answered("send-plain")).toMatchObject({ status: "sent" });
      f.replay(...finish("backing", "Sent."));
      expect(f.deliveries).toHaveLength(3);
    } finally { await f.close(); }
  }, 20_000);
}
