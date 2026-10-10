import { hardenedRedact } from "@/lib/view/compactText";
import { canonicalProject } from "@/lib/projects/aliases";
import type { PrototypeReviewRead } from "@/lib/prototypeReview/types";
import { withoutLocalPaths } from "./redaction";
import { READ_SCHEMAS, validToolValue } from "./readSchemas";

export const READ_TOOL_NAMES = ["list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "orchestrator_messages", "search_transcripts", "read_prototype_review", "view_prototype_frame"] as const;
export type ReadToolName = typeof READ_TOOL_NAMES[number];
export const VOICE_IMAGES = Symbol("voice prototype frames");
export interface BoardReadPaths {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  projectFor(kind: "task" | "pipeline" | "conversation", id: string): Promise<string | null>;
  recipient(project: string): string | null;
  resolveProject(current: string | null, requested?: string): string;
  review(id: string): PrototypeReviewRead;
  frame(id: string, reviewId: string, mediaId: string): Promise<{ mime: string; data: string }>;
}
export interface SpeechReadResult {
  speech: string; total?: number; shown?: number; more?: number; nextCursor?: string | null;
  rows?: unknown[]; item?: unknown; truncated: boolean;
  repeated?: true; readSecondsAgo?: number;
  coverage?: Record<string, unknown>;
  [VOICE_IMAGES]?: Array<{ mime: string; data: string }>;
}
const clean = (value: string) => withoutLocalPaths(hardenedRedact(value).replace(/<!--[^]*?-->/g, ""));
const encoder = new TextEncoder();
/** Byte limits preserve complete Unicode scalars. */
const short = (value: unknown, limit = 160) => {
  const text = clean(typeof value === "string" ? value : "").replace(/\b(?:conversation_|task_|pipeline_)[A-Za-z0-9_-]+\b/g, "[reference]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[reference]");
  let kept = ""; let bytes = 0; for (const char of text) { bytes += encoder.encode(char).length; if (bytes > limit) break; kept += char; } return kept;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const taskRow = (row: Record<string, unknown>) => ({ handle: row.id, title: short(String(row.text ?? "").split("\n")[0]), state: short(row.status,32), ...(row.priority ? { priority: row.priority } : {}) });
const pipelineRow = (row: Record<string, unknown>) => ({ handle: row.id ?? row.pipelineId, title: short(row.task ?? row.title), state: short(row.state,32),
  ...(row.stateDetail ? { detail: short(row.stateDetail,80) } : {}), ...(row.cursor ? { stage: short(object(row.cursor).stageId,32) } : {}) });
function page(source: Record<string, unknown>, items: Record<string, unknown>[], label: string): SpeechReadResult {
  const total = typeof source.total === "number" ? source.total : typeof source.count === "number" ? source.count : items.length;
  const more = typeof source.remainingCount === "number" ? source.remainingCount : Math.max(source.hasMore === true ? 1 : 0,total-items.length);
  const result: SpeechReadResult = {total,shown:items.length,more,nextCursor: typeof source.nextCursor === "string" ? source.nextCursor : typeof source.cursor === "string" ? source.cursor : null,
    rows:items, speech:short(`${total} ${label}. ${items.slice(0,5).map(row => `${row.title ?? row.excerpt ?? "Message"}: ${row.state ?? row.speaker ?? ""}`).join(". ")}`,600), truncated: more > 0 || source.hasMore === true};
  // Upstream cursors are opaque and must survive the speech budget intact.
  if (Buffer.byteLength(JSON.stringify(result)) > 4000) {
    result.rows = items.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,["handle","time","speaker","state"].includes(key) ? value : typeof value === "string" ? short(value,60) : value])));
    result.speech = short(result.speech,240);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 4000) throw new Error("ANSWER_TOO_LARGE");
  return result;
}
/** Only this read allowlist reaches the backend. Project identities are
 * resolved by the server and every targeted record is fenced before reading. */
