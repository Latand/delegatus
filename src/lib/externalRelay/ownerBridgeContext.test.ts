import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { startTestRelay } from "./testRelay";
import { contextRequest } from "./request.fixture";
import { requestSchema } from "./protocol";
import { ownerTierFor } from "./profile";
import { ownerRunPrompt, runOwnerAgent } from "./ownerRun";
import { resolveOwnerBridgeContext, ownerNeedsClarification } from "./ownerBridgeContext";
import { publishedRelayReference, recordPublishedRelayReference } from "./publishedReferences";
import { relayCall } from "./client";
import { appendBridgeReports, recordBridgeReportTelegram } from "@/lib/bridge/store";
import type { RelayTargetSettings } from "./store";

const previousState = process.env.LLV_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-context-"));
let sequence = 0;
const chatId = String(2 ** 6);
const messageId = 2 ** 5;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(root, `case-${++sequence}`); });
afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});
const at = "2026-10-11T12:00:00Z";
const body = "Build clone creation with one button? Confirm the start.";
const target: RelayTargetSettings = { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true,
  engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3, ownerTier: true };
function report() {
  const directory = path.join(process.env.LLV_STATE_DIR!, "telegram");
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, "bot.sqlite"));
  db.exec("CREATE TABLE chats (chat_id TEXT PRIMARY KEY, alias TEXT)");
  db.query("INSERT INTO chats VALUES (?, ?)").run(chatId, "report-room");
  db.close();
  const report = appendBridgeReports([{ key: "report", project: "project-b", targetSeatConversationId: "seat-b",
    origin: { kind: "manager", conversationId: "seat-b", role: "orchestrator" }, class: "question", at, body,
    telegram: { chat: "report-room", html: body } }]).appended[0];
  recordBridgeReportTelegram(report.id, { state: "sent", messageIds: [messageId], at });
  return report;
}
function ownerRequest(replyTo: string | null = "published-report", previousKey = "older-message") {
  return requestSchema.parse({ ...contextRequest, target_id: "target", answer: { max_chars: 1000, progress: "none" }, input: {
    ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true },
    request_text: "го", respond_to: "owner-message", conversation: [
      { ...contextRequest.input.conversation[0], id: previousKey, text: "Old unrelated API work", sent_at: at },
      { ...contextRequest.input.conversation[0], id: "owner-message", text: "/ai го", reply_to: replyTo, sent_at: at },
    ],
  } });
}
function receipt(apiBase: string, messageKey = "published-report", targetId = "target", actualChat = chatId) {
  recordPublishedRelayReference(apiBase, `/targets/${targetId}/messages`, "POST", { chat_id: Number(actualChat), message_id: messageId }, 200, { message_key: messageKey, replayed: false });
}

test("publish transport retains the exact reference and resolves a report absent from relay history", async () => {
  report();
  const server = await startTestRelay(() => ({ body: { message_key: "published-report", replayed: false } }));
  const apiBase = `${server.origin}/v1`;
  try {
    await relayCall(apiBase, "/targets/target/messages", "POST", { chat_id: Number(chatId), message_id: messageId, text: body }, "fixture");
    expect(publishedRelayReference(apiBase, "target", "published-report")).toMatchObject({ chatId, messageId });
    const request = ownerRequest(); const owner = ownerTierFor({ ownerTier: true }, request)!;
    const context = resolveOwnerBridgeContext(request, owner, apiBase);
    expect(context).toMatchObject({ project: "project-b", sourceSeat: "seat-b", reportText: body });
    owner.bridgeReport = context;
    expect(ownerNeedsClarification(owner)).toBe(false);
    const prompt = ownerRunPrompt(request, owner, 3);
    expect(prompt).toContain(body);
    expect(prompt).toContain("Forward the owner's text and request_text verbatim");
    expect(prompt).toContain('"sourceSeat":"seat-b"');
  } finally { await server.close(); }
});

test("an approval immediately following a published report resolves even at the same timestamp", () => {
  report(); receipt("http://127.0.0.1:1/v1");
  const request = ownerRequest(null, "published-report");
  expect(resolveOwnerBridgeContext(request, ownerTierFor({ ownerTier: true }, request)!, "http://127.0.0.1:1/v1")).toMatchObject({ reportText: body });
});

for (const requestText of ["Implement the new feature in project-a.", null])
  test(`an independent owner instruction does not inherit the preceding report (${requestText === null ? "message text" : "request text"})`, () => {
    report(); receipt("http://127.0.0.1:1/v1");
    const request = ownerRequest(null, "published-report");
    request.input.request_text = requestText;
    request.input.conversation[1]!.text = "/ai Implement the new feature in project-a.";
    const owner = ownerTierFor({ ownerTier: true }, request)!;
    expect(ownerNeedsClarification(owner)).toBe(false);
    expect(resolveOwnerBridgeContext(request, owner, "http://127.0.0.1:1/v1")).toBeNull();
  });

test("an explicit reply retains its report context even with a substantive instruction", () => {
  report(); receipt("http://127.0.0.1:1/v1");
  const request = ownerRequest();
  request.input.request_text = "Implement the feature described in this report.";
  expect(resolveOwnerBridgeContext(request, ownerTierFor({ ownerTier: true }, request)!, "http://127.0.0.1:1/v1"))
    .toMatchObject({ project: "project-b", sourceSeat: "seat-b", reportText: body });
});

for (const mismatch of ["chat", "target", "unpublished", "intervening-message", "unknown-reply"] as const)
  test(`${mismatch} cannot turn stale chat text into report context or a task`, async () => {
    report();
    const apiBase = "http://127.0.0.1:1/v1";
    if (mismatch !== "unpublished") receipt(apiBase, "published-report", mismatch === "target" ? "other-target" : "target", mismatch === "chat" ? String(Number(chatId) + 1) : chatId);
    const request = ownerRequest(mismatch === "intervening-message" ? null : mismatch === "unknown-reply" ? "unknown" : "published-report");
    const owner = ownerTierFor({ ownerTier: true }, request)!;
    owner.bridgeReport = resolveOwnerBridgeContext(request, owner, apiBase);
    expect(owner.bridgeReport).toBeNull();
    const result = await runOwnerAgent({ request, owner, target, accountId: null, hardCapMs: 1000,
      onConversation: () => { throw new Error("an unresolved approval must not launch work"); },
      ports: { launch: async () => { throw new Error("no task or agent should be started"); }, observe: async () => ({ state: "failed" }), stop: async () => {} },
    }).done;
    expect(result).toMatchObject({ status: "done", answer: { action: "reply", reply_to: "owner-message" } });
    const text = (result.answer as { text: string }).text;
    expect(text).toContain("Що саме підтверджуєте?");
    expect(text.split("\n")).toHaveLength(1);
  });

test("publication retries preserve the mapping and a conflicting receipt is refused", () => {
  const apiBase = "http://127.0.0.1:1/v1";
  receipt(apiBase); receipt(apiBase);
  expect(() => receipt(apiBase, "published-report", "target", String(Number(chatId) + 1))).toThrow("reference conflict");
  expect(publishedRelayReference(apiBase, "target", "published-report")?.chatId).toBe(chatId);
  expect(publishedRelayReference("http://127.0.0.1:2/v1", "target", "published-report")).toBeNull();
});

test("non-owner messages and an off owner switch cannot enter this owner context path", () => {
  const request = ownerRequest();
  expect(ownerTierFor({ ownerTier: false }, request)).toBeNull();
  expect(ownerTierFor({ ownerTier: true }, { ...request, input: { ...request.input, requester: { ...request.input.requester!, is_owner: false } } })).toBeNull();
});
