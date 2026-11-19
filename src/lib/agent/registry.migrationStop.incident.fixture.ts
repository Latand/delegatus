import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "bun:test";

import { AgentRegistry, MIGRATION_STOP_SLICE_ROWS, type RegistryFile } from "./registry";
import { buildMigrationStopFixture, MIGRATION_STOP_INCIDENT_SHAPE, MIGRATION_STOP_TARGET, registryRowsForComparison } from "./registry.migrationStop.fixture";

export const SWEEP_ROWS_PER_WRITE = 16;

/*
 * The recurrence test for section 4.1, at the size of the incident: 14 000
 * conversations on one engine and 27 000 deliveries. The hygiene pass stops
 * the stale intent in a process of its own, as the account-migration helper
 * does, while this process keeps admitting deliveries. On the code before the
 * fix that pass holds one write transaction for the whole stop and the first
 * delivery write made meanwhile is refused.
 */
export async function measureMigrationStop(history: "hot" | "archived") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-stop-incident-"));
  try {
    const fixture = buildMigrationStopFixture(directory, MIGRATION_STOP_INCIDENT_SHAPE);
    if (history === "archived") {
      const archive = new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" });
      try {
        // Exercise normal archival on the same generated fixture as hot history.
        for (let moved = 0; moved < 20_000;) {
          const count = archive.archiveInactiveRows(2_000);
          expect(count).toBeGreaterThan(0);
          moved += count;
        }
      } finally { archive.close(); }
    }
    const ready = path.join(directory, "ready");
    const release = path.join(directory, "release");
    const result = path.join(directory, "result.json");
    const registry = new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite", sqliteWriterDeadlineMs: 1_000 });
    /* A conversation holds a bounded number of deliveries, so the admissions go round the ones on the target. */
    const target = (index: number) =>
      fixture.targetConversationIds[index % fixture.targetConversationIds.length]! as Parameters<AgentRegistry["holdDelivery"]>[0];
    const child = Bun.spawn([
      process.execPath, path.join(import.meta.dir, "registry.migrationStop.child.ts"),
      fixture.filename, fixture.intentUpdatedAt, ready, release, result,
    ], { stdout: "ignore", stderr: "inherit", env: { ...process.env, NODE_ENV: "test" } });
    const admissions: Array<{ acquired: boolean; waitedMs: number; duringStop: boolean }> = [];
    let fastProbes = 0;
    let fastRefusals = 0;
    let firstThousandRefusals = 0;
    const probe = setInterval(() => {
      if (!fs.existsSync(`${ready}.started`) || fs.existsSync(result)) return;
      fastProbes += 1;
      if (!registry.deliveryWriteNow({ label: "delivery.sweep-probe" }, () => undefined, { recordRefusal: false }).acquired) {
        fastRefusals += 1;
        if (fastProbes <= 1_000) firstThousandRefusals += 1;
      }
    }, 10);
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
      const sweep = pass.transactions.filter(transaction => transaction.label === "migration.stop.sweep");
      const sweepHolds = sweep.map(transaction => transaction.heldMs).sort((left, right) => left - right);
      console.info("migration stop measurement", JSON.stringify({ history, transactions: sweep.length,
        totalHoldMs: Math.round(sweepHolds.reduce((sum, held) => sum + held, 0)),
        p99HoldMs: Math.round(sweepHolds[Math.floor(sweepHolds.length * 0.99)]!),
        maxHoldMs: Math.round(sweepHolds.at(-1)!), fastProbes, fastRefusals, firstThousandRefusals, expiredAdmissions: refused.length }));
      expect(Math.max(...sweep.map(transaction => transaction.rows))).toBeLessThanOrEqual(SWEEP_ROWS_PER_WRITE);
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
      const optedOut = fixture.sourceConversationIds.filter(id => stopped.conversations[id]?.migrationOptOut?.targetId === MIGRATION_STOP_TARGET);
      expect(optedOut).toHaveLength(MIGRATION_STOP_INCIDENT_SHAPE.sourceConversations);
    } finally {
      clearInterval(probe);
      if (child.exitCode === null) child.kill();
      await child.exited;
      registry.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
