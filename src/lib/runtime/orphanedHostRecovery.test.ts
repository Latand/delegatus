import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { loadTasks } from "@/lib/tasks/store";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";

import { recordedScopeProcess } from "./agentScope";
import type { RuntimeHostClient } from "./client";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { ORPHANED_HOST_STOP_REFUSED_HOLD_MS } from "./orphanedHost";
import { surfaceOrphanedHosts } from "./orphanedHostAlarm";
import { startupRowRetries } from "./startupRowRetries";
import { StructuredDeliveryQueue, type StructuredDeliveryEffect } from "./structuredDeliveryQueue";
import { terminateStructuredHostTree } from "./structuredHostControl";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

/* Hosts that outlived the Viewer owning them across a release: the recorded
   owner process is gone while the engine still runs. Every process here is a
   child this test started, and only those are stopped. Tasks and the other
   state files live in this suite's own sandbox. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orphan-recovery-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });

const child = () => ownFixtureTree(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
async function ended(): Promise<ProcessIdentity> {
  const process = child();
  const identity = captureProcessIdentity(process.pid!);
  await stopFixtureTree(process);
  return identity;
}

function orphanRow(name: string, engine: ProcessIdentity, owner: ProcessIdentity, pendingAction: AgentRegistryEntry["pendingAction"] = null) {
  const directory = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const sessionId = crypto.randomUUID();
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const conversation = registry.ensureConversation("claude", artifactPath, "default");
  const key = { engine: "claude" as const, sessionId };
  registry.upsert({
    key, artifactPath, cwd: directory, accountId: "default", launchProfile: emptyLaunchProfile({ cwd: directory }),
    status: "idle", host: null, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(owner)}`, pendingAction,
    structuredHost: { kind: "claude-broker", endpoint: "stdio:orphaned", process: engine, eventCursor: 5, protocolVersion: "fixture",
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  });
  let spawns = 0;
  const recover = (request: { operationId?: string; admittedAt?: string }) => recoverDeadStructuredConversation({
    path: artifactPath, conversationId: conversation.id, ...request,
  }, {
    registry, client: {} as RuntimeHostClient, transportAvailable: () => true, park: () => null,
    orphanStop: { graceMs: 200, deadlineMs: 3_000 },
    resolveAccount: () => ({ engine: "claude", accountId: "default", kind: "legacy", home: directory, transcriptRoot: directory, env: { NODE_ENV: "test" } }),
    spawn: async input => {
      spawns += 1;
      return { ok: true, target: null, path: artifactPath, launchId: input.receipt.launchId, conversationId: conversation.id,
        launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
    },
  });
  const cards = () => loadTasks(statePath("tasks.json")).filter(task => task.text.includes(`claude:${sessionId}`));
  return { registry, conversation, key, recover, cards, spawns: () => spawns };
}

/** The queue that drains one accepted send to the orphan, over a receipt
    that follows its own transitions, with the real recovery behind it. */
function sendQueue(row: ReturnType<typeof orphanRow>, admittedAt: string) {
  const operationId = `operation-${row.key.sessionId}`;
  const effect: StructuredDeliveryEffect = {
    id: `effect:${operationId}`, kind: "runtime.send", eventSeq: 7,
    payload: { operationId, conversationId: row.conversation.id, text: "the merge gate finished", policy: "queue" },
  };
  const transitions: Array<[string, string | null | undefined]> = [];
  let status = "queued";
  /* The resumed host the send reaches once recovery has spawned it. */
  const resumed = new FakeEngineHost(createFakeDeliveryLedger(), {
    status: "idle", sessionKey: row.key.sessionId, endpoint: "fixture:resumed-host", pid: 1, processStartIdentity: "fixture:1",
    eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null,
  });
  const queue = new StructuredDeliveryQueue({
    effects: async () => (status === "queued" ? [effect] : []),
    status: async () => ({ status, admittedAt }),
    transition: async (_operationId, next, details) => { transitions.push([next, details?.reason]); status = next; },
  }, () => (row.spawns() > 0 ? resumed : null), undefined, () => {}, async (_conversationId, admission) =>
    (await row.recover({ operationId: admission?.operationId, admittedAt: admission?.admittedAt }))?.spawned === true);
  return { queue, transitions, status: () => status };
}

/* The engine's start identity cannot be read, so no signal can be fenced to
   it and its stop is refused. The send used to fail within milliseconds as
   "structured recovery is synchronizing while a live host owner remains",
   though the owner was proven gone. */
