import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";

import { AccountMutationBusyError, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { HostState } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import {
  StructuredDeliveryQueue,
  type StructuredDeliveryEffect,
  type StructuredDeliveryQueuePort,
  type StructuredHostRecovery,
} from "./structuredDeliveryQueue";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { StructuredRecoveryContendedError } from "./structuredRecoveryContention";
import type { spawnStructuredConversation } from "./structuredSpawn";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recovery-contention-"));
/* The account mutation lock, its revision fence and the launch membership
   store all live under the state dir, so this suite pins it inside its own
   sandbox and never touches the state a running Viewer owns. */
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => {
  setSystemTime();
});

/** The sentence the lock's synchronous acquire refuses with (#1716). */
const BUSY = "account mutation is busy in this process; retry shortly";
const TEXT = "carry this through the handover";

function idleHostState(sessionKey: string): HostState {
  return {
    status: "idle",
    sessionKey,
    endpoint: "fixture:recovered-host",
    pid: 1,
    processStartIdentity: "fixture:1",
    eventCursor: 0,
    protocolVersion: "fixture",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

/** Holds the real account mutation lock the way an async holder does — a quota
    probe, a migration step — until that same holder lets go. */
async function holdAccountMutation(): Promise<() => Promise<void>> {
  let entered!: () => void;
  let finish!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const holder = withAccountMutationLockAsync(async () => {
    entered();
    await gate;
  });
  await inside;
  return async () => {
    finish();
    await holder;
  };
}

function journalPort(journal: RuntimeJournal): StructuredDeliveryQueuePort {
  return {
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
    },
    status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
  };
}

/**
 * One conversation whose structured host ended with its release, one original
 * send queued for it in a real runtime journal, and the recovery the controller
 * binds: the real registry reservation and the real account mutation lock,
 * with only the engine launch faked.
 */
function recoveryFixture(engine: "codex" | "claude", spawnOutcome: "publish" | "busy-after-reservation" = "publish") {
  const sessionId = crypto.randomUUID();
  const directory = path.join(sandbox, `${engine}-${sessionId}`);
  const cwd = path.join(directory, "workspace");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const hostKind = engine === "codex" ? "codex-app-server" : "claude-broker";
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation(engine, artifactPath, "default");
  const key = { engine, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd }),
    status: "dead",
    host: null,
    structuredHost: {
      kind: hostKind,
      endpoint: "stdio:ended-with-its-release",
      process: null,
      eventCursor: 3,
      protocolVersion: "fixture",
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind,
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: engine === "codex", structuredAttention: true },
    },
  });
  const operationId = `operation-${sessionId}`;
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: `idempotency-${sessionId}`,
    conversationId: conversation.id,
    text: TEXT,
    policy: "queue",
  });

  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger, idleHostState(sessionId));
  const spawns: string[] = [];
  let published = false;
  let recoveries = 0;
  let wakes = 0;
  const spawn: typeof spawnStructuredConversation = async (input) => {
    spawns.push(input.receipt.launchId);
    if (spawnOutcome === "busy-after-reservation") throw new AccountMutationBusyError(BUSY);
    published = true;
    return {
      ok: true,
      target: null,
      path: artifactPath,
      launchId: input.receipt.launchId,
      conversationId: conversation.id,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered" as const,
      state: "settled" as const,
    };
  };
  const recover = async (conversationId: string) => (await recoverDeadStructuredConversation({ path: artifactPath, conversationId }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (accountEngine) => ({
      engine: accountEngine,
      accountId: "default",
      kind: "managed",
      home: path.join(directory, "account-home"),
      transcriptRoot: directory,
      env: { NODE_ENV: "test" },
    }),
    spawn,
    requestDeliveryDrain: () => {},
  }))?.spawned === true;
  const queue = new StructuredDeliveryQueue(
    journalPort(journal),
    () => (published ? host : null),
    undefined,
    () => { wakes += 1; },
    async (conversationId) => {
      recoveries += 1;
      return recover(conversationId);
    },
  );

  return {
    conversationId: conversation.id,
    operationId,
    journal,
    ledger,
    queue,
    recover,
    spawns,
    recoveries: () => recoveries,
    wakes: () => wakes,
    successorReceipts: () => Object.values(registry.snapshot().receipts).filter((receipt) =>
      receipt.conversationId === conversation.id && receipt.purpose === "resume-successor").length,
    receipt: () => journal.operationResult(operationId)!.receipt,
  };
}

function sendEffect(operationId: string): StructuredDeliveryEffect {
  return {
    id: `effect:${operationId}`,
    kind: "runtime.send",
    eventSeq: 7,
    payload: { operationId, conversationId: "conversation-contended", text: TEXT, policy: "queue" },
  };
}

