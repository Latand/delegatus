import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, expect, spyOn, test } from "bun:test";

import { MIGRATION_INTENT_PROGRESS_TIMEOUT_MS } from "@/lib/accounts/migration/intentLiveness";
import { terminalizeStaleUndeliverableHeldDeliveries } from "@/lib/reaperRuntime";

import { AgentRegistry, MIGRATION_STOP_SLICE_ROWS, type RegistryFile } from "./registry";
import {
  buildMigrationStopFixture,
  MIGRATION_STOP_INCIDENT_SHAPE,
  MIGRATION_STOP_SOURCE,
  MIGRATION_STOP_TARGET,
  registryRowsForComparison,
  type MigrationStopFixture,
  type MigrationStopFixtureShape,
} from "./registry.migrationStop.fixture";

/*
 * Stopping an account migration held the registry's write lock for the whole
 * engine (docs/design/viewer-stalls-root-cause.md, section 4.1): a stop that
 * had three conversations to settle rewrote eleven thousand in one transaction
 * and every other writer was refused meanwhile. These hold the stop to bounded
 * transactions and to the rows the single transaction wrote. Every registry is
 * a private temporary file.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-stop-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/* More source conversations than two slices, so a sweep is several transactions. */
const SHAPE: MigrationStopFixtureShape = {
  sourceConversations: MIGRATION_STOP_SLICE_ROWS * 2 + 30,
  targetConversations: 20,
  otherEngineConversations: 10,
  deliveredDeliveries: 300,
};
const template = buildMigrationStopFixture(path.join(root, "template"), SHAPE);
let copies = 0;

function fixtureCopy(): MigrationStopFixture {
  const directory = path.join(root, `copy-${copies++}`);
  fs.cpSync(path.dirname(template.filename), directory, { recursive: true });
  return { ...template, filename: path.join(directory, "registry.json"), sqliteFilename: path.join(directory, "registry.sqlite") };
}

function open(fixture: MigrationStopFixture, options: { sqliteWriterDeadlineMs?: number } = {}): AgentRegistry {
  return new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite", ...options });
}

/** Rows with the times a run stamps removed, so two runs of one fixture compare. */
function comparableRows(fixture: MigrationStopFixture): string {
  return JSON.stringify(registryRowsForComparison(fixture.filename),
    (key, value) => key === "updatedAt" || key === "stoppedAt" || key === "settledAt" ? "<time>" : value);
}

function optedOut(file: RegistryFile, ids: readonly string[]): string[] {
  return ids.filter(id => file.conversations[id]?.migrationOptOut?.targetId === MIGRATION_STOP_TARGET);
}

test("a stop writes what one transaction over the engine wrote, and nothing else", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    const before = structuredClone(registry.snapshot());

    const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });

    if (!stopped.acquired) throw new Error("the stop must be admitted");
    const after = registry.snapshot();
    const intent = after.migrationIntents[fixture.intentId]!;
    expect(intent.state).toBe("stopped");
    expect(intent.stoppedAt).not.toBeNull();
    expect(intent.stopSweep).toBeUndefined();
    const stamp = intent.updatedAt;
    /* Every conversation of the engine that is not on the target is opted out, with the stop's own time. */
    for (const id of [...fixture.sourceConversationIds, ...fixture.requested.map(owned => owned.conversationId)]) {
      expect(after.conversations[id]!.migrationOptOut).toEqual({ targetId: MIGRATION_STOP_TARGET, updatedAt: stamp });
      expect(after.conversations[id]!.updatedAt).toBe(stamp);
    }
    /* Conversations on the target and another engine's conversations are the rows they were. */
    for (const id of [...fixture.targetConversationIds, ...fixture.otherEngineConversationIds, fixture.committedConversationId]) {
      expect(after.conversations[id]).toEqual(before.conversations[id]!);
    }
    /* What the intent still owned is rolled back and its held input cancelled, never attempted. */
    for (const owned of fixture.requested) {
      expect(after.conversations[owned.conversationId]!.migration).toMatchObject({ intentId: fixture.intentId, phase: "rolled-back", updatedAt: stamp });
      expect(after.heldDeliveries[owned.heldDeliveryId]).toMatchObject({
        state: "failed", attempts: 0, generationId: null, error: expect.stringContaining("migration was stopped"),
      });
    }
    expect(Object.values(after.heldDeliveries).filter(delivery => delivery.state === "delivered")).toHaveLength(SHAPE.deliveredDeliveries);
    /* The held input stays pending evidence, so no conversation's readiness moved and no revision did. */
    expect(registry.engineRouting("codex")).toEqual(before.engineRouting.codex);
    expect(registry.engineRouting("claude")).toEqual(before.engineRouting.claude);
  } finally {
    registry.close();
  }
});

