import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

/* Copilot sessions in the runtime journal (docs/design/copilot-engine.md 3.4). */

function journalWith(session: Record<string, unknown>): RuntimeJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-copilot-"));
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true, maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-copilot"),
    kind: "session-status",
    payload: {
      conversationId: "conv-copilot",
      host: "hosted",
      provenance: "structured",
      ...session,
    },
  });
  return journal;
}

const copilot = {
  sessionKey: { engine: "copilot", sessionId: "session-copilot" },
  hostKind: "copilot-acp",
  capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
};

test("a Copilot session keeps its engine, host kind and interrupt steer mode", () => {
  const journal = journalWith({ ...copilot, turn: "idle", activeTurnId: null });
  const session = journal.snapshot().sessions.find((candidate) => candidate.conversationId === "conv-copilot");
  expect(session).toMatchObject({
    sessionKey: { engine: "copilot", sessionId: "session-copilot" },
    hostKind: "copilot-acp",
    capabilities: { steer: false, steerMode: "interrupt" },
  });
  journal.close();
});

test("a steer to a running Copilot turn is admitted for interrupt-and-resend, never refused", () => {
  const journal = journalWith({ ...copilot, turn: "running", activeTurnId: "copilot:1-turn" });
  const result = journal.executeOperation({
    kind: "steer",
    operationId: "op-steer",
    idempotencyKey: "steer-key",
    conversationId: "conv-copilot",
    text: "change course",
  });
  expect(result.receipt).toMatchObject({ kind: "steer", status: "pending", turnId: "copilot:1-turn" });
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("a steer after the Copilot turn ended starts a plain turn", () => {
  const journal = journalWith({ ...copilot, turn: "idle", activeTurnId: null });
  const result = journal.executeOperation({
    kind: "steer",
    operationId: "op-late-steer",
    idempotencyKey: "late-steer-key",
    conversationId: "conv-copilot",
    text: "one more thing",
  });
  expect(result.receipt).toMatchObject({ status: "pending", turnId: null });
  journal.close();
});

test("a steer to an engine that declares neither steer nor a fallback is still refused", () => {
  const journal = journalWith({
    sessionKey: { engine: "claude", sessionId: "session-claude" },
    hostKind: "claude-broker",
    capabilities: { steer: false, structuredAttention: true },
    turn: "running",
    activeTurnId: "claude-turn",
  });
  const result = journal.executeOperation({
    kind: "steer",
    operationId: "op-claude-steer",
    idempotencyKey: "claude-steer-key",
    conversationId: "conv-copilot",
    text: "change course",
  });
  expect(result.receipt).toMatchObject({ status: "rejected", reason: "stale-turn" });
  journal.close();
});
