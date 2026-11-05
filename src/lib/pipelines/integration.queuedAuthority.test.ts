import { test, expect, harness, loadPipelines, savePipelines, ORIGIN_MAIN_SHA } from "./engine.fixture";
import { buildPipeline } from "./store";
import { startPipelineIntegration, recoverPipelineProviderTurn } from "./engine";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord, integrationAttempt } from "./integration";
import { setMergeOnReview } from "@/lib/projects/settings";
import type { Pipeline, PipelineStageAttempt } from "./types";

const changes = ["control", "policy-after-journal", "deadline-after-journal", "epoch-after-journal", "requirements-after-journal",
  "scope-after-journal", "owner-replaced", "attempt-replaced", "cut-replaced", "authority-removed", "uncertain"] as const;
for (const transport of ["host", "native"] as const) test.each([...changes])(`integration fences queued continuation at ${transport} dispatch (%s)`,async change=>{
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

    return p;
  }
  const a=finished("item-a"); savePipelines([a]);
  expect((await startPipelineIntegration(a,h.ports)).error).toBeUndefined();
  const rows=loadPipelines(), current=rows.find(p=>p.id===a.id)!;
  current.state="running"; current.cursor!.state="running";
  const stage=current.stages.find(s=>s.id===current.cursor!.stageId)!;
  const attempt={n:1,state:"running",effectiveRole:stage.effectiveRole,launchId:null,conversationId:null,sessionId:null,
    agentPath:null,paneId:null,flowId:null,startedAt:now,completedAt:null,output:null,verdict:null,error:null} as PipelineStageAttempt;
  current.runs.find(r=>r.stageId===stage.id)!.attempts.push(attempt);
  const cutTs=Date.parse(now)+1000;
  Object.assign(attempt,{state:"running",completedAt:null,verdict:null,launchId:"provider-launch",conversationId:"conversation_provider",sessionId:"provider-session",agentPath:"/codex/provider.jsonl",paneId:null});
  attempt.providerWait={condition:{kind:"transient",scope:null,resetLabel:null,label:"model at capacity"},text:"Selected model is at capacity. Please try a different model.",accountId:null,turnTs:cutTs,tries:0,startedAt:now,resumeAt:new Date(Date.parse(now)+60000).toISOString(),resetsAt:null};
  integrationAttempt(current);savePipelines(rows);
  h.setHostsResident(true);h.setConversationActive(false);
  h.ports.now=()=>new Date(Date.parse(now)+120000).toISOString();
  const message={text:attempt.providerWait.text,ts:cutTs,errorClass:"server_overloaded"};
  h.durableTurns.set(attempt.agentPath!,{turn:"terminal",message,terminalProviderMessage:message,promptHistoryComplete:true});
  const {migrationDeliveryFixture}=await import("@/test-helpers/migrationDelivery");
  const {enqueueStructuredMessage}=await import("@/lib/runtime/structuredMessageDelivery");
  const {bindStructuredDeliveryQueue}=await import("@/lib/runtime/structuredDeliveryController");
  const {kickStructuredDeliveryQueue}=await import("@/lib/runtime/structuredDeliverySignal");
  const f=migrationDeliveryFixture();let exposeEffects=false,guards=0;
  const nativeWrites:string[]=[];
  let hostCalls=0;
  const send=f.host.send.bind(f.host);
  f.host.send=async entry=>{
    hostCalls++;
    const result=await send(entry);
    if(change==="uncertain")throw new Error("reply lost after the host accepted input");
    return result;
  };
  let busy=false;
  if(transport==="native") {
    const {NativeCodexQueue}=await import("@/lib/runtime/nativeCodexQueue");
    const {NATIVE_QUEUE_CAPABILITY}=await import("@/lib/runtime/codexCapabilityFlags");
    const health=f.host.health.bind(f.host);
    f.host.health=async()=>({...await health(),status:busy?"active":"idle",activeTurnRef:busy?"busy-turn":null,activeFlags:[NATIVE_QUEUE_CAPABILITY]});
    Object.assign(f.host,{nativeQueue:{
      queue:new NativeCodexQueue({rpc:async(method)=>{
        if(method==="thread/queue/list")return {data:[],nextCursor:null};
        nativeWrites.push(method); throw new Error("revocable input must not enter the native automatic queue");
      }},f.key.sessionId),
      prepare:async(_entry:unknown,version:{text:string})=>[{type:"text" as const,text:version.text}],
      evidence:async()=>null,
      sendWithdrawn:async()=>{
        nativeWrites.push("turn/start");
        if(change==="uncertain")throw new Error("reply lost after turn/start");
        return {turnId:"guarded-turn"};
      },
    }});
    f.client.nativeQueueRead=async id=>f.journal.nativeQueueRead(id);
    f.client.nativeQueueTransition=async(id,change)=>f.journal.nativeQueueTransition(id,change);
    f.journal.append({scope:`session:${f.conversation.id}`,kind:"session-status",payload:{conversationId:f.conversation.id,
      sessionKey:f.key,hostKind:"codex-app-server",host:"hosted",turn:"idle",activeTurnId:null,accountId:"account-a",
      capabilities:{steer:true,structuredAttention:true,nativeQueue:true}}});
  }
  const originalEffects=f.client.effectBatch.bind(f.client);
  f.client.effectBatch=async (...args)=>exposeEffects?originalEffects(...args):[];
  f.client.readSession=async lookup=>f.journal.readSession(lookup);
  f.client.command=async command=>f.journal.executeOperation(command);
  const changed=loadPipelines();const own=changed.find(p=>p.id===a.id)!;
  const actualAttempt=own.runs.find(r=>r.stageId===own.cursor!.stageId)!.attempts.at(-1)!;
  actualAttempt.conversationId=f.conversation.id;actualAttempt.agentPath=f.conversation.generations.at(-1)!.path;
  integrationAttempt(own);savePipelines(changed);
  h.durableTurns.set(actualAttempt.agentPath!,{turn:"terminal",message,terminalProviderMessage:message,promptHistoryComplete:true});
  f.registry.rememberMembership(f.conversation.id,{kind:"pipeline",containerId:own.id,role:"merger",slot:`${own.cursor!.stageId}:${actualAttempt.n}`,stageId:own.cursor!.stageId,stageOrder:own.stages.findIndex(s=>s.id===own.cursor!.stageId),round:actualAttempt.n,parentConversationId:null});
  const bind=()=>bindStructuredDeliveryQueue([{key:f.key,host:f.host}],{registry:f.registry,client:f.client,now:()=>Date.parse(h.ports.now()),
    watchdogIntervalMs:0,hostlessSettleIntervalMs:0,settlementSweepMs:0});
  await bind();
  const sends:string[]=[];
  h.ports.resumeSeveredTurn=async input=>{
    const answer=await enqueueStructuredMessage({conversationId:input.conversationId,path:input.transcriptPath,
      clientMessageId:input.clientMessageId,text:input.text,policy:"queue",origin:{kind:"agent",role:"pipeline"}},
      {enabled:()=>true,registry:()=>f.registry,client:()=>f.client,kick:()=>{},progress:null,
       // The provider adapter's idle-only input uses the ordinary journal.
       // Native cases exercise queued pipeline input with no idle-only hint.
       ...(transport==="host"?{idleContinuationAllowed:input.continuationAllowed}:{}),
       authorizeDispatch:()=>{guards++;input.authorizeContinuation?.();}});
    expect(answer).toMatchObject({ok:true,receipt:{status:"queued"}});
    if(answer?.ok)sends.push(input.clientMessageId);
    return answer?.ok===true;
  };
  try {
    await recoverPipelineProviderTurn(a.id,h.ports);
    expect(sends).toHaveLength(1);expect(f.host.ledger.writes).toHaveLength(0);
    // Reconstruct the controller after admission; no request-local closure is
    // present in this instance. Native input must remain ours while busy.
    await bindStructuredDeliveryQueue([], {client:null});
    if(transport==="native") {
      exposeEffects=true; busy=true; await bind(); await kickStructuredDeliveryQueue();
      expect(nativeWrites).toHaveLength(0);
      await bindStructuredDeliveryQueue([], {client:null});
      busy=false;
    }
    if(change==="policy-after-journal")setMergeOnReview("viewer",false,"operator",now);
    if(change==="deadline-after-journal") {
      const deadline=loadPipelines().find(p=>p.id===a.id)!.merge!.integration!.deadline;
      h.ports.now=()=>new Date(Date.parse(deadline)+1).toISOString();
    }
    if(["epoch-after-journal","requirements-after-journal","scope-after-journal"].includes(change)){
      const rows=loadPipelines(),row=rows.find(p=>p.id===a.id)!;
      if(change==="epoch-after-journal")row.delivery!.epoch++;
      if(change==="requirements-after-journal")row.spec="Updated integration contract";
      if(change==="scope-after-journal")row.merge!.integration!.scope="changed-scope";
      savePipelines(rows);
    }
    if(["owner-replaced","attempt-replaced","cut-replaced","authority-removed"].includes(change)) {
      const changed=loadPipelines(),row=changed.find(p=>p.id===a.id)!;
      const old=row.runs.find(r=>r.stageId===stage.id)!.attempts.at(-1)!;
      if(change==="owner-replaced") {
        row.delivery!.ownerId="replacement-owner"; row.delivery!.active=false; row.delivery!.disposition="comparison"; row.delivery!.publish="disabled";
      }
      if(change==="attempt-replaced") {
        old.historical=true;
        row.runs.find(r=>r.stageId===stage.id)!.attempts.push({...structuredClone(old),n:old.n+1,historical:false,
          launchId:"replacement-launch",conversationId:"conversation_replacement"});
        integrationAttempt(row);
      }
      if(change==="cut-replaced") old.providerWait!.turnTs++;
      if(change==="authority-removed") delete row.merge!.integration;
      savePipelines(changed);
    }
    exposeEffects=true;await bind();await kickStructuredDeliveryQueue();
    const writes=()=>transport==="native"?nativeWrites.length:hostCalls;
    const expected=change==="control"||change==="uncertain"?1:0;
    expect(guards).toBe(1);
    expect(writes()).toBe(expected);
    await kickStructuredDeliveryQueue();
    expect(writes()).toBe(expected);
    // A revoked message keeps the original continuation reservation; it cannot
    // silently create a second attempt before the refused receipt is reconciled.
    const kept=loadPipelines().find(p=>p.id===a.id)!.runs.find(r=>r.stageId===stage.id)!.attempts[0]!;
    expect(kept.providerWait?.continuationRequestedAt).toBeTruthy();
    if(change==="control") {
      const {assertPipelineTurnAllowed}=await import("@/lib/runtime/accountCreditGuard");
      const saved=loadPipelines(), accepted=saved.find(p=>p.id===a.id)!;
      accepted.runs.find(r=>r.stageId===stage.id)!.attempts[0]!.verdict={status:"pass"};
      accepted.cursor!.stageId="integration-review"; accepted.cursor!.state="committing";
      savePipelines(saved);
      // An accepted producer can answer its publication repair while the
      // review cursor publishes, with the same current integration authority.
      expect(()=>assertPipelineTurnAllowed(f.conversation.id,f.registry,{operationId:"repair",clientMessageId:"stage-summary-rewrite-fixture",
        origin:{kind:"agent",role:"pipeline"},now:Date.parse(h.ports.now())})).not.toThrow();
      expect(()=>assertPipelineTurnAllowed(f.conversation.id,f.registry,{operationId:"old-provider",clientMessageId:sends[0],
        origin:{kind:"agent",role:"pipeline"},now:Date.parse(h.ports.now())})).toThrow("no longer owns");
    }
  } finally {await f.cleanup();}
});
