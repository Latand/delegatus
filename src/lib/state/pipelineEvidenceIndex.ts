import { historyProjectionReady, installHistoryProjection } from "./historyProjection";
import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

const tables = [
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO pipeline_evidence_clock VALUES (1,0)",
  "CREATE TABLE IF NOT EXISTS pipeline_authority_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO pipeline_authority_clock VALUES (1,0)",
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_rows (collection TEXT NOT NULL, row_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(collection,row_key))",
];
const tracked = (row: string) => `${row}.collection IN ('pipelines','pipelines_archive')`;
const touch = (row: string) => `INSERT INTO pipeline_evidence_rows VALUES (${row}.collection,${row}.row_key,(SELECT revision FROM pipeline_evidence_clock WHERE id=1))
  ON CONFLICT(collection,row_key) DO UPDATE SET revision=excluded.revision;`;
const revisionIndex = "CREATE INDEX pipeline_evidence_changed ON pipeline_evidence_rows(revision,collection,row_key)";
// Match stageBranchOwnershipFence. Keep the general journal clock for readers
// that validate the complete record. Invalid JSON always revokes authority.
const authorityFields = [
  "id", "repoDir", "worktreeDir", "branch", "delivery.target", "delivery.active",
  "delivery.ownerId", "delivery.epoch", "delivery.publish",
];
const authority = (row: string) => `CASE WHEN json_valid(${row}.value_json) THEN json_array(
  json_extract(${row}.value_json,${authorityFields.map(field => `'$.${field}'`).join(",")}),
  json_type(${row}.value_json,'$.delivery'), json_type(${row}.value_json,'$.state'),
  CASE WHEN json_extract(${row}.value_json,'$.state') IN ('draft','provisioning','running','needs_decision','needs_review','paused','completed','closed')
    THEN json_extract(${row}.value_json,'$.state') IN ('completed','closed') END) END`;
const triggers = [
  `CREATE TRIGGER pipeline_evidence_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_update AFTER UPDATE ON state_rows WHEN ${tracked("OLD")} OR ${tracked("NEW")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1 AND
      (OLD.collection IS NOT NEW.collection OR OLD.row_key IS NOT NEW.row_key
        OR ${authority("OLD")} IS NULL OR ${authority("NEW")} IS NULL
        OR ${authority("OLD")} IS NOT ${authority("NEW")});
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")} BEGIN
    UPDATE pipeline_authority_clock SET revision=revision+1 WHERE id=1;
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
    "SELECT name,sql FROM sqlite_master WHERE name IN ('pipeline_evidence_clock','pipeline_authority_clock','pipeline_evidence_rows','pipeline_evidence_insert','pipeline_evidence_update','pipeline_evidence_delete','pipeline_evidence_changed')",
  ).all();
  return historyProjectionReady(db) && rows.length === 7 && rows.some(row => row.sql === revisionIndex) && triggers.every(sql => rows.some(row => row.sql === sql));
}
