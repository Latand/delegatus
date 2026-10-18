import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { decodeFlow } from "@/lib/reviewHistory/decode";
import { isStoredPipeline } from "@/lib/pipelines/store";
import { readAttribution } from "@/lib/readAttribution";
import { installHistoryProjection, readHistoryProjection, historyAttemptCounts, historyHeadlessFlows } from "@/lib/state/historyProjection";
import { activeHeadlessTranscriptPaths } from "@/lib/lifecycle/liveness";
import { livenessProbe } from "@/lib/agent/accountLiveness";

type Operation = "update" | "expiry" | "liveness";
const operation = process.argv.find(value => value.startsWith("--operation="))?.slice("--operation=".length) as Operation | undefined;
const prepareTemplate=process.argv.includes("--prepare-template");
if (!process.env.LLV_STATE_DIR || !process.argv.includes("--isolated-copy") || (!prepareTemplate && !["update","expiry","liveness"].includes(operation ?? ""))) {
  throw new Error("requires --isolated-copy, LLV_STATE_DIR for a private database copy, and --operation=update|expiry|liveness or --prepare-template");
}
if (process.platform !== "linux") throw new Error("measurement requires Linux per-thread counters");

const filename = statePath("state.sqlite");
const sourceHasher=crypto.createHash("sha256");
for await(const chunk of fs.createReadStream(filename)) sourceHasher.update(chunk);
const sourceHash=sourceHasher.digest("hex");
const base = Date.parse("2026-10-17T12:00:00.000Z");
const windowMs = 30 * 24 * 60 * 60_000;
const db = new Database(filename);
db.exec("BEGIN IMMEDIATE");
installHistoryProjection(db,path.dirname(filename));
db.exec("COMMIT");
const project = db.query<{project:string},[]>(`SELECT json_extract(value_json,'$.project') AS project FROM state_rows
 WHERE collection='pipelines' AND json_valid(value_json) GROUP BY project ORDER BY count(*) DESC LIMIT 1`).get()?.project ?? "fixture";
const dimensions = db.query<{rows:number;bytes:number},[]>(`SELECT count(*) AS rows,sum(length(CAST(value_json AS BLOB))) AS bytes FROM state_rows
 WHERE collection IN ('pipelines','pipelines_archive','flows')`).get()!;
let now=base, targetRows=0;
if(operation==="liveness"||prepareTemplate) {
  const existing=db.query<{value_json:string},[string]>("SELECT value_json FROM state_rows WHERE collection='flows' AND row_key=?").get("history_measure_flow");
  if(!existing) {
    const rowOrder=db.query<{value:number},[]>("SELECT COALESCE(MAX(row_order),-1)+1 AS value FROM state_rows WHERE collection='flows'").get()!.value;
    const rounds=Array.from({length:1000},(_,n)=>({reviewerPid:2_147_000_000+n,reviewerPath:`history-measure-${n}`,reviewerConversationId:null,reviewerIdentity:`historical-start-${n}`}));
    const fixture={id:"history_measure_flow",project:"fixture",template:"implement-review-loop",cwd:"/repo",implementerPath:"implementer.jsonl",baseRef:"a".repeat(40),
      roles:{implementer:{engine:"codex",model:null,effort:null},reviewer:{engine:"codex",model:null,effort:null}},reviewerMode:"headless",rounds};
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('flows',?,?,?,1,1)")
      .run(fixture.id,JSON.stringify(fixture),rowOrder);
    targetRows=rounds.length;
  } else targetRows=(JSON.parse(existing.value_json) as {rounds:unknown[]}).rounds.length;
}
let manualDecodedJsonBytes=0;
function readLegacyRows<T>(collections: readonly string[], accept: (value:unknown)=>value is T): T[] {
  const placeholders=collections.map(()=>"?").join(",");
  const rows=db.query<{value_json:string},string[]>(`SELECT value_json FROM state_rows WHERE collection IN (${placeholders}) AND json_valid(value_json) ORDER BY row_order,row_key`).all(...collections);
  const result:T[]=[];
  for(const row of rows) { manualDecodedJsonBytes+=Buffer.byteLength(row.value_json); try { const value:unknown=JSON.parse(row.value_json); if(accept(value)) result.push(value); } catch { /* malformed persisted records are skipped as by the adapters */ } }
  return result;
}

