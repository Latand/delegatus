import { historyProjectionReady, installHistoryProjection } from "./historyProjection";
import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

const tables = [
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO pipeline_evidence_clock VALUES (1,0)",
  "CREATE TABLE IF NOT EXISTS pipeline_authority_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO pipeline_authority_clock VALUES (1,0)",
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_rows (collection TEXT NOT NULL, row_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(collection,row_key))",
  "CREATE TABLE IF NOT EXISTS pipeline_stage_authority (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, lane_id TEXT NOT NULL, operation TEXT NOT NULL, fields TEXT)",
  "CREATE TABLE IF NOT EXISTS pipeline_stage_authority_lane_scopes (collection TEXT NOT NULL, row_key TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(collection,row_key)) WITHOUT ROWID",
];
const tracked = (row: string) => `${row}.collection IN ('pipelines','pipelines_archive')`;
const taskIds = (row: string) => `CASE WHEN json_valid(${row}.value_json) THEN ${row}.value_json -> '$.taskIds' END`;
const insertTaskMembership = (row: string) => `INSERT OR IGNORE INTO pipeline_task_membership
  SELECT DISTINCT ${row}.collection,${row}.row_key,ids.value
  FROM json_each(CASE WHEN json_valid(${row}.value_json) THEN ${row}.value_json ELSE '{}' END,'$.taskIds') ids
  WHERE ${tracked(row)} AND typeof(ids.key)='integer' AND ids.type='text';`;
const deleteTaskMembership = (row: string) => `DELETE FROM pipeline_task_membership WHERE collection=${row}.collection AND row_key=${row}.row_key;`;
const membershipTriggers = [
  `CREATE TRIGGER pipeline_task_membership_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")}
    BEGIN ${insertTaskMembership("NEW")} END`,
  `CREATE TRIGGER pipeline_task_membership_update AFTER UPDATE ON state_rows
    WHEN (${tracked("OLD")} OR ${tracked("NEW")}) AND
      (OLD.collection IS NOT NEW.collection OR OLD.row_key IS NOT NEW.row_key OR ${taskIds("OLD")} IS NOT ${taskIds("NEW")})
    BEGIN ${deleteTaskMembership("OLD")} ${insertTaskMembership("NEW")} END`,
  `CREATE TRIGGER pipeline_task_membership_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")}
    BEGIN ${deleteTaskMembership("OLD")} END`,
];
export function pipelineTaskMembershipReady(names: ReadonlySet<string>): boolean {
  return ["pipeline_task_membership", "pipeline_task_membership_lookup", "pipeline_task_membership_insert",
    "pipeline_task_membership_update", "pipeline_task_membership_delete"].every(name => names.has(name));
}

/** Backfill scalar links once in the fenced schema transaction. Subsequent
 * mutations, including archive moves and writes by older peers, maintain them. */
export function installPipelineTaskMembership(db: Database, names: ReadonlySet<string>): void {
  if (pipelineTaskMembershipReady(names)) return;
  for (const sql of membershipTriggers) db.exec(`DROP TRIGGER IF EXISTS ${sql.split(" ")[2]}`);
  db.exec("DROP TABLE IF EXISTS pipeline_task_membership");
  db.exec(`CREATE TABLE pipeline_task_membership (collection TEXT NOT NULL, row_key TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY(collection,row_key,task_id)) WITHOUT ROWID`);
  db.exec("CREATE INDEX pipeline_task_membership_lookup ON pipeline_task_membership(task_id,collection,row_key)");
  db.exec(`INSERT OR IGNORE INTO pipeline_task_membership
    SELECT r.collection,r.row_key,ids.value FROM state_rows r
    CROSS JOIN json_each(CASE WHEN json_valid(r.value_json) THEN r.value_json ELSE '{}' END,'$.taskIds') ids
    WHERE ${tracked("r")} AND typeof(ids.key)='integer' AND ids.type='text'`);
  for (const sql of membershipTriggers) db.exec(sql);
}

