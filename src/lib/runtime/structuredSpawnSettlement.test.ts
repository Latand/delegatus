import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { reconcileStructuredSpawnReplay, recoverPendingStructuredSpawns, terminalizeStaleStructuredSpawns } from "./structuredSpawn";

const now = Date.parse("2026-10-20T04:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
});

function fixture(disposition: "lost" | "unverified", live = false) {
  setSystemTime(now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-settlement-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const runtimeFile = path.join(root, "runtime.sqlite");
  let journal = new RuntimeJournal(runtimeFile, { structuredHosts: true, now: () => now });
  cleanups.push(() => journal.close());
  let commands = 0;
  const client = {
    readSession: async identity => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    operationStatus: async (id, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    transitionOperation: async (id, status, details, options) => journal.transitionOperation(id, status, details, options),
    command: async command => { commands++; return journal.executeOperation(command); },
  } as RuntimeHostClient;
  const ids = spyOn(crypto, "randomUUID");
  let sequence = 0;
  ids.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const request = { engine: "codex" as const, cwd: root, transport: "structured" as const,
    clientAttemptId: "original-launch-request", requestDigest: "original-launch-digest" };
  const begun = beginLegacySpawnFixture(registry, request);
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const receipt = begun.receipt;
  const key = { engine: "codex" as const, sessionId: "spawn-settlement-session" };
  const artifactPath = path.join(root, "session.jsonl");
  registry.stageStructuredSpawn(receipt.launchId, {
    key, artifactPath, cwd: root, accountId: "default", launchProfile: emptyLaunchProfile({ cwd: root }),
    status: live ? "live" : "unhosted", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: live ? "stdio:live" : "stdio:released",
      process: null, eventCursor: 1, protocolVersion: null, writerClaimEpoch: 1,
      activeTurnRef: live ? "original-turn" : null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: live ? "original-writer" : null, pendingAction: "spawn",
  });
  const delivery = registry.holdDelivery(receipt.conversationId, "initial prompt", `spawn_${receipt.launchId}`,
    "text", [], null, { operationId: `spawn_message_${receipt.launchId}` });
  ids.mockRestore();
  return { registry, client, receipt, request, key, artifactPath, root, delivery,
    commands: () => commands,
    journal: () => journal,
    async admitAndFail() {
      await client.command({ kind: "spawn", operationId: receipt.launchId, idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId, engine: "codex", cwd: root, prompt: "initial prompt" });
      journal.append({ scope: { type: "session", id: receipt.conversationId }, kind: "session-status", payload: {
        conversationId: receipt.conversationId, sessionKey: key, artifactPath, cwd: root,
        hostKind: "codex-app-server", host: live ? "hosted" : "unhosted", turn: live ? "running" : "unknown",
        activeTurnId: live ? "original-turn" : null, provenance: "structured",
      } });
      // The production producer fails the launch in the delivery transaction;
      // there is no corresponding runtime spawn transition in that write.
      registry.recordDeliveryOutcome(delivery.id, "failed", "first prompt settlement", disposition);
      expect(registry.spawnRecoverySnapshot([receipt.launchId]).receipts[receipt.launchId]?.state).toBe("failed");
      expect(journal.operationResult(receipt.launchId)?.receipt.status).toBe("queued");
    },
    restart() {
      journal.close();
      journal = new RuntimeJournal(runtimeFile, { structuredHosts: true, now: () => now });
      return new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    },
  };
}

test.each(["startup", "periodic"] as const)("%s reconciles a failed launch after its placeholder became unhosted", async pass => {
  const f = fixture("lost");
  await f.admitAndFail();
  const registry = f.restart();
  const run = () => pass === "startup" ? recoverPendingStructuredSpawns(registry, f.client)
    : terminalizeStaleStructuredSpawns(registry, f.client, { now: () => now });
  await run();
  const settled = f.journal().operationResult(f.receipt.launchId)!.receipt;
  expect(settled).toMatchObject({ status: "failed", operationId: f.receipt.launchId, idempotencyKey: f.receipt.launchId });
  await run();
  expect(f.journal().operationResult(f.receipt.launchId)!.receipt).toEqual(settled);
  const replay = beginLegacySpawnFixture(registry, f.request);
  expect(replay.kind).toBe("replay");
  expect(replay.receipt).toMatchObject({ launchId: f.receipt.launchId, clientAttemptId: f.request.clientAttemptId });
  expect(f.commands()).toBe(1);
  expect(f.journal().effectBatch(100, ["runtime.spawn"])).toEqual([]);
});

test.each(["unhosted", "hosted"] as const)("uncertain initial delivery retains uncertainty and its %s writer", async host => {
  const live = host === "hosted";
  const f = fixture("unverified", live);
  await f.admitAndFail();
  const before = f.journal().readSession({ conversationId: f.receipt.conversationId });
  if (!before) throw new Error("fixture session is unavailable");
  const entry = f.registry.spawnRecoverySnapshot([f.receipt.launchId]).entries[`codex:${f.key.sessionId}`];
  await recoverPendingStructuredSpawns(f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
  const after = f.journal().readSession({ conversationId: f.receipt.conversationId })!;
  expect(after).toEqual({ ...before, recentReceipts: after.recentReceipts });
  expect(f.registry.spawnRecoverySnapshot([f.receipt.launchId]).entries[`codex:${f.key.sessionId}`]).toEqual(entry);
  expect(f.commands()).toBe(1);
});

test.each(["replay", "startup", "periodic"] as const)("uncertain settlement preserves a live registering writer through %s reconciliation", async pass => {
  const f = fixture("unverified", true);
  await f.admitAndFail();
  f.journal().append({ scope: { type: "session", id: f.receipt.conversationId }, kind: "session-status", payload: {
    conversationId: f.receipt.conversationId, sessionKey: f.key, artifactPath: f.artifactPath, cwd: f.root,
    hostKind: "codex-app-server", host: "registering", turn: "unknown", activeTurnId: null, provenance: "structured",
  } });
  const before = f.journal().readSession({ conversationId: f.receipt.conversationId })!;
  const beforeEntry = f.registry.spawnRecoverySnapshot([f.receipt.launchId]).entries[`codex:${f.key.sessionId}`]!;
  const run = pass === "replay" ? () => reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client)
    : pass === "startup" ? () => recoverPendingStructuredSpawns(f.registry, f.client)
      : () => terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now });
  await run();
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
  expect(f.journal().readSession({ conversationId: f.receipt.conversationId }))
    .toMatchObject({ host: "registering", turn: "unknown", sessionKey: before.sessionKey });
  expect(f.registry.spawnRecoverySnapshot([f.receipt.launchId]).entries[`codex:${f.key.sessionId}`]).toEqual(beforeEntry);
  expect(f.commands()).toBe(1);
});

