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
import { isStoredPipeline } from "@/lib/pipelines/store";
import { decodeFlow } from "@/lib/reviewHistory/decode";

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
  return ["history_meta", "history_flow_meta", "history_flow_changes", "history_count_meta", "history_count_roles", "history_pending", "history_inputs", "history_runs", "history_attempts", "history_rounds", "history_projects", "history_count_projects", "history_conversation", "history_path", "history_project", "history_reviewer", "history_started"].every(name => names.has(name))
    && triggers.every(sql => rows.some(row => row.sql === sql));
}

/** Schema installation queues identities only. Existing payloads are projected
 * cooperatively on demand; neither startup nor a request decodes them in JS.
 * Every writer, including an older release, queues changes transactionally. */
export function installHistoryProjection(db: Database, directory: string): void {
  if (historyProjectionReady(db) || !mayRunStateStartupMutation(directory)) return;
  for (const sql of triggers) db.exec(`DROP TRIGGER IF EXISTS ${sql.split(" ")[2]!}`);
  for (const table of ["history_meta","history_flow_meta","history_flow_changes","history_count_meta","history_count_roles","history_pending","history_inputs","history_projects","history_count_projects","history_runs","history_attempts","history_rounds"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const sql of [
    "CREATE TABLE history_meta(generation TEXT NOT NULL,revision INTEGER NOT NULL)",
    "INSERT INTO history_meta VALUES (lower(hex(randomblob(16))),0)",
    "CREATE TABLE history_flow_meta(revision INTEGER NOT NULL)",
    "INSERT INTO history_flow_meta VALUES (0)",
    "CREATE TABLE history_flow_changes(revision INTEGER PRIMARY KEY,row_key TEXT NOT NULL)",
    "CREATE TABLE history_count_meta(revision INTEGER NOT NULL)",
    "INSERT INTO history_count_meta VALUES (0)",
    "CREATE TABLE history_count_roles(project TEXT NOT NULL,role TEXT NOT NULL,runs INTEGER NOT NULL,PRIMARY KEY(project,role))",
    "CREATE TABLE history_pending(collection TEXT NOT NULL,row_key TEXT NOT NULL,PRIMARY KEY(collection,row_key))",
    "CREATE TABLE history_inputs(collection TEXT NOT NULL,row_key TEXT NOT NULL,row_order INTEGER NOT NULL,project TEXT,state TEXT,input BLOB NOT NULL,PRIMARY KEY(collection,row_key))",
    "CREATE TABLE history_projects(project TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
    "CREATE TABLE history_count_projects(project TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
    "CREATE TABLE history_runs(collection TEXT NOT NULL,row_key TEXT NOT NULL,run INTEGER NOT NULL,role TEXT NOT NULL,PRIMARY KEY(collection,row_key,run))",
    `CREATE TABLE history_attempts(collection TEXT NOT NULL,row_key TEXT NOT NULL,run INTEGER NOT NULL,attempt INTEGER NOT NULL,
      stageId TEXT,n INTEGER,state TEXT,historical INTEGER,conversationId TEXT,agentPath TEXT,paneId TEXT,startedAt TEXT,startedMs INTEGER,role TEXT,providerWait TEXT,
      PRIMARY KEY(collection,row_key,run,attempt))`,
    "CREATE INDEX history_conversation ON history_attempts(conversationId,collection,historical)",
    "CREATE INDEX history_path ON history_attempts(agentPath,collection,historical)",
    "CREATE INDEX history_project ON history_inputs(project,collection,row_key)",
    "CREATE INDEX history_started ON history_attempts(startedMs,collection,row_key)",
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

type CountUpdate = { oldProject: string | null; newProject: string | null; oldSignature: string; newSignature: string };
function projectOne(db: Database, collection: string, key: string): CountUpdate | null {
  const raw = db.query<{ value_json: string; row_order: number }, [string,string]>(
    "SELECT value_json,row_order FROM state_rows WHERE collection=? AND row_key=? AND json_valid(value_json)").get(collection,key);
  let decoded: unknown = null;
  if (raw) {
    try { decoded = JSON.parse(raw.value_json) as unknown; } catch { /* malformed persisted records remain stored and excluded */ }
  }
  const accepted = raw && (collection === "flows" ? decodeFlow(decoded) !== null : isStoredPipeline(decoded));
  const row = accepted ? db.query<{ project: string | null; state: string | null; row_order: number }, [string,string]>(
    "SELECT json_extract(value_json,'$.project') AS project,json_extract(value_json,'$.state') AS state,row_order FROM state_rows WHERE collection=? AND row_key=?").get(collection,key) : null;
  const input = row ? db.query<{ input: Uint8Array }, [string,string]>(collection === "flows" ? flowSql : pipelineSql).get(collection,key)!.input : null;
  const oldCountSignature = collection === "flows" ? "" : countSignature(db,collection,key);
  const newCountSignature = collection === "flows" || !input ? "" : countSignatureFromInput(db,input);
  const before = db.query<{ project: string | null; same: number }, [Uint8Array | null,number | null,string | null,string | null,string,string]>(
    "SELECT project,(input IS ? AND row_order IS ? AND project IS ? AND state IS ?) AS same FROM history_inputs WHERE collection=? AND row_key=?")
    .get(input,row?.row_order ?? null,row?.project ?? null,row?.state ?? null,collection,key);
  if (before?.same) return null;
  const projects = collection === "flows" ? [] : [...new Set([before?.project,row?.project].filter((value): value is string => typeof value === "string"))];
  const countChanged = collection !== "flows" && (before?.project !== row?.project || oldCountSignature !== newCountSignature);
  db.exec("UPDATE history_meta SET revision=revision+1");
  if(collection==="flows") {
    db.exec("UPDATE history_flow_meta SET revision=revision+1");
    db.query("INSERT INTO history_flow_changes SELECT revision,? FROM history_flow_meta").run(key);
    db.query("DELETE FROM history_flow_changes WHERE revision<(SELECT revision-4096 FROM history_flow_meta)").run();
  }
  if(countChanged) db.exec("UPDATE history_count_meta SET revision=revision+1");
  for (const project of projects) {
    db.query("INSERT INTO history_projects SELECT ?,revision FROM history_meta WHERE 1 ON CONFLICT(project) DO UPDATE SET revision=excluded.revision").run(project);
    if (countChanged) db.query("INSERT INTO history_count_projects SELECT ?,revision FROM history_count_meta WHERE 1 ON CONFLICT(project) DO UPDATE SET revision=excluded.revision").run(project);
  }
  if(countChanged){
    const oldRoles=JSON.parse(oldCountSignature||"[[],[]]")[0] as string[];
    const newRoles=JSON.parse(newCountSignature||"[[],[]]")[0] as string[];
    for(const [project,roles,amount] of [[before?.project,oldRoles,-1],[row?.project,newRoles,1]] as const){
      if(typeof project!=="string")continue;
      const delta=new Map<string,number>();for(const role of roles)delta.set(role,(delta.get(role)??0)+amount);
      for(const [role,value] of delta){
        db.query("INSERT INTO history_count_roles VALUES (?,?,?) ON CONFLICT(project,role) DO UPDATE SET runs=runs+excluded.runs").run(project,role,value);
        db.query("DELETE FROM history_count_roles WHERE project=? AND role=? AND runs<=0").run(project,role);
      }
    }
  }
  const forgetEmptyProjects = () => {
    for (const project of projects) {
      db.query("DELETE FROM history_projects WHERE project=? AND NOT EXISTS (SELECT 1 FROM history_inputs WHERE project=? AND collection IN ('pipelines','pipelines_archive'))").run(project,project);
      db.query("DELETE FROM history_count_projects WHERE project=? AND NOT EXISTS (SELECT 1 FROM history_inputs WHERE project=? AND collection IN ('pipelines','pipelines_archive'))").run(project,project);
    }
  };
  for (const table of ["history_runs","history_attempts","history_inputs"]) db.query(`DELETE FROM ${table} WHERE collection=? AND row_key=?`).run(collection,key);
  if (collection === "flows") db.query("DELETE FROM history_rounds WHERE row_key=?").run(key);
  if (!row || !input) {
    forgetEmptyProjects();
    return countChanged ? {oldProject:before?.project ?? null,newProject:null,oldSignature:oldCountSignature,newSignature:"[[],[]]"} : null;
  }
  db.query("INSERT INTO history_inputs VALUES (?,?,?,?,?,?)").run(collection,key,row.row_order,row.project,row.state,input);
  if (collection === "flows") {
    db.query(`INSERT INTO history_rounds SELECT ?,r.key,json_extract(r.value,'$.reviewerPath'),json_extract(r.value,'$.reviewerConversationId'),
      json_extract(r.value,'$.reviewerPid'),json_extract(r.value,'$.reviewerIdentity') FROM json_each(?,'$.rounds') r
      WHERE json_extract(?,'$.reviewerMode')='headless' AND json_extract(r.value,'$.reviewerPid')>0`).run(key,input,input);
    return null;
  }
  forgetEmptyProjects();
  db.query(`INSERT INTO history_runs SELECT ?,?,r.key,COALESCE((SELECT json_extract(s.value,'$.role') FROM json_each(?,'$.roles') s
    WHERE json_extract(s.value,'$.id')=json_extract(r.value,'$.stageId') LIMIT 1),'unassigned') FROM json_each(?,'$.runs') r`).run(collection,key,input,input);
  db.query(`INSERT INTO history_attempts SELECT ?,?,r.key,a.key,json_extract(r.value,'$.stageId'),
    ${["n","state","historical","conversationId","agentPath","paneId","startedAt"].map(field => `json_extract(a.value,'$.${field}')`).join(",")},
    CASE WHEN julianday(json_extract(a.value,'$.startedAt')) IS NOT NULL THEN CAST(ROUND((julianday(json_extract(a.value,'$.startedAt'))-2440587.5)*86400000) AS INTEGER) END,
    ${["role","providerWait"].map(field => `json_extract(a.value,'$.${field}')`).join(",")}
    FROM json_each(?,'$.runs') r,json_each(r.value,'$.attempts') a`).run(collection,key,input);
  const projectedTimes=db.query<{run:number;attempt:number;startedAt:string|null},[string,string]>("SELECT run,attempt,startedAt FROM history_attempts WHERE collection=? AND row_key=?").all(collection,key);
  for(const attempt of projectedTimes){const parsed=Date.parse(attempt.startedAt??"");db.query("UPDATE history_attempts SET startedMs=? WHERE collection=? AND row_key=? AND run=? AND attempt=?").run(Number.isFinite(parsed)?parsed:null,collection,key,attempt.run,attempt.attempt);}
  return countChanged ? {oldProject:before?.project ?? null,newProject:row.project,oldSignature:oldCountSignature,newSignature:newCountSignature} : null;
}

function countSignature(db: Database, collection: string, key: string): string {
  const roles=db.query<{role:string},[string,string]>("SELECT role FROM history_runs WHERE collection=? AND row_key=? ORDER BY run").all(collection,key).map(row=>row.role);
  const attempts=db.query<{role:string|null;startedAt:string|null},[string,string]>(`SELECT COALESCE(a.role,r.role) AS role,a.startedAt FROM history_attempts a
    JOIN history_runs r USING(collection,row_key,run) WHERE a.collection=? AND a.row_key=? ORDER BY a.run,a.attempt`).all(collection,key);
  return JSON.stringify([roles,attempts]);
}
function countSignatureFromInput(db:Database,input:Uint8Array): string {
  const json=db.query<{json:string},[Uint8Array]>("SELECT json(?) AS json").get(input)!.json;
  const value=JSON.parse(json) as {roles:Array<{id:string;role:string}>;runs:Array<{stageId:string;attempts:Array<{role?:string;startedAt?:string|null}>}>};
  const role=(stageId:string)=>value.roles.find(item=>item.id===stageId)?.role ?? "unassigned";
  return JSON.stringify([value.runs.map(run=>role(run.stageId)),value.runs.flatMap(run=>run.attempts.map(attempt=>({role:attempt.role ?? role(run.stageId),startedAt:attempt.startedAt ?? null}))) ]);
}

type CountCache = { stamp: string; at: number; until: number; value: Record<string,number>; roles: Record<string,number> };
type HeadlessRow={row_key:string;round:number;row_order:number;reviewerPath:string|null;reviewerConversationId:string|null;reviewerPid:number;reviewerIdentity:string|null};
type HeadlessCache = { revision:number; rows:HeadlessRow[]; flows:LivenessFlow[]; deadOwners:HeadlessRow[]; deadByPath:Map<string,HeadlessRow[]>; deadByConversation:Map<string,HeadlessRow[]>; bytes:number };
type Shared = { connections: Map<string,Database>; counts: Map<string,CountCache>; headless: Map<string,HeadlessCache>; headlessRoundRows:WeakMap<object,HeadlessRow> };
const host = globalThis as typeof globalThis & { __delegatusHistoryProjectionV1?: Shared };
const shared:Shared = host.__delegatusHistoryProjectionV1 ??= { connections: new Map<string,Database>(), counts: new Map<string,CountCache>(), headless: new Map<string,HeadlessCache>(), headlessRoundRows:new WeakMap<object,HeadlessRow>() };
shared.headless ??= new Map();
shared.headlessRoundRows ??= new WeakMap();

const COUNT_WINDOW_MS = 30 * 24 * 60 * 60_000;

function updateWarmCountCaches(db:Database, update:CountUpdate, allowedStamps:Map<string,string>):void {
  const oldValue=JSON.parse(update.oldSignature) as [string[],Array<{role:string|null;startedAt:string|null}>];
  const newValue=JSON.parse(update.newSignature) as [string[],Array<{role:string|null;startedAt:string|null}>];
  for(const [key,cache] of shared.counts){
    const [filename,cachedProject]=JSON.parse(key) as [string,string];
    if(filename!==db.filename)continue;
    const allowed=allowedStamps.get(key);
    if(!allowed || cache.stamp!==allowed){shared.counts.delete(key);continue;}
    const stamped=JSON.parse(cache.stamp) as [string,string,string[],Array<{project:string;revision:number}>];
    const currentProjects=[...new Set([canonicalProject(cachedProject),...Object.keys(projectAliasSnapshot().aliases).filter(alias=>canonicalProject(alias)===canonicalProject(cachedProject))])].sort();
    if(JSON.stringify(stamped[2])!==JSON.stringify(currentProjects)){shared.counts.delete(key);continue;}
    const ownsOld=update.oldProject!==null&&canonicalProject(update.oldProject)===canonicalProject(cachedProject);
    const ownsNew=update.newProject!==null&&canonicalProject(update.newProject)===canonicalProject(cachedProject);
    const roleDelta=new Map<string,number>();
    for(const role of (ownsOld?oldValue[0]:[]))roleDelta.set(role,(roleDelta.get(role)??0)-1);
    for(const role of (ownsNew?newValue[0]:[]))roleDelta.set(role,(roleDelta.get(role)??0)+1);
    const changes=new Map<string,number>();
    const member=(at:number)=>at<=cache.at&&cache.at-at<=COUNT_WINDOW_MS;
    const apply=(attempt:{role:string|null;startedAt:string|null},amount:number)=>{
      const at=Date.parse(attempt.startedAt??"");
      if(attempt.role&&Number.isFinite(at)&&member(at))changes.set(attempt.role,(changes.get(attempt.role)??0)+amount);
    };
    for(const attempt of (ownsOld?oldValue[1]:[]))apply(attempt,-1);
    for(const attempt of (ownsNew?newValue[1]:[])){
      apply(attempt,1);
      const at=Date.parse(attempt.startedAt??"");
      if(attempt.role&&Number.isFinite(at)){if(at>cache.at)cache.until=Math.min(cache.until,at);else if(cache.at-at<=COUNT_WINDOW_MS)cache.until=Math.min(cache.until,at+COUNT_WINDOW_MS+1);}
    }
    for(const [role,delta] of changes){const next=(cache.value[role]??0)+delta;if(next>0||cache.roles[role])cache.value[role]=next;else delete cache.value[role];}
    for(const [role,delta] of roleDelta){const next=(cache.roles[role]??0)+delta;if(next>0){cache.roles[role]=next;cache.value[role]??=0;}else{delete cache.roles[role];if((cache.value[role]??0)<=0)delete cache.value[role];}}
    const placeholders=currentProjects.map(()=>"?").join(",");
    const revisions=db.query<{project:string;revision:number},SQLQueryBindings[]>(`SELECT project,revision FROM history_count_projects WHERE project IN (${placeholders}) ORDER BY project`).all(...currentProjects);
    const generation=db.query<{generation:string},[]>("SELECT generation FROM history_meta").get()!.generation;
    cache.stamp=JSON.stringify([databaseFileIdentity(db.filename),generation,currentProjects,revisions]);
  }
}

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
  /** Deterministic scheduling seam for interleaving tests. */
  onYield?: () => Promise<void>;
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
          if (!pending) { assertWriter(); const value = withViewerOperation("history.read", () => read(db)); db.exec("COMMIT"); return { value }; }
          db.exec("ROLLBACK");
        } catch (error) { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
        if (performance.now() > deadline) throw new FileTransactionBusyError("history projection preparation exceeded its deadline");
        assertWriter();
        db.exec("BEGIN IMMEDIATE");
        try {
          const pending = db.query<{ collection: string; row_key: string }, SQLQueryBindings[]>(pendingSql).get(...collections);
          assertWriter();
          if (pending) {
            const allowedStamps=new Map([...shared.counts].filter(([key])=>(JSON.parse(key) as [string,string])[0]===filename).map(([key,value])=>[key,value.stamp]));
            const countUpdate = withViewerOperation("history.project-row", () => projectOne(db,pending.collection,pending.row_key));
            db.query("DELETE FROM history_pending WHERE collection=? AND row_key=?").run(pending.collection,pending.row_key);
            assertWriter();
            db.exec("COMMIT");
            if(countUpdate)updateWarmCountCaches(db,countUpdate,allowedStamps);
            return null;
          }
          assertWriter();
          db.exec("COMMIT");
          return null;
        } catch (error) { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
      });
      if (answer) return answer.value;
      if (options.onYield) await options.onYield();
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
  const generation=db.query<{generation:string},[]>("SELECT generation FROM history_meta").get()!.generation;
  const revision=db.query<{revision:number},[]>("SELECT revision FROM history_flow_meta").get()!.revision;
  const key=JSON.stringify([db.filename,databaseFileIdentity(db.filename),generation]);
  let cached=shared.headless.get(key);
  if (!cached) {
    const rows:HeadlessRow[] = db.query<HeadlessRow, []>(
      "SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key ORDER BY p.row_order,p.row_key,r.round").all();
    const flows=rows.map(row => ({ reviewerMode: "headless" as const, rounds: [row] }));
    for(const row of rows)shared.headlessRoundRows.set(row,row);
    const bytes=Buffer.byteLength(JSON.stringify(flows))+rows.length*8;
    cached={revision,rows,flows,deadOwners:[],deadByPath:new Map(),deadByConversation:new Map(),bytes};
    if(bytes<=16*1024*1024){shared.headless.delete(key);shared.headless.set(key,cached);}
    else {shared.headless.delete(key);return flows;}
    while(shared.headless.size>2 || [...shared.headless.values()].reduce((sum,item)=>sum+item.bytes,0)>16*1024*1024) shared.headless.delete(shared.headless.keys().next().value!);
  } else if (cached.revision!==revision) {
    const changes=db.query<{row_key:string},[number]>("SELECT row_key FROM history_flow_changes WHERE revision>? ORDER BY revision").all(cached.revision);
    const keys=[...new Set(changes.map(row=>row.row_key))];
    if(revision-cached.revision>4096 || (cached.revision<revision&&changes.length===0)){
      shared.headless.delete(key);
      return historyHeadlessFlows(db);
    }
    const changed=new Set(keys);
    let rows=cached.rows.filter(row=>!changed.has(row.row_key));
    cached.deadOwners=cached.deadOwners.filter(row=>!changed.has(row.row_key));
    for(const flowKey of keys) rows=rows.concat(db.query<HeadlessRow,[string]>("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key WHERE r.row_key=? ORDER BY r.round").all(flowKey));
    rows.sort((left,right)=>left.row_order-right.row_order||left.row_key.localeCompare(right.row_key)||left.round-right.round);
    const flows=rows.map(row=>({reviewerMode:"headless" as const,rounds:[row]}));
    for(const row of rows)shared.headlessRoundRows.set(row,row);
    cached.rows=rows;cached.flows=flows;
    rebuildDeadOwnerIndexes(cached);
    const bytes=Buffer.byteLength(JSON.stringify(flows))+rows.length*8;
    cached.revision=revision;cached.bytes=bytes+deadOwnerBytes(cached.deadOwners);
    if(cached.bytes>16*1024*1024){shared.headless.delete(key);return flows;}
    shared.headless.delete(key);shared.headless.set(key,cached);
  } else { shared.headless.delete(key); shared.headless.set(key,cached); }
  return cached.flows;
}

function deadOwnerBytes(rows:HeadlessRow[]):number{return Buffer.byteLength(JSON.stringify(rows))+rows.length*8;}
function rebuildDeadOwnerIndexes(cache:HeadlessCache):void{
  cache.deadByPath=new Map();cache.deadByConversation=new Map();
  for(const row of cache.deadOwners){
    if(row.reviewerPath){const list=cache.deadByPath.get(row.reviewerPath)??[];list.push(row);cache.deadByPath.set(row.reviewerPath,list);}
    if(row.reviewerConversationId){const list=cache.deadByConversation.get(row.reviewerConversationId)??[];list.push(row);cache.deadByConversation.set(row.reviewerConversationId,list);}
  }
}

/** Move confirmed-dead rounds out of the active walk while retaining an indexed
 * proof for result assembly. The owner cache keeps the same overall byte cap. */
export function pruneHistoryHeadlessRounds(flows:readonly LivenessFlow[], rounds:readonly object[]):void{
  const cache=[...shared.headless.values()].find(item=>item.flows===flows);
  if(!cache||!rounds.length)return;
  const moved=new Set<HeadlessRow>();
  for(const round of rounds){const row=shared.headlessRoundRows.get(round);if(row)moved.add(row);}
  if(!moved.size)return;
  cache.rows=cache.rows.filter(row=>!moved.has(row));
  cache.deadOwners.push(...moved);
  rebuildDeadOwnerIndexes(cache);
  cache.bytes=Buffer.byteLength(JSON.stringify(cache.flows))+cache.rows.length*8+deadOwnerBytes(cache.deadOwners);
}

export function canPruneHistoryHeadlessRounds(flows:readonly LivenessFlow[]):boolean{
  return [...shared.headless.values()].some(item=>item.flows===flows);
}

/** Dead owner evidence is addressed by transcript path or conversation id. */
export function historyHeadlessDeadRounds(flows:readonly LivenessFlow[],path:string|null,conversationIds:readonly string[]):LivenessFlow["rounds"]{
  const cache=[...shared.headless.values()].find(item=>item.flows===flows);
  if(!cache)return [];
  const found=new Set<HeadlessRow>();
  if(path)for(const row of cache.deadByPath.get(path)??[])found.add(row);
  for(const id of conversationIds)for(const row of cache.deadByConversation.get(id)??[])found.add(row);
  return [...found];
}

/** Counts stay valid until a timestamp crosses a window edge. The shared LRU
 * retains at most 64 results and 256 KiB; it owns no pipeline payloads. */
export function historyAttemptCounts(db: Database, project: string, now: number): Record<string,number> {
  project = canonicalProject(project);
  const projects = [...new Set([project,...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === project)])].sort();
  const placeholders = projects.map(() => "?").join(",");
  const revisions = db.query<{ project: string; revision: number }, SQLQueryBindings[]>(`SELECT * FROM history_count_projects WHERE project IN (${placeholders}) ORDER BY project`).all(...projects);
  const generation = db.query<{generation:string},[]>("SELECT generation FROM history_meta").get()!.generation;
  const stamp = JSON.stringify([databaseFileIdentity(db.filename),generation,projects,revisions]);
  const key = JSON.stringify([db.filename,project]);
  const cached = shared.counts.get(key);
  if (cached?.stamp === stamp && now >= cached.at) {
    if (now < cached.until) {
      shared.counts.delete(key); shared.counts.set(key,cached); return { ...cached.value };
    }
    const crossed = db.query<{startedMs:number;role:string},SQLQueryBindings[]>(`SELECT a.startedMs,COALESCE(a.role,r.role) AS role FROM history_attempts a INDEXED BY history_started
      CROSS JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key
      CROSS JOIN history_runs r ON r.collection=a.collection AND r.row_key=a.row_key AND r.run=a.run
      WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders}) AND (
        (a.startedMs>? AND a.startedMs<=? AND a.startedMs>=?) OR (a.startedMs>=? AND a.startedMs<=? AND a.startedMs<?))`)
      .all(...projects,cached.at,now,now-COUNT_WINDOW_MS,cached.at-COUNT_WINDOW_MS,cached.at,now-COUNT_WINDOW_MS);
    for (const row of crossed) {
      const entered = row.startedMs > cached.at && row.startedMs >= now-COUNT_WINDOW_MS;
      const next=(cached.value[row.role] ?? 0) + (entered ? 1 : -1);
      if (next > 0 || cached.roles[row.role]) cached.value[row.role]=next;
      else delete cached.value[row.role];
    }
    const expiring = db.query<{at:number|null},SQLQueryBindings[]>(`SELECT MIN(a.startedMs) AS at FROM history_attempts a INDEXED BY history_started
      JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE p.collection IN ('pipelines','pipelines_archive')
      AND p.project IN (${placeholders}) AND a.startedMs>=? AND a.startedMs<=?`).get(...projects,now-COUNT_WINDOW_MS,now)?.at;
    const future = db.query<{at:number|null},SQLQueryBindings[]>(`SELECT MIN(a.startedMs) AS at FROM history_attempts a INDEXED BY history_started
      JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE p.collection IN ('pipelines','pipelines_archive')
      AND p.project IN (${placeholders}) AND a.startedMs>?`).get(...projects,now)?.at;
    cached.until = Math.min(expiring === null || expiring === undefined ? Infinity : expiring+COUNT_WINDOW_MS+1,future ?? Infinity);
    cached.at = now;
    shared.counts.delete(key); shared.counts.set(key,cached); return { ...cached.value };
  }
  const runs = db.query<{ role: string; count:number }, SQLQueryBindings[]>(`SELECT role,runs AS count FROM history_count_roles WHERE project IN (${placeholders}) ORDER BY role`).all(...projects);
  const value: Record<string,number> = {};
  const roles:Record<string,number>={};
  for (const row of runs) { value[row.role] = 0; roles[row.role]=row.count; }
  const cutoff=now-30*24*60*60_000;
  const window=COUNT_WINDOW_MS;
  const attempts = db.query<{ role: string; count:number }, SQLQueryBindings[]>(`SELECT COALESCE(a.role,r.role) AS role,count(*) AS count FROM history_attempts a INDEXED BY history_started
    CROSS JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key
    CROSS JOIN history_runs r ON r.collection=a.collection AND r.row_key=a.row_key AND r.run=a.run WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders}) AND a.startedMs BETWEEN ? AND ? GROUP BY COALESCE(a.role,r.role)`).all(...projects,cutoff,now);
  let until = Infinity;
  const future=db.query<{at:number|null},SQLQueryBindings[]>(`SELECT MIN(startedMs) AS at FROM history_attempts a INDEXED BY history_started
    JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders}) AND a.startedMs>?`).get(...projects,now)?.at;
  if (future!==null && future!==undefined) until=Math.min(until,future);
  for (const attempt of attempts) value[attempt.role]=(value[attempt.role]??0)+attempt.count;
  const expiring=db.query<{at:number|null},SQLQueryBindings[]>(`SELECT MIN(a.startedMs) AS at FROM history_attempts a INDEXED BY history_started JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key
    WHERE p.collection IN ('pipelines','pipelines_archive') AND p.project IN (${placeholders}) AND a.startedMs BETWEEN ? AND ?`).get(...projects,cutoff,now)?.at;
  if(expiring!==null&&expiring!==undefined)until=Math.min(until,expiring+window+1);
  shared.counts.delete(key); shared.counts.set(key,{stamp,at:now,until,value,roles});
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
