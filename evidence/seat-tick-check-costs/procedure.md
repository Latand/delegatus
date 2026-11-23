# Isolated replay procedure

These are the two exact scratch programs used for the recorded measurements.
They are evidence, outside the serving module graph. Run them only from isolated
source exports with dependencies linked, using the repository's
`isolatedEnvironment(createGateSandbox(), checkEnvironment(process.env))`.
That supplies private HOME, XDG roots, TMPDIR and LLV_STATE_DIR, plus the Viewer
control URL on closed port 1. The stage kept programs and source exports inside
its assigned scratch root and saved each command's combined output and exit
status separately. No test was run through a recorded gate.

For the read comparison, save the first program as `probe.ts` in one scratch
folder and run that same absolute program from the base and head exports in
order base/head, head/base, base/head. Its first run creates one shared
`paired-registry.json` beside the program; leave those bytes unchanged for all
six runs. Each process gets fresh isolated state. Source exports were taken
from base `6e8b65d9` and the final source hashes in `measurements.json`.

For the journal comparison, save the second program as `overhead.ts` beside a
`base/` source export. Run it from the head export with fresh isolated state.
Its fixture rings are initialized from each writer's actual output before
measurement. The process names in its output distinguish modules from listeners.

## Read comparison program

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";
const { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } = await import(path.join(process.cwd(),"src/lib/agent/registry"));
const { SqliteAgentRegistryStore } = await import(path.join(process.cwd(),"src/lib/agent/sqliteRegistryStore"));
const { defaultSeatTickSources } = await import(path.join(process.cwd(),"src/lib/monitor/seatTickSources"));
const { defaultSeatTickSettings } = await import(path.join(process.cwd(),"src/lib/monitor/seatTickSettings"));
const { emptySeatTickState } = await import(path.join(process.cwd(),"src/lib/monitor/types"));
const { writeSeatTickState } = await import(path.join(process.cwd(),"src/lib/monitor/seatTickState"));
const curation = await import(path.join(process.cwd(), "src/lib/memory/curation/run.ts"));
const root = process.env.LLV_STATE_DIR!;
const now = Date.parse("2026-11-05T10:00:00Z");
const projects = Array.from({length: 30}, (_,i) => `bench-project-${String(i).padStart(2,"0")}`);
const fixtureFile = path.join(import.meta.dir,"paired-registry.json");
let snapshot;
if(fs.existsSync(fixtureFile)) snapshot=normalizeRegistry(JSON.parse(fs.readFileSync(fixtureFile,"utf8")));
else {
const initial = new AgentRegistry(path.join(root,"seed.json"),()=>false,undefined,{sqliteMode:"off"});
const conversation = initial.ensureConversation("codex", path.join(root,"seat.jsonl"), null);
const sample = initial.holdDelivery(conversation.id,"Check the pending work.","seat-tick:paired:target");
initial.recordDeliveryOutcome(sample.id,"delivered");
for(let i=1;i<30;i++) initial.ensureConversation("codex",path.join(root,`seat-${i}.jsonl`),null);
snapshot = initial.snapshot();
const delivered = snapshot.heldDeliveries[sample.id]!;
snapshot.heldDeliveries = {};
for(let i=0;i<12000;i++) {
 const id=`bench-delivery-${String(i).padStart(6,"0")}`;
 const key=i===11999?"seat-tick:paired:target":`seat-tick:paired:unrelated-${i}`;
 snapshot.heldDeliveries[id]={...structuredClone(delivered),id,clientMessageId:key,text:"x".repeat(1024),command:{...structuredClone(delivered.command),operationId:id}};
}
initial.close(); fs.writeFileSync(fixtureFile,JSON.stringify(snapshot));
}
const conversation={id:Object.keys(snapshot.conversations)[0]};
const sqliteFilename=path.join(root,"registry.sqlite");
const seed = new SqliteAgentRegistryStore(sqliteFilename,{initialSnapshot:snapshot,normalize:normalizeRegistry}); seed.close();
const registry=new AgentRegistry(path.join(root,"registry.json"),()=>false,undefined,{sqliteMode:"sqlite",sqliteFilename});
await registry.prepareRecoveryIndexes(); setAgentRegistryForTests(registry);
const wake={conversationId:conversation.id,clientMessageId:"seat-tick:paired:target",operationId:null} as never;
async function measure(label:string, fn:()=>unknown|Promise<unknown>) {
 const thread=process.threadCpuUsage(); const cpu=process.cpuUsage(),start=performance.now(); const answer=await fn(); const wallMs=performance.now()-start,used=process.cpuUsage(cpu);
 const t=process.threadCpuUsage(thread); return {label,wallMs,cpuMs:(used.user+used.system)/1000,threadCpuMs:(t.user+t.system)/1000,answer};
}
const delivery=[];
for(let i=0;i<6;i++) delivery.push(await measure(i===0?"cold":"warm",()=>defaultSeatTickSources().withdrawWake(wake,"fixture only")));
const seats=new Map();
for(const [i,project] of projects.entries()) {
 seats.set(project,{conversationId:Object.keys(snapshot.conversations)[i],seatEpoch:i+1,designatedAt:new Date(now-86400000).toISOString(),path:null});
 writeSeatTickState(project,{...emptySeatTickState(),seatEpoch:i+1,lastWakeAt:new Date(now-1000).toISOString()});
}
let admissions=0;
const sources={...defaultSeatTickSources(),now:()=>now,registry:()=>registry,settings:defaultSeatTickSettings,
 activeSeats:()=>projects,seatFor:(project:string)=>({active:seats.get(project)??null,pending:null,history:[]}) as never,
 liveness:async({conversationId}:{conversationId?:string})=>{admissions++;return [{conversationId,host:{state:"alive",pid:process.pid,kind:"structured"},lifecycle:"waiting",reason:"host_alive_turn_idle"}] as never;},
 latestDeployment:()=>({state:"ok" as const,value:null}),pipelines:()=>[],tasks:()=>[]};