test("a live writer keeps a lost first prompt from becoming a failed agent", async () => {
  const f = fixture("lost", true);
  await f.admitAndFail();
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
  expect(f.journal().readSession({ conversationId: f.receipt.conversationId }))
    .toMatchObject({ host: "hosted", turn: "running", activeTurnId: "original-turn" });
});

test("a refused terminal write stays owed and the next process can settle it", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const transition = f.client.transitionOperation;
  f.client.transitionOperation = async () => { throw new Error("journal temporarily unavailable"); };
  // Reporting must not consume the repair obligation after a failed write.
  const report = spyOn(f.registry, "reportFailedLaunch");
  await terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now });
  expect(report).not.toHaveBeenCalled();
  report.mockRestore();
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("queued");
  expect(f.registry.failedSpawnReceipts().map(row => row.launchId)).toContain(f.receipt.launchId);
  f.client.transitionOperation = transition;
  const child = Bun.spawn([process.execPath, "-e", `
    import { AgentRegistry } from "./src/lib/agent/registry";
    import { RuntimeJournal } from "./src/runtime-host/journal";
    import { terminalizeStaleStructuredSpawns } from "./src/lib/runtime/structuredSpawn";
    const registry = new AgentRegistry(process.env.SETTLEMENT_REGISTRY, undefined, undefined, { sqliteMode: "sqlite" });
    const journal = new RuntimeJournal(process.env.SETTLEMENT_JOURNAL, { structuredHosts: true });
    const client = {
      readSession: async identity => journal.readSession(identity),
      snapshot: async () => journal.snapshot(),
      effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
      operationStatus: async id => journal.operationResult(id),
      transitionOperation: async (...args) => journal.transitionOperation(...args),
    };
    try { await terminalizeStaleStructuredSpawns(registry, client); }
    finally { journal.close(); }
  `], {
    env: { ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      SETTLEMENT_REGISTRY: f.registry.filename, SETTLEMENT_JOURNAL: path.join(f.root, "runtime.sqlite") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
  expect(f.commands()).toBe(1);
}, 30_000);

test("a committed terminal write with a lost acknowledgement settles once", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const transition = f.client.transitionOperation;
  let transitions = 0;
  f.client.transitionOperation = async (...args) => {
    transitions++;
    await transition(...args);
    throw new Error("acknowledgement lost");
  };
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(transitions).toBe(1);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
  expect(f.commands()).toBe(1);
});

