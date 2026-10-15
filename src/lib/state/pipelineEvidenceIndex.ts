import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

const tables = [
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO pipeline_evidence_clock VALUES (1,0)",
  "CREATE TABLE IF NOT EXISTS pipeline_evidence_rows (collection TEXT NOT NULL, row_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(collection,row_key))",
];
const tracked = (row: string) => `${row}.collection IN ('pipelines','pipelines_archive')`;
const touch = (row: string) => `INSERT INTO pipeline_evidence_rows VALUES (${row}.collection,${row}.row_key,(SELECT revision FROM pipeline_evidence_clock WHERE id=1))
  ON CONFLICT(collection,row_key) DO UPDATE SET revision=excluded.revision;`;
const triggers = [
  `CREATE TRIGGER pipeline_evidence_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")} BEGIN
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_update AFTER UPDATE ON state_rows WHEN ${tracked("OLD")} OR ${tracked("NEW")} BEGIN
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} ${touch("NEW")} END`,
  `CREATE TRIGGER pipeline_evidence_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")} BEGIN
    UPDATE pipeline_evidence_clock SET revision=revision+1 WHERE id=1; ${touch("OLD")} END`,
];

/** Installed inside the state schema's existing transaction. No historical
 * payload is parsed or copied. Triggers also observe older writers and raw SQL
 * that leaves the collection revision and change journal unchanged. */
export function installPipelineEvidenceIndex(db: Database, directory: string): void {
  if (pipelineEvidenceIndexReady(db) || !mayRunStateStartupMutation(directory)) return;
  for (const sql of tables) db.exec(sql);
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
  const rows = db.query<{ name: string; sql: string }, []>(
    "SELECT name,sql FROM sqlite_master WHERE name IN ('pipeline_evidence_clock','pipeline_evidence_rows','pipeline_evidence_insert','pipeline_evidence_update','pipeline_evidence_delete')",
  ).all();
  return rows.length === 5 && triggers.every(sql => rows.some(row => row.sql === sql))
    && Boolean(db.query("SELECT 1 FROM pipeline_evidence_clock WHERE id=1").get());
}
