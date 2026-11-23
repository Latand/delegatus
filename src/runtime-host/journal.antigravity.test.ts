import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

/* Antigravity sessions in the runtime journal (docs/design/antigravity-engine.md §3.3). */

function journalWith(session: Record<string, unknown>): RuntimeJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-antigravity-"));
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true, maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-antigravity"),
    kind: "session-status",
    payload: {
      conversationId: "conv-antigravity",
      host: "hosted",
      provenance: "structured",
      ...session,
    },
  });
  return journal;
}

const antigravity = {
  sessionKey: { engine: "antigravity", sessionId: "session-antigravity" },
  hostKind: "antigravity-acp",
  capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
};

test("an Antigravity session keeps its engine, host kind and interrupt steer mode", () => {
  const journal = journalWith({ ...antigravity, turn: "idle", activeTurnId: null });
  const session = journal.snapshot().sessions.find((candidate) => candidate.conversationId === "conv-antigravity");
  expect(session).toMatchObject({
    sessionKey: { engine: "antigravity", sessionId: "session-antigravity" },
    hostKind: "antigravity-acp",
    capabilities: { steer: false, steerMode: "interrupt" },
  });
  journal.close();
});

test("a steer to a running Antigravity turn is admitted for interrupt-and-resend, never refused", () => {
  const journal = journalWith({ ...antigravity, turn: "running", activeTurnId: "antigravity:1-turn" });
  const result = journal.executeOperation({
    kind: "steer",
    operationId: "op-steer",
    idempotencyKey: "steer-key",
    conversationId: "conv-antigravity",
    text: "change course",
  });
  expect(result.receipt).toMatchObject({ kind: "steer", status: "pending", turnId: "antigravity:1-turn" });
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("a steer after the Antigravity turn ended starts a plain turn", () => {
  const journal = journalWith({ ...antigravity, turn: "idle", activeTurnId: null });
  const result = journal.executeOperation({
    kind: "steer",
    operationId: "op-late-steer",
    idempotencyKey: "late-steer-key",
    conversationId: "conv-antigravity",
    text: "one more thing",
  });
  expect(result.receipt).toMatchObject({ status: "pending", turnId: null });
  journal.close();
});

test("Antigravity session status persists to SQLite, is visible to a second connection, and isolates caller mutations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-antigravity-sqlite-"));
  const dbPath = path.join(dir, "events.sqlite");
  const writer = new RuntimeJournal(dbPath, { structuredHosts: true, maxEvents: 100, now: () => 200 });
  const reader = new RuntimeJournal(dbPath, { structuredHosts: true, maxEvents: 100, now: () => 200 });
  try {
    writer.append({
      scope: runtimeScope("session", "conv-ag-2"),
      kind: "session-status",
      payload: {
        conversationId: "conv-ag-2",
        host: "hosted",
        provenance: "structured",
        ...antigravity,
        turn: "running",
        activeTurnId: "antigravity:2-turn",
      },
    });
    const fromWriter = writer.snapshot().sessions.find((candidate) => candidate.conversationId === "conv-ag-2")!;
    expect(fromWriter.hostKind).toBe("antigravity-acp");
    // Mutating the caller's returned copy must not affect later reads.
    (fromWriter as unknown as Record<string, unknown>).hostKind = "mutated";
    expect(writer.snapshot().sessions.find((candidate) => candidate.conversationId === "conv-ag-2")?.hostKind).toBe("antigravity-acp");

    // A second SQLite connection sees the committed Antigravity session.
    const second = new RuntimeJournal(dbPath, { structuredHosts: true, maxEvents: 100, now: () => 200 });
    try {
      expect(second.snapshot().sessions.find((candidate) => candidate.conversationId === "conv-ag-2")).toMatchObject({
        sessionKey: { engine: "antigravity", sessionId: "session-antigravity" },
        hostKind: "antigravity-acp",
        capabilities: { steer: false, steerMode: "interrupt" },
      });
    } finally {
      second.close();
    }
  } finally {
    reader.close();
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
