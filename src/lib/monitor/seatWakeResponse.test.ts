import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { fixtureRegistry, FIXTURE_SESSION, FIXTURE_CONVERSATION } from "@/lib/agentState/testFixture";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { FileRuntimeEventStore } from "@/lib/runtime/eventStore";
import { normalizeSeatWakeResponse, observeSeatWakeResponse, seatWakeResponseBound, wakeResponseEvidenceFromEvents, wakeResponseRecoveryKey, type SeatWakeResponse } from "./seatWakeResponse";
const row: SeatWakeResponse = { clientMessageId: "wake", operationId: "operation", conversationId: "conversation_fixture", seatEpoch: 7,
  deliveredAt: "2026-11-01T00:00:00Z", progressAt: "2026-11-01T00:00:00Z", boundMs: 900_000, action: "pending" };

test.each([[300_000, 1_800_000, 900_000], [300_000, 60_000, 600_000], [600_000, 3_600_000, 1_200_000]])("response bound freezes cadence %i and wake %i at %i", (check, wake, bound) => {
  expect(seatWakeResponseBound(check, wake)).toBe(bound);
});
test.each(["pending", "nudging", "nudged"] as const)("writer output for %s round trips through the persisted reader", action => {
  expect(normalizeSeatWakeResponse(JSON.parse(JSON.stringify({ ...row, action })))).toEqual({ ...row, action });
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


test.each(["current", "successor", "other-author", "closed"])("real delivery admission binds recovery identity and author: %s", async mode => {
  const successor = mode === "successor";
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
    events.append(generation, { kind: "turn-started", turnId: admitted.command.operationId, seq: 1 });
    events.append(generation, { kind: "delta", turnId: admitted.command.operationId, text: "request completed", seq: 2 });
    events.append(generation, { kind: "turn-ended", turnId: admitted.command.operationId, status: "completed", seq: 3 });
    if (mode === "closed") { registry.close(); closed = true; }
    const evidence = await observeSeatWakeResponse(recovering);
    if (mode === "closed") expect(evidence).toEqual({ answered: false, wait: "response ownership evidence unavailable" });
    else if (mode === "other-author") {
      expect(evidence.answered).toBe(false); expect(evidence.turnId).not.toBe(admitted.command.operationId);
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
    { kind: "item", turnId: row.operationId, accountingAt: "2026-11-01T00:01:00Z", item: { type, id: "activity" } },
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