/** A queue over one operation whose receipt follows its own transitions. */
function trackedQueue(options: {
  effect: StructuredDeliveryEffect;
  recover: StructuredHostRecovery;
  host?: () => FakeEngineHost | null;
}) {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const admittedAt = new Date().toISOString();
  let status = "queued";
  let wakes = 0;
  const queue = new StructuredDeliveryQueue({
    effects: async () => (status === "queued" ? [options.effect] : []),
    status: async () => ({ status, admittedAt }),
    transition: async (operationId, next, details) => {
      transitions.push([operationId, next, details?.reason]);
      status = next;
    },
  }, options.host ?? (() => null), undefined, () => { wakes += 1; }, options.recover);
  return { queue, transitions, status: () => status, wakes: () => wakes };
}

for (const engine of ["codex", "claude"] as const) {
  test(`${engine}: a recovery the account lock refuses keeps the original queued, and it is delivered once after the holder lets go`, async () => {
    const startedAt = Date.now();
    setSystemTime(new Date(startedAt));
    const fixture = recoveryFixture(engine);
    try {
      const admitted = fixture.receipt();
      const effects = fixture.journal.effectBatch(100, ["runtime.send"]);
      expect(effects).toHaveLength(1);
      expect(effects[0]!.payload).toMatchObject({ operationId: fixture.operationId, text: TEXT });
      const contentDigest = fixture.journal.effectBatch(100, ["runtime.send"])[0]!.payload.contentDigest;

      const release = await holdAccountMutation();
      try {
        await fixture.queue.drain();

        /* The original is still the one admitted, still queued: same id, key
           and revision, and the same effect with its text and digest. */
        expect(fixture.receipt()).toMatchObject({
          operationId: fixture.operationId,
          idempotencyKey: admitted.idempotencyKey,
          conversationId: fixture.conversationId,
          status: "queued",
          revision: admitted.revision,
        });
        expect(fixture.journal.effectBatch(100, ["runtime.send"])).toEqual(effects);
        /* The refusal reserved nothing, started nothing and wrote nothing. */
        expect(fixture.recoveries()).toBe(1);
        expect(fixture.spawns).toEqual([]);
        expect(fixture.successorReceipts()).toBe(0);
        expect(fixture.ledger.writes).toEqual([]);
        expect(fixture.wakes()).toBe(1);

        /* A wake inside the spacing costs a wake and nothing else. */
        setSystemTime(new Date(startedAt + 500));
        await fixture.queue.drain();
        expect(fixture.recoveries()).toBe(1);
        expect(fixture.wakes()).toBe(2);
        expect(fixture.receipt().revision).toBe(admitted.revision);
      } finally {
        await release();
      }

      setSystemTime(new Date(startedAt + 1_000));
      await fixture.queue.drain();

      expect(fixture.recoveries()).toBe(2);
      expect(fixture.spawns).toHaveLength(1);
      expect(fixture.successorReceipts()).toBe(1);
      expect(fixture.ledger.writes).toHaveLength(1);
      expect(fixture.ledger.writes[0]).toMatchObject({ id: fixture.operationId, text: TEXT, contentDigest });
      expect(fixture.receipt()).toMatchObject({
        operationId: fixture.operationId,
        idempotencyKey: admitted.idempotencyKey,
        status: "delivered",
      });

      setSystemTime(new Date(startedAt + 60_000));
      await fixture.queue.drain();
      expect(fixture.ledger.writes).toHaveLength(1);
      expect(fixture.spawns).toHaveLength(1);
      expect(fixture.recoveries()).toBe(2);
    } finally {
      fixture.journal.close();
    }
  });
}

test("the reservation refusal is marked where the reservation is made, with the lock's own sentence", async () => {
  const fixture = recoveryFixture("codex");
  try {
    const release = await holdAccountMutation();
    let refusal: unknown;
    try {
      await fixture.recover(fixture.conversationId);
    } catch (error) {
      refusal = error;
    } finally {
      await release();
    }
    expect(refusal).toBeInstanceOf(StructuredRecoveryContendedError);
    expect((refusal as StructuredRecoveryContendedError).message).toBe(BUSY);
    expect((refusal as StructuredRecoveryContendedError).contention).toBeInstanceOf(AccountMutationBusyError);
    expect(fixture.successorReceipts()).toBe(0);
    expect(fixture.spawns).toEqual([]);
  } finally {
    fixture.journal.close();
  }
});

