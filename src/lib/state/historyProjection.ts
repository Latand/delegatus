import path from "node:path";
import { hotStateSqliteWriterReady, hotStatePreparingWriterReady } from "./hotStateAuthority";
import { FileTransactionBusyError } from "./fileTransaction";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { statePath } from "@/lib/configDir";
import { observeSqlite } from "@/lib/sqliteReadAttribution";
import { databaseFileIdentity, openCurrentDatabase } from "./currentDatabase";
import { stateLockAttempt, stateLockDeferral, waitForStateLock } from "./lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { AgentLivenessPipelineRef, LivenessFlow } from "@/lib/lifecycle/liveness";
import type { fleetLimitWaits } from "@/lib/mcp/agentFleet";

const tracked = (row: string) => `${row}.collection IN ('pipelines','pipelines_archive','flows')`;
const enqueue = (row: string) => `INSERT INTO history_pending SELECT ${row}.collection,${row}.row_key WHERE ${tracked(row)} ON CONFLICT(collection,row_key) DO NOTHING;`;
const triggers = [
  `CREATE TRIGGER history_insert AFTER INSERT ON state_rows WHEN ${tracked("NEW")} BEGIN ${enqueue("NEW")} END`,
  `CREATE TRIGGER history_update AFTER UPDATE ON state_rows WHEN ${tracked("OLD")} OR ${tracked("NEW")} BEGIN ${enqueue("OLD")} ${enqueue("NEW")} END`,
  `CREATE TRIGGER history_delete AFTER DELETE ON state_rows WHEN ${tracked("OLD")} BEGIN ${enqueue("OLD")} END`,
];

export function historyProjectionReady(db: Database): boolean {
  const rows = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE name LIKE 'history_%'").all();
  const names = new Set(rows.map(row => row.name));
  return ["history_meta", "history_pending", "history_inputs", "history_runs", "history_attempts", "history_rounds", "history_projects", "history_conversation", "history_path", "history_project", "history_reviewer"].every(name => names.has(name))
    && triggers.every(sql => rows.some(row => row.sql === sql));
}

/** Schema installation queues identities only. Existing payloads are projected
 * cooperatively on demand; neither startup nor a request decodes them in JS.
 * Every writer, including an older release, queues changes transactionally. */
