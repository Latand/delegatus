import { hardenedRedact } from "@/lib/view/compactText";
import { canonicalProject } from "@/lib/projects/aliases";
import type { PrototypeReviewRead } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";
import { byteShort, captionHead, matchRounds, reviewAnswer, selectFrames } from "./prototypeRead";
import { cleanStrings, withoutCredentials, withoutLocalPaths } from "./redaction";
import { READ_SCHEMAS, validToolValue } from "./readSchemas";

export const READ_TOOL_NAMES = ["list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "orchestrator_messages", "search_transcripts", "read_prototype_review", "view_prototype_frame", "agent_fleet"] as const;
export type ReadToolName = typeof READ_TOOL_NAMES[number];
export const VOICE_IMAGES = Symbol("voice prototype frames");
export interface BoardReadPaths {
  call(name: string, args: Record<string, unknown>, redactText?: (text: string) => string): Promise<Record<string, unknown>>;
  projectFor(kind: "task" | "pipeline" | "conversation", id: string): Promise<string | null>;
  recipient(project: string): string | null;
  resolveProject(current: string | null, requested?: string): string;
  review(id: string): PrototypeReviewRead;
  prototypeTasks?(project: string, taskId?: string): readonly BoardTask[];
  frame(id: string, reviewId: string, mediaId: string): Promise<{ mime: string; data: string }>;
}
export interface SpeechReadResult {
  status?: string; code?: string; match?: string;
  speech: string; total?: number; shown?: number; more?: number; nextCursor?: string | null;
  rows?: unknown[]; item?: unknown; truncated: boolean;
  repeated?: true; readSecondsAgo?: number;
  coverage?: Record<string, unknown>;
  [VOICE_IMAGES]?: Array<{ mime: string; data: string }>;
}
const clean = (value: string) => withoutLocalPaths(hardenedRedact(value).replace(/<!--[^]*?-->/g, ""));
const encoder = new TextEncoder();
const NO_SECRETS: readonly string[] = Object.freeze([]);
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
  ...(row.stateDetail ? { detail: short(row.stateDetail,80) } : {}), ...(row.cursor ? { stage: short(object(row.cursor).stageId,32),
    verdict: object(rows(row.stages).find(stage => stage.id === object(row.cursor).stageId)?.latestAttempt).verdict ?? null } : {}) });
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
  private readonly redactors = new WeakMap<readonly string[], (text: string) => string>();
  constructor(private readonly paths: BoardReadPaths) {}
  resolveProject(current: string | null, requested?: string) { return this.paths.resolveProject(current, requested); }
  normalize(project: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const schema = READ_SCHEMAS[name]; if (!schema) throw new Error("TOOL_NOT_ALLOWED");
    if (Object.keys(args).some(key => !Object.hasOwn(schema,key)) || Object.entries(schema).some(([key,property]) => !validToolValue(property,args[key]))) throw new Error("INVALID_TOOL_ARGUMENTS");
    const values = Object.fromEntries(Object.entries(args).filter(([key,value]) => key !== "project" && key !== "refresh" && value !== null && value !== undefined));
    return { ...values, project, ...(name.startsWith("list_") || name.endsWith("messages") ? {limit:values.limit ?? 10} : {}),
      ...(name === "agent_fleet" ? {limit:values.limit ?? 10} : {}),
      ...(name === "agent_activity" ? {liveOnly:values.liveOnly ?? true,limit:values.limit ?? 10} : {}),
      ...(name.endsWith("messages") ? {roles:values.roles ?? (name === "orchestrator_messages" ? ["assistant"] : ["user","assistant"])} : {}),
      ...(name === "search_transcripts" ? {order:values.order ?? "relevance",limit:6} : {}) };
  }
  async call(current: string, name: string, args: Record<string, unknown>): Promise<SpeechReadResult> {
    const project = this.resolveProject(current, typeof args.project === "string" ? args.project : undefined);
    const normalized = this.normalize(project,name,args);
    return this.read(project,name,normalized);
  }
  async read(project: string, name: string, args: Record<string, unknown>, secrets: readonly string[] = NO_SECRETS): Promise<SpeechReadResult> {
    project = canonicalProject(project);
    const kind = (name === "agent_fleet" && args.pipelineId) || name === "get_pipeline" ? "pipeline" : name === "get_task" || name.includes("prototype") ? "task" : name === "conversation_messages" || (["agent_activity", "agent_fleet"].includes(name) && args.conversationId) ? "conversation" : null;
    const id = String(args[kind === "pipeline" ? "pipelineId" : kind === "task" ? "taskId" : "conversationId"] ?? "");
    if (kind && (id || !name.includes("prototype")) && canonicalProject(await this.paths.projectFor(kind,id) ?? "") !== project) throw new Error("PROJECT_REFUSED");
    if (name === "read_prototype_review" || name === "view_prototype_frame") {
      if (!this.paths.prototypeTasks) throw new Error("TOOL_NOT_ALLOWED");
      const tasks = this.paths.prototypeTasks(project, id || undefined);
      const observed = new Map<string, PrototypeReviewRead>();
      const read = (id: string) => { if (!observed.has(id)) observed.set(id, this.paths.review(id)); return observed.get(id)!; };
      const candidates = matchRounds(tasks, read, args);
      const scrub = (text: string) => clean(withoutCredentials(text, secrets));
      // Mask complete text before a title, caption or speech budget can cut it.
      const answer = () => reviewAnswer(cleanStrings(candidates, scrub), cleanStrings(tasks, scrub), cleanStrings(matchRounds(tasks, read, {}), scrub), scrub(project), cleanStrings(args, scrub));
      if (name === "read_prototype_review") return answer();
      if (candidates.length !== 1) {
        const result = answer();
        return { ...result, status: "refused", code: "FRAME_UNAVAILABLE", speech: `No frame was opened: select one prototype review first. Nothing was seen. ${result.speech}` };
      }
      const candidate = candidates[0];
      const attached: Array<{ variant: number; view: string; width?: number; lang?: string; original: boolean }> = [];
      const missing: Array<{ variant: number; reason: string; views: string[] }> = [];
      const images: Array<{ mime: string; data: string }> = [];
      let bytes = 0;
      for (const choice of selectFrames(candidate, args)) {
        let reason = choice.reason;
        if (!reason && bytes + choice.media!.bytes > 8 * 1024 * 1024) reason = "the 8 MiB picture budget is spent";
        if (!reason) {
          try {
            const image = await this.paths.frame(candidate.task.id, candidate.round.id, choice.media!.id);
            images.push(image); bytes += choice.media!.bytes;
            attached.push({ variant: choice.variant, view: captionHead(scrub(choice.frame!.caption)), width: choice.frame!.width, lang: choice.frame!.lang, original: args.original === true });
          } catch { reason = "stored picture could not be opened or verified"; }
        }
        if (reason) missing.push({ variant: choice.variant, reason, views: cleanStrings(choice.views, scrub) });
      }
      const misses = missing.map(row => `variant ${row.variant}: ${row.reason}`).join("; ");
      return { status: images.length ? "done" : "refused", ...(!images.length ? { code: "FRAME_UNAVAILABLE" } : {}),
        item: { taskId: candidate.task.id, reviewId: candidate.round.id, attached, missing, requested: cleanStrings(args, scrub) },
        speech: images.length ? byteShort(`Attached ${images.length} picture(s): ${attached.map(row => `variant ${row.variant} «${row.view}»`).join(", ")}. Describe only what these pictures show and name each variant and view.${missing.length ? ` Not attached: ${misses}.` : ""}`, 1200)
          : `No frame was opened: ${misses}. Nothing was seen. Say that you could not view it and what you asked for, and describe nothing about how it looks.`,
        truncated: false, ...(images.length ? { [VOICE_IMAGES]: images } : {}) };
    }
    let tool = name;
    if (name === "orchestrator_messages") {
      const conversationId = this.paths.recipient(project); if (!conversationId) throw new Error("NO_ORCHESTRATOR");
      args = {...args,conversationId}; tool = "conversation_messages";
    }
    let redactText = this.redactors.get(secrets);
    if (!redactText) { redactText = text=>clean(withoutCredentials(text,secrets)); this.redactors.set(secrets,redactText); }
    // Mask active credentials before projection cuts fields into speech-sized
    // pieces. Otherwise a cut can leave a fragment that no longer matches.
    const source = cleanStrings(await this.paths.call(tool,{...args,project,compact:true,includeHints:false,
      ...(tool === "conversation_messages" ? {kinds:["message"],maxChars:320} : {}),...(tool === "get_task" ? {compact:false} : {})},
      redactText),text=>withoutCredentials(text,secrets));
    if (name === "list_tasks") return page(source,rows(source.tasks).map(taskRow),"tasks");
    if (name === "list_pipelines") return page(source,rows(source.pipelines).map(pipelineRow),"pipelines");
    if (name === "get_task") {
      const row = object(source.task); const item = {...taskRow(row),note:short(object(row.note).text,320),hold:short(object(row.hold).note,200),steps:rows(row.steps).slice(0,8).map(step=>({text:short(step.text),state:short(step.state,32)}))};
      return {item,speech:short(`${item.title}: ${item.state}. ${item.note} ${item.hold} ${item.steps.map(step=>`${step.text}: ${step.state}`).join(". ")}`,600),truncated:rows(row.steps).length>8};
    }
    if (name === "get_pipeline") {
      const item = {...pipelineRow(source), stages:rows(source.stages).slice(0,12).map(stage=>({title:short(stage.id,32),kind:short(stage.kind,32),role:short(stage.roleId,64),state:short(object(stage.latestAttempt).state ?? stage.state ?? "pending",32),verdict:object(stage.latestAttempt).verdict ?? stage.verdict ?? null})),
        ...(args.stageId ? {stageId:args.stageId,stageDetail:{kind:short(object(source.stage).kind,32),role:short(object(source.stage).roleId,32),state:short(object(source.attempt).state,32)},verdict:object(source.attempt).verdict ?? null,summary:short(object(source.attempt).summary,600),findings:(Array.isArray(object(source.attempt).findings) ? object(source.attempt).findings as unknown[] : []).slice(0,5).map(finding=>short(finding,200))} : {})};
      return {item,speech:short(`${item.title}: ${item.state}. ${args.stageId ? `${item.stageId}: ${item.stageDetail?.state}. ${item.verdict ?? ""}. ${item.summary}` : item.stages.map(stage=>`${stage.title}: ${stage.state}`).join(". ")}`,600),truncated:rows(source.stages).length>12 || (Array.isArray(object(source.attempt).findings) && (object(source.attempt).findings as unknown[]).length>5)};
    }
    if (name === "agent_fleet") {
      const summary = object(source.summary ?? source), counts = object(summary.agents);
      const engines = Object.entries(object(summary.byEngine)).map(([engine,pair]) => `${engine}: ${Array.isArray(pair) ? pair[1] : 0} running`).join(". ");
      const result: SpeechReadResult = { item: summary,
        ...(Array.isArray(source.agents) ? { rows: source.agents, shown: source.agents.length, total: Number(source.total ?? source.agents.length),
          nextCursor: typeof source.nextCursor === "string" ? source.nextCursor : null } : {}),
        speech: short(`${counts.live ?? 0} live agents, ${counts.running ?? 0} running. ${engines}. ${counts.limitWait ?? 0} waiting for an account limit. ${counts.stalled ?? 0} stalled.${summary.coverage ? " Some evidence is pending or stale; these counts are partial." : ""}`,600),
        ...(summary.coverage ? {coverage:object(summary.coverage)} : {}),
        truncated: source.hasMore === true || !!summary.coverage };
      if (Buffer.byteLength(JSON.stringify(result)) > 4000) throw new Error("ANSWER_TOO_LARGE");
      return result;
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
