import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { publishHotStateAuthority, HOT_STATE_BACKEND } from "./hotStateAuthority";
import { afterEach, expect, test, spyOn } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseReplacedError } from "./currentDatabase";
import { historyInputSql, installHistoryProjection, readHistoryProjection, historyAttemptCounts, historyPipelineRef, historyHeadlessFlows, historyHeadlessFlowsForTarget, historyHeadlessDeadRounds, historyFleetLimitWaits } from "./historyProjection";
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
function aliasDirectory(filename:string):string {
  // The projection fixture has a deliberately minimal schema. Alias persistence
  // needs the full state store, which owns a separate database in this fixture.
  const directory=path.join(path.dirname(filename),"aliases");fs.mkdirSync(directory);
  return directory;
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
    expect(ref).toEqual({pipelineId:"pipeline_63",stageId:"build",attempt:1,reportedState:"running",reportedPipelineState:"running",paneId:null,
      conversationId:"conversation_fixture",agentPath:"fixture-transcript"});
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
    expect(await f.read(db => historyPipelineRef(db,"conversation_fixture","fixture-transcript"))).toMatchObject({pipelineId:row.id,
      conversationId:"conversation_fixture",agentPath:"fixture-transcript"});
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
    first.stages[0]!.role!.roleId="reviewer";
    first.stages[0]!.effectiveRole!.roleId="reviewer";
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

test("count refresh handles an attempt entering and then leaving after a clock jump",async()=>{
  const f=fixture();
  try {
    const row=pipeline("clock_jump");
    row.runs[0]!.attempts[0]!.startedAt=new Date(NOW+30*24*60*60_000).toISOString();
    f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0,reviewer:0});
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW+90*24*60*60_000))).toEqual({builder:0,reviewer:0});
  } finally {f.db.close();}
});

test("count refresh removes an absent effective role while retaining the run role",async()=>{
  const f=fixture();
  try {
    const row=pipeline("role_removal");
    row.stages=row.stages.slice(0,1);row.runs=row.runs.slice(0,1);
    row.runs[0]!.attempts[0]!.effectiveRole!.roleId="reviewer";
    row.runs[0]!.attempts[0]!.startedAt=new Date(NOW).toISOString();
    f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0,reviewer:1});
    row.runs[0]!.attempts=[];
    f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0});

    const expiring=pipeline("role_expiry");
    expiring.stages=expiring.stages.slice(0,1);expiring.runs=expiring.runs.slice(0,1);
    expiring.runs[0]!.attempts[0]!.effectiveRole!.roleId="reviewer";
    expiring.runs[0]!.attempts[0]!.startedAt=new Date(NOW-WINDOW).toISOString();
    f.put(expiring);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0,reviewer:1});
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW+1))).toEqual({builder:0});
  } finally {f.db.close();}
});

test("count refresh keeps the inclusive millisecond window boundary",async()=>{
  const f=fixture();
  const now=Date.parse("2026-10-17T12:00:00.999Z");
  const row=pipeline("millisecond_boundary");
  row.runs[0]!.attempts[0]!.startedAt=new Date(now-WINDOW).toISOString();
  try {
    f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",now))).toEqual({builder:1,reviewer:0});
  } finally {f.db.close();}
});

test("count cache misses read aggregate roles and the indexed time slice",async()=>{
  const f=fixture();
  try{
    for(let n=0;n<250;n++){
      const row=pipeline(`archive_${n}`);row.runs[0]!.attempts[0]!.startedAt=new Date(NOW-100*24*60*60_000).toISOString();
      f.put(row,"pipelines_archive",n);
    }
    const recent=pipeline("recent_archive");recent.runs[0]!.attempts[0]!.startedAt="October 17, 2026 12:00:00 GMT";f.put(recent,"pipelines_archive",251);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:1,reviewer:0});
    await f.read(db=>{
      for(let n=0;n<65;n++)historyAttemptCounts(db,`evicted_${n}`,NOW);
      const query=spyOn(Database.prototype,"query");
      try{
        expect(historyAttemptCounts(db,"fixture",NOW+1)).toEqual({builder:1,reviewer:0});
        const sql=query.mock.calls.map(([statement])=>String(statement));
        expect(sql.some(statement=>statement.includes("FROM history_count_roles"))).toBe(true);
        expect(sql.some(statement=>statement.includes("FROM history_runs")&&statement.includes("GROUP BY r.role"))).toBe(false);
        expect(sql.some(statement=>statement.includes("a.startedMs BETWEEN")&&statement.includes("GROUP BY COALESCE(a.role,r.role)"))).toBe(true);
      }finally{query.mockRestore();}
    });
  }finally{f.db.close();}
});

