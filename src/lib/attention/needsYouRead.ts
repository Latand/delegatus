import { buildNeedsYouQueue, type MobileAttentionEntry } from "@/components/attention/attentionQueue";
import { needsYouEntrySince, needsYouRowText, needsYouSections, needsYouSubject } from "@/components/attention/needsYouPanel";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { bridgeQuestions, openBridgeAsks } from "@/lib/bridge/asks";
import { BRIDGE_ASK_TTL_SECONDS, type BridgeReportLogV1 } from "@/lib/bridge/types";
import { translate, type Locale } from "@/lib/i18n/core";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import { PIPELINE_MERGE_LIVE_STATES, type Pipeline } from "@/lib/pipelines/types";
import type { AutoView } from "@/lib/selfUpdate/auto";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { AttentionDismissalV1 } from "./dismissals";
import { DismissalError } from "./dismissals";
import type { DismissalTarget, DismissedBy } from "./dismissalTypes";

export const NEEDS_YOU_ROW_KINDS = ["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask", "lane-decision", "lane-review", "prototype", "update"] as const;
export type NeedsYouRowKind = typeof NEEDS_YOU_ROW_KINDS[number];
export interface NeedsYouBody { files: readonly FileEntry[]; pipelines: readonly Pipeline[]; tasks: readonly BoardTask[]; workLinks?: import("@/lib/forge/workLinks").FilesWorkLinks }
export interface NeedsYouEvidence { code: string; stale: boolean; at: string | null; detail: string; source: string }
export interface NeedsYouRow {
  id: string; kind: NeedsYouRowKind; title: string; line: string; since: string | null; taskId: string | null;
  subject: { conversationId?: string; pipelineId?: string; stageId?: string; reportSeq?: number; reviewId?: string; decisionId?: string };
  target: DismissalTarget | null; stale: boolean; evidence: Array<string | NeedsYouEvidence>; path?: string;
}
export interface ClearedRow {
  id: string; kind: NeedsYouRowKind; title: string; taskId: string | null;
  cleared: { at: string; by: DismissedBy; note: string | null }; undo: DismissalTarget;
}
export interface NeedsYouAnswer {
  project: string; at: string; count: number; staleCount: number; rows: NeedsYouRow[]; cleared: ClearedRow[]; omittedCount: number;
  nextCursor?: string; unavailable?: string[]; sections?: number;
}
export interface NeedsYouEvidencePorts {
  tasks: readonly BoardTask[]; pipelines: readonly Pipeline[]; dismissals: readonly AttentionDismissalV1[];
  reports: BridgeReportLogV1 | null; admissions: readonly { conversationId: string; at: string }[];
  workLinks?: import("@/lib/forge/workLinks").FilesWorkLinks;
  canonicalConversationId?(id: string): string;
  ended?: ReadonlySet<string>; unavailable: readonly string[];
}
export interface NeedsYouReadOptions { kinds?: readonly NeedsYouRowKind[]; full?: boolean; cursor?: string; locale?: Locale }

/** One projection shared with both panels; closing is a browser transient. */
export function needsYouEntries(body: NeedsYouBody, decision: AutoView["decision"], now: number, project: string): MobileAttentionEntry[] {
  const key = canonicalOrchestratorProject(project);
  return needsYouSections(buildNeedsYouQueue(withoutArchivedPredecessors([...body.files]), body.pipelines, now, [], decision, body.tasks), key)
    .filter(section => canonicalOrchestratorProject(section.project) === key).flatMap(section => section.entries);
}
const iso = (seconds: number | null) => seconds !== null && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
const clip = (value: string, cap: number) => value.length > cap ? value.slice(0, cap - 1) + "…" : value;
const after = (value: string | number | null | undefined, since: number) => (typeof value === "number" ? value : Date.parse(value ?? "")) > since;
function taskOf(entry: MobileAttentionEntry, ports: NeedsYouEvidencePorts): BoardTask | undefined {
  if (entry.kind === "prototype") return ports.tasks.find(task => task.id === entry.notice.taskId);
  if (entry.kind === "pipeline") return ports.tasks.find(task => entry.row.pipeline.taskIds?.includes(task.id));
  if (entry.kind === "update") return undefined;
  const canonical = ports.canonicalConversationId ?? ((id: string) => id);
  return ports.tasks.find(task => task.assignments.some(a => a.path === entry.item.file.path || !!a.conversationId && !!entry.item.file.conversationId && canonical(a.conversationId) === canonical(entry.item.file.conversationId) || entry.item.file.path.startsWith("spawn:") && a.launchId === entry.item.file.path.slice(6)));
}

