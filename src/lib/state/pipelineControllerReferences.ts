import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

export type PipelineAttemptReference = { stageId: string; n: number; run: number; attempt: number; position: number; firstHost: number };

/** Write-time projections. Old writers participate through the same row
 * triggers; controller reads never enumerate retained payloads for ownership. */
export function installPipelineControllerReferences(db: Database, directory: string): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='pipeline_refs_delete'").get()) return;
  if (!mayRunStateStartupMutation(directory)) return;
  db.exec(`CREATE TABLE pipeline_attempt_refs (
    row_key TEXT NOT NULL, position INTEGER NOT NULL, stageId TEXT NOT NULL, n INTEGER NOT NULL,
    run INTEGER NOT NULL, attempt INTEGER NOT NULL, historical INTEGER NOT NULL, terminal INTEGER NOT NULL, firstHost INTEGER NOT NULL,
    PRIMARY KEY(row_key,position))`);
  db.exec("CREATE INDEX pipeline_attempt_terminal ON pipeline_attempt_refs(row_key,terminal,firstHost,position)");
  db.exec("CREATE INDEX pipeline_attempt_current ON pipeline_attempt_refs(row_key,stageId,historical,position DESC)");
  db.exec(`CREATE TABLE pipeline_owner_refs (
    row_key TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL, live INTEGER NOT NULL,
    PRIMARY KEY(row_key,kind,identity,live))`);
  db.exec("CREATE INDEX pipeline_owner_lookup ON pipeline_owner_refs(kind,identity,live)");
  db.exec("UPDATE pipeline_tick_work SET attempt_cursor=0");
  const populate = (source: string, key: string) => {
    const value = "controller_source.payload";
    const attemptValue = "(CASE WHEN a.type='object' THEN a.value ELSE '{}' END)";
    const runValue = "(CASE WHEN r.type='object' THEN r.value ELSE '{}' END)";
    const hostValue = "(CASE WHEN h.type='object' THEN h.value ELSE '{}' END)";
    const cte = `WITH controller_source AS MATERIALIZED (SELECT jsonb(${source}) AS payload)`;
    const field = (name: string) => `json_extract(${value},'$.${name}')`;
    const op = field("delivery.operation");
    // Same fail-closed publication custody as pipelineHostHasLiveWork.
    const publishing = `((${op} IS NOT NULL AND (
      ${field("delivery.operation.state")} IS NOT 'settled'
      OR json_type(${value},'$.delivery.operation.result.ok') IS NULL
      OR json_type(${value},'$.delivery.operation.result.ok') NOT IN ('true','false')
      OR (json_type(${value},'$.delivery.operation.result.ok')='false' AND json_type(${value},'$.delivery.operation.result.error') IS NOT 'text')
      OR (json_type(${value},'$.delivery.operation.result.ok')='true' AND (
        json_type(${value},'$.delivery.operation.result.sha') IS NOT 'text'
        OR COALESCE(${field("delivery.operation.result.remote")},'') NOT IN ('published','unavailable')
        OR (json_type(${value},'$.delivery.operation.result.uncertain') IS NOT NULL AND json_type(${value},'$.delivery.operation.result.uncertain')!='false')))
      OR (json_type(${value},'$.delivery.operation.executor') IS NOT NULL AND json_type(${value},'$.delivery.operation.executor.finished') IS NOT 'true')))
      OR ${field("publicationAdmission.state")}='pending' OR ${field("remoteAction.state")}='pending' OR ${field("cursor.state")}='committing')`;
    const attempts = `FROM controller_source, jsonb_each(CASE WHEN json_type(${value},'$.runs')='array' THEN jsonb_extract(${value},'$.runs') ELSE '[]' END) r,
      jsonb_each(CASE WHEN json_type(${runValue},'$.attempts')='array' THEN jsonb_extract(${runValue},'$.attempts') ELSE '[]' END) a`;
    const identities = (source: string, fields: string[]) => `json_each(json_object(${fields.map(name => `'${name}',json_extract(${source},'$.${name}')`).join(",")})) ids`;
    return `
      INSERT INTO pipeline_attempt_refs ${cte}, refs AS MATERIALIZED (
        SELECT CAST(r.key AS INTEGER)*4294967296+CAST(a.key AS INTEGER)+1 AS position,
          json_extract(${runValue},'$.stageId') AS stageId,json_extract(${attemptValue},'$.n') AS n,r.key AS run,a.key AS attempt,
          COALESCE(json_extract(${attemptValue},'$.historical'),0) AS historical,
          CASE WHEN (json_extract(${attemptValue},'$.verdict') IS NOT NULL OR COALESCE(json_extract(${attemptValue},'$.completedAt'),'')!='')
            AND (COALESCE(json_extract(${attemptValue},'$.conversationId'),'')='' OR json_extract(${attemptValue},'$.conversationId') IS NOT ${field("srcConversationId")})
            AND (COALESCE(json_extract(${attemptValue},'$.agentPath'),'')='' OR json_extract(${attemptValue},'$.agentPath') IS NOT ${field("srcPath")})
            AND NOT (COALESCE(${field("terminalReap.settledAt")},'')!='' AND ${field("terminalReap.settledAttempts")} IS NULL)
            AND NOT EXISTS (SELECT 1 FROM json_each(${value},'$.terminalReap.settledAttempts') settled
              WHERE settled.value=json_extract(${runValue},'$.stageId')||':'||CAST(json_extract(${attemptValue},'$.n') AS INTEGER))
            AND NOT EXISTS (SELECT 1 FROM json_each(${value},'$.unconfirmedHosts') h
              WHERE json_extract(${hostValue},'$.stageId')=json_extract(${runValue},'$.stageId') AND json_extract(${hostValue},'$.attempt')=json_extract(${attemptValue},'$.n'))
            THEN 1 ELSE 0 END AS terminal,
          COALESCE(json_extract(${attemptValue},'$.conversationId'),'')||'|'||COALESCE(json_extract(${attemptValue},'$.agentPath'),'')||'|'||COALESCE(json_extract(${attemptValue},'$.paneId'),'') AS hostIdentity
        ${attempts} WHERE json_type(${runValue},'$.stageId')='text' AND json_type(${attemptValue},'$.n') IN ('integer','real'))
        SELECT ${key},position,stageId,n,run,attempt,historical,terminal,
          CASE WHEN ROW_NUMBER() OVER (PARTITION BY hostIdentity ORDER BY position)=1 AND hostIdentity!='||' THEN 1 ELSE 0 END FROM refs
      ${["unconfirmedHosts","closeReport.unconfirmed","closeReport.pending"].map((field,index) => `UNION ALL
        SELECT ${key},281474976710656+${index}*4294967296+CAST(h.key AS INTEGER),json_extract(${hostValue},'$.stageId'),json_extract(${hostValue},'$.attempt'),-1,-1,1,0,0
        FROM controller_source, jsonb_each(CASE WHEN json_type(${value},'$.${field}')='array' THEN jsonb_extract(${value},'$.${field}') ELSE '[]' END) h WHERE json_type(${hostValue},'$.stageId')='text' AND json_type(${hostValue},'$.attempt') IN ('integer','real')`).join("\n")};
      INSERT INTO pipeline_owner_refs ${cte}
        SELECT ${key},ids.key,ids.value,COALESCE((${publishing}) OR ${field("state")} NOT IN ('completed','closed'),0)
        FROM controller_source, ${identities(value,["srcConversationId","srcPath"])} WHERE ids.value IS NOT NULL AND ids.value!=''
      UNION ALL
        SELECT ${key},ids.key,ids.value,COALESCE((${publishing}) OR json_extract(${attemptValue},'$.state') IN ('pending','spawning','running','reviewing','committing')
          OR (json_extract(${attemptValue},'$.verdict') IS NULL AND COALESCE(json_extract(${attemptValue},'$.completedAt'),'')='')
          OR (json_extract(${attemptValue},'$.activation') IS NOT NULL AND json_extract(${attemptValue},'$.activation.phase') IS NOT 'settled'),0)
        ${attempts}, ${identities(attemptValue,["conversationId","agentPath","paneId","launchId","sessionId"])} WHERE ids.value IS NOT NULL AND ids.value!=''
      UNION ALL
        SELECT ${key},'flow',json_extract(${attemptValue},'$.flowId'),0 ${attempts} WHERE json_extract(${attemptValue},'$.flowId') IS NOT NULL ON CONFLICT DO NOTHING;`;
  };
  const clear = (key: string, guard = "1") => `DELETE FROM pipeline_attempt_refs WHERE row_key=${key} AND (${guard}); DELETE FROM pipeline_owner_refs WHERE row_key=${key} AND (${guard});`;
  db.exec(`CREATE TRIGGER pipeline_refs_insert AFTER INSERT ON state_rows WHEN NEW.collection='pipelines' AND json_valid(NEW.value_json) BEGIN ${populate("NEW.value_json","NEW.row_key")} END`);
  const paths = ["runs","state","srcConversationId","srcPath","delivery.operation","publicationAdmission.state","remoteAction.state",
    "cursor.state","terminalReap.settledAttempts","terminalReap.settledAt","unconfirmedHosts","closeReport.unconfirmed","closeReport.pending"]
    .map(field => `'$.${field}'`).join(",");
  const changed = `OLD.collection IS NOT NEW.collection OR OLD.row_key IS NOT NEW.row_key OR CASE
    WHEN json_valid(OLD.value_json) AND json_valid(NEW.value_json)
    THEN jsonb_extract(OLD.value_json,${paths}) IS NOT jsonb_extract(NEW.value_json,${paths}) ELSE 1 END`;
  db.exec(`CREATE TRIGGER pipeline_refs_update AFTER UPDATE ON state_rows WHEN (OLD.collection='pipelines' OR NEW.collection='pipelines') AND (${changed}) BEGIN
    ${clear("OLD.row_key", "OLD.collection='pipelines'")}
    ${populate("CASE WHEN NEW.collection='pipelines' AND json_valid(NEW.value_json) THEN NEW.value_json ELSE '{}' END","NEW.row_key")}
    END`);
  db.exec(`CREATE TRIGGER pipeline_refs_delete AFTER DELETE ON state_rows WHEN OLD.collection='pipelines' BEGIN ${clear("OLD.row_key")} END`);
  for (const row of db.query<{ row_key: string }, []>("SELECT row_key FROM state_rows WHERE collection='pipelines' AND json_valid(value_json)").all()) {
    // Initialization is fenced and transactional. Quote captured JSON as SQL data.
    const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const key = literal(row.row_key);
    db.exec(populate(`(SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=${key})`,key));
  }
}
