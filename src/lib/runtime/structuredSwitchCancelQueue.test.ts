import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { RuntimeJournal } from "@/runtime-host/journal";

import type { HostState } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";

/*
 * A cancelled account switch in the structured delivery queue (#1695 K6b,
 * #1705), over a real runtime journal in a private SQLite file and a fake
 * engine host: the reconfigure ends with exactly one terminal transition, the
 * session's projected pending switch clears, it is never applied, and the
 * send queued behind it goes through. No runtime host socket, registry or
 * account is touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-switch-cancel-queue-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const CONVERSATION = "conversation-switch-cancel";

function busyJournal(name: string): RuntimeJournal {
  const journal = new RuntimeJournal(path.join(sandbox, `${name}.sqlite`), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: CONVERSATION },
    kind: "session-status",
    payload: {
      conversationId: CONVERSATION,
      sessionKey: { engine: "claude", sessionId: "session-switch-cancel" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      artifactPath: "/sessions/switch-cancel.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-running",
    },
  });
  journal.executeOperation({
    kind: "reconfigure",
    operationId: "switch-to-b",
    idempotencyKey: "switch-to-b",
    conversationId: CONVERSATION,
    model: "claude-opus-5",
    effort: "high",
    fast: false,
    accountId: "account-b",
  });
  journal.executeOperation({
    kind: "send",
    operationId: "message-behind-switch",
    idempotencyKey: "message-behind-switch",
    conversationId: CONVERSATION,
    text: "continue after the switch decision",
    policy: "queue",
  });
  return journal;
}

function hostState(active: boolean): HostState {
  return {
    status: active ? "active" : "idle",
    sessionKey: "session-switch-cancel",
    endpoint: "fake:structured-host",
    pid: 1,
    processStartIdentity: "fake:1",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: active ? "turn-running" : null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

function queueOver(journal: RuntimeJournal, cancelled: Set<string>, state: HostState) {
  const transitions: Array<{ operationId: string; status: string; reason: string | null }> = [];
  const port: StructuredDeliveryQueuePort = {
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
      transitions.push({ operationId, status, reason: details?.reason ?? null });
    },
    status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
    reconfigureCancelled: (effect) => cancelled.has(effect.operationId),
  };
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger, state);
  const applied: string[] = [];
  const queue = new StructuredDeliveryQueue(
    port,
    () => host,
    undefined,
    undefined,
    undefined,
    async (effect) => {
      applied.push(effect.operationId);
      return "applied";
    },
  );
  return { queue, transitions, ledger, applied };
}

test("a switch cancelled while the turn runs fails once as cancelled, clears the pending switch, never applies, and lets the send behind it through", async () => {
  const journal = busyJournal("cancelled-behind-turn");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure?.accountId).toBe("account-b");
  const cancelled = new Set<string>();
  const state = hostState(true);
  const { queue, transitions, ledger, applied } = queueOver(journal, cancelled, state);

  /* Not cancelled and behind a running turn: the queue waits, and so does the send behind the switch. */
  await queue.drain();
  expect(journal.operationResult("switch-to-b")?.receipt.status).toBe("queued");
  expect(applied).toEqual([]);
  expect(ledger.writes).toEqual([]);

  /* Cancelled while the turn still runs: settled at once, before any turn check. */
  cancelled.add("switch-to-b");
  await queue.drain();
  expect(journal.operationResult("switch-to-b")?.receipt).toMatchObject({ status: "failed" });
  expect(journal.snapshot().sessions[0]?.pendingReconfigure ?? null).toBeNull();

  /* The turn ends; later drains apply nothing and settle nothing again. */
  state.status = "idle";
  state.activeTurnRef = null;
  await queue.drain();
  await queue.drain();
  expect(applied).toEqual([]);
  expect(transitions.filter((entry) => entry.operationId === "switch-to-b")).toEqual([{ operationId: "switch-to-b", status: "failed", reason: "cancelled" }]);
  expect(ledger.writes.map((entry) => entry.id)).toEqual(["message-behind-switch"]);
  journal.close();
});

test("a switch that is not cancelled still waits for the turn and applies once it ends", async () => {
  const journal = busyJournal("uncancelled-behind-turn");
  const state = hostState(true);
  const { queue, transitions, applied } = queueOver(journal, new Set(), state);
  await queue.drain();
  expect(applied).toEqual([]);
  state.status = "idle";
  state.activeTurnRef = null;
  await queue.drain();
  expect(applied).toEqual(["switch-to-b"]);
  expect(transitions.filter((entry) => entry.operationId === "switch-to-b").map((entry) => entry.status)).toEqual(["applying", "applied"]);
  expect(journal.snapshot().sessions[0]?.pendingReconfigure ?? null).toBeNull();
  journal.close();
});