const touch = (row: string) => `INSERT INTO pipeline_evidence_rows VALUES (${row}.collection,${row}.row_key,(SELECT revision FROM pipeline_evidence_clock WHERE id=1))
  ON CONFLICT(collection,row_key) DO UPDATE SET revision=excluded.revision;`;
const revisionIndex = "CREATE INDEX pipeline_evidence_changed ON pipeline_evidence_rows(revision,collection,row_key)";
// The multi-path json_extract keeps the selected raw JSON values, their types,
// numeric spelling, and escaped strings that SQLite's scalar decode can conflate.
// Duplicate or escaped member names in the authority record are ambiguous:
// every write invalidates freshness, even if SQLite sees the same first member.
// Keep this in SQL so older writers and independent raw connections are fenced.
const authorityFields = [
  "id", "repoDir", "worktreeDir", "branch", "delivery.target", "delivery.active",
  "delivery.ownerId", "delivery.epoch", "delivery.publish", "delivery.disposition",
];
const raw = (row: string, field: string) => `${row}.value_json -> '$.${field}'`;
const decoded = (row: string, field: string) => `json_extract(${row}.value_json,'$.${field}')`;
const state = (row: string) => `CASE WHEN ${decoded(row, "state")} IN ('draft','provisioning','running','needs_decision','needs_review','paused','completed','closed')
  THEN ${decoded(row, "state")} IN ('completed','closed') END`;
const ambiguousMembers = (json: string) => `EXISTS (SELECT 1 FROM json_each(${json})
  GROUP BY key HAVING count(*)>1 OR instr(fullkey,char(92))>0)`;
const unambiguous = (row: string) => `CASE WHEN json_valid(${row}.value_json) THEN
  NOT ${ambiguousMembers(`${row}.value_json`)}
    AND NOT ${ambiguousMembers(raw(row, "delivery"))}
    AND NOT ${ambiguousMembers(raw(row, "delivery.target"))}
  ELSE false END`;
// Invalid or ambiguous rows retain their complete raw value as an invalid
// sentinel. A single OLD/NEW comparison then detects every change without
// repeating the expensive JSON validation in separate NULL branches.
const authority = (row: string) => `CASE WHEN ${unambiguous(row)} THEN json_array(
    json_extract(${row}.value_json,${[...authorityFields.map(field => `'$.${field}'`), "'$.state'"].join(",")}),
    json_type(${row}.value_json,'$.delivery'))
    ELSE json_array('invalid',${row}.value_json) END`;

// Keep the last authority write to each coordinate, including vacated ones.
// A claim can leave and return between two observations. Both sides of a move
// must remain visible even after more writes to the same lane.
const scopeKeys = (row: string) => {
  const text = (field: string) => `json_type(${row}.value_json,'$.${field}') IS 'text'`;
  const deliveryBranch = decoded(row, "delivery.target.branch");
  return `CASE WHEN ${unambiguous(row)} THEN json_array(
    json_array('lane',${row}.row_key),
    json_array('lane',${decoded(row, "id")}),
    json_array('worktree',${decoded(row, "worktreeDir")}),
    json_array('branch-name',${decoded(row, "branch")}),
    CASE WHEN ${text("delivery.target.branch")} AND substr(${deliveryBranch},1,11)='refs/heads/'
      THEN json_array('branch-name',substr(${deliveryBranch},12)) END,
    CASE WHEN ${text("delivery.target.repository")} AND ${text("delivery.target.branch")}
      THEN json_array('target',${decoded(row, "delivery.target.repository")},${deliveryBranch}) END,
    CASE WHEN ${state(row)} IS NULL OR NOT (${["id", "repoDir", "worktreeDir", "branch"].map(text).join(" AND ")})
        OR (${raw(row, "delivery")} IS NOT NULL AND NOT (${text("delivery.target.repository")} AND ${text("delivery.target.branch")}))
      THEN json_array('unknown') END
  ) ELSE json_array(json_array('unknown')) END`;
};
const fieldValue = (row: string, field: string) => field === "state" ? state(row)
  : field === "delivery" ? `json_type(${row}.value_json,'$.delivery')` : raw(row, field);
