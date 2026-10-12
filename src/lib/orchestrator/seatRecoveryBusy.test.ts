import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { executeOrchestratorRotation, executeOrchestratorSeatRequest, type SeatCommandDependencies } from "./seatCommand";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "./seats";

let sandbox = "";
let previousState: string | undefined;
beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-sqlite-retry-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const AT = "2026-10-11T17:11:00.000Z";
const conversationId = () => `conversation_${randomUUID()}`;
function dependencies(spawn: SeatCommandDependencies["spawn"], waitMs?: number): SeatCommandDependencies {
  return {
    spawn, deliver: async () => ({ ok: true, outcome: "delivered" }), conversationTarget: () => null,
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }), stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: "claude", model: "opus" }), resolvedConversation: () => null,
    seatStoreWaitMs: waitMs, now: () => AT,
  };
}
const request = { project: "atlas", mandate: "Run the board.", clientRequestId: "sqlite_designation", engine: "claude", model: "opus", cwd: "/tmp" };

for (const returned of [true, false]) test(`SQLite busy ${returned ? "response" : "throw"} then success preserves one pending intent`, async () => {
  const keys: unknown[] = [];
  const id = conversationId();
  const deps = dependencies(async body => {
    keys.push(body.clientAttemptId);
    expect(orchestratorSeatFor("atlas").history).toEqual([]);
    if (keys.length === 1) {
      if (returned) return { status: 500, body: { error: "database is locked", code: "SQLITE_BUSY" } };
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return { status: 200, body: { ok: true, conversationId: id, path: null } };
  });
  const result = await executeOrchestratorSeatRequest(request, deps);
  expect(result.status).toBe(200);
  expect(keys).toEqual([request.clientRequestId, request.clientRequestId]);
  expect(orchestratorSeatFor("atlas")).toMatchObject({ active: { conversationId: id }, pending: null, history: [] });
});

test("SQLite busy beyond the replay budget terminalizes with the original error text", async () => {
  let calls = 0;
  const result = await executeOrchestratorSeatRequest(request, dependencies(async () => {
    calls += 1;
    return { status: 500, body: { error: "database is locked" } };
  }));
  expect(calls).toBe(4);
  expect(result.body.error).toBe("database is locked");
  expect(orchestratorSeatFor("atlas")).toMatchObject({ pending: null, history: [{ seat: { intent: { error: "database is locked" } } }] });
});

test("SQLite busy at the time budget terminalizes without another spawn", async () => {
  let calls = 0;
  await executeOrchestratorSeatRequest(request, dependencies(async () => {
    calls += 1;
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  }, 0));
  expect(calls).toBe(1);
  expect(orchestratorSeatFor("atlas").history.at(-1)?.seat.intent.error).toBe("database is locked");
});

test("automatic host recovery retries SQLite busy before replacing its incumbent", async () => {
  const incumbent = conversationId();
  beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "seed_designation", mode: "existing", engine: "claude", model: "opus", now: AT });
  const activated = completeOrchestratorSeatIntent({ project: "atlas", clientRequestId: "seed_designation", conversationId: incumbent, path: null, now: AT });
  if (activated.kind !== "activated") throw new Error("fixture seat did not activate");
  const active = activated.seat;
  const successor = conversationId();
  let calls = 0;
  const result = await executeOrchestratorRotation({ project: "atlas", clientRequestId: "seat-host-recovery-retry", expectedIncumbentSeatEpoch: active.seatEpoch, cwd: "/tmp" }, dependencies(async () => {
    calls += 1;
    return calls === 1 ? { status: 500, body: { error: "database is locked" } }
      : { status: 200, body: { ok: true, conversationId: successor, path: null } };
  }), null, { autonomous: true, automaticReplacement: { conversationId: incumbent, seatEpoch: active.seatEpoch }, replacementHold: () => null });
  expect(result.status).toBe(200);
  expect(calls).toBe(2);
  expect(orchestratorSeatFor("atlas")).toMatchObject({ active: { conversationId: successor }, pending: null, history: [] });
});

test("other spawn errors retain immediate terminal behavior", async () => {
  let calls = 0;
  await executeOrchestratorSeatRequest(request, dependencies(async () => {
    calls += 1;
    return { status: 500, body: { error: "spawn transport failed" } };
  }));
  expect(calls).toBe(1);
  expect(orchestratorSeatFor("atlas").history.at(-1)?.seat.intent.error).toBe("spawn transport failed");
});


for (const automatic of [false, true]) test(`a failed receipt after SQLite busy stays pending through ${automatic ? "automatic recovery" : "designation"} replay`, async () => {
  let failedReceipt = false;
  let calls = 0;
  const id = conversationId();
  const deps = dependencies(async () => {
    calls += 1;
    if (calls === 1) {
      failedReceipt = true;
      return { status: 500, body: { error: "database is locked" } };
    }
    expect(orchestratorSeatFor("atlas").history).toEqual([]);
    return { status: 200, body: { ok: true, conversationId: id, path: null } };
  });
  deps.launchSettlement = ({ clientRequestId }) => failedReceipt && clientRequestId === request.clientRequestId
    ? { kind: "failed", error: "spawn failed before pane binding" } : { kind: "unknown" };
  let result;
  if (automatic) {
    const incumbent = conversationId();
    beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "seed_designation", mode: "existing", engine: "claude", model: "opus", now: AT });
    const activated = completeOrchestratorSeatIntent({ project: "atlas", clientRequestId: "seed_designation", conversationId: incumbent, path: null, now: AT });
    if (activated.kind !== "activated") throw new Error("fixture seat did not activate");
    result = await executeOrchestratorRotation({ project: "atlas", clientRequestId: request.clientRequestId, cwd: "/tmp", expectedIncumbentSeatEpoch: activated.seat.seatEpoch }, deps, null,
      { autonomous: true, automaticReplacement: { conversationId: incumbent, seatEpoch: activated.seat.seatEpoch }, replacementHold: () => null });
  } else result = await executeOrchestratorSeatRequest(request, deps);
  expect(result.status).toBe(200);
  expect(calls).toBe(2);
  expect(orchestratorSeatFor("atlas").history).toEqual([]);
});
