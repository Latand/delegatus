import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const now = Date.parse("2026-10-18T12:00:00Z");
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"spend-route-"));
const previous = new Map<string,string | undefined>();
for (const key of ["HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","LLV_STATE_DIR","TMPDIR"]) {
  previous.set(key,process.env[key]); process.env[key]=path.join(sandbox,key); fs.mkdirSync(process.env[key]!,{recursive:true});
}
let NextRequest: typeof import("next/server").NextRequest;
let GET: typeof import("./route").GET;
let ActivityStore: typeof import("@/lib/activity/store").ActivityStore;
let saveTasks: typeof import("@/lib/tasks/store").saveTasks;
let teamStore: typeof import("@/lib/team/store").teamStore;
let resetTeamStoreForTests: typeof import("@/lib/team/store").resetTeamStoreForTests;
let mintSession: typeof import("@/lib/team/sessions").mintSession;
beforeEach(async()=>{
  setSystemTime(now);
  ({NextRequest}=await import("next/server"));
  ({GET}=await import("./route"));
  ({ActivityStore}=await import("@/lib/activity/store"));
  ({saveTasks}=await import("@/lib/tasks/store"));
  ({teamStore,resetTeamStoreForTests}=await import("@/lib/team/store"));
  ({mintSession}=await import("@/lib/team/sessions"));
  resetTeamStoreForTests();
  for (const file of ["team/team.sqlite","team/team.sqlite-wal","team/team.sqlite-shm","activity/records.sqlite","activity/records.sqlite-wal","activity/records.sqlite-shm"])
    fs.rmSync(path.join(sandbox,"LLV_STATE_DIR",file),{force:true});
  saveTasks([]);
});
import type { BoardTask } from "@/lib/tasks/types";
const task = (id:string):BoardTask => ({id,project:"fixture",placement:"unplaced",text:"Fixture",status:"inbox",createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),assignments:[]});
afterAll(()=>{ resetTeamStoreForTests(); setSystemTime(); for(const [key,value] of previous) { if(value===undefined) delete process.env[key]; else process.env[key]=value; } fs.rmSync(sandbox,{recursive:true,force:true}); });
const get = (ids:string,headers:Record<string,string>={})=>GET(new NextRequest(`http://127.0.0.1/api/task-spend?ids=${encodeURIComponent(ids)}`,{headers:{host:"127.0.0.1",...headers}}));
test("same-origin guard runs before reads; absent and pre-migration stores answer an uncached bootstrap",async()=>{
  expect((await get("a",{origin:"https://evil.example","sec-fetch-site":"cross-site"})).status).toBe(403);
  const response=await get("a"); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).tasks).toEqual({});
  const store=ActivityStore.open(); store.db.exec("DROP TABLE task_limit_spend"); store.close();
  expect((await (await get("a")).json()).tasks).toEqual({});
});
test("the route caps unique ids at 400 and keeps known empty tasks",async()=>{
  const tasks=Array.from({length:401},(_,i)=>task(`task-${i}`)); saveTasks(tasks);
  const store=ActivityStore.open(); store.close();
  const body=await (await get([tasks[0]!.id,...tasks.map(t=>t.id)].join(","))).json();
  expect(Object.keys(body.tasks)).toHaveLength(400); expect(body.tasks["task-0"]).toEqual({providers:[]}); expect(body.tasks["task-400"]).toBeUndefined();
});
test("owners see account details and members see provider headlines only",async()=>{
  const team=teamStore();
  const cookies:string[]=[];
  for(const [id,role] of [["m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","owner"],["m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","member"]] as const) {
    team.insertMember({id,role,name:role,status:"active",color:"teal",telegram:null,createdAt:new Date(now).toISOString(),createdBy:"claim",revokedAt:null});
    cookies.push(mintSession(team,id,"claim",{surface:"desktop",browser:"chrome"},now).value);
  }
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const workspaceId = `w_${"c".repeat(32)}`;
  createWorkspace(team, team.owner()!, { id: workspaceId, name: "Spend fixture", projects: ["fixture"] });
  team.putWorkspaceMember(workspaceId, "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "member", team.owner()!.id, new Date(now).toISOString());
  saveTasks([task("a")]); const store=ActivityStore.open();
  store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("a","codex:a","codex",1000,0,10,10,4,null,null,null,null,1,2,null,now);
  store.db.query("INSERT INTO task_limit_spend VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("a","claude:a","claude",2000,0,10,10,6,null,null,null,null,1,2,null,now); store.close();
  const owner=await (await get("a",{cookie:`llv_member=${cookies[0]}`})).json();
  expect(owner.tasks.a.providers.map((p:{engine:string})=>p.engine)).toEqual(["claude","codex"]);
  expect(owner.tasks.a.providers[0].accounts).toHaveLength(1);
  const member=await (await get("a",{cookie:`llv_member=${cookies[1]}`})).json();
  expect(member.tasks.a.providers[0].accounts).toBeNull(); expect(JSON.stringify(member)).not.toContain('"key"');
});
test("an unreadable store gives a generic failure with no private paths",async()=>{
  const state=process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR=path.join(sandbox,"corrupt");
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR,"activity"),{recursive:true});
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR,"activity","records.sqlite"),"invalid fixture database");
  try { const response=await get("a"); expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.text()).not.toContain(sandbox); }
  finally { process.env.LLV_STATE_DIR=state; }
});
