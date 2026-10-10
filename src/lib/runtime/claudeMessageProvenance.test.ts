import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegistryFile } from "@/lib/agent/registry";

import { claudeMessageProvenance } from "./claudeMessageProvenance";
import { FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
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

function emptySnapshot(overrides: Partial<Pick<RegistryFile, "receipts" | "conversations" | "deliveryOperationOwners">> = {}): RegistryFile {
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
    deliveryOperationOwners: {
      "spawn_message_launch-root": { clientMessageId: "spawn_launch-root", conversationId: "conversation_root" },
    } as unknown as RegistryFile["deliveryOperationOwners"],
  });
  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot });
  expect(map["engine-uuid-4"]).toEqual({ origin: "operator", submissionId: "spawn_launch-root" });
  expect(map["engine-uuid-5"]).toEqual({ origin: "agent", senderRole: "orchestrator", senderConversationId: "conversation_parent" });
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

test("voice channel survives a reopened Claude delivery ledger into feed provenance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-claude-ledger-"));
  tmpDirs.push(directory);
  const ledger = new FileClaudeDeliveryLedger(directory);
  ledger.recordQueued(SESSION_ID, { id: "voice-operation", text: "Review the plan", origin: { kind: "operator", channel: "voice-delegatus" } }, "turn-started");
  ledger.confirmDelivered(SESSION_ID, "voice-operation", "voice-engine-message");
  const reopened = new FileClaudeDeliveryLedger(directory);
  expect(claudeMessageProvenance(TRANSCRIPT, { ledger: reopened, registrySnapshot: () => emptySnapshot() })["voice-engine-message"])
    .toEqual({ origin: "operator", channel: "voice-delegatus" });
});

const noSeats = () => ({ schemaVersion: 1, nextSeatEpoch: 1, seats: {}, pending: {}, history: [], revocations: [], rollbacks: {} });
function rotationSeats(custom = false, historical = false) {
  const seat = {
    project: "atlas", promptVersion: 44, mandate: custom ? "A custom mandate" : ORCHESTRATOR_SYSTEM_PROMPT,
    intent: { clientRequestId: "rotation-fixture", launchId: "rotation-launch" },
  } as OrchestratorSeat;
  return { ...noSeats(), seats: historical ? {} : { atlas: seat }, history: historical ? [{ seat }] : [] } as unknown as ReturnType<typeof import("@/lib/orchestrator/seats").readOrchestratorSeatFile>;
}

for (const custom of [false, true]) for (const historical of [false, true]) {
  test(`rotation UUID retains ${custom ? "custom" : "v44"} mandate from ${historical ? "history" : "active seat"} with stamped operator origin`, () => {
    const ledger = newLedger();
    ledger.recordQueued(SESSION_ID, { id: "spawn_message_rotation-launch", text: "Mandate", origin: { kind: "operator", channel: "voice-delegatus" }, selectedContext: REFERENCE }, "turn-started");
    ledger.confirmDelivered(SESSION_ID, "spawn_message_rotation-launch", "rotation-uuid");
    const snapshot = emptySnapshot({ deliveryOperationOwners: {
      "spawn_message_rotation-launch": { clientMessageId: "spawn_rotation-launch", conversationId: "conversation_successor" },
    } as unknown as RegistryFile["deliveryOperationOwners"] });
    let reads = 0;
    const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot, orchestratorSeats: () => { reads++; return rotationSeats(custom, historical); } });
    expect(map["rotation-uuid"]).toEqual({ origin: "operator", channel: "voice-delegatus", selectedContext: REFERENCE, submissionId: "spawn_rotation-launch", mandate: custom ? { kind: "custom" } : { kind: "version", version: 44 } });
    expect(reads).toBe(1);
  });
}

test("pruned first-launch ownership still names the recorded seat, while unrelated root launches remain operator messages", () => {
  const ledger = newLedger();
  for (const launch of ["rotation-launch", "ordinary-launch"]) {
    ledger.recordQueued(SESSION_ID, { id: `spawn_message_${launch}`, text: "Same words" }, "turn-started");
    ledger.confirmDelivered(SESSION_ID, `spawn_message_${launch}`, launch);
  }
  const snapshot = emptySnapshot({ conversations: { conversation_successor: { generations: [{ path: TRANSCRIPT }], delegationDepth: 0 } } as unknown as RegistryFile["conversations"] });
  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot, orchestratorSeats: () => rotationSeats() });
  expect(map["rotation-launch"]).toEqual({ origin: "operator", mandate: { kind: "version", version: 44 } });
  expect(map["ordinary-launch"]).toEqual({ origin: "operator" });
});

test("reserved adoption identity keeps the card when the seat store is unavailable, without classifying an operator paste", () => {
  const ledger = newLedger();
  for (const id of ["adopt-operation", "paste-operation"]) {
    ledger.recordQueued(SESSION_ID, { id, text: "Same mandate words", origin: { kind: "operator" } }, "turn-started");
    ledger.confirmDelivered(SESSION_ID, id, id);
  }
  const snapshot = emptySnapshot({ deliveryOperationOwners: {
    "adopt-operation": { clientMessageId: "orchmandate_fixture", conversationId: "conversation_successor" },
    "paste-operation": { clientMessageId: "operator-paste", conversationId: "conversation_successor" },
  } as unknown as RegistryFile["deliveryOperationOwners"] });
  const map = claudeMessageProvenance(TRANSCRIPT, { ledger, registrySnapshot: () => snapshot, orchestratorSeats: () => { throw new Error("unavailable"); } });
  expect(map["adopt-operation"]).toEqual({ origin: "operator", submissionId: "orchmandate_fixture", mandate: { kind: "unqualified" } });
  expect(map["paste-operation"]).toEqual({ origin: "operator", submissionId: "operator-paste" });
});
