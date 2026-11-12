import { buildNeedsYouQueue, type MobileAttentionEntry } from "@/components/attention/attentionQueue";
import { attentionReason, dismissalCovers } from "@/components/attention";
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
import { laneRouteNow } from "./routeTypes";

export const NEEDS_YOU_ROW_KINDS = ["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask", "lane-decision", "lane-review", "prototype", "update"] as const;
export type NeedsYouRowKind = typeof NEEDS_YOU_ROW_KINDS[number];
export interface NeedsYouBody { files: readonly FileEntry[]; pipelines: readonly Pipeline[]; tasks: readonly BoardTask[]; workLinks?: import("@/lib/forge/workLinks").FilesWorkLinks;
  /** The orchestrators' own open questions (docs/design/operator-decision-forms.md §2.2). */
  seatDecisions?: readonly import("@/lib/prototypeReview/types").PrototypeReviewNotice[] }
export interface NeedsYouEvidence { code: string; stale: boolean; at: string | null; detail: string; source: string }
export interface NeedsYouRow {
  id: string; kind: NeedsYouRowKind; title: string;
  /** One sentence: what the operator must choose or do, and what happens next. */
  line: string;
  /** The question in its author's words and its choices, when the row has them. */
  question?: string; options?: string[]; recommended?: number;
  since: string | null; taskId: string | null;
  subject: { conversationId?: string; pipelineId?: string; stageId?: string; reportSeq?: number; reviewId?: string; decisionId?: string };
  target: DismissalTarget | null; stale: boolean; evidence: Array<string | NeedsYouEvidence>; path?: string;
}
export interface ClearedRow {
  id: string; kind: NeedsYouRowKind; title: string; taskId: string | null;
  cleared: { at: string; by: DismissedBy; note: string | null }; undo: DismissalTarget;
}
export interface NeedsYouAnswer {
  project: string; at: string; count: number; staleCount: number; rows: NeedsYouRow[]; cleared: ClearedRow[]; omittedCount: number;
  /** Waits in this project its seat answers first (docs/design/attention-auto-resolve.md):
      never in `count`, and on the seat's own agenda. */
  routedToSeat?: number;
  nextCursor?: string; unavailable?: string[]; sections?: number;
  partial?: true; omissions?: string[]; countIsLowerBound?: true;
}
export interface NeedsYouEvidencePorts {
  tasks: readonly BoardTask[]; pipelines: readonly Pipeline[]; dismissals: readonly AttentionDismissalV1[];
  reports: BridgeReportLogV1 | null; admissions: readonly { conversationId: string; at: string }[];
  workLinks?: import("@/lib/forge/workLinks").FilesWorkLinks;
  canonicalConversationId?(id: string): string;
  ended?: ReadonlySet<string>; unavailable: readonly string[];
}
export interface NeedsYouReadOptions { kinds?: readonly NeedsYouRowKind[]; full?: boolean; cursor?: string; locale?: Locale; signal?: AbortSignal; deadlineAt?: number }

