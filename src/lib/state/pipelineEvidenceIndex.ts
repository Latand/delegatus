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
// Raw JSON values retain types and escaped
// strings, including lone surrogates that SQLite's decoded text can conflate.
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
const authority = (row: string) => `CASE WHEN ${unambiguous(row)} THEN json_array(
    ${authorityFields.map(field => raw(row, field)).join(",")},
    json_type(${row}.value_json,'$.delivery'), json_type(${row}.value_json,'$.state'),
    ${state(row)}) END`;

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
    json_array('branch',${decoded(row, "repoDir")},${decoded(row, "branch")}),
    CASE WHEN ${text("delivery.target.branch")} AND substr(${deliveryBranch},1,11)='refs/heads/'
      THEN json_array('branch',${decoded(row, "repoDir")},substr(${deliveryBranch},12)) END,
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
  WHEN ${authority("OLD")} IS NULL OR ${authority("NEW")} IS NULL THEN 'record'
  ELSE nullif(rtrim(${[...authorityFields, "delivery", "state"].map(field =>
    `CASE WHEN (${fieldValue("OLD", field)}) IS NOT (${fieldValue("NEW", field)}) THEN '${field},' ELSE '' END`,
  ).join(" || ")},','),'') END`;
// SQLite can suppress the DELETE trigger for an implicit OR REPLACE delete.
// Capture the occupied destination before the statement and consume it only
// after an actual insert or move. A conflict ignored by SQLite advances no clock.
const replacedKey = "json_array('replaced',NEW.collection,NEW.row_key)";
const captureReplacement = `
  INSERT INTO pipeline_stage_authority
  SELECT ${replacedKey},-1,prior.row_key,'replace',${scopeKeys("prior")}
  FROM state_rows prior WHERE prior.collection=NEW.collection AND prior.row_key=NEW.row_key
    AND ${scopeKeys("prior")} IS NOT ${scopeKeys("NEW")}
  ON CONFLICT(key) DO UPDATE SET fields=excluded.fields;
`;
const clearReplacement = `DELETE FROM pipeline_stage_authority WHERE key=${replacedKey};`;
const replacedScopes = `SELECT scopes.value AS key,prior.lane_id FROM pipeline_stage_authority prior
  CROSS JOIN json_each(prior.fields) scopes WHERE prior.key=${replacedKey} AND scopes.type='array'`;
const recordStageAuthority = (operation: string, rows: string[], fields = "NULL") => `
  INSERT INTO pipeline_stage_authority
  SELECT key,(SELECT revision FROM pipeline_authority_clock WHERE id=1),lane_id,${operation},${fields}
  FROM (${rows.map(row => `SELECT keys.value AS key,${row}.row_key AS lane_id
    FROM json_each(${scopeKeys(row)}) keys WHERE ${tracked(row)} AND keys.type='array'`).join(" UNION ALL ")})
  -- The preceding clock update affects one row exactly when authority changed.
  WHERE changes()=1
  ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,lane_id=excluded.lane_id,
    operation=excluded.operation,fields=excluded.fields;
`;
const recordReplacement = (when = "true") => `
  INSERT INTO pipeline_stage_authority
  SELECT key,(SELECT revision FROM pipeline_authority_clock WHERE id=1),lane_id,'replace',NULL
  FROM (${replacedScopes}) WHERE ${when}
  ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,lane_id=excluded.lane_id,
    operation=excluded.operation,fields=excluded.fields;
  ${clearReplacement}
`;
const moved = "(OLD.collection IS NOT NEW.collection OR OLD.row_key IS NOT NEW.row_key)";
const triggers = [
  `CREATE TRIGGER pipeline_stage_authority_before_insert BEFORE INSERT ON state_rows WHEN ${tracked("NEW")}
    BEGIN ${clearReplacement} ${captureReplacement} END`,
  `CREATE TRIGGER pipeline_stage_authority_before_move BEFORE UPDATE OF collection,row_key ON state_rows
    WHEN ${tracked("NEW")} AND ${moved} BEGIN ${clearReplacement} ${captureReplacement} END`,
  `CREATE TRIGGER pipeline_evidence_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    ${recordStageAuthority("'insert'", ["NEW"])}
    ${recordReplacement()}
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_update AFTER UPDATE ON state_rows WHEN ${tracked("OLD")} OR ${tracked("NEW")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1 AND
      (${moved}
        OR ${authority("OLD")} IS NULL OR ${authority("NEW")} IS NULL
        OR ${authority("OLD")} IS NOT ${authority("NEW")});
    ${recordStageAuthority(`CASE WHEN ${moved} THEN 'move' ELSE 'update' END`, ["OLD", "NEW"], changedFields)}
    ${recordReplacement(moved)}
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    ${recordStageAuthority("'delete'", ["OLD"])}
    DELETE FROM pipeline_stage_authority WHERE key=json_array('replaced',OLD.collection,OLD.row_key);
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} END`,
];

/** Installed inside the state schema's existing transaction. No historical
 * payload is parsed or copied. Triggers also observe older writers and raw SQL
 * that leaves the collection revision and change journal unchanged. */
export function installPipelineEvidenceIndex(db: Database, directory: string): void {
  if (pipelineEvidenceIndexReady(db) || !mayRunStateStartupMutation(directory)) return;
  installHistoryProjection(db, directory);
  for (const sql of tables) db.exec(sql);
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
    "SELECT name,sql FROM sqlite_master WHERE name IN ('pipeline_evidence_clock','pipeline_authority_clock','pipeline_evidence_rows','pipeline_evidence_insert','pipeline_evidence_update','pipeline_evidence_delete','pipeline_evidence_changed','pipeline_stage_authority','pipeline_stage_authority_before_insert','pipeline_stage_authority_before_move')",
  ).all();
  return historyProjectionReady(db) && rows.length === 5 + triggers.length
    && rows.some(row => row.sql === revisionIndex) && triggers.every(sql => rows.some(row => row.sql === sql));
}