test("a refused projection commit cannot publish speculative count state",async()=>{
  const f=fixture();
  try {
    const row=pipeline("commit_refusal"); f.put(row);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(1);
    row.runs[0]!.attempts.push({...row.runs[0]!.attempts[0]!,n:2,startedAt:new Date(NOW).toISOString()}); f.put(row);
    const original=Database.prototype.exec; const exec=spyOn(Database.prototype,"exec"); let refused=false;
    exec.mockImplementation(function(this:Database,sql:string) {
      if(!refused&&sql==="COMMIT"){refused=true;throw new Error("commit refused");}
      return Reflect.apply(original,this,[sql]);
    } as never);
    try { await expect(f.read(db=>historyAttemptCounts(db,"fixture",NOW))).rejects.toThrow("commit refused"); }
    finally {exec.mockRestore();}
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(2);
  } finally {f.db.close();}
});

test("flow changes do not remove confirmed dead owner evidence before liveness assembly",async()=>{
  const f=fixture();
  try {
    f.put(flow({rounds:[{reviewerPid:4244,reviewerIdentity:"dead-start",reviewerPath:"reviewer.jsonl"}]}),"flows");
    const projected=await f.read(historyHeadlessFlows);
    const probe=livenessProbe({now:()=>NOW,pidAlive:()=>false,processIdentity:()=>null});
    expect([...activeHeadlessTranscriptPaths(projected,{entries:{},conversations:{}},probe)]).toEqual([]);
    expect(projected.flatMap(item=>item.rounds)).toHaveLength(1);
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

test("invalid persisted flows are excluded with the authoritative validator",async()=>{
  const f=fixture();
  try{
    const missingRoles={...flow({id:"missing_roles"})} as Record<string,unknown>;delete missingRoles.roles;
    const invalidRole=flow({id:"invalid_role",roles:{implementer:{engine:"codex",model:null,effort:null},reviewer:{engine:"unknown",model:null,effort:null}}});
    const nullRound=flow({id:"null_round",rounds:[null]});
    for(const row of [missingRoles,invalidRole,nullRound])f.put(row,"flows");
    expect(await f.read(historyHeadlessFlows,{startup:true,collections:["flows"]})).toEqual([]);
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM state_rows WHERE collection='flows'").get()!.n).toBe(3);
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM history_rounds").get()!.n).toBe(0);
    expect(await f.read(historyHeadlessFlows,{startup:true,collections:["flows"]})).toEqual([]);
  }finally{f.db.close();}
});

for (const collections of [["pipelines","pipelines_archive","flows"], ["pipelines"]] as const) {
  test(`a separate steady writer outlives the deadline while ${collections.length === 1 ? "fleet" : "liveness"} reads include their initial rows`,async()=>{
    const f=fixture();
    const rows=Array.from({length:4},(_,n)=>{
      const row=pipeline(`initial_${n}`);
      Object.assign(row.runs[0]!.attempts[0]!,{conversationId:`conversation_${n}`,providerWait:{accountId:null,resetsAt:NOW+1000,
        resumeAt:new Date(NOW+2000).toISOString(),startedAt:new Date(NOW).toISOString(),text:"wait",turnTs:1,tries:0,
        condition:{kind:"usage_limit",scope:null,resetLabel:null,label:"usage limit"}}});
      return row;
    });
    const laterRow=pipeline("later_steady");
    const root=path.dirname(f.filename),ready=path.join(root,"reader-ready"),signals=path.join(root,"reader-yields"),acks=path.join(root,"writer-acks"),writerRows=path.join(root,"writer-rows.json");
    fs.mkdirSync(signals);fs.mkdirSync(acks);
    fs.writeFileSync(writerRows,JSON.stringify(laterRow));
    const home=path.join(root,"child-home");fs.mkdirSync(home);
    const env={...process.env,HOME:home,XDG_CONFIG_HOME:home,TMPDIR:home,LLV_STATE_DIR:home,LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1"};
    const readerSource=`
      const fs=await import("node:fs"),path=await import("node:path");
      const {readHistoryProjection,historyAttemptCounts,historyPipelineRef,historyFleetLimitWaits}=await import(process.argv[1]);
      const filename=process.argv[2],ready=process.argv[3],signals=process.argv[4],acks=process.argv[5];
      const collections=JSON.parse(process.argv[6]),rows=JSON.parse(process.argv[7]);
      const started=performance.now(),deadline=started+1000;let signaled=false,yields=0;
      const waitForCommit=signal=>new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(path.join(acks,String(signal)))){clearInterval(timer);resolve();}},1);});
      try{
        const answer=await readHistoryProjection(db=>({
          counts:historyAttemptCounts(db,"fixture",${NOW}),
          refs:rows.map(row=>historyPipelineRef(db,row.runs[0].attempts[0].conversationId,"missing-transcript")),
          waits:[...historyFleetLimitWaits(db,rows.map(row=>row.runs[0].attempts[0].conversationId))],
          keys:db.query("SELECT row_key FROM history_inputs ORDER BY row_key").all().map(row=>row.row_key),
        }),{filename,collections,deadlineMs:deadline,onYield:async()=>{if(!signaled){signaled=true;fs.writeFileSync(ready,"captured");}const signal=++yields;fs.writeFileSync(path.join(signals,String(signal)),"yield");await waitForCommit(signal);}});
        process.stdout.write(JSON.stringify({ok:true,elapsed:performance.now()-started,answer})+"\\n");
      }catch(error){process.stdout.write(JSON.stringify({ok:false,elapsed:performance.now()-started,error:String(error)})+"\\n");process.exitCode=1;}
    `;
    const writerSource=`
      const fs=await import("node:fs"),path=await import("node:path");const {Database}=await import("bun:sqlite");
      const filename=process.argv[1],ready=process.argv[2],signals=process.argv[3],acks=process.argv[4],row=JSON.parse(fs.readFileSync(process.argv[5],"utf8"));
      const waitForStart=()=>new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(ready)){clearInterval(timer);resolve();}},2);});
      const db=new Database(filename);db.exec("PRAGMA busy_timeout=1000");let count=0,handled=0,started;
      const commit=()=>{count++;db.query("INSERT INTO state_rows VALUES (?,?,?,?) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json,row_order=excluded.row_order")
        .run("pipelines",row.id,JSON.stringify(row),count);};
      try{await waitForStart();started=performance.now();let nextFreeWrite=started;while(performance.now()-started<1600){const signal=handled+1;
        if(fs.existsSync(path.join(signals,String(signal)))){commit();handled++;fs.writeFileSync(path.join(acks,String(signal)),"committed");nextFreeWrite=performance.now()+10;}
        else if(performance.now()>=nextFreeWrite){commit();nextFreeWrite=performance.now()+10;}
        await new Promise(resolve=>setTimeout(resolve,1));
      }process.stdout.write(JSON.stringify({count,elapsed:performance.now()-started})+"\\n");}
      catch(error){process.stderr.write(String(error));process.exitCode=1;}finally{db.close();}
    `;
    let reader:ReturnType<typeof Bun.spawn>|undefined,writer:ReturnType<typeof Bun.spawn>|undefined,readerFinished=false;
    try{
      rows.forEach(row=>f.put(row));
      const readerStartedAt=performance.now();
      reader=Bun.spawn([process.execPath,"-e",readerSource,path.join(import.meta.dir,"historyProjection.ts"),f.filename,ready,signals,acks,JSON.stringify(collections),JSON.stringify(rows)],
        {env,stdout:"pipe",stderr:"pipe"});
      const startedAt=performance.now();
      while(!fs.existsSync(ready)&&performance.now()-startedAt<1000)await new Promise(resolve=>setTimeout(resolve,2));
      expect(fs.existsSync(ready)).toBe(true);
      writer=Bun.spawn([process.execPath,"-e",writerSource,f.filename,ready,signals,acks,writerRows],{env,stdout:"pipe",stderr:"pipe"});
      const committed=path.join(acks,"1"),committedAt=performance.now();
      while(!fs.existsSync(committed)&&performance.now()-committedAt<1000)await new Promise(resolve=>setTimeout(resolve,2));
      expect(fs.existsSync(committed)).toBe(true);
      const readerResult=await Promise.race([
        Promise.all([reader.exited,new Response(reader.stdout as ReadableStream<Uint8Array>).text(),new Response(reader.stderr as ReadableStream<Uint8Array>).text()]).then(([code,out,stderr])=>{readerFinished=true;return {code,out,stderr};}),
        new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("projection reader exceeded external 1000 ms deadline")),Math.max(0,readerStartedAt+1000-performance.now()))),
      ]);
      const parsed=JSON.parse(readerResult.out.trim()) as {ok:boolean;elapsed:number;answer?:{counts:Record<string,number>;refs:Array<{pipelineId:string}|null>;waits:Array<[string,unknown]>;keys:string[]};error?:string};
      expect(readerResult.code).toBe(0);expect(parsed.ok).toBe(true);
      expect(parsed.elapsed).toBeLessThan(1000);
      expect(parsed.answer!.keys).toEqual(rows.map(row=>row.id));
      expect(parsed.answer!.counts).toEqual(oldCounts(rows));
      expect(parsed.answer!.refs.map(ref=>ref?.pipelineId)).toEqual(rows.map(row=>row.id));
      expect(parsed.answer!.waits).toEqual([...fleetLimitWaits(rows as unknown as Pipeline[])]);
      const [writerCode,writerOut,writerErr]=await Promise.all([writer.exited,new Response(writer.stdout as ReadableStream<Uint8Array>).text(),new Response(writer.stderr as ReadableStream<Uint8Array>).text()]);
      expect(writerCode).toBe(0);expect(writerErr).toBe("");
      const writerResult=JSON.parse(writerOut.trim()) as {count:number;elapsed:number};
      expect(writerResult.elapsed).toBeGreaterThan(1000);expect(writerResult.count).toBeGreaterThan(0);
      expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM history_pending").get()!.n).toBeGreaterThan(0);
      const pendingBeforeFollowup=f.db.query<{collection:string;row_key:string},[]>("SELECT collection,row_key FROM history_pending ORDER BY row_key").all();
      expect(pendingBeforeFollowup).toEqual([{collection:"pipelines",row_key:"later_steady"}]);
      const final=await f.read(db=>db.query<{row_key:string},[]>("SELECT row_key FROM history_inputs WHERE collection='pipelines' ORDER BY row_key").all().map(row=>row.row_key),{collections});
      expect(final).toHaveLength(rows.length+1);
      expect(final).toContain("initial_0");
      expect(final).toContain("later_steady");
    }finally{
      if(reader&&!readerFinished&&reader.exitCode===null)reader.kill();
      if(writer&&writer.exitCode===null)writer.kill();
      if(reader&&reader.exitCode===null)await reader.exited;
      if(writer&&writer.exitCode===null)await writer.exited;
      f.db.close();
    }
  });
}

test("a commit during cooperative bootstrap remains queued for the following read",async () => {
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
    expect((await pending).builder).toBe(4);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(5);
  } finally { f.db.close(); }
});

