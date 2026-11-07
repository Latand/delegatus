import type { Database as BunDatabase } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { databaseFileIdentity, openCurrentDatabase } from "@/lib/state/currentDatabase";
import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import path from "node:path";

export interface CreationAdmissionRecord { request_key: string; digest: string; candidate_id: string; kind: "admitted" | "fenced" }

function open(prepare = false) {
  const filename = statePath("state.sqlite");
  const db = openCurrentDatabase(filename, () => {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as { Database: typeof BunDatabase } | undefined;
    if (!sqlite) throw new Error("pipeline admission requires the Bun runtime");
    const connection = new sqlite.Database(filename, { readwrite: true, create: false, strict: true });
    connection.exec("PRAGMA busy_timeout=0"); return connection;
  });
  if (prepare && mayRunStateStartupMutation(path.dirname(filename))) {
    assertStateStartupMutation(path.dirname(filename), "pipeline admission schema");
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_pipeline_admission (
      request_key TEXT PRIMARY KEY, digest TEXT NOT NULL, candidate_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('admitted','fenced'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_pipeline_admission_candidate ON mcp_pipeline_admission(candidate_id);
    CREATE TRIGGER IF NOT EXISTS mcp_pipeline_admission_update BEFORE UPDATE ON mcp_pipeline_admission
      BEGIN SELECT RAISE(ABORT,'pipeline admission identities are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mcp_pipeline_admission_delete BEFORE DELETE ON mcp_pipeline_admission
      BEGIN SELECT RAISE(ABORT,'pipeline admission identities have no expiry'); END;`);
    for (const event of ["INSERT", "UPDATE OF value_json"]) {
      const suffix = event === "INSERT" ? "insert" : "update";
      db.exec(`CREATE TRIGGER IF NOT EXISTS mcp_pipeline_admit_${suffix} BEFORE ${event} ON state_rows
        WHEN NEW.collection='pipelines' AND json_valid(NEW.value_json)
          AND json_extract(NEW.value_json,'$.creationRequest.key') IS NOT NULL BEGIN
        SELECT CASE WHEN EXISTS (SELECT 1 FROM mcp_pipeline_admission
          WHERE request_key=json_extract(NEW.value_json,'$.creationRequest.key') AND kind='fenced')
          THEN RAISE(ABORT,'pipeline admission was fenced') END;
        SELECT CASE WHEN EXISTS (SELECT 1 FROM mcp_pipeline_admission
          WHERE request_key=json_extract(NEW.value_json,'$.creationRequest.key')
          AND digest IS NOT json_extract(NEW.value_json,'$.creationRequest.digest'))
          THEN RAISE(ABORT,'pipeline admission digest changed') END;
        SELECT CASE WHEN EXISTS (SELECT 1 FROM mcp_pipeline_admission
          WHERE request_key=json_extract(NEW.value_json,'$.creationRequest.key')
          AND candidate_id IS NOT json_extract(NEW.value_json,'$.id'))
          THEN RAISE(ABORT,'pipeline admission candidate changed') END;
        INSERT OR IGNORE INTO mcp_pipeline_admission(request_key,digest,candidate_id,kind)
          SELECT json_extract(NEW.value_json,'$.creationRequest.key'),json_extract(NEW.value_json,'$.creationRequest.digest'),
            json_extract(NEW.value_json,'$.id'),'admitted'
          WHERE json_extract(NEW.value_json,'$.creationRequest.admissionProtocol')=1;
        SELECT CASE WHEN json_extract(NEW.value_json,'$.creationRequest.admissionProtocol')=1
          AND NOT EXISTS (SELECT 1 FROM mcp_pipeline_admission
            WHERE request_key=json_extract(NEW.value_json,'$.creationRequest.key') AND kind='admitted'
              AND digest=json_extract(NEW.value_json,'$.creationRequest.digest')
              AND candidate_id=json_extract(NEW.value_json,'$.id'))
          THEN RAISE(ABORT,'pipeline admission candidate is already held') END;
      END`);
    }
  }
  return db;
}

export function pipelineAdmissionIdentity(prepare = false): string | null {
  const db = open(prepare);
  try {
    const prepared = db.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='mcp_pipeline_admit_insert'").get();
    return prepared ? databaseFileIdentity(statePath("state.sqlite")) : null;
  } finally { db.close(); }
}

export function readCreationAdmission(key: string): CreationAdmissionRecord | null {
  const db = open();
  try { return db.query<CreationAdmissionRecord, [string]>("SELECT request_key,digest,candidate_id,kind FROM mcp_pipeline_admission WHERE request_key=?").get(key); }
  finally { db.close(); }
}

/** The account lock serializes this write with pipeline and queue admission. */
export function recordCreationAdmission(record: CreationAdmissionRecord, assertAuthority: () => void): CreationAdmissionRecord {
  const db = open();
  try {
    db.exec("BEGIN IMMEDIATE");
    assertAuthority();
    const existing = db.query<CreationAdmissionRecord, [string]>("SELECT request_key,digest,candidate_id,kind FROM mcp_pipeline_admission WHERE request_key=?").get(record.request_key);
    if (existing && (existing.digest !== record.digest || existing.candidate_id !== record.candidate_id)) throw new Error("pipeline admission identity changed");
    if (!existing) db.query("INSERT INTO mcp_pipeline_admission(request_key,digest,candidate_id,kind) VALUES (?,?,?,?)")
      .run(record.request_key, record.digest, record.candidate_id, record.kind);
    db.exec("COMMIT");
    return existing ?? record;
  } catch (error) { if (db.inTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}
