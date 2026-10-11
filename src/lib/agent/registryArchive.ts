import type { Database } from "bun:sqlite";

const RECORDS_VIEW = `CREATE VIEW registry_records AS
  SELECT collection,row_key,value_json,row_order FROM registry_hot_rows
  UNION ALL SELECT c.collection,c.row_key,a.value_json,a.row_order
  FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id`;

/** Cold rows share the registry's transaction and backup boundary. registry_rows
 * keeps a compatibility copy for older processes during release handover;
 * current readers enumerate registry_hot_rows and fetch cold versions on demand.
 * Versions are immutable, so an already-held view can read that exact row.
 * Neither history nor launch idempotency has a time-based expiry. */
export function installRegistryArchive(db: Database): void {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS registry_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL,
      row_key TEXT NOT NULL, value_json TEXT NOT NULL, row_order INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS registry_cold (
      collection TEXT NOT NULL, row_key TEXT NOT NULL, archive_id INTEGER NOT NULL,
      PRIMARY KEY(collection, row_key), FOREIGN KEY(archive_id) REFERENCES registry_archive(id)
    )`,
    `CREATE VIEW IF NOT EXISTS registry_hot_rows AS SELECT r.* FROM registry_rows r
      WHERE NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection=r.collection AND c.row_key=r.row_key)`,
    `CREATE TABLE IF NOT EXISTS registry_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, row_key TEXT NOT NULL
    )`,
    ...["registry_rows", "registry_cold"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return `CREATE TRIGGER IF NOT EXISTS ${table}_changes_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN INSERT INTO registry_changes(collection,row_key) VALUES (${row}.collection,${row}.row_key); END`;
    })),
    ...["INSERT", "UPDATE", "DELETE"].map(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return `CREATE TRIGGER IF NOT EXISTS registry_meta_changes_${event.toLowerCase()} AFTER ${event} ON registry_meta
        BEGIN INSERT INTO registry_changes(collection,row_key) VALUES ('meta',${row}.key); END`;
    }),
    ...["INSERT","UPDATE","DELETE"].map(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return `CREATE TRIGGER IF NOT EXISTS registry_promote_cold_${event.toLowerCase()} AFTER ${event} ON registry_rows
        BEGIN DELETE FROM registry_cold WHERE collection=${row}.collection AND row_key=${row}.row_key; END`;
    }),
    `CREATE INDEX IF NOT EXISTS registry_archive_order ON registry_archive(collection,row_order)`,
    `CREATE INDEX IF NOT EXISTS registry_archive_key ON registry_archive(collection,row_key)`,
    ...["conversationId", "artifactPath", "clientAttemptId", "spawnCapabilityDigest", "parentConversationId", "state"].map(field =>
      `CREATE INDEX IF NOT EXISTS registry_archive_${field} ON registry_archive(collection,json_extract(value_json,'$.${field}'),row_order)`),
    `CREATE INDEX IF NOT EXISTS registry_archive_operation ON registry_archive(collection,json_extract(value_json,'$.command.operationId'),row_order)`,
    `CREATE INDEX IF NOT EXISTS registry_archive_launch ON registry_archive(collection,json_extract(value_json,'$.evidence.launchId'),row_order)`,
    `CREATE INDEX IF NOT EXISTS registry_archive_session ON registry_archive(collection,json_extract(value_json,'$.key.sessionId'),row_order)`,
    `CREATE INDEX IF NOT EXISTS registry_archive_status ON registry_archive(collection,json_extract(value_json,'$.status'),row_order)`,
    `CREATE INDEX IF NOT EXISTS registry_hot_operation ON registry_rows(collection,json_extract(value_json,'$.structuredHostOperationId'))`,
    `CREATE TRIGGER IF NOT EXISTS registry_archive_immutable_update BEFORE UPDATE ON registry_archive
      BEGIN SELECT RAISE(ABORT,'registry archive versions are immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS registry_archive_immutable_delete BEFORE DELETE ON registry_archive
      BEGIN SELECT RAISE(ABORT,'registry archive versions have no expiry'); END`,
    ...["INSERT", "UPDATE", "DELETE"].map(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return `CREATE TRIGGER IF NOT EXISTS registry_cold_grant_${event.toLowerCase()} AFTER ${event} ON registry_cold
        WHEN ${row}.collection IN ('entries','receipts','conversations','lineageEdges')
        BEGIN INSERT INTO registry_grant_changes(collection,row_key) VALUES (${row}.collection,${row}.row_key); END`;
    }),
  ]) db.run(statement);
  // Select identity from the indexed cold mapping. Selecting it from the archive
  // makes SQLite scan every cold row for each keyed read, including misses.
  // Upgrade existing installations atomically; no stored payload is rewritten.
  const installed = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='view' AND name='registry_records'",
  ).get();
  if (installed?.sql !== RECORDS_VIEW) {
    db.transaction(() => {
      db.run("DROP VIEW IF EXISTS registry_records");
      db.run(RECORDS_VIEW);
    }).immediate();
  }
}

/** Move only terminal evidence. Unknown or outstanding work stays hot; keyed
 * readers still see every row through registry_records. The pass is bounded
 * and is invoked by the existing hygiene owner, never by opening a reader. */
export function archiveInactiveRegistryRows(db: Database, limit: number): number {
  db.run(`CREATE TEMP TABLE IF NOT EXISTS registry_archive_candidates (
    collection TEXT NOT NULL,row_key TEXT NOT NULL,PRIMARY KEY(collection,row_key))`);
  db.run("DELETE FROM registry_archive_candidates");
  // Unary + removes the outer TEXT affinity without changing its value. SQLite
  // can then use the JSON expression indexes for the correlated identity reads.
  // CROSS JOIN keeps each generation ahead of its primary-key entry lookup.
  db.run(`INSERT INTO registry_archive_candidates
    SELECT collection,row_key FROM registry_hot_rows r WHERE
    (collection='entries' AND json_extract(value_json,'$.status')='dead'
      AND json_extract(value_json,'$.host') IS NULL
      AND json_extract(value_json,'$.structuredHost.process') IS NULL
      AND json_extract(value_json,'$.claimOwner') IS NULL
      AND json_extract(value_json,'$.pendingAction') IS NULL
      AND COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)=0)
    OR (collection='receipts' AND json_extract(value_json,'$.state') IN ('completed','failed','conflicted')
      AND json_extract(value_json,'$.queuedPinnedSpawn') IS NULL
      AND NOT EXISTS (SELECT 1 FROM registry_hot_rows e WHERE e.collection='entries'
        AND json_extract(e.value_json,'$.structuredHostOperationId')=+r.row_key
        AND (json_extract(e.value_json,'$.status')!='dead' OR json_extract(e.value_json,'$.structuredHost.process') IS NOT NULL
          OR json_extract(e.value_json,'$.host') IS NOT NULL OR json_extract(e.value_json,'$.claimOwner') IS NOT NULL
          OR json_extract(e.value_json,'$.pendingAction') IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM registry_hot_rows e WHERE e.collection='entries'
        AND e.row_key=json_extract(r.value_json,'$.key.engine')||':'||json_extract(r.value_json,'$.key.sessionId')
        AND (json_extract(e.value_json,'$.status')!='dead' OR json_extract(e.value_json,'$.structuredHost.process') IS NOT NULL
          OR json_extract(e.value_json,'$.host') IS NOT NULL OR json_extract(e.value_json,'$.claimOwner') IS NOT NULL
          OR json_extract(e.value_json,'$.pendingAction') IS NOT NULL)))
    OR (collection='conversations'
      AND json_extract(value_json,'$.migration') IS NULL
      AND json_extract(value_json,'$.reconfigure') IS NULL
      AND json_extract(value_json,'$.switchHold') IS NULL
      AND COALESCE(json_extract(value_json,'$.turn.state'),'unknown') IN ('unknown','idle','terminal')
      AND NOT EXISTS (SELECT 1 FROM json_each(r.value_json,'$.generations') g
        CROSS JOIN registry_hot_rows e ON e.collection='entries'
          AND e.row_key=json_extract(r.value_json,'$.engine')||':'||json_extract(g.value,'$.id'))
      AND NOT EXISTS (SELECT 1 FROM registry_hot_rows d WHERE d.collection='heldDeliveries'
        AND json_extract(d.value_json,'$.conversationId')=+r.row_key
        AND json_extract(d.value_json,'$.state') NOT IN ('delivered','failed','cancelled','superseded'))
      AND NOT EXISTS (SELECT 1 FROM registry_hot_rows s WHERE s.collection='receipts'
        AND json_extract(s.value_json,'$.conversationId')=+r.row_key
        AND json_extract(s.value_json,'$.state') NOT IN ('completed','failed','conflicted')))
    OR (collection IN ('lineageEdges','memberships') AND EXISTS (
      SELECT 1 FROM registry_cold c WHERE c.collection='conversations' AND c.row_key=r.row_key))
    OR (collection='migrationIntents' AND json_extract(value_json,'$.state') IN ('complete','stopped')
      AND NOT EXISTS (SELECT 1 FROM registry_hot_rows c WHERE c.collection='conversations'
        AND json_extract(c.value_json,'$.migration.intentId')=+r.row_key))
    OR (collection='heldDeliveries' AND json_extract(value_json,'$.state') IN ('delivered','failed','cancelled','superseded'))
    OR (collection='deliveryOperationOwners' AND json_extract(value_json,'$.terminalState') IN ('delivered','failed'))
    ORDER BY row_order LIMIT ?`, [limit]);
  const rows = db.query<{ collection: string; row_key: string }, []>(
    "SELECT collection,row_key FROM registry_archive_candidates").all();
  for (const row of rows) {
    const archived = db.query<{ id: number }, [string,string]>(
      "INSERT INTO registry_archive(collection,row_key,value_json,row_order) SELECT collection,row_key,value_json,row_order FROM registry_rows WHERE collection=? AND row_key=? RETURNING id")
      .get(row.collection,row.row_key)!;
    db.query("INSERT INTO registry_cold(collection,row_key,archive_id) VALUES (?,?,?)")
      .run(row.collection,row.row_key,archived.id);
  }
  return rows.length;
}
