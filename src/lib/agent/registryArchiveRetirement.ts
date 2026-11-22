import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MIGRATION_DELIVERY_CANCELLATION_PREFIX } from "@/lib/accounts/migration/intentLiveness";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";

export const RETIREMENT_GRACE_MS = 60 * 60_000;
export const RETIREMENT_OBSERVE_IDS = 2_000;
export const RETIREMENT_BATCH = 250;
export const RETIREMENT_CYCLE_BATCHES = 4;

/** Retained: every reachable reservation, owner, receipt, custody/journal
 * receipt, unresolved switch, pending send, uncertain delivery, compatibility
 * copy and collection order high-water mark. No age expiry applies to them.
 * Any mapping (including a damaged identity) fences its archive version. */
export const SUPERSEDED_ARCHIVE = `NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.archive_id=a.id)
  AND a.row_order < (SELECT MAX(r.row_order) FROM registry_rows r WHERE r.collection=a.collection)`;
export const GUARDED_ARCHIVE_DELETE = `CREATE TRIGGER registry_archive_immutable_delete BEFORE DELETE ON registry_archive
  WHEN NOT EXISTS (SELECT 1 FROM registry_archive_retirements l WHERE l.id=OLD.id)
    OR EXISTS (SELECT 1 FROM registry_cold c WHERE c.archive_id=OLD.id)
    OR NOT COALESCE(OLD.row_order < (SELECT MAX(r.row_order) FROM registry_rows r WHERE r.collection=OLD.collection),0)
  BEGIN SELECT RAISE(ABORT,'registry archive version is retained'); END`;

/** Called inside the store's fenced startup transaction. The new objects make
 * the name-based installed-schema check request this upgrade once. */
export function installArchiveRetirement(db: Database) {
  db.run(`CREATE INDEX IF NOT EXISTS registry_cold_archive ON registry_cold(archive_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS registry_archive_retirements (
    id INTEGER PRIMARY KEY, collection TEXT NOT NULL, bytes INTEGER NOT NULL, observed_at INTEGER NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS registry_archive_retirements_due ON registry_archive_retirements(observed_at,id)`);
  db.run(`CREATE TABLE IF NOT EXISTS registry_archive_retirement_state (key TEXT PRIMARY KEY,value INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS registry_archive_retirement_totals (collection TEXT PRIMARY KEY,retired INTEGER NOT NULL,bytes INTEGER NOT NULL)`);
  const installed = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='registry_archive_immutable_delete'").get();
  if (installed?.sql !== GUARDED_ARCHIVE_DELETE) {
    db.run("DROP TRIGGER IF EXISTS registry_archive_immutable_delete");
    db.run(GUARDED_ARCHIVE_DELETE);
  }
}

