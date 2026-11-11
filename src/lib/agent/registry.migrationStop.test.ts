import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { emptyLaunchProfile, type HeldDelivery, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
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
afterEach(() => { setSystemTime(); });

/* More source conversations than two slices, so a sweep is several transactions. */
const SHAPE: MigrationStopFixtureShape = {
  sourceConversations: MIGRATION_STOP_SLICE_ROWS * 2 + 30,
  targetConversations: 20,
  otherEngineConversations: 10,
  deliveredDeliveries: 300,
};
const template = buildMigrationStopFixture(path.join(root, "template"), SHAPE);
let copies = 0;

function fixtureCopy(of: MigrationStopFixture = template): MigrationStopFixture {
  const directory = path.join(root, `copy-${copies++}`);
  fs.cpSync(path.dirname(of.filename), directory, { recursive: true });
  return { ...of, filename: path.join(directory, "registry.json"), sqliteFilename: path.join(directory, "registry.sqlite") };
}

/* The fixture at the size of the incident takes seconds to build: built once, when a test first needs it. */
let incidentTemplate: MigrationStopFixture | null = null;
function incidentCopy(): MigrationStopFixture {
  incidentTemplate ??= buildMigrationStopFixture(path.join(root, "incident"), MIGRATION_STOP_INCIDENT_SHAPE);
  return fixtureCopy(incidentTemplate);
}

type ConversationId = Parameters<AgentRegistry["conversation"]>[0];
const LATER_TARGET = "account-later-target";
/** The times of a sequence of decisions, one second apart; the registry stamps each decision with the clock it runs under. */
const at = (second: number) => `2030-01-01T00:00:0${second}.000Z`;
function clock(second: number): void {
  setSystemTime(new Date(at(second)));
}

function manualMigration(registry: AgentRegistry, targetId: string, origin: "manual" | "auto" = "manual") {
  return registry.commitMigrationIntent({
    engine: "codex", targetId, origin, requestId: `${origin}-to-${targetId}-${registry.engineRouting("codex").revision}`,
    expectedRevision: registry.engineRouting("codex").revision, scope: "all",
  });
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
      expect(after.conversations[id]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: stamp });
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
    expect(marker).toMatchObject({ stampedAt: interrupted.migrationIntents[fixture.intentId]!.updatedAt, optOut: true });
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
    expect(second.readOnlySnapshot().migrationIntents[interrupted.intentId]!.stopSweep).toMatchObject({ stampedAt, optOut: true });
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
  const fixture = incidentCopy();
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

/*
 * The order of decisions (section 12.7). A stop decides the engine-wide
 * opt-out at its own time and its sweep writes it later. Whatever is decided
 * for a conversation in between is the newer decision and has to stand,
 * whether the sweep reaches the conversation before it or after it.
 */

test("a stop resumed after a later stop of another target leaves the later opt-out standing", async () => {
  for (const sameInstant of [false, true]) {
    const fixture = fixtureCopy();
    const registry = open(fixture);
    const step = (second: number) => clock(sameInstant ? 0 : second);
    const stamp = (second: number) => at(sameInstant ? 0 : second);
    const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
    try {
      step(0);
      await stopWithoutSweep(registry, fixture);
      step(1);
      const later = manualMigration(registry, LATER_TARGET);
      step(2);
      const stopped = await registry.stopMigrationIntent(later.id);
      expect(stopped.acquired).toBe(true);
      /* The rolled-back migration is spent and the hygiene pass clears it: nothing on the conversation says it moved after the first stop. */
      step(3);
      expect(registry.clearRolledBackConversationMigration(id, later.id)).toBe(true);
      expect(registry.conversation(id)).toMatchObject({ migration: null, migrationOptOut: { targetId: LATER_TARGET, updatedAt: stamp(2) } });

      step(4);
      expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);

      const finished = registry.readOnlySnapshot();
      expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
      expect(finished.migrationIntents[later.id]!.stopSweep).toBeUndefined();
      for (const source of fixture.sourceConversationIds) {
        expect(finished.conversations[source]!.migrationOptOut).toMatchObject({ targetId: LATER_TARGET, updatedAt: stamp(2) });
      }
      /* A send does not follow routing onto the target that was just stopped. */
      step(5);
      expect(registry.requestConversationMigrationToActiveAccount(id).migration).toBeNull();
    } finally {
      registry.close();
    }
  }
});

/** What a later reader acts on, for every conversation: the opt-out that stands, the migration, the row's own time. */
function decisions(registry: AgentRegistry): string {
  const file = registry.snapshot();
  return JSON.stringify(Object.keys(file.conversations).sort().map((id) => {
    const conversation = file.conversations[id]!;
    /* A withdrawal that kept its time stands for no opt-out. */
    const optOut = conversation.migrationOptOut?.targetId ? conversation.migrationOptOut : null;
    return [id, optOut?.targetId ?? null, optOut?.updatedAt ?? null,
      conversation.migration?.targetId ?? null, conversation.migration?.phase ?? null, conversation.updatedAt];
  }), null, 1);
}

const pinnedTemplate = buildMigrationStopFixture(path.join(root, "pinned"), { ...SHAPE, pinnedSourceConversations: 3 });

/* What is decided after a stop. Each runs once on a registry whose sweep
   finished before it and once on a registry whose sweep had not started. */
const laterDecisions: Array<[string, (registry: AgentRegistry, fixture: MigrationStopFixture) => Promise<void>]> = [
  ["a manual migration to another target", async (registry) => {
    clock(1);
    manualMigration(registry, LATER_TARGET);
  }],
  ["a manual migration to another target that is stopped and cleaned up", async (registry, fixture) => {
    clock(1);
    const later = manualMigration(registry, LATER_TARGET);
    clock(2);
    await registry.stopMigrationIntent(later.id);
    clock(3);
    for (const id of fixture.sourceConversationIds.slice(10, 15)) {
      expect(registry.clearRolledBackConversationMigration(id as ConversationId, later.id)).toBe(true);
    }
  }],
  ["a reseat onto the stopped target", async (registry, fixture) => {
    clock(1);
    registry.requestConversationReseat(fixture.sourceConversationIds[40]! as ConversationId, MIGRATION_STOP_TARGET);
  }],
  ["a reseat onto the stopped target that is rolled back after routing moved on, and cleaned up", async (registry, fixture) => {
    const id = fixture.sourceConversationIds[40]! as ConversationId;
    clock(1);
    const reseated = registry.requestConversationReseat(id, MIGRATION_STOP_TARGET);
    clock(2);
    registry.setEngineRouting("codex", LATER_TARGET);
    clock(3);
    registry.rollbackConversationMigration(id, reseated.migration!.revision);
    expect(registry.clearRolledBackConversationMigration(id, reseated.migration!.intentId)).toBe(true);
    expect(registry.conversation(id)!.migration).toBeNull();
  }],
  ["a reseat onto the stopped target that is rolled back at once", async (registry, fixture) => {
    const id = fixture.sourceConversationIds[40]! as ConversationId;
    clock(1);
    const reseated = registry.requestConversationReseat(id, MIGRATION_STOP_TARGET);
    clock(2);
    registry.rollbackConversationMigration(id, reseated.migration!.revision);
  }],
  ["an automatic migration back to the stopped target", async (registry) => {
    clock(1);
    manualMigration(registry, MIGRATION_STOP_TARGET, "auto");
  }],
  ["a manual migration back to the stopped target", async (registry) => {
    clock(1);
    manualMigration(registry, MIGRATION_STOP_TARGET);
  }],
  ["a second stop of the same intent after routing moved on", async (registry, fixture) => {
    clock(1);
    registry.setEngineRouting("codex", LATER_TARGET);
    clock(2);
    expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
  }],
  ["a second stop of the same intent while routing stays on its target", async (registry, fixture) => {
    clock(1);
    expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
  }],
];