/** Facts only. The seat decides what each fact means for this question. */
export function needsYouEvidence(entry: MobileAttentionEntry, ports: NeedsYouEvidencePorts): NeedsYouEvidence[] {
  const facts: NeedsYouEvidence[] = [];
  const add = (code: string, stale: boolean, detail: string, source: string, at: string | null = null) => {
    if (!facts.some(f => f.code === code)) facts.push({ code, stale, detail: clip(detail, 140), source, at });
  };
  const canonical = ports.canonicalConversationId ?? ((id: string) => id);
  const since = (needsYouEntrySince(entry) ?? Infinity) * 1000;
  const task = taskOf(entry, ports);
  if (entry.kind !== "update" && entry.kind !== "pipeline" && task?.status === "done") add("task-done", true, "The task is done", "tasks", task.updatedAt);
  if (entry.kind === "conversation") {
    const { file, reason } = entry.item;
    const admission = ports.admissions.filter(a => !!file.conversationId && canonical(a.conversationId) === canonical(file.conversationId) && after(a.at, since)).sort((a,b) => b.at.localeCompare(a.at))[0];
    if (admission) add("operator-wrote", true, "A later operator message was admitted", "reply-suggestions", admission.at);
    if (file.lastTurn && after(file.lastTurn.startedAt, since)) add("later-turn", true, "A later turn started", "files", new Date(file.lastTurn.startedAt).toISOString());
    if (file.proc === "done" || file.proc === "killed" || file.conversationId && ports.ended?.has(file.conversationId)) add("ended", true, "The conversation ended", "liveness");
    for (const member of file.durableLineage?.memberships ?? []) {
      if (member.kind !== "pipeline") continue;
      const lane = ports.pipelines.find(p => p.id === member.containerId);
      if (lane && (["completed", "closed"].includes(lane.state) || laneMovedAt(lane) > since)) add("lane-moved", true, "The conversation's lane moved or ended", "pipelines", iso(laneMovedAt(lane) / 1000));
    }
    if (reason.kind === "launch" && task?.assignments.some(a => after(a.at, since))) add("relaunched", true, "The task gained a later assignment", "tasks");
    if (reason.kind === "memory" && file.lastTurn && after(file.lastTurn.startedAt, Date.parse(file.memoryKill?.at ?? ""))) add("resumed", true, "A turn started after the memory kill", "files");
    if (reason.report) {
      const later = ports.reports?.reports.filter(r => !!r.targetSeatConversationId && !!file.conversationId && canonical(r.targetSeatConversationId) === canonical(file.conversationId) && r.seq > reason.report!.seq) ?? [];
      const newest = later.at(-1);
      if (newest) add("seat-reported", false, `${later.length} later reports; newest ${newest.class}: ${newest.body.split("\n")[0]}`, "bridge", newest.at);
      add("expires", false, "The report question expires after two hours", "bridge", iso((needsYouEntrySince(entry) ?? 0) + BRIDGE_ASK_TTL_SECONDS));
      const question = ports.reports && bridgeQuestions(ports.reports, { now: new Date(), canonicalConversationId: canonical }).find(q => q.report.seq === reason.report!.seq);
      if (question?.state === "answered" || question?.state === "resolved") add("report-answered", true, "The report question was answered or resolved", "bridge");
    }
  } else if (entry.kind === "pipeline") {
    const lane = entry.row.pipeline;
    const links = ports.workLinks?.pipelines[lane.id];
    for (const link of links?.links ?? []) {
      if (link.state === "merged" || link.state === "closed") add(`pr-${link.state}`, true, `The pull request is ${link.state}`, "forge", link.checkedAt);
    }
    if (lane.merge && (PIPELINE_MERGE_LIVE_STATES.has(lane.merge.state) || lane.merge.state === "merged")) add("merge-queued", true, `Merge ${lane.merge.state}`, "pipelines", lane.merge.updatedAt);
    const tasks = ports.tasks.filter(t => lane.taskIds?.includes(t.id));
    if (ports.pipelines.some(p => p.id !== lane.id && p.taskIds?.some(id => lane.taskIds?.includes(id)) && after(p.createdAt, since)) || tasks.some(t => t.assignments.some(a => after(a.at, since)))) add("newer-work", true, "The task gained newer work after this lane parked", "pipelines/tasks");
    if (tasks.length && tasks.every(t => t.status === "done")) add("task-done", true, "Every task on this lane is done", "tasks");
    if (lane.stateDetail) add("detail", false, lane.stateDetail.split("\n")[0], "pipelines");
  } else if (entry.kind === "prototype") {
    const rounds = task?.prototypeReviews ?? task?.prototypeReviewReplica?.rounds ?? [];
    const index = rounds.findIndex(r => r.id === entry.notice.reviewId);
    const round = rounds[index];
    const later = rounds.slice(index + 1).find(r => r.decision);
    if (index >= 0 && later?.decision) add("later-round-decided", true, "A later round was decided", "tasks", later.decision.at);
    const lane = round?.source.pipelineId ? ports.pipelines.find(p => p.id === round.source.pipelineId) : undefined;
    const sourceIndex = lane?.stages.findIndex(s => s.id === round?.source.stageId) ?? -1;
    if (lane && (["completed", "closed"].includes(lane.state) || sourceIndex >= 0 && lane.runs.some(r => lane.stages.findIndex(s => s.id === r.stageId) > sourceIndex && r.attempts.some(a => after(a.startedAt, since))))) add("lane-moved-past", true, "The publishing lane moved past this round", "pipelines", iso(laneMovedAt(lane) / 1000));
    if (task?.prototypeReviewReplica) add("elsewhere", false, "This review belongs to another installation", "tasks");
  } else {
    add("answer-only", false, "The operator chooses deploy now or keep waiting", "self-update");
    if (entry.decision.blockers) add("blockers", false, JSON.stringify(entry.decision.blockers), "self-update", entry.decision.at);
  }
  return facts;
}

