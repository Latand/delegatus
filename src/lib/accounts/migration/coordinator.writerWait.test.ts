import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import type { AgentRegistry, ConversationObservation } from "@/lib/agent/registry";
import { holdBeforeEachWrite, longestLoopGap, registryLockHolder, sqliteRegistryFixture, type RegistryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { setBoardFileForTests } from "@/lib/board/store";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";

import { advanceConversationMigration, drainHeldDeliveries, reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";

/*
 * Rule (c) of docs/design/delivery-progress-and-drain.md for the
 * account-migration coordinator: every registry write it makes while it
 * drains held sends and advances the switch that holds them waits for the
 * write lock off the event loop, is correlated with its operation, and a write
 * the lock refused leaves the durable state the next pass resumes from. A
 * separate process holds the lock; the heartbeat measures this process's loop.
 */

const HEARTBEAT_BOUND_MS = 50;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => resetBlockingWaitsForTests(() => {}));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setBoardFileForTests(null);
});

function fixture(name: string, deadlineMs?: number): { store: AgentRegistry; holder: RegistryLockHolder } {
  const made = sqliteRegistryFixture(`llv-coordinator-writer-${name}`, deadlineMs !== undefined ? { sqliteWriterDeadlineMs: deadlineMs } : {});
  setBoardFileForTests(path.join(made.root, "board.json"));
  const holder = registryLockHolder(made.sqliteFilename);
  cleanups.push(made.cleanup, () => made.registry.close?.(), () => holder.close());
  return { store: made.registry, holder };
}

function observation(pathname: string, accountId: string): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo", title: `Title ${pathname}` }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  };
}

/** A provider whose successor identity follows the migration operation, as
    the real ones do: a repeated `create` returns the same successor. */
function provider(options: {
  counts?: { create: number; verify: number; publish: number; successors: Set<string> };
  continuity?: boolean;
  beforeReceipt?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  failVerify?: (conversationId: string) => boolean;
  cleanup?: () => void;
} = {}): SuccessorProviderPort {
  const counts = options.counts ?? { create: 0, verify: 0, publish: 0, successors: new Set<string>() };
  const owners = new Map<string, string>();
  return {
    virtualSource: true,
    async create(input) {
      counts.create += 1;
      const nativeId = `successor-${input.operationId}`;
      counts.successors.add(nativeId);
      owners.set(nativeId, input.conversationId);
      if (options.continuity) await input.recordContinuityPath(`/forks/${nativeId}.jsonl`);
      await options.beforeReceipt?.();
      return {
        operationId: input.operationId,
        nativeId,
        path: `/successors/${nativeId}.jsonl`,
        continuityPaths: [],
        historyHash: `hash-${nativeId}`,
        host: { kind: "codex-app-server", identity: `host-${nativeId}`, epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
      };
    },
    async verify(receipt) {
      counts.verify += 1;
      if (options.failVerify?.(owners.get(receipt.nativeId) ?? "")) throw new Error("successor verification failed");
    },
    async publishHost() {
      counts.publish += 1;
      await options.beforeCommit?.();
    },
    async cleanup() { options.cleanup?.(); },
  };
}

function port(delivered: string[]): HeldDeliveryPort {
  return { async deliver({ clientMessageId }) { delivered.push(clientMessageId); return "delivered"; } };
}

function waits(label: string) {
  return blockingWaitDiagnostics().longest.filter((sample) => sample.site === "registry-lock-async" && sample.label === label);
}

function startSwitch(store: AgentRegistry, names: string[], requestId: string) {
  store.reconcileConversations(names.map((name) => observation(`/${name}.jsonl`, "a")));
  const conversations = names.map((name) => store.conversationForPath(`/${name}.jsonl`)!);
  store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId, expectedRevision: store.engineRouting("codex").revision });
  return conversations;
}

