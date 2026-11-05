import { test, expect, harness, loadPipelines, savePipelines, ORIGIN_MAIN_SHA } from "./engine.fixture";
import { buildPipeline } from "./store";
import { startPipelineIntegration, recoverPipelineProviderTurn } from "./engine";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord, integrationAttempt } from "./integration";
import { setMergeOnReview } from "@/lib/projects/settings";
import type { Pipeline, PipelineStageAttempt } from "./types";

test.each(["control","policy","epoch","deadline","requirements","scope","policy-at-actuation"] as const)("provider recovery revalidates integration authority (%s)",async change=>{
  const inverse=false, activePeer=false, batchRelation="different";
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
  const current=rows.find(p=>p.id===a.id)!;
  current.state="running";current.cursor!.state="running";
  const attempt=current.runs.find(r=>r.stageId===current.cursor!.stageId)!.attempts.at(-1)!;
  const cutTs=Date.parse(now)+1000;
  Object.assign(attempt,{state:"running",completedAt:null,verdict:null,launchId:"provider-launch",conversationId:"conversation_provider",sessionId:"provider-session",agentPath:"/codex/provider.jsonl",paneId:null});
  attempt.providerWait={condition:{kind:"transient",scope:null,resetLabel:null,label:"model at capacity"},text:"Selected model is at capacity. Please try a different model.",accountId:null,turnTs:cutTs,tries:0,startedAt:now,resumeAt:new Date(Date.parse(now)+60000).toISOString(),resetsAt:null};
  integrationAttempt(current);savePipelines(rows);
  h.setHostsResident(true);h.setConversationActive(false);
  h.ports.now=()=>new Date(Date.parse(now)+120000).toISOString();
  const message={text:attempt.providerWait.text,ts:cutTs,errorClass:"server_overloaded"};
  h.durableTurns.set(attempt.agentPath!,{turn:"terminal",message,terminalProviderMessage:message,promptHistoryComplete:true});
  const sends:string[]=[];
  h.ports.resumeSeveredTurn=async input=>{
    if(input.continuationAllowed && !await input.continuationAllowed())return false;
    if(change==="policy-at-actuation")setMergeOnReview("viewer",false,"operator",now);
    try { input.authorizeContinuation?.(); }
    catch(error) { input.onRefused?.(String(error), "refused"); return false; }
    sends.push(input.clientMessageId);return true;
  };
  if(change==="policy")setMergeOnReview("viewer",false,"operator",now);
  if(change!=="control" && change!=="policy"){
    const changed=loadPipelines();const own=changed.find(p=>p.id===a.id)!;
    if(change==="epoch")own.delivery!.epoch++;
    if(change==="deadline")own.merge!.integration!.deadline=new Date(Date.parse(now)+50000).toISOString();
    if(change==="requirements")own.spec=(own.spec??"")+" updated contract";
    if(change==="scope")own.merge!.integration!.scope="different-scope";
    savePipelines(changed);
  }
  await recoverPipelineProviderTurn(a.id,h.ports);
  expect(sends).toHaveLength(change==="control"?1:0);
  if(change!=="control") {
    const kept=loadPipelines().find(p=>p.id===a.id)!.runs.find(r=>r.stageId===current.cursor!.stageId)!.attempts;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.providerWait?.actionAt).toBeUndefined();
    expect(kept[0]!.providerWait?.continuationRequestedAt).toBeUndefined();
  }
});