function rowOf(entry: MobileAttentionEntry, ports: NeedsYouEvidencePorts, options: NeedsYouReadOptions): NeedsYouRow {
  const text = needsYouRowText((key, params) => translate(options.locale ?? "en", key, params), entry);
  const task = taskOf(entry, ports);
  const subject: NeedsYouRow["subject"] = entry.kind === "conversation" ? { ...(entry.item.file.conversationId ? { conversationId: entry.item.file.conversationId } : {}), ...(entry.item.reason.report ? { reportSeq: entry.item.reason.report.seq } : {}) }
    : entry.kind === "pipeline" ? { pipelineId: entry.row.pipeline.id, ...(entry.row.pipeline.cursor?.stageId ? { stageId: entry.row.pipeline.cursor.stageId } : {}) }
    : entry.kind === "prototype" ? { reviewId: entry.notice.reviewId } : { decisionId: entry.decision.id };
  const facts = needsYouEvidence(entry, ports);
  const target: DismissalTarget | null = entry.kind === "update" ? null : entry.kind === "prototype" ? { kind: "prototype", taskId: entry.notice.taskId, reviewId: entry.notice.reviewId }
    : needsYouSubject(entry) as DismissalTarget;
  return { id: entry.id, kind: entry.kind === "conversation" ? entry.item.reason.kind : entry.kind === "pipeline" ? entry.row.pipeline.state === "needs_review" ? "lane-review" : "lane-decision" : entry.kind,
    title: clip(text.title, 90), line: clip(text.line, 160), since: iso(needsYouEntrySince(entry)), taskId: task?.id ?? null, subject, target,
    stale: facts.some(f => f.stale), evidence: facts.slice(0, options.full ? facts.length : 4).map(f => options.full ? f : clip(`${f.code}: ${f.detail}`, 140)),
    ...(options.full && entry.kind === "conversation" ? { path: entry.item.file.path } : {}) };
}

