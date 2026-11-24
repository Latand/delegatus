import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { fixtureRegistry, FIXTURE_SESSION, FIXTURE_CONVERSATION } from "@/lib/agentState/testFixture";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { FileRuntimeEventStore, readRuntimeEventPage } from "@/lib/runtime/eventStore";
import { statePath } from "@/lib/configDir";
import { matchingWakeResponseCheckpoint, normalizeSeatWakeResponse, observeSeatWakeResponse, seatWakeResponseBound, wakeResponseEvidenceFromEvents, wakeResponseRecoveryKey, type SeatWakeResponse } from "./seatWakeResponse";
const row: SeatWakeResponse = { clientMessageId: "wake", operationId: "operation", conversationId: "conversation_fixture", seatEpoch: 7,
  deliveredAt: "2026-11-01T00:00:00Z", progressAt: "2026-11-01T00:00:00Z", boundMs: 900_000, action: "pending" };

test.each([[300_000, 1_800_000, 900_000], [300_000, 60_000, 600_000], [600_000, 3_600_000, 1_200_000]])("response bound freezes cadence %i and wake %i at %i", (check, wake, bound) => {
  expect(seatWakeResponseBound(check, wake)).toBe(bound);
});
test.each(["pending", "nudging", "nudged"] as const)("writer output for %s round trips through the persisted reader", action => {
  expect(normalizeSeatWakeResponse(JSON.parse(JSON.stringify({ ...row, action })))).toEqual({ ...row, action });
});
test("wake preparation survives serialization while legacy rows retain their missing proof", () => {
  const preparedAt = "2026-10-31T23:55:00Z";
  expect(normalizeSeatWakeResponse(JSON.parse(JSON.stringify({ ...row, preparedAt })))).toEqual({ ...row, preparedAt });
  expect(normalizeSeatWakeResponse(JSON.parse(JSON.stringify(row)))).toEqual(row);
  expect(normalizeSeatWakeResponse({ ...row, preparedAt: "invalid" })).toBeUndefined();
  expect(normalizeSeatWakeResponse({ ...row, preparedAt: "2026-11-01T00:01:00Z" })).toBeUndefined();
});
test("receipt timeouts preserve replay progress and a new receipt binding reopens the prefix", () => {
  const checkpoint = { generationId: "generation", identity: "a".repeat(64), binding: "b".repeat(64), fromPreparation: false,
    nativeTurns: [["native-turn", false] as [string, boolean]],
    position: { source: "1:2:3", offset: 3_146_040, edge: "c".repeat(64), seq: 20 },
    reduction: { terminal: false, continuation: false, replied: false, providerFailure: false, inputBound: false, turnId: "turn" } };
  expect(matchingWakeResponseCheckpoint([checkpoint], "generation", checkpoint.identity, checkpoint.binding, true)).toEqual(checkpoint);
  expect(matchingWakeResponseCheckpoint([checkpoint], "generation", checkpoint.identity, checkpoint.binding, false)).toEqual(checkpoint);
  expect(matchingWakeResponseCheckpoint([checkpoint], "generation", checkpoint.identity, "d".repeat(64), false)).toBeUndefined();
  const partial = { ...checkpoint, nativeTurns: [["original-native-turn", false] as [string, boolean], ["nudge-native-turn", true] as [string, boolean]] };
  expect(matchingWakeResponseCheckpoint([partial], "generation", partial.identity, "d".repeat(64), true)).toEqual(partial);
  expect(matchingWakeResponseCheckpoint([checkpoint], "generation", checkpoint.identity, checkpoint.binding, true, ["native-turn", "late-nudge-turn"]))
    .toBeUndefined();
  expect(matchingWakeResponseCheckpoint([partial], "generation", partial.identity, "e".repeat(64), false)).toBeUndefined();
});