if(prepareTemplate) {
  await readHistoryProjection(database=>historyAttemptCounts(database,project,base),{filename,collections:["pipelines","pipelines_archive"]});
  await readHistoryProjection(historyHeadlessFlows,{filename,collections:["flows"]});
  const resultFile=process.env.MEASURE_RESULT_FILE;
  if(!resultFile) throw new Error("MEASURE_RESULT_FILE must name an isolated output file");
  fs.writeFileSync(resultFile,JSON.stringify({operation:"prepare-template",sourceSha256:sourceHash,sourceRows:dimensions.rows,
    sourceJsonBytes:dimensions.bytes,syntheticRounds:targetRows}),{mode:0o600});
  db.close();
  process.exit(0);
}

function threadCounters() {
  const prefix = `/proc/self/task/${process.pid}`;
  const io = fs.readFileSync(`${prefix}/io`,"utf8");
  const sched = fs.readFileSync(`${prefix}/schedstat`,"utf8");
  return { bytes:Number(/^rchar: (\d+)/m.exec(io)![1]),runNs:Number(sched.split(" ")[0]) };
}
async function measure<T>(work:()=>T|Promise<T>) {
  readAttribution.clear();
  manualDecodedJsonBytes=0;
  let last=performance.now(),maxTimerGapMs=0;
  const timer=setInterval(()=>{const at=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,at-last-10);last=at;},10);
  const before=threadCounters(),started=performance.now();
  const result=await work();
  const elapsedMs=performance.now()-started,after=threadCounters();
  await new Promise<void>(resolve=>setTimeout(resolve,15));
  clearInterval(timer);
  return {result,elapsedMs,mainThreadMs:(after.runNs-before.runNs)/1e6,readBytes:after.bytes-before.bytes,
    decodedJsonBytes:manualDecodedJsonBytes+readAttribution.snapshot(elapsedMs).decodedJsonBytes,maxTimerGapMs};
}

if (operation === "liveness") {
  await readHistoryProjection(historyHeadlessFlows,{filename,collections:["flows"]});
} else {
  await readHistoryProjection(database=>historyAttemptCounts(database,project,base),{filename,collections:["pipelines","pipelines_archive"]});
  if (operation === "update") {
    const target=db.query<{row_key:string},[string]>(`SELECT row_key FROM state_rows WHERE collection='pipelines' AND json_valid(value_json)
      AND json_extract(value_json,'$.project')=? AND json_type(value_json,'$.runs[0].attempts[0].startedAt')='text' LIMIT 1`).get(project);
    if (target) {
      targetRows=1;
      db.query(`UPDATE state_rows SET value_json=json_set(value_json,'$.runs[0].attempts[0].conversationId',?) WHERE collection='pipelines' AND row_key=?`)
        .run("conversation_measure_delta",target.row_key);
    }
  }
  if (operation === "expiry") {
    const first=db.query<{at:number|null},[string,number,number]>(`SELECT MIN(a.startedMs) AS at FROM history_attempts a INDEXED BY history_started
      JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE p.project=? AND p.collection IN ('pipelines','pipelines_archive')
      AND a.startedMs BETWEEN ? AND ?`).get(project,base-windowMs,base)?.at;
    now=first===null||first===undefined?base+windowMs+1:first+windowMs+1;
    targetRows=db.query<{n:number},[string,number,number]>(`SELECT count(*) AS n FROM history_attempts a INDEXED BY history_started
      JOIN history_inputs p ON p.collection=a.collection AND p.row_key=a.row_key WHERE p.project=? AND p.collection IN ('pipelines','pipelines_archive')
      AND a.startedMs BETWEEN ? AND ?`).get(project,base-windowMs,now-windowMs-1)?.n ?? 0;
  }
}
const probeCalls={pid:0,identity:0};
const probe=livenessProbe({
  now:()=>base,
  pidAlive:pid=>{probeCalls.pid++;try{process.kill(pid,0);return true;}catch{return false;}},
  processIdentity:pid=>{probeCalls.identity++;try{return fs.readFileSync(`/proc/${pid}/stat`,"utf8").split(") ")[1]?.split(" ")[19]??null;}catch{return null;}},
});
const registry={entries:{},conversations:{}};
const summaries:Record<string,unknown>={};