const curators=[];
for(let i=0;i<4;i++) {
 admissions=0;
 const controller=curation.productionCurationController(sources);
const owner=(curation as any).curationForSweep?.(controller,projects)??controller;
 const measured=await measure(i===0?"cold-sweep":"warm-sweep",()=>Promise.all(projects.map(project=>owner.launchIfDue({project,now,settings:{...defaultSeatTickSettings(project),enabled:true}} as never))));
 curators.push({...measured,answer:undefined,admissions});
}
console.log(JSON.stringify({process:"isolated Bun process exercising Viewer source modules; no Viewer or runtime-host listener",bun:Bun.version,fixtureHash:createHash("sha256").update(fs.readFileSync(fixtureFile)).digest("hex"),load:os.loadavg(),rows:12000,payloadBytes:1024,projects:30,delivery,curators}));
registry.close(); setAgentRegistryForTests(null);
```

## Journal comparison program

```ts
import fs from "node:fs";
import path from "node:path";
const {SeatTickTimings}=await import(path.join(process.cwd(),"src/lib/monitor/seatTickTiming.ts"));
const {appendSeatTickRecordAsync}=await import(path.join(process.cwd(),"src/lib/monitor/journalStore.ts"));
const {appendSeatTickRecord}=await import(path.join(import.meta.dir,"base/src/lib/monitor/journalStore.ts"));
const record={schemaVersion:1,at:"2026-11-05T10:00:00Z",project:"bench",seatEpoch:1,verdict:"quiet",reasons:[],items:0,deferred:0,eventsThrough:0,delivery:null,detail:"nothing owed"};
function trace(count:number) {
 const timing=new SeatTickTimings(); for(let i=0;i<count;i++) timing.begin("check.sources.registry")(); return timing.snapshot();
}
async function measure(fn:()=>unknown,n:number) {const thread=process.threadCpuUsage(),cpu=process.cpuUsage(),start=performance.now();for(let i=0;i<n;i++)await fn();const used=process.cpuUsage(cpu),t=process.threadCpuUsage(thread);return {wallMs:(performance.now()-start)/n,cpuMs:(used.user+used.system)/1000/n,threadCpuMs:(t.user+t.system)/1000/n};}
const results=[];
for(const count of [100,512]) {
 const timing=trace(count); const rich={...record,timing};
 const plainFile=path.join(process.env.LLV_STATE_DIR!,"plain-"+count+".ndjson"),richFile=path.join(process.env.LLV_STATE_DIR!,"rich-"+count+".ndjson");
 fs.mkdirSync(path.dirname(plainFile),{recursive:true});
 for(const [file,row]of [[plainFile,record],[richFile,rich]] as const) {
  await (file===plainFile?appendSeatTickRecord:appendSeatTickRecordAsync)(row as never,file); const line=fs.readFileSync(file,"utf8"); fs.writeFileSync(file,line.repeat(500));
  const directory=file+".projects";fs.mkdirSync(directory,{recursive:true});
  const {createHash}=await import("node:crypto");fs.writeFileSync(path.join(directory,createHash("sha256").update("bench").digest("hex")+".ndjson"),line.repeat(500));
 }
 const pairs=[];for(let i=0;i<6;i++) {const order=i%2?["rich","plain"]:["plain","rich"];const p:any={order};for(const mode of order)p[mode]=await measure(()=>(mode==="plain"?appendSeatTickRecord:appendSeatTickRecordAsync)((mode==="plain"?record:rich) as never,mode==="plain"?plainFile:richFile),20);pairs.push(p);}
 results.push({count,trace:await measure(()=>trace(count),1000),bytes:(fs.statSync(richFile).size-fs.statSync(plainFile).size)/500,pairs});
}
console.log(JSON.stringify({process:"isolated Bun process running Viewer timing and journal modules",results}));
```