test("a temporary event-ledger read failure retains its validated checkpoint and resumes after restore", async () => {
  const previousState = process.env.LLV_STATE_DIR, previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-checkpoint-recovery-"));
  process.env.LLV_STATE_DIR = root;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "absent.sock");
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  try {
    const fixture = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid)!, null);
    await registry.deliveryWriteOrBusy({ label: "fixture.wake-checkpoint" }, () => registry.agentStateWrite(file => Object.assign(file, fixture)));
    const events = new FileRuntimeEventStore();
    const pageBytes = 12 * 1024 * 1024;
    const prefix = `${JSON.stringify({ kind: "delta", turnId: "earlier", text: "", seq: 1 })}\n`;
    events.append(FIXTURE_SESSION, { kind: "delta", turnId: "earlier", text: "x".repeat(pageBytes - Buffer.byteLength(prefix)), seq: 1 });
    events.append(FIXTURE_SESSION, { kind: "turn-started", turnId: "wake-turn", seq: 2 });
    events.append(FIXTURE_SESSION, { kind: "item", turnId: "wake-turn", phase: "completed",
      deliveryEcho: { operationId: row.operationId, at: row.deliveredAt }, item: { type: "user" }, seq: 3 });
    events.append(FIXTURE_SESSION, { kind: "delta", turnId: "wake-turn", text: "answered", seq: 4 });
    events.append(FIXTURE_SESSION, { kind: "turn-ended", turnId: "wake-turn", status: "completed", seq: 5 });
    const filename = statePath("structured-host-events", `${encodeURIComponent(FIXTURE_SESSION)}.jsonl`);
    const hidden = `${filename}.held`;
    const persisted = { ...row, conversationId: FIXTURE_CONVERSATION, generationId: FIXTURE_SESSION, turnId: "wake-turn" };
    const prepared = await observeSeatWakeResponse(persisted);
    expect(prepared).toMatchObject({ answered: false, scan: [{ generationId: FIXTURE_SESSION,
      position: { offset: 0, skip: 8 * 1024 * 1024 } }] });
    fs.renameSync(filename, hidden);
    const missing = await observeSeatWakeResponse({ ...persisted, scan: prepared.scan });
    expect(missing).toMatchObject({ answered: false, scan: prepared.scan });
    fs.renameSync(hidden, filename);
    expect(await readRuntimeEventPage(FIXTURE_SESSION, missing.scan![0]!.position, () => {}, undefined, path.dirname(filename))).not.toBeNull();
    const resumed = await observeSeatWakeResponse({ ...persisted, scan: missing.scan });
    expect(resumed).toMatchObject({ answered: true, turnId: "wake-turn" });
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy answer beyond the first page releases on its first watchdog tick", async () => {
  const previousState = process.env.LLV_STATE_DIR, previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-legacy-first-tick-"));
  process.env.LLV_STATE_DIR = root;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "absent.sock");
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  try {
    const fixture = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid)!, null);
    await registry.deliveryWriteOrBusy({ label: "fixture.legacy-wake" }, () => registry.agentStateWrite(file => Object.assign(file, fixture)));
    const events = new FileRuntimeEventStore();
    const prefix = `${JSON.stringify({ kind: "delta", turnId: "earlier", text: "", seq: 1 })}\n`;
    events.append(FIXTURE_SESSION, { kind: "delta", turnId: "earlier", text: "x".repeat(5 * 1024 * 1024 - Buffer.byteLength(prefix)), seq: 1 });
    events.append(FIXTURE_SESSION, { kind: "turn-started", turnId: "wake-turn", seq: 2 });
    events.append(FIXTURE_SESSION, { kind: "item", turnId: "wake-turn", phase: "completed",
      deliveryEcho: { operationId: row.operationId, at: row.deliveredAt }, item: { type: "user" }, seq: 3 });
    events.append(FIXTURE_SESSION, { kind: "delta", turnId: "wake-turn", text: "answered", seq: 4 });
    events.append(FIXTURE_SESSION, { kind: "turn-ended", turnId: "wake-turn", status: "completed", seq: 5 });
    const persisted = { ...row, conversationId: FIXTURE_CONVERSATION, generationId: FIXTURE_SESSION, turnId: "wake-turn" };
    expect(await observeSeatWakeResponse(persisted)).toMatchObject({ answered: true, turnId: "wake-turn", generationId: FIXTURE_SESSION });
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("response belongs to the delivered turn; provider failures and unrelated input give no answer", () => {
  const start = { kind: "turn-started", turnId: "operation" };
  const output = { kind: "item", turnId: "operation", accountingAt: "2026-11-01T00:01:00Z", item: { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } } };
  const end = { kind: "turn-ended", turnId: "operation", status: "completed" };
  expect(wakeResponseEvidenceFromEvents(row, [start, output, end])).toMatchObject({ answered: true });
  expect(wakeResponseEvidenceFromEvents(row, [{ ...start, turnId: "other" }, { ...output, turnId: "other" }, { ...end, turnId: "other" }]).answered).toBe(false);
  expect(wakeResponseEvidenceFromEvents(row, [start, { ...output, item: { type: "assistant", isApiErrorMessage: true, error: "rate_limit" } }, { ...end, status: "error" }])).toMatchObject({ answered: false, wait: expect.stringContaining("provider failure") });
  expect(wakeResponseEvidenceFromEvents(row, [start, end]).answered).toBe(false);
});
test("a joined input and a stable recovery nudge retain their own membership", () => {
  const echo = { kind: "item", turnId: "native-turn", deliveryEcho: { operationId: row.operationId }, item: { type: "user" } };
  expect(wakeResponseEvidenceFromEvents(row, [echo, { kind: "delta", turnId: "native-turn", text: "answer" }, { kind: "turn-ended", turnId: "native-turn", status: "completed" }]).answered).toBe(true);
  const recovering = { ...row, action: "nudged" as const };
  const key = wakeResponseRecoveryKey(recovering);
  expect(key).toBe(wakeResponseRecoveryKey({ ...row, action: "nudging" }));
  expect(wakeResponseEvidenceFromEvents(recovering, [{ kind: "turn-started", turnId: key }, { kind: "delta", turnId: key, text: "answer" }, { kind: "turn-ended", turnId: key, status: "completed" }], [key]).answered).toBe(true);
});