export function installHistoryProjection(db: Database, directory: string): void {
  if (historyProjectionReady(db) || !mayRunStateStartupMutation(directory)) return;
  for (const sql of triggers) db.exec(`DROP TRIGGER IF EXISTS ${sql.split(" ")[2]!}`);
  for (const table of ["history_meta","history_pending","history_inputs","history_projects","history_runs","history_attempts","history_rounds"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const sql of [
    "CREATE TABLE history_meta(generation TEXT NOT NULL,revision INTEGER NOT NULL)",
    "INSERT INTO history_meta VALUES (lower(hex(randomblob(16))),0)",
    "CREATE TABLE history_pending(collection TEXT NOT NULL,row_key TEXT NOT NULL,PRIMARY KEY(collection,row_key))",
    "CREATE TABLE history_inputs(collection TEXT NOT NULL,row_key TEXT NOT NULL,row_order INTEGER NOT NULL,project TEXT,state TEXT,input BLOB NOT NULL,PRIMARY KEY(collection,row_key))",
    "CREATE TABLE history_projects(project TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
    "CREATE TABLE history_runs(collection TEXT NOT NULL,row_key TEXT NOT NULL,run INTEGER NOT NULL,role TEXT NOT NULL,PRIMARY KEY(collection,row_key,run))",
    `CREATE TABLE history_attempts(collection TEXT NOT NULL,row_key TEXT NOT NULL,run INTEGER NOT NULL,attempt INTEGER NOT NULL,
      stageId TEXT,n INTEGER,state TEXT,historical INTEGER,conversationId TEXT,agentPath TEXT,paneId TEXT,startedAt TEXT,role TEXT,providerWait TEXT,
      PRIMARY KEY(collection,row_key,run,attempt))`,
    "CREATE INDEX history_conversation ON history_attempts(conversationId,collection,historical)",
    "CREATE INDEX history_path ON history_attempts(agentPath,collection,historical)",
    "CREATE INDEX history_project ON history_inputs(project,collection,row_key)",
    `CREATE TABLE history_rounds(row_key TEXT NOT NULL,round INTEGER NOT NULL,reviewerPath TEXT,reviewerConversationId TEXT,
      reviewerPid INTEGER,reviewerIdentity TEXT,PRIMARY KEY(row_key,round))`,
    "CREATE INDEX history_reviewer ON history_rounds(reviewerPid)",
    ...triggers,
    "INSERT INTO history_pending SELECT collection,row_key FROM state_rows WHERE collection IN ('pipelines','pipelines_archive','flows')",
  ]) db.exec(sql);
}

// Compact inputs omit prompts, output, scaffolds, reports, decisions and journals.
const pipelineInput = `WITH source AS MATERIALIZED (SELECT jsonb(value_json) AS payload FROM state_rows WHERE collection=? AND row_key=?),
 runs AS MATERIALIZED (SELECT r.key,json_extract(r.value,'$.stageId') AS stageId,jsonb_extract(r.value,'$.attempts') AS attempts FROM source,json_each(payload,'$.runs') r),
 attempts AS MATERIALIZED (SELECT r.key AS run,a.key,jsonb(a.value) AS payload FROM runs r,json_each(r.attempts) a),
 compact AS MATERIALIZED (SELECT run,key,json_object(${["n","state","historical","conversationId","agentPath","paneId","startedAt","effectiveRole.roleId","providerWait"].map(field => `'${field === "effectiveRole.roleId" ? "role" : field}',json_extract(payload,'$.${field}')`).join(",")}) AS payload FROM attempts),
 compact_runs AS MATERIALIZED (SELECT r.key,json_object('stageId',r.stageId,'attempts',json_group_array(json(a.payload) ORDER BY a.key) FILTER (WHERE a.key IS NOT NULL)) AS payload
 FROM runs r LEFT JOIN compact a ON a.run=r.key GROUP BY r.key)
 SELECT jsonb_object('closedAt',json_extract(payload,'$.closedAt'),'roles',(SELECT jsonb_group_array(jsonb_object('id',json_extract(s.value,'$.id'),'role',json_extract(s.value,'$.role.roleId'))) FROM json_each(payload,'$.stages') s),
 'runs',(SELECT jsonb_group_array(jsonb(payload) ORDER BY key) FROM compact_runs)) AS input FROM source`;
const pipelineSql = pipelineInput;
const flowSql = `WITH source AS MATERIALIZED (SELECT jsonb(value_json) AS payload FROM state_rows WHERE collection=? AND row_key=?)
 SELECT jsonb_object('reviewerMode',json_extract(payload,'$.reviewerMode'),'rounds',
 (SELECT jsonb_group_array(jsonb_object('reviewerPath',json_extract(r.value,'$.reviewerPath'),'reviewerConversationId',json_extract(r.value,'$.reviewerConversationId'),
 'reviewerPid',json_extract(r.value,'$.reviewerPid'),'reviewerIdentity',json_extract(r.value,'$.reviewerIdentity')) ORDER BY r.key) FROM json_each(payload,'$.rounds') r)) AS input FROM source`;

function projectOne(db: Database, collection: string, key: string): void {
  const row = db.query<{ project: string | null; state: string | null; row_order: number }, [string,string]>(
    "SELECT json_extract(value_json,'$.project') AS project,json_extract(value_json,'$.state') AS state,row_order FROM state_rows WHERE collection=? AND row_key=?").get(collection,key);
  const input = row ? db.query<{ input: Uint8Array }, [string,string]>(collection === "flows" ? flowSql : pipelineSql).get(collection,key)!.input : null;
  const before = db.query<{ project: string | null; same: number }, [Uint8Array | null,number | null,string | null,string | null,string,string]>(
    "SELECT project,(input IS ? AND row_order IS ? AND project IS ? AND state IS ?) AS same FROM history_inputs WHERE collection=? AND row_key=?")
    .get(input,row?.row_order ?? null,row?.project ?? null,row?.state ?? null,collection,key);
  if (before?.same) return;
  const projects = collection === "flows" ? [] : [...new Set([before?.project,row?.project].filter((value): value is string => typeof value === "string"))];
  db.exec("UPDATE history_meta SET revision=revision+1");
  for (const project of projects) {
    db.query("INSERT INTO history_projects SELECT ?,revision FROM history_meta WHERE 1 ON CONFLICT(project) DO UPDATE SET revision=excluded.revision").run(project);
  }
  const forgetEmptyProjects = () => {
    for (const project of projects) db.query("DELETE FROM history_projects WHERE project=? AND NOT EXISTS (SELECT 1 FROM history_inputs WHERE project=? AND collection IN ('pipelines','pipelines_archive'))").run(project,project);
  };
  for (const table of ["history_runs","history_attempts","history_inputs"]) db.query(`DELETE FROM ${table} WHERE collection=? AND row_key=?`).run(collection,key);
  if (collection === "flows") db.query("DELETE FROM history_rounds WHERE row_key=?").run(key);
  if (!row || !input) { forgetEmptyProjects(); return; }
  db.query("INSERT INTO history_inputs VALUES (?,?,?,?,?,?)").run(collection,key,row.row_order,row.project,row.state,input);
  if (collection === "flows") {
    db.query(`INSERT INTO history_rounds SELECT ?,r.key,json_extract(r.value,'$.reviewerPath'),json_extract(r.value,'$.reviewerConversationId'),
      json_extract(r.value,'$.reviewerPid'),json_extract(r.value,'$.reviewerIdentity') FROM json_each(?,'$.rounds') r
      WHERE json_extract(?,'$.reviewerMode')='headless' AND json_extract(r.value,'$.reviewerPid')>0`).run(key,input,input);
    return;
  }
  forgetEmptyProjects();
  db.query(`INSERT INTO history_runs SELECT ?,?,r.key,COALESCE((SELECT json_extract(s.value,'$.role') FROM json_each(?,'$.roles') s
    WHERE json_extract(s.value,'$.id')=json_extract(r.value,'$.stageId') LIMIT 1),'unassigned') FROM json_each(?,'$.runs') r`).run(collection,key,input,input);
  db.query(`INSERT INTO history_attempts SELECT ?,?,r.key,a.key,json_extract(r.value,'$.stageId'),
    ${["n","state","historical","conversationId","agentPath","paneId","startedAt","role","providerWait"].map(field => `json_extract(a.value,'$.${field}')`).join(",")}
    FROM json_each(?,'$.runs') r,json_each(r.value,'$.attempts') a`).run(collection,key,input);
}

type CountCache = { stamp: string; at: number; until: number; value: Record<string,number> };
type Shared = { connections: Map<string,Database>; counts: Map<string,CountCache> };
const host = globalThis as typeof globalThis & { __delegatusHistoryProjectionV1?: Shared };
const shared = host.__delegatusHistoryProjectionV1 ??= { connections: new Map(), counts: new Map() };

function connection(filename: string): Database {
  let db = shared.connections.get(filename);
  if (!db) {
    const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
    db = openCurrentDatabase(filename, () => {
      const opened = observeSqlite(new sqlite.Database(filename,{ strict: true }),"history");
      opened.exec("PRAGMA busy_timeout=0");
      return opened;
    });
  }
  shared.connections.delete(filename); shared.connections.set(filename,db);
  while (shared.connections.size > 2) {
    const key = shared.connections.keys().next().value!;
    shared.connections.get(key)!.close(); shared.connections.delete(key);
  }
  return db;
}

function projectionStep<T>(deadline: number, work: () => T): T {
  try { return stateLockAttempt("history.projection", work); }
  catch (error) {
    if (stateLockDeferral(error) && performance.now() >= deadline) throw new FileTransactionBusyError("history projection admission exceeded its deadline");
    throw error;
  }
}

/** One row per transaction, with timer opportunities every 4 ms and one
 * asynchronous admission deadline. The final read checks the queue in its own
 * snapshot, so a peer commit during a yield cannot leave a stale answer. */
export async function readHistoryProjection<T>(read: (db: Database) => T, options: {
  filename?: string;
  collections?: readonly ("pipelines" | "pipelines_archive" | "flows")[];
  signal?: AbortSignal;
  startup?: boolean;
  deadlineMs?: number;
} = {}): Promise<T> {
  const filename = options.filename ?? statePath("state.sqlite");
  const collections = options.collections ?? ["pipelines","pipelines_archive","flows"];
  if (!collections.length) throw new Error("history projection requires a collection");
  const assertWriter = () => {
    if (!hotStateSqliteWriterReady(path.dirname(filename)) && !(options.startup && hotStatePreparingWriterReady(path.dirname(filename)))) {
      throw new FileTransactionBusyError("history projection writes are fenced during release handoff");
    }
  };
  const pendingSql = `SELECT collection,row_key FROM history_pending WHERE collection IN (${collections.map(()=>"?").join(",")}) LIMIT 1`;
  const deadline = options.deadlineMs ?? performance.now() + 30_000;
  return withViewerOperation("history.prepare", () => waitForStateLock("history.projection", async () => {
    let slice = performance.now();
    for (;;) {
      options.signal?.throwIfAborted();
      const db = connection(filename);
      const answer = projectionStep(deadline, () => {
        db.exec("BEGIN");
        try {
          const pending = db.query<{ collection: string; row_key: string }, SQLQueryBindings[]>(pendingSql).get(...collections);
          if (!pending) { const value = withViewerOperation("history.read", () => read(db)); db.exec("COMMIT"); return { value }; }
          db.exec("ROLLBACK");
        } catch (error) { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
        if (performance.now() > deadline) throw new FileTransactionBusyError("history projection preparation exceeded its deadline");
        assertWriter();
        db.exec("BEGIN IMMEDIATE");
        try {
          const pending = db.query<{ collection: string; row_key: string }, SQLQueryBindings[]>(pendingSql).get(...collections);
          assertWriter();
          if (pending) {
            withViewerOperation("history.project-row", () => projectOne(db,pending.collection,pending.row_key));
            db.query("DELETE FROM history_pending WHERE collection=? AND row_key=?").run(pending.collection,pending.row_key);
          }
          assertWriter();
          db.exec("COMMIT");
          return null;
        } catch (error) { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
      });
      if (answer) return answer.value;
      if (performance.now() - slice >= 4) { await new Promise<void>(resolve => setTimeout(resolve,0)); slice = performance.now(); }
    }
  }, { signal: options.signal, waitMs: Math.max(0,deadline-performance.now()) }));
}

export function historyPipelineRef(db: Database, conversationId: string | null, path: string): AgentLivenessPipelineRef | null {
  const read = (field: "conversationId" | "agentPath", value: string) => db.query<AgentLivenessPipelineRef,[string]>(`SELECT a.row_key AS pipelineId,a.stageId,a.n AS attempt,
    a.state AS reportedState,p.state AS reportedPipelineState,a.paneId FROM history_attempts a JOIN history_inputs p USING(collection,row_key)
    WHERE a.${field}=? AND a.collection='pipelines' AND COALESCE(a.historical,0)=0
    ORDER BY p.row_order DESC,p.row_key DESC,a.run DESC,a.attempt DESC LIMIT 1`).get(value);
  return (conversationId ? read("conversationId",conversationId) : null) ?? read("agentPath",path);
}

export function historyHeadlessFlows(db: Database): LivenessFlow[] {
  const rows = db.query<{ row_key: string; reviewerPath: string | null; reviewerConversationId: string | null; reviewerPid: number; reviewerIdentity: string | null }, []>(
    "SELECT r.* FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key ORDER BY p.row_order,p.row_key,r.round").all();
  return rows.map(row => ({ reviewerMode: "headless" as const, rounds: [row] }));
}

/** Counts stay valid until a timestamp crosses a window edge. The shared LRU
 * retains at most 64 results and 256 KiB; it owns no pipeline payloads. */
export function historyAttemptCounts(db: Database, project: string, now: number): Record<string,number> {
  project = canonicalProject(project);
  const projects = [...new Set([project,...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === project)])].sort();
  const placeholders = projects.map(() => "?").join(",");
  const revisions = db.query<{ project: string; revision: number }, SQLQueryBindings[]>(`SELECT * FROM history_projects WHERE project IN (${placeholders}) ORDER BY project`).all(...projects);
  const generation = db.query<{generation:string},[]>("SELECT generation FROM history_meta").get()!.generation;
  const stamp = JSON.stringify([databaseFileIdentity(db.filename),generation,projects,revisions]);
  const key = JSON.stringify([db.filename,project]);
  const cached = shared.counts.get(key);
  if (cached?.stamp === stamp && now >= cached.at && now < cached.until) {
    shared.counts.delete(key); shared.counts.set(key,cached); return { ...cached.value };
  }
  const runs = db.query<{ role: string }, SQLQueryBindings[]>(`SELECT DISTINCT r.role FROM history_inputs p INDEXED BY history_project
    CROSS JOIN history_runs r ON r.collection=p.collection AND r.row_key=p.row_key WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders})`).all(...projects);
  const value: Record<string,number> = {};
  for (const row of runs) value[row.role] ??= 0;
  const attempts = db.query<{ startedAt: string | null; role: string }, SQLQueryBindings[]>(`SELECT a.startedAt,COALESCE(a.role,r.role) AS role FROM history_inputs p INDEXED BY history_project
    CROSS JOIN history_attempts a ON a.collection=p.collection AND a.row_key=p.row_key
    CROSS JOIN history_runs r ON r.collection=a.collection AND r.row_key=a.row_key AND r.run=a.run WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders}) AND a.startedAt IS NOT NULL`).all(...projects);
  let until = Infinity;
  const window = 30 * 24 * 60 * 60_000;
  for (const attempt of attempts) {
    const at = Date.parse(attempt.startedAt ?? "");
    if (!Number.isFinite(at)) continue;
    if (at > now) until = Math.min(until,at);
    else if (now - at <= window) { value[attempt.role] = (value[attempt.role] ?? 0) + 1; until = Math.min(until,at + window + 1); }
  }
  shared.counts.delete(key); shared.counts.set(key,{stamp,at:now,until,value});
  let bytes = 0;
  for (const entry of shared.counts) bytes += JSON.stringify(entry).length * 2;
  while (shared.counts.size > 64 || bytes > 256 * 1024) {
    const oldest = shared.counts.keys().next().value!;
    bytes -= JSON.stringify([oldest,shared.counts.get(oldest)]).length * 2; shared.counts.delete(oldest);
  }
  return { ...value };
}

/** Fleet reads only waits belonging to the bounded liveness answer. */
export function historyFleetLimitWaits(db: Database, ids: string[]): ReturnType<typeof fleetLimitWaits> {
  const waits: ReturnType<typeof fleetLimitWaits> = new Map();
  if (!ids.length) return waits;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query<{ conversationId: string; providerWait: string }, SQLQueryBindings[]>(`SELECT a.conversationId,a.providerWait FROM history_attempts a INDEXED BY history_conversation
    CROSS JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE a.collection='pipelines' AND a.conversationId IN (${placeholders})
    AND p.state NOT IN ('completed','closed') AND COALESCE(json_extract(p.input,'$.closedAt'),'')=''
    AND COALESCE(a.historical,0)=0 AND a.providerWait IS NOT NULL
    AND a.attempt=(SELECT MAX(b.attempt) FROM history_attempts b WHERE b.collection=a.collection AND b.row_key=a.row_key AND b.run=a.run AND COALESCE(b.historical,0)=0)
    ORDER BY p.row_order,p.row_key,a.run`).all(...ids);
  for (const row of rows) {
    const wait = JSON.parse(row.providerWait);
    if (wait.actionAt || wait.condition.kind !== "usage_limit") continue;
    waits.set(row.conversationId,{ account: wait.accountId ?? "unknown", resetsAt: wait.resetsAt === null ? null : new Date(wait.resetsAt).toISOString(), resumeAt: wait.resumeAt });
  }
  return waits;
}
