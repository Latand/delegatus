import fs from "node:fs";

import { Database } from "bun:sqlite";

import { currentWaitCorrelation } from "@/lib/blockingWaits";
import { MIGRATION_INTENT_PROGRESS_TIMEOUT_MS } from "@/lib/accounts/migration/intentLiveness";
import { terminalizeStaleUndeliverableHeldDeliveries } from "@/lib/reaperRuntime";

import { AgentRegistry } from "./registry";

/*
 * The account-migration helper's hygiene pass, in a process of its own, over a
 * private fixture registry. It reports every write transaction the pass held:
 * its label, how long the registry's write lock was held and how many rows it
 * wrote. `ready` is written once the registry is open; the pass starts when
 * `release` appears.
 */

const [filename, intentUpdatedAt, ready, release, resultFile] = process.argv.slice(2);
if (!filename || !intentUpdatedAt || !ready || !release || !resultFile) throw new Error("migration stop child arguments are required");

interface HeldTransaction { label: string; heldMs: number; rows: number }
const transactions: HeldTransaction[] = [];
let open: { label: string; startedAt: number; rows: number } | null = null;
const exec = Database.prototype.exec;
Database.prototype.exec = function observedExec(this: Database, sql: string, ...args: unknown[]) {
  const result = (exec as (...values: unknown[]) => unknown).call(this, sql, ...args);
  if (/^\s*BEGIN\s+IMMEDIATE\b/i.test(sql)) {
    open = { label: currentWaitCorrelation()?.label ?? "uncorrelated", startedAt: performance.now(), rows: 0 };
  } else if (open && /^\s*(?:COMMIT|END|ROLLBACK)\s*;?\s*$/i.test(sql)) {
    transactions.push({ label: open.label, heldMs: performance.now() - open.startedAt, rows: open.rows });
    open = null;
  }
  return result;
} as typeof Database.prototype.exec;

const registry = new AgentRegistry(filename, undefined, undefined, {
  sqliteMode: "sqlite",
  onSqliteRowPayloadRead: () => {},
});
/* Rows written are counted where the store persists them. */
const store = (registry as unknown as { sqliteStore: { upsertRow: (...values: unknown[]) => void } }).sqliteStore;
const upsertRow = store.upsertRow.bind(store);
store.upsertRow = (...values: unknown[]) => { if (open) open.rows += 1; upsertRow(...values); };

/* The helper keeps a reader view between passes; the pass does not pay for the first one. */
registry.readOnlySnapshot();
fs.writeFileSync(ready, "ready");
while (!fs.existsSync(release)) await new Promise(resolve => setTimeout(resolve, 5));

const startedAt = performance.now();
fs.writeFileSync(`${ready}.started`, "started");
const terminalized = await terminalizeStaleUndeliverableHeldDeliveries(
  registry,
  Date.parse(intentUpdatedAt) + MIGRATION_INTENT_PROGRESS_TIMEOUT_MS + 1_000,
);
const passMs = performance.now() - startedAt;
registry.close();
fs.writeFileSync(resultFile, JSON.stringify({ passMs, terminalized, transactions }));
process.exit(0);