test.each(["wake", "nudge"] as const)("joined %s output before its delivery echo cannot settle the response", action => {
  const recovering = action === "nudge" ? { ...row, action: "nudged" as const } : row;
  const operationId = action === "nudge" ? wakeResponseRecoveryKey(recovering) : row.operationId;
  const events = [
    { kind: "turn-started", turnId: "joined-native-turn" },
    { kind: "delta", turnId: "joined-native-turn", text: "earlier turn response" },
    { kind: "item", turnId: "joined-native-turn", phase: "completed", item: { type: "reasoning", text: "x".repeat(200_000) } },
    { kind: "item", turnId: "joined-native-turn", deliveryEcho: { operationId }, item: { type: "user" } },
    { kind: "turn-ended", turnId: "joined-native-turn", status: "completed" },
  ];
  const continuations = action === "nudge" ? [operationId] : [];
  const nudgeRecoveryOps = action === "nudge" ? [operationId] : [];
  expect(wakeResponseEvidenceFromEvents(recovering, events, continuations, "joined-native-turn", action === "nudge", nudgeRecoveryOps))
    .toMatchObject({ answered: false });
  events.splice(4, 0, { kind: "delta", turnId: "joined-native-turn", text: "answer after joined input" });
  expect(wakeResponseEvidenceFromEvents(recovering, events, continuations, "joined-native-turn", action === "nudge", nudgeRecoveryOps))
    .toMatchObject({ answered: true });
});


test("a successful same-request continuation answers an earlier provider error", () => {
  const events = [
    { kind: "turn-started", turnId: row.operationId },
    { kind: "item", turnId: row.operationId, item: { type: "assistant", error: "rate_limit", isApiErrorMessage: true } },
    { kind: "turn-ended", turnId: row.operationId, status: "error" },
    { kind: "turn-started", turnId: "quota-continuation" },
    { kind: "delta", turnId: "quota-continuation", text: "request completed" },
    { kind: "turn-ended", turnId: "quota-continuation", status: "completed" },
  ];
  expect(wakeResponseEvidenceFromEvents(row, events, ["quota-continuation"]).answered).toBe(true);
  expect(wakeResponseEvidenceFromEvents(row, events).answered).toBe(false);
});


test("batched membership and retained native receipts survive a truncated input tail", () => {
  const echo = { kind: "item", turnId: "batch-turn", deliveryEcho: { operationId: "batch", memberOperationIds: [row.operationId] }, item: { type: "user" } };
  const reply = [{ kind: "delta", turnId: "batch-turn", text: "answer" }, { kind: "turn-ended", turnId: "batch-turn", status: "completed" }];
  expect(wakeResponseEvidenceFromEvents(row, [echo, ...reply])).toMatchObject({ answered: true, turnId: "batch-turn" });
  expect(wakeResponseEvidenceFromEvents(row, reply, [], "batch-turn")).toMatchObject({ answered: true, turnId: "batch-turn" });
  expect(wakeResponseEvidenceFromEvents(row, reply).answered).toBe(false);
});


test("a frozen recovery payload round trips without changing its retry identity", () => {
  const recovering = { ...row, action: "nudging" as const, recovery: { text: "continue the existing request", origin: { kind: "agent" as const, role: "seat-tick", project: "fixture" } } };
  const restored = normalizeSeatWakeResponse(JSON.parse(JSON.stringify(recovering)))!;
  expect(restored).toEqual(recovering);
  expect(wakeResponseRecoveryKey(restored)).toBe(wakeResponseRecoveryKey(row));
});


