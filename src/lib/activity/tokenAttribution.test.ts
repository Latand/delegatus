import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRegistry, type RegistryFile, type RegistryConversation, type SpawnLineageEdge } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { TeamStore } from "@/lib/team/store";
import { launchMemberResolver, usageAttribution, type LaunchMemberDependencies } from "./tokenAttribution";
import { USAGE_NOW } from "./tokenUsage.fixture";
const id = "conversation_child", parent = "conversation_parent";
const snapshot = () => normalizeRegistry({ version:2,entries:{},receipts:{} });
const emptyDeps: LaunchMemberDependencies = { snapshot:()=>null,started:()=>null,spawnAuthor:()=>null,majority:()=>null,pipeline:()=>null };
test("launch event, spawn author, parent, pipeline creator, task creator and majority have fixed precedence", () => {
  const initial = snapshot();
  initial.lineageEdges[id] = { childConversationId:id,parentConversationId:parent,childSessionKey:null,parentSessionKey:null,childArtifactPath:null,parentArtifactPath:null,
    kind:"spawn",role:null,reviewsConversationId:null,source:"viewer-spawn",evidence:{launchId:null,clientAttemptId:null},createdAt:"2026-10-17T00:00:00Z" };
  initial.memberships[id] = [{ conversationId:id,kind:"pipeline",containerId:"pipeline-a",role:"builder",slot:"build",stageId:"build",stageOrder:0,round:null,parentConversationId:null,createdAt:"2026-10-17T00:00:00Z" }];
  const scenarios: Array<[Partial<LaunchMemberDependencies>,string]> = [
    [{ started:()=>"event",spawnAuthor:()=>"spawn",majority:()=>"majority" },"event"],
    [{ spawnAuthor:()=>"spawn",majority:()=>"majority" },"spawn"],
    [{ started:key=>key===parent?"parent":null,majority:()=>"majority" },"parent"],
    [{ pipeline:()=>({srcConversationId:"conversation_creator",taskIds:["task-a"]}),started:key=>key==="conversation_creator"?"creator":null },"creator"],
    [{ pipeline:()=>({srcConversationId:null,taskIds:["task-a"]}),started:(key,action)=>key==="task-a"&&action==="task.created"?"task":null },"task"],
    [{ majority:key=>key===id?"majority":null },"majority"],
    [{},"unattributed"],
  ];
  for (const [deps,want] of scenarios) expect(launchMemberResolver({...emptyDeps,...deps})(id,initial,"team")).toBe(want);
  expect(launchMemberResolver(emptyDeps)(id,initial,"solo")).toBe("operator");
});
test("a launch chain stops at eight conversations, detects cycles and caches within one pass", () => {
  let reads=0;
  const cyclic = (key:string): RegistryFile => { const s=snapshot(); s.lineageEdges[key]={...snapshotEdge(),childConversationId:key as `conversation_${string}`,parentConversationId:`conversation_${Number(key.split("_")[1]??0)+1}`}; return s; };
  const snapshotEdge=():SpawnLineageEdge=>({childConversationId:id,parentConversationId:parent,childSessionKey:null,parentSessionKey:null,childArtifactPath:null,parentArtifactPath:null,kind:"spawn" as const,
    role:null,reviewsConversationId:null,source:"viewer-spawn" as const,evidence:{launchId:null,clientAttemptId:null},createdAt:"2026-10-17T00:00:00Z"});
  const resolve=launchMemberResolver({...emptyDeps,snapshot:key=>{reads++;return cyclic(key);}});
  expect(resolve("conversation_0",cyclic("conversation_0"),"team")).toBe("unattributed"); expect(reads).toBe(7);
  resolve("conversation_0",cyclic("conversation_0"),"team"); expect(reads).toBe(7);
  const cycle=snapshot(); cycle.lineageEdges[id]={...snapshotEdge(),parentConversationId:id};
  let cycleReads=0;
  expect(launchMemberResolver({...emptyDeps,snapshot:()=>{cycleReads++;return cycle;}})(id,cycle,"team")).toBe("unattributed");
  expect(cycleReads).toBe(0);
});
test("account selection follows response time across generations, and an unproved path stays unknown", () => {
  const conversation={ generations:[
    {id:"gen-a",path:"/missing/fixture.jsonl",accountId:"account-a",launchProfile:emptyLaunchProfile({model:"model-a"}),historyHash:null,host:null,createdAt:"2026-10-17T00:00:00Z",archivedAt:null},
    {id:"gen-b",path:"/missing/fixture.jsonl",accountId:"account-b",launchProfile:emptyLaunchProfile({model:"model-b",serviceTier:"priority"}),historyHash:null,host:null,createdAt:"2026-10-18T00:00:00Z",archivedAt:null},
  ],continuityPaths:[] } as unknown as RegistryConversation;
  const facts={path:"/missing/fixture.jsonl",engine:"codex" as const,cwd:null,entrypoint:null,sessionMeta:null};
  const attr=usageAttribution(facts,conversation,"member-a");
  expect(attr(USAGE_NOW-86400000)).toMatchObject({account:"codex:account-a",model:"model-a",member:"member-a"});
  expect(attr(USAGE_NOW)).toMatchObject({account:"codex:account-b",model:"model-b",tier:"priority"});
  expect(usageAttribution({...facts,path:"/missing/subagent.jsonl"},conversation,"member-a")(USAGE_NOW))
    .toMatchObject({account:"unknown",model:"model-b",tier:"priority"});
  expect(usageAttribution({...facts,engine:"claude"},null,"unattributed")(USAGE_NOW).account).toBe("unknown");
});
test("both engines' main account \"default\" stores as two accounts", () => {
  const conversation={ generations:[{id:"gen",path:"/missing/fixture.jsonl",accountId:"default",launchProfile:emptyLaunchProfile({model:"model-a"}),historyHash:null,host:null,createdAt:"2026-10-17T00:00:00Z",archivedAt:null}],continuityPaths:[] } as unknown as RegistryConversation;
  const facts={path:"/missing/fixture.jsonl",cwd:null,entrypoint:null,sessionMeta:null};
  const stored=(engine:"claude"|"codex")=>usageAttribution({...facts,engine},conversation,"member-a")(USAGE_NOW).account;
  expect(stored("claude")).toBe("claude:default"); expect(stored("codex")).toBe("codex:default");
});
let root:string;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),"token-authorship-"));});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
test("the real majority query is scoped, deterministic on ties, and handles missing authors", () => {
  const store=new TeamStore(path.join(root,"team.sqlite"));
  try {
    for (const [i,memberId] of ["member-b","member-a","member-a","member-b"].entries()) store.recordMessageAuthor({clientMessageId:`message-${i}`,conversationId:id,memberId,at:"2026-10-17T00:00:00Z",textDigest:null});
    store.recordMessageAuthor({clientMessageId:"peer",conversationId:parent,memberId:"peer",at:"2026-10-17T00:00:00Z",textDigest:null});
    expect(store.majorityMessageAuthor(id)).toBe("member-a"); expect(store.majorityMessageAuthor("missing")).toBeNull();
  } finally {store.close();}
});
