import { spyOn } from "bun:test";
import { StructuredDispatchDeferredError } from "@/lib/runtime/engineHost";
import { test, expect, savePipelines } from "./engine.fixture";
import { buildPipeline } from "./store";
import type { PipelineStageAttempt } from "./types";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { assertPipelineTurnAllowed, pipelineRequiresDispatchGuard } from "@/lib/runtime/accountCreditGuard";

test("an ordinary pipeline can use an integration-like stage name without becoming a merge session", async () => {
  const f=migrationDeliveryFixture();
  const now=new Date().toISOString();
  const p=buildPipeline({id:"ordinary",task:"Ordinary task",project:"viewer",repoDir:"/fixture/repo",srcPath:null,srcConversationId:null,now,state:"draft",
    stages:[{id:"integration-resolve",kind:"run",prompt:"Do ordinary work",next:null,
      effectiveRole:{roleId:null,engine:"codex",model:null,effort:null,access:"read-write",promptScaffold:null}}]});
  p.baseBranch="main";p.baseRef="a".repeat(40);p.lastPassedCommit=p.baseRef;
  p.state="running";p.cursor={stageId:"integration-resolve",state:"running",input:null,activatedBy:null};
  p.runs[0]!.attempts.push({n:1,state:"running",effectiveRole:p.stages[0]!.effectiveRole,launchId:"ordinary-launch",conversationId:f.conversation.id,
    sessionId:f.key.sessionId,agentPath:f.conversation.generations[0]!.path,paneId:null,flowId:null,startedAt:now,completedAt:null,output:null,verdict:null,error:null} as PipelineStageAttempt);
  savePipelines([p]);
  f.registry.rememberMembership(f.conversation.id,{kind:"pipeline",containerId:p.id,role:"builder",slot:"integration-resolve:1",stageId:"integration-resolve",stageOrder:0,round:1,parentConversationId:null});
  try {
    expect(()=>assertPipelineTurnAllowed(f.conversation.id,f.registry,{operationId:"ordinary-message",origin:{kind:"agent",role:"pipeline"}})).not.toThrow();
    expect(pipelineRequiresDispatchGuard(f.conversation.id,f.registry)).toBe(false);
    const unavailable=spyOn(f.registry,"conversationMemberships").mockImplementation(()=>{throw new Error("fixture authority read is busy");});
    try {expect(()=>pipelineRequiresDispatchGuard(f.conversation.id,f.registry)).toThrow(StructuredDispatchDeferredError);}
    finally {unavailable.mockRestore();}
  } finally {await f.cleanup();}
});