function clearedRows(body: NeedsYouBody, decision: AutoView["decision"], now: number, project: string, ports: NeedsYouEvidencePorts, options: NeedsYouReadOptions): ClearedRow[] {
  const canonical = ports.canonicalConversationId ?? ((id: string) => id);
  const asks = ports.reports ? openBridgeAsks({ ...ports.reports, resolvedAsks: [] }, { now: new Date(now * 1000), canonicalConversationId: canonical }) : new Map();
  const raw: NeedsYouBody = { files: body.files.map(f => ({ ...f, attentionDismissal: undefined, ...(f.conversationId && asks.has(canonical(f.conversationId)) ? { bridgeAsks: asks.get(canonical(f.conversationId)), bridgeAsk: asks.get(canonical(f.conversationId))?.at(-1) } : {}) })),
    pipelines: body.pipelines.map(p => ({ ...p, dismissedAt: null, dismissedBy: undefined })),
    tasks: body.tasks.map(t => ({ ...t, prototypeReview: t.prototypeReview ? { ...t.prototypeReview, waitingDismissal: undefined } : undefined })) };
  const visible = new Set(needsYouEntries(body, decision, now, project).map(e => e.id));
  return needsYouEntries(raw, decision, now, project).flatMap(entry => {
    if (visible.has(entry.id) || entry.kind === "update") return [];
    const row = rowOf(entry, ports, options);
    let mark: { at: string; by: DismissedBy; note?: string } | undefined;
    if (entry.kind === "prototype") mark = ports.dismissals.find(d => d.kind === "prototype" && d.taskId === entry.notice.taskId && d.subject === entry.id);
    else if (entry.kind === "pipeline") {
      const p = body.pipelines.find(p => p.id === entry.row.pipeline.id);
      if (p?.dismissedAt && p.dismissedBy) mark = { at: p.dismissedAt, by: p.dismissedBy, note: p.dismissedNote };
    } else if (entry.item.reason.report) mark = ports.reports?.resolvedAsks?.find(r => r.seq === entry.item.reason.report?.seq);
    else mark = ports.dismissals.find(d => d.kind !== "prototype" && (d.conversationId && d.conversationId === entry.item.file.conversationId || d.path === entry.item.file.path));
    if (!mark || !row.target) return [];
    return [{ id: row.id, kind: row.kind, title: row.title, taskId: row.taskId, cleared: { at: mark.at, by: mark.by, note: mark.note ?? null }, undo: row.target }];
  }).sort((a,b) => b.cleared.at.localeCompare(a.cleared.at)).slice(0,20);
}

/** Forty rows and 24 KB, including the cleared list and pagination envelope. */
export function needsYouAnswer(body: NeedsYouBody, decision: AutoView["decision"], now: number, project: string, ports: NeedsYouEvidencePorts, options: NeedsYouReadOptions = {}, order: "panel" | "stale-first" = "panel"): NeedsYouAnswer {
  const entries = needsYouEntries(body, decision, now, project);
  const all = entries.map(e => rowOf(e, ports, options));
  if (order === "stale-first") all.sort((a,b) => Number(b.stale) - Number(a.stale));
  const filtered = options.kinds ? all.filter(r => options.kinds!.includes(r.kind)) : all;
  const start = options.cursor ? filtered.findIndex(r => r.id === options.cursor) + 1 : 0;
  if (options.cursor && !start) throw new DismissalError("INVALID_CURSOR", "The row cursor is no longer on this panel; read again");
  const answer: NeedsYouAnswer = { project: canonicalOrchestratorProject(project), at: new Date(now * 1000).toISOString(), count: all.length, staleCount: all.filter(r => r.stale).length,
    rows: [], cleared: clearedRows(body, decision, now, project, ports, options), omittedCount: filtered.length - start,
    ...(ports.unavailable.length ? { unavailable: [...new Set(ports.unavailable)] } : {}) };
  const sections = needsYouSections(buildNeedsYouQueue(withoutArchivedPredecessors([...body.files]), body.pipelines, now, [], decision, body.tasks), project).filter(s => canonicalOrchestratorProject(s.project) === answer.project).length;
  if (sections > 1) answer.sections = sections;
  for (const row of filtered.slice(start, start + 40)) {
    const candidate = { ...answer, rows: [...answer.rows, row], omittedCount: filtered.length - start - answer.rows.length - 1, nextCursor: row.id };
    while (Buffer.byteLength(JSON.stringify(candidate)) > 24_000 && candidate.cleared.length) candidate.cleared = candidate.cleared.slice(0,-1);
    if (Buffer.byteLength(JSON.stringify(candidate)) > 24_000) break;
    Object.assign(answer, candidate);
  }
  while (Buffer.byteLength(JSON.stringify(answer)) > 24_000 && answer.cleared.length) answer.cleared.pop();
  if (!answer.omittedCount) delete answer.nextCursor;
  return answer;
}

