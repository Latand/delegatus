import path from "node:path";
import { expect, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost, releaseStructuredDeliveryHost } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { NativeCodexQueue } from "./nativeCodexQueue";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import type { HostState } from "./engineHost";
import { messageRowModel } from "@/components/conversation/messageRow";
import { outboxStateForReceiptStatus } from "@/components/conversation/outbox";
import { translate } from "@/lib/i18n";

async function switchingFixture(layout = "successor thread", publish = true, failure: "failed" | "cancelled" | null = null, accountSwitch = true) {
  const f = migrationDeliveryFixture();
  let active = true;
  let successorStatus: HostState["status"] = "idle";
  let unreadableSuccessor = false;
  let unreadableAfterPublication = false;
  let preparationError: string | null = null;
  const writes: Array<{ threadId: string; input: unknown }> = [];
  const nativeHost = (threadId: string, predecessor = false) => {
    const host = Object.assign(new FakeEngineHost(), {
      onStateChange: () => () => {},
      nativeQueue: {
        queue: new NativeCodexQueue({ rpc: async (method, params) => {
          if (method !== "thread/queue/add") throw new Error(`unexpected native write: ${method}`);
          const input = params as { input: unknown; clientUserMessageId: string };
          writes.push({ threadId, input: input.input });
          return { queuedSubmission: { id: "native-submission", ...input }, queueRevision: 1 };
        } }, threadId),
        prepare: async (entry: { versions: Array<{ text: string }> }) => {
          if (preparationError) throw new Error(preparationError);
          return [{ type: "text" as const, text: entry.versions[0]!.text }];
        },
        evidence: async () => null,
        sendWithdrawn: async () => { throw new Error("unexpected resend"); },
      },
    });
    const health = host.health.bind(host);
    host.health = async () => {
      if (!predecessor && unreadableSuccessor) throw new Error("successor health read timed out");
      return { ...await health(), sessionKey: threadId,
        status: predecessor ? active ? "active" : "idle" : successorStatus, activeTurnRef: predecessor && active ? "running" : null,
        activeFlags: ["native-queue"],
      };
    };
    return host;
  };
  const source = nativeHost(f.key.sessionId, true);
  f.client.nativeQueueRead = async id => f.journal.nativeQueueRead(id);
  f.client.nativeQueueTransition = async (id, change) => f.journal.nativeQueueTransition(id, change);
  const successorId = layout === "same thread" || !accountSwitch ? f.key.sessionId : "successor-thread";
  const publishSuccessor = () => publishStructuredDeliveryHost({ key: { engine: "codex", sessionId: successorId }, host: nativeHost(successorId) });
  await bindStructuredDeliveryQueue([{ key: f.key, host: source }], { registry: f.registry, client: f.client,
    reconfigure: {
      validateAccount: async () => { if (failure === "failed") throw new Error("target account requires authentication"); },
      resolveAccount: () => ({}) as never, releaseHost: async () => true,
      recover: async () => {
        await publishSuccessor();
        return { target: null, path: f.conversation.generations.at(-1)!.path, conversationId: f.conversation.id, spawned: true };
      },
      migrate: async (id, _target, registry, ownsOperation, reconfigureOperationId) => {
        const migrated = await advanceConversationMigration(id, registry, {
          create: async input => ({ operationId: input.operationId, nativeId: successorId,
            path: path.join(f.root, "successor.jsonl"), continuityPaths: [], historyHash: "fixture",
            host: { kind: "codex-app-server", identity: "fixture-successor", epoch: 1, verifiedAt: new Date().toISOString() } }),
          verify: async () => {},
        }, { ownsOperation, reconfigureOperationId });
        if (publish) await publishSuccessor();
        unreadableSuccessor = unreadableAfterPublication;
        return migrated;
      },
    },
  });
  return { ...f, writes, successorId, publishSuccessor, finishTurn: () => { active = false; },
    successorStatus: (status: HostState["status"]) => { successorStatus = status; },
    unreadableSuccessor: (value: boolean) => { unreadableSuccessor = value; },
    unreadableAfterPublication: () => { unreadableAfterPublication = true; },
    preparationError: (value: string) => { preparationError = value; },
    admit: (kind: "native-queue" | "send" = "native-queue") => {
      f.journal.executeOperation(kind === "native-queue"
        ? { kind, operationId: "queued-add", idempotencyKey: "queued-add", conversationId: f.conversation.id,
          action: "add", text: "preserve queued words", binding: { threadId: f.key.sessionId, accountId: "account-a" } }
        : { kind, operationId: "queued-add", idempotencyKey: "queued-add", conversationId: f.conversation.id,
          text: "preserve queued words", policy: "queue" });
      f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
        conversationId: f.conversation.id, model: "gpt-6.1-sol", effort: "high", fast: false,
        ...(accountSwitch ? { accountId: "account-b" } : {}) });
      if (failure === "cancelled") f.registry.withdrawConversationReconfigure(f.conversation.id, "switch");
    },
  };
}

test.each(["same thread", "successor thread"])("pending native add survives an account switch with %s exactly once", async layout => {
  const f = await switchingFixture(layout);
  try {
    f.admit();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("queued-add")?.receipt.status).toBe("queued");
    expect(f.writes).toEqual([]);
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe("applied");
    expect(f.journal.operationResult("queued-add")?.receipt.status).toBe("applied");
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toMatchObject({ state: "queued",
      binding: { threadId: f.successorId, accountId: "account-b" }, reason: null });
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(f.writes).toEqual([{ threadId: f.successorId, input: [{ type: "text", text: "preserve queued words" }] }]);
  } finally { await f.cleanup(); }
});