for (const [name, decide] of laterDecisions) {
  test(`decided after a stop, ${name} leaves the rows it leaves when the sweep had finished first`, async () => {
    const outcome: string[] = [];
    for (const deferred of [false, true]) {
      const fixture = fixtureCopy(pinnedTemplate);
      let registry = open(fixture);
      try {
        clock(0);
        if (deferred) await stopWithoutSweep(registry, fixture);
        else expect((await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).acquired).toBe(true);
        expect(Boolean(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep)).toBe(deferred);

        await decide(registry, fixture);

        /* The sweep is resumed by another process: the marker and every stored decision are read back from the store. */
        registry.close();
        registry = open(fixture);
        clock(6);
        expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
        for (const intent of Object.values(registry.readOnlySnapshot().migrationIntents)) expect(intent.stopSweep).toBeUndefined();
        /* What a send then does with three of the conversations: a pinned one, a plain one, the one a reseat named. */
        clock(7);
        for (const index of [0, 20, 40]) {
          registry.requestConversationMigrationToActiveAccount(fixture.sourceConversationIds[index]! as ConversationId);
        }
        outcome.push(decisions(registry));
      } finally {
        registry.close();
      }
    }
    expect(outcome[1]).toBe(outcome[0]!);
  });
}

test("a decision made while the sweep is between two transactions stands", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  /* Both are in the sweep's last slice, which the sweep has read and not yet written. */
  const withdrawn = fixture.sourceConversationIds.at(-1)! as ConversationId;
  const optedOutLater = fixture.sourceConversationIds.at(-2)! as ConversationId;
  try {
    clock(0);
    await stopWithoutSweep(registry, fixture);
    const write = registry.deliveryWrite.bind(registry);
    let transactions = 0;
    const between = spyOn(registry, "deliveryWrite").mockImplementation(((correlation, operation, correlate) => {
      transactions += 1;
      if (transactions === 2) {
        clock(1);
        registry.requestConversationReseat(withdrawn, MIGRATION_STOP_TARGET);
        const reseated = registry.requestConversationReseat(optedOutLater, MIGRATION_STOP_TARGET);
        registry.rollbackConversationMigration(optedOutLater, reseated.migration!.revision);
        clock(2);
      }
      return write(correlation, operation, correlate);
    }) as typeof registry.deliveryWrite);
    const swept = await registry.continueMigrationStop(fixture.intentId);
    between.mockRestore();

    expect(swept).toBe(true);
    expect(transactions).toBeGreaterThan(2);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    /* The reseat withdrew the opt-out and the rollback opted out again, each after the stop. */
    expect(finished.conversations[withdrawn]!.migrationOptOut).toMatchObject({ targetId: null, updatedAt: at(1) });
    expect(finished.conversations[optedOutLater]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(1) });
    const others = fixture.sourceConversationIds.slice(0, -2);
    for (const id of others) expect(finished.conversations[id]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) });
  } finally {
    registry.close();
  }
  /* A registry opened afterwards reads the withdrawal as it was stored. */
  const reopened = open(fixture);
  try {
    expect(reopened.conversation(withdrawn)!.migrationOptOut).toMatchObject({ targetId: null, updatedAt: at(1) });
  } finally {
    reopened.close();
  }
});

test("a stop repeated while its sweep is between two transactions restarts the sweep under the new time", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    clock(0);
    await stopWithoutSweep(registry, fixture);
    const write = registry.deliveryWrite.bind(registry);
    let transactions = 0;
    let repeated: Promise<unknown> | null = null;
    const between = spyOn(registry, "deliveryWrite").mockImplementation((async (correlation, operation, correlate) => {
      transactions += 1;
      if (transactions === 2) {
        clock(1);
        repeated = registry.stopMigrationIntent(fixture.intentId);
        await repeated;
      }
      return write(correlation, operation, correlate);
    }) as typeof registry.deliveryWrite);
    /* The first sweep finds its marker replaced and ends; the repeated stop wrote every row. */
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    between.mockRestore();
    expect(repeated).not.toBeNull();

    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    for (const id of fixture.sourceConversationIds) {
      expect(finished.conversations[id]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(1) });
    }
  } finally {
    registry.close();
  }
});

test("a completion decided from a reading older than the stop does not end a sweep that is still writing", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    const stampedAt = await stopWithoutSweep(registry, fixture);
    /* The coordinator read the intent while it drained and writes its completion after the stop. */
    const completed = registry.setMigrationIntentState(fixture.intentId, "complete");
    expect(completed).toMatchObject({ state: "stopped", stopSweep: { stampedAt, optOut: true } });
    expect(registry.requestConversationMigrationToActiveAccount(fixture.sourceConversationIds[5]! as ConversationId).migration).toBeNull();

    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]).toMatchObject({ state: "stopped" });
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
    /* With the sweep over, the intent's state is written as it was before. */
    expect(registry.setMigrationIntentState(fixture.intentId, "complete").state).toBe("complete");
  } finally {
    registry.close();
  }
});

test("a view that cannot be read refuses the stop before it, and after it leaves the sweep for a later call", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    const before = comparableRows(fixture);
    const prepare = registry.prepareReadOnlySnapshot.bind(registry);
    const view = spyOn(registry, "prepareReadOnlySnapshot").mockRejectedValueOnce(new Error("the reader view is unavailable"));
    await expect(registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision }))
      .rejects.toThrow("the reader view is unavailable");
    expect(comparableRows(fixture)).toBe(before);

    /* The first view is read, the stop commits, and the sweep's own view fails. */
    let views = 0;
    view.mockImplementation(((signal, options) => {
      views += 1;
      return views === 2 ? Promise.reject(new Error("the reader view is unavailable")) : prepare(signal, options);
    }) as typeof registry.prepareReadOnlySnapshot);
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
    const warnings = warned.mock.calls.map((call) => String(call[0]));
    warned.mockRestore();
    view.mockRestore();
    expect(stopped.acquired).toBe(true);
    expect(warnings.filter((line) => line.includes("the reader view is unavailable"))).toHaveLength(1);
    const interrupted = registry.readOnlySnapshot();
    expect(interrupted.migrationIntents[fixture.intentId]).toMatchObject({ state: "stopped", stopSweep: { optOut: true } });
    expect(optedOut(interrupted, fixture.sourceConversationIds)).toHaveLength(0);

    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
  } finally {
    registry.close();
  }
});

test("a view prepared before the stop committed is not read as the sweep's own", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    /* A view of the registry as it was before the stop: the intent still drains in it. */
    const earlier = structuredClone(await registry.prepareReadOnlySnapshot(undefined, { recoveryIndexes: false }));
    const stampedAt = await stopWithoutSweep(registry, fixture);
    const prepare = registry.prepareReadOnlySnapshot.bind(registry);

    /* A caller that keeps being handed the earlier view writes nothing and keeps the marker. */
    const stale = spyOn(registry, "prepareReadOnlySnapshot").mockResolvedValue(earlier);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(false);
    expect(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep).toMatchObject({ stampedAt, optOut: true });
    expect(optedOut(registry.readOnlySnapshot(), fixture.sourceConversationIds)).toHaveLength(0);

    /* One earlier view, then the current one: the sweep reads from the current one and finishes. */
    stale.mockReset();
    stale.mockResolvedValueOnce(earlier).mockImplementation(prepare);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    stale.mockRestore();
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
  } finally {
    registry.close();
  }
});