test("the stop in bounded transactions leaves the rows the back-to-back form leaves", async () => {
  const sliced = fixtureCopy();
  const whole = fixtureCopy();
  const slicedRegistry = open(sliced);
  const wholeRegistry = open(whole);
  try {
    await slicedRegistry.stopMigrationIntent(sliced.intentId, { expectedRevision: sliced.intentRevision });
    const stopped = wholeRegistry.setMigrationIntentState(whole.intentId, "stopped", whole.intentRevision);
    expect(stopped.state).toBe("stopped");
    expect(stopped.stopSweep).toBeUndefined();
  } finally {
    slicedRegistry.close();
    wholeRegistry.close();
  }
  expect(comparableRows(sliced)).toBe(comparableRows(whole));
});

test("no transaction of a stop writes more than one slice of conversations", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  /* Each committed mutation persists its changed rows once; count the conversations in each. */
  type Changes = { rows: Map<string, Set<string>> };
  const store = (registry as unknown as { sqliteStore: { persistChanges: (file: unknown, changes: Changes, revision: number) => void } }).sqliteStore;
  const persistChanges = store.persistChanges.bind(store);
  const written: number[] = [];
  store.persistChanges = (file, changes, revision) => {
    const conversations = changes.rows.get("conversations")?.size ?? 0;
    if (conversations > 0) written.push(conversations);
    persistChanges(file, changes, revision);
  };
  try {
    await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
  } finally {
    registry.close();
  }
  expect(Math.max(...written)).toBeLessThanOrEqual(MIGRATION_STOP_SLICE_ROWS);
  expect(written.reduce((sum, count) => sum + count, 0)).toBe(SHAPE.sourceConversations + template.requested.length);
  expect(written.length).toBeGreaterThanOrEqual(Math.ceil(SHAPE.sourceConversations / MIGRATION_STOP_SLICE_ROWS));
});

test("a refused stop changes nothing, and a refused sweep keeps the stop's decision until it is resumed", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture, { sqliteWriterDeadlineMs: 60 });
  const peer = new Database(fixture.sqliteFilename);
  let held = false;
  try {
    const before = comparableRows(fixture);
    registry.readOnlySnapshot();
    peer.exec("BEGIN IMMEDIATE");
    held = true;
    expect(await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).toEqual({ acquired: false });
    peer.exec("ROLLBACK");
    held = false;
    expect(comparableRows(fixture)).toBe(before);

    /* The stop commits, then another writer takes the lock before the sweep's first slice. */
    const continueStop = registry.continueMigrationStop.bind(registry);
    const sweep = spyOn(registry, "continueMigrationStop").mockImplementationOnce(async (id, reason) => {
      peer.exec("BEGIN IMMEDIATE");
      held = true;
      return continueStop(id, reason);
    });
    const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
    sweep.mockRestore();
    expect(stopped.acquired).toBe(true);
    const interrupted = registry.readOnlySnapshot();
    const marker = interrupted.migrationIntents[fixture.intentId]!.stopSweep;
    expect(marker).toEqual({ stampedAt: interrupted.migrationIntents[fixture.intentId]!.updatedAt, optOut: true });
    expect(optedOut(interrupted, fixture.sourceConversationIds)).toHaveLength(0);
    /* The intent's own conversations were settled by the stop itself. */
    for (const owned of fixture.requested) {
      expect(interrupted.conversations[owned.conversationId]!.migration?.phase).toBe("rolled-back");
      expect(interrupted.heldDeliveries[owned.heldDeliveryId]?.state).toBe("failed");
    }
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(false);
    peer.exec("ROLLBACK");
    held = false;

    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
    expect(finished.conversations[fixture.sourceConversationIds[0]!]!.migrationOptOut?.updatedAt).toBe(marker!.stampedAt);
  } finally {
    if (held) peer.exec("ROLLBACK");
    peer.close();
    registry.close();
  }
});

