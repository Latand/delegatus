import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegistryFile } from "@/lib/agent/registry";

import { claudeMessageProvenance } from "./claudeMessageProvenance";
import { FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { captureSelectedContext } from "@/lib/selection/selectedContext";

/**
 * The ledger→feed join of #1117: delivery evidence written at admission time
 * answers "who authored this transcript row" by engine message id. New sends
 * carry a stamped origin; older ledgers still classify through the evidence
 * they already have (the operator's selected-context capture, a spawn
 * operation's launch receipt); anything unproven is omitted, never guessed.
 */

/* Assembled from parts so the invented id can never fingerprint as a real
   session identifier on the publication gate. */
const SESSION_ID = ["11111111", "2222", "4333", "8444", "555555555550"].join("-");
const TRANSCRIPT = `/tmp/llv-provenance-fixture/${SESSION_ID}.jsonl`;

const REFERENCE = captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
  cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
  identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  revision: 2,
  now: Date.parse("2026-07-31T09:00:00.000Z"),
});

const tmpDirs: string[] = [];

function newLedger(): FileClaudeDeliveryLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-provenance-"));
  tmpDirs.push(dir);
  return new FileClaudeDeliveryLedger(dir);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function emptySnapshot(overrides: Partial<Pick<RegistryFile, "receipts" | "conversations">> = {}): RegistryFile {
  return { receipts: {}, conversations: {}, ...overrides } as RegistryFile;
}

test("a stamped operator send resolves to the operator with its selected-context badge", () => {
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, {
    id: "op-1",
    text: "please rerun the failing check",
    selectedContext: REFERENCE,
    origin: { kind: "operator" },
  }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "op-1", "engine-uuid-1");

  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => emptySnapshot() });
  expect(map["engine-uuid-1"]).toEqual({ origin: "operator", selectedContext: REFERENCE });
});

test("a stamped agent send resolves to an internal relay naming the sender role", () => {
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, {
    id: "op-2",
    text: "Round 2 verdict: REQUEST_CHANGES",
    origin: { kind: "agent", role: "reviewer" },
  }, "queued-next-turn");
  ledger.confirmDelivered(SESSION_ID, "op-2", "engine-uuid-2");

  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => emptySnapshot() });
  expect(map["engine-uuid-2"]).toEqual({ origin: "agent", senderRole: "reviewer" });
});

test("a pre-#1117 operator send still resolves through its selected-context capture", () => {
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, {
    id: "op-3",
    text: "розкажи що плануєш робити",
    selectedContext: REFERENCE,
  }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "op-3", "engine-uuid-3");

  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => emptySnapshot() });
  expect(map["engine-uuid-3"]).toEqual({ origin: "operator", selectedContext: REFERENCE });
});

test("a pre-#1117 spawn first message classifies through its launch receipt's delegation depth", () => {
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, { id: "spawn_message_launch-root", text: "build the thing" }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "spawn_message_launch-root", "engine-uuid-4");
  ledger.recordQueued(SESSION_ID, { id: "spawn_message_launch-delegated", text: "stage mandate" }, "queued-next-turn");
  ledger.confirmDelivered(SESSION_ID, "spawn_message_launch-delegated", "engine-uuid-5");

  const snapshot = emptySnapshot({
    receipts: {
      "launch-root": { delegationDepth: 0, parentConversationId: null },
      "launch-delegated": { delegationDepth: 2, parentConversationId: "conversation_parent" },
    } as unknown as RegistryFile["receipts"],
    conversations: {
      conversation_parent: { agentRole: "orchestrator", generations: [] },
    } as unknown as RegistryFile["conversations"],
  });
  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot });
  expect(map["engine-uuid-4"]).toEqual({ origin: "operator" });
  expect(map["engine-uuid-5"]).toEqual({ origin: "agent", senderRole: "orchestrator" });
});

test("undelivered entries, unproven entries and a missing ledger resolve to nothing", () => {
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, { id: "op-queued-only", text: "still waiting" }, "queued-next-turn");
  ledger.recordQueued(SESSION_ID, { id: "op-no-evidence", text: "who sent this?" }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "op-no-evidence", "engine-uuid-6");

  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => emptySnapshot() });
  expect(map).toEqual({});
  expect(claudeMessageProvenance("/tmp/does-not-exist/nope.jsonl", { ledger: newLedger(), registrySnapshot: () => emptySnapshot() })).toEqual({});
  expect(claudeMessageProvenance("/tmp/not-a-transcript.log", { ledger, registrySnapshot: () => emptySnapshot() })).toEqual({});
});

test("a delivered entry names the submission that admitted its operation", () => {
  /* The ledger files an entry under the delivery OPERATION's id; the registry
     keeps which client message id admitted that operation, and that key is
     the id of the outbox row the operator is looking at. Resolving it here is
     what lets the feed bind the record into that row without comparing text
     (#1950 round 2). A retry writes a second operation under the same key, so
     both entries name one submission. */
  const ledger = newLedger();
  for (const operationId of ["op-first", "op-retry"]) {
    ledger.recordQueued(SESSION_ID, {
      id: operationId,
      text: "read the release notes",
      origin: { kind: "operator" },
    }, "turn-started");
    ledger.confirmDelivered(SESSION_ID, operationId, `engine-uuid-${operationId}`);
  }
  const owner = (clientMessageId: string) => ({ clientMessageId, conversationId: "conversation_atlas_a" });
  const snapshot = {
    receipts: {},
    conversations: {},
    deliveryOperationOwners: { "op-first": owner("op_submission_a"), "op-retry": owner("op_submission_a") },
  } as unknown as RegistryFile;

  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot });
  expect(map["engine-uuid-op-first"]).toEqual({ origin: "operator", submissionId: "op_submission_a" });
  expect(map["engine-uuid-op-retry"]).toEqual({ origin: "operator", submissionId: "op_submission_a" });
});

test("an operation the registry cannot name carries no submission", () => {
  /* Absence is honest and binds nothing: a row whose delivery this browser
     cannot name must never be handed to whichever submission shares its
     words. */
  const ledger = newLedger();
  ledger.recordQueued(SESSION_ID, { id: "op-unknown", text: "anything", origin: { kind: "operator" } }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "op-unknown", "engine-uuid-unknown");
  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => emptySnapshot() });
  expect(map["engine-uuid-unknown"]).toEqual({ origin: "operator" });
});
