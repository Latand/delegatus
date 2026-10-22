import type { Database } from "bun:sqlite";

/* One current ending per operation. Compatibility writers and archive mapping
   changes update it in their own transaction. Payloads remain authoritative. */
const endingText = `CASE WHEN json_type(o.value_json,'$.settledAt')='text'
  THEN json_extract(o.value_json,'$.settledAt') ELSE COALESCE(
    (SELECT json_extract(d.value_json,'$.deliveredAt') FROM registry_records d
      WHERE d.collection='heldDeliveries' AND d.row_key=json_extract(o.value_json,'$.deliveryId')
        AND json_extract(d.value_json,'$.command.operationId')=o.row_key
        AND json_extract(d.value_json,'$.requestDigest')=json_extract(o.value_json,'$.requestDigest')),
    json_extract(o.value_json,'$.settledDelivery.deliveredAt')) END`;
const endingSelect = `SELECT o.row_key, json_extract(o.value_json,'$.deliveryId'),
  CASE WHEN (${endingText}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
    THEN CAST(round((julianday(${endingText})-2440587.5)*86400000) AS INTEGER) END, ${endingText}
  FROM registry_records o WHERE o.collection='deliveryOperationOwners'`;

export function refreshOwnerEndingSql(predicate: string): string {
  return `INSERT INTO registry_owner_endings(operation_id,delivery_id,ending_ms,ending_text)
    ${endingSelect} AND (${predicate}) ON CONFLICT(operation_id) DO UPDATE SET
      delivery_id=excluded.delivery_id,ending_ms=excluded.ending_ms,ending_text=excluded.ending_text`;
}

export function installRegistryEndings(db: Database): void {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS registry_owner_endings (
      operation_id TEXT PRIMARY KEY, delivery_id TEXT, ending_ms INTEGER, ending_text TEXT)`,
    "CREATE INDEX IF NOT EXISTS registry_owner_endings_time ON registry_owner_endings(ending_ms,operation_id)",
    "CREATE INDEX IF NOT EXISTS registry_owner_endings_delivery ON registry_owner_endings(delivery_id,operation_id)",
    "CREATE INDEX IF NOT EXISTS registry_owner_endings_unparsed ON registry_owner_endings(operation_id) WHERE ending_ms IS NULL AND ending_text IS NOT NULL",
    ...["registry_rows", "registry_cold"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return `CREATE TRIGGER IF NOT EXISTS ${table}_ending_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN ${row}.collection IN ('deliveryOperationOwners','heldDeliveries') BEGIN
          DELETE FROM registry_owner_endings WHERE operation_id=${row}.row_key AND ${row}.collection='deliveryOperationOwners';
          ${refreshOwnerEndingSql(`o.row_key=${row}.row_key AND ${row}.collection='deliveryOperationOwners'`)};
          ${refreshOwnerEndingSql(`o.row_key IN (SELECT operation_id FROM registry_owner_endings WHERE delivery_id=${row}.row_key)
            AND ${row}.collection='heldDeliveries'`)};
        END`;
    })),
  ]) db.run(statement);
}

/** Bootstrap by key, never OFFSET. Each committed cursor covers exactly the
    projection rows in that transaction; interruption resumes after that key. */
export function prepareRegistryEndingsBatch(db: Database, limit = 16): boolean {
  const mark = db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()?.value;
  const after = mark && mark !== "complete" ? JSON.parse(mark) as string : "";
  const keys = mark === "complete" ? [] : db.query<{ row_key: string }, [string, number]>(`SELECT row_key FROM registry_rows
    WHERE collection='deliveryOperationOwners' AND row_key>? ORDER BY row_key LIMIT ?`).all(after, limit);
  const insert = db.query(refreshOwnerEndingSql("o.row_key=?"));
  for (const key of keys) insert.run(key.row_key);
  if (mark !== "complete") db.query("INSERT OR REPLACE INTO registry_meta(key,value) VALUES ('owner_endings_cursor',?)")
    .run(keys.length < limit ? "complete" : JSON.stringify(keys.at(-1)!.row_key));
  const legacy = db.query<{ operation_id: string; ending_text: string }, [number]>(`SELECT operation_id,ending_text FROM registry_owner_endings
    WHERE ending_ms IS NULL AND ending_text IS NOT NULL LIMIT ?`).all(limit);
  const parsed = db.query("UPDATE registry_owner_endings SET ending_ms=?,ending_text=? WHERE operation_id=?");
  for (const row of legacy) {
    const ms = Date.parse(row.ending_text);
    parsed.run(Number.isFinite(ms) ? ms : null, Number.isFinite(ms) ? row.ending_text : null, row.operation_id);
  }
  return keys.length < limit && legacy.length < limit;
}


export function registryEndingsPrepared(db: Database): boolean {
  return db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()?.value === "complete"
    && !db.query("SELECT 1 FROM registry_owner_endings WHERE ending_ms IS NULL AND ending_text IS NOT NULL LIMIT 1").get();
}
