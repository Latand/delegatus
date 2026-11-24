import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

function someAttempt(value: string, predicate: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${value}, '$.runs') run,
    json_each(CASE WHEN run.type = 'object' THEN run.value ELSE '{}' END, '$.attempts') attempt
    WHERE ${predicate.replaceAll("attempt.value", "(CASE WHEN attempt.type = 'object' THEN attempt.value ELSE '{}' END)")})`;
}

/** These are candidate sets. Callers still apply their original admission
    predicates and revalidate the selected row before writing or acting. */
const predicates = (value: string) => {
  const at = (field: string) => `json_extract(${value}, '$.${field}')`;
  const attempt = (predicate: string) => someAttempt(value, predicate);
  return {
    admission: `${at("delivery")} IS NULL AND ${at("publicationAdmission.state")} = 'pending'`,
    provisioning: `${at("state")} = 'provisioning'`,
    running: `${at("state")} = 'running'`,
    "pending-stage": `${at("state")} = 'running' AND ${at("cursor.state")} = 'pending'`,
    hosts: `${at("state")} IN ('running', 'needs_decision')`,
    publication: `${at("delivery.active")} = 1 AND ${at("delivery.operation.state")} = 'running'`,
    "pending-publication": `${at("delivery.active")} = 1 AND ${at("delivery.operation.state")} = 'pending'`,
    "closed-launch": `${at("state")} = 'closed' AND ${attempt(`json_extract(attempt.value, '$.launchId') IS NOT NULL
      AND json_extract(attempt.value, '$.state') != 'failed' AND json_extract(attempt.value, '$.verdict') IS NULL`)}`,
    activation: attempt(`json_extract(attempt.value, '$.activation') IS NOT NULL`),
    "activation-close": `${at("activationCloseRequested")} = 1`,
    close: `${at("closeTeardown")} IS NOT NULL AND (${at("closeTeardown.phase")} != 'settled'
      OR (json_array_length(${value}, '$.closeReport.unconfirmed') > 0
        AND json_array_length(${value}, '$.closeReport.stillRunning') = 0))`,
    cleanup: `json_array_length(${value}, '$.pendingReviewFlowCleanup') > 0`,
    remote: `${at("remoteAction.state")} = 'pending'`,
    provenance: attempt(`json_extract(attempt.value, '$.report.provenance.state') = 'pending'`),
  };
};
export function pipelineControllerObligationSql(value: string): string {
  const hasHost = someAttempt(value, ["conversationId", "agentPath", "paneId"]
    .map(field => `COALESCE(json_extract(attempt.value,'$.${field}'),'')!=''`).join(" OR "));
  return `CASE WHEN NOT json_valid(${value}) THEN 1 ELSE (
    json_extract(${value},'$.state') NOT IN ('closed','completed')
    OR json_array_length(${value},'$.unconfirmedHosts')>0
    OR json_extract(${value},'$.provisioningJob') IS NOT NULL
    OR (json_extract(${value},'$.state') IN ('completed','closed') AND json_extract(${value},'$.closeTeardown') IS NULL
      AND json_extract(${value},'$.terminalReap.settledAt') IS NULL
      AND (json_extract(${value},'$.state')='completed' OR ${hasHost}))
    OR (${Object.values(predicates(value)).join(" OR ")})
  ) END`;
}
export type PipelineControllerSelection = keyof ReturnType<typeof predicates>;

/** The slot projection can be read while the ordinary lane walk is excluded.
 * Old writers maintain it through the same row triggers. */
export function installProvisioningSlotIndex(db: Database, directory: string): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='pipeline_provision_slot_update'").get()) return;
  if (!mayRunStateStartupMutation(directory)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_provision_slot (
    row_key TEXT PRIMARY KEY, due_at INTEGER, cache_identity TEXT
  );
  CREATE INDEX IF NOT EXISTS pipeline_provision_slot_due ON pipeline_provision_slot(due_at,row_key) WHERE due_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS pipeline_provision_slot_cache ON pipeline_provision_slot(cache_identity,row_key) WHERE cache_identity IS NOT NULL`);
  const select = (row: string, from = "") => {
    const at = (field: string) => `json_extract(${row}.value_json,'$.${field}')`;
    return `SELECT ${row}.row_key,
      CASE
        WHEN ${at("state")} IN ('closed','completed','running') OR ${at("hiddenAt")} IS NOT NULL THEN 0
        WHEN ${at("state")}='provisioning' AND ${at("provisioningJob.status")} IN ('running','awaitingApply','waiting')
        THEN COALESCE(${at("provisioningJob.retryAt")},${at("provisioningJob.deadlineAt")})
      END,
      CASE WHEN ${at("provisioningJob.status")}='running' THEN ${at("provisioningJob.cacheOwner.identity")} END
      ${from} WHERE ${row}.collection='pipelines' AND CASE WHEN json_valid(${row}.value_json)
        THEN ${at("provisioningJob.version")}=1 AND ${at("provisioningJob.kind")}='provision' ELSE 0 END`;
  };
  const put = `INSERT INTO pipeline_provision_slot(row_key,due_at,cache_identity) ${select("NEW")};`;
  const remove = "DELETE FROM pipeline_provision_slot WHERE row_key=OLD.row_key AND OLD.collection='pipelines';";
  db.exec(`CREATE TRIGGER pipeline_provision_slot_insert AFTER INSERT ON state_rows WHEN NEW.collection='pipelines'
      BEGIN ${put} END;
    CREATE TRIGGER pipeline_provision_slot_update AFTER UPDATE OF collection,row_key,value_json ON state_rows
      WHEN OLD.collection='pipelines' OR NEW.collection='pipelines' BEGIN ${remove} ${put} END;
    CREATE TRIGGER pipeline_provision_slot_delete AFTER DELETE ON state_rows WHEN OLD.collection='pipelines'
      BEGIN ${remove} END`);
  db.exec(`INSERT OR IGNORE INTO pipeline_provision_slot(row_key,due_at,cache_identity) ${select("r", "FROM state_rows r")}`);
}