/*
 * The loop (section 12.7). A write lock that is free is granted without a
 * wait, so a stop that only awaited its writes ran every transaction in one
 * turn of the loop: no timer, no request and no other delivery of the same
 * process ran until the stop was over.
 */

test("the loop gets a turn between every two transactions of a stop", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  let turns = 0;
  let counting = true;
  const turn = () => { turns += 1; if (counting) setImmediate(turn); };
  setImmediate(turn);
  const write = registry.deliveryWrite.bind(registry);
  const startedOnTurn: number[] = [];
  const observed = spyOn(registry, "deliveryWrite").mockImplementation(((correlation, operation, correlate) => {
    startedOnTurn.push(turns);
    return write(correlation, operation, correlate);
  }) as typeof registry.deliveryWrite);
  try {
    const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
    expect(stopped.acquired).toBe(true);
  } finally {
    counting = false;
    observed.mockRestore();
    registry.close();
  }
  /* The stop, a slice for every 32 conversations, and the last transaction that ends the sweep. */
  expect(startedOnTurn.length).toBe(1 + Math.ceil(SHAPE.sourceConversations / MIGRATION_STOP_SLICE_ROWS) + 1);
  for (let index = 1; index < startedOnTurn.length; index += 1) {
    expect(startedOnTurn[index]!).toBeGreaterThan(startedOnTurn[index - 1]!);
  }
});

/*
 * The recurrence test for the loop, at the size of the incident and in one
 * process, as the Viewer runs a stop asked for through its own route: a timer
 * and a delivery of the same process, both started before the stop.
 */
test("a stop at incident size leaves the same process's timers and deliveries running", async () => {
  const fixture = incidentCopy();
  const registry = open(fixture, { sqliteWriterDeadlineMs: 1_000 });
  /* The serving process keeps a prepared reader view; the stop does not pay for the first one. */
  await registry.prepareReadOnlySnapshot(undefined, { recoveryIndexes: false });
  const gaps: number[] = [];
  let stopEnded = false;
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const tick = performance.now();
    if (!stopEnded) gaps.push(tick - lastTick);
    lastTick = tick;
  }, 10);
  const dueAt = performance.now() + 10;
  const delivery = new Promise<{ acquired: boolean; lateMs: number; duringStop: boolean }>((resolve, reject) => {
    setTimeout(() => {
      const lateMs = performance.now() - dueAt;
      registry.deliveryWrite({ label: "delivery.admit" }, () => registry.holdDelivery(
        fixture.targetConversationIds[0]! as Parameters<AgentRegistry["holdDelivery"]>[0], "sent during the stop", "same-process-during-stop",
      )).then((written) => resolve({ acquired: written.acquired, lateMs, duringStop: !stopEnded }), reject);
    }, 10);
  });
  try {
    const stopped = await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision });
    stopEnded = true;
    const admission = await delivery;
    expect(stopped.acquired).toBe(true);
    expect(admission).toMatchObject({ acquired: true, duringStop: true });
    /* The timer was due 10 ms into the stop. Measured, it ran 22 to 53 ms late: behind the stop's own transaction. */
    expect(admission.lateMs).toBeLessThan(1_000);
    /* The stop is some four hundred transactions with a turn after each. Before, the timer did not run once. */
    expect(gaps.length).toBeGreaterThan(20);
    expect(Math.max(...gaps)).toBeLessThan(1_000);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(finished, fixture.sourceConversationIds)).toHaveLength(MIGRATION_STOP_INCIDENT_SHAPE.sourceConversations);
  } finally {
    clearInterval(timer);
    await delivery.catch(() => undefined);
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

/*
 * A stop is decided in one transaction and written onto the conversations in
 * many. The cases below hold that the decision is in force for every
 * conversation the intent owns from that first transaction on, wherever the
 * sweep has got to, and that decisions made in one instant keep the order they
 * were made in.
 */

/** The fixture's intent, enrolled over the whole engine: it owns more conversations than a stop settles in its own transaction. */
function enrollEngine(registry: AgentRegistry, fixture: MigrationStopFixture): void {
  const intent = manualMigration(registry, MIGRATION_STOP_TARGET);
  expect(intent.id).toBe(fixture.intentId);
}

/** Stops the intent with its sweep never run: every write of the sweep refused, or the process gone. */
async function stopIntentWithoutSweep(registry: AgentRegistry, intentId: string): Promise<void> {
  const sweep = spyOn(registry, "continueMigrationStop").mockResolvedValueOnce(false);
  try {
    expect((await registry.stopMigrationIntent(intentId)).acquired).toBe(true);
  } finally {
    sweep.mockRestore();
  }
}

/** Conversations whose stored migration the stop's own transaction did not reach. */
function unsweptOwned(registry: AgentRegistry, fixture: MigrationStopFixture): ConversationId[] {
  const file = registry.readOnlySnapshot();
  return fixture.sourceConversationIds.filter(id => file.conversations[id]!.migration?.phase !== "rolled-back") as ConversationId[];
}

/** Conversation rows each committed transaction wrote, in order. */
function conversationRowsPerTransaction(registry: AgentRegistry): number[] {
  type Changes = { rows: Map<string, Set<string>> };
  const store = (registry as unknown as { sqliteStore: { persistChanges: (file: unknown, changes: Changes, revision: number) => void } }).sqliteStore;
  const persistChanges = store.persistChanges.bind(store);
  const written: number[] = [];
  store.persistChanges = (file, changes, revision) => {
    written.push(changes.rows.get("conversations")?.size ?? 0);
    persistChanges(file, changes, revision);
  };
  return written;
}

/** What the stop left for every conversation and every delivery, without the identities a run mints. */
function stoppedOutcome(registry: AgentRegistry, only?: string): string {
  const file = registry.snapshot();
  const conversations = Object.keys(file.conversations).filter(id => !only || id === only).sort().map((id) => {
    const conversation = file.conversations[id]!;
    return [id, conversation.generations.length, conversation.generations.at(-1)!.accountId,
      conversation.migration?.targetId ?? null, conversation.migration?.phase ?? null, conversation.migrationOptOut?.targetId ?? null];
  });
  const deliveries = Object.values(file.heldDeliveries).filter(delivery => delivery.state !== "delivered" && (!only || delivery.conversationId === only))
    .map(delivery => [delivery.conversationId, delivery.clientMessageId, delivery.state, delivery.error])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ conversations, deliveries }, null, 1);
}

const successorReceipt = (operationId: string, name: string): ProviderReceipt => ({
  operationId, nativeId: name, path: `/sessions/${name}.jsonl`, continuityPaths: [], historyHash: `${name}-history`,
  host: { kind: "codex-app-server", identity: `${name}-host`, epoch: 1, verifiedAt: "2030-01-01T00:00:00.000Z" },
});

