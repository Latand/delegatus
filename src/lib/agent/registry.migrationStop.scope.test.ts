import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentRegistry, type RegistryFile } from "./registry";
import { buildMigrationStopFixture, MIGRATION_STOP_TARGET } from "./registry.migrationStop.fixture";

const roots: string[] = [];
afterEach(() => { setSystemTime(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function archive(registry: AgentRegistry) {
  for (let pass = 0; pass < 10; pass++) if (!registry.archiveInactiveRows(1000)) return;
  throw new Error("fixture archive did not converge");
}
function fixture(creditGuard?: true) {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-scope-")); roots.push(root);
  const f = buildMigrationStopFixture(root, { sourceConversations: 1249, targetConversations: 20,
    otherEngineConversations: 10, deliveredDeliveries: 1249 });
  const registry = new AgentRegistry(f.filename, () => false, undefined, { sqliteMode: "sqlite" });
  const id = f.sourceConversationIds[0]! as `conversation_${string}`;
  const reseat = registry.requestConversationReseat(id, MIGRATION_STOP_TARGET, undefined, undefined, creditGuard);
  archive(registry);
  return { ...f, registry, id, reseatIntent: reseat.migration!.intentId };
}
function countForeignWrites(registry: AgentRegistry, id: string) {
  type Changes = { rows: Map<string, Set<string>> };
  const store = (registry as unknown as { sqliteStore: { persistChanges: (file: RegistryFile, changes: Changes, revision: number) => void } }).sqliteStore;
  const persist = store.persistChanges.bind(store);
  const writes: string[] = [];
  const spy = spyOn(store, "persistChanges").mockImplementation((file, changes, revision) => {
    for (const key of changes.rows.get("conversations") ?? []) if (key !== id) writes.push(key);
    persist(file, changes, revision);
  });
  return { writes, restore: () => spy.mockRestore() };
}
function archiveCount(filename: string) {
  const db = new Database(filename, { readonly: true });
  try { return (db.query("SELECT count(*) AS n FROM registry_archive WHERE collection='conversations'").get() as { n: number }).n; }
  finally { db.close(); }
}

for (const stop of ["sliced", "synchronous", "resumed"] as const) test(`${stop} conversation stop writes zero foreign conversations`, async () => {
  const f = fixture(); const observed = countForeignWrites(f.registry, f.id);
  try {
    const before = archiveCount(f.sqliteFilename);
    setSystemTime(new Date("2030-01-01T00:06:00.000Z"));
    if (stop === "synchronous") f.registry.setMigrationIntentState(f.reseatIntent, "stopped");
    else if (stop === "sliced") await f.registry.stopMigrationIntent(f.reseatIntent);
    else {
      const pause = spyOn(f.registry, "continueMigrationStop").mockResolvedValueOnce(false);
      await f.registry.stopMigrationIntent(f.reseatIntent); pause.mockRestore();
      expect(f.registry.readOnlySnapshot().migrationIntents[f.reseatIntent]?.stopSweep).toBeDefined();
      f.registry.close();
      const restart = new AgentRegistry(f.filename, () => false, undefined, { sqliteMode: "sqlite" });
      const resumed = countForeignWrites(restart, f.id);
      try { await restart.continueMigrationStop(f.reseatIntent); observed.writes.push(...resumed.writes); archive(restart); }
      finally { resumed.restore(); restart.close(); }
    }
    if (stop !== "resumed") archive(f.registry);
    const after = archiveCount(f.sqliteFilename);
    console.log(JSON.stringify({ stop, foreignWrites: observed.writes.length, archiveVersionsPerStop: after - before,
      archiveVersionsPerHourAtTenStops: (after - before) * 10 }));
    expect(observed.writes).toHaveLength(0);
    expect(after - before).toBeLessThanOrEqual(1);
  } finally { observed.restore(); f.registry.close(); }
});

test("a pending conversation stop cannot replace a later engine stop's decisions", async () => {
  const f = fixture();
  try {
    const pause = spyOn(f.registry, "continueMigrationStop").mockResolvedValueOnce(false);
    await f.registry.stopMigrationIntent(f.reseatIntent); pause.mockRestore();
    await f.registry.stopMigrationIntent(f.intentId);
    const before = f.registry.readOnlySnapshot();
    const foreign = f.sourceConversationIds.slice(1);
    expect(foreign.every(id => before.conversations[id]?.migrationOptOut?.targetId === MIGRATION_STOP_TARGET)).toBe(true);
    const observed = countForeignWrites(f.registry, f.id);
    try { await f.registry.continueMigrationStop(f.reseatIntent); expect(observed.writes).toHaveLength(0); }
    finally { observed.restore(); }
    const after = f.registry.readOnlySnapshot();
    for (const id of foreign) expect(after.conversations[id]).toEqual(before.conversations[id]);
    expect(after.migrationIntents[f.reseatIntent]?.stopSweep).toBeUndefined();
  } finally { f.registry.close(); }
});

test("a pending conversation stop leaves a foreign send eligible for the engine's routing", async () => {
  const f = fixture();
  try {
    const pause = spyOn(f.registry, "continueMigrationStop").mockResolvedValueOnce(false);
    await f.registry.stopMigrationIntent(f.reseatIntent); pause.mockRestore();
    const foreign = f.sourceConversationIds[1]! as `conversation_${string}`;
    expect(f.registry.conversation(foreign)?.migrationOptOut).toBeNull();
    expect(f.registry.requestConversationMigrationToActiveAccount(foreign).migration).toMatchObject({ intentId: f.intentId,
      targetId: MIGRATION_STOP_TARGET });
    const before = f.registry.conversation(foreign);
    await f.registry.continueMigrationStop(f.reseatIntent);
    expect(f.registry.conversation(foreign)).toEqual(before);
  } finally { f.registry.close(); }
});

test("a later conversation stop leaves an earlier engine stop's foreign opt-outs in order", async () => {
  const f = fixture();
  try {
    const pause = spyOn(f.registry, "continueMigrationStop").mockResolvedValueOnce(false);
    await f.registry.stopMigrationIntent(f.intentId); pause.mockRestore();
    const engineOrder = f.registry.readOnlySnapshot().migrationIntents[f.intentId]!.stopSweep!.order;
    await f.registry.stopMigrationIntent(f.reseatIntent);
    await f.registry.continueMigrationStop(f.intentId);
    const after = f.registry.readOnlySnapshot();
    for (const id of f.sourceConversationIds.slice(1)) {
      expect(after.conversations[id]?.migrationOptOut).toMatchObject({ targetId: MIGRATION_STOP_TARGET, order: engineOrder });
    }
  } finally { f.registry.close(); }
});

test("one simulated hour of unchanged dead-generation retries creates no repeated stop or foreign archive versions", async () => {
  const f = fixture(true); const observed = countForeignWrites(f.registry, f.id);
  try {
    const before = archiveCount(f.sqliteFilename);
    let stops = 0;
    for (let interval = 1; interval <= 12; interval++) {
      setSystemTime(new Date(Date.parse("2030-01-01T00:00:00.000Z") + interval * 5 * 60_000));
      const migration = f.registry.conversation(f.id)?.migration;
      if (migration) {
        await f.registry.stopMigrationIntent(migration.intentId);
        f.registry.clearRolledBackConversationMigration(f.id, migration.intentId);
        archive(f.registry);
        stops++;
      }
      f.registry.requestConversationReseat(f.id, MIGRATION_STOP_TARGET, undefined, undefined, true);
    }
    const versions = archiveCount(f.sqliteFilename) - before;
    console.log(JSON.stringify({ simulatedHours: 1, stops, foreignWrites: observed.writes.length, archiveVersionsPerHour: versions }));
    expect(stops).toBe(1);
    expect(observed.writes).toHaveLength(0);
    expect(versions).toBeLessThanOrEqual(1);
  } finally { observed.restore(); f.registry.close(); }
}, 240_000);