test("pending native add follows the replacement host after a model-only switch", async () => {
  const f = await switchingFixture("same thread", true, null, false);
  try {
    f.admit();
    await kickStructuredDeliveryQueue();
    expect(f.writes).toEqual([]);
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe("applied");
    expect(f.journal.operationResult("queued-add")?.receipt.status).toBe("applied");
    expect(f.registry.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile.model).toBe("gpt-6.1-sol");
    await kickStructuredDeliveryQueue();
    expect(f.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test.each(["unpublished", "dead", "attention"] as const)("native composer send stays queued until the successor can accept it (%s)", async unavailable => {
  const f = await switchingFixture("successor thread", unavailable !== "unpublished");
  try {
    f.admit("send");
    if (unavailable !== "unpublished") f.successorStatus(unavailable);
    await kickStructuredDeliveryQueue();
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe("applied");
    expect(f.journal.operationResult("queued-add")?.receipt).toMatchObject({ status: "queued", reason: null });
    const receipt = f.journal.operationResult("queued-add")!.receipt;
    for (const locale of ["en", "uk"] as const) {
      const row = messageRowModel((key, params) => translate(locale, key, params), {
        id: "queued-add", text: "preserve queued words", images: 0, at: Date.now(),
        state: outboxStateForReceiptStatus(receipt.status)!, deliveryReceipt: receipt,
      });
      expect(row.phase).toBe("pending");
      expect(row.failure).toBeNull();
      expect(row.status).toBe(translate(locale, "outbox.awaitingConfirmation"));
    }
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.state).toBe("admitted");
    expect(f.writes).toEqual([]);
    f.successorStatus("idle");
    await f.publishSuccessor();
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toMatchObject({ state: "queued", binding: { threadId: f.successorId, accountId: "account-b" } });
    expect(f.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("unreadable successor health retains the queued native entry without a failure receipt", async () => {
  const f = await switchingFixture();
  try {
    f.admit("send");
    f.unreadableAfterPublication();
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("queued-add")?.receipt).toMatchObject({ status: "queued", reason: null });
    expect(f.writes).toEqual([]);
    f.unreadableSuccessor(false);
    await kickStructuredDeliveryQueue();
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.state).toBe("queued");
    expect(f.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("successor preparation failure preserves the actual delivery reason", async () => {
  const f = await switchingFixture();
  try {
    f.admit();
    f.preparationError("queued attachment is no longer readable");
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("queued-add")?.receipt).toMatchObject({ status: "failed", reason: "queued attachment is no longer readable" });
    expect(f.writes).toEqual([]);
  } finally { await f.cleanup(); }
});

test("failed account switch refuses an unsubmitted native entry with the actual failure", async () => {
  const f = await switchingFixture("successor thread", true, "failed");
  try {
    f.admit();
    await kickStructuredDeliveryQueue();
    f.finishTurn();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("queued-add")?.receipt).toMatchObject({ status: "failed", reason: "account switch failed: target account requires authentication" });
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.state).toBe("refused");
    expect(f.writes).toEqual([]);
  } finally { await f.cleanup(); }
});

test("cancelled runtime switch settles the queued native entry on the unchanged runtime", async () => {
  const f = await switchingFixture("successor thread", true, "cancelled");
  try {
    f.admit();
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt).toMatchObject({ status: "failed", reason: "cancelled" });
    expect(f.journal.operationResult("queued-add")?.receipt.status).toBe("applied");
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toMatchObject({ state: "queued", binding: { threadId: f.key.sessionId, accountId: "account-a" } });
    await kickStructuredDeliveryQueue();
    expect(f.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("a cancelled claimed succession gives the unsubmitted native entry a terminal cancellation reason", async () => {
  const f = await switchingFixture();
  try {
    f.admit();
    const effect = f.journal.effectBatch(100).find(effect => effect.kind === "runtime.reconfigure")!;
    f.registry.claimConversationReconfigure(f.conversation.id, { operationId: "switch", revision: effect.eventSeq,
      profile: { model: "gpt-6.1-sol", effort: "high", fast: false }, accountId: "account-b" });
    const pending = f.registry.requestConversationReseat(f.conversation.id, "account-b", { operationId: "switch", revision: effect.eventSeq });
    f.registry.cancelConversationSwitch(f.conversation.id, pending.migration!.revision);
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt).toMatchObject({ status: "failed", reason: "cancelled" });
    expect(f.journal.operationResult("queued-add")?.receipt).toMatchObject({ status: "failed", reason: "runtime switch cancelled" });
    expect(f.writes).toEqual([]);
  } finally { await f.cleanup(); }
});

test.each(["foreign host", "conversation gone"])("native queue entry is terminally refused when ownership is unavailable (%s)", async missing => {
  const f = await switchingFixture();
  try {
    f.journal.executeOperation({ kind: "native-queue", operationId: "foreign-add", idempotencyKey: "foreign-add",
      conversationId: f.conversation.id, action: "add", text: "retain foreign words",
      binding: { threadId: f.key.sessionId, accountId: "account-a" } });
    if (missing === "foreign host") await releaseStructuredDeliveryHost(f.key);
    else f.registry.conversation = () => null;
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("foreign-add")?.receipt).toMatchObject({ status: "failed",
      reason: missing === "foreign host" ? "native queue host or account ownership changed" : "native queue conversation is unavailable" });
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.state).toBe("refused");
    expect(f.writes).toEqual([]);
  } finally { await f.cleanup(); }
});
