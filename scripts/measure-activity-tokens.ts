/** Run only in an isolated export, with an inventory and VACUUM INTO copy.
 * Writes aggregate measurements only; transcript bodies and identities stay private. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ActivityStore } from "../src/lib/activity/store";
import { ingestTranscripts, type IngestSource } from "../src/lib/activity/ingest";

const options = new Map<string, string>();
for (let i=2;i<process.argv.length;i+=2) options.set(process.argv[i]!, process.argv[i+1]!);
const mode = options.get("--mode") ?? "ingest";
const output = options.get("--output")!;
const root = path.dirname(output);
fs.mkdirSync(root, { recursive: true });
const samples = Number(options.get("--samples") ?? 3);
const now = Date.parse("2026-10-18T12:00:00Z");
if (mode === "ingest" || mode === "backfill") {
  const sources = JSON.parse(fs.readFileSync(options.get("--inventory")!, "utf8")) as IngestSource[];
  const runs = [];
  for (let run=0;run<samples;run++) {
    const file = path.join(root, `${mode}-${run}.sqlite`);
    fs.copyFileSync(options.get("--seed")!, file);
    const store = ActivityStore.open(file);
    if (mode === "backfill") {
      for (const source of sources) store.commitFile(source.path, { offset: source.size, size: source.size, mtimeMs: source.mtimeMs,
        facts: { engine: source.engine as "claude" | "codex", cwd: null, entrypoint: null, sessionMeta: null }, prompted: true }, [], {}, null);
    }
    let previous=performance.now(), maxLoopGapMs=0;
    const timer=setInterval(() => { const at=performance.now(); maxLoopGapMs=Math.max(maxLoopGapMs, at-previous-10); previous=at; }, 10);
    const started=performance.now();
    const result=await ingestTranscripts(sources, { store, complete:true, listedAt:now, now:()=>now,
      resolver:()=>()=>({ project:"measurement-project", registered:true, launch:"pipeline",
        usageAttribution:()=>({ member:"operator",account:"unknown",model:null,tier:null }) }) });
    const elapsedMs=performance.now()-started;
    await new Promise<void>(resolve=>setImmediate(resolve)); clearInterval(timer);
    const usage=store.db.query("SELECT 1 FROM sqlite_master WHERE name='usage_hours'").get()
      ? store.db.query<{ rows: number; requests: number }, []>("SELECT COUNT(*) AS rows, SUM(requests) AS requests FROM usage_hours").get() : null;
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); store.close();
    if (result.failures.length) throw new Error("ingest measurement failed");
    runs.push({ elapsedMs, maxLoopGapMs, bytesRead:result.bytesRead, filesRead:result.filesRead, turnsRead:result.turnsRead,
      inputsWritten:result.inputsWritten, deferred:result.filesDeferred, usage, databaseBytes:fs.statSync(file).size,
      maxRssKiB:process.resourceUsage().maxRSS });
  }
  fs.writeFileSync(output,JSON.stringify({ mode, revision:options.get("--revision"), files:sources.length,
    sourceBytes:sources.reduce((n,s)=>n+s.size,0), samples:runs },null,2)+"\n");
  process.stdout.write(JSON.stringify(runs)+"\n");
} else if (mode === "capacity") {
  const { shiftDay, weekOfDay }=await import("../src/lib/activity/range");
  const { usagePriceKey, SUM_TOKENS }=await import("../src/lib/activity/tokenStore");
  const file=options.get("--seed")!;
  const store=ActivityStore.open(file);
  try {
    store.transaction(()=>{
      const write=store.db.query(`INSERT OR REPLACE INTO usage_days VALUES('', 'Europe/Kyiv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 100, 800, 100, 40, 200, 50)`);
      for(let day=0;day<760;day++) for(let row=0;row<200;row++) {
        const date=shiftDay("2026-10-18",-day),model=`model-${row%4}`,tier=row%2?"priority":"standard",engine=row%2?"codex":"claude";
        write.run(date,`project-${Math.floor(row/20)}`,`role-${Math.floor(row/4)%5}`,model,tier,`account-${row%3}`,`member-${row%2}`,engine,weekOfDay(date),usagePriceKey(model,tier,engine));
      }
      for(const dimension of ["all","price","model","role","project","member","account","engine"]) {
        const key=dimension==="all"?"'all'":dimension==="price"?"json_array(model,tier,engine)":dimension;
        store.db.query(`INSERT OR REPLACE INTO usage_summaries SELECT host,zone,day,'${dimension}',${key} AS key,
          ${dimension==="price"?"model,tier,engine":"'','',''"},week,${SUM_TOKENS} FROM usage_days GROUP BY host,zone,day,key`).run();
      }
      store.db.query("UPDATE usage_meta SET version=version+1 WHERE singleton=1").run();
    });
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fs.writeFileSync(output,JSON.stringify({days:760,rows:store.db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM usage_days").get()!.n,
      summaryRows:store.db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM usage_summaries").get()!.n,databaseBytes:fs.statSync(file).size},null,2)+"\n");
  } finally {store.close();}
} else if (mode === "read") {
  const { activityTokensResponse }=await import("../src/lib/activity/tokenReport");
  const { activityResponse }=await import("../src/lib/activity/report");
  const { shiftDay }=await import("../src/lib/activity/range");
  const file=options.get("--seed")!;
  const measured: Array<{ dimension:string; days:number; run:number; totalMs:number; cacheMs:number; bytes:number; queries:Array<{ name:string; ms:number }> }>=[];
  const dimensions=options.has("--matrix")?["kind","model","role","project","member","account","engine"]:["kind"];
  for (const dimension of dimensions) for (const days of [7,30,92,366]) for (let run=0;run<samples;run++) {
    const queries: Array<{ name:string; ms:number; plan?:unknown; cpuMs?:number; involuntarySwitches?:number }>=[];
    const params=new URLSearchParams({ from:shiftDay("2026-10-18",1-days),to:"2026-10-18",stack:dimension,list:dimension==="kind"?"model":dimension,tz:"Europe/Kyiv",compare:"previous" });
    for(const [key,value] of new URLSearchParams(options.get("--filter"))) params.set(key,value);
    const deps={ now:()=>now+run*120000, file:()=>file, tz:()=>"Europe/Kyiv", aliases:()=>({}),canonical:(p:string)=>p,
      projectNames:async()=>new Map<string,string>(),roster:()=>[],accounts:()=>new Map<string,string>(),measured:(name:string,ms:number,plan:()=>unknown,scheduling:{cpuMs:number;involuntarySwitches:number})=>queries.push({name,ms,...scheduling,...(run===0?{plan:plan()}: {})}) };
    const start=performance.now(); const body=await activityTokensResponse(params,{mode:"solo",memberId:null,canChoose:true},deps);
    const totalMs=performance.now()-start;
    const warm=performance.now(); await activityTokensResponse(params,{mode:"solo",memberId:null,canChoose:true},deps);
    measured.push({dimension,days,run,totalMs,cacheMs:performance.now()-warm,bytes:Buffer.byteLength(JSON.stringify(body)),queries});
  }
  const time=[];
  for (let run=0;run<samples;run++) {
    const start=performance.now(); const body=await activityResponse(new URLSearchParams("from=2025-10-18&to=2026-10-18&tz=Europe/Kyiv"),{now:()=>now,projectNames:async()=>new Map()});
    time.push({elapsedMs:performance.now()-start,days:body.days.length,bytes:Buffer.byteLength(JSON.stringify(body)),sha256:crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")});
  }
  fs.writeFileSync(output,JSON.stringify({mode,revision:options.get("--revision"),tokens:measured,time},null,2)+"\n");
  process.stdout.write(JSON.stringify({tokens:measured,time})+"\n");
} else throw new Error("unknown measurement mode");
