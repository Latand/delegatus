import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { ACCOUNT_STORE_BUSY_MESSAGE, AccountMutationBusyError, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
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
import { recoverDeadStructuredConversation, StructuredOrphanGraceError, StructuredOrphanStopRefusedError, StructuredRecoveryHeldForUpdateError } from "./structuredRecovery";
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

/** The public sentence is stable; real locks retain owner evidence separately. */
const BUSY = ACCOUNT_STORE_BUSY_MESSAGE;
const TEXT = "carry this through the handover";
/** When each contended recovery attempt is due, from the first: 1s, 2s, 4s, 8s
    and then 15s apart, twelve attempts in all. */
const CONTENDED_SCHEDULE_MS = [0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000];
/** One original more than the 128 whose contention history the executor once
    kept, past which it dropped the oldest one's attempts and due time. */
const BATCH = 129;

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
    transportAvailable: () => true,
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
  progress?: StructuredDeliveryQueuePort["progress"];
}) {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const admittedAt = new Date().toISOString();
  let status = "queued";
  let wakes = 0;
  const queue = new StructuredDeliveryQueue({
    progress: options.progress,
    effects: async () => (status === "queued" ? [options.effect] : []),
    status: async () => ({ status, admittedAt }),
    transition: async (operationId, next, details) => {
      transitions.push([operationId, next, details?.reason]);
      status = next;
    },
  }, options.host ?? (() => null), undefined, () => { wakes += 1; }, options.recover);
  return { queue, transitions, status: () => status, wakes: () => wakes };
}

/**
 * One queue draining an original send for each of `count` conversations whose
 * hosts are gone, all admitted to one real runtime journal. Each recovery is
 * recorded; while `contended()` holds it is refused before its reservation, and
 * otherwise it brings that conversation's host back.
 */
