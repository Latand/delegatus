import fs from "node:fs";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { databaseFileIdentity, openCurrentDatabase } from "@/lib/state/currentDatabase";
import type { AppConnectReceipt, AppConnectRow } from "./appConnectTypes";

const COLLECTION = "forge-app-connect";
const states = z.enum(["awaiting_click", "awaiting_answer", "awaiting_owner", "missing_repository", "missing_permissions", "verification_failed", "connected", "expired", "cancelled"]);
const schema = z.object({ kind: z.literal("request"), key: z.string(), requestId: z.string(), repository: z.string(), project: z.string(), conversationId: z.string(),
  permissions: z.record(z.string(), z.enum(["read", "write"])), ownRepository: z.boolean(), absentAtRequest: z.boolean(),
  missingPermissionsAtRequest: z.array(z.string()).optional(),
  createdAt: z.number().finite(), expiresAt: z.number().finite(), nextAt: z.number().finite(), checks: z.number().int().nonnegative(), state: states,
  discovery: z.object({ context: z.object({ appId: z.number().int(), slug: z.string(), accountId: z.number().int(), accountType: z.enum(["orgs", "users"]), settingsUrl: z.url(), prerequisite: z.enum(["none", "app_private"]) }),
    covered: z.boolean(), installationId: z.number().int().nullable(), installationUrl: z.string().nullable(), missingPermissions: z.array(z.string()), missingAppPermissions: z.array(z.string()), pending: z.boolean(), proved: z.boolean().optional() }),
  repositoryId: z.number().int().nullable(), reviewId: z.string().optional(), form: z.unknown().optional(), replacedForm: z.boolean().optional(), lastError: z.string().optional(), changed: z.boolean().optional(), notifiedState: states.optional(), notificationDeferred: z.boolean().optional(),
});
const receiptSchema = z.object({ kind: z.literal("receipt"), key: z.string(), digest: z.string(), response: z.object({ requestId: z.string(), repository: z.string(), state: states }).passthrough() });
type Record = AppConnectRow | AppConnectReceipt;
export const appConnectOpen = (row: AppConnectRow) => !["connected", "expired", "cancelled"].includes(row.state);
const active = (record: Record) => record.kind === "request" && (appConnectOpen(record) || (!record.notificationDeferred && record.notifiedState !== record.state));
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "forge-app-connect-v1", key: (row: Record) => row.key, loadRecords: () => [], controllerActive: active };

/** No cached database handle survives a state-root swap. Terminal history is
 * excluded by the shared store's active index, so polling never scans history.
 */
export class AppConnectStore {
  private held?: { identity: string | null; store: SqliteStateCollection<Record> };
  constructor(readonly filename = statePath("state.sqlite")) {}
  private open(write = false): SqliteStateCollection<Record> | null {
    const identity = databaseFileIdentity(this.filename);
    if (this.held && this.held.identity === identity) return this.held.store;
    this.close();
    if (!write && (!fs.existsSync(this.filename) || !stateCollectionsInitialized(this.filename, [seed]))) return null;
    initializeStateCollections(this.filename, [seed]);
    const store = new SqliteStateCollection<Record>(this.filename, { ...seed, busyMessage: "App connection requests are busy", clone: structuredClone,
      decode: value => {
        const result = z.union([schema, receiptSchema]).safeParse(value);
        return result.success ? result.data as Record : null;
      }, controllerActive: active });
    this.held = { identity: databaseFileIdentity(this.filename), store };
    return store;
  }
  close() { this.held?.store.close(); this.held = undefined; }
  get(key: string): Record | null { return this.open()?.get(key) ?? null; }
  request(repository: string): AppConnectRow | null {
    const row = this.get(repository.toLowerCase());
    return row?.kind === "request" ? row : null;
  }
  put(row: Record) { this.open(true)!.boundedPatch(2, tx => { tx.put(row); }); }
  page(after = -1): { rows: AppConnectRow[]; cursor: number } {
    const store = this.open();
    if (!store) return { rows: [], cursor: -1 };
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("App connection polling needs Bun's SQLite runtime");
    const db = openCurrentDatabase(this.filename, () => new sqlite.Database(this.filename, { readonly: true, strict: true }));
    try {
      const keys = db.query<{ row_key: string; row_order: number }, [string, number]>(
        "SELECT row_key,row_order FROM state_rows WHERE collection=? AND controller_active=1 AND row_order>? ORDER BY row_order LIMIT 4").all(COLLECTION, after);
      return { rows: keys.flatMap(({ row_key }) => { const row = store.get(row_key); return row?.kind === "request" ? [row] : []; }), cursor: keys.at(-1)?.row_order ?? -1 };
    } finally { db.close(); }
  }
}