/** One projection shared with both panels; closing is a browser transient. */
export function needsYouEntries(body: NeedsYouBody, decision: AutoView["decision"], now: number, project: string): MobileAttentionEntry[] {
  const key = canonicalOrchestratorProject(project);
  return needsYouSections(buildNeedsYouQueue(withoutArchivedPredecessors([...body.files]), body.pipelines, now, [], decision, body.tasks, body.seatDecisions), key)
    .filter(section => canonicalOrchestratorProject(section.project) === key).flatMap(section => section.entries);
}
const readEnded = (options: NeedsYouReadOptions) => options.signal?.aborted || options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
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
    if (lane.merge && (PIPELINE_MERGE_LIVE_STATES.has(lane.merge.state) || lane.merge.state === "refreshing" || lane.merge.state === "merged")) add("merge-queued", true, `Merge ${lane.merge.state}`, "pipelines", lane.merge.updatedAt);
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
    if (entry.notice.undelivered) add("undelivered", false, "The round is decided and its message keeps failing to reach the seat; Delegatus retries it", "tasks",
      task?.prototypeReviews?.find(r => r.id === entry.notice.reviewId)?.decision?.delivery.failingSince ?? null);
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
  /* A seat's own question is answered, never hidden: it has no dismissal. */
  const target: DismissalTarget | null = entry.kind === "update" ? null : entry.kind === "prototype" ? entry.notice.taskId === null || entry.notice.undelivered ? null : { kind: "prototype", taskId: entry.notice.taskId, reviewId: entry.notice.reviewId }
    : needsYouSubject(entry) as DismissalTarget;
  return { id: entry.id, kind: entry.kind === "conversation" ? entry.item.reason.kind : entry.kind === "pipeline" ? entry.row.pipeline.state === "needs_review" ? "lane-review" : "lane-decision" : entry.kind,
    title: clip(text.title, 90), line: clip(text.line, 400),
    ...(text.question ? { question: clip(text.question, 600) } : {}),
    ...(text.options.length ? { options: text.options.map(option => clip(option, 160)) } : {}),
    ...(text.recommended !== null ? { recommended: text.recommended } : {}),
    since: iso(needsYouEntrySince(entry)), taskId: task?.id ?? null, subject, target,
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
  const live = needsYouEntries(raw, decision, now, project).flatMap((entry): ClearedRow[] => {
    if (readEnded(options) || visible.has(entry.id) || entry.kind === "update") return [];
    const row = rowOf(entry, ports, options);
    if (options.kinds && !options.kinds.includes(row.kind)) return [];
    let undo = row.target;
    let mark: { at: string; by: DismissedBy; note?: string } | undefined;
    if (entry.kind === "prototype") mark = ports.dismissals.find(d => d.kind === "prototype" && d.taskId === entry.notice.taskId && d.subject === entry.id);
    else if (entry.kind === "pipeline") {
      const p = body.pipelines.find(p => p.id === entry.row.pipeline.id);
      if (p?.dismissedAt && p.dismissedBy) mark = { at: p.dismissedAt, by: p.dismissedBy, note: p.dismissedNote };
    } else if (entry.item.reason.report) {
      mark = ports.reports?.resolvedAsks?.find(r => r.seq === entry.item.reason.report?.seq);
      if (!mark) {
        const record = ports.dismissals.find(d => d.kind !== "prototype" && d.kind !== "escalation" && !d.restoredAt
          && (d.conversationId && d.conversationId === entry.item.file.conversationId || d.path === entry.item.file.path)
          && dismissalCovers(entry.item.reason, d));
        if (record) {
          mark = record;
          // A task/conversation clear lives on the conversation, so undo must
          // remove that covering record rather than resolve an individual ask.
          undo = record.conversationId ? { kind: "conversation", conversationId: record.conversationId }
            : record.path ? { kind: "conversation", path: record.path } : null;
        }
      }
    } else mark = ports.dismissals.find(d => d.kind !== "prototype" && d.kind !== "escalation" && !d.restoredAt && (d.conversationId && d.conversationId === entry.item.file.conversationId || d.path === entry.item.file.path));
    if (!mark || !undo) return [];
    return [{ id: row.id, kind: row.kind, title: row.title, taskId: row.taskId, cleared: { at: mark.at, by: mark.by, note: mark.note ?? null }, undo }];
  });
  return [...live, ...systemClearedRows(body, project, ports, live, options)].filter(row => !options.kinds || options.kinds.includes(row.kind)).sort((a,b) => b.cleared.at.localeCompare(a.cleared.at)).slice(0,20);
}

/**
 * What Delegatus cleared, from its own records rather than from a reason that
 * still asks (docs/design/attention-auto-resolve.md, acceptance 2). Clearing
 * usually follows the source going quiet (an answered ask is no longer
 * raised), so the record carries what it hid: the reason, its title and its
 * project, and Undo names the conversation's record. One the operator brought
 * back is no longer cleared.
 */