test("a stop is in force for every conversation its intent owns before the sweep reaches them", async () => {
  const fixture = fixtureCopy();
  let registry = open(fixture);
  try {
    enrollEngine(registry, fixture);
    const owned = fixture.sourceConversationIds.length + fixture.requested.length;
    expect(owned).toBeGreaterThan(MIGRATION_STOP_SLICE_ROWS * 2);
    clock(0);
    await stopIntentWithoutSweep(registry, fixture.intentId);

    /* The fence is the stored marker: the process that takes over finds it. */
    registry.close();
    registry = open(fixture);
    const unswept = unsweptOwned(registry, fixture);
    expect(unswept).toHaveLength(owned - MIGRATION_STOP_SLICE_ROWS);
    const stored = structuredClone(registry.readOnlySnapshot().conversations[unswept.at(-1)!]!);
    expect(stored.migration).toMatchObject({ intentId: fixture.intentId, phase: "requested" });

    /* A reader is told what the stop decided: rolled back at the stop's time, opted out of its target. */
    for (const read of [registry.conversation(stored.id)!, registry.conversationForPath(stored.generations.at(-1)!.path)!]) {
      expect(read.migration).toMatchObject({ intentId: fixture.intentId, phase: "rolled-back", updatedAt: at(0), revision: stored.migration!.revision });
      expect(read.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) });
    }
    /* A conversation the stop does not own is read as it is stored. */
    expect(registry.conversation(fixture.committedConversationId as ConversationId)!.migration?.phase).toBe("committed");

    /* No step of the migration is admitted, and a refused step writes nothing. */
    const revision = stored.migration!.revision;
    const receipt = successorReceipt(stored.migration!.operationId, "after-stop");
    clock(1);
    expect(() => registry.transitionConversationMigration(stored.id, revision, ["requested"], { phase: "preparing" })).toThrow("migration transition is stale");
    expect(() => registry.transitionConversationMigration(stored.id, revision, ["requested", "preparing", "successor-starting", "verifying"], { phase: "failed-recoverable" }))
      .toThrow("migration transition is stale");
    expect(() => registry.persistMigrationProviderReceipt(stored.id, revision, receipt.operationId, receipt)).toThrow("conflicts with durable state");
    expect(() => registry.commitSuccessor(stored.id, { id: receipt.nativeId, path: receipt.path, accountId: MIGRATION_STOP_TARGET }, revision, receipt.operationId, receipt))
      .toThrow("migration succession ownership is stale");
    expect(() => registry.retryConversationMigration(stored.id, revision)).toThrow("migration intent is inactive");
    expect(registry.readOnlySnapshot().conversations[stored.id]).toEqual(stored);
    expect(unsweptOwned(registry, fixture)).toHaveLength(unswept.length);

    /* The sweep then writes what the readers were already told. */
    clock(2);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(unsweptOwned(registry, fixture)).toHaveLength(0);
    expect(finished.conversations[stored.id]!.migration).toMatchObject({ phase: "rolled-back", updatedAt: at(0) });
    expect(registry.conversation(stored.id)).toEqual(finished.conversations[stored.id]!);
  } finally {
    registry.close();
  }
});

for (const reached of ["successor-starting", "verifying"] as const) {
  test(`a successor ${reached === "verifying" ? "ready to commit" : "being created"} when its intent stops is refused, and the rows are those of an uninterrupted stop`, async () => {
    const outcome: string[] = [];
    for (const interrupted of [true, false]) {
      const fixture = fixtureCopy();
      const registry = open(fixture);
      try {
        enrollEngine(registry, fixture);
        /* The last source conversation is far outside the stop's own transaction. */
        const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
        const migration = registry.conversation(id)!.migration!;
        const receipt = successorReceipt(migration.operationId, "ready-successor");
        registry.transitionConversationMigration(id, migration.revision, ["requested"], { phase: "successor-starting" });
        if (reached === "verifying") registry.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, receipt);

        if (interrupted) await stopIntentWithoutSweep(registry, fixture.intentId);
        else expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
        expect(unsweptOwned(registry, fixture).includes(id)).toBe(interrupted);

        const successor = { id: receipt.nativeId, path: receipt.path, accountId: MIGRATION_STOP_TARGET, historyHash: receipt.historyHash, host: receipt.host };
        if (reached === "successor-starting") {
          expect(() => registry.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, receipt)).toThrow("conflicts with durable state");
        }
        expect(() => registry.commitSuccessor(id, successor, migration.revision, migration.operationId, receipt)).toThrow();
        expect(registry.conversation(id)).toMatchObject({ migration: { phase: "rolled-back" }, migrationOptOut: { targetId: MIGRATION_STOP_TARGET } });
        expect(registry.conversation(id)!.generations.map(generation => generation.accountId)).toEqual([MIGRATION_STOP_SOURCE]);

        /* The artifact a provider reports late belongs to no migration. */
        registry.recordMigrationContinuityPath(id, "/sessions/late-artifact.jsonl", { operationId: migration.operationId, revision: migration.revision });
        const late = registry.readOnlySnapshot().conversations[id]!;
        expect(late.migration?.phase).toBe("rolled-back");
        expect(late.abandonedContinuityPaths).toContain("/sessions/late-artifact.jsonl");
        expect(late.migration?.pendingContinuityPaths).not.toContain("/sessions/late-artifact.jsonl");

        expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
        expect(() => registry.commitSuccessor(id, successor, migration.revision, migration.operationId, receipt)).toThrow();
        outcome.push(stoppedOutcome(registry));
      } finally {
        registry.close();
      }
    }
    expect(outcome[0]).toBe(outcome[1]!);
  });
}

test("a send after a stop is not held behind a migration the sweep has not reached, and what that migration held is cancelled", async () => {
  const outcome: string[] = [];
  for (const interrupted of [true, false]) {
    const fixture = fixtureCopy();
    const registry = open(fixture);
    try {
      enrollEngine(registry, fixture);
      const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
      const generation = registry.conversation(id)!.generations.at(-1)!.id;
      const before = registry.holdDelivery(id, "sent while migrating", "sent-before-stop");
      expect(before.state).toBe("held");

      if (interrupted) await stopIntentWithoutSweep(registry, fixture.intentId);
      else expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
      expect(unsweptOwned(registry, fixture).includes(id)).toBe(interrupted);

      /* Whoever reaches the conversation first writes the stop onto it: one conversation, in that writer's own transaction. */
      const written = conversationRowsPerTransaction(registry);
      const after = registry.holdDelivery(id, "sent after the stop", "sent-after-stop");
      expect(written).toEqual([interrupted ? 1 : 0]);
      expect(after).toMatchObject({ state: "assigned", generationId: generation });
      const file = registry.readOnlySnapshot();
      /* Rows of a read-only snapshot are shared with the store, so each field is compared on its own and no matcher object reaches them. */
      expect(file.heldDeliveries[before.id]).toMatchObject({ state: "failed", attempts: 0 });
      expect(file.heldDeliveries[before.id]!.error).toContain("migration was stopped");
      expect(file.conversations[id]).toMatchObject({ migration: { phase: "rolled-back" }, migrationOptOut: { targetId: MIGRATION_STOP_TARGET } });
      /* The cancelled input is never claimed, and the send follows routing nowhere. */
      expect(registry.beginDeliveryAttempt(before.id, generation)).toBeNull();
      expect(registry.requestConversationMigrationToActiveAccount(id).migration?.phase).toBe("rolled-back");

      expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
      expect(registry.readOnlySnapshot().heldDeliveries[after.id]).toMatchObject({ state: "assigned", generationId: generation });
      outcome.push(stoppedOutcome(registry));
    } finally {
      registry.close();
    }
  }
  expect(outcome[0]).toBe(outcome[1]!);
});

