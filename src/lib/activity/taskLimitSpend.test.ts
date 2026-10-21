import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityStore, conversationDigest, type TurnOwner } from "./store";
import { commitUsage, DAY, HOUR, maintainUsage } from "./tokenStore";
import { usageRecord, USAGE_NOW } from "./tokenUsage.fixture";
import { refreshTaskLimitSpend, readTaskLimitSpend, TASK_SPEND_DUE_SQL, type SpendDependencies } from "./taskLimitSpend";
import type { BoardTask } from "@/lib/tasks/types";

let root: string, store: ActivityStore;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "task-spend-")); store = ActivityStore.open(path.join(root, "records.sqlite")); });
afterEach(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
const owner: TurnOwner = { conversation: "work", project: "fixture", engine: "claude", role: "builder", pipelineId: null, stageId: null };
function commit(id: string, overrides: Partial<TurnOwner> = {}) {
  store.transaction(() => commitUsage(store.db, { owner: { ...owner, ...overrides }, records: [usageRecord(id)],
    attribution: () => ({ account: "claude:a", member: "unknown", model: null, tier: null }), malformed: 0, now: USAGE_NOW }));
}
test("token commits dirty exactly their owner, exclude the seat, and ignore replayed records", () => {
  commit("lane", { pipelineId: "lane" }); commit("chat"); commit("seat", { role: "orchestrator" });
  const dirty = () => store.db.query("SELECT key, at FROM limit_spend_dirty ORDER BY key").all();
  expect(dirty()).toEqual([{ key: `c:${conversationDigest("work")}`, at: USAGE_NOW }, { key: "p:lane", at: USAGE_NOW }]);
  store.db.exec("DELETE FROM limit_spend_dirty"); commit("lane", { pipelineId: "lane" }); expect(dirty()).toEqual([]);
});

const task = (id: string, conversations: string[] = []): BoardTask => ({ id, project: "fixture", placement: "unplaced", text: "Fixture", status: "assigned",
  createdAt: new Date(USAGE_NOW - 2 * 86400000).toISOString(), updatedAt: new Date(USAGE_NOW).toISOString(),
  assignments: conversations.map(conversationId => ({ conversationId, path: null, panePid: null, state: "delivered", error: null, at: new Date(USAGE_NOW).toISOString() })) });
function world(tasks: BoardTask[], lanes: Record<string, string[]> = {}): SpendDependencies {
  return { now: () => USAGE_NOW, tasks: ids => tasks.filter(t => ids.has(t.id)),
    source: () => ({ revision: () => 1, get: id => tasks.find(t => t.id === id) ?? null,
      keyRange: (after, _through, limit) => tasks.filter(t => `t:${t.id}` > after).sort((a,b) => a.id.localeCompare(b.id)).slice(0, limit),
      changesAfter: () => ({ revision: 1, changeFloor: 0, entries: [] }), parse: json => JSON.parse(json) }),
    pipelineTasks: id => lanes[id] ?? [],
    pipelineSource: () => ({ revision: () => 1, parse: json => JSON.parse(json),
      changesAfter: () => ({ revision: 1, changeFloor: 0, entries: [] }) }),
    observations: () => new Map(), labels: () => new Map(), history: () => ({ series: {} }) };
}
test("refresh seeds lane and standalone ownership without counting a linked lane twice or including the seat", async () => {
  const deps = world([task("a", ["work", "chat", "seat", "foreign"])], { lane: ["a"] });
  commit("lane", { pipelineId: "lane" }); commit("standalone", { conversation: "chat" }); commit("seat", { conversation: "seat", role: "orchestrator" });
  commit("foreign", { conversation: "foreign", pipelineId: "other" });
  for (let i = 0; i < 4; i++) await refreshTaskLimitSpend(store, deps);
  const result = readTaskLimitSpend(store.db, ["a"], { canChoose: true }, deps);
  expect(result.tasks.a!.providers).toHaveLength(1);
  expect(result.tasks.a!.providers[0]).toMatchObject({ engine: "claude", tokens: 240, bound: "norate" });
  const writes = store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  await refreshTaskLimitSpend(store, deps);
  expect(store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(writes);
});

test("owner queries use their indexes for singleton and multiple owners without scanning hour history", async () => {
  const { ownerHoursSql } = await import("./taskLimitSpend");
  for (const owner of ["p:lane", `c:${conversationDigest("work")}`]) {
    const query = ownerHoursSql(owner,null,1000);
    const plan = JSON.stringify(store.db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.binds));
    expect(plan).toContain(owner.startsWith("p:") ? "usage_hours_pipeline" : "usage_hours_conversation");
    expect(plan).not.toContain("SCAN usage_hours");
  }
});

test("rated, partial, unpriced and unattributed rows retain their bound and window evidence", async () => {
  const { computeTaskRows } = await import("./taskLimitSpend");
  const { HOUR, DAY } = await import("./tokenStore");
  const now = USAGE_NOW, hour = Math.floor(now/HOUR)-1;
  const observations = new Map([["claude:a", { session: { usedPercent: 60,resetsAt: now/1000+3600 },
    weekly: { usedPercent: 40,resetsAt: now/1000+DAY/1000 },plan: "max",capturedAt: now/1000 }]]);
  const day = new Date(hour*HOUR).toISOString().slice(0,10);
  const rates = (["weekly","session"] as const).map(window => ({ account: "claude:a",window,day,rate: window === "weekly" ? 2 : 5,
    rise: 10,weight: 5,source: "own" as const,plan: "max",frozen: 0,computed_at: now }));
  const h = { hour,conversation: "d",model: "claude-sonnet-5",tier: "standard",account: "claude:a",engine: "claude",pipeline: null,role: "builder",
    requests: 1,input: 1000000,cache_read: 0,cache_write: 0,cache_write_1h: 0,output: 0,reasoning: 0 };
  const rows = computeTaskRows(task("a"),[h,{ ...h,model: "unpriced" },{ ...h,account: "unknown" }],rates,observations,now-3*DAY,now);
  const a = rows.find(r=>r.account==="claude:a")!;
  expect(a).toMatchObject({ tokens: 2000000,weekly_pp: 4,window_pp: 4,session_pp: 10,unpriced_tokens: 1000000,floor: null });
  const put = store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) put.run(r.task,r.account,r.engine,r.tokens,r.unpriced_tokens,r.weight,r.rated_weight,r.weekly_pp,r.window_start,r.window_pp,r.session_start,r.session_pp,r.first_hour,r.last_hour,r.floor,now);
  const deps = { ...world([task("a")]),observations: () => observations };
  expect(readTaskLimitSpend(store.db,["a"],{ canChoose: true },deps).tasks.a!.providers[0]).toMatchObject({ bound: "floor",floor: "uncounted",weeklyPp: 4 });
  expect(readTaskLimitSpend(store.db,["a"],{ canChoose: false },deps).tasks.a!.providers[0]!.accounts).toBeNull();
  expect(computeTaskRows(task("a"),[h],rates,observations,now,now)[0]!.floor).toBe("before-counting");
});