/** A stop whose sweep never ran: the process ended, or every write was refused. */
async function stopWithoutSweep(registry: AgentRegistry, fixture: MigrationStopFixture): Promise<string> {
  const sweep = spyOn(registry, "continueMigrationStop").mockResolvedValueOnce(false);
  const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
  sweep.mockRestore();
  if (!stopped.acquired) throw new Error("the stop must be admitted");
  const marker = registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep;
  if (!marker) throw new Error("an interrupted stop keeps its marker");
  return marker.stampedAt;
}

test("until the sweep reaches a conversation, the stop's opt-out is read from the intent", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    const stampedAt = await stopWithoutSweep(registry, fixture);
    const unswept = fixture.sourceConversationIds[5]!;
    expect(registry.readOnlySnapshot().conversations[unswept]!.migrationOptOut).toBeNull();
    /* A conversation that starts after the stop was never part of its decision. */
    await new Promise(resolve => setTimeout(resolve, 5));
    const later = registry.ensureConversation("codex", "/sessions/started-after-the-stop.jsonl", MIGRATION_STOP_SOURCE);
    expect(later.createdAt > stampedAt).toBe(true);

    /* A send to an unswept conversation does not follow routing onto the stopped target. */
    expect(registry.requestConversationMigrationToActiveAccount(unswept as typeof later.id).migration).toBeNull();
    expect(registry.requestConversationMigrationToActiveAccount(later.id).migration).toMatchObject({ targetId: MIGRATION_STOP_TARGET, phase: "requested" });

    /* An automatic migration to the same target leaves the stopped conversations where they are. */
    const auto = registry.commitMigrationIntent({
      engine: "codex", targetId: MIGRATION_STOP_TARGET, origin: "auto", requestId: "auto-after-stop",
      expectedRevision: registry.engineRouting("codex").revision, scope: "all",
    });
    const enrolled = Object.values(registry.readOnlySnapshot().conversations)
      .filter(conversation => conversation.migration?.intentId === auto.id).map(conversation => conversation.id);
    expect(enrolled).toEqual([later.id]);

    /* The sweep still writes the decision afterwards, and only onto the conversations it covered. */
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
    expect(finished.conversations[later.id]!.migrationOptOut).toBeNull();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
  } finally {
    registry.close();
  }
});

test("a manual migration to the stopped target withdraws the opt-outs the sweep has not written", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    await stopWithoutSweep(registry, fixture);
    const manual = registry.commitMigrationIntent({
      engine: "codex", targetId: MIGRATION_STOP_TARGET, origin: "manual", requestId: "manual-after-stop",
      expectedRevision: registry.engineRouting("codex").revision, scope: "all",
    });
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(0);
    for (const id of fixture.sourceConversationIds.slice(0, 20)) {
      expect(finished.conversations[id]!.migration).toMatchObject({ intentId: manual.id, phase: "requested" });
    }
  } finally {
    registry.close();
  }
});

test("a stop interrupted before its sweep is finished by the hygiene pass of the next process", async () => {
  const interrupted = fixtureCopy();
  const uninterrupted = fixtureCopy();
  const first = open(interrupted);
  let stampedAt: string;
  try { stampedAt = await stopWithoutSweep(first, interrupted); }
  finally { first.close(); }

  /* The marker is durable: a registry opened afterwards resumes from it. */
  const second = open(interrupted);
  try {
    expect(second.readOnlySnapshot().migrationIntents[interrupted.intentId]!.stopSweep).toEqual({ stampedAt, optOut: true });
    await terminalizeStaleUndeliverableHeldDeliveries(second, Date.parse(stampedAt) + 1_000);
    const finished = second.readOnlySnapshot();
    expect(finished.migrationIntents[interrupted.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, interrupted.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
  } finally {
    second.close();
  }

  /* The same stop and the same later pass, with nothing in between to interrupt it. */
  const whole = open(uninterrupted);
  try {
    const stopped = await whole.stopMigrationIntent(uninterrupted.intentId, { expectedRevision: uninterrupted.intentRevision });
    if (!stopped.acquired) throw new Error("the stop must be admitted");
    await terminalizeStaleUndeliverableHeldDeliveries(whole, Date.parse(stopped.value.updatedAt) + 1_000);
  } finally { whole.close(); }
  expect(comparableRows(interrupted)).toBe(comparableRows(uninterrupted));
});

test("a stale revision refuses the stop before anything is written", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    const before = comparableRows(fixture);
    await expect(registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision + 1 }))
      .rejects.toThrow("migration intent revision is stale");
    await expect(registry.stopMigrationIntent("missing-intent")).rejects.toThrow("migration intent is unknown");
    expect(comparableRows(fixture)).toBe(before);
  } finally {
    registry.close();
  }
});

