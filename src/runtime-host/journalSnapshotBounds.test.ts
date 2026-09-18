import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

test("dead sessions retain durable audit state without shipping stale live text", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-snapshot-bounds-"));
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { now: () => 100 });
  try {
    journal.append({
      scope: runtimeScope("session", "conversation-dead"),
      kind: "session-status",
      payload: {
        conversationId: "conversation-dead",
        sessionKey: { engine: "codex", sessionId: "session-dead" },
        hostKind: "codex-app-server",
        host: "dead",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
        liveTurn: { turnId: "turn-finished", text: "stale streamed text" },
      },
    });

    expect(journal.sessionState("conversation-dead")?.liveTurn?.text).toBe("stale streamed text");
    expect(journal.snapshot().sessions[0]?.liveTurn).toBeNull();
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("browser summaries defer voice bodies without losing session identity or receipt recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-summary-"));
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"));
  try {
    for (let n = 0; n < 100; n++) journal.append({
      scope: runtimeScope("session", `conversation-${n}`), kind: "session-status",
      payload: { conversationId: `conversation-${n}`, sessionKey: { engine: "codex", sessionId: `session-${n}` },
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        parentConversationId: "conversation-parent", artifactPath: `/repo/session-${n}.jsonl`,
        voiceDeliveries: [{ deliveryId: `delivery-${n}`, turnId: `turn-${n}`, ready: true,
          responses: [{ responseId: `response-${n}`, text: "Synthetic worker output. ".repeat(500) }] }],
        acknowledgedVoiceDeliveryIds: ["already-delivered"],
        recentReceipts: [{ operationId: `op-${n}`, idempotencyKey: `key-${n}`, conversationId: `conversation-${n}`,
          kind: "send", status: "queued", text: "Preserve the original request", revision: 1, at: "2026-09-15T00:00:00Z" }],
      },
    });
    const full = journal.snapshotJson();
    const summary = journal.snapshotJson([]);
    expect(summary.length).toBeLessThan(full.length / 10);
    const fullValue = JSON.parse(full);
    const summaryValue = JSON.parse(summary);
    expect(summaryValue.sessions).toHaveLength(fullValue.sessions.length);
    for (let i = 0; i < fullValue.sessions.length; i++) {
      const { voiceDeliveries, ...metadata } = fullValue.sessions[i];
      const { voiceDeliverySnapshotRevision, voiceDeliveries: deferred, ...actual } = summaryValue.sessions[i];
      expect(actual).toEqual(metadata);
      expect(voiceDeliverySnapshotRevision).toBe(metadata.revision);
      expect(voiceDeliveries).toHaveLength(1);
      expect(deferred).toEqual(voiceDeliveries.map((delivery: { responses: Array<{ responseId: string; text: string }> }) => ({ ...delivery, responses: delivery.responses.map(response => ({ ...response, text: "" })) })));
    }
    const targeted = JSON.parse(journal.snapshotJson(["conversation-7"]));
    expect(targeted.sessions.find((s: { conversationId: string }) => s.conversationId === "conversation-7"))
      .toEqual(fullValue.sessions.find((s: { conversationId: string }) => s.conversationId === "conversation-7"));
    expect(journal.sessionState("conversation-8")?.voiceDeliveries).toHaveLength(1);
    expect(JSON.parse(journal.snapshotJson()).sessions).toEqual(fullValue.sessions);
    console.log(JSON.stringify({ profile: "voice-summary", sessions: 100, fullBytes: full.length, summaryBytes: summary.length }));
  } finally { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