test("input held by a migration is not handed out by any path before the sweep cancels it", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    enrollEngine(registry, fixture);
    const [rolledBack, cancelled, cleared] = fixture.sourceConversationIds.slice(-3) as ConversationId[];
    const held = [rolledBack!, cancelled!, cleared!].map((id, index) => registry.holdDelivery(id, `held ${index}`, `held-before-stop-${index}`));
    const revision = registry.conversation(rolledBack!)!.migration!.revision;
    await stopIntentWithoutSweep(registry, fixture.intentId);
    for (const id of [rolledBack!, cancelled!, cleared!]) expect(unsweptOwned(registry, fixture)).toContain(id);

    /* A rollback and a cancellation re-arm what a live migration held; a stopped one has nothing left to re-arm. */
    registry.rollbackConversationMigration(rolledBack!, revision);
    expect(() => registry.cancelConversationSwitch(cancelled!, revision)).toThrow("switch is no longer pending");
    /* The hygiene pass clears a rolled-back migration only once nothing is pending on it. */
    expect(registry.clearRolledBackConversationMigration(cleared!, fixture.intentId)).toBe(true);

    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    for (const delivery of held) {
      expect(finished.heldDeliveries[delivery.id]).toMatchObject({ state: "failed", attempts: 0, generationId: null });
    }
    expect(finished.conversations[cleared!]!.migration).toBeNull();
    for (const id of [rolledBack!, cancelled!, cleared!]) {
      expect(finished.conversations[id]!.migrationOptOut?.targetId).toBe(MIGRATION_STOP_TARGET);
      expect(finished.conversations[id]!.generations.at(-1)!.accountId).toBe(MIGRATION_STOP_SOURCE);
    }
  } finally {
    registry.close();
  }
});

/** What a first writer finds on a conversation whose intent was stopped: input in each state a migration can leave it in. */
interface FirstWriterScene {
  id: ConversationId;
  generation: string;
  intentId: string;
  operationId: string;
  /** Claimed before the migration: its outcome is unknown. */
  uncertain: HeldDelivery;
  /** Assigned to the source generation before the migration, never claimed. */
  assigned: HeldDelivery;
  /** Sent while the migration was under way and held behind it. */
  held: HeldDelivery;
}

/* Every write that decides from a conversation's migration. Each is the first
   to reach a conversation after a stop whose sweep never ran, and has to leave
   what it leaves after a stop whose sweep had finished. */
const firstWriters: Array<[string, (registry: AgentRegistry, scene: FirstWriterScene) => unknown, { successorStarting?: true }?]> = [
  ["a reseat to another account", (registry, scene) => {
    const migration = registry.requestConversationReseat(scene.id, LATER_TARGET).migration;
    return [migration?.targetId, migration?.phase];
  }],
  ["an engine-wide migration to another target", (registry) => manualMigration(registry, LATER_TARGET).state],
  ["a send that follows routing", (registry, scene) => registry.requestConversationMigrationToActiveAccount(scene.id).migration?.phase],
  ["the claim of input assigned before the migration", (registry, scene) => registry.beginDeliveryAttempt(scene.assigned.id, scene.generation)?.state ?? null],
  ["the requeue of input whose outcome is unknown", (registry, scene) => registry.requeueUnactuatedDelivery(scene.uncertain.id).state],
  ["the hand-over of undispatched claims", (registry, scene) =>
    registry.holdUndispatchedClaimsForSwitch(scene.id, [scene.uncertain.command.operationId], "switch-after-stop")],
  ["the cancellation of rolled-back input", (registry, scene) =>
    registry.terminalizeRolledBackMigrationDelivery(scene.held.id, scene.intentId, "cancelled after the stop")?.state ?? null],
  ["a spawn capability for the successor", (registry, scene) => registry.stageSpawnCapabilityForConversation(scene.id, scene.operationId) === null],
  ["a reconfigure claim", (registry, scene) => registry.claimConversationReconfigure(scene.id, {
    operationId: "reconfigure-after-stop", revision: 1, profile: { model: null, effort: null, fast: null },
  }).kind],
  ["a reconfigure settlement", (registry, scene) => registry.settleConversationReconfigure(scene.id, "no-such-reconfigure", 1, "failed").kind],
  /* A migration whose successor is being created refuses a resume; a stopped one no longer does. */
  ["a resumed launch", (registry, scene) => registry.beginSpawnRequest({
    engine: "codex", cwd: "/repo", accountId: MIGRATION_STOP_SOURCE, transport: "structured", conversationId: scene.id,
    purpose: "resume-successor", expectedArtifactPath: `/sessions/codex-${scene.generation}.jsonl`, launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  }).kind, { successorStarting: true }],
  ["a rollback", (registry, scene) => registry.rollbackConversationMigration(scene.id).migration?.phase],
  ["the clearing of a rolled-back migration", (registry, scene) => registry.clearRolledBackConversationMigration(scene.id, scene.intentId)],
];

for (const [name, write, before] of firstWriters) {
  test(`reaching a conversation before the sweep, ${name} leaves what it leaves after a finished stop`, async () => {
    const outcome: string[] = [];
    for (const interrupted of [true, false]) {
      const fixture = fixtureCopy();
      const registry = open(fixture);
      try {
        const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
        const generation = registry.conversation(id)!.generations.at(-1)!.id;
        const first = registry.holdDelivery(id, "claimed before the migration", "claimed-before-migration");
        const uncertain = registry.beginDeliveryAttempt(first.id, generation);
        const assigned = registry.holdDelivery(id, "assigned before the migration", "assigned-before-migration");
        if (uncertain?.state !== "delivery-uncertain" || assigned.state !== "assigned") throw new Error("the scene needs a claimed and an assigned delivery");
        enrollEngine(registry, fixture);
        const held = registry.holdDelivery(id, "sent during the migration", "held-during-migration");
        expect(held.state).toBe("held");
        const migration = registry.conversation(id)!.migration!;
        if (before?.successorStarting) {
          registry.transitionConversationMigration(id, migration.revision, ["requested", "waiting-turn"], { phase: "successor-starting" });
        }
        const scene: FirstWriterScene = { id, generation, intentId: fixture.intentId, operationId: migration.operationId, uncertain, assigned, held };

        if (interrupted) await stopIntentWithoutSweep(registry, fixture.intentId);
        else expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
        expect(unsweptOwned(registry, fixture).includes(id)).toBe(interrupted);

        let result: unknown;
        let refused = false;
        try {
          result = await write(registry, scene);
        } catch (error) {
          refused = true;
          result = error instanceof Error ? error.message : String(error);
        }
        /* A refused write wrote nothing; any other wrote the stop onto the conversation it reached. */
        const reached = refused ? null : stoppedOutcome(registry, id);
        expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
        outcome.push(JSON.stringify({ refused, result, reached, finished: stoppedOutcome(registry) }, null, 1));
      } finally {
        registry.close();
      }
    }
    expect(outcome[0]).toBe(outcome[1]!);
  });
}

for (const during of ["create", "verify", "publish"] as const) {
  test(`a stop decided while the coordinator awaits the provider's ${during} ends that migration without a commit`, async () => {
    const fixture = fixtureCopy();
    const registry = open(fixture);
    try {
      enrollEngine(registry, fixture);
      const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
      const calls: string[] = [];
      const cleaned: string[] = [];
      /* The stop lands inside the named await: the coordinator's next check is its first after it. */
      const stopDuring = async (step: typeof during) => {
        calls.push(step);
        if (step === during) await stopIntentWithoutSweep(registry, fixture.intentId);
      };
      const provider: SuccessorProviderPort = {
        virtualSource: true,
        async create(input) {
          await stopDuring("create");
          return successorReceipt(input.operationId, "raced-successor");
        },
        async verify() { await stopDuring("verify"); },
        async publishHost() { await stopDuring("publish"); },
        async cleanup(receipt) { cleaned.push(receipt.nativeId); },
      };

      const advanced = await advanceConversationMigration(id, registry, provider, { deferBoardRepair: true });

      expect(calls.at(-1)).toBe(during);
      expect(unsweptOwned(registry, fixture)).toContain(id);
      expect(advanced.migration?.phase).toBe("rolled-back");
      expect(advanced.generations.map(generation => generation.accountId)).toEqual([MIGRATION_STOP_SOURCE]);
      /* The successor the provider made is discarded, once. */
      expect(cleaned).toEqual(["raced-successor"]);
      expect(Object.keys(registry.readOnlySnapshot().pendingSuccessorCleanups)).toEqual([]);

      /* A later pass of the coordinator finds nothing to advance. */
      const again = await advanceConversationMigration(id, registry, provider, { deferBoardRepair: true });
      expect(again.migration?.phase).toBe("rolled-back");
      expect(calls.filter(step => step === "create")).toHaveLength(1);

      expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
      const finished = registry.readOnlySnapshot().conversations[id]!;
      expect(finished.migration?.phase).toBe("rolled-back");
      expect(finished.generations.map(generation => generation.accountId)).toEqual([MIGRATION_STOP_SOURCE]);
      expect(finished.migrationOptOut?.targetId).toBe(MIGRATION_STOP_TARGET);
    } finally {
      registry.close();
    }
  });
}