function contendedBatch(count: number, contended: () => boolean) {
  const directory = fs.mkdtempSync(path.join(sandbox, "batch-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const ledger = createFakeDeliveryLedger();
  const hosts = new Map<string, FakeEngineHost>();
  const recovered = new Set<string>();
  const attemptedAt = new Map<string, number[]>();
  const sends: string[] = [];
  const originals = Array.from({ length: count }, (_, index) => {
    const conversationId = `conversation-batch-${index}`;
    const sessionId = `session-batch-${index}`;
    journal.append({
      scope: { type: "session", id: conversationId },
      kind: "session-status",
      payload: {
        conversationId,
        sessionKey: { engine: "claude", sessionId },
        hostKind: "claude-broker",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        artifactPath: path.join(directory, `${sessionId}.jsonl`),
        capabilities: { steer: false, structuredAttention: true },
      },
    });
    const host = new FakeEngineHost(ledger, idleHostState(sessionId));
    const send = host.send.bind(host);
    host.send = async (entry) => {
      sends.push(entry.id);
      return send(entry);
    };
    hosts.set(conversationId, host);
    attemptedAt.set(conversationId, []);
    const { operationId, receipt } = journal.executeOperation({
      kind: "send",
      operationId: `operation-batch-${index}`,
      idempotencyKey: `idempotency-batch-${index}`,
      conversationId,
      text: `${TEXT} ${index}`,
      policy: "queue",
    });
    return { conversationId, operationId, admitted: receipt };
  });
  const queue = new StructuredDeliveryQueue(
    journalPort(journal),
    (conversationId) => (recovered.has(conversationId) ? hosts.get(conversationId) ?? null : null),
    undefined,
    () => {},
    async (conversationId) => {
      attemptedAt.get(conversationId)!.push(Date.now());
      if (contended()) throw new StructuredRecoveryContendedError(new AccountMutationBusyError(BUSY));
      recovered.add(conversationId);
      return true;
    },
  );
  return {
    journal,
    ledger,
    queue,
    originals,
    sends,
    /** Every conversation's attempt times, relative to `startedAt`. */
    attempts: (startedAt: number) => originals.map(({ conversationId }) =>
      attemptedAt.get(conversationId)!.map((at) => at - startedAt)),
    receipt: (operationId: string) => journal.operationResult(operationId)!.receipt,
    pendingSends: () => journal.effectBatch(count + 1, ["runtime.send"]),
  };
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
    const marked = refusal as StructuredRecoveryContendedError;
    expect(marked.contention).toBeInstanceOf(AccountMutationBusyError);
    expect(marked.message).toBe(marked.contention.message);
    expect(marked.contention.owner).toMatchObject({ operation: "holdAccountMutation", pid: process.pid });
    expect(marked.message).toBe(ACCOUNT_STORE_BUSY_MESSAGE);
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

    expect({ shape, attemptedAt }).toEqual({ shape, attemptedAt: CONTENDED_SCHEDULE_MS });
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

test("each of more than 128 contended originals keeps its own spacing and settles failed at the cap", async () => {
  const startedAt = Date.now();
  setSystemTime(new Date(startedAt));
  const batch = contendedBatch(BATCH, () => true);
  try {
    for (let elapsed = 0; elapsed <= 180_000 && batch.pendingSends().length > 0; elapsed += 250) {
      setSystemTime(new Date(startedAt + elapsed));
      await batch.queue.drain();
    }

    /* Every original was tried on the schedule, once per attempt, and no more
       than the cap: a pass never tries one early or twice. */
    expect(batch.attempts(startedAt)).toEqual(batch.originals.map(() => CONTENDED_SCHEDULE_MS));
    for (const { operationId } of batch.originals) {
      expect(batch.receipt(operationId)).toMatchObject({
        operationId,
        status: "failed",
        reason: `structured host recovery failed after 12 contended attempts: ${BUSY}`,
      });
    }
    expect(batch.sends).toEqual([]);

    setSystemTime(new Date(startedAt + 600_000));
    await batch.queue.drain();
    expect(batch.attempts(startedAt)).toEqual(batch.originals.map(() => CONTENDED_SCHEDULE_MS));
  } finally {
    batch.journal.close();
  }
});

test("each of more than 128 contended originals is delivered once, as admitted, when contention ends before the cap", async () => {
  const startedAt = Date.now();
  setSystemTime(new Date(startedAt));
  let contended = true;
  const batch = contendedBatch(BATCH, () => contended);
  try {
    const admittedSends = batch.pendingSends();
    expect(admittedSends).toHaveLength(BATCH);

    /* Two refused attempts, and a pass inside each spacing that tries nothing. */
    for (const elapsed of [0, 500, 1_000, 2_500]) {
      setSystemTime(new Date(startedAt + elapsed));
      await batch.queue.drain();
    }
    expect(batch.attempts(startedAt)).toEqual(batch.originals.map(() => [0, 1_000]));
    for (const { operationId, admitted } of batch.originals) {
      expect(batch.receipt(operationId)).toMatchObject({
        operationId,
        idempotencyKey: admitted.idempotencyKey,
        conversationId: admitted.conversationId,
        status: "queued",
        revision: admitted.revision,
      });
    }
    expect(batch.pendingSends()).toEqual(admittedSends);
    expect(batch.sends).toEqual([]);

    /* The holder lets go; the next due attempt brings every host back. */
    contended = false;
    setSystemTime(new Date(startedAt + 3_000));
    await batch.queue.drain();

    expect(batch.attempts(startedAt)).toEqual(batch.originals.map(() => [0, 1_000, 3_000]));
    expect([...batch.sends].sort()).toEqual(batch.originals.map(({ operationId }) => operationId).sort());
    for (const { operationId, admitted } of batch.originals) {
      const admittedSend = admittedSends.find((effect) => effect.payload.operationId === operationId)!;
      expect(batch.ledger.writes.filter((write) => write.id === operationId)).toEqual([
        expect.objectContaining({ text: admittedSend.payload.text, contentDigest: admittedSend.payload.contentDigest }),
      ]);
      expect(batch.receipt(operationId)).toMatchObject({
        operationId,
        idempotencyKey: admitted.idempotencyKey,
        status: "delivered",
      });
    }

    setSystemTime(new Date(startedAt + 60_000));
    await batch.queue.drain();
    expect(batch.sends).toHaveLength(BATCH);
    expect(batch.attempts(startedAt)).toEqual(batch.originals.map(() => [0, 1_000, 3_000]));
  } finally {
    batch.journal.close();
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


test("recovery exhausts its durable attempt budget when each executor exits inside the callback", async () => {
  const directory = fs.mkdtempSync(path.join(sandbox, "restarting-budget-"));
  const journalFile = path.join(directory, "runtime.sqlite");
  const progressFile = path.join(directory, "progress.sqlite");
  const operationId = "restarting-recovery";
  const journal = new RuntimeJournal(journalFile, { structuredHosts: true });
  journal.append({ scope: { type: "session", id: "conversation_recovery_budget" }, kind: "session-status", payload: {
    conversationId: "conversation_recovery_budget", sessionKey: { engine: "codex", sessionId: "recovery-budget" },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured", capabilities: { steer: true, structuredAttention: true },
  } });
  journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId, conversationId: "conversation_recovery_budget", text: TEXT, policy: "queue" });
  journal.close();
  const source = `
    const { RuntimeJournal } = await import(${JSON.stringify(new URL("../../runtime-host/journal.ts", import.meta.url).pathname)});
    const { StructuredDeliveryQueue } = await import(${JSON.stringify(new URL("./structuredDeliveryQueue.ts", import.meta.url).pathname)});
    const { DeliveryProgressStore } = await import(${JSON.stringify(new URL("./deliveryProgress.ts", import.meta.url).pathname)});
    const journal = new RuntimeJournal(${JSON.stringify(journalFile)}, { structuredHosts: true });
    const progress = new DeliveryProgressStore(${JSON.stringify(progressFile)});
    const queue = new StructuredDeliveryQueue({
      effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      transition: async (id, status, details, options) => { journal.transitionOperation(id, status, details, options); }, progress,
    }, () => null, undefined, () => {}, async () => {
      console.log(JSON.stringify({ receipt: journal.operationResult(${JSON.stringify(operationId)})?.receipt, attempt: progress.get(${JSON.stringify(operationId)})?.attempt }));
      process.exit(0);
    });
    await queue.drain();
    progress.flush();
    console.log(JSON.stringify({ receipt: journal.operationResult(${JSON.stringify(operationId)})?.receipt, attempt: progress.get(${JSON.stringify(operationId)})?.attempt }));
    progress.close(); journal.close();
  `;
  let last: { receipt: { status: string; reason: string }; attempt: number } | undefined;
  for (let restart = 0; restart < 13; restart++) {
    const child = spawnSync(process.execPath, ["-e", source], { env: process.env, encoding: "utf8", timeout: 10000 });
    expect(child.status).toBe(0);
    last = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  }
  expect(last).toMatchObject({ receipt: { status: "queued" }, attempt: 12 });
});


test.each(["note missing", "flush refused"] as const)("host recovery waits for a durable attempt record (%s)", async refusal => {
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(path.join(sandbox, `attempt-write-${refusal.replaceAll(" ", "-")}.sqlite`));
  const refused = refusal === "note missing"
    ? spyOn(progress, "note").mockImplementation(() => {})
    : spyOn(progress, "flush").mockReturnValue(false);
  let calls = 0;
  const tracked = trackedQueue({ effect: sendEffect(`attempt-write-${refusal}`), progress,
    recover: async () => { calls++; return false; } });
  try {
    await tracked.queue.drain();
    expect(calls).toBe(0);
    expect(tracked.status()).toBe("queued");
    refused.mockRestore();
    await tracked.queue.drain();
    expect(calls).toBe(1);
    expect(tracked.status()).toBe("failed");
  } finally { refused.mockRestore(); progress.close(); }
});


test.each(["orphan grace", "orphan stop hold", "release hold"] as const)("a classified %s can outlast twelve polls and still recover", async wait => {
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const filename = path.join(sandbox, `recovery-wait-${wait.replaceAll(" ", "-")}.sqlite`);
  const progress = new DeliveryProgressStore(filename);
  let calls = 0;
  const tracked = trackedQueue({ effect: sendEffect(`recovery-wait-${wait}`), progress, recover: async () => {
    calls++;
    if (calls > 16) return false;
    if (wait === "orphan grace") throw new StructuredOrphanGraceError("native work is within its bounded grace");
    if (wait === "orphan stop hold") throw new StructuredOrphanStopRefusedError("stop is within its bounded hold", Date.now() + 120_000, true);
    throw new StructuredRecoveryHeldForUpdateError("release admission is held");
  } });
  try {
    for (let poll = 0; poll < 16; poll++) {
      await tracked.queue.drain();
      expect(tracked.status()).toBe("queued");
    }
    // The wait is durable but did not actuate a successor. A reader after
    // executor replacement must see the same remaining recovery budget.
    expect(progress.flush()).toBe(true);
    const reopened = new DeliveryProgressStore(filename);
    try { expect(reopened.get(`recovery-wait-${wait}`)?.attempt).toBe(0); }
    finally { reopened.close(); }
    await tracked.queue.drain();
    expect(calls).toBe(17);
    expect(tracked.status()).toBe("failed");
    expect(progress.get(`recovery-wait-${wait}`)?.attempt).toBe(1);
  } finally { progress.close(); }
});


test.each(["executor", "attempt", "terminal"] as const)("an admission answer preserves a changed %s after the recovery await", async changed => {
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(path.join(sandbox, `recovery-race-${changed}.sqlite`));
  const operationId = `recovery-race-${changed}`;
  const tracked = trackedQueue({ effect: sendEffect(operationId), progress, recover: async () => {
    if (changed === "terminal") progress.settle(operationId, "delivered", "replacement completed the message");
    else progress.note(operationId, "conversation-contended", { waitReason: "recovering-host",
      ...(changed === "executor" ? { executorId: "replacement-executor" } : { attempted: true }) });
    throw new StructuredRecoveryHeldForUpdateError("release admission is held");
  } });
  try {
    await tracked.queue.drain();
    expect(progress.get(operationId)?.attempt).toBe(changed === "attempt" ? 2 : 1);
    if (changed === "terminal") expect(progress.get(operationId)?.terminal?.state).toBe("delivered");
  } finally { progress.close(); }
});