const changedFields = `CASE
  WHEN OLD.collection IS NOT NEW.collection THEN 'collection'
  WHEN OLD.row_key IS NOT NEW.row_key THEN 'row_key'
  WHEN NOT (${unambiguous("OLD")}) OR NOT (${unambiguous("NEW")}) THEN 'record'
  ELSE nullif(rtrim(${[...authorityFields, "delivery", "state"].map(field =>
    `CASE WHEN (${fieldValue("OLD", field)}) IS NOT (${fieldValue("NEW", field)}) THEN '${field},' ELSE '' END`,
  ).join(" || ")},','),'') END`;
// SQLite can suppress the DELETE trigger for an implicit OR REPLACE delete.
// Capture the occupied destination before the statement and consume it only
// after an actual insert or move. A conflict ignored by SQLite advances no clock.
const replacedKey = "json_array('replaced',NEW.collection,NEW.row_key)";
const captureReplacement = `
  INSERT INTO pipeline_stage_authority
  SELECT ${replacedKey},-1,prior.row_key,'replace',prior.fields
  FROM pipeline_stage_authority_lane_scopes prior WHERE prior.collection=NEW.collection AND prior.row_key=NEW.row_key
  ON CONFLICT(key) DO UPDATE SET fields=excluded.fields;
`;
const clearReplacement = `DELETE FROM pipeline_stage_authority WHERE key=${replacedKey};`;
const replacedScopes = `SELECT scopes.value AS key,prior.lane_id FROM pipeline_stage_authority prior
  CROSS JOIN json_each(prior.fields) scopes WHERE prior.key=${replacedKey} AND scopes.type='array'`;
const recordStageAuthority = (operation: string, rows: string[], fields = "NULL", gate = "changes()=1") => `
  INSERT INTO pipeline_stage_authority
  SELECT key,(SELECT revision FROM pipeline_authority_clock WHERE id=1),lane_id,${operation},${fields}
  FROM (${rows.map(row => `SELECT keys.value AS key,${row}.row_key AS lane_id
    FROM json_each(CASE WHEN ${gate} THEN ${scopeKeys(row)} ELSE '[]' END) keys
    WHERE ${tracked(row)} AND keys.type='array'`).join(" UNION ALL ")})
  -- The preceding clock update affects one row exactly when authority changed.
  WHERE ${gate}
  ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,lane_id=excluded.lane_id,
    operation=excluded.operation,fields=excluded.fields;
`;
const recordReplacement = `
  INSERT INTO pipeline_stage_authority
  SELECT key,(SELECT revision FROM pipeline_authority_clock WHERE id=1),lane_id,'replace',NULL
  FROM (${replacedScopes}) WHERE true
  ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,lane_id=excluded.lane_id,
    operation=excluded.operation,fields=excluded.fields;
  ${clearReplacement}
`;
const recordLaneScopes = (row: string) => `INSERT INTO pipeline_stage_authority_lane_scopes(collection,row_key,fields)
  VALUES (${row}.collection,${row}.row_key,${scopeKeys(row)})
  ON CONFLICT(collection,row_key) DO UPDATE SET fields=excluded.fields;`;
