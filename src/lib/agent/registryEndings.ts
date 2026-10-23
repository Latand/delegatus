import type { Database } from "bun:sqlite";

/* One current ending per operation. Compatibility writers and archive mapping
   changes update it in their own transaction. Payloads remain authoritative. */
const field = (path: string) => `json_extract(d.value_json,'$.${path}')`;
const kind = (path: string) => `json_type(d.value_json,'$.${path}')`;
/* The operation a delivery names after normalization: a falsy or absent
   command.operationId takes the delivery's own id (canonicalHeldDeliveryCommand). */
const deliveryOperation = `CASE WHEN ${kind("command.operationId")} IS NULL OR ${kind("command.operationId")} IN ('null','false')
    OR (${kind("command.operationId")} IN ('integer','real') AND ${field("command.operationId")}=0)
    OR (${kind("command.operationId")}='text' AND ${field("command.operationId")}='')
  THEN ${field("id")} WHEN ${kind("command.operationId")}='text' THEN ${field("command.operationId")} END`;
const settledDeliveryAt = "json_extract(o.value_json,'$.settledDelivery.deliveredAt')";
const isoInstant = (text: string) => `(${text} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND julianday(${text}) IS NOT NULL)`;
/* The later of two stored instants, compared as instants: text order puts
   'Thu, 01 Oct…' after '2026-10-23…'. A pair SQL cannot parse is kept whole
   as a JSON array with no instant; endingInstant reads the later in JS. */
const laterInstant = (a: string, b: string) => `CASE WHEN ${a} IS NULL THEN ${b} WHEN ${b} IS NULL THEN ${a}
  WHEN ${isoInstant(a)} AND ${isoInstant(b)} THEN CASE WHEN julianday(${a})>=julianday(${b}) THEN ${a} ELSE ${b} END
  ELSE json_array(${a},${b}) END`;
/* A delivery stored without its digest gets one computed from its text on
   normalization, which SQL cannot reproduce. Such a delivery may or may not be
   the owner's, so the later of both candidate instants stands; the caller
   judges each named owner by its normalized ending. */
const endingText = `CASE WHEN json_type(o.value_json,'$.settledAt')='text'
  THEN json_extract(o.value_json,'$.settledAt') ELSE COALESCE(
    (SELECT CASE WHEN ${kind("requestDigest")}='text' THEN ${field("deliveredAt")}
        ELSE ${laterInstant(field("deliveredAt"), settledDeliveryAt)} END
      FROM registry_records d
      WHERE d.collection='heldDeliveries' AND d.row_key=json_extract(o.value_json,'$.deliveryId')
        AND (${deliveryOperation})=o.row_key
        AND (${kind("requestDigest")} IS NOT 'text' OR ${field("requestDigest")}=json_extract(o.value_json,'$.requestDigest'))),
    ${settledDeliveryAt}) END`;
const endingSelect = `SELECT o.row_key, json_extract(o.value_json,'$.deliveryId'),
  CASE WHEN (${endingText}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
    THEN CAST(round((julianday(${endingText})-2440587.5)*86400000) AS INTEGER) END, ${endingText}
  FROM registry_records o WHERE o.collection='deliveryOperationOwners'`;

/** The instant a projected ending names: its stored text, or the later of
    a candidate pair kept as a JSON array. NaN when neither parses. */
export function endingInstant(text: string): number {
  if (!text.startsWith("[")) return Date.parse(text);
  let candidates: unknown;
  try { candidates = JSON.parse(text); } catch { return NaN; }
  if (!Array.isArray(candidates)) return NaN;
  const instants = candidates.flatMap(value => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? [ms] : [];
  });
  return instants.length ? Math.max(...instants) : NaN;
}

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
    const ms = endingInstant(row.ending_text);
    parsed.run(Number.isFinite(ms) ? ms : null, Number.isFinite(ms) ? row.ending_text : null, row.operation_id);
  }
  return keys.length < limit && legacy.length < limit;
}


export function registryEndingsPrepared(db: Database): boolean {
  return db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()?.value === "complete"
    && !db.query("SELECT 1 FROM registry_owner_endings WHERE ending_ms IS NULL AND ending_text IS NOT NULL LIMIT 1").get();
}