test("stops decided in one instant keep the order they were made in, across a restart", async () => {
  const fixture = fixtureCopy();
  let registry = open(fixture);
  try {
    /* Every step below runs under one frozen instant. */
    clock(0);
    expect((await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).acquired).toBe(true);
    const first = registry.readOnlySnapshot();
    expect(first.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
    expect(optedOut(first, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
    const firstOrder = first.conversations[fixture.sourceConversationIds[0]!]!.migrationOptOut!.order!;

    /* The order is stored with the rows it orders: another process continues it. */
    registry.close();
    registry = open(fixture);
    const later = manualMigration(registry, LATER_TARGET);
    expect((await registry.stopMigrationIntent(later.id)).acquired).toBe(true);

    const finished = registry.readOnlySnapshot();
    expect(finished.migrationIntents[later.id]!.stopSweep).toBeUndefined();
    /* The later stop stands on every conversation, the ones outside its own transaction included. */
    for (const id of fixture.sourceConversationIds) {
      expect(finished.conversations[id]!.migrationOptOut).toMatchObject({ targetId: LATER_TARGET, updatedAt: at(0) });
    }
    /* The next send does not restart the migration that was just stopped. */
    for (const id of [fixture.sourceConversationIds[0]!, fixture.sourceConversationIds.at(-1)!] as ConversationId[]) {
      registry.clearRolledBackConversationMigration(id, later.id);
      expect(registry.requestConversationMigrationToActiveAccount(id).migration).toBeNull();
    }
    /* Same time on both stops; the place each took is what tells them apart. */
    for (const id of fixture.sourceConversationIds) {
      expect(finished.conversations[id]!.migrationOptOut!.order!).toBeGreaterThan(firstOrder);
    }
  } finally {
    registry.close();
  }
});

test("an older stop's unfinished sweep, resumed in the instant of a newer stop, leaves the newer opt-out standing", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  try {
    clock(0);
    await stopWithoutSweep(registry, fixture);
    const later = manualMigration(registry, LATER_TARGET);
    await stopIntentWithoutSweep(registry, later.id);
    /* Both sweeps are owed, the older one runs last, and both carry the same time. */
    expect(await registry.continueMigrationStop(later.id)).toBe(true);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);

    const finished = registry.readOnlySnapshot();
    for (const intent of Object.values(finished.migrationIntents)) expect(intent.stopSweep).toBeUndefined();
    for (const id of fixture.sourceConversationIds) {
      expect(finished.conversations[id]!.migrationOptOut).toMatchObject({ targetId: LATER_TARGET, updatedAt: at(0) });
    }
  } finally {
    registry.close();
  }
});

test("a withdrawal and a stop made in one instant are told apart in both orders", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  const [withdrawnAfter, withdrawnBefore] = fixture.sourceConversationIds.slice(-2) as ConversationId[];
  try {
    clock(0);
    await stopWithoutSweep(registry, fixture);
    /* Withdrawn before a second stop of the same intent: the second stop is the newer decision. */
    registry.requestConversationReseat(withdrawnBefore!, MIGRATION_STOP_TARGET);
    registry.rollbackConversationMigration(withdrawnBefore!);
    registry.clearRolledBackConversationMigration(withdrawnBefore!, registry.conversation(withdrawnBefore!)!.migration!.intentId);
    registry.requestConversationReseat(withdrawnBefore!, MIGRATION_STOP_TARGET);
    await stopIntentWithoutSweep(registry, fixture.intentId);
    /* Withdrawn after it: the withdrawal is the newer decision. */
    registry.requestConversationReseat(withdrawnAfter!, MIGRATION_STOP_TARGET);

    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    const finished = registry.readOnlySnapshot();
    expect(finished.conversations[withdrawnAfter!]!.migrationOptOut).toMatchObject({ targetId: null, updatedAt: at(0) });
    expect(finished.conversations[withdrawnBefore!]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) });
  } finally {
    registry.close();
  }
});

test("an opt-out stored by a release from before the order is read as stored and ordered by its time", async () => {
  const fixture = fixtureCopy();
  const [older, sameInstant] = fixture.sourceConversationIds.slice(-2) as ConversationId[];
  const legacy = { [older!]: { targetId: LATER_TARGET, updatedAt: at(0) }, [sameInstant!]: { targetId: LATER_TARGET, updatedAt: at(1) } };
  const stored = new Database(fixture.sqliteFilename);
  try {
    for (const [id, optOut] of Object.entries(legacy)) {
      const changed = stored.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.migrationOptOut', json(?)) WHERE collection = 'conversations' AND row_key = ?")
        .run(JSON.stringify(optOut), id);
      expect(changed.changes).toBeGreaterThan(0);
    }
  } finally {
    stored.close();
  }
  const registry = open(fixture);
  try {
    expect(registry.conversation(older!)!.migrationOptOut).toEqual(legacy[older!]!);
    clock(1);
    expect((await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).acquired).toBe(true);
    const finished = registry.readOnlySnapshot();
    /* Decided a second before the stop: the stop is the newer decision. */
    expect(finished.conversations[older!]!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(1) });
    /* Stamped in the stop's own millisecond with no order to tell them apart: the sweep's late write leaves it. */
    expect(finished.conversations[sameInstant!]!.migrationOptOut).toEqual(legacy[sameInstant!]!);
  } finally {
    registry.close();
  }
});

/*
 * What a stop covers is fixed when the intent stops and written afterwards.
 * The clock cannot say what that was: set back between the two, it puts the
 * stop's time before the creation of conversations the stop was decided over,
 * and after the creation of ones that started later. The cases below move the
 * clock behind the stop and hold the rows to those of a stop written at once.
 */

test("a clock set back across the creation of its conversations leaves a stop's opt-out on every one of them", async () => {
  /* The conversations and their enrolment at second 1, the stop at second 0. */
  clock(1);
  const setBack = buildMigrationStopFixture(path.join(root, "clock-set-back"), SHAPE);
  for (const interrupted of [false, true]) {
    const fixture = fixtureCopy(setBack);
    let registry = open(fixture);
    try {
      clock(1);
      enrollEngine(registry, fixture);
      /* Far outside the stop's own transaction. */
      const last = fixture.sourceConversationIds.at(-1)! as ConversationId;
      expect(registry.conversation(last)!.createdAt).toBe(at(1));
      clock(0);
      if (interrupted) {
        await stopIntentWithoutSweep(registry, fixture.intentId);
        /* The decision is in force before the sweep writes it, and for the process that takes over. */
        registry.close();
        registry = open(fixture);
        expect(registry.conversation(last)!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) });
        expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
      } else {
        expect((await registry.stopMigrationIntent(fixture.intentId)).acquired).toBe(true);
      }
      const stopped = registry.readOnlySnapshot();
      expect(stopped.migrationIntents[fixture.intentId]).toMatchObject({ state: "stopped", stoppedAt: at(0) });
      expect(stopped.migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
      expect(optedOut(stopped, fixture.sourceConversationIds)).toHaveLength(SHAPE.sourceConversations);
      expect(optedOut(stopped, fixture.targetConversationIds)).toHaveLength(0);
      /* The rolled-back migration is spent and the hygiene pass clears it: the next send starts no migration. */
      for (const id of [fixture.sourceConversationIds[0]! as ConversationId, last]) {
        expect(registry.clearRolledBackConversationMigration(id, fixture.intentId)).toBe(true);
        expect(registry.requestConversationMigrationToActiveAccount(id).migration).toBeNull();
      }
    } finally {
      registry.close();
    }
  }
});

