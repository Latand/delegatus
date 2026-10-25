import { expect, spyOn, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { NativeCodexQueue, type NativeQueuedSubmission } from "./nativeCodexQueue";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import { parseRuntimeCommand } from "./commands";
import type { RuntimeHostClient } from "./client";
import type { EngineHost } from "./engineHost";
import type { NativeQueueCommand, NativeQueueProof, NativeQueueRecord } from "./nativeQueueContracts";

/* The reconcile pass behind a consumed queued message, driven through the real
   delivery controller, queue, executor and journal. Only the engine's
   canonical history is invented: it answers with a proof once Codex consumed
   the entry. */

const binding = { threadId: "", accountId: "account-a" };

async function seeded(ids: string[]) {
  const f = migrationDeliveryFixture();
  const conversationId = f.conversation.id;
  binding.threadId = f.key.sessionId;
  f.journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: f.key, hostKind: "codex-app-server", host: "hosted", turn: "running", activeTurnId: "active-a",
    accountId: binding.accountId, capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
  const items: NativeQueuedSubmission[] = [];
  const queue = new NativeCodexQueue({ rpc: async (method, params) => {
    if (method === "thread/queue/list") return { data: items, nextCursor: null };
    if (method !== "thread/queue/add") throw new Error(`unexpected ${method}`);
    const queuedSubmission = { id: `native-${items.length + 1}`, clientUserMessageId: params.clientUserMessageId as string, input: params.input as NativeQueuedSubmission["input"] };
    items.push(queuedSubmission);
    return { queuedSubmission };
  } }, binding.threadId);
  const evidenceState = { consumed: new Set<string>(), calls: 0 };
  const nativeQueue = {
    queue,
    prepare: async (_entry: NativeQueueRecord, version: NativeQueueRecord["versions"][number]) => [{ type: "text" as const, text: version.text }],
    evidence: async () => null,
    evidenceBatch: async (entries: NativeQueueRecord[]) => entries.map(entry => {
      evidenceState.calls += 1;
      if (!evidenceState.consumed.has(entry.entryId)) return null;
      const version = entry.versions.find(row => row.revision === entry.revision)!;
      return { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: version.revision,
        turnId: "canonical-turn", itemId: `item-${entry.entryId}`, input: version.input! } as NativeQueueProof;
    }),
    sendWithdrawn: async () => { throw new Error("unused"); },
  };
  const baseHealth = f.host.health.bind(f.host);
  const hostWith = Object.assign(f.host, { health: async () => ({ ...await baseHealth(), status: "active" as const, activeTurnRef: "active-a" }) });
  const addingHost = { health: hostWith.health, nativeQueue } as unknown as EngineHost;
  const adding = new NativeQueueExecutor({
    client: journalClient(f.journal) as unknown as RuntimeHostClient,
    resolveHost: () => addingHost,
    binding: () => binding,
  });
  for (const id of ids) {
    const command = parseRuntimeCommand("native-queue", { kind: "native-queue", conversationId, operationId: id, idempotencyKey: `key-${id}`,
      action: "add", text: `same words`, binding }) as NativeQueueCommand & { operationId: string };
    f.journal.executeOperation(command);
    await adding.execute(command);
  }
  (hostWith as unknown as { nativeQueue: unknown }).nativeQueue = nativeQueue;
  return { f, conversationId, nativeQueue, evidenceState, host: hostWith };
}

function journalClient(journal: ReturnType<typeof migrationDeliveryFixture>["journal"]) {
  return {
    operationStatus: async (id: string) => journal.operationResult(id),
    transitionOperation: async (...args: Parameters<typeof journal.transitionOperation>) => journal.transitionOperation(...args),
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
    nativeQueueTransition: async (id: string, transition: Parameters<typeof journal.nativeQueueTransition>[1]) => journal.nativeQueueTransition(id, transition),
    nativeQueueSettleCompacted: async (request: Parameters<typeof journal.nativeQueueSettleCompacted>[0]) => journal.nativeQueueSettleCompacted(request),
  };
}

const states = (s: Awaited<ReturnType<typeof seeded>>) =>
  Object.fromEntries(s.f.journal.nativeQueueRead(s.conversationId).map(row => [row.entryId, row.state]));

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

const bind = (s: Awaited<ReturnType<typeof seeded>>, client: RuntimeHostClient, extra: Record<string, unknown> = {}) =>
  bindStructuredDeliveryQueue([{ key: s.f.key, host: s.host }], { registry: s.f.registry, client,
    watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0, ...extra });

test("an entry queued while busy and consumed later reaches delivered on the retry chain alone; a same-text entry stays", async () => {
  const s = await seeded(["op-consumed", "op-pending"]);
  try {
    await bind(s, { ...s.f.client, ...journalClient(s.f.journal) } as RuntimeHostClient);
    await kickStructuredDeliveryQueue();
    expect(states(s)).toEqual({ "op-consumed": "queued", "op-pending": "queued" });
    // Codex consumes it afterwards; nothing kicks the queue again.
    s.evidenceState.consumed.add("op-consumed");
    await until(() => states(s)["op-consumed"] === "delivered");
    expect(states(s)["op-pending"]).toBe("queued");
  } finally { await s.f.cleanup(); }
});

test("a host without a native queue is logged once across reconcile passes and its entry stays queued", async () => {
  const s = await seeded(["op-pending"]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    (s.host as unknown as { nativeQueue: unknown }).nativeQueue = undefined;
    await bind(s, { ...s.f.client, ...journalClient(s.f.journal) } as RuntimeHostClient);
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    const skips = warn.mock.calls.filter(call => String(call[0]).includes("has no native queue"));
    expect(skips.length).toBe(1);
    expect(JSON.stringify(skips[0])).toContain(s.f.key.sessionId);
    expect(states(s)).toEqual({ "op-pending": "queued" });
  } finally { warn.mockRestore(); await s.f.cleanup(); }
});

test("one failed canonical read is followed by recovery on its own", async () => {
  const s = await seeded(["op-consumed"]);
  s.evidenceState.consumed.add("op-consumed");
  let failures = 1;
  const base = journalClient(s.f.journal);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await bind(s, { ...s.f.client, ...base, nativeQueueRead: async (id: string) => {
      if (failures-- > 0) throw new Error("native queue read failed");
      return base.nativeQueueRead(id);
    } } as RuntimeHostClient);
    await kickStructuredDeliveryQueue();
    await until(() => states(s)["op-consumed"] === "delivered");
  } finally { warn.mockRestore(); await s.f.cleanup(); }
});

