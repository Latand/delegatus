import { AgentRegistry } from "@/lib/agent/registry";
import fs from "node:fs";
import { initializeStateCollections } from "@/lib/state/sqliteStateStore";
import { statePath } from "@/lib/configDir";
import { loadPipelines, loadArchivedPipelines, pipelineStateCollectionSeeds } from "@/lib/pipelines/store";
import { flowStateCollectionSeed, loadFlows } from "@/lib/flows/store";
import { readHistoryProjection, historyAttemptCounts, historyPipelineRef, historyHeadlessFlows } from "@/lib/state/historyProjection";
import { readAttribution } from "@/lib/readAttribution";
import { Database } from "bun:sqlite";

// The caller supplies a database backup, never a serving state directory.
if (!process.env.LLV_STATE_DIR || !process.argv.includes("--isolated-copy")) throw new Error("requires LLV_STATE_DIR pointing at a private state copy and --isolated-copy");
const mode = process.argv.includes("--legacy") ? "legacy" : "projection";
const admission = process.argv.includes("--admission");
const filename = statePath("state.sqlite");
initializeStateCollections(filename,[...pipelineStateCollectionSeeds(),flowStateCollectionSeed()]);
const db = new Database(filename,{readonly:true});
const project = db.query<{project:string},[]>("SELECT json_extract(value_json,'$.project') AS project FROM state_rows WHERE collection='pipelines' GROUP BY project ORDER BY count(*) DESC LIMIT 1").get()?.project ?? "fixture";
const target = db.query<{id:string|null;path:string|null},[]>(`SELECT json_extract(a.value,'$.conversationId') AS id,json_extract(a.value,'$.agentPath') AS path
 FROM state_rows p,json_each(p.value_json,'$.runs') r,json_each(r.value,'$.attempts') a WHERE p.collection='pipelines'
 AND json_extract(a.value,'$.agentPath') IS NOT NULL LIMIT 1`).get() ?? {id:null,path:null};
const rows = db.query<{n:number;bytes:number},[]>("SELECT count(*) AS n,sum(length(CAST(value_json AS BLOB))) AS bytes FROM state_rows WHERE collection IN ('pipelines','pipelines_archive','flows')").get()!;
db.close();
const registryFile = statePath("agent-registry.sqlite");
const registry = admission ? new AgentRegistry(statePath("agent-registry.json"),undefined,undefined,{sqliteMode:"sqlite",sqliteFilename:registryFile}) : null;
let registryTarget = "conversation_absent";
let registryRows = 0, registryBytes = 0;
if (admission) {
  const raw = new Database(registryFile,{readonly:true});
  const dimensions=raw.query<{n:number;bytes:number},[]>("SELECT count(*) AS n,sum(length(CAST(value_json AS BLOB))) AS bytes FROM registry_rows").get()!;
  registryRows=dimensions.n;registryBytes=dimensions.bytes;
  registryTarget = raw.query<{row_key:string},[]>("SELECT row_key FROM registry_rows WHERE collection='conversations' LIMIT 1").get()?.row_key ?? registryTarget;
  raw.close();
}
const now = Date.parse("2026-10-17T12:00:00.000Z");
function threadCounters() {
  if (process.platform !== "linux") throw new Error("measurement requires Linux per-thread counters");
  const io = fs.readFileSync(`/proc/self/task/${process.pid}/io`,"utf8");
  const sched = fs.readFileSync(`/proc/self/task/${process.pid}/schedstat`,"utf8");
  return {bytes:Number(/^rchar: (\d+)/m.exec(io)![1]),runNs:Number(sched.split(" ")[0])};
}
const measurements = [];
for (let repeat=0;repeat<4;repeat++) {
  readAttribution.clear();
  let lastTick = performance.now(), maxTimerGapMs = 0;
  const timer = setInterval(() => { const at=performance.now(); maxTimerGapMs=Math.max(maxTimerGapMs,at-lastTick-10); lastTick=at; },10);
  const before = threadCounters(), start = performance.now();
  let count = 0;
  if (registry) {
    const snapshot = mode === "legacy" ? registry.readOnlySnapshot() : registry.curatorConversationSnapshot(registryTarget);
    count = snapshot.conversations[registryTarget as `conversation_${string}`] ? 1 : 0;
  } else if (mode === "legacy") {
    const pipelines = loadPipelines();
    const archive = loadArchivedPipelines();
    const flows = loadFlows();
    // The old curator loop and liveness pipeline index each consume all attempts.
    for (const p of [...pipelines,...archive]) if (p.project === project) for (const run of p.runs) for (const a of run.attempts) {
      if (a.startedAt && Date.parse(a.startedAt)<=now && now-Date.parse(a.startedAt)<=30*24*60*60_000) count++;
    }
    for (const p of pipelines) for (const run of p.runs) for (const a of run.attempts) if (!a.historical && (a.conversationId===target.id || a.agentPath===target.path)) void a.state;
    void flows.length;
  } else {
    const result = await readHistoryProjection(database => {
      const counts = historyAttemptCounts(database,project,now);
      void historyPipelineRef(database,target.id,target.path ?? "");
      void historyHeadlessFlows(database);
      return counts;
    });
    count = Object.values(result).reduce((sum,n) => sum+n,0);
  }
  const elapsedMs = performance.now()-start, after = threadCounters();
  await new Promise<void>(resolve=>setTimeout(resolve,15));
  clearInterval(timer);
  measurements.push({repeat,cold:repeat===0,elapsedMs,maxTimerGapMs,mainThreadMs:(after.runNs-before.runNs)/1e6,
    readBytes:after.bytes-before.bytes,decodedJsonBytes:readAttribution.snapshot(elapsedMs).decodedJsonBytes,count});
}
console.log(JSON.stringify({mode,operation:admission ? "curator-registry-admission" : "curator-counts-and-liveness-history",sourceRows:admission ? registryRows : rows.n,sourceBytes:admission ? registryBytes : rows.bytes,now,measurements},null,2));