export class CompanionBoardReads {
  constructor(private readonly paths: BoardReadPaths) {}
  resolveProject(current: string | null, requested?: string) { return this.paths.resolveProject(current, requested); }
  normalize(project: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const schema = READ_SCHEMAS[name]; if (!schema) throw new Error("TOOL_NOT_ALLOWED");
    if (Object.keys(args).some(key => !Object.hasOwn(schema,key)) || Object.entries(schema).some(([key,property]) => !validToolValue(property,args[key]))) throw new Error("INVALID_TOOL_ARGUMENTS");
    const values = Object.fromEntries(Object.entries(args).filter(([key,value]) => key !== "project" && key !== "refresh" && value !== null && value !== undefined));
    return { ...values, project, ...(name.startsWith("list_") || name.endsWith("messages") ? {limit:values.limit ?? 10} : {}),
      ...(name === "agent_activity" ? {liveOnly:values.liveOnly ?? true,limit:values.limit ?? 10} : {}),
      ...(name.endsWith("messages") ? {roles:values.roles ?? (name === "orchestrator_messages" ? ["assistant"] : ["user","assistant"])} : {}),
      ...(name === "search_transcripts" ? {order:values.order ?? "relevance",limit:6} : {}) };
  }
  async call(current: string, name: string, args: Record<string, unknown>): Promise<SpeechReadResult> {
    const project = this.resolveProject(current, typeof args.project === "string" ? args.project : undefined);
    const normalized = this.normalize(project,name,args);
    return this.read(project,name,normalized);
  }
  async read(project: string, name: string, args: Record<string, unknown>): Promise<SpeechReadResult> {
    project = canonicalProject(project);
    const kind = name === "get_pipeline" ? "pipeline" : name === "get_task" || name.includes("prototype") ? "task" : name === "conversation_messages" || (name === "agent_activity" && args.conversationId) ? "conversation" : null;
    const id = String(args[kind === "pipeline" ? "pipelineId" : kind === "task" ? "taskId" : "conversationId"] ?? "");
    if (kind && canonicalProject(await this.paths.projectFor(kind,id) ?? "") !== project) throw new Error("PROJECT_REFUSED");
    if (name === "read_prototype_review") {
      const review = this.paths.review(id);
      // Complete review text is the operator's explicit one-call exception to
      // list budgets. Internal delivery text and local paths never leave it.
      const scrub = (value: unknown): unknown => typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(scrub)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !["source","url"].includes(key)).map(([key,value]) => [key,scrub(value)])) : value;
      return { item:scrub(review),speech:`${review.rounds.length} prototype review rounds. Read every variant, question, recommendation and saved decision from the item.`,truncated:!!review.historyTruncated };
    }
    if (name === "view_prototype_frame") {
      const image = await this.paths.frame(id,String(args.reviewId),String(args.mediaId));
      return {item:{taskId:id,reviewId:args.reviewId,mediaId:args.mediaId},speech:"The prototype frame is attached for visual inspection. Describe only what you can see; this read saves no decision.",truncated:false,[VOICE_IMAGES]:[image]};
    }
    let tool = name;
    if (name === "orchestrator_messages") {
      const conversationId = this.paths.recipient(project); if (!conversationId) throw new Error("NO_ORCHESTRATOR");
      args = {...args,conversationId}; tool = "conversation_messages";
    }
    const source = await this.paths.call(tool,{...args,project,compact:true,includeHints:false,
      ...(tool === "conversation_messages" ? {kinds:["message"],maxChars:320} : {}),...(tool === "get_task" ? {compact:false} : {})});
    if (name === "list_tasks") return page(source,rows(source.tasks).map(taskRow),"tasks");
    if (name === "list_pipelines") return page(source,rows(source.pipelines).map(pipelineRow),"pipelines");
    if (name === "get_task") {
      const row = object(source.task); const item = {...taskRow(row),note:short(object(row.note).text,320),hold:short(object(row.hold).note,200),steps:rows(row.steps).slice(0,8).map(step=>({text:short(step.text),state:short(step.state,32)}))};
      return {item,speech:short(`${item.title}: ${item.state}. ${item.note} ${item.hold} ${item.steps.map(step=>`${step.text}: ${step.state}`).join(". ")}`,600),truncated:rows(row.steps).length>8};
    }
    if (name === "get_pipeline") {
      const item = {...pipelineRow(source), stages:rows(source.stages).slice(0,12).map(stage=>({title:short(stage.id,32),kind:short(stage.kind,32),state:short(object(stage.latestAttempt).state ?? stage.state ?? "pending",32),verdict:object(stage.latestAttempt).verdict ?? stage.verdict ?? null})),
        ...(args.stageId ? {stageId:args.stageId,stageDetail:{kind:short(object(source.stage).kind,32),role:short(object(source.stage).roleId,32),state:short(object(source.attempt).state,32)},verdict:object(source.attempt).verdict ?? null,summary:short(object(source.attempt).summary,600),findings:(Array.isArray(object(source.attempt).findings) ? object(source.attempt).findings as unknown[] : []).slice(0,5).map(finding=>short(finding,200))} : {})};
      return {item,speech:short(`${item.title}: ${item.state}. ${args.stageId ? `${item.stageId}: ${item.stageDetail?.state}. ${item.verdict ?? ""}. ${item.summary}` : item.stages.map(stage=>`${stage.title}: ${stage.state}`).join(". ")}`,600),truncated:rows(source.stages).length>12 || (Array.isArray(object(source.attempt).findings) && (object(source.attempt).findings as unknown[]).length>5)};
    }
    if (name === "agent_activity") {
      const result = page({...source, remainingCount:source.budgetOmittedCount},rows(source.conversations).map(row=>({handle:row.conversationId,title:short(row.title)||"Agent",state:short(row.lifecycle,32),turn:short(row.turn ?? row.turnState,32)})),"observed agents");
      const coverage = { unselectedCount: source.unselectedCount ?? 0, ...(source.catalog ? {catalog:source.catalog} : {}),
        ...(source.evidence ? {evidence:source.evidence,unverifiedCount:source.unverifiedCount ?? 0} : {}),
        ...(source.undescribedHostCount ? {undescribedHostCount:source.undescribedHostCount} : {}) };
      return {...result, coverage, truncated:result.truncated || Number(coverage.unselectedCount)>0 || !!source.evidence || !!source.catalog,
        speech:short(`${result.speech}${Number(coverage.unselectedCount)>0 ? ` Additional conversations were not checked; narrow by conversationId.` : ""}${source.evidence || source.catalog ? " Some evidence is pending or stale; these counts are partial." : ""}`,600)};
    }
    if (tool === "conversation_messages") return page(source,rows(source.records).map(row=>({speaker:row.role,time:row.ts,excerpt:short(row.text,320)})),"messages");
    if (name === "search_transcripts") {
      if (canonicalProject(object(source.projectScope).resolved as string ?? "") !== project) throw new Error("PROJECT_REFUSED");
      return page(source,rows(source.items).map(row=>({handle:row.conversationId,title:short(row.title),time:row.timestamp,excerpt:short(row.snippet,200)})),"conversations");
    }
    throw new Error("TOOL_NOT_ALLOWED");
  }
}
