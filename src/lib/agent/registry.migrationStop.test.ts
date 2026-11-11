import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

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
        expect(finished.conversations[source]!.migrationOptOut).toEqual({ targetId: LATER_TARGET, updatedAt: stamp(2) });
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
    expect(finished.conversations[withdrawn]!.migrationOptOut).toEqual({ targetId: null, updatedAt: at(1) });
    expect(finished.conversations[optedOutLater]!.migrationOptOut).toEqual({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(1) });
    const others = fixture.sourceConversationIds.slice(0, -2);
    for (const id of others) expect(finished.conversations[id]!.migrationOptOut).toEqual({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(0) });
  } finally {
    registry.close();
  }
  /* A registry opened afterwards reads the withdrawal as it was stored. */
  const reopened = open(fixture);
  try {
    expect(reopened.conversation(withdrawn)!.migrationOptOut).toEqual({ targetId: null, updatedAt: at(1) });
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
      expect(finished.conversations[id]!.migrationOptOut).toEqual({ targetId: MIGRATION_STOP_TARGET, updatedAt: at(1) });
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
    expect(registry.readOnlySnapshot().migrationIntents[fixture.intentId]!.stopSweep).toEqual({ stampedAt, optOut: true });
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