export interface RetirementApproval {
  category: "A";
  digest: string;
  databaseIdentity: string;
  graceMs: number;
  batchSize: number;
  cycleBatches: number;
}
export const retirementApprovalFile = (filename: string) => path.join(path.dirname(filename), "registry-archive-retirement.json");
export function retirementApproval(filename: string): RetirementApproval | null {
  try {
    const a = JSON.parse(fs.readFileSync(retirementApprovalFile(filename), "utf8")) as RetirementApproval;
    if (!a || typeof a !== "object") return null;
    return a.category === "A" && /^[a-f0-9]{64}$/.test(a.digest)
      && a.databaseIdentity === databaseFileIdentity(filename)
      && Number.isSafeInteger(a.graceMs) && a.graceMs >= RETIREMENT_GRACE_MS
      && Number.isSafeInteger(a.batchSize) && a.batchSize >= 1 && a.batchSize <= RETIREMENT_BATCH
      && Number.isSafeInteger(a.cycleBatches) && a.cycleBatches >= 1 && a.cycleBatches <= RETIREMENT_CYCLE_BATCHES ? a : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const cursor = (db: Database) => db.query<{ value: number }, []>("SELECT value FROM registry_archive_retirement_state WHERE key='cursor'").get()?.value ?? 0;
export interface RetirementObservation {
  cursor: number;
  nextCursor: number;
  rows: { id: number; collection: string; bytes: number }[];
}
/** Bounded page of existing primary keys, including retained rows. Read before
 * writer admission. A concurrent observer is fenced by the cursor at commit. */
export function observeSupersededArchive(db: Database): RetirementObservation {
  return db.transaction(() => {
    const start = cursor(db);
    const examined = db.query<{ id: number }, [number, number]>(`SELECT id FROM registry_archive
      WHERE id>? ORDER BY id LIMIT ?`).all(start, RETIREMENT_OBSERVE_IDS);
    const last = examined.at(-1)?.id;
    const nextCursor = last === undefined || examined.length < RETIREMENT_OBSERVE_IDS ? 0 : last;
    if (last === undefined) return { cursor: start, nextCursor: 0, rows: [] };
    const rows = db.query<RetirementObservation["rows"][number], [number, number]>(`SELECT a.id,a.collection,length(CAST(a.value_json AS BLOB)) AS bytes
      FROM registry_archive a WHERE a.id>? AND a.id<=? AND ${SUPERSEDED_ARCHIVE}`).all(start, last);
    return { cursor: start, nextCursor, rows };
  })();
}

/** One admitted transaction; its caller commits the ledger, totals and deletes
 * together. No registry change journal or logical revision is written. */
export function retireSupersededArchiveBatch(db: Database, approval: RetirementApproval, now: number, observation?: RetirementObservation): number {
  const trigger = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='registry_archive_immutable_delete'").get();
  if (trigger?.sql !== GUARDED_ARCHIVE_DELETE) throw new Error("registry archive retirement guard is not installed");
  if (observation && cursor(db) === observation.cursor) {
    const insert = db.query(`INSERT OR IGNORE INTO registry_archive_retirements(id,collection,bytes,observed_at)
      SELECT a.id,a.collection,length(CAST(a.value_json AS BLOB)),? FROM registry_archive a WHERE a.id=? AND ${SUPERSEDED_ARCHIVE}`);
    for (const row of observation.rows) insert.run(now,row.id);
    db.query("INSERT OR REPLACE INTO registry_archive_retirement_state(key,value) VALUES ('cursor',?)").run(observation.nextCursor);
  }
  const due = db.query<{ id: number }, [number, number]>(`SELECT id FROM registry_archive_retirements
    WHERE observed_at<=? ORDER BY observed_at,id LIMIT ?`).all(now-approval.graceMs,approval.batchSize);
  let retired = 0;
  for (const { id } of due) {
    const removed = db.query<{ collection: string; bytes: number }, [number]>(`DELETE FROM registry_archive AS a
      WHERE a.id=? AND ${SUPERSEDED_ARCHIVE} RETURNING collection,length(CAST(value_json AS BLOB)) AS bytes`).get(id);
    if (removed) {
      db.query(`INSERT INTO registry_archive_retirement_totals(collection,retired,bytes) VALUES (?,1,?)
        ON CONFLICT(collection) DO UPDATE SET retired=retired+1,bytes=bytes+excluded.bytes`).run(removed.collection,removed.bytes);
      retired++;
    }
    db.query("DELETE FROM registry_archive_retirements WHERE id=?").run(id);
  }
  return retired;
}

export interface ArchiveCollectionMeasurement {
  collection: string;
  logicalRows: number;
  coldRows: number;
  hotBytes: number;
  compatibilityBytes: number;
  liveArchiveBytes: number;
  eligibleRows: number;
  eligibleBytes: number;
  highWaterRows: number;
}

/** Read-only, including before the upgrade is installed. Payload bytes count a
 * logical cold row once; compatibility bytes describe a separate physical copy. */
export function archiveRetirementReport(db: Database, now = Date.now()) {
  return db.transaction(() => {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const totals = tables.has("registry_archive_retirement_totals")
      ? db.query("SELECT collection,retired,bytes FROM registry_archive_retirement_totals ORDER BY collection").all() : [];
    const observed = tables.has("registry_archive_retirements")
      ? db.query("SELECT COUNT(*) AS rows,COALESCE(SUM(bytes),0) AS bytes FROM registry_archive_retirements").get() : { rows: 0,bytes: 0 };
    const collections = db.query<ArchiveCollectionMeasurement, []>(`WITH names AS (SELECT collection FROM registry_rows UNION SELECT collection FROM registry_archive)
      SELECT n.collection,
        (SELECT COUNT(*) FROM registry_rows r WHERE r.collection=n.collection) AS logicalRows,
        (SELECT COUNT(*) FROM registry_cold c WHERE c.collection=n.collection) AS coldRows,
        (SELECT COALESCE(SUM(length(CAST(r.value_json AS BLOB))),0) FROM registry_hot_rows r WHERE r.collection=n.collection) AS hotBytes,
        (SELECT COALESCE(SUM(length(CAST(r.value_json AS BLOB))),0) FROM registry_rows r JOIN registry_cold c USING(collection,row_key) WHERE r.collection=n.collection) AS compatibilityBytes,
        (SELECT COALESCE(SUM(length(CAST(a.value_json AS BLOB))),0) FROM registry_archive a WHERE a.collection=n.collection AND a.id IN (SELECT archive_id FROM registry_cold)) AS liveArchiveBytes,
        (SELECT COUNT(*) FROM registry_archive a WHERE a.collection=n.collection AND ${SUPERSEDED_ARCHIVE.replace("NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.archive_id=a.id)","a.id NOT IN (SELECT archive_id FROM registry_cold)")}) AS eligibleRows,
        (SELECT COALESCE(SUM(length(CAST(a.value_json AS BLOB))),0) FROM registry_archive a WHERE a.collection=n.collection AND ${SUPERSEDED_ARCHIVE.replace("NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.archive_id=a.id)","a.id NOT IN (SELECT archive_id FROM registry_cold)")}) AS eligibleBytes,
        (SELECT COUNT(*) FROM registry_archive a WHERE a.collection=n.collection AND a.id NOT IN (SELECT archive_id FROM registry_cold)
          AND NOT COALESCE(a.row_order < (SELECT MAX(r.row_order) FROM registry_rows r WHERE r.collection=a.collection),0)) AS highWaterRows
      FROM names n ORDER BY n.collection`).all();
    const cutoff = new Date(now - 7*24*60*60_000).toISOString();
    const B1 = db.query(`SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(value_json AS BLOB))),0) AS bytes
      FROM registry_records WHERE collection='heldDeliveries'
      AND (json_extract(value_json,'$.state')='delivered' OR (json_extract(value_json,'$.state')='failed'
        AND substr(COALESCE(json_extract(value_json,'$.error'),''),1,?) != ?))
      AND julianday(COALESCE(json_extract(value_json,'$.deliveredAt'),json_extract(value_json,'$.createdAt')))<julianday(?)`).get(MIGRATION_DELIVERY_CANCELLATION_PREFIX.length,MIGRATION_DELIVERY_CANCELLATION_PREFIX,cutoff);
    const B2 = db.query(`SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(json_extract(value_json,'$.evidenceText') AS BLOB))),0) AS bytes
      FROM registry_records WHERE collection='deliveryOperationOwners' AND json_extract(value_json,'$.terminalState')='delivered'
      AND julianday(json_extract(value_json,'$.settledAt'))<julianday(?)`).get(cutoff);
    const pragma = (name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string,number>)[0]!;
    const report = { category: "A", graceMs: RETIREMENT_GRACE_MS, batchSize: RETIREMENT_BATCH, cycleBatches: RETIREMENT_CYCLE_BATCHES,
      collections, observed, retired: totals, B1, B2,
      pages: { pageSize: pragma("page_size"), allocated: pragma("page_count"), free: pragma("freelist_count") },
      backup: "Hourly backup is a full VACUUM INTO; no incremental backup is implemented. Payload bytes are not backup write bytes." };
    return { ...report, digest: crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex") };
  })();
}