test("a send to an orphan whose stop is refused stays held for its bound, then fails with the refusal, and the seat is alerted", async () => {
  const engine = child();
  const real = captureProcessIdentity(engine.pid!);
  const unverifiable = { pid: real.pid, startIdentity: null } as unknown as ProcessIdentity;
  const row = orphanRow("refused", unverifiable, await ended());
  const admittedAt = Date.parse("2026-11-17T05:05:00.000Z");
  setSystemTime(new Date(admittedAt));
  const send = sendQueue(row, new Date(admittedAt).toISOString());
  try {
    await send.queue.drain();
    expect(send.status()).toBe("queued");
    expect(send.transitions.some(([state]) => state === "failed")).toBe(false);
    const cards = row.cards();
    expect(cards.map(card => card.status)).toEqual(["assigned"]);
    expect(cards[0]!.text).toContain(row.conversation.id);
    expect(cards[0]!.text).toContain("start identity cannot be verified");

    setSystemTime(new Date(admittedAt + ORPHANED_HOST_STOP_REFUSED_HOLD_MS - 1));
    await send.queue.drain();
    expect(send.status()).toBe("queued");

    setSystemTime(new Date(admittedAt + ORPHANED_HOST_STOP_REFUSED_HOLD_MS));
    await send.queue.drain();
    expect(send.status()).toBe("failed");
    const reason = send.transitions.at(-1)![1] ?? "";
    expect(reason).toContain("could not be stopped");
    expect(reason).toContain("start identity cannot be verified");
    expect(reason).not.toContain("synchronizing");
    expect(row.cards().map(card => card.status)).toEqual(["assigned"]);
    expect(row.spawns()).toBe(0);
    expect(processIdentityStatus(real)).toBe("alive");
  } finally {
    row.registry.close();
    await stopFixtureTree(engine);
  }
});

/* A refusal can clear: here a pending action owned the row when the send
   arrived and ended inside the bound, so the held send stops and resumes the
   orphan. */
test("a send held behind a pending action resumes the orphan once the action ends", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const row = orphanRow("pending", engineIdentity, await ended(), "spawn");
  const send = sendQueue(row, new Date().toISOString());
  try {
    await send.queue.drain();
    expect(send.status()).toBe("queued");
    expect(row.spawns()).toBe(0);
    expect(processIdentityStatus(engineIdentity)).toBe("alive");

    const entry = row.registry.readOnlySnapshot().entries[`claude:${row.key.sessionId}`]!;
    row.registry.upsert({ ...entry, pendingAction: null });
    await send.queue.drain();
    expect(row.spawns()).toBe(1);
    expect(processIdentityStatus(engineIdentity)).toBe("dead");
    expect(send.transitions.some(([state]) => state === "failed")).toBe(false);
    expect(send.status()).not.toBe("queued");
    // The orphan the alarm named is gone, so its card is closed.
    expect(row.cards().map(card => card.status)).toEqual(["done"]);
  } finally {
    row.registry.close();
    await stopFixtureTree(engine);
  }
});

test("an alarmed orphan that a send stops and resumes has its card closed without another startup pass", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const row = orphanRow("closed-by-send", engineIdentity, await ended());
  try {
    await surfaceOrphanedHosts({ registry: row.registry, rows: [{ key: row.key }], adopted: new Set(),
      retry: key => startupRowRetries(row.registry).get(key), sweepAbsent: true, assertActive: () => {} });
    expect(row.cards().map(card => card.status)).toEqual(["assigned"]);

    const result = await row.recover({ admittedAt: new Date().toISOString() });
    expect(result).toMatchObject({ spawned: true });
    expect(processIdentityStatus(engineIdentity)).toBe("dead");
    expect(row.cards().map(card => card.status)).toEqual(["done"]);
  } finally {
    row.registry.close();
    await stopFixtureTree(engine);
  }
});

/* The seat answered the alarm by stopping the host itself. */
test("an alarmed orphan stopped by a direct kill has its card closed", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const row = orphanRow("closed-by-kill", engineIdentity, await ended());
  try {
    await surfaceOrphanedHosts({ registry: row.registry, rows: [{ key: row.key }], adopted: new Set(),
      retry: key => startupRowRetries(row.registry).get(key), sweepAbsent: true, assertActive: () => {} });
    expect(row.cards().map(card => card.status)).toEqual(["assigned"]);

    const entry = row.registry.readOnlySnapshot().entries[`claude:${row.key.sessionId}`]!;
    const outcome = await terminateStructuredHostTree({
      kind: "structured", pid: engineIdentity.pid, startIdentity: engineIdentity.startIdentity!, bootEpoch: engineIdentity.bootEpoch ?? null,
      engine: "claude", sessionId: row.key.sessionId, conversationId: row.conversation.id,
      seat: null, turnBusy: null, owned: false, lastActiveAt: null,
    }, {
      orphanAlarmRegistry: row.registry,
      registryCustody: { claimEpoch: entry.claimEpoch, claimOwner: entry.claimOwner,
        writerClaimEpoch: entry.structuredHost?.writerClaimEpoch ?? null, process: recordedScopeProcess(entry.structuredHost) },
      terminateOwnedHost: async () => false,
      retireRegistryEntry: (key, expected, confirmed, custody, scope) => row.registry.terminateStructuredHost(key, expected, confirmed, custody, scope),
      graceMs: 200, deadlineMs: 3_000,
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(processIdentityStatus(engineIdentity)).toBe("dead");
    expect(row.cards().map(card => card.status)).toEqual(["done"]);
  } finally {
    row.registry.close();
    await stopFixtureTree(engine);
  }
});