test("pipeline binding changes remap old and new tasks without another token write", async () => {
  const tasks = [task("a"),task("b")], lanes = { lane: ["a"] };
  const deps = world(tasks,lanes);
  commit("lane", { pipelineId: "lane" });
  for (let i=0;i<4;i++) await refreshTaskLimitSpend(store,deps);
  expect(readTaskLimitSpend(store.db,["a","b"],{canChoose:true},deps).tasks.a!.providers).toHaveLength(1);
  lanes.lane = ["b"];
  let revision=1;
  deps.pipelineSource=()=>({revision:()=>revision,parse:json=>JSON.parse(json),
    changesAfter:(from:number)=>({revision,changeFloor:0,entries:from<revision?[{revision,key:"lane",operation:"upsert" as const,valueJson:"{}",rowRevision:revision}]:[]})});
  // Install the initial cursor, then change only pipeline membership.
  await refreshTaskLimitSpend(store,deps);
  revision=2;
  await refreshTaskLimitSpend(store,deps);
  const response = readTaskLimitSpend(store.db,["a","b"],{canChoose:true},deps);
  expect(response.tasks.a!.providers).toEqual([]); expect(response.tasks.b!.providers[0]!.tokens).toBe(120);
});

test("deleting a task removes its spend and owner mappings", async () => {
  const tasks=[task("b")],deps=world(tasks,{lane:["b"]});
  commit("lane",{pipelineId:"lane"});
  for(let i=0;i<4;i++) await refreshTaskLimitSpend(store,deps);
  tasks.pop(); store.db.query("INSERT INTO limit_spend_dirty VALUES(?,?)").run("t:b",USAGE_NOW+1);
  await refreshTaskLimitSpend(store,deps);
  expect(store.db.query("SELECT * FROM task_limit_spend WHERE task='b'").all()).toEqual([]);
  expect(store.db.query("SELECT * FROM task_spend_owners WHERE task='b'").all()).toEqual([]);
});

