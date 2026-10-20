import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeOperationResult } from "@/lib/runtime/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { SEND_LOST_REASON, SEND_UNVERIFIED_REASON } from "@/lib/runtime/sendSettlement";
import { fencedFirstMessageRetrySafe } from "./fencedFirstMessage";

function fenced(): RuntimeOperationResult {
  return { operationId: "spawn_message_launch-fixture", replayed: false, receipt: {
    operationId: "spawn_message_launch-fixture", conversationId: "conversation_fixture", idempotencyKey: "spawn_launch-fixture",
    kind: "send", status: "failed", reason: SEND_LOST_REASON, at: "2026-10-20T12:00:00Z", revision: 3,
  } };
}

test("the journal's fenced original first message permits replacement", async () => {
  const calls: string[] = [];
  const safe = await fencedFirstMessageRetrySafe({ operationStatus: async (id, options) => {
    calls.push(id);
    expect(options?.currentRetryLeaf).toBe(true);
    return fenced();
  } }, "launch-fixture", "conversation_fixture", () => true);
  expect(safe).toBe(true);
  expect(calls).toEqual(["spawn_message_launch-fixture"]);
});

test.each([
  "unknown", "delivered", "queued", "wrong-operation", "wrong-receipt", "wrong-conversation", "wrong-key", "wrong-kind",
  "unknown-guidance", "redirected", "retry-leaf", "absent", "unreadable", "lost-authority",
])("a %s journal answer never permits a fresh message", async mode => {
  const operation = fenced();
  const r = operation.receipt;
  let eligible = true;
  if (mode === "unknown") { r.status = "uncertain"; r.reason = SEND_UNVERIFIED_REASON; }
  if (mode === "delivered") r.status = "delivered";
  if (mode === "queued") r.status = "queued";
  if (mode === "wrong-operation") operation.operationId = "other";
  if (mode === "wrong-receipt") r.operationId = "other";
  if (mode === "wrong-conversation") r.conversationId = "conversation_other";
  if (mode === "wrong-key") r.idempotencyKey = "other";
  if (mode === "wrong-kind") r.kind = "steer";
  if (mode === "unknown-guidance") r.resend = "verify-first";
  if (mode === "redirected") r.redirectedTo = { operationId: "other", conversationId: "conversation_other" };
  if (mode === "retry-leaf") r.retryOfOperationId = "prior";
  expect(await fencedFirstMessageRetrySafe({ operationStatus: async () => {
    if (mode === "unreadable") throw new Error("transport unavailable");
    if (mode === "lost-authority") eligible = false;
    return mode === "absent" ? null : operation;
  } }, "launch-fixture", "conversation_fixture", () => eligible)).toBe(false);
});

test("an absent transport or preexisting authority refusal performs no read", async () => {
  expect(await fencedFirstMessageRetrySafe(null, "launch-fixture", "conversation_fixture", () => true)).toBe(false);
  let calls = 0;
  expect(await fencedFirstMessageRetrySafe({ operationStatus: async () => { calls++; return fenced(); } },
    "launch-fixture", "conversation_fixture", () => false)).toBe(false);
  expect(calls).toBe(0);
});

test("a real terminal journal fence survives reopen and a later retry leaf withdraws permission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-journal-"));
  const filename = path.join(root, "journal.sqlite");
  const options = { structuredHosts: true, now: () => Date.parse("2026-10-20T12:00:00Z") };
  let journal = new RuntimeJournal(filename, options);
  try {
    journal.append({ scope: { type: "session", id: "conversation_fixture" }, kind: "session-status", payload: {
      conversationId: "conversation_fixture", sessionKey: { engine: "codex", sessionId: "thread-fixture" },
      hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    } });
    journal.executeOperation({ kind: "send", operationId: "spawn_message_launch-fixture", idempotencyKey: "spawn_launch-fixture",
      conversationId: "conversation_fixture", text: "Run the stage", policy: "queue" });
    journal.transitionOperation("spawn_message_launch-fixture", "failed", { reason: SEND_LOST_REASON }, { fromStatuses: ["queued"] });
    journal.close();
    journal = new RuntimeJournal(filename, options);
    const client = { operationStatus: async (id: string) => journal.currentRetryResult(id) };
    expect(await fencedFirstMessageRetrySafe(client, "launch-fixture", "conversation_fixture", () => true)).toBe(true);
    expect(journal.effectBatch()).toHaveLength(0);
    journal.retryOperation("spawn_message_launch-fixture", "explicit-retry");
    expect(await fencedFirstMessageRetrySafe(client, "launch-fixture", "conversation_fixture", () => true)).toBe(false);
  } finally { journal.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