test("captured identities include updates and deletions before projection and defer a re-enqueued identity",async () => {
  const f=fixture();
  const rows=[pipeline("initial_a"),pipeline("initial_b"),pipeline("initial_c")];
  try {
    rows.forEach(row=>f.put(row));
    let changed=false;
    const answer=await f.read(db=>({counts:historyAttemptCounts(db,"fixture",NOW),
      keys:db.query<{row_key:string},[]>("SELECT row_key FROM history_inputs ORDER BY row_key").all().map(row=>row.row_key),
    }),{onYield:async()=>{
      if(changed)return;changed=true;
      for(const row of rows.slice(0,2)){
        row.runs[0].attempts.push({...row.runs[0].attempts[0],n:2});f.put(row);
      }
      f.db.query("DELETE FROM state_rows WHERE row_key=?").run(rows[2].id);
    }});
    expect(answer.counts).toEqual({builder:3,reviewer:0});
    expect(answer.keys).toEqual(["initial_a","initial_b"]);
    expect(f.db.query<{row_key:string},[]>("SELECT row_key FROM history_pending ORDER BY row_key").all()).toEqual([{row_key:"initial_a"}]);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:4,reviewer:0});
  } finally {f.db.close();}
});

test("a replaced database cannot return an answer from a stale pending batch",async()=>{
  const f=fixture();
  const backup=path.join(path.dirname(f.filename),"replacement.sqlite");
  let replaced=false;
  try{
    f.put(pipeline("initial_a"));f.put(pipeline("initial_b"));
    f.db.query("VACUUM INTO ?").run(backup);
    await expect(f.read(db=>historyAttemptCounts(db,"fixture",NOW),{onYield:async()=>{
      if(replaced)return;replaced=true;
      for(const suffix of ["-wal","-shm"]){
        const sidecar=`${f.filename}${suffix}`;
        if(fs.existsSync(sidecar))fs.renameSync(sidecar,`${sidecar}.old`);
      }
      fs.renameSync(f.filename,`${f.filename}.old`);
      fs.renameSync(backup,f.filename);
    }})).rejects.toBeInstanceOf(DatabaseReplacedError);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:2,reviewer:0});
    const replacementDb=new Database(f.filename);
    try{expect(replacementDb.query<{row_key:string},[]>("SELECT row_key FROM history_pending ORDER BY row_key").all()).toEqual([]);}
    finally{replacementDb.close();}
  }finally{f.db.close();}
});