const observed = (pathname: string, accountId: string) => ({
  engine: "codex" as const, path: pathname, accountId, launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  turn: { state: "idle" as const, source: "empty" as const, terminalAt: null }, observedAt: at(1),
});
const currentPath = (registry: AgentRegistry, id: string) => registry.conversation(id as ConversationId)!.generations.at(-1)!.path;

/* What happens to one conversation after a stop, while the clock runs behind
   the stop's own time: the path it is found under afterwards, and what the
   stop leaves on it. Each runs once after a finished stop and once before the
   sweep has started. */
const changesBehindTheClock: Array<[
  string,
  (registry: AgentRegistry, fixture: MigrationStopFixture) => string,
  { accounts: string[]; optOut: string | null; sent: string | null },
]> = [
  ["a conversation that starts", (registry) => {
    return registry.ensureConversation("codex", "/sessions/started-after-the-stop.jsonl", MIGRATION_STOP_SOURCE).generations[0]!.path;
  }, { accounts: [MIGRATION_STOP_SOURCE], optOut: null, sent: MIGRATION_STOP_TARGET }],
  ["a conversation the scanner finds", (registry) => {
    registry.reconcileConversations([observed("/sessions/found-after-the-stop.jsonl", MIGRATION_STOP_SOURCE)], { snapshot: false });
    return "/sessions/found-after-the-stop.jsonl";
  }, { accounts: [MIGRATION_STOP_SOURCE], optOut: null, sent: MIGRATION_STOP_TARGET }],
  ["a conversation on the stopped target that moves to another account", (registry, fixture) => {
    const id = fixture.targetConversationIds[0]! as ConversationId;
    const migration = registry.requestConversationReseat(id, LATER_TARGET).migration!;
    const receipt = successorReceipt(migration.operationId, "moved-after-the-stop");
    registry.transitionConversationMigration(id, migration.revision, [migration.phase], { phase: "successor-starting" });
    registry.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, receipt);
    registry.commitSuccessor(id, { id: receipt.nativeId, path: receipt.path, accountId: LATER_TARGET, historyHash: receipt.historyHash, host: receipt.host },
      migration.revision, migration.operationId, receipt);
    return receipt.path;
  }, { accounts: [MIGRATION_STOP_TARGET, LATER_TARGET], optOut: null, sent: MIGRATION_STOP_TARGET }],
  ["a conversation whose account the scanner corrects to the stopped target", (registry, fixture) => {
    const pathname = currentPath(registry, fixture.sourceConversationIds.at(-1)!);
    registry.reconcileConversations([observed(pathname, MIGRATION_STOP_TARGET)], { snapshot: false });
    return pathname;
  }, { accounts: [MIGRATION_STOP_TARGET], optOut: MIGRATION_STOP_TARGET, sent: null }],
  ["a conversation whose account the scanner corrects away from the stopped target", (registry, fixture) => {
    const pathname = currentPath(registry, fixture.targetConversationIds.at(-1)!);
    registry.reconcileConversations([observed(pathname, MIGRATION_STOP_SOURCE)], { snapshot: false });
    return pathname;
  }, { accounts: [MIGRATION_STOP_SOURCE], optOut: null, sent: MIGRATION_STOP_TARGET }],
];

for (const [name, change, expected] of changesBehindTheClock) {
  test(`with the clock set back behind a stop, ${name} is left as a stop written at once leaves it`, async () => {
    for (const deferred of [false, true]) {
      const fixture = fixtureCopy();
      let registry = open(fixture);
      try {
        clock(5);
        if (deferred) await stopWithoutSweep(registry, fixture);
        else expect((await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).acquired).toBe(true);
        expect(Boolean(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep)).toBe(deferred);

        clock(1);
        const pathname = change(registry, fixture);

        /* The sweep is resumed by another process: what places the conversation against the stop is read back from the store. */
        registry.close();
        registry = open(fixture);
        clock(2);
        expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
        expect(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep).toBeUndefined();
        const swept = registry.conversationForPath(pathname)!;
        clock(3);
        const sent = registry.requestConversationMigrationToActiveAccount(swept.id).migration;
        expect({
          deferred,
          accounts: swept.generations.map(generation => generation.accountId),
          optOut: swept.migrationOptOut?.targetId ?? null,
          sent: sent && sent.phase !== "committed" && sent.phase !== "rolled-back" ? sent.targetId : null,
        }).toEqual({ deferred, ...expected });
        /* The stop's opt-out carries the stop's own time, whoever wrote it. */
        if (expected.optOut) expect(swept.migrationOptOut!.updatedAt).toBe(at(5));
        /* The rest of the engine is swept as before. */
        const others = fixture.sourceConversationIds.slice(0, -1);
        expect(optedOut(registry.readOnlySnapshot(), others)).toHaveLength(others.length);
      } finally {
        registry.close();
      }
    }
  });
}

test("a conversation that takes over one the scanner found before a stop keeps the opt-out the sweep had not written", async () => {
  const fixture = fixtureCopy();
  let registry = open(fixture);
  try {
    /* A launch whose transcript the scanner finds before the launch is settled. */
    clock(0);
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: "/repo", accountId: MIGRATION_STOP_SOURCE, launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Found before the stop" }),
    });
    if (begun.kind !== "created") throw new Error("the launch must be admitted");
    registry.close();
    const stored = new Database(fixture.sqliteFilename);
    try {
      const pending = stored.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.state', 'path-pending', '$.pathCorrelation', json(?)) WHERE collection = 'receipts' AND row_key = ?")
        .run(JSON.stringify({ cwd: "/repo", startedAt: at(0) }), begun.receipt.launchId);
      expect(pending.changes).toBeGreaterThan(0);
    } finally {
      stored.close();
    }
    registry = open(fixture);
    const childPath = "/sessions/child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl";
    registry.reconcileConversations([observed(childPath, MIGRATION_STOP_SOURCE)], { snapshot: false });
    const found = registry.conversationForPath(childPath)!;
    expect(found.id).not.toBe(begun.receipt.conversationId);

    clock(5);
    await stopWithoutSweep(registry, fixture);
    expect(registry.readOnlySnapshot().conversations[found.id]!.migrationOptOut).toBeNull();

    /* The scanner pairs the transcript with its launch: the launch's conversation, which starts now, takes the found one over. */
    clock(6);
    registry.reconcileConversations([{ ...observed(childPath, MIGRATION_STOP_SOURCE), startedAt: at(0) }], { snapshot: false });
    expect(registry.conversationForPath(childPath)!.id).toBe(begun.receipt.conversationId);
    expect(registry.readOnlySnapshot().conversations[found.id]).toBeUndefined();

    expect(registry.conversation(begun.receipt.conversationId)!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(5) });

    clock(7);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    expect(registry.conversation(begun.receipt.conversationId)!.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(5) });
    clock(8);
    expect(registry.requestConversationMigrationToActiveAccount(begun.receipt.conversationId).migration).toBeNull();
  } finally {
    registry.close();
  }
});

