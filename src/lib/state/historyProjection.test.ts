import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { publishHotStateAuthority, HOT_STATE_BACKEND } from "./hotStateAuthority";
import { afterEach, expect, test, spyOn } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHistoryProjection, readHistoryProjection, historyAttemptCounts, historyPipelineRef, historyHeadlessFlows, historyFleetLimitWaits } from "./historyProjection";
import { fleetLimitWaits } from "@/lib/mcp/agentFleet";
import type { Pipeline } from "@/lib/pipelines/types";
import { buildPipeline } from "@/lib/pipelines/store";
import { livenessProbe } from "@/lib/agent/accountLiveness";
import { activeHeadlessTranscriptPaths } from "@/lib/lifecycle/liveness";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const WINDOW = 30 * 24 * 60 * 60_000;
const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"history-projection-")); owned.push(root);
  const filename = path.join(root,"state.sqlite");
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=0");
  db.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT,row_order INTEGER,PRIMARY KEY(collection,row_key))");
  db.exec("BEGIN IMMEDIATE"); installHistoryProjection(db,root); db.exec("COMMIT");
  const put = (row: unknown, collection = "pipelines", order = 0) => db.query("INSERT INTO state_rows VALUES (?,?,?,?) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json,row_order=excluded.row_order")
    .run(collection,(row as { id: string }).id,JSON.stringify(row),order);
  return { db,filename,put, read: <T>(fn: (db: Database) => T, options: Parameters<typeof readHistoryProjection>[1] = {}) => readHistoryProjection(fn,{filename,...options}) };
}
function pipeline(id: string, overrides = {}) {
  const role = (roleId: "builder" | "reviewer") => ({roleId,engine:"codex" as const,model:null,effort:null,access:"read-write" as const,promptScaffold:"fixture"});
  const record = buildPipeline({id,task:"projection fixture",project:"fixture",repoDir:"/repo",srcPath:null,srcConversationId:null,now:new Date(NOW).toISOString(),stages:[
    {id:"build",kind:"run",prompt:"",role:{roleId:"builder"},effectiveRole:role("builder"),next:null},
    {id:"empty",kind:"run",prompt:"",role:{roleId:"reviewer"},effectiveRole:role("reviewer"),next:null},
  ]});
  record.state="running";
  record.runs[0]!.attempts.push({n:1,state:"running",effectiveRole:role("builder"),launchId:null,conversationId:"conversation_fixture",sessionId:null,
    agentPath:"fixture-transcript",paneId:null,flowId:null,startedAt:new Date(NOW).toISOString(),completedAt:null,input:null,activatedBy:null,output:null,verdict:null,error:null});
  return Object.assign(record,overrides);
}
function flow(overrides: Record<string, unknown> = {}) {
  return {id:"flow_one",project:"fixture",template:"implement-review-loop",cwd:"/repo",implementerPath:"/implementer.jsonl",baseRef:"a".repeat(40),
    roles:{implementer:{engine:"codex",model:null,effort:null},reviewer:{engine:"codex",model:null,effort:null}},reviewerMode:"headless",rounds:[],...overrides};
}
function oldCounts(rows: ReturnType<typeof pipeline>[], now = NOW) {
  const counts: Record<string,number> = {};
  for (const p of rows) for (const run of p.runs) {
    const role = p.stages.find(stage => stage.id === run.stageId)?.role?.roleId ?? "unassigned";
    counts[role] ??= 0;
    for (const a of run.attempts) if (a.startedAt && Date.parse(a.startedAt) <= now && now - Date.parse(a.startedAt) <= WINDOW) {
      const actual = (a as typeof a & { effectiveRole?: {roleId: string} }).effectiveRole?.roleId ?? role;
      counts[actual] = (counts[actual] ?? 0) + 1;
    }
  }
  return counts;
}

test("empty history answers without payload reads",async () => {
  const f = fixture();
  try {
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW))).toEqual({});
    expect(await f.read(db => historyPipelineRef(db,"conversation_fixture","fixture-transcript"))).toBeNull();
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
    expect(await f.read(db => historyFleetLimitWaits(db,[]))).toEqual(new Map());
  } finally { f.db.close(); }
});