if(operation==="liveness") {
  const before=await measure(()=>{
    const flows=readLegacyRows(["flows"],decodeFlow).filter(flow=>flow.reviewerMode==="headless");
    const roundRows=flows.reduce((sum,flow)=>sum+flow.rounds.length,0);
    const paths=activeHeadlessTranscriptPaths(flows,registry,probe,true);
    return {roundRows,paths:paths.size};
  });
  Object.assign(before,{pidProbes:probeCalls.pid,identityProbes:probeCalls.identity});
  probeCalls.pid=0;probeCalls.identity=0;
  const firstAfter=await measure(async()=>{
    const flows=await readHistoryProjection(historyHeadlessFlows,{filename,collections:["flows"]});
    const roundRows=flows.reduce((sum,flow)=>sum+flow.rounds.length,0);
    const paths=activeHeadlessTranscriptPaths(flows,registry,probe,true);
    return {roundRows,paths:paths.size};
  });
  Object.assign(firstAfter,{pidProbes:probeCalls.pid,identityProbes:probeCalls.identity});
  probeCalls.pid=0;probeCalls.identity=0;
  const after=await measure(async()=>{
    const flows=await readHistoryProjection(historyHeadlessFlows,{filename,collections:["flows"]});
    const roundRows=flows.reduce((sum,flow)=>sum+flow.rounds.length,0);
    const paths=activeHeadlessTranscriptPaths(flows,registry,probe,true);
    return {roundRows,paths:paths.size};
  });
  Object.assign(after,{pidProbes:probeCalls.pid,identityProbes:probeCalls.identity});
  if(before.result.paths!==firstAfter.result.paths||firstAfter.result.paths!==after.result.paths) throw new Error("liveness path results differ across legacy and projected reads");
  summaries.before=before;summaries.afterFirst=firstAfter;summaries.after=after;
} else {
  const legacy=await measure(()=>{
    const records=readLegacyRows(["pipelines","pipelines_archive"],isStoredPipeline);
    let count=0;
    for(const pipeline of records) if(pipeline.project===project) for(const run of pipeline.runs) for(const attempt of run.attempts) {
      const at=Date.parse(attempt.startedAt??"");
      if(Number.isFinite(at)&&at<=now&&now-at<=windowMs) count++;
    }
    return count;
  });
  const projected=await measure(()=>readHistoryProjection(database=>historyAttemptCounts(database,project,now),{filename,collections:["pipelines","pipelines_archive"]}));
  const projectedCount=Object.values(projected.result).reduce((sum,count)=>sum+count,0);
  if(legacy.result!==projectedCount) throw new Error("legacy and projected counts differ");
  summaries.before=legacy;summaries.after={...projected,result:projectedCount};
}

const result={operation,sourceSha256:sourceHash,sourceRows:dimensions.rows,sourceJsonBytes:dimensions.bytes,
  transitionedRows:targetRows,now:new Date(now).toISOString(),results:summaries,probeCalls};
const resultFile=process.env.MEASURE_RESULT_FILE;
if(!resultFile) throw new Error("MEASURE_RESULT_FILE must name an isolated output file");
fs.writeFileSync(resultFile,JSON.stringify(result,null,2),{mode:0o600});
db.close();
