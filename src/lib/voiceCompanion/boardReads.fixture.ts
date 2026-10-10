import { CompanionBoardReads } from "./boardReads";
import { createCompanionBoardReadPaths } from "./readPaths";
import { productionDomainDependencies } from "@/lib/mcp/bindings";
import { buildPipeline } from "@/lib/pipelines/store";
import type { BoardTask } from "@/lib/tasks/types";

/** Small fixtures retain the real task/pipeline filtering and projection. */
export function fixtureBoardReads(input: {
  tasks(): readonly {id:string;project:string;text:string;status:string;note?:{text:string};hold?:{note:string};steps?:Array<{text:string;state:string}>}[];
  pipelines(): readonly {id:string;project:string;task:string;state:string;stages:Array<{id:string;kind:string}>;runs:unknown[]}[];
  activity(project:string):Promise<Array<{conversationId:string;project:string;title?:string|null;lifecycle:string}>>;
  messages(id:string):Promise<Array<{role:string;text:string}>>;
}) {
  const at = "2026-10-10T00:00:00.000Z";
  const taskRows = input.tasks().map(row=>({createdAt:at,updatedAt:at,placement:"unplaced",assignments:[],...row})) as unknown as BoardTask[];
  const pipelineRows = input.pipelines().map(row=>({...buildPipeline({id:row.id,task:row.task,project:row.project,repoDir:"/repo",srcPath:null,srcConversationId:null,now:at,
    stages: row.stages.map(stage=>({id:stage.id,kind:"run",prompt:"Fixture",next:null,effectiveRole:{roleId:null,engine:"claude",model:null,effort:null,access:"read-only",promptScaffold:null}}))}),state:row.state,runs:row.runs})) as ReturnType<typeof productionDomainDependencies.getPipelines>["pipelines"];
  const paths = createCompanionBoardReadPaths({domain:{...productionDomainDependencies,taskSelectionSource:undefined,pipelineSelectionSource:undefined,
    loadTasks:()=>taskRows,listTaskRecords:()=>taskRows,getPipelines:()=>({pipelines:pipelineRows}) as ReturnType<typeof productionDomainDependencies.getPipelines>,
    listPipelineRecords:()=>pipelineRows,readPipelineRecord:id=>pipelineRows.find(row=>row.id===id)??null}});
  return new CompanionBoardReads({...paths,
    resolveProject(current,requested) {if(!current || requested && requested !== current) throw new Error("PROJECT_REFUSED");return current;},
    async projectFor(kind,id) {if(kind === "task")return taskRows.find(row=>row.id===id)?.project??null;if(kind === "pipeline")return pipelineRows.find(row=>row.id===id)?.project??null;
      return (await input.activity("fixture")).find(row=>row.conversationId===id)?.project??null;},
    recipient:()=>"conversation_a",
    review:id=>({taskId:id,rounds:[],waitingReviewId:null}),
    frame:async()=>({mime:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="}),
    call:async(name,args,redactText)=>name==="search_transcripts" ? {items:[],total:0,nextCursor:null,projectScope:{resolved:args.project}} : name==="agent_activity" ? {conversations:(await input.activity(String(args.project))).filter(row=>row.project===args.project),count:(await input.activity(String(args.project))).filter(row=>row.project===args.project).length}
      : name==="conversation_messages" ? {records:(await input.messages(String(args.conversationId))).map(row=>({role:row.role,text:row.text}))} : paths.call(name,args,redactText),
  });
}