test("lock retries retain the captured batch and its committed progress",async () => {
  const f=fixture();
  const lock=new Database(f.filename);lock.exec("PRAGMA busy_timeout=0");
  let released:Promise<void> | undefined;
  try {
    f.put(pipeline("initial_a"));f.put(pipeline("initial_b"));
    const answer=await f.read(db=>historyAttemptCounts(db,"fixture",NOW),{onYield:async()=>{
      if(released)return;
      lock.exec("BEGIN IMMEDIATE");
      lock.query("INSERT INTO state_rows VALUES (?,?,?,?)").run("pipelines","later",JSON.stringify(pipeline("later")),0);
      // The next projection attempt must defer before this timer releases the lock.
      released=new Promise<void>(resolve=>setTimeout(()=>{lock.exec("COMMIT");resolve();},0));
    }});
    expect(answer).toEqual({builder:2,reviewer:0});
    expect(f.db.query<{row_key:string},[]>("SELECT row_key FROM history_pending").all()).toEqual([{row_key:"later"}]);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:3,reviewer:0});
  } finally {await released;lock.close();f.db.close();}
});

test("cancellation during a bounded drain leaves the remaining identities retryable",async () => {
  const f=fixture();const cancel=new AbortController();
  try {
    f.put(pipeline("initial_a"));f.put(pipeline("initial_b"));
    await expect(f.read(db=>historyAttemptCounts(db,"fixture",NOW),{signal:cancel.signal,
      onYield:async()=>{cancel.abort(new Error("fixture cancelled during drain"));},
    })).rejects.toThrow("fixture cancelled during drain");
    expect(f.db.query<{row_key:string},[]>("SELECT row_key FROM history_pending").all()).toEqual([{row_key:"initial_b"}]);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:2,reviewer:0});
  } finally {f.db.close();}
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