test("large active and archived history preserves counts, last-wins lineage and fleet waits",async () => {
  const f = fixture();
  const rows = Array.from({length:128},(_,n) => pipeline(`pipeline_${n}`,{ output:"omitted ".repeat(8192) }));
  rows[1].runs[0].attempts.push({ ...rows[1].runs[0].attempts[0],n:2,startedAt:new Date(NOW+1).toISOString(),historical:true } as never);
  rows[2].runs[0].attempts.push({ ...rows[2].runs[0].attempts[0],n:2,startedAt:"invalid" });
  const wait = {accountId:null,resetsAt:NOW+1000,resumeAt:new Date(NOW+2000).toISOString(),startedAt:new Date(NOW).toISOString(),text:"wait",turnTs:1,tries:0,condition:{kind:"usage_limit",scope:null,resetLabel:null,label:"usage limit"}};
  Object.assign(rows[127].runs[0].attempts[0],{providerWait:wait});
  try {
    rows.forEach((row,n) => f.put(row,n<64 ? "pipelines" : "pipelines_archive",n));
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW))).toEqual(oldCounts(rows));
    const ref = await f.read(db => historyPipelineRef(db,"conversation_fixture","fixture-transcript"));
    expect(ref).toEqual({pipelineId:"pipeline_63",stageId:"build",attempt:1,reportedState:"running",reportedPipelineState:"running",paneId:null});
    expect(await f.read(db => historyFleetLimitWaits(db,["conversation_fixture"]))).toEqual(fleetLimitWaits(rows.slice(0,64) as unknown as Pipeline[]));
    const result = await f.read(db => historyAttemptCounts(db,"fixture",NOW)); result.builder=999;
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW))).toEqual(oldCounts(rows));
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW+1))).toEqual(oldCounts(rows,NOW+1));
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW-1))).toEqual(oldCounts(rows,NOW-1));
  } finally { f.db.close(); }
});

test("raw peer updates, reorder, archive moves, deletions and retained timestamps invalidate projections",async () => {
  const f = fixture();
  const row = pipeline("pipeline_one");
  try {
    f.put(row);
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW))).toEqual(oldCounts([row]));
    Object.assign(row.runs[0].attempts[0],{providerWait:{condition:{kind:"usage_limit",scope:null,resetLabel:null,label:"usage limit"},resetsAt:null,resumeAt:"2026-10-17T12:01:00Z",startedAt:"2026-10-17T12:00:00Z",text:"wait",turnTs:1,tries:0,accountId:null}});
    f.put(row);
    expect((await f.read(db => historyFleetLimitWaits(db,["conversation_fixture"]))).size).toBe(1);
    Object.assign(row,{project:"successor"}); f.put(row);
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW))).toEqual({});
    expect(await f.read(db => historyAttemptCounts(db,"successor",NOW))).toEqual(oldCounts([row]));
    f.db.query("DELETE FROM state_rows WHERE row_key=?").run(row.id);
    expect(await f.read(db => historyAttemptCounts(db,"successor",NOW))).toEqual({});
    expect(await f.read(db => historyPipelineRef(db,"conversation_fixture","fixture-transcript"))).toBeNull();
    f.put(row,"pipelines_archive");
    expect(await f.read(db => historyAttemptCounts(db,"successor",NOW+WINDOW+1))).toEqual({builder:0,reviewer:0});
    expect(await f.read(db => historyPipelineRef(db,"conversation_fixture","fixture-transcript"))).toBeNull();
  } finally { f.db.close(); }
});