test("a canonical read that never answers is logged past its deadline and replaced by exactly one read", async () => {
  const s = await seeded(["op-consumed"]);
  s.evidenceState.consumed.add("op-consumed");
  let now = 1_000_000;
  let reads = 0;
  const base = journalClient(s.f.journal);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await bind(s, { ...s.f.client, ...base, nativeQueueRead: (_id: string) => { reads += 1; return new Promise<NativeQueueRecord[]>(() => {}); } } as RuntimeHostClient,
      { nativeReconcileDeadlineMs: 60_000, now: () => now });
    await kickStructuredDeliveryQueue();
    expect(reads).toBe(1);
    // Inside the deadline no second read starts, however often the queue passes.
    now += 59_000;
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(reads).toBe(1);
    // Past it the hung read is logged and replaced once; later deadlines add none while it hangs.
    for (let deadline = 0; deadline < 3; deadline++) { now += 61_000; await kickStructuredDeliveryQueue(); await kickStructuredDeliveryQueue(); }
    expect(reads).toBe(2);
    expect(warn.mock.calls.filter(call => String(call[0]).includes("exceeded its deadline")).length).toBe(1);
  } finally { warn.mockRestore(); await s.f.cleanup(); }
});

test("a read inside its deadline starts no second read and its answer settles the entry", async () => {
  const s = await seeded(["op-consumed"]);
  s.evidenceState.consumed.add("op-consumed");
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const base = journalClient(s.f.journal);
  try {
    await bind(s, { ...s.f.client, ...base, nativeQueueRead: async (id: string) => { reads += 1; await gate; return base.nativeQueueRead(id); } } as RuntimeHostClient,
      { nativeReconcileDeadlineMs: 60_000 });
    await kickStructuredDeliveryQueue();
    await kickStructuredDeliveryQueue();
    expect(reads).toBe(1);
    release();
    await until(() => states(s)["op-consumed"] === "delivered");
    expect(reads).toBe(1);
  } finally { await s.f.cleanup(); }
});