/** Provisioning resources are ordered by their first durable enqueue. */
export function installProvisioningWaitIndex(db: Database, directory: string): boolean {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='pipeline_provision_wait_update'").get()) return false;
  if (!mayRunStateStartupMutation(directory)) return false;
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_provision_wait (
    row_key TEXT PRIMARY KEY, resource TEXT NOT NULL, sequence INTEGER NOT NULL, row_order INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pipeline_provision_wait_head ON pipeline_provision_wait(resource,sequence,row_order,row_key)`);
  const eligibleResource = (row: string) => `CASE WHEN json_valid(${row}) THEN CASE
    WHEN json_extract(${row},'$.state')='provisioning' AND json_extract(${row},'$.hiddenAt') IS NULL
      AND json_extract(${row},'$.closedAt') IS NULL THEN json_extract(${row},'$.provisioningJob.resource') END END`;
  const resource = eligibleResource("NEW.value_json");
  const put = `INSERT INTO pipeline_provision_wait(row_key,resource,sequence,row_order)
    SELECT NEW.row_key,${resource},NEW.row_revision,NEW.row_order
    WHERE NEW.collection='pipelines' AND json_valid(NEW.value_json) AND ${resource} IS NOT NULL
    ON CONFLICT(row_key) DO UPDATE SET sequence=CASE WHEN resource=excluded.resource THEN sequence ELSE excluded.sequence END,
      resource=excluded.resource,row_order=excluded.row_order;`;
  db.exec(`CREATE TRIGGER pipeline_provision_wait_insert AFTER INSERT ON state_rows WHEN NEW.collection='pipelines'
      BEGIN ${put} END;
    CREATE TRIGGER pipeline_provision_wait_update AFTER UPDATE ON state_rows WHEN OLD.collection='pipelines' OR NEW.collection='pipelines'
      BEGIN
        DELETE FROM pipeline_provision_wait WHERE row_key=OLD.row_key AND OLD.collection='pipelines'
          AND (NEW.collection!='pipelines' OR NEW.row_key!=OLD.row_key OR CASE WHEN json_valid(NEW.value_json) THEN ${resource} IS NULL ELSE 1 END);
        ${put}
      END;
    CREATE TRIGGER pipeline_provision_wait_delete AFTER DELETE ON state_rows WHEN OLD.collection='pipelines'
      BEGIN DELETE FROM pipeline_provision_wait WHERE row_key=OLD.row_key; END`);
  db.exec(`INSERT OR IGNORE INTO pipeline_provision_wait(row_key,resource,sequence,row_order)
    SELECT row_key,${eligibleResource("value_json")},row_revision,row_order FROM state_rows
    WHERE collection='pipelines' AND ${eligibleResource("value_json")} IS NOT NULL`);
  return true;
}

/** Install and backfill under the caller's initialization transaction. Row
    triggers also cover older peers, keyed patches, moves and replacements;
    their candidate flags commit atomically with the authoritative payload. */
export function installPipelineControllerIndex(db: Database, directory: string): void {
  const objects = new Set(db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master WHERE name IN ('pipeline_controller_work', 'pipeline_controller_work_order',
      'pipeline_controller_work_insert', 'pipeline_controller_work_update', 'pipeline_controller_work_delete')
  `).all().map(row => row.name));
  if (objects.size === 5) return;
  // A candidate MCP reader can precede the new Viewer's schema initialization.
  // Ordinary collection reads do not need this optional controller projection.
  if (!mayRunStateStartupMutation(directory)) return;
  const installed = objects.has("pipeline_controller_work");
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_controller_work (
    kind TEXT NOT NULL, row_key TEXT NOT NULL, row_order INTEGER NOT NULL,
    PRIMARY KEY(kind, row_key)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS pipeline_controller_work_order ON pipeline_controller_work(kind, row_order, row_key)");
  const kinds = (value: string) => `CASE WHEN json_valid(${value}) THEN json_array(${Object.entries(predicates(value))
    .map(([kind, predicate]) => `CASE WHEN (${predicate}) THEN '${kind}' END`).join(", ")}) ELSE '[]' END`;
  const inserts = (value: string, key: string, order: string, collection: string) => `
    INSERT INTO pipeline_controller_work(kind, row_key, row_order)
    SELECT work.value, ${key}, ${order} FROM json_each(${kinds(value)}) work
    WHERE ${collection} = 'pipelines' AND work.value IS NOT NULL;`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS pipeline_controller_work_insert AFTER INSERT ON state_rows
    WHEN NEW.collection = 'pipelines' BEGIN
      ${inserts("NEW.value_json", "NEW.row_key", "NEW.row_order", "NEW.collection")}
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS pipeline_controller_work_update AFTER UPDATE ON state_rows
    WHEN OLD.collection = 'pipelines' OR NEW.collection = 'pipelines' BEGIN
      DELETE FROM pipeline_controller_work WHERE row_key = OLD.row_key AND OLD.collection = 'pipelines';
      ${inserts("NEW.value_json", "NEW.row_key", "NEW.row_order", "NEW.collection")}
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS pipeline_controller_work_delete AFTER DELETE ON state_rows
    WHEN OLD.collection = 'pipelines' BEGIN
      DELETE FROM pipeline_controller_work WHERE row_key = OLD.row_key;
    END`);
  if (!installed) {
    db.exec(`INSERT INTO pipeline_controller_work(kind, row_key, row_order)
      SELECT work.value, r.row_key, r.row_order FROM state_rows r, json_each(${kinds("r.value_json")}) work
      WHERE r.collection = 'pipelines' AND work.value IS NOT NULL`);
  }
}