test("a lineage-only pipeline update leaves project attempt counts warm",async()=>{
  const f=fixture();
  try {
    for(let n=0;n<100;n++) f.put(pipeline(`lineage_${n}`),"pipelines",n);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(100);
    const row=pipeline("lineage_42");row.runs[0]!.attempts[0]!.conversationId="conversation_rebound";
    f.put(row,"pipelines",42);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyAttemptCounts(db,"fixture",NOW).builder).toBe(100);
        expect(query.mock.calls.some(([sql])=>sql.includes("a.startedMs BETWEEN"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("a count-affecting record update adjusts a warm project summary by that record",async()=>{
  const f=fixture();
  try {
    for(let n=0;n<100;n++) f.put(pipeline(`delta_${n}`),"pipelines",n);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(100);
    const row=pipeline("delta_42");
    row.runs[0]!.attempts[0]!.startedAt=new Date(NOW-WINDOW-1).toISOString();
    f.put(row,"pipelines",42);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyAttemptCounts(db,"fixture",NOW).builder).toBe(99);
        expect(query.mock.calls.some(([sql])=>sql.includes("a.startedMs BETWEEN"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("run role changes and insertions update warm count summaries without a history scan",async()=>{
  const f=fixture();
  try {
    const first=pipeline("role_delta");
    f.put(first);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:1,reviewer:0});
    first.stages[0]!.role.roleId="reviewer";
    first.stages[0]!.effectiveRole.roleId="reviewer";
    f.put(first);
    const inserted=pipeline("role_inserted");
    f.put(inserted);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyAttemptCounts(db,"fixture",NOW)).toEqual({builder:2,reviewer:0});
        expect(query.mock.calls.some(([sql])=>sql.includes("a.startedMs BETWEEN"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("crossing the count window expires only rows that passed its boundary",async()=>{
  const f=fixture();
  try {
    const leaving=pipeline("leaving");
    leaving.runs[0]!.attempts[0]!.startedAt=new Date(NOW-WINDOW+100).toISOString();
    f.put(leaving,"pipelines",0);
    f.put(pipeline("staying"),"pipelines",1);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(2);
    const expiryNow=NOW+101;
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyAttemptCounts(db,"fixture",expiryNow).builder).toBe(1);
        expect(query.mock.calls.some(([sql])=>sql.includes("a.startedMs>? AND a.startedMs<=?"))).toBe(true);
        expect(query.mock.calls.some(([sql])=>sql.includes("a.startedMs BETWEEN"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("unrecognized and malformed saved records remain stored but never poison projections or startup",async () => {
  const f=fixture();
  const rejected={...pipeline("future_state"),state:"teleported"};
  try {
    f.put(rejected);
    f.put(pipeline("future_runs"));
    f.db.query("UPDATE state_rows SET value_json=? WHERE row_key=?").run(JSON.stringify({...pipeline("future_runs"),runs:["unknown-run-vocabulary"]}),"future_runs");
    f.db.query("INSERT INTO state_rows VALUES (?,?,?,?)").run("pipelines","malformed","{",2);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW),)).toEqual({});
    expect(await f.read(db=>historyPipelineRef(db,"conversation_fixture","fixture-transcript"))).toBeNull();
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM state_rows WHERE collection='pipelines'").get()!.n).toBe(3);
    expect(await readHistoryProjection(db=>historyAttemptCounts(db,"fixture",NOW),{filename:f.filename,startup:true,collections:["pipelines"]})).toEqual({});
  } finally { f.db.close(); }
});

test("a commit during cooperative bootstrap is included before the read answers",async () => {
  const f = fixture();
  try {
    for (let n=0;n<4;n++) f.put(pipeline(`pipeline_${n}`),"pipelines",n);
    let release!: () => void; let yielded!: () => void;
    const blocked = new Promise<void>(resolve => { release=resolve; });
    const atYield = new Promise<void>(resolve => { yielded=resolve; });
    const pending = f.read(db => historyAttemptCounts(db,"fixture",NOW),{onYield:async () => { yielded(); await blocked; }});
    await atYield;
    const left = f.db.query<{n:number},[]>("SELECT count(*) AS n FROM history_pending").get()!.n;
    expect(left).toBe(3);
    f.put(pipeline("pipeline_new"),"pipelines",4);
    release();
    expect((await pending).builder).toBe(5);
  } finally { f.db.close(); }
});

test("headless ownership retains every recorded round and removes changed owners",async () => {
  const f = fixture();
  const saved = flow({rounds:[{reviewerPid:42,reviewerPath:"reviewer-one",reviewerConversationId:"conversation_reviewer",reviewerIdentity:"start-one"},{reviewerPid:43,reviewerPath:"reviewer-two",reviewerIdentity:null}]});
  try {
    f.put(saved,"flows");
    const rounds = (await f.read(historyHeadlessFlows)).flatMap(flow => flow.rounds);
    expect(rounds.map(row => row.reviewerPid)).toEqual([42,43]);
    f.put({...saved,reviewerMode:"pane"},"flows");
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
  } finally { f.db.close(); }
});

test("unchanged headless history reuses the bounded shared round projection",async()=>{
  const f=fixture();
  try {
    const saved=flow({rounds:Array.from({length:100},(_,n)=>({reviewerPid:1000+n,reviewerPath:`reviewer-${n}`,reviewerIdentity:`start-${n}`}))});
    f.put(saved,"flows");
    expect((await f.read(historyHeadlessFlows)).flatMap(item=>item.rounds)).toHaveLength(100);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyHeadlessFlows(db)).toHaveLength(100);
        expect(query.mock.calls.some(([sql])=>sql.includes("FROM history_rounds"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("a repeated liveness snapshot stops visiting confirmed-dead cached rounds",async()=>{
  const f=fixture();
  let probes=0;
  const probe=livenessProbe({now:()=>NOW,pidAlive:()=>{probes++;return false;},processIdentity:()=>null});
  const registry={entries:{},conversations:{}};
  try {
    f.put(flow({rounds:Array.from({length:100},(_,n)=>({reviewerPid:10000+n,reviewerPath:`dead-${n}`,reviewerIdentity:`start-${n}`}))}),"flows");
    const first=await f.read(historyHeadlessFlows);
    expect([...activeHeadlessTranscriptPaths(first,registry,probe,true)]).toEqual([]);
    expect(probes).toBe(100);
    const second=await f.read(historyHeadlessFlows);
    expect(second).toHaveLength(0);
    expect([...activeHeadlessTranscriptPaths(second,registry,probe,true)]).toEqual([]);
    expect(probes).toBe(100);
  } finally { f.db.close(); }
});

test("malformed persisted records are skipped without losing the source row",async () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO state_rows VALUES (?,?,?,?)").run("pipelines","broken","{",0);
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM history_pending").get()!.n).toBe(0);
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM state_rows WHERE row_key='broken'").get()!.n).toBe(1);
    f.db.query("DELETE FROM state_rows WHERE row_key='broken'").run();
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
  } finally { f.db.close(); }
});


test("count cache is shared across module copies and evicts after 64 projects",async () => {
  const f = fixture();
  try {
    f.put(pipeline("pipeline_one"));
    const other = await import(`${path.join(import.meta.dir,"historyProjection.ts")}?second-bundle`) as typeof import("./historyProjection");
    await f.read(db => historyAttemptCounts(db,"fixture",NOW));
    await f.read(db => {
      const query = spyOn(Database.prototype,"query");
      try {
        expect(other.historyAttemptCounts(db,"fixture",NOW)).toEqual({builder:1,reviewer:0});
        expect(query.mock.calls.some(([sql]) => sql.includes("SELECT a.startedAt"))).toBe(false);
        for (let n=0;n<65;n++) other.historyAttemptCounts(db,`project_${n}`,NOW);
        query.mockClear();
        expect(historyAttemptCounts(db,"fixture",NOW)).toEqual({builder:1,reviewer:0});
        expect(query.mock.calls.some(([sql]) => sql.includes("SELECT a.startedAt"))).toBe(true);
      } finally { query.mockRestore(); }
    });
  } finally { f.db.close(); }
});

test("a real process restart reads the persisted projection",async () => {
  const f = fixture();
  try {
    f.put(pipeline("pipeline_one"));
    await f.read(db => historyAttemptCounts(db,"fixture",NOW));
    const childRoot = path.join(path.dirname(f.filename),"child"); fs.mkdirSync(childRoot);
    const env = { ...process.env, HOME:childRoot, XDG_CONFIG_HOME:childRoot, TMPDIR:childRoot, LLV_STATE_DIR:childRoot, LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1" };
    const child = Bun.spawn([process.execPath,"-e",`
      const {readHistoryProjection,historyAttemptCounts}=await import(process.argv[1]);
      console.log(JSON.stringify(await readHistoryProjection(db=>historyAttemptCounts(db,"fixture",${NOW}),{filename:process.argv[2]})));
    `,path.join(import.meta.dir,"historyProjection.ts"),f.filename],{env,stdout:"pipe",stderr:"pipe"});
    const [code,output] = await Promise.all([child.exited,new Response(child.stdout).text()]);
    expect(code).toBe(0); expect(JSON.parse(output)).toEqual({builder:1,reviewer:0});
  } finally { f.db.close(); }
});


test("a writer lock is awaited asynchronously and the original request recovers",async () => {
  const f = fixture();
  const childRoot = path.join(path.dirname(f.filename),"lock-child"); fs.mkdirSync(childRoot);
  const env = {...process.env,HOME:childRoot,XDG_CONFIG_HOME:childRoot,TMPDIR:childRoot,LLV_STATE_DIR:childRoot,LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1"};
  const child = Bun.spawn([process.execPath,"-e",`
    const {Database}=require("bun:sqlite"); const db=new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE"); process.stdout.write("ready\\n");
    process.stdin.once("data",()=>{db.exec("COMMIT");db.close();process.exit(0)});
  `,f.filename],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    reader.releaseLock();
    f.db.exec("PRAGMA busy_timeout=0");
    // An unchanged read needs no writer and succeeds under the peer's lock.
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
    child.stdin.write("release"); await child.stdin.flush();
    expect(await child.exited).toBe(0);
    f.put(pipeline("pipeline_one"));
    const lock = new Database(f.filename); lock.exec("BEGIN IMMEDIATE");
    const pending = f.read(db=>historyAttemptCounts(db,"fixture",NOW));
    let yielded=false;
    await new Promise<void>(resolve=>setTimeout(()=>{yielded=true;lock.exec("COMMIT");lock.close();resolve()},0));
    expect((await pending).builder).toBe(1); expect(yielded).toBe(true);
  } finally {
    child.stdin.end();
    if (child.exitCode===null) {child.kill();await child.exited;}
    f.db.close();
  }
});


test("liveness ignores an unrelated archive failure until that collection is requested",async () => {
  const f=fixture();
  try {
    f.put(pipeline("pipeline_one"));
    f.db.query("INSERT INTO state_rows VALUES (?,?,?,?)").run("pipelines_archive","broken","{",0);
    const ref=await readHistoryProjection(db=>historyPipelineRef(db,"conversation_fixture","fixture-transcript"),{filename:f.filename,collections:["pipelines"]});
    expect(ref?.pipelineId).toBe("pipeline_one");
    expect(await f.read(historyHeadlessFlows)).toEqual([]);
  } finally {f.db.close();}
});

test("a result exceeding the byte budget is returned without remaining cached",async () => {
  const f=fixture();
  try {
    const role="builder";
    f.put(pipeline("pipeline_one"));
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW)))[role]).toBe(1);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyAttemptCounts(db,"fixture",NOW)[role]).toBe(1);
      expect(query.mock.calls.some(([sql])=>sql.includes("SELECT a.startedAt"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});


test("identity and fleet selectors use scoped indexes with singleton and duplicate multi-value binds",async () => {
  const f=fixture();
  try {
    f.put(pipeline("pipeline_one"));
    await f.read(db=>{
      const queries=spyOn(Database.prototype,"query");
      let selections: string[];
      try {
        historyPipelineRef(db,"conversation_absent","fixture-transcript");
        historyFleetLimitWaits(db,["conversation_fixture"]);
        historyFleetLimitWaits(db,["conversation_fixture","conversation_other","conversation_fixture"]);
        historyAttemptCounts(db,"fixture",NOW);
        selections=queries.mock.calls.map(([sql])=>sql).filter(sql=>sql.includes("FROM history_attempts a") || sql.startsWith("SELECT a.startedAt"));
      } finally {queries.mockRestore();}
      expect(selections.length).toBeGreaterThanOrEqual(5);
      for (const sql of selections) {
        const values:(string|number)[]=sql.includes("a.startedMs BETWEEN") ? ["fixture",NOW-WINDOW,NOW] : sql.includes("a.startedMs>") ? ["fixture",NOW] : sql.includes("p.project IN") ? ["fixture"] : sql.includes("a.agentPath=?") ? ["fixture-transcript"] : Array.from({length:(sql.match(/\?/g) ?? []).length},()=>"conversation_fixture");
        const plan=db.query<{detail:string},SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row=>row.detail).join("\n");
        expect(plan).not.toContain("SCAN a");
        if (sql.includes("a.conversationId")) expect(plan).toContain("history_conversation");
        else if (sql.includes("a.agentPath")) expect(plan).toContain("history_path");
        else if (sql.includes("a.startedMs BETWEEN")) expect(plan).toContain("history_started");
        else expect(plan).toContain("history_project");
      }
    });
  } finally {f.db.close();}
});


test("a release fence arriving during a yield refuses refresh and leaves its durable queue retryable",async () => {
  const f=fixture();
  const target=path.join(path.dirname(f.filename),"viewer-release.json");
  try {
    f.put(pipeline("pipeline_one"));
    let release!: () => void; let yielded!: () => void;
    const blocked = new Promise<void>(resolve => { release=resolve; });
    const atYield = new Promise<void>(resolve => { yielded=resolve; });
    const pending=f.read(db=>historyAttemptCounts(db,"fixture",NOW),{onYield:async () => { yielded(); await blocked; }});
    await atYield;
    const revision="a".repeat(40);
    fs.writeFileSync(target,JSON.stringify({endpoint:"http://127.0.0.1:1",revision,hotStateBackend:HOT_STATE_BACKEND}));
    publishHotStateAuthority(path.dirname(f.filename),"fencing",revision);
    release();
    await expect(pending).rejects.toThrow(/fenced/);
    fs.unlinkSync(target);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(1);
  } finally {f.db.close();}
});

test("cancellation and an expired deadline preserve pending work; a warm artifact needs no refresh budget",async () => {
  const f=fixture();
  try {
    f.put(pipeline("pipeline_one"));
    const cancel=new AbortController();cancel.abort(new Error("fixture cancelled"));
    await expect(readHistoryProjection(historyHeadlessFlows,{filename:f.filename,signal:cancel.signal})).rejects.toThrow(/fixture cancelled/);
    await expect(readHistoryProjection(historyHeadlessFlows,{filename:f.filename,deadlineMs:0})).rejects.toThrow(/deadline/);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(1);
    expect(await readHistoryProjection(historyHeadlessFlows,{filename:f.filename,deadlineMs:0})).toEqual([]);
  } finally {f.db.close();}
});


test("removed project headers are evicted and a re-created project cannot reuse its cached revision",async () => {
  const f=fixture();
  try {
    const row=pipeline("pipeline_one");f.put(row);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(1);
    f.db.query("DELETE FROM state_rows WHERE row_key=?").run(row.id);
    await f.read(historyHeadlessFlows);
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM history_projects").get()!.n).toBe(0);
    row.runs[0].attempts.push({...row.runs[0].attempts[0],n:2});f.put(row);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(2);
  } finally {f.db.close();}
});


test("a warmed count follows project succession even when its caller holds the earlier key",async () => {
  const f=fixture();const previous=process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR=path.dirname(f.filename);resetProjectAliasesForTests();
  try {
    f.put(pipeline("pipeline_one"));f.put(pipeline("pipeline_two",{project:"renamed"}),"pipelines",1);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(1);
    expect(persistProjectAliases([{source:"fixture",target:"renamed",displayName:"renamed"}])).toBe(true);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(2);
  } finally {
    if(previous===undefined)delete process.env.LLV_STATE_DIR;else process.env.LLV_STATE_DIR=previous;
    resetProjectAliasesForTests();f.db.close();
  }
});


test("fleet wait precedence follows row order, row key and then run order",async () => {
  const f=fixture();
  const wait=(accountId:string)=>({accountId,resetsAt:null,resumeAt:new Date(NOW+1000).toISOString(),startedAt:new Date(NOW).toISOString(),text:"wait",turnTs:1,tries:0,condition:{kind:"usage_limit",scope:null,resetLabel:null,label:"usage limit"}});
  const first=pipeline("pipeline_alpha"),last=pipeline("pipeline_zulu");
  first.runs[1].attempts.push({...first.runs[0].attempts[0],n:1,providerWait:wait("account-alpha")} as never);
  Object.assign(last.runs[0].attempts[0],{providerWait:wait("account-zulu")});
  try {
    f.put(last);f.put(first);
    const expected=fleetLimitWaits([first,last] as unknown as Pipeline[]);
    expect(await f.read(db=>historyFleetLimitWaits(db,["conversation_fixture"]))).toEqual(expected);
    expect(expected.get("conversation_fixture")?.account).toBe("account-zulu");
  } finally {f.db.close();}
});