function systemClearedRows(body: NeedsYouBody, project: string, ports: NeedsYouEvidencePorts, live: readonly ClearedRow[], options: NeedsYouReadOptions): ClearedRow[] {
  const key = canonicalOrchestratorProject(project);
  const canonical = ports.canonicalConversationId ?? ((id: string) => id);
  const shown = new Set(live.flatMap(row => row.undo.kind === "conversation"
    ? [
        ...(row.undo.conversationId ? [canonical(row.undo.conversationId)] : []),
        ...(row.undo.path ? [row.undo.path] : []),
      ]
    : []));
  const rows: ClearedRow[] = [];
  for (const record of ports.dismissals) {
    if (readEnded(options)) break;
    if (record.by.kind !== "system" || record.restoredAt || !record.cleared || record.kind === "prototype" || record.kind === "escalation") continue;
    if (canonicalOrchestratorProject(record.cleared.project) !== key) continue;
    const subject = record.conversationId ? canonical(record.conversationId) : record.path;
    if (!subject || shown.has(subject)) continue;
    shown.add(subject);
    const file = body.files.find(f => record.conversationId && f.conversationId && canonical(f.conversationId) === subject || f.path === record.path);
    const undo: DismissalTarget = record.conversationId ? { kind: "conversation", conversationId: record.conversationId } : { kind: "conversation", path: record.path! };
    const task = ports.tasks.find(t => t.assignments.some(a => !!a.conversationId && !!record.conversationId && canonical(a.conversationId) === subject || !!file && a.path === file.path));
    rows.push({ id: record.reasonId ?? `${record.subject}:cleared:${record.at}`, kind: record.cleared.reason, title: clip(record.cleared.title || (file ? file.title : subject), 90),
      taskId: task?.id ?? null, cleared: { at: record.at, by: record.by, note: null }, undo });
  }
  return rows;
}

/** How many waits in a project its seat answers first. */
export function routedToSeat(body: Pick<NeedsYouBody, "files" | "pipelines">, now: number, project: string): number {
  const inProject = (raw: string) => canonicalOrchestratorProject(raw) === project;
  const conversations = withoutArchivedPredecessors([...body.files]).filter(file => {
    if (!inProject(file.project)) return false;
    const reason = attentionReason(file, now);
    return Boolean(reason && !reason.dismissal && reason.route?.owner === "seat");
  }).length;
  const lanes = body.pipelines.filter(pipeline => inProject(pipeline.project) && laneRouteNow(pipeline)?.owner === "seat").length;
  return conversations + lanes;
}

/** Forty rows and 24 KB, including the cleared list and pagination envelope. */
export function needsYouAnswer(body: NeedsYouBody, decision: AutoView["decision"], now: number, project: string, ports: NeedsYouEvidencePorts, options: NeedsYouReadOptions = {}, order: "panel" | "stale-first" = "panel"): NeedsYouAnswer {
  const entries = needsYouEntries(body, decision, now, project);
  const selected = entries.filter(entry => !options.kinds || options.kinds.includes(entry.kind === "conversation" ? entry.item.reason.kind
    : entry.kind === "pipeline" ? entry.row.pipeline.state === "needs_review" ? "lane-review" : "lane-decision" : entry.kind));
  const all: NeedsYouRow[] = [];
  for (const entry of selected) {
    if (readEnded(options)) break;
    all.push(rowOf(entry, ports, options));
  }
  const projectionOmitted = selected.length - all.length;
  if (order === "stale-first") all.sort((a,b) => Number(b.stale) - Number(a.stale));
  const filtered = options.kinds ? all.filter(r => options.kinds!.includes(r.kind)) : all;
  const cursor = projectionOmitted ? undefined : options.cursor;
  const start = cursor ? filtered.findIndex(r => r.id === cursor) + 1 : 0;
  if (cursor && !start) throw new DismissalError("INVALID_CURSOR", "The row cursor is no longer on this panel; read again");
  const answer: NeedsYouAnswer = { project: canonicalOrchestratorProject(project), at: new Date(now * 1000).toISOString(), count: selected.length, staleCount: all.filter(r => r.stale).length,
    rows: [], cleared: readEnded(options) ? [] : clearedRows(body, decision, now, project, ports, options), omittedCount: filtered.length - start + projectionOmitted,
    ...(ports.unavailable.length ? { unavailable: [...new Set(ports.unavailable)] } : {}) };
  const sections = readEnded(options) ? 0 : needsYouSections(buildNeedsYouQueue(withoutArchivedPredecessors([...body.files]), body.pipelines, now, [], decision, body.tasks, body.seatDecisions), project).filter(s => canonicalOrchestratorProject(s.project) === answer.project).length;
  if (sections > 1) answer.sections = sections;
  const routed = readEnded(options) ? 0 : routedToSeat(body, now, answer.project);
  if (routed) answer.routedToSeat = routed;
  for (const row of filtered.slice(start, start + 40)) {
    const candidate = { ...answer, rows: [...answer.rows, row], omittedCount: filtered.length - start - answer.rows.length - 1 + projectionOmitted, nextCursor: row.id };
    while (Buffer.byteLength(JSON.stringify(candidate)) > 24_000 && candidate.cleared.length) candidate.cleared = candidate.cleared.slice(0,-1);
    if (Buffer.byteLength(JSON.stringify(candidate)) > 24_000) break;
    Object.assign(answer, candidate);
  }
  while (Buffer.byteLength(JSON.stringify(answer)) > 24_000 && answer.cleared.length) answer.cleared.pop();
  if (projectionOmitted || readEnded(options)) {
    answer.partial = true;
    answer.countIsLowerBound = true;
    answer.omissions = [...(projectionOmitted ? ["row-evidence"] : []), "cleared", "section-counts"];
    delete answer.nextCursor;
  }
  if (!answer.omittedCount) delete answer.nextCursor;
  while (Buffer.byteLength(JSON.stringify(answer)) > 24_000 && answer.rows.length) { answer.rows.pop(); answer.omittedCount++; }
  return answer;
}