test("a busy error raised after the successor reservation exists settles failed and is never retried", async () => {
  const startedAt = Date.now();
  setSystemTime(new Date(startedAt));
  const fixture = recoveryFixture("codex", "busy-after-reservation");
  try {
    await fixture.queue.drain();

    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.successorReceipts()).toBe(1);
    expect(fixture.receipt()).toMatchObject({
      operationId: fixture.operationId,
      status: "failed",
      reason: `structured host recovery failed: ${BUSY}`,
    });
    expect(fixture.wakes()).toBe(0);

    setSystemTime(new Date(startedAt + 60_000));
    await fixture.queue.drain();
    expect(fixture.recoveries()).toBe(1);
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.successorReceipts()).toBe(1);
    expect(fixture.ledger.writes).toEqual([]);
  } finally {
    fixture.journal.close();
  }
});

test("contention that outlasts its attempts settles failed after a bounded, spaced series, with or without a dead host", async () => {
  for (const shape of ["missing", "dead"] as const) {
    const startedAt = Date.now();
    setSystemTime(new Date(startedAt));
    const attemptedAt: number[] = [];
    const deadHost = new FakeEngineHost(createFakeDeliveryLedger(), { ...idleHostState("ended"), status: "dead" });
    const tracked = trackedQueue({
      effect: sendEffect(`operation-${shape}`),
      host: () => (shape === "dead" ? deadHost : null),
      recover: async () => {
        attemptedAt.push(Date.now() - startedAt);
        throw new StructuredRecoveryContendedError(new AccountMutationBusyError(BUSY));
      },
    });

    for (let elapsed = 0; elapsed <= 180_000 && tracked.status() === "queued"; elapsed += 250) {
      setSystemTime(new Date(startedAt + elapsed));
      const before = attemptedAt.length;
      await tracked.queue.drain();
      /* No pass loops on the contended conversation. */
      expect(attemptedAt.length - before).toBeLessThanOrEqual(1);
    }

    expect({ shape, attemptedAt }).toEqual({
      shape,
      attemptedAt: [0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000],
    });
    /* Only an attempt requeues; the passes between them write nothing. */
    expect(tracked.transitions.filter(([, status]) => status === "queued")).toHaveLength(12);
    expect(tracked.transitions.at(-1)).toEqual([
      `operation-${shape}`,
      "failed",
      `structured host recovery failed after 12 contended attempts: ${BUSY}`,
    ]);

    setSystemTime(new Date(startedAt + 600_000));
    await tracked.queue.drain();
    expect(attemptedAt).toHaveLength(12);
    setSystemTime();
  }
});

test("every other recovery outcome settles on first sight, whatever its message says", async () => {
  const cases: Array<{ name: string; recover: StructuredHostRecovery; reason: string }> = [
    {
      name: "plain failure",
      recover: async () => { throw new Error("successor admission unavailable"); },
      reason: "structured host recovery failed: successor admission unavailable",
    },
    {
      name: "unmarked busy error",
      recover: async () => { throw new AccountMutationBusyError(BUSY); },
      reason: `structured host recovery failed: ${BUSY}`,
    },
    {
      name: "busy sentence on a plain error",
      recover: async () => { throw new Error(BUSY); },
      reason: `structured host recovery failed: ${BUSY}`,
    },
    {
      name: "recovery that did not start",
      recover: async () => false,
      reason: "structured host recovery did not start; retry the operation",
    },
  ];
  for (const { name, recover, reason } of cases) {
    let attempts = 0;
    const tracked = trackedQueue({
      effect: sendEffect("operation-other"),
      recover: async (conversationId) => {
        attempts += 1;
        return recover(conversationId);
      },
    });

    await tracked.queue.drain();
    await tracked.queue.drain();

    expect({ name, transitions: tracked.transitions }).toEqual({
      name,
      transitions: [["operation-other", "queued", "dead-host"], ["operation-other", "failed", reason]],
    });
    expect({ name, attempts, wakes: tracked.wakes() }).toEqual({ name, attempts: 1, wakes: 0 });
  }
});

test("a compaction waiting on contended recovery holds inside the spacing and tries again after it", async () => {
  const startedAt = Date.now();
  setSystemTime(new Date(startedAt));
  let attempts = 0;
  const tracked = trackedQueue({
    effect: {
      id: "effect:operation-compact",
      kind: "runtime.compact",
      eventSeq: 3,
      payload: {
        operationId: "operation-compact",
        conversationId: "conversation-contended",
        sessionKey: { engine: "codex", sessionId: "compacting-session" },
      },
    },
    recover: async () => {
      attempts += 1;
      throw new StructuredRecoveryContendedError(new AccountMutationBusyError(BUSY));
    },
  });

  await tracked.queue.drain();
  setSystemTime(new Date(startedAt + 400));
  await tracked.queue.drain();

  expect(attempts).toBe(1);
  expect(tracked.status()).toBe("queued");
  expect(tracked.transitions).toEqual([["operation-compact", "queued", "dead-host"]]);

  setSystemTime(new Date(startedAt + 1_000));
  await tracked.queue.drain();
  expect(attempts).toBe(2);
  expect(tracked.status()).toBe("queued");
});