/*
 * The decision a send takes (section 12.10). A send to a conversation that is
 * not on the account its engine is routed to follows routing, unless the
 * opt-out that stands for the conversation names that account. One opt-out
 * stands: the newest decision, written on the row already or still on its way
 * from the sweep of a stop. The cases below hold the send to the answer it
 * gives once every sweep has finished, wherever the sweeps have got to.
 */

/* The fourth review's sequence: a stop of the first target, a migration of the
   active conversations to a second target, a stop of that one, and routing set
   back to the first. The newest opt-out names the second target, so a send
   follows routing to the first. */
for (const firstSweepPending of [false, true]) {
  test(`a send follows routing back to a target stopped before the stop of another target, with the first stop's sweep ${firstSweepPending ? "not started" : "finished"}`, async () => {
    const answers: Array<{ laterSweepPending: boolean; target: string | null }> = [];
    for (const laterSweepPending of [false, true]) {
      const fixture = fixtureCopy();
      const registry = open(fixture);
      /* Inactive, and far outside each stop's own transaction. */
      const id = fixture.sourceConversationIds.at(-1)! as ConversationId;
      try {
        clock(0);
        if (firstSweepPending) await stopWithoutSweep(registry, fixture);
        else expect((await registry.stopMigrationIntent(fixture.intentId, { expectedRevision: fixture.intentRevision })).acquired).toBe(true);
        clock(1);
        const later = registry.commitMigrationIntent({
          engine: "codex", targetId: LATER_TARGET, origin: "manual", requestId: "later-active",
          expectedRevision: registry.engineRouting("codex").revision, scope: "active",
        });
        expect(registry.conversation(id)!.migration).toBeNull();
        clock(2);
        if (laterSweepPending) await stopIntentWithoutSweep(registry, later.id);
        else expect((await registry.stopMigrationIntent(later.id)).acquired).toBe(true);
        clock(3);
        registry.setEngineRouting("codex", MIGRATION_STOP_TARGET);
        const sent = registry.requestConversationMigrationToActiveAccount(id);
        answers.push({ laterSweepPending, target: sent.migration?.targetId ?? null });
      } finally {
        registry.close();
      }
    }
    expect(answers).toEqual([
      { laterSweepPending: false, target: MIGRATION_STOP_TARGET },
      { laterSweepPending: true, target: MIGRATION_STOP_TARGET },
    ]);
  });
}

/* The same decision through the write a send makes: the reservation of the
   message and the move that follows routing are one transaction. */
test("a message admitted while two stops are unswept follows routing by the opt-out that stands", async () => {
  const fixture = fixtureCopy();
  const registry = open(fixture);
  const [banned, free] = fixture.sourceConversationIds.slice(-2) as ConversationId[];
  try {
    clock(0);
    await stopWithoutSweep(registry, fixture);
    /* Routed to the stopped target, with its opt-out on the way: the message is admitted and nothing moves. */
    expect(registry.holdDelivery(banned!, "sent after the stop", "sent-after-the-stop", "text", [], null, {}, { reseatToActiveAccount: {} }).state).toBe("assigned");
    expect(registry.conversation(banned!)!.migration).toBeNull();

    clock(1);
    const later = registry.commitMigrationIntent({
      engine: "codex", targetId: LATER_TARGET, origin: "manual", requestId: "later-active",
      expectedRevision: registry.engineRouting("codex").revision, scope: "active",
    });
    clock(2);
    await stopIntentWithoutSweep(registry, later.id);
    /* Its message made the conversation active: the second migration enrolled it and the stop rolled that back.
       Routed to the second target, the newest opt-out: the next message starts no other move. */
    expect(registry.holdDelivery(banned!, "sent after the second stop", "sent-after-the-second-stop", "text", [], null, {}, { reseatToActiveAccount: {} }).state).toBe("assigned");
    expect(registry.conversation(banned!)!.migration).toMatchObject({ intentId: later.id, targetId: LATER_TARGET, phase: "rolled-back" });

    clock(3);
    registry.setEngineRouting("codex", MIGRATION_STOP_TARGET);
    /* Routed back to the first target, whose opt-out the second stop replaced: the message waits for the move. */
    expect(registry.holdDelivery(free!, "sent after routing came back", "sent-after-routing-came-back", "text", [], null, {}, { reseatToActiveAccount: {} }).state).toBe("held");
    expect(registry.conversation(free!)!.migration).toMatchObject({ targetId: MIGRATION_STOP_TARGET, phase: "requested" });

    /* Both sweeps then leave the second stop's opt-out on both conversations, and the move as it was asked for. */
    clock(4);
    expect(await registry.continueMigrationStop(fixture.intentId)).toBe(true);
    expect(await registry.continueMigrationStop(later.id)).toBe(true);
    const finished = registry.readOnlySnapshot();
    for (const intent of Object.values(finished.migrationIntents)) expect(intent.stopSweep).toBeUndefined();
    for (const id of [banned!, free!]) expect(finished.conversations[id]!.migrationOptOut).toMatchObject({ targetId: LATER_TARGET, updatedAt: at(2) });
    expect(finished.conversations[free!]!.migration).toMatchObject({ targetId: MIGRATION_STOP_TARGET, phase: "requested" });
  } finally {
    registry.close();
  }
});

/* An opt-out stored by a release from before the order has no place, and a
   sweep orders its stop against it by time, keeping it at an equal time
   (section 12.8). A send reads the same order before the sweep arrives. */
test("a send orders an opt-out stored without a place against an unswept stop as the sweep will", async () => {
  const answers: Array<{ sweepPending: boolean; older: string | null; sameInstant: string | null }> = [];
  for (const sweepPending of [false, true]) {
    const fixture = fixtureCopy();
    const [older, sameInstant] = fixture.sourceConversationIds.slice(-2) as ConversationId[];
    const legacy = { [older!]: { targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) }, [sameInstant!]: { targetId: MIGRATION_STOP_TARGET, updatedAt: at(2) } };
    const stored = new Database(fixture.sqliteFilename);
    try {
      for (const [id, optOut] of Object.entries(legacy)) {
        const changed = stored.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.migrationOptOut', json(?)) WHERE collection = 'conversations' AND row_key = ?")
          .run(JSON.stringify(optOut), id);
        expect(changed.changes).toBeGreaterThan(0);
      }
    } finally {
      stored.close();
    }
    const registry = open(fixture);
    try {
      /* The fixture's draining intent is moved to a second target, which enrols no inactive conversation, and stopped there. */
      clock(1);
      const later = registry.commitMigrationIntent({
        engine: "codex", targetId: LATER_TARGET, origin: "manual", requestId: "later-active",
        expectedRevision: registry.engineRouting("codex").revision, scope: "active",
      });
      clock(2);
      if (sweepPending) await stopIntentWithoutSweep(registry, later.id);
      else expect((await registry.stopMigrationIntent(later.id)).acquired).toBe(true);
      clock(3);
      registry.setEngineRouting("codex", MIGRATION_STOP_TARGET);
      const target = (id: ConversationId) => registry.requestConversationMigrationToActiveAccount(id).migration?.targetId ?? null;
      answers.push({ sweepPending, older: target(older!), sameInstant: target(sameInstant!) });
    } finally {
      registry.close();
    }
  }
  /* Stored a second before the stop: the stop is the newer decision and the first target is free again.
     Stored in the stop's own millisecond: kept, so the conversation stays opted out of the first target. */
  expect(answers).toEqual([
    { sweepPending: false, older: MIGRATION_STOP_TARGET, sameInstant: null },
    { sweepPending: true, older: MIGRATION_STOP_TARGET, sameInstant: null },
  ]);
});