test("seed pages resume after reopening the store and never exceed 200 tasks or 100 recomputations", async () => {
  const tasks = Array.from({length:405},(_,i)=>task(String(i).padStart(3,"0")));
  const deps = world(tasks);
  const first = await refreshTaskLimitSpend(store,deps);
  expect(first.tasks).toBeLessThanOrEqual(100);
  expect(store.db.query<{seed:string},[]>("SELECT seed FROM limit_spend_meta").get()!.seed).toBe("tasks:t:199");
  store.close(); store = ActivityStore.open(path.join(root,"records.sqlite"));
  await refreshTaskLimitSpend(store,deps);
  expect(store.db.query<{seed:string},[]>("SELECT seed FROM limit_spend_meta").get()!.seed).toBe("tasks:t:399");
  for (let i=0;i<6;i++) await refreshTaskLimitSpend(store,deps);
  expect(store.db.query("SELECT * FROM limit_spend_dirty").all()).toEqual([]);
  const src = deps.source()!;
  deps.source = () => ({...src,revision:()=>10,changesAfter:()=>({revision:10,changeFloor:5,entries:[]})});
  await refreshTaskLimitSpend(store,deps);
  expect(store.db.query<{seed:string},[]>("SELECT seed FROM limit_spend_meta").get()!.seed).toBe("tasks:");
});

test("task feed edits replace conversation assignments and a log deletion removes the projection", async () => {
  const tasks = [task("a",["work"])], deps = world(tasks);
  commit("first"); for(let i=0;i<4;i++) await refreshTaskLimitSpend(store,deps);
  const src=deps.source()!;
  tasks[0]=task("a",["replacement"]);
  deps.source=()=>({...src,revision:()=>2,changesAfter:()=>({revision:2,changeFloor:0,entries:[{revision:2,key:"t:a",operation:"upsert",valueJson:JSON.stringify(tasks[0]),rowRevision:2}]})});
  await refreshTaskLimitSpend(store,deps);
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers).toEqual([]);
  deps.source=()=>({...src,revision:()=>3,changesAfter:()=>({revision:3,changeFloor:0,entries:[{revision:3,key:"t:a",operation:"delete",valueJson:null,rowRevision:null}]})});
  await refreshTaskLimitSpend(store,deps);
  expect(store.db.query("SELECT * FROM task_spend_owners").all()).toEqual([]);
});