test("an unavailable session read remains uncertain", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  f.client.readSession = async () => { throw new Error("session evidence unavailable"); };
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
});

test("an unavailable operation read retains the durable repair obligation", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const read = f.client.operationStatus;
  f.client.operationStatus = async () => { throw new Error("operation evidence unavailable"); };
  await terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now });
  expect(f.registry.failedSpawnReceipts().map(row => row.launchId)).toContain(f.receipt.launchId);
  f.client.operationStatus = read;
  await terminalizeStaleStructuredSpawns(f.restart(), f.client, { now: () => now });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
});

test("a delivering first-prompt retry keeps a failed launch uncertain", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const messageId = `spawn_message_${f.receipt.launchId}`;
  const read = f.client.operationStatus;
  f.client.operationStatus = async (id, options) => {
    if (id !== messageId) return read(id, options);
    const operation = await read(f.receipt.launchId);
    if (!operation) return null;
    return { ...operation, receipt: { ...operation.receipt, operationId: messageId, kind: "send", status: "delivering" } };
  };
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
  expect((await f.client.operationStatus(messageId))?.receipt.status).toBe("delivering");
  expect(f.commands()).toBe(1);
});

test("an unavailable first-prompt operation read keeps a failed launch uncertain", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const read = f.client.operationStatus;
  f.client.operationStatus = async (id, options) => {
    if (id === `spawn_message_${f.receipt.launchId}`) throw new Error("first-prompt evidence unavailable");
    return read(id, options);
  };
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("uncertain");
  expect(f.commands()).toBe(1);
});

test("periodic reconciliation finds a queued spawn after failure reporting was already handled", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  f.registry.reportFailedLaunch(f.registry.spawnRecoverySnapshot([f.receipt.launchId]).receipts[f.receipt.launchId]!);
  expect(f.registry.failedSpawnReceipts()).toEqual([]);
  await terminalizeStaleStructuredSpawns(f.restart(), f.client, { now: () => now });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
  expect(f.commands()).toBe(1);
});

test("the periodic cursor reaches a failed launch beyond one active outbox page", async () => {
  const f = fixture("lost");
  for (let index = 0; index < 101; index++) {
    f.journal().executeOperation({ kind: "spawn", operationId: `other-launch-${index}`,
      idempotencyKey: `other-launch-${index}`, conversationId: `other-conversation-${index}`,
      engine: "codex", cwd: f.root, prompt: "unrelated active admission" });
  }
  await f.admitAndFail();
  f.registry.reportFailedLaunch(f.registry.spawnRecoverySnapshot([f.receipt.launchId]).receipts[f.receipt.launchId]!);
  expect(f.registry.failedSpawnReceipts()).toEqual([]);
  const read = spyOn(f.client, "effectBatch");
  await terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now, actuationCap: 1 });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("queued");
  await terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now, actuationCap: 1 });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]?.[1]).toBe(0);
  expect(read.mock.calls[1]?.[1]).toBeGreaterThan(0);
  read.mockRestore();
  expect(f.commands()).toBe(1);
});