test("targeted headless liveness uses owner indexes and skips unrelated rounds", async () => {
  const f = fixture();
  try {
    f.put(flow({ id: "flow-target", rounds: [{ reviewerPid: 41, reviewerPath: "target-path", reviewerConversationId: "conversation_target", reviewerIdentity: "target-start" }] }), "flows", 1);
    for (let index = 0; index < 80; index += 1) {
      f.put(flow({ id: `flow-unrelated-${index}`, rounds: [{ reviewerPid: 1000 + index, reviewerPath: `other-path-${index}`, reviewerConversationId: `conversation_other_${index}`, reviewerIdentity: `other-start-${index}` }] }), "flows", index + 2);
    }
    const rows = (await f.read(db => historyHeadlessFlowsForTarget(db, ["conversation_target"], ["target-path"])))
      .flatMap(item => item.rounds);
    expect(rows.map(row => row.reviewerPid)).toEqual([41]);
    const plan = f.db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN SELECT r.*,p.row_order FROM history_rounds r
      JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key
      WHERE r.reviewerConversationId IN (?) OR r.reviewerPath IN (?)
      ORDER BY p.row_order,p.row_key,r.round`).all("conversation_target", "target-path").map(row => row.detail).join("\n");
    expect(plan).toContain("history_reviewer_conversation");
    expect(plan).toContain("history_reviewer_path");
  } finally { f.db.close(); }
});

test("large headless history reuses its cached rows and applies one changed flow",async()=>{
  const f=fixture();
  try {
    const rounds=Array.from({length:3000},(_,n)=>({reviewerPid:20000+n,reviewerPath:`reviewer-${n}`,reviewerIdentity:`start-${n}`}));
    const saved=flow({rounds});f.put(saved,"flows",1);
    expect((await f.read(historyHeadlessFlows)).flatMap(item=>item.rounds)).toHaveLength(3000);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyHeadlessFlows(db)).toHaveLength(3000);
        expect(query.mock.calls.some(([sql])=>sql.includes("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs"))).toBe(false);
      } finally {query.mockRestore();}
    });
    const changed=flow({rounds:rounds.slice(1)});f.put(changed,"flows",1);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try {
        expect(historyHeadlessFlows(db).flatMap(item=>item.rounds)).toHaveLength(2999);
        expect(query.mock.calls.some(([sql])=>sql.includes("WHERE r.row_key=?"))).toBe(true);
        expect(query.mock.calls.some(([sql])=>sql.includes("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key ORDER BY"))).toBe(false);
      } finally {query.mockRestore();}
    });
  } finally {f.db.close();}
});

test("dead headless rounds leave the active walk but remain indexed across unrelated flow updates",async()=>{
  const f=fixture();
  let probes=0;
  const probe=livenessProbe({now:()=>NOW,pidAlive:()=>{probes++;return false;},processIdentity:()=>null});
  const registry={entries:{},conversations:{}};
  try {
    f.put(flow({rounds:Array.from({length:3000},(_,n)=>({reviewerPid:10000+n,reviewerPath:`dead-${n}`,reviewerIdentity:`start-${n}`}))}),"flows");
    const first=await f.read(historyHeadlessFlows);
    expect([...activeHeadlessTranscriptPaths(first,registry,probe,true)]).toEqual([]);
    expect(probes).toBe(3000);
    expect(first).toHaveLength(0);
    expect(historyHeadlessDeadRounds(first,"dead-0",[])).toHaveLength(1);
    const unchanged=await f.read(historyHeadlessFlows);
    expect(unchanged).toHaveLength(0);
    expect([...activeHeadlessTranscriptPaths(unchanged,registry,probe,true)]).toEqual([]);
    expect(probes).toBe(3000);
    f.put(flow({id:"flow_two",rounds:[]}),"flows",2);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try{
        const updated=historyHeadlessFlows(db);
        expect(updated).toHaveLength(0);
        expect(historyHeadlessDeadRounds(updated,"dead-0",[])).toHaveLength(1);
        const sql=query.mock.calls.map(([statement])=>String(statement));
        expect(sql.some(statement=>statement.includes("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key ORDER BY"))).toBe(false);
      }finally{query.mockRestore();}
    });
    expect(probes).toBe(3000);
  } finally { f.db.close(); }
});

test("small flow deltas preserve dead-owner indexes without scanning retained history",async()=>{
  const f=fixture();
  try{
    f.put(flow({rounds:Array.from({length:3000},(_,n)=>({reviewerPid:30000+n,reviewerPath:`dead-retained-${n}`,reviewerIdentity:`start-${n}`}))}),"flows");
    const flows=await f.read(historyHeadlessFlows);
    const probe=livenessProbe({now:()=>NOW,pidAlive:()=>false,processIdentity:()=>null});
    expect([...activeHeadlessTranscriptPaths(flows,{entries:{},conversations:{}},probe,true)]).toEqual([]);
    f.put(flow({id:"unrelated_empty",rounds:[]}),"flows",2);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try{
        expect(historyHeadlessFlows(db)).toEqual([]);
        const sql=query.mock.calls.map(([statement])=>String(statement));
        expect(sql.some(statement=>statement.includes("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key ORDER BY"))).toBe(false);
        expect(sql.some(statement=>statement.includes("SELECT r.*,p.row_order FROM history_rounds r JOIN history_inputs p ON p.collection='flows' AND p.row_key=r.row_key WHERE r.row_key=?"))).toBe(true);
      }finally{query.mockRestore();}
    });
    expect(historyHeadlessDeadRounds(flows,"dead-retained-0",[])).toHaveLength(1);
    f.put(flow({id:"small_delta",rounds:[{reviewerPid:40001,reviewerPath:"new-reviewer",reviewerIdentity:"new-start"}]}),"flows",3);
    await f.read(db=>{
      const query=spyOn(Database.prototype,"query");
      try{
        const updated=historyHeadlessFlows(db);
        expect(updated.flatMap(item=>item.rounds.map(round=>round.reviewerPath))).toEqual(["new-reviewer"]);
        expect(historyHeadlessDeadRounds(updated,"dead-retained-0",[])).toHaveLength(1);
        const sql=query.mock.calls.map(([statement])=>String(statement));
        expect(sql.filter(statement=>statement.includes("SELECT r.*,p.row_order FROM history_rounds"))).toHaveLength(1);
        expect(sql.some(statement=>statement.includes("ORDER BY p.row_order,p.row_key,r.round"))).toBe(false);
      }finally{query.mockRestore();}
    });
  }finally{f.db.close();}
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
        expect(query.mock.calls.some(([sql]) => sql.includes("FROM history_count_roles"))).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql.includes("GROUP BY r.role"))).toBe(false);
      } finally { query.mockRestore(); }
    });
  } finally { f.db.close(); }
});

test("a real process restart reads the persisted projection",async () => {
  const f = fixture();
  try {
    f.put(pipeline("pipeline_one"));
    expect(await f.read(db => historyAttemptCounts(db,"fixture",NOW),{onYield:async()=>{
      f.put(pipeline("pipeline_two"));
    }})).toEqual({builder:1,reviewer:0});
    const childRoot = path.join(path.dirname(f.filename),"child"); fs.mkdirSync(childRoot);
    const env = { ...process.env, HOME:childRoot, XDG_CONFIG_HOME:childRoot, TMPDIR:childRoot, LLV_STATE_DIR:childRoot, LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1" };
    const child = Bun.spawn([process.execPath,"-e",`
      const {readHistoryProjection,historyAttemptCounts}=await import(process.argv[1]);
      console.log(JSON.stringify(await readHistoryProjection(db=>historyAttemptCounts(db,"fixture",${NOW}),{filename:process.argv[2]})));
    `,path.join(import.meta.dir,"historyProjection.ts"),f.filename],{env,stdout:"pipe",stderr:"pipe"});
    const [code,output,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(output)).toEqual({builder:2,reviewer:0});
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

test("headless shared byte cap is enforced after flow refresh and dead-owner pruning",async()=>{
  const f=fixture();
  const cap=16*1024*1024;
  const cacheBytes=()=>[...((globalThis as typeof globalThis&{__delegatusHistoryProjectionV1?:{headless:Map<string,{bytes:number}>}}).__delegatusHistoryProjectionV1?.headless.values()??[])].reduce((sum,item)=>sum+item.bytes,0);
  const make=(id:string,size:number)=>flow({id,rounds:[{reviewerPid:51001,reviewerPath:"r".repeat(size),reviewerIdentity:"dead-start"}]});
  try{
    f.put(make("large_one",6*1024*1024),"flows",1);f.put(make("large_two",6*1024*1024),"flows",2);
    await f.read(historyHeadlessFlows);
    f.put(make("large_one",9*1024*1024),"flows",1);await f.read(historyHeadlessFlows);
    f.put(make("large_two",9*1024*1024),"flows",2);await f.read(historyHeadlessFlows);
    expect(cacheBytes()).toBeLessThanOrEqual(cap);
  }finally{f.db.close();}
  const pruned=fixture();
  try{
    pruned.put(flow({id:"large_pruned",rounds:[{reviewerPid:52001,reviewerPath:"p".repeat(9*1024*1024),reviewerIdentity:"dead-start"}]}),"flows");
    const projected=await pruned.read(historyHeadlessFlows);
    const dead=livenessProbe({now:()=>NOW,pidAlive:()=>false,processIdentity:()=>null});
    expect([...activeHeadlessTranscriptPaths(projected,{entries:{},conversations:{}},dead,true)]).toEqual([]);
    expect(cacheBytes()).toBeLessThanOrEqual(cap);
  }finally{pruned.db.close();}
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
        if (sql.includes("WHERE a.conversationId=?")) expect(plan).toContain("history_conversation");
        else if (sql.includes("WHERE a.agentPath=?")) expect(plan).toContain("history_path");
        else if (sql.includes("a.conversationId")) expect(plan).toContain("history_conversation");
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
  process.env.LLV_STATE_DIR=aliasDirectory(f.filename);resetProjectAliasesForTests();
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

test("local count delta cannot hide a peer projection revision",async()=>{
  const f=fixture();
  const childRoot=path.join(path.dirname(f.filename),"peer-reader");fs.mkdirSync(childRoot);
  const env={...process.env,HOME:childRoot,XDG_CONFIG_HOME:childRoot,TMPDIR:childRoot,LLV_STATE_DIR:childRoot,LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1"};
  try{
    const a=pipeline("peer_a"),b=pipeline("peer_b");f.put(a);f.put(b,"pipelines",1);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(2);
    b.runs[0]!.attempts.push({...b.runs[0]!.attempts[0]!,n:2});f.put(b,"pipelines",1);
    const child=Bun.spawn([process.execPath,"-e",`
      const {readHistoryProjection,historyHeadlessFlows}=await import(process.argv[1]);
      await readHistoryProjection(historyHeadlessFlows,{filename:process.argv[2],collections:["pipelines"]});
    `,path.join(import.meta.dir,"historyProjection.ts"),f.filename],{env,stdout:"pipe",stderr:"pipe"});
    const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
    expect(code).toBe(0);expect(stderr).toBe("");
    a.runs[0]!.attempts.push({...a.runs[0]!.attempts[0]!,n:2});f.put(a);
    expect((await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).builder).toBe(4);
  }finally{f.db.close();}
});

test("alias change plus a record update rebuilds the complete canonical count",async()=>{
  const f=fixture();const previous=process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR=aliasDirectory(f.filename);resetProjectAliasesForTests();
  try{
    f.put(pipeline("alias_source"));const renamed=pipeline("alias_target",{project:"renamed"});f.put(renamed,"pipelines",1);
    expect((await f.read(db=>historyAttemptCounts(db,"renamed",NOW))).builder).toBe(1);
    expect(persistProjectAliases([{source:"fixture",target:"renamed",displayName:"renamed"}])).toBe(true);
    renamed.runs[0]!.attempts.push({...renamed.runs[0]!.attempts[0]!,n:2});f.put(renamed,"pipelines",1);
    expect((await f.read(db=>historyAttemptCounts(db,"renamed",NOW))).builder).toBe(3);
  }finally{if(previous===undefined)delete process.env.LLV_STATE_DIR;else process.env.LLV_STATE_DIR=previous;resetProjectAliasesForTests();f.db.close();}
});

test("warm count removal drops an unbacked effective role key",async()=>{
  const f=fixture();
  try{
    const row=pipeline("effective_role");row.stages=row.stages.slice(0,1);row.runs=row.runs.slice(0,1);
    row.runs[0]!.attempts[0]!.effectiveRole!.roleId="reviewer";f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0,reviewer:1});
    row.runs[0]!.attempts=[];f.put(row);
    expect(await f.read(db=>historyAttemptCounts(db,"fixture",NOW))).toEqual({builder:0});
  }finally{f.db.close();}
});

test("aliased project role backing sums survive a member deletion",async()=>{
  const f=fixture();const previous=process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR=aliasDirectory(f.filename);resetProjectAliasesForTests();
  try{
    const first=pipeline("backing_first",{project:"fixture"}),second=pipeline("backing_second",{project:"renamed"});
    first.runs.forEach(run=>{run.attempts=[];});second.runs.forEach(run=>{run.attempts=[];});
    f.put(first);f.put(second,"pipelines",1);
    expect(persistProjectAliases([{source:"fixture",target:"renamed",displayName:"renamed"}])).toBe(true);
    expect(await f.read(db=>historyAttemptCounts(db,"renamed",NOW))).toEqual({builder:0,reviewer:0});
    f.db.query("DELETE FROM state_rows WHERE collection='pipelines' AND row_key='backing_second'").run();
    expect(await f.read(db=>historyAttemptCounts(db,"renamed",NOW))).toEqual({builder:0,reviewer:0});
  }finally{if(previous===undefined)delete process.env.LLV_STATE_DIR;else process.env.LLV_STATE_DIR=previous;resetProjectAliasesForTests();f.db.close();}
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

test("the jsonb and the text input queries store the same text JSON",() => {
  const f=fixture();
  try {
    const wait={accountId:null,resetsAt:NOW+1000,resumeAt:new Date(NOW+2000).toISOString(),startedAt:new Date(NOW).toISOString(),text:"wait",turnTs:1,tries:0,condition:{kind:"usage_limit",scope:null,resetLabel:null,label:"usage limit"}};
    const rows=[pipeline("plain"),pipeline("closed",{closedAt:new Date(NOW).toISOString()}),pipeline("empty_runs",{runs:[]})];
    rows[0]!.runs[0]!.attempts.push({...rows[0]!.runs[0]!.attempts[0]!,n:2,historical:true,providerWait:wait} as never);
    rows.forEach((row,n)=>f.put(row,"pipelines",n));
    f.put(flow({id:"flow_rounds",rounds:[{reviewerPath:"/b.jsonl",reviewerConversationId:null,reviewerPid:7,reviewerIdentity:"x"},{reviewerPath:"/a.jsonl",reviewerConversationId:"c",reviewerPid:0,reviewerIdentity:null}]}),"flows");
    f.put(flow({id:"flow_empty"}),"flows");
    expect(historyInputSql(f.db,"pipelines","text")).not.toContain("jsonb");
    expect(historyInputSql(f.db,"flows","text")).not.toContain("jsonb");
    for (const [collection,key] of [["pipelines","plain"],["pipelines","closed"],["pipelines","empty_runs"],["flows","flow_rounds"],["flows","flow_empty"]] as const) {
      const input=(form:"jsonb"|"text")=>f.db.query<{input:string},[string,string]>(historyInputSql(f.db,collection,form)).get(collection,key)!.input;
      expect(typeof input("jsonb")).toBe("string");
      expect(input("text")).toBe(input("jsonb"));
    }
    expect(historyInputSql(f.db,"pipelines")).toBe(historyInputSql(f.db,"pipelines","jsonb"));
  } finally { f.db.close(); }
});
