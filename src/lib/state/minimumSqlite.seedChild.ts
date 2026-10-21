/**
 * Writes a state database the way a release from 1.13.0 to 1.15.0 left it
 * where Bun links a newer SQLite (Linux, the container image): this release's
 * schema and one pipeline row, then the statements those releases wrote that
 * the SQLite macOS ships cannot compile. Runs on Bun's own SQLite, in a child
 * of minimumSqlite.test.ts, whose process has the minimum SQLite instead.
 *
 * argv: <state.sqlite> <legacy | foreign> <pipeline JSON>
 *   legacy  — pipeline_refs_insert with jsonb and aggregate ORDER BY, and
 *             history_inputs as a BLOB column holding jsonb;
 *   foreign — also a view no store rebuilds, using aggregate ORDER BY.
 */
import { Database } from "bun:sqlite";
import { initializeStateCollections } from "./sqliteStateStore";

const [filename, mode, pipelineJson] = process.argv.slice(2);
if (!filename || (mode !== "legacy" && mode !== "foreign") || !pipelineJson) throw new Error("usage: <state.sqlite> <legacy|foreign> <pipeline JSON>");
const pipeline = JSON.parse(pipelineJson) as { id: string };

initializeStateCollections(filename, [{
  collection: "pipelines", schemaVersion: 1, key: (row: { id: string }) => row.id,
  migrationId: "minimum-sqlite-seed", loadRecords: () => [pipeline],
}]);

const db = new Database(filename);
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  db.exec("DROP TRIGGER pipeline_refs_insert");
  db.exec(`CREATE TRIGGER pipeline_refs_insert AFTER INSERT ON state_rows WHEN NEW.collection='pipelines' AND json_valid(NEW.value_json)
    BEGIN INSERT INTO pipeline_ref_inputs(row_key,value_json)
      SELECT NEW.row_key,jsonb_object('runs',(SELECT json_group_array(json(value) ORDER BY key) FROM json_each(NEW.value_json,'$.runs')))
      ON CONFLICT(row_key) DO UPDATE SET value_json=excluded.value_json WHERE value_json IS NOT excluded.value_json; END`);
  db.exec("DROP TABLE history_inputs");
  db.exec("CREATE TABLE history_inputs(collection TEXT NOT NULL,row_key TEXT NOT NULL,row_order INTEGER NOT NULL,project TEXT,state TEXT,input BLOB NOT NULL,PRIMARY KEY(collection,row_key))");
  db.query("INSERT INTO history_inputs VALUES ('pipelines',?,0,'fixture','running',jsonb('{\"runs\":[]}'))").run(pipeline.id);
  if (mode === "foreign") {
    db.exec("CREATE VIEW operator_pipeline_keys AS SELECT json_group_array(row_key ORDER BY row_key) AS keys FROM state_rows");
  }
  db.exec("COMMIT");
} finally {
  db.close();
}
