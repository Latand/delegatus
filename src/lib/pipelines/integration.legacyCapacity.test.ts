import { test, expect, harness, loadPipelines, savePipelines, tickPipelines, entry, ORIGIN_MAIN_SHA, type PipelineStageStopResult } from "./engine.fixture";
import { buildPipeline, pipelineRevision } from "./store";
import { startPipelineIntegration, patchPipeline } from "./engine";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord, integrationAttempt } from "./integration";
import { setMergeOnReview } from "@/lib/projects/settings";
import type { Pipeline, PipelineStageAttempt } from "./types";

test.each([
  ...[false, true].flatMap(inverse => [false, true].map(activePeer => ({ inverse, activePeer, batchRelation: "different" }))),
])("legacy and durable resolvers share capacity on resumption (%#)", async ({ activePeer, batchRelation, inverse }) => {
  savePipelines([]);
  const h = harness(), now = h.ports.now();
  const lookup = h.ports.roleLookup!;
  h.ports.roleLookup = id => lookup(id === "merger" ? "builder" : id);
  setMergeOnReview("viewer", true, "operator", now);
  function finished(id: string): Pipeline {
    const p = buildPipeline({id, task:"Resolver capacity", project:"viewer",repoDir:"/fixture/repo",srcPath:null,srcConversationId:null,now,state:"draft",publication:"remote-branch",
      stages:[{id:"feature",kind:"run",prompt:"Feature",next:null,effectiveRole:{roleId:null,engine:"codex",model:null,effort:null,access:"read-write",promptScaffold:null}}]});
    Object.assign(p,{state:"completed",cursor:null,closedAt:now,baseBranch:"main",baseRef:ORIGIN_MAIN_SHA,lastPassedCommit:ORIGIN_MAIN_SHA,
      delivery:{target:{repository:"repo-capacity",remote:"git@example.invalid:owner/repo.git",branch:`refs/heads/${p.branch}`,pr:id==="item-a"?11:12},disposition:"owner",publish:"disabled",active:false,ownerId:id,epoch:1,journal:[]}});
    p.merge={state:"refreshing",by:null,repository:"acme/widgets",prNumber:id==="item-a"?11:12,policyChangedAt:now,reviewedHead:ORIGIN_MAIN_SHA,chain:[ORIGIN_MAIN_SHA],updates:[],seenChecks:[],head:null,headSeenAt:null,lastChecks:null,readAt:null,nextReadAt:null,requestedAt:now,mergedHead:null,mergeCommit:null,method:null,mergedAt:null,attempts:0,reason:null,blockedAt:null,updatedAt:now};
    p.merge.refresh=refreshReservation(p,"b".repeat(40),ORIGIN_MAIN_SHA,Date.parse(now),"main");p.merge.integration=integrationRecord(p,now);
    p.merge.integration.batch={owner:"item-a",items:["item-a","item-b"],cursor:0,deadline:p.merge.integration.deadline};
    return p;
  }
  const a=finished("item-a"),b=finished("item-b");savePipelines([a,b]);
  expect((await startPipelineIntegration(a,h.ports)).error).toBeUndefined();
  let rows=loadPipelines();const parked=rows.find(p=>p.id===a.id)!;
  parked.state="needs_decision";parked.stateDetail="Choose contract";parked.cursor!.state="running";
  const stage=parked.stages.find(s=>s.id==="integration-resolve")!;
  parked.runs.find(r=>r.stageId===stage.id)!.attempts.push({n:1,state:"needs_decision",effectiveRole:stage.effectiveRole,launchId:null,conversationId:null,sessionId:null,agentPath:null,paneId:null,flowId:null,startedAt:now,completedAt:now,output:null,verdict:{status:"needs_decision"},error:null} as PipelineStageAttempt);
  integrationAttempt(parked);
  for (const row of rows) row.merge!.integration!.batch.cursor=1;
  savePipelines(rows);
  expect((await startPipelineIntegration(loadPipelines().find(p=>p.id===b.id)!,h.ports)).error).toBeUndefined();
  rows=loadPipelines();const peer=rows.find(p=>p.id===b.id)!;
  if (batchRelation === "different")
    peer.merge!.integration!.batch={owner:peer.id,items:[peer.id],cursor:0,deadline:peer.merge!.integration!.deadline};
  peer.state=activePeer?"running":"needs_decision";peer.cursor!.state="running";
  const peerStage=peer.stages.find(s=>s.id==="integration-resolve")!;
  peer.runs.find(r=>r.stageId===peerStage.id)!.attempts.push({n:1,state:activePeer?"running":"needs_decision",effectiveRole:peerStage.effectiveRole,launchId:"peer-launch",conversationId:"conversation_peer",sessionId:"session-peer",agentPath:"/codex/peer.jsonl",paneId:"%peer",flowId:null,startedAt:now,completedAt:null,output:null,verdict:null,error:null} as PipelineStageAttempt);
  integrationAttempt(peer);
  // The inverse case resumes the legacy carrier against a durable peer.
  const legacy = inverse ? rows.find(p => p.id === a.id)! : peer;
  legacy.stages.find(s=>s.id==="integration-resolve")!.id="refresh";
  legacy.runs.find(s=>s.stageId==="integration-resolve")!.stageId="refresh";
  legacy.cursor!.stageId="refresh";
  legacy.refreshOf={pipelineId:"legacy-origin",base:"b".repeat(40)};
  delete legacy.merge;
  savePipelines(rows);
  h.setHostsResident(true);h.setConversationActive(true);
  const current=loadPipelines().find(p=>p.id===a.id)!;
  const resumed=await patchPipeline(a.id,{action:"resolve-decision",clientRequestId:"resume-capacity",answer:"Keep compatible contract",expectedStageId:inverse?"refresh":"integration-resolve",expectedAttempt:1,expectedRevision:pipelineRevision(current)},h.ports);
  expect(resumed.error).toBeUndefined();
  await tickPipelines([entry("/codex/peer.jsonl")],h.ports);
  await tickPipelines([entry("/codex/peer.jsonl")],h.ports);
  if (activePeer) {
    expect(h.spawnInputs.filter(p=>p.membership.containerId===a.id)).toHaveLength(0);
    const latest = loadPipelines();
    const released = latest.find(p=>p.id===b.id)!;
    released.state="needs_decision";
    const heldAttempt=released.runs.find(r=>r.stageId===released.cursor!.stageId)!.attempts.at(-1)!;
    heldAttempt.state="needs_decision";heldAttempt.completedAt=now;heldAttempt.verdict={status:"needs_decision"};
    integrationAttempt(released);savePipelines(latest);
    await tickPipelines([entry("/codex/peer.jsonl")],h.ports);
    await tickPipelines([entry("/codex/peer.jsonl")],h.ports);
  }
  console.info("reviewer capacity resume",JSON.stringify({spawned:h.spawnInputs.map(p=>({item:p.membership.containerId,slot:p.membership.slot})),rows:loadPipelines().map(p=>({id:p.id,state:p.state,cursor:p.cursor,attempt:p.runs.find(r=>r.stageId===p.cursor?.stageId)?.attempts.at(-1)?.state,detail:p.stateDetail}))}));
  expect(h.spawnInputs.filter(p=>p.membership.containerId===a.id)).toHaveLength(1);
});