/** Viewer-only gathering; unavailable evidence is named and never implies stale. */
export async function readNeedsYou(project: string, options: NeedsYouReadOptions = {}, order: "panel" | "stale-first" = "panel"): Promise<NeedsYouAnswer> {
  const [{ operatorBoardRepresentation }, { selfUpdateService }, { loadTasks }, { loadPipelinesForList }, { readAttentionDismissals }, { readBridgeReportLog }, { readReplySuggestionsFile }, { operatorLocale }, liveness, registry] = await Promise.all([
    import("@/app/api/files/operatorProjection"), import("@/lib/selfUpdate/instance"), import("@/lib/tasks/store"), import("@/lib/pipelines/store"),
    import("./dismissals"), import("@/lib/bridge/store"), import("@/lib/suggestions/store"), import("@/lib/operator/settings"), import("@/lib/lifecycle/liveness"), import("@/lib/agent/registry"),
  ]);
  const body = await operatorBoardRepresentation();
  const unavailable: string[] = [];
  const source = <T>(name: string, read: () => T, fallback: T): T => { try { return read(); } catch { unavailable.push(name); return fallback; } };
  const tasks = source("tasks", loadTasks, []);
  const pipelines = source("pipelines", loadPipelinesForList, []);
  const dismissals = source("dismissals", () => readAttentionDismissals().records, []);
  const reports = source<BridgeReportLogV1 | null>("bridge", readBridgeReportLog, null);
  const admissions = source("reply-suggestions", () => readReplySuggestionsFile().admissions, []);
  const lookup = registry.readOnlyConversationLookupFromSnapshot(registry.agentRegistry().readOnlySnapshot());
  const canonicalConversationId = (id: string) => lookup.canonicalConversationId(id as `conversation_${string}`);
  const ended = new Set<string>();
  try {
    const snapshot = await liveness.agentLivenessSnapshot({ project, limit: 200, evidenceDeadlineMs: 1000 }, liveness.productionLivenessSources());
    for (const row of snapshot.conversations) if (row.lifecycle === "gone" && row.conversationId) ended.add(row.conversationId);
    if (snapshot.selection.budget !== "complete") unavailable.push("liveness");
  } catch { unavailable.push("liveness"); }
  let decision: AutoView["decision"] = null;
  try { decision = (await selfUpdateService().snapshot()).auto?.decision; } catch { unavailable.push("self-update"); }
  if (needsYouEntries(body, null, Date.now() / 1000, project).some(entry => entry.kind === "pipeline" && (!body.workLinks?.pipelines[entry.row.pipeline.id] || body.workLinks.pipelines[entry.row.pipeline.id].links.some(link => link.kind === "pr" && link.state === null)))) unavailable.push("forge");
  return needsYouAnswer(body, decision, Date.now() / 1000, project, { tasks, pipelines, dismissals, reports, admissions, ended, canonicalConversationId, workLinks: body.workLinks, unavailable }, { ...options, locale: options.locale ?? operatorLocale() ?? "en" }, order);
}