/*
 * The recurrence test for section 4.1, at the size of the incident: 14 000
 * conversations on one engine and 27 000 deliveries. The hygiene pass stops
 * the stale intent in a process of its own, as the account-migration helper
 * does, while this process keeps admitting deliveries. On the code before the
 * fix that pass holds one write transaction for the whole stop and the first
 * delivery write made meanwhile is refused.
 */
test("a stale intent is stopped at incident size without holding other writers out", async () => {
  const fixture = buildMigrationStopFixture(path.join(root, "incident"), MIGRATION_STOP_INCIDENT_SHAPE);
  const directory = path.dirname(fixture.filename);
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const result = path.join(directory, "result.json");
  const registry = open(fixture, { sqliteWriterDeadlineMs: 1_000 });
  /* A conversation holds a bounded number of deliveries, so the admissions go round the ones on the target. */
  const target = (index: number) =>
    fixture.targetConversationIds[index % fixture.targetConversationIds.length]! as Parameters<AgentRegistry["holdDelivery"]>[0];
  const child = Bun.spawn([
    process.execPath, path.join(import.meta.dir, "registry.migrationStop.child.ts"),
    fixture.filename, fixture.intentUpdatedAt, ready, release, result,
  ], { stdout: "ignore", stderr: "inherit", env: { ...process.env, NODE_ENV: "test" } });
  const admissions: Array<{ acquired: boolean; waitedMs: number; duringStop: boolean }> = [];
  try {
    registry.readOnlySnapshot();
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null) throw new Error(`the stopping process ended early with ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    fs.writeFileSync(release, "go");
    while (!fs.existsSync(result) && child.exitCode === null) {
      const duringStop = fs.existsSync(`${ready}.started`);
      const startedAt = performance.now();
      const written = await registry.deliveryWrite({ label: "delivery.admit" },
        () => registry.holdDelivery(target(admissions.length), `admitted during the stop ${admissions.length}`, `during-stop-${admissions.length}`));
      admissions.push({ acquired: written.acquired, waitedMs: performance.now() - startedAt, duringStop: duringStop && !fs.existsSync(result) });
      /* One refusal is the defect; waiting out the rest of a minutes-long hold proves nothing more. */
      if (!written.acquired) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const refused = admissions.filter(admission => !admission.acquired);
    expect(refused).toEqual([]);
    expect(await child.exited).toBe(0);
    const pass = JSON.parse(fs.readFileSync(result, "utf8")) as { transactions: Array<{ label: string; heldMs: number; rows: number }> };
    /* The bound that does not depend on the machine: no transaction writes more than the stop's own rows or one slice. */
    expect(Math.max(...pass.transactions.map(transaction => transaction.rows))).toBeLessThanOrEqual(MIGRATION_STOP_SLICE_ROWS * 2);
    /* And in time. Measured, the longest hold is 93 to 204 ms; a commit that the
       scheduler or a checkpoint delays on a loaded machine may pass 250 ms, so
       one in a hundred may, and none may reach the one second a writer waits. */
    const held = pass.transactions.map(transaction => transaction.heldMs).sort((left, right) => left - right);
    expect(held[Math.floor(held.length * 0.99) - 1]!).toBeLessThan(250);
    expect(held.at(-1)!).toBeLessThan(1_000);
    const during = admissions.filter(admission => admission.duringStop);
    expect(during.length).toBeGreaterThan(0);
    expect(Math.max(...during.map(admission => admission.waitedMs))).toBeLessThan(1_000);
    const stopped = registryRowsForComparison(fixture.filename) as unknown as RegistryFile;
    expect(stopped.migrationIntents[fixture.intentId]).toMatchObject({ state: "stopped" });
    expect(stopped.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(stopped, fixture.sourceConversationIds)).toHaveLength(MIGRATION_STOP_INCIDENT_SHAPE.sourceConversations);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    registry.close();
  }
}, 600_000);

test("the hygiene pass leaves an intent that still makes progress alone", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    await terminalizeStaleUndeliverableHeldDeliveries(registry, Date.parse(fixture.intentUpdatedAt) + MIGRATION_INTENT_PROGRESS_TIMEOUT_MS - 1_000);
    expect(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.state).toBe("draining");
    expect(optedOut(registry.readOnlySnapshot(), fixture.sourceConversationIds)).toHaveLength(0);
  } finally {
    registry.close();
  }
});