const moved = "(OLD.collection IS NOT NEW.collection OR OLD.row_key IS NOT NEW.row_key)";
const triggers = [
  `CREATE TRIGGER pipeline_stage_authority_before_insert BEFORE INSERT ON state_rows WHEN ${tracked("NEW")}
    BEGIN ${clearReplacement} ${captureReplacement} END`,
  `CREATE TRIGGER pipeline_evidence_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    ${recordStageAuthority("'insert'", ["NEW"])}
    ${recordReplacement}
    ${recordLaneScopes("NEW")}
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_update AFTER UPDATE ON state_rows WHEN ${tracked("OLD")} OR ${tracked("NEW")} BEGIN
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} ${touch("NEW")} ${clearReplacement} END`,
  `CREATE TRIGGER pipeline_stage_authority_update AFTER UPDATE ON state_rows
    WHEN (${tracked("OLD")} OR ${tracked("NEW")}) AND
      (${moved} OR ${authority("OLD")} IS NOT ${authority("NEW")}) BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    ${recordStageAuthority(`CASE WHEN ${moved} THEN 'move' ELSE 'update' END`, ["OLD", "NEW"], changedFields, "true")}
    DELETE FROM pipeline_stage_authority_lane_scopes WHERE ${moved} AND ${tracked("OLD")} AND collection=OLD.collection AND row_key=OLD.row_key;
    INSERT INTO pipeline_stage_authority_lane_scopes(collection,row_key,fields)
      SELECT NEW.collection,NEW.row_key,${scopeKeys("NEW")} WHERE ${tracked("NEW")} AND true
      ON CONFLICT(collection,row_key) DO UPDATE SET fields=excluded.fields; END`,
  `CREATE TRIGGER pipeline_evidence_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    ${recordStageAuthority("'delete'", ["OLD"])}
    DELETE FROM pipeline_stage_authority_lane_scopes WHERE collection=OLD.collection AND row_key=OLD.row_key;
    DELETE FROM pipeline_stage_authority WHERE key=json_array('replaced',OLD.collection,OLD.row_key);
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} END`,
];

/** Installed inside the state schema's existing transaction. Historical rows
 * are not scanned at install; triggers inspect only rows being written and
 * defer expanding a captured replacement row until SQLite inserts it. */
export function installPipelineEvidenceIndex(db: Database, directory: string): void {
  if (pipelineEvidenceIndexReady(db) || !mayRunStateStartupMutation(directory)) return;
  installHistoryProjection(db, directory);
  const hadLaneScopes = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_stage_authority_lane_scopes'").get());
  for (const sql of tables) db.exec(sql);
  if (!hadLaneScopes) db.exec(`INSERT OR IGNORE INTO pipeline_stage_authority_lane_scopes(collection,row_key,fields)
    SELECT r.collection,r.row_key,${scopeKeys("r")} FROM state_rows r WHERE ${tracked("r")}`);
  db.exec("DROP TRIGGER IF EXISTS pipeline_stage_authority_before_move");
  db.exec("DROP INDEX IF EXISTS pipeline_evidence_changed");
  db.exec(revisionIndex);
  for (const sql of triggers) {
    const name = sql.split(" ")[2]!;
    const current = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if (current?.sql === sql) continue;
    // Reinstalling tracking invalidates every prior compact witness.
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(sql);
  }
}

export function pipelineEvidenceIndexReady(db: Database): boolean {
  return pipelineEvidenceSchemaReady(db) && Boolean(db.query("SELECT 1 FROM pipeline_evidence_clock e JOIN pipeline_authority_clock a ON a.id=e.id WHERE e.id=1").get());
}

/** The schema half of readiness: it reads sqlite_master only, so one answer
    holds for as long as the file's schema_version does. */
export function pipelineEvidenceSchemaReady(db: Database): boolean {
  const rows = db.query<{ name: string; sql: string }, []>(
    "SELECT name,sql FROM sqlite_master WHERE name IN ('pipeline_evidence_clock','pipeline_authority_clock','pipeline_evidence_rows','pipeline_evidence_insert','pipeline_evidence_update','pipeline_evidence_delete','pipeline_evidence_changed','pipeline_stage_authority','pipeline_stage_authority_lane_scopes','pipeline_stage_authority_before_insert','pipeline_stage_authority_update')",
  ).all();
  return historyProjectionReady(db) && rows.length === 6 + triggers.length
    && rows.some(row => row.sql === revisionIndex) && triggers.every(sql => rows.some(row => row.sql === sql));
}