/** Sources are selected before imports or reads. Each wait shares the route's cutoff. */
export interface NeedsYouReadSources {
  board(signal: AbortSignal): Promise<NeedsYouBody>;
  tasks(signal: AbortSignal): Promise<readonly BoardTask[]>;
  pipelines(signal: AbortSignal): Promise<readonly Pipeline[]>;
  dismissals(signal: AbortSignal): Promise<AttentionDismissalV1[]>;
  reports(signal: AbortSignal): Promise<BridgeReportLogV1 | null>;
  admissions(signal: AbortSignal): Promise<{ conversationId: string; at: string }[]>;
  identity(signal: AbortSignal): Promise<(id: string) => string>;
  ended(project: string, signal: AbortSignal, remainingMs: number): Promise<{ ids: Set<string>; complete: boolean }>;
  decision(signal: AbortSignal): Promise<AutoView["decision"]>;
  locale(signal: AbortSignal): Promise<Locale>;
}
const productionSources: NeedsYouReadSources = {
  board: async signal => (await import("@/app/api/files/operatorProjection")).operatorBoardRepresentation(signal),
  tasks: async signal => { const store = await import("@/lib/tasks/store"); signal.throwIfAborted(); return store.loadTasksForList(); },
  pipelines: async signal => { const store = await import("@/lib/pipelines/store"); signal.throwIfAborted(); return store.loadPipelinesForList(); },
  dismissals: async signal => { const store = await import("./dismissals"); signal.throwIfAborted(); return store.readAttentionDismissals().records; },
  reports: async signal => { const store = await import("@/lib/bridge/store"); signal.throwIfAborted(); return store.readBridgeReportLog(); },
  admissions: async signal => { const store = await import("@/lib/suggestions/store"); signal.throwIfAborted(); return store.readReplySuggestionsFile().admissions; },
  identity: async signal => {
    const registry = await import("@/lib/agent/registry");
    signal.throwIfAborted();
    const snapshot = await registry.agentRegistry().prepareReadOnlySnapshot(signal);
    signal.throwIfAborted();
    const lookup = registry.readOnlyConversationLookupFromSnapshot(snapshot);
    return id => lookup.canonicalConversationId(id as `conversation_${string}`);
  },
  ended: async (project, signal, remainingMs) => {
    const liveness = await import("@/lib/lifecycle/liveness");
    signal.throwIfAborted();
    const snapshot = await liveness.agentLivenessSnapshot({ project, signal, limit: 200, evidenceDeadlineMs: Math.min(1000, remainingMs) }, liveness.productionLivenessSources());
    return { ids: new Set(snapshot.conversations.filter(row => row.lifecycle === "gone" && row.conversationId).map(row => row.conversationId!)), complete: snapshot.selection.budget === "complete" };
  },
  decision: async signal => { const store = await import("@/lib/selfUpdate/instance"); signal.throwIfAborted(); return (await store.selfUpdateService().snapshot()).auto?.decision ?? null; },
  locale: async signal => { const store = await import("@/lib/operator/settings"); signal.throwIfAborted(); return store.operatorLocale() ?? "en"; },
};

