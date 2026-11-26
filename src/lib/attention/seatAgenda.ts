import { attentionReason } from "@/components/attention";
import { laneState } from "@/components/kanban/cardState";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import type { SeatTickWorkerAskInput } from "@/lib/monitor/types";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import type { Pipeline } from "@/lib/pipelines/types";
import { MERGE_REASON_PATTERNS, MERGE_REASONS } from "@/lib/forge/mergeReasons";
import { laneStopKind } from "@/lib/pipelines/laneStop";
import { latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import { interruptedStageLaunchFailure } from "@/lib/pipelines/interruptedLaunch";
import { indexMergeSuccessors, mergeSuccessor } from "@/lib/pipelines/mergeSuccessor";
import { cleanTitle } from "@/lib/title";
import { isWorkingAgent } from "@/components/workingAgents";
import { waitingRoute, waitingRouteIndex, type HoldPullRequestState, type PublishedRoundLookup } from "@/lib/tasks/waitingRoute";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { laneNeedKind, laneWaitCleared } from "./routeTypes";

/*
 * The seat's half of routing (docs/design/attention-auto-resolve.md,
 * «Implementation plan for acceptance 3»): every wait the projection routed to
 * a project's seat, as one line the seat tick puts on the wake. Each line says
 * who asked, what they asked in their own words, and the tool that answers it
 * where it asked, so the answer goes back to the asking conversation or lane;
 * and how to hand it to the operator when only they can decide.
 */

const LABEL_MAX = 700;
const QUESTION_MAX = 360;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** A native question in its author's words, with its numbered options. */
function nativeQuestion(file: FileEntry): string {
  const questions = file.pendingQuestion?.questions ?? [];
  if (!questions.length) return "see the conversation";
  return questions.map((question, index) => {
    const options = question.options.map((option, n) => `${n + 1}) ${option.label}${option.recommended ? " (recommended)" : ""}`).join(" ");
    return `${questions.length > 1 ? `${index + 1}. ` : ""}«${clip(question.question, 200)}»${options ? ` ${options}` : ""}${question.multiSelect ? " (several)" : ""}`;
  }).join("; ");
}

function conversationLine(file: FileEntry, reason: NonNullable<ReturnType<typeof attentionReason>>): string {
  const who = file.durableLineage?.role?.trim() || "agent";
  const title = clip(cleanTitle(file.title ?? "", 90) || who, 90);
  const id = file.conversationId ?? file.path;
  const escalate = `if only the operator can decide, ask them with publish_prototype_review, then dismiss_attention escalate {reviewId} with target {kind:"conversation", conversationId:"${id}", reasonId:"${reason.id}"}`;
  switch (reason.kind) {
    case "memory":
      return `${title} — ${who} was killed out of memory${reason.header ? ` (${clip(reason.header, 80)})` : ""}; resume it or close its work with conversation_action; ${escalate}`;
    case "permission":
      return `${title} — ${who} waits on a tool permission request${reason.header ? `: ${clip(reason.header, QUESTION_MAX)}` : ""}; answer it with conversation_action permission; ${escalate}`;
    case "question":
      return `${title} — ${who} asks you in its own question control: ${nativeQuestion(file)}; answer it with conversation_action answer, requestId "${reason.id}" and answers (the option numbers per question, from 1); ${escalate}`;
    case "plan":
      return `${title} — ${who} waits on approval of its plan${file.pendingQuestion?.plan ? `: «${clip(file.pendingQuestion.plan, QUESTION_MAX)}»` : ""}; approve or reject it with conversation_action answer, requestId "${reason.id}" and approve true or false; ${escalate}`;
    default:
      return `${title} — ${who} asks: «${clip(reason.header || "see its last message", QUESTION_MAX)}»; reply with send_message to ${id}, which reaches that conversation; ${escalate}`;
  }
}

/** A parked lane's question in the stage's own words. */
function laneQuestion(pipeline: Pipeline): string {
  const stageId = pipeline.cursor?.stageId;
  const attempt = stageId ? latestOperationalStageAttempt(pipeline, stageId) : null;
  const summary = attempt?.report?.verdict.status === "needs_decision" ? attempt.report.summary?.trim() : null;
  return summary ? `«${clip(summary, QUESTION_MAX)}»` : `stopped: ${clip(pipeline.stateDetail ?? "no reason recorded", QUESTION_MAX)}`;
}

/** The step a stopped merge takes, by the runner's reason
    (docs/design/calm-task-cards-build.md §7.2): a retry only helps where the
    next read can pass, so a PR that is gone is cleared and a conflict is
    refreshed first. */
function mergeStep(pipeline: Pipeline): string {
  const reason = pipeline.merge?.reason ?? null;
  const target = `{kind:"pipeline", pipelineId:"${pipeline.id}"}`;
  if (reason === MERGE_REASONS.closed || reason === MERGE_REASONS.noPr || reason === MERGE_REASONS.settingOff) {
    return `a retry stops again at once: check whether the change reached main another way or the lane had nothing to merge, then clear it with dismiss_attention target ${target} and a one-line reason (the same write as «Leave the PR open»)`;
  }
  if (reason === MERGE_REASONS.conflict || reason === MERGE_REASONS.mainMoving || reason === MERGE_REASONS.headChanged) {
    return "refresh it first: a lane that merges current main into this branch, resolves the conflict and has one review of the resolution, then pipeline_action retry-merge";
  }
  if (reason === MERGE_REASONS.checksTimeout || reason === MERGE_REASONS.noChecks || (reason && MERGE_REASON_PATTERNS.check.test(reason))) {
    return "pipeline_action retry-merge to re-read required checks; fix required failures first; optional failures are notes; unknown requirements keep every red check blocking";
  }
  return "repair it and pipeline_action retry-merge";
}

function laneLine(pipeline: Pipeline): string {
  const title = clip(pipeline.task || pipeline.id, 90);
  const stage = pipeline.cursor?.stageId ? ` stage ${pipeline.cursor.stageId}` : "";
  /* The class first, so the seat reads what kind of stop it is before the stage's own words. */
  const stop = laneStopKind(pipeline);
  const kind = stop ? `[${stop.kind}] ` : "";
  const escalate = `if only the operator can decide, ask them with publish_prototype_review, then dismiss_attention escalate {reviewId} with target {kind:"pipeline", pipelineId:"${pipeline.id}"}`;
  switch (laneNeedKind(pipeline)) {
    case "lane-merge":
      return `${kind}${mergeStep(pipeline)}; ${title} — completed; merge reason: ${clip(pipeline.merge?.reason ?? "no reason recorded", QUESTION_MAX)}; ${escalate}`;
    case "lane-review":
      return `${kind}${title} —${stage} review budget spent, the last fix was not re-reviewed; pipeline_action accept-head once it holds; ${escalate}`;
    default: {
      if (stop?.kind === "review") {
        return `${kind}${title} —${stage} ${laneQuestion(pipeline)}; inspect the retained review and its findings; review budget is fixed; close the lane with pipeline_action close if work cannot continue; ${escalate}`;
      }
      const attempt = pipeline.cursor ? latestOperationalStageAttempt(pipeline, pipeline.cursor.stageId) : null;
      if (attempt && !attempt.verdict && !attempt.report && pipeline.cursor
        && interruptedStageLaunchFailure(attempt.error, pipeline.stateDetail)) {
        const selector = attempt.launchId ? ` with stageId "${pipeline.cursor.stageId}" and launchId "${attempt.launchId}"` : "";
        return `${kind}${title} —${stage} ${laneQuestion(pipeline)}; pipeline_action retry-stage${selector} checks the original launch and reserves a fresh attempt if it never started; ${escalate}`;
      }
      if (stop?.kind !== "question" || (attempt?.verdict ?? attempt?.report?.verdict)?.status !== "needs_decision") {
        return `${kind}${title} —${stage} pipeline_action retry-stage; ${laneQuestion(pipeline)}; repair the stop; ${escalate}`;
      }
      return `${kind}${title} —${stage} asks ${laneQuestion(pipeline)}; answer with pipeline_action resolve-decision (expectedRevision from get_pipeline), or retry-stage for a mechanical stop; ${escalate}`;
    }
  }
}

/** The wait's agenda key: its route key, and the round it came back from
    when its escalation handed it back, so the seat is woken once for it. */
function agendaKey(route: { key: string; returnedFrom?: string }): string {
  return route.returnedFrom ? `${route.key}@returned:${route.returnedFrom}` : route.key;
}

/** Said first on a wait that came back from a decision round. */
function returnedNote(route: { returnedFrom?: string }): string {
  return route.returnedFrom
    ? `[back from decision round ${route.returnedFrom}: use read_prototype_review and carry out the answer or ask again if dismissed or replaced] `
    : "";
}

export interface SeatAgendaPauses {
  quotaReadyLaneIds?: readonly string[];
  deployLaneIds?: readonly string[];
}

/** Every wait the board routes to this project's seat, oldest first. */
export function seatAgendaAsks(
  body: { files: readonly FileEntry[]; pipelines: readonly Pipeline[]; tasks?: readonly BoardTask[]; seatRound?: PublishedRoundLookup; pullRequestState?: HoldPullRequestState },
  now: number, project: string, pauseWaitingTasks: Map<string, string[]> = new Map(),
  pauses: SeatAgendaPauses = {},
): SeatTickWorkerAskInput[] {
  const canonical = canonicalOrchestratorProject(project);
  const asks: SeatTickWorkerAskInput[] = [];
  const working = new Set<string>();
  for (const file of withoutArchivedPredecessors([...body.files])) {
    if (canonicalOrchestratorProject(file.project) !== canonical) continue;
    if (isWorkingAgent(file, now)) {
      working.add(file.path);
      if (file.conversationId) working.add(file.conversationId);
    }
    const reason = attentionReason(file, now);
    if (!reason || reason.dismissal || reason.route?.owner !== "seat") continue;
    asks.push({ key: agendaKey(reason.route), id: file.conversationId ?? file.path, label: clip(returnedNote(reason.route) + conversationLine(file, reason), LABEL_MAX), sinceMs: reason.since * 1000 });
  }
  const projectLanes = body.pipelines.filter(pipeline => canonicalOrchestratorProject(pipeline.project) === canonical);
  const waitingLaneTasks = new Map<string, string[]>();
  if (body.tasks?.length) {
    const projectTasks = body.tasks.filter(task => canonicalOrchestratorProject(task.project) === canonical);
    const index = waitingRouteIndex(body.tasks, projectLanes, working, {
      quota: new Set(pauses.quotaReadyLaneIds), deploy: new Set(pauses.deployLaneIds),
    }, body.pullRequestState, body.seatRound);
    for (const task of projectTasks) {
      if (task.status === "done" || (!task.hold && task.status !== "blocked")) continue;
      const liveMember = task.assignments.some(a => working.has(a.conversationId ?? "") || working.has(a.path ?? ""));
      const route = waitingRoute(task, index, now * 1000, liveMember);
      if (route?.owner !== "seat") continue;
      if (route.carriedBy === "task") {
        asks.push({ key: route.key, id: task.id, waitingTaskIds: [task.id],
          label: clip(`«${clip(cleanTitle(task.text, 90), 90)}» (task ${task.id}) — ${route.why}. ${route.action}`, LABEL_MAX),
          sinceMs: Date.parse(task.hold?.since ?? task.statusBy?.at ?? task.updatedAt) || null });
      } else {
        const byLane = route.rule === "pause-ready" ? pauseWaitingTasks : waitingLaneTasks;
        const linked = byLane.get(route.laneId);
        if (linked) linked.push(task.id);
        else byLane.set(route.laneId, [task.id]);
      }
    }
  }
  const successorOwners = indexMergeSuccessors(body.pipelines);
  const lanes = projectLanes
    .flatMap((pipeline) => {
      if (pipeline.hiddenAt || laneWaitCleared(pipeline) || mergeSuccessor(pipeline, successorOwners)) return [];
      const state = laneState(pipeline);
      const route = state.route;
      if (state.owner !== "seat" || !route) return [];
      const kind = laneNeedKind(pipeline)?.replace("lane-", "") ?? pipeline.state;
      const waitingTaskIds = waitingLaneTasks.get(pipeline.id)?.sort();
      const pages = waitingTaskIds?.length ? Array.from({ length: Math.ceil(waitingTaskIds.length / 4) }, (_, page) => waitingTaskIds.slice(page * 4, page * 4 + 4)) : [undefined];
      return pages.map((page, index) => {
        const waiting = page?.length ? `Waiting task(s) ${page.join(", ")}: re-send or clear their holds after settling the lane. ` : "";
        const key = agendaKey(route) + (page ? `@waiting:${index + 1}:${waitingTaskIds!.length}:${page.join(",")}` : "");
        return { key, id: pipeline.id, label: clip(`${returnedNote(route)}${waiting}${laneLine(pipeline)}`, LABEL_MAX),
          ...(page ? { waitingTaskIds: page } : {}), sinceMs: state.sinceMs,
          seatOwnedLane: { id: pipeline.id, title: pipeline.task || pipeline.id, sinceMs: state.sinceMs,
            reason: `${kind}: ${pipeline.merge?.state === "blocked" ? clip(pipeline.merge.reason ?? "merge stopped", 120) : pipeline.stateDetail ?? state.stop?.kind ?? pipeline.state}` } };
      });
    });
  const ordered: SeatTickWorkerAskInput[] = [...asks, ...lanes];
  return ordered.sort((a, b) => {
    const age = (a.sinceMs ?? Number.POSITIVE_INFINITY) - (b.sinceMs ?? Number.POSITIVE_INFINITY);
    if (age) return age;
    if (a.seatOwnedLane && b.seatOwnedLane) return a.id.localeCompare(b.id);
    // Preserve the board's conversation order when their timestamps tie.
    return Number(!!a.seatOwnedLane) - Number(!!b.seatOwnedLane);
  });
}