describe("the account-migration coordinator's registry writes wait off the event loop", () => {
  test("the drain's claim and settle wait for a lock held elsewhere, correlated with the send's operation", async () => {
    const { store, holder } = fixture("drain");
    const [conversation] = startSwitch(store, ["drain-wait"], "drain-wait");
    await advanceConversationMigration(conversation!.id, store, provider());
    const held = store.holdDelivery(conversation!.id, "drain fixture", "drain-wait-1");
    const delivered: string[] = [];

    resetBlockingWaitsForTests(() => {});
    const hook = holdBeforeEachWrite(store, holder, 150, /coordinator\.ts/);
    const { gapMs } = await longestLoopGap(() => drainHeldDeliveries(conversation!.id, port(delivered), store));
    hook.restore();
    expect(hook.unwrapped).toEqual([]);

    expect(delivered).toEqual(["drain-wait-1"]);
    expect(store.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivered", attempts: 1 });
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    for (const label of ["delivery.claim", "delivery.settle"]) {
      expect(waits(label)[0]).toMatchObject({ synchronous: false, operationId: held.command.operationId });
    }
    expect(blockingWaitDiagnostics().sites["registry-lock"]?.synchronousCount ?? 0).toBe(0);
  });

  test("every write that advances a switch waits off the loop, the failure transition and the cleanup records included", async () => {
    const { store, holder } = fixture("advance");
    const [moving, failing] = startSwitch(store, ["advance-moving", "advance-failing"], "advance-wait");
    store.holdDelivery(moving!.id, "moving fixture", "advance-moving-1");
    const delivered: string[] = [];
    let cleaned = 0;
    const switching = provider({ continuity: true, failVerify: (id) => id === failing!.id, cleanup: () => { cleaned += 1; } });

    resetBlockingWaitsForTests(() => {});
    const hook = holdBeforeEachWrite(store, holder, 120, /coordinator\.ts/);
    const { gapMs } = await longestLoopGap(() => reconcileMigrations(switching, port(delivered), store, { passBudgetMs: 25_000 }));
    hook.restore();
    expect(hook.unwrapped).toEqual([]);

    expect(store.conversation(moving!.id)!.migration).toMatchObject({ phase: "committed" });
    expect(store.conversation(failing!.id)!.migration).toMatchObject({ phase: "failed-recoverable" });
    expect(delivered).toEqual(["advance-moving-1"]);
    expect(cleaned).toBe(1);
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    const movingOperation = store.conversation(moving!.id)!.migration!.operationId;
    for (const label of ["migration.transition", "migration.continuity", "migration.receipt", "migration.commit"]) {
      expect(waits(label).some((sample) => sample.operationId === movingOperation)).toBe(true);
    }
    const failingOperation = store.conversation(failing!.id)!.migration!.operationId;
    expect(waits("migration.transition").some((sample) => sample.operationId === failingOperation)).toBe(true);
    expect(waits("migration.cleanup").length).toBeGreaterThan(0);
    expect(blockingWaitDiagnostics().sites["registry-lock"]?.synchronousCount ?? 0).toBe(0);
  }, 30_000);

  test("a commit refused for the lock leaves the switch verifying and the next pass commits it once, carrying the held send once", async () => {
    const { store, holder } = fixture("commit", 150);
    const [conversation] = startSwitch(store, ["commit-refused"], "commit-refused");
    const held = store.holdDelivery(conversation!.id, "commit fixture", "commit-refused-1");
    const counts = { create: 0, verify: 0, publish: 0, successors: new Set<string>() };
    let refuse = true;
    const switching = provider({ counts, beforeCommit: async () => { if (refuse) { refuse = false; await holder.hold(600); } } });
    const delivered: string[] = [];

    const { gapMs } = await longestLoopGap(() => reconcileMigrations(switching, port(delivered), store));
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "verifying" });
    expect(store.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "held" });
    expect(delivered).toEqual([]);
    expect(waits("migration.commit")[0]).toMatchObject({ operationId: store.conversation(conversation!.id)!.migration!.operationId });

    await new Promise((resolve) => setTimeout(resolve, 700));
    await reconcileMigrations(switching, port(delivered), store);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "committed" });
    expect(delivered).toEqual(["commit-refused-1"]);
    expect(counts.successors.size).toBe(1);
    expect(store.conversation(conversation!.id)!.generations).toHaveLength(2);
  });

  test("an advancement whose provider receipt the lock refused resumes on the next pass with the same successor", async () => {
    const { store, holder } = fixture("receipt", 150);
    const [conversation] = startSwitch(store, ["receipt-refused"], "receipt-refused");
    store.holdDelivery(conversation!.id, "receipt fixture", "receipt-refused-1");
    const counts = { create: 0, verify: 0, publish: 0, successors: new Set<string>() };
    let refuse = true;
    const switching = provider({ counts, beforeReceipt: async () => { if (refuse) { refuse = false; await holder.hold(600); } } });
    const delivered: string[] = [];

    const { gapMs } = await longestLoopGap(() => reconcileMigrations(switching, port(delivered), store));
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "successor-starting", providerReceipt: null });
    expect(waits("migration.receipt").length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 700));
    await reconcileMigrations(switching, port(delivered), store);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "committed" });
    expect(counts).toMatchObject({ create: 2, verify: 1, publish: 1 });
    expect(counts.successors.size).toBe(1);
    expect(delivered).toEqual(["receipt-refused-1"]);
  });

  test("a refused continuity path and a refused phase transition resume the same way", async () => {
    const { store, holder } = fixture("transition", 150);
    const [conversation] = startSwitch(store, ["transition-refused"], "transition-refused");
    store.holdDelivery(conversation!.id, "transition fixture", "transition-refused-1");
    const counts = { create: 0, verify: 0, publish: 0, successors: new Set<string>() };
    const switching = provider({ counts, continuity: true });
    const delivered: string[] = [];
    const phase = store.conversation(conversation!.id)!.migration!.phase;

    await holder.hold(600);
    const { gapMs } = await longestLoopGap(() => reconcileMigrations(switching, port(delivered), store));
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    expect(store.conversation(conversation!.id)!.migration!.phase).toBe(phase);
    expect(counts.create).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 650));

    let refuse = true;
    const continuing = provider({ counts, continuity: true, beforeReceipt: async () => {} });
    const refusing: SuccessorProviderPort = {
      ...continuing,
      async create(input) {
        if (!refuse) return continuing.create(input);
        refuse = false;
        await holder.hold(600);
        return continuing.create(input);
      },
    };
    await reconcileMigrations(refusing, port(delivered), store);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "successor-starting", providerReceipt: null });
    expect(store.conversation(conversation!.id)!.continuityPaths).toEqual([]);
    expect(waits("migration.continuity").length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 700));
    await reconcileMigrations(refusing, port(delivered), store);
    expect(store.conversation(conversation!.id)!.migration).toMatchObject({ phase: "committed" });
    expect(counts.successors.size).toBe(1);
    expect(delivered).toEqual(["transition-refused-1"]);
  });

  test("an orphan cancellation the lock refused leaves its conversation undrained for that pass", async () => {
    const { store, holder } = fixture("orphan", 150);
    store.reconcileConversations([observation("/orphan-wait.jsonl", "a")]);
    const conversation = store.conversationForPath("/orphan-wait.jsonl")!;
    const claimed = store.holdDelivery(conversation.id, "claimed fixture", "orphan-claimed");
    store.beginDeliveryAttempt(claimed.id, claimed.generationId!);
    const orphan = store.holdDelivery(conversation.id, "orphan fixture", "orphan-assigned");
    const reconciled: string[] = [];
    const reconciling: HeldDeliveryPort = {
      async deliver() { throw new Error("nothing assigned may be delivered here"); },
      async reconcileUncertain({ clientMessageId }) { reconciled.push(clientMessageId); return "delivered"; },
    };

    await holder.hold(600);
    const { gapMs } = await longestLoopGap(() => reconcileMigrations(provider(), reconciling, store));
    expect(gapMs).toBeLessThan(HEARTBEAT_BOUND_MS);
    expect(reconciled).toEqual([]);
    expect(store.snapshot().heldDeliveries[orphan.id]).toMatchObject({ state: "assigned" });
    expect(waits("delivery.cancel")[0]).toMatchObject({ operationId: orphan.command.operationId });

    await new Promise((resolve) => setTimeout(resolve, 650));
    await reconcileMigrations(provider(), reconciling, store);
    expect(store.snapshot().heldDeliveries[orphan.id]?.state ?? "failed").toBe("failed");
    expect(reconciled).toEqual(["orphan-claimed"]);
  });
});