export const NEEDS_YOU_READ_BUDGET_MS = 3500;
export async function readNeedsYou(project: string, options: NeedsYouReadOptions = {}, order: "panel" | "stale-first" = "panel", sources: NeedsYouReadSources = productionSources): Promise<NeedsYouAnswer> {
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + NEEDS_YOU_READ_BUDGET_MS);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("attention read budget exhausted")), Math.max(0, deadlineAt - Date.now()));
  const unavailable: string[] = [];
  const omissions: string[] = [];
  const source = async <T>(name: string, read: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> => {
    if (signal.aborted || Date.now() >= deadlineAt) { omissions.push(name); return fallback; }
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); }), cancelled]);
      // A native read can run beyond expiry before its timer gets a turn.
      if (signal.aborted || Date.now() >= deadlineAt) { omissions.push(name); return fallback; }
      return value;
    } catch { unavailable.push(name); omissions.push(name); return fallback; }
    finally { signal.removeEventListener("abort", abort); }
  };
  try {
    const wants = (kinds: readonly NeedsYouRowKind[]) => !options.kinds || options.kinds.some(kind => kinds.includes(kind));
    const conversations = wants(["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask"]);
    const boardNeeded = conversations || wants(["lane-decision", "lane-review", "prototype"]);
    const body = boardNeeded ? await source("board", () => sources.board(signal), { files: [], pipelines: [], tasks: [] }) : { files: [], pipelines: [], tasks: [] };
    const tasks = boardNeeded ? await source("tasks", sources.tasks, []) : [];
    const pipelines = boardNeeded ? await source("pipelines", sources.pipelines, []) : [];
    const dismissals = boardNeeded ? await source("dismissals", sources.dismissals, []) : [];
    const reports = wants(["decision"]) ? await source("bridge", sources.reports, null) : null;
    const admissions = conversations ? await source("reply-suggestions", sources.admissions, []) : [];
    const canonicalConversationId = conversations ? await source("identity", sources.identity, (id: string) => id) : (id: string) => id;
    const liveness = conversations ? await source("liveness", () => sources.ended(project, signal, Math.max(0, deadlineAt - Date.now())), { ids: new Set<string>(), complete: false }) : { ids: new Set<string>(), complete: true };
    if (!liveness.complete) { unavailable.push("liveness"); omissions.push("liveness"); }
    const decision = wants(["update"]) ? await source("self-update", sources.decision, null) : null;
    const locale = options.locale ?? await source("locale", sources.locale, "en");
    if (needsYouEntries(body, null, Date.now() / 1000, project).some(entry => entry.kind === "pipeline" && (!body.workLinks?.pipelines[entry.row.pipeline.id] || body.workLinks.pipelines[entry.row.pipeline.id].links.some(link => link.kind === "pr" && link.state === null)))) unavailable.push("forge");
    // A partial collection cannot validate a cursor into missing data.
    const answer = needsYouAnswer(body, decision, Date.now() / 1000, project, { tasks, pipelines, dismissals, reports, admissions, ended: liveness.ids, canonicalConversationId, workLinks: body.workLinks, unavailable }, { ...options, signal, deadlineAt, ...(omissions.length ? { cursor: undefined } : {}), locale }, order);
    if (omissions.length) Object.assign(answer, { partial: true, omissions: [...new Set([...omissions, ...(answer.omissions ?? [])])], countIsLowerBound: true });
    while (Buffer.byteLength(JSON.stringify(answer)) > 24_000 && answer.rows.length) { answer.rows.pop(); answer.omittedCount++; }
    if (answer.partial) delete answer.nextCursor;
    return answer;
  } finally { clearTimeout(timer); }
}