test("the 50k row budget resumes a large task in a new process without publishing a partial total", async () => {
  const now=USAGE_NOW, hour=Math.floor(now/3600000)-1;
  store.transaction(()=>{
    store.db.query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<50001)
      INSERT INTO usage_hours SELECT '',?, 'conversation', 'model-'||i,'standard','claude:a','claude',NULL,'builder','operator','lane',NULL,1,1,0,0,0,0,0 FROM n`).run(hour);
  });
  const tasks=[task("a")],deps=world(tasks,{lane:["a"]});
  // Seed task owners, then the pipeline page makes this task eligible.
  await refreshTaskLimitSpend(store,deps);
  const first=await refreshTaskLimitSpend(store,deps);
  expect(first.rows).toBe(50000); expect(first.tasks).toBe(0);
  expect(store.db.query("SELECT * FROM task_limit_spend").all()).toEqual([]);
  expect(store.db.query("SELECT * FROM task_spend_progress").all()).toHaveLength(1);
  store.close();
  const script=`import { ActivityStore } from ${JSON.stringify(new URL("./store.ts",import.meta.url).href)};
    import { refreshTaskLimitSpend } from ${JSON.stringify(new URL("./taskLimitSpend.ts",import.meta.url).href)};
    const tasks=${JSON.stringify(tasks)}, store=ActivityStore.open(process.argv[1]);
    const result=await refreshTaskLimitSpend(store,{now:()=>${now},source:()=>null,tasks:ids=>tasks.filter(t=>ids.has(t.id)),pipelineTasks:()=>['a'],observations:()=>new Map(),labels:()=>new Map(),history:()=>({series:{}})});
    console.log(JSON.stringify(result));store.close();`;
  const child=Bun.spawn([process.execPath,"-e",script,path.join(root,"records.sqlite")],{stdout:"pipe",stderr:"pipe"});
  const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(await child.exited,err).toBe(0); expect(JSON.parse(out).rows).toBe(1);
  store=ActivityStore.open(path.join(root,"records.sqlite"));
  expect(store.db.query<{tokens:number},[]>("SELECT tokens FROM task_limit_spend").get()!.tokens).toBe(50001);
  expect(store.db.query("SELECT * FROM task_spend_progress").all()).toEqual([]);
});

test("a held SQLite writer defers asynchronously and the pass recovers after release",async()=>{
  const { Database }=await import("bun:sqlite");
  const { stateLockWaitsInFlight }=await import("@/lib/state/lockWait");
  const peer=new Database(path.join(root,"records.sqlite"));peer.exec("BEGIN IMMEDIATE");
  const refresh=refreshTaskLimitSpend(store,world([task("a")]));
  try {
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(stateLockWaitsInFlight().some(w=>w.callSite==="activity.transaction")).toBe(true);
  } finally {peer.exec("ROLLBACK");peer.close();}
  await refresh;
  expect(store.db.query<{seed:string},[]>("SELECT seed FROM limit_spend_meta").get()!.seed).toBe("lanes:");
});


test("read-time weekly and session starts accept five minutes of jitter and refuse reset or overlapping evidence", () => {
  const now=USAGE_NOW, start=now/1000-10000, session=now/1000-2000;
  const put=store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  put.run("a","claude:a","claude",1000,0,10,10,7,start+299,3,session+299,5,1,Math.floor(now/3600000)-1,null,now);
  let weekly=start, short=session;
  const deps:SpendDependencies={...world([task("a")]),observations:()=>new Map([["claude:a",{session:{usedPercent:20,resetsAt:short+18000},weekly:{usedPercent:40,resetsAt:weekly+604800},plan:"max",capturedAt:now/1000}]])};
  const account=()=>readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers[0]!.accounts![0]!;
  expect(account().week).toEqual({usedPercent:40,taskPp:3});expect(account().sessionPp).toBe(5);
  weekly+=1000;short+=1000;
  expect(account().week!.taskPp).toBeNull();expect(account().sessionPp).toBeNull();
  weekly=now/1000-1000;store.db.query("UPDATE task_limit_spend SET last_hour=?").run(Math.floor(now/3600000)-2);
  expect(account().week!.taskPp).toBe(0);
  short=now/1000-18000;expect(account().sessionPp).toBeNull();
  deps.observations=()=>new Map([["claude:a",{session:null,weekly:{usedPercent:40,resetsAt:null},plan:"max",capturedAt:now/1000}]]);
  expect(account().week).toEqual({usedPercent:40,taskPp:null});
});

test("weekly task spend stays unknown without a usable rate and is zero only before the window", () => {
  const start=USAGE_NOW/1000-3*86400;
  store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("a","claude:a","claude",1_000_000,1_000_000,0,0,null,null,null,null,null,Math.floor(USAGE_NOW/3600000)-1,Math.floor(USAGE_NOW/3600000)-1,null,USAGE_NOW);
  const deps={...world([task("a")]),observations:()=>new Map([["claude:a",{session:null,weekly:{usedPercent:50,resetsAt:USAGE_NOW/1000+4*86400},plan:"max",capturedAt:USAGE_NOW/1000}]])};
  const account=()=>readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers[0]!.accounts![0]!;
  expect(account().week!.taskPp).toBeNull();
  store.db.query("UPDATE task_limit_spend SET last_hour=?").run(Math.floor(start*1000/3600000)-1);
  expect(account().week!.taskPp).toBe(0);
});

test("incomplete token coverage keeps a priced task total at a lower bound until the tail is ingested", async () => {
  const tasks=[task("a",["work"])],deps=world(tasks),hour=Math.floor(USAGE_NOW/HOUR)-1,day=new Date(hour*HOUR).toISOString().slice(0,10);
  const ownerKey=`c:${conversationDigest("work")}`;
  store.transaction(()=>{
    store.db.query("UPDATE usage_meta SET counted_from=?,complete=0,pending_bytes=10000").run(USAGE_NOW-4*DAY);
    store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)")
      .run(hour,conversationDigest("work"),"claude-sonnet-5","standard","claude:a","claude");
    store.db.query("INSERT INTO task_spend_owners VALUES(?,?)").run(ownerKey,"a");
    store.db.query("INSERT INTO limit_spend_dirty VALUES(?,?)").run("t:a",USAGE_NOW);
    store.db.query("INSERT INTO usage_limit_rates VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("claude:a","weekly",day,2,20,10,"own","max",1,USAGE_NOW);
    store.db.query(`UPDATE limit_spend_meta SET seed='done',task_revision=1,task_key='',pipeline_revision=1,pipeline_key='',pipeline_seed='done',
      aggregate_schema=2,rate_schema=3,rates_hour=?`).run(Math.floor(USAGE_NOW/HOUR));
  });
  deps.observations=()=>new Map([["claude:a",{session:null,weekly:{usedPercent:30,resetsAt:USAGE_NOW/1000+7*86400},plan:"max",capturedAt:USAGE_NOW/1000}]]);
  await refreshTaskLimitSpend(store,deps);
  const partial=readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers[0]!;
  expect(partial).toMatchObject({weeklyPp:expect.any(Number),bound:"floor",floor:"uncounted"});
  store.transaction(()=>{
    store.db.query("UPDATE usage_meta SET complete=1,pending_bytes=0 WHERE singleton=1").run();
    store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)")
      .run(hour+1,conversationDigest("work"),"claude-sonnet-5","standard","claude:a","claude");
    store.db.query("INSERT INTO limit_spend_dirty VALUES(?,?) ON CONFLICT(key) DO UPDATE SET at=at+1").run(ownerKey,USAGE_NOW+1);
  });
  await refreshTaskLimitSpend(store,deps);
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers[0]).toMatchObject({bound:"approx",floor:null});
});

test("a finalized task retains its persisted spend after hourly retention and an unrelated rate change", async () => {
  const oldHour=Math.floor((USAGE_NOW-91*DAY)/HOUR), now=USAGE_NOW+3*DAY, currentHour=Math.floor(now/HOUR);
  const oldTask={...task("old"),createdAt:new Date(USAGE_NOW-95*DAY).toISOString()};
  const deps=world([oldTask]); deps.now=()=>now;
  const row=store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  row.run("old","claude:a","claude",1_000_000,0,2,2,4,null,null,null,null,oldHour,oldHour,null,USAGE_NOW);
  const ownerKey=`c:${conversationDigest("work")}`;
  store.db.query("INSERT INTO task_spend_owners VALUES(?,?)").run(ownerKey,"old");
  store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)")
    .run(oldHour,"expired","claude-sonnet-5","standard","claude:a","claude");
  store.db.query(`UPDATE limit_spend_meta SET seed='done',task_revision=1,task_key='',pipeline_revision=1,pipeline_key='',pipeline_seed='done',
    aggregate_schema=2,rate_schema=3,rates_hour=?`).run(currentHour);
  store.db.query("INSERT INTO limit_spend_rate_changes VALUES(?,?, '')").run("claude:a",new Date(now).toISOString().slice(0,10));
  store.transaction(()=>maintainUsage(store.db,now,"Europe/Kyiv"));
  expect(store.db.query("SELECT * FROM usage_hours WHERE conversation='expired'").all()).toEqual([]);
  await refreshTaskLimitSpend(store,deps);
  const provider=readTaskLimitSpend(store.db,["old"],{canChoose:true},deps).tasks.old!.providers[0]!;
  expect(provider).toMatchObject({weeklyPp:4,tokens:1_000_000,bound:"approx"});
  expect(store.db.query("SELECT * FROM limit_spend_rate_changes").all()).toEqual([]);
  const day=new Date(currentHour*HOUR).toISOString().slice(0,10);
  store.db.query("INSERT INTO usage_limit_rates VALUES(?,?,?,?,?,?,?,?,?,?)").run("claude:a","weekly",day,2,20,10,"own","max",1,now);
  store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)")
    .run(currentHour,conversationDigest("work"),"claude-sonnet-5","standard","claude:a","claude");
  store.db.query("INSERT INTO limit_spend_dirty VALUES(?,?)").run(ownerKey,now+1);
  await refreshTaskLimitSpend(store,deps);
  const afterNewUsage=readTaskLimitSpend(store.db,["old"],{canChoose:true},deps).tasks.old!.providers[0]!;
  expect(afterNewUsage.tokens).toBe(2_000_000);
  expect(afterNewUsage.weeklyPp).toBeGreaterThan(4);
});

test("legacy aggregate rows stay hidden until bounded migration replaces unsupported window zeroes", async () => {
  const tasks=[task("a")],deps=world(tasks);
  commit("legacy");
  store.db.query("INSERT INTO task_spend_owners VALUES(?,?)").run(`c:${conversationDigest("work")}`,"a");
  store.db.query("DELETE FROM limit_spend_dirty");
  store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("a","claude:a","claude",120,120,0,0,null,USAGE_NOW/1000-1000,0,null,null,Math.floor(USAGE_NOW/3600000),Math.floor(USAGE_NOW/3600000),null,USAGE_NOW);
  store.db.query("UPDATE limit_spend_meta SET aggregate_schema=1,aggregate_cursor='',seed='done',task_revision=1,task_key='',pipeline_revision=1,pipeline_seed='done',rates_hour=?")
    .run(Math.floor(USAGE_NOW/3600000));
  const depsWithWindow={...deps,observations:()=>new Map([["claude:a",{session:null,weekly:{usedPercent:50,resetsAt:USAGE_NOW/1000+6*86400},plan:"max",capturedAt:USAGE_NOW/1000}]])};
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},depsWithWindow).tasks).toEqual({});
  await refreshTaskLimitSpend(store,depsWithWindow);
  expect(store.db.query<{aggregate_schema:number},[]>("SELECT aggregate_schema FROM limit_spend_meta").get()!.aggregate_schema).toBe(2);
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},depsWithWindow).tasks.a!.providers[0]!.accounts![0]!.week!.taskPp).toBeNull();
});


test("a failed rate refresh retries durably without advancing its hourly gate",async()=>{
  const deps=world([task("a",["work"])]);
  deps.history=()=>{throw new Error("fixture history unavailable");};
  await expect(refreshTaskLimitSpend(store,deps)).rejects.toThrow("fixture history unavailable");
  expect(store.db.query<{rates_hour:number},[]>("SELECT rates_hour FROM limit_spend_meta").get()!.rates_hour).toBe(-1);
  deps.history=()=>({series:{}}); await refreshTaskLimitSpend(store,deps);
  expect(store.db.query<{rates_hour:number},[]>("SELECT rates_hour FROM limit_spend_meta").get()!.rates_hour).toBe(Math.floor(USAGE_NOW/3600000));
});

test("new owner usage after computation is kept dirty and cannot publish the stale total",async()=>{
  const tasks=[task("a",["work"])],deps=world(tasks);
  commit("initial"); for(let i=0;i<4;i++) await refreshTaskLimitSpend(store,deps);
  commit("next");
  let reads=0;
  deps.tasks=ids=>{if(++reads===2)commit("late");return tasks.filter(t=>ids.has(t.id));};
  await refreshTaskLimitSpend(store,deps);
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},world(tasks)).tasks.a!.providers[0]!.tokens).toBe(120);
  expect(store.db.query("SELECT key FROM limit_spend_dirty WHERE key LIKE 't:%'").all()).toHaveLength(1);
  deps.tasks=ids=>tasks.filter(t=>ids.has(t.id));await refreshTaskLimitSpend(store,deps);
  expect(readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers[0]!.tokens).toBe(360);
});


test("finalizing yesterday's rate recomputes tasks that have no usage today",async()=>{
  const hour=3600000,tasks=[task("yesterday",["work"])],deps=world(tasks);
  let now=Date.parse("2026-10-18T00:10:00Z"); deps.now=()=>now;
  commit("yesterday-row");
  store.db.query("UPDATE usage_hours SET model='claude-sonnet-5',hour=?").run(Math.floor(Date.parse("2026-10-17T23:00:00Z")/hour));
  store.db.query("UPDATE usage_meta SET complete=0,pending_bytes=100").run();
  const series={"claude|a|weekly":[{t:Date.parse("2026-10-11T00:00:00Z")/1000,remaining:100},
    {t:Date.parse("2026-10-17T22:00:00Z")/1000,remaining:100},{t:Date.parse("2026-10-17T23:00:00Z")/1000,remaining:80},{t:now/1000,remaining:80}]};
  deps.history=()=>({series}); deps.observations=()=>new Map([["claude:a",{session:null,weekly:{usedPercent:30,resetsAt:Date.parse("2026-10-18T00:00:00Z")/1000+7*86400},plan:"max",capturedAt:now/1000}]]);
  for(let i=0;i<5;i++) await refreshTaskLimitSpend(store,deps);
  const before=store.db.query<{weekly_pp:number},[]>("SELECT weekly_pp FROM task_limit_spend WHERE task='yesterday'").get()!.weekly_pp;
  now+=hour;
  store.db.query("UPDATE usage_meta SET complete=1,pending_bytes=0").run();
  series["claude|a|weekly"].push({t:Date.parse("2026-10-17T23:30:00Z")/1000,remaining:60});
  await refreshTaskLimitSpend(store,deps);
  const after=store.db.query<{weekly_pp:number},[]>("SELECT weekly_pp FROM task_limit_spend WHERE task='yesterday'").get()!.weekly_pp;
  expect(after).toBeCloseTo(before*2);
  expect(store.db.query<{frozen:number},[string]>("SELECT frozen FROM usage_limit_rates WHERE account='claude:a' AND window='weekly' AND day=?").get("2026-10-17")!.frozen).toBe(1);
});


test("provider and account order are stable, with rated accounts before unknown rates",()=>{
  const put=store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for(const [account,engine,pp] of [["codex:b","codex",null],["codex:z","codex",2],["codex:a","codex",1],["claude:a","claude",1]] as const) {
    put.run("a",account,engine,100,0,1,pp===null?0:1,pp,null,null,null,null,1,2,null,USAGE_NOW);
  }
  const deps={...world([task("a")]),labels:()=>new Map([["codex:z","Zulu"],["codex:a","Alpha"],["codex:b","Before"]])};
  const providers=readTaskLimitSpend(store.db,["a"],{canChoose:true},deps).tasks.a!.providers;
  expect(providers.map(p=>p.engine)).toEqual(["claude","codex"]);
  expect(providers[1]!.accounts!.map(a=>a.label)).toEqual(["Alpha","Zulu","Before"]);
  expect(providers[1]).toMatchObject({weeklyPp:3,bound:"floor",floor:"uncounted"});
});

test("one pass resolves at most 500 dirty owners and task selection uses its due index",async()=>{
  const deps=world([]);
  for(let i=0;i<3;i++)await refreshTaskLimitSpend(store,deps);
  store.transaction(()=>{for(let i=0;i<501;i++)store.db.query("INSERT INTO limit_spend_dirty VALUES(?,?)").run(`c:${String(i).padStart(4,"0")}`,USAGE_NOW);});
  await refreshTaskLimitSpend(store,deps);
  expect(store.db.query("SELECT key FROM limit_spend_dirty").all()).toEqual([{key:"c:0500"}]);
  const plan=JSON.stringify(store.db.query(`EXPLAIN QUERY PLAN ${TASK_SPEND_DUE_SQL}`).all());
  expect(plan).toContain("limit_spend_dirty_tasks");expect(plan).not.toContain("TEMP B-TREE");
});