test("periodic failed-launch repair reads only the launch retry lineage as history grows", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  f.registry.reportFailedLaunch(f.registry.spawnRecoverySnapshot([f.receipt.launchId]).receipts[f.receipt.launchId]!);
  const db = (f.journal() as unknown as { db: Database }).db;
  db.exec("BEGIN");
  const insert = db.query(`INSERT INTO operations
    (operation_id, conversation_id, idempotency_key, request_hash, request_json, receipt_json, event_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < 25_000; index++) {
    const id = `unrelated-terminal-${String(index).padStart(5, "0")}`;
    insert.run(id, `conversation-${id}`, id, "hash", "{}",
      JSON.stringify({ operationId: id, conversationId: `conversation-${id}`, kind: "spawn", status: "failed" }), index + 10);
  }
  db.exec("COMMIT");

  const plan = db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN
    SELECT operation_id, receipt_json FROM operations
    WHERE json_extract(receipt_json, '$.retryOfOperationId') = ?
    ORDER BY event_seq DESC LIMIT 1`).all(f.receipt.launchId).map(row => row.detail).join("\n");
  expect(plan).toContain("operations_retry_parent");
  const retryLeafRead = spyOn(f.journal(), "currentRetryResult");

  await terminalizeStaleStructuredSpawns(f.registry, f.client, { now: () => now });

  expect(retryLeafRead).toHaveBeenCalledTimes(2);
  expect(retryLeafRead.mock.calls.map(call => call[0]).sort()).toEqual([
    `spawn_message_${f.receipt.launchId}`, f.receipt.launchId,
  ].sort());
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("failed");
  expect(f.commands()).toBe(1);
});

test("late transcript evidence recovers the launch and closes its original operation as delivered", async () => {
  const f = fixture("lost", true);
  await f.admitAndFail();
  fs.writeFileSync(f.artifactPath, JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "initial prompt" }],
  } }) + "\n");
  const recovered = await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(recovered.state).toBe("completed");
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("delivered");
  expect(f.journal().readSession({ conversationId: f.receipt.conversationId })?.host).toBe("hosted");
  expect(f.commands()).toBe(1);
});

test("a failed journal write after late transcript recovery is repaired on the next pass", async () => {
  const f = fixture("lost", true);
  await f.admitAndFail();
  fs.writeFileSync(f.artifactPath, JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "initial prompt" }],
  } }) + "\n");
  const transition = f.client.transitionOperation;
  f.client.transitionOperation = async () => { throw new Error("terminal journal write unavailable"); };
  await expect(reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client))
    .rejects.toThrow("terminal journal write unavailable");
  expect(f.registry.spawnReceipt(f.receipt.launchId)?.state).toBe("completed");
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("queued");
  f.client.transitionOperation = transition;
  await terminalizeStaleStructuredSpawns(f.restart(), f.client, { now: () => now });
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("delivered");
  expect(f.commands()).toBe(1);
});

test("release authority lost during a read prevents terminal dispatch", async () => {
  const f = fixture("lost");
  await f.admitAndFail();
  const read = f.client.operationStatus;
  let active = true;
  f.client.operationStatus = async (...args) => {
    const result = await read(...args);
    active = false;
    return result;
  };
  await expect(reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client, {
    assertActive: () => { if (!active) throw new Error("release retired"); },
  })).rejects.toThrow("release retired");
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("queued");
});

test("a terminal success that lands during reconciliation wins", async () => {
  const f = fixture("lost", true);
  await f.admitAndFail();
  const read = f.client.operationStatus;
  f.client.operationStatus = async (...args) => {
    const observed = await read(...args);
    if (args[0] === f.receipt.launchId) f.journal().transitionOperation(f.receipt.launchId, "delivered");
    return observed;
  };
  await reconcileStructuredSpawnReplay(f.receipt.launchId, f.registry, f.client);
  expect(f.journal().operationResult(f.receipt.launchId)?.receipt.status).toBe("delivered");
  expect(f.journal().readSession({ conversationId: f.receipt.conversationId })?.host).toBe("hosted");
  expect(f.commands()).toBe(1);
});