test("a failed tool followed by a valid model answer still settles the delivered wake", () => {
  expect(wakeResponseEvidenceFromEvents(row, [
    { kind: "turn-started", turnId: row.operationId },
    { kind: "item", turnId: row.operationId, phase: "completed", item: { type: "mcpToolCall", id: "tool", error: { message: "fixture tool refused" } } },
    { kind: "item", turnId: row.operationId, phase: "completed", item: { type: "agentMessage", text: "The tool failed; the request is answered." } },
    { kind: "turn-ended", turnId: row.operationId, status: "completed" },
  ]).answered).toBe(true);
});


test.each(["current", "successor", "other-author", "closed", "failed-current", "failed-successor", "unanswered-current", "unanswered-successor", "unbound-original", "unbound-tail"])("real delivery admission binds recovery identity and author: %s", async mode => {
  const successor = mode.endsWith("successor");
  const failed = mode.startsWith("failed-") || mode.startsWith("unanswered-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-response-admission-"));
  const priorState = process.env.LLV_STATE_DIR, priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "absent.sock");
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  let closed = false;
  try {
    const fixture = fixtureRegistry(root, "claude", captureProcessIdentity(process.pid)!, null);
    let generation = FIXTURE_SESSION;
    if (successor) {
      generation = FIXTURE_SESSION.slice(0, -1) + "c";
      const previous = fixture.entries[`claude:${FIXTURE_SESSION}`]!;
      fixture.entries[`claude:${generation}`] = { ...previous, key: { engine: "claude", sessionId: generation }, artifactPath: path.join(root, "successor.jsonl") };
      const conversation = fixture.conversations[FIXTURE_CONVERSATION]!;
      conversation.generations.push({ ...conversation.generations[0]!, id: generation, path: path.join(root, "successor.jsonl") });
    }
    await registry.deliveryWriteOrBusy({ label: "fixture.response-admission" }, () => registry.agentStateWrite(file => Object.assign(file, fixture)));
    const recovering: SeatWakeResponse = { ...row, conversationId: FIXTURE_CONVERSATION, generationId: FIXTURE_SESSION,
      turnId: "original-native-turn", action: "nudging", recovery: { text: "continue the retained request", origin: { kind: "agent", role: "seat-tick", project: "fixture" } } };
    const key = wakeResponseRecoveryKey(recovering);
    const admitted = registry.holdDelivery(FIXTURE_CONVERSATION, recovering.recovery!.text, key, "text", [], null,
      { operationId: "allocated-recovery-operation", origin: mode === "other-author" ? { ...recovering.recovery!.origin, role: "worker" } : recovering.recovery!.origin, policy: "queue" });
    registry.recordDeliveryOutcome(admitted.id, "delivered");
    expect(admitted.command.operationId).not.toBe(key);
    const events = new FileRuntimeEventStore();
    if (mode.startsWith("unbound-")) {
      const original = registry.holdDelivery(FIXTURE_CONVERSATION, "original wake", row.clientMessageId, "text", [], null,
        { operationId: "allocated-original-operation", policy: "queue" });
      registry.recordDeliveryOutcome(original.id, "delivered");
      expect(original.command.operationId).not.toBe(row.operationId);
      if (mode === "unbound-original") events.append(FIXTURE_SESSION,
        { kind: "turn-started", turnId: original.command.operationId, seq: 1 });
      events.append(FIXTURE_SESSION, { kind: "turn-ended", turnId: original.command.operationId, status: "error", seq: 2 });
      const evidence = await observeSeatWakeResponse({ ...recovering, action: "nudged", turnId: original.command.operationId });
      expect(evidence).toMatchObject({ answered: false, terminal: false });
      return;
    }
    if (failed) {
      events.append(FIXTURE_SESSION, { kind: "turn-started", turnId: "original-native-turn", seq: 1 });
      if (mode.startsWith("failed-")) events.append(FIXTURE_SESSION, { kind: "delta", turnId: "original-native-turn", text: "request completed during recovery admission", seq: 2 });
      else events.append(FIXTURE_SESSION, { kind: "item", turnId: "original-native-turn", phase: "completed", item: { type: "reasoning", text: "still working" }, seq: 2 });
      events.append(FIXTURE_SESSION, { kind: "turn-ended", turnId: "original-native-turn", status: "completed", seq: 3 });
    }
    const recoverySeq = failed && !successor ? 4 : 1;
    events.append(generation, { kind: "turn-started", turnId: admitted.command.operationId, seq: recoverySeq });
    if (failed) events.append(generation, { kind: "item", turnId: admitted.command.operationId, phase: "completed",
      item: { type: "assistant", error: "provider_error", isApiErrorMessage: true }, seq: recoverySeq + 1 });
    else events.append(generation, { kind: "delta", turnId: admitted.command.operationId, text: "request completed", seq: recoverySeq + 1 });
    events.append(generation, { kind: "turn-ended", turnId: admitted.command.operationId, status: failed ? "error" : "completed", seq: recoverySeq + 2 });
    if (mode === "closed") { registry.close(); closed = true; }
    const evidence = await observeSeatWakeResponse(recovering);
    if (mode === "closed") expect(evidence).toEqual({ answered: false, wait: "response ownership evidence unavailable" });
    else if (mode === "other-author") {
      expect(evidence.answered).toBe(false); expect(evidence.turnId).not.toBe(admitted.command.operationId);
    } else if (failed) {
      expect(evidence.answered).toBe(mode.startsWith("failed-"));
      expect(evidence.providerFailure).toBe(mode.startsWith("failed-") ? undefined : true);
      if (mode.startsWith("unanswered-")) expect(await observeSeatWakeResponse({ ...recovering, action: "nudged" }))
        .toMatchObject({ answered: false, terminal: true, turnId: admitted.command.operationId });
    } else expect(evidence).toMatchObject({ answered: true, generationId: generation, turnId: admitted.command.operationId });
  } finally {
    setAgentRegistryForTests(null); if (!closed) registry.close();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
    if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test.each(["reasoning", "mcpToolCall"])("a completed %s item refreshes progress without answering the wake", type => {
  const evidence = wakeResponseEvidenceFromEvents(row, [
    { kind: "turn-started", turnId: row.operationId },
    { kind: "item", turnId: row.operationId, accountingAt: "2026-11-01T00:01:00Z", item: { type, id: "activity", ...(type === "reasoning" ? { summary: [{ type: "summary_text", text: "A meaningful thought" }] } : {}) } },
    { kind: "turn-ended", turnId: row.operationId, status: "completed" },
  ]);
  expect(evidence).toMatchObject({ answered: false, progressAt: "2026-11-01T00:01:00Z" });
});


test("a real answer after an in-turn provider retry settles the response", () => {
  expect(wakeResponseEvidenceFromEvents(row, [
    { kind: "turn-started", turnId: row.operationId },
    { kind: "item", turnId: row.operationId, item: { type: "assistant", error: "retryable", isApiErrorMessage: true } },
    { kind: "item", turnId: row.operationId, item: { type: "agentMessage", text: "request completed after retry" } },
    { kind: "turn-ended", turnId: row.operationId, status: "completed" },
  ]).answered).toBe(true);
});


test("terminal recovery requires the nudge's own membership and end boundary", () => {
  const nudged = { ...row, action: "nudged" as const };
  const key = wakeResponseRecoveryKey(nudged);
  const original = [{ kind: "turn-started", turnId: row.operationId }, { kind: "turn-ended", turnId: row.operationId, status: "error" }];
  expect(wakeResponseEvidenceFromEvents(nudged, original, [key]).terminal).toBe(false);
  const nudge = [...original, { kind: "turn-started", turnId: key }, { kind: "turn-ended", turnId: key, status: "error" }];
  expect(wakeResponseEvidenceFromEvents(nudged, nudge, [key]).terminal).toBe(true);
  expect(wakeResponseEvidenceFromEvents(nudged, [...nudge, { kind: "turn-started", turnId: key }], [key]).terminal).toBe(false);
  expect(wakeResponseEvidenceFromEvents(nudged, [...original.slice(0, 1),
    { kind: "item", turnId: row.operationId, deliveryEcho: { operationId: key } }, original[1]!], [key]).terminal).toBe(true);
  // Compacted native membership is proof only for the bound continuation.
  const tail = [{ kind: "turn-ended", turnId: "native-nudge", status: "error" }];
  expect(wakeResponseEvidenceFromEvents(nudged, tail, [key], "native-nudge", true).terminal).toBe(true);
  expect(wakeResponseEvidenceFromEvents(nudged, tail, [key], "native-nudge").terminal).toBe(false);
});
