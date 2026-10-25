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
    /* A refresh compiled into any trigger a row write reaches, even one on
       another table, made every registry_rows write of any collection several
       times slower (2.4 instead of 0.4 ms per upsert on a fresh registry).
       The row triggers only queue an owner or delivery change, which older
       releases' writes also do. The projection reads as ready only with an
       empty queue; this release drains it in its own writes and preparation. */
    "CREATE TABLE IF NOT EXISTS registry_owner_ending_changes (collection TEXT NOT NULL, row_key TEXT NOT NULL)",
    ...["registry_rows", "registry_cold"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].flatMap(event => {
      const row = event === "DELETE" ? "OLD" : "NEW";
      return [
        // Earlier builds of this projection refreshed inside the row trigger.
        `DROP TRIGGER IF EXISTS ${table}_ending_${event.toLowerCase()}`,
        `CREATE TRIGGER IF NOT EXISTS ${table}_ending_change_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN ${row}.collection IN ('deliveryOperationOwners','heldDeliveries') BEGIN
          INSERT INTO registry_owner_ending_changes(collection,row_key) VALUES (${row}.collection,${row}.row_key);
        END`,
      ];
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
  // The traversal refreshes every key it has yet to reach; queued changes
  // drain once it is complete, before the projection reads as ready.
  const drained = (mark === "complete" || keys.length < limit) && drainRegistryEndingChanges(db, limit);
  const legacy = db.query<{ operation_id: string; ending_text: string }, [number]>(`SELECT operation_id,ending_text FROM registry_owner_endings
    WHERE ending_ms IS NULL AND ending_text IS NOT NULL LIMIT ?`).all(limit);
  const parsed = db.query("UPDATE registry_owner_endings SET ending_ms=?,ending_text=? WHERE operation_id=?");
  for (const row of legacy) {
    const ms = endingInstant(row.ending_text);
    parsed.run(Number.isFinite(ms) ? ms : null, Number.isFinite(ms) ? row.ending_text : null, row.operation_id);
  }
  return keys.length < limit && drained && legacy.length < limit;
}

/** Refreshes queued owner and delivery changes, oldest first, at most `limit`
    per call, with the statements the row triggers once ran. A change applies
    to the rows as they are now, so a late refresh writes what an immediate
    one would have. Answers whether the queue is empty afterwards. */
export function drainRegistryEndingChanges(db: Database, limit = 64): boolean {
  const queued = db.query<{ id: number; collection: string; row_key: string }, [number]>(
    "SELECT rowid AS id,collection,row_key FROM registry_owner_ending_changes ORDER BY rowid LIMIT ?").all(limit);
  if (queued.length === 0) return true;
  const removeOwner = db.query("DELETE FROM registry_owner_endings WHERE operation_id=?");
  const refreshOwner = db.query(refreshOwnerEndingSql("o.row_key=?"));
  const refreshDelivery = db.query(refreshOwnerEndingSql("o.row_key IN (SELECT operation_id FROM registry_owner_endings WHERE delivery_id=?)"));
  const done = db.query("DELETE FROM registry_owner_ending_changes WHERE rowid=?");
  for (const change of queued) {
    if (change.collection === "deliveryOperationOwners") {
      removeOwner.run(change.row_key);
      refreshOwner.run(change.row_key);
    } else refreshDelivery.run(change.row_key);
    done.run(change.id);
  }
  return queued.length < limit && !db.query("SELECT 1 FROM registry_owner_ending_changes LIMIT 1").get();
}

/** True while a change awaits its refresh. A file without the queue has no
    trigger keeping the projection current, so it never reads as drained. */
export function registryEndingChangesPending(db: Database): boolean {
  try { return Boolean(db.query("SELECT 1 FROM registry_owner_ending_changes LIMIT 1").get()); }
  catch { return true; }
}

export function registryEndingsPrepared(db: Database): boolean {
  return db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()?.value === "complete"
    && !registryEndingChangesPending(db)
    && !db.query("SELECT 1 FROM registry_owner_endings WHERE ending_ms IS NULL AND ending_text IS NOT NULL LIMIT 1").get();
}
