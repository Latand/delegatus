import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { ROLE_IDS } from "@/lib/roles/types";

import { automaticMemoryExcluded, roleIsClean } from "./eligibility";
import { LESSON_MATCH_MIN_CHARS, lettersAndDigits } from "./roleConsolidate";
import { lessonRequestLines, type HandedFindings } from "./roleRender";
import { leaveOperatorLessons, leaveSeatLessons, leaveLessons, lessonRequest, recordLessonRequest, roleMemoryCollection, RoleMemoryRefusal, type LeftLesson } from "./roleStore";
import { assertGenericRule, problemInput } from "./roleProblems";
import { scopeKind } from "./roleScopes";
import { roleMemoryEnabled, roleMemorySelectorEnabled } from "./settings";
import { operatorMemoryEnabled } from "./operatorMemory";
import { lessonText, lessonTextLength, RULE_MAX_CHARS, RULE_MIN_CHARS, WHY_MAX_CHARS, type LessonInput, type ScopeKind, type RewriteInput, type ProblemInput } from "./roleTypes";

/* The three points where role memory meets a pipeline stage: the selector at
   spawn, the request in the answer to an accepted stage_report, and the
   answer the agent leaves with leave_lesson. Each reads the pipeline record
   and writes only role memory's own collection. */

function attemptOf(pipeline: Pipeline, stageId: string, n: number): PipelineStageAttempt | null {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.find((attempt) => attempt.n === n && !attempt.historical) ?? null;
}

/** Whether a stage reads and writes learned rules, by role and by the engine's review-gate classification. */
export function stageMemoryExcluded(stage: Pick<PipelineStage, "kind" | "onFail"> | null, roleId: string | null): boolean {
  return automaticMemoryExcluded({ roleId, stage });
}

/** What a stage launch carries from memory: whether it is clean (no automatic
    memory of any kind, its engine's own included), and a text-free selector.
    Reading the rules is deferred to each engine start. */
export function stageMemoryForLaunch(pipeline: Pick<Pipeline, "id" | "project">, stage: Pick<PipelineStage, "id" | "kind" | "onFail">, roleId: string | null): { cleanMemory: boolean; learnedRules: { project: string; roleId: string | null } | null } {
  const cleanMemory = stageMemoryExcluded(stage, roleId);
  return { cleanMemory, learnedRules: cleanMemory || !roleMemorySelectorEnabled() ? null : { project: pipeline.project, roleId } };
}

function handedFindings(pipeline: Pipeline, attempt: PipelineStageAttempt): HandedFindings | null {
  const edge = attempt.activatedBy;
  if (!edge || edge.edge !== "fail") return null;
  const source = attemptOf(pipeline, edge.stageId, edge.attempt);
  const verdict = source?.verdict ?? source?.report?.verdict;
  const ranked = verdict?.rankedFindings ?? [];
  return { stageId: edge.stageId, findings: ranked.length ? ranked.map(finding => ({ severity: finding.severity ?? "unranked", text: finding.text })) : (verdict?.findings ?? []).map(text => ({ severity: "unranked", text })) };
}

/** The lesson request for an accepted stage_report, once per attempt; null for a clean stage, the kill switch set, or a repeat. */
export function lessonRequestForReport(pipeline: Pipeline, stageId: string, n: number, conversationId: string, now = new Date().toISOString()): string[] | null {
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId) ?? null;
  const attempt = attemptOf(pipeline, stageId, n);
  if (!stage || !attempt) return null;
  const roleId = attempt.effectiveRole.roleId ?? null;
  if (stageMemoryExcluded(stage, roleId) || !roleMemoryEnabled()) return null;
  const created = recordLessonRequest({ pipelineId: pipeline.id, taskId: pipeline.taskIds?.[0], stageId, attempt: n, project: pipeline.project, roleId, conversationId, at: now });
  return created ? lessonRequestLines(handedFindings(pipeline, attempt)) : null;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new RoleMemoryRefusal("LESSON_INVALID", `${field} must be text`);
  const trimmed = lessonText(value);
  const length = lessonTextLength(trimmed);
  if (length < min || length > max) throw new RoleMemoryRefusal("LESSON_INVALID", `${field} must be ${min}–${max} characters; it has ${length}`);
  return trimmed;
}

/** A stored rule and why are kept off everything that leaves this machine by
    their words (roleStore.ts); text with too few to recognise is refused. */
function recognisable(value: string, field: string): string {
  const count = lettersAndDigits(value);
  if (count < LESSON_MATCH_MIN_CHARS) throw new RoleMemoryRefusal("LESSON_INVALID", `${field} needs at least ${LESSON_MATCH_MIN_CHARS} letters or digits; it has ${count}. Say it in words`);
  return value;
}

export interface LessonAnswerArgs { lesson?: unknown; rewrite?: unknown; none?: unknown; lessons?: unknown; problem?: unknown; applied?: unknown; misled?: unknown }

export function lessonUsage(args: Pick<LessonAnswerArgs, "applied" | "misled">): { applied?: string[]; misled?: string[] } {
  const parse = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 5 || value.some(id => typeof id !== "string" || !/^r_[a-f0-9]{16}$/.test(id)) || new Set(value).size !== value.length) throw new RoleMemoryRefusal("LESSON_INVALID", "applied and misled must each contain up to five distinct exact rule ids");
    return value;
  };
  const applied = parse(args.applied), misled = parse(args.misled);
  if (applied?.some(id => misled?.includes(id))) throw new RoleMemoryRefusal("LESSON_INVALID", "a rule cannot be both applied and misled in one answer");
  return { ...(applied ? { applied } : {}), ...(misled ? { misled } : {}) };
}

/** Fixed identifiers of a single change/run; semantic generality belongs to the agent and curator. */
export function taskIdentifier(rule: string): string | null {
  const plain = rule.normalize("NFKC");
  const direct = plain.match(/#\d+|\b(?:PR|pull\s+request|issue)\s*#?\s*\d+|\b(?:pull|issues)\/\d+|\br_[a-f0-9]+\b|\bconversation_[a-z0-9_-]+|\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/iu);
  if (direct) return direct[0];
  return [...plain.matchAll(/\b[a-f0-9]{7,40}\b/giu)].find(match => /[a-f]/i.test(match[0]) && /\d/.test(match[0]))?.[0] ?? null;
}

function ruleText(value: unknown, field: string): string {
  const rule = recognisable(text(value, field, RULE_MIN_CHARS, RULE_MAX_CHARS), field);
  if (taskIdentifier(rule)) throw new RoleMemoryRefusal("LESSON_ABOUT_ONE_TASK", "the rule names one task or run; this belongs in your stage report. If it holds on other tasks, say it without that identifier");
  return rule;
}

/** Exactly one answer, validated before the request can be consumed. */
export function parseLessons(args: LessonAnswerArgs, writerRole: string | null): { lessons: LessonInput[]; none: string | null; rewrite?: RewriteInput; problem?: ProblemInput } {
  if (args.lessons !== undefined || [args.none, args.rewrite, args.lesson, args.problem].filter(value => value !== undefined).length !== 1) {
    throw new RoleMemoryRefusal("LESSON_INVALID", "give exactly one of none, rewrite, lesson or problem");
  }
  if (args.none !== undefined) return { lessons: [], none: text(args.none, "none", 1, WHY_MAX_CHARS) };
  if (args.problem !== undefined) return { lessons: [], none: null, problem: problemInput(args.problem) };
  const value = args.rewrite ?? args.lesson;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoleMemoryRefusal("LESSON_INVALID", "answer must be an object");
  const item = value as Record<string, unknown>;
  const rule = ruleText(item.rule, "rule");
  const why = recognisable(text(item.why, "why", 1, WHY_MAX_CHARS), "why");
  if (args.rewrite !== undefined) {
    assertGenericRule(rule, "role");
    return { lessons: [], none: null, rewrite: { id: text(item.id, "id", 1, 128), rule, why } };
  }
  const scope = item.scope as ScopeKind;
  if (!["role", "project", "machine"].includes(scope)) throw new RoleMemoryRefusal("LESSON_INVALID", "lesson.scope must be role, project or machine");
  assertGenericRule(rule, scope);
  let role: string | undefined;
  if (item.role !== undefined) {
    if (scope !== "role") throw new RoleMemoryRefusal("LESSON_INVALID", "lesson.role goes only with scope role");
    if (typeof item.role !== "string" || !(ROLE_IDS as readonly string[]).includes(item.role)) throw new RoleMemoryRefusal("LESSON_INVALID", "lesson.role must be a role id");
    role = item.role;
  }
  if (scope === "role" && roleIsClean(role ?? writerRole)) throw new RoleMemoryRefusal("LESSON_CLEAN_ROLE", "this role receives no learned rules; its own know-how has no memory scope");
  if (scope === "role" && !role && !writerRole) throw new RoleMemoryRefusal("LESSON_INVALID", "this stage has no role; name one in role, or use scope project");
  return { lessons: [{ scope, ...(role ? { role } : {}), rule, why }], none: null };
}

export interface LeaveLessonResult {
  pipelineId: string;
  stageId: string;
  attempt: number;
  left: LeftLesson[];
  none: string | null;
  problem?: ProblemInput;
}

/** leave_lesson: the calling conversation's attempt that was asked for a lesson, resolved by the server. */
export function leaveLessonForConversation(pipelines: readonly Pipeline[], conversationId: string | null, args: LessonAnswerArgs, now = new Date().toISOString()): LeaveLessonResult {
  if (!conversationId) throw new RoleMemoryRefusal("LESSON_NOT_AN_ATTEMPT", "a lesson is left by a stage that was asked for one, or by a project's designated orchestrator seat; this conversation is neither");
  const held = pipelines.flatMap((pipeline) => pipeline.runs.flatMap((run) => run.attempts
    .filter((attempt) => !attempt.historical && attempt.conversationId === conversationId)
    .map((attempt) => ({ pipeline, stage: pipeline.stages.find((candidate) => candidate.id === run.stageId) ?? null, stageId: run.stageId, attempt }))));
  if (!held.length) throw new RoleMemoryRefusal("LESSON_NOT_AN_ATTEMPT", "a lesson is left by a stage that was asked for one, or by a project's designated orchestrator seat; this conversation is neither");
  const requested = held.map((entry) => ({ ...entry, request: lessonRequest(entry.pipeline.id, entry.stageId, entry.attempt.n) }))
    .filter((entry) => entry.request).sort((a, b) => b.request!.at.localeCompare(a.request!.at));
  const target = requested[0] ?? null;
  const latest = target ?? held.at(-1)!;
  const roleId = latest.attempt.effectiveRole.roleId ?? null;
  if (stageMemoryExcluded(latest.stage, roleId)) throw new RoleMemoryRefusal("LESSON_CLEAN_STAGE", "a review stage stays clean: it reads no learned rules and leaves none");
  if (!roleMemoryEnabled()) throw new RoleMemoryRefusal("LESSON_SWITCHED_OFF", "learned rules are switched off on this installation");
  if (!target) throw new RoleMemoryRefusal("LESSON_NOT_REQUESTED", "report the stage with stage_report first; its answer asks for the lesson");
  const parsed = parseLessons(args, roleId);
  const usage = lessonUsage(args);
  if (parsed.rewrite) {
    const row = roleMemoryCollection()?.get(`r:${parsed.rewrite.id}`);
    if (row?.kind === "rule") assertGenericRule(parsed.rewrite.rule, scopeKind(row.scope));
  }
  const result = leaveLessons({
    request: { pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n },
    source: {
      project: target.pipeline.project, pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n,
      roleId, fixRound: target.attempt.activatedBy?.edge === "fail", conversationId,
    },
    lessons: parsed.lessons, none: parsed.none, rewrite: parsed.rewrite, problem: parsed.problem, ...usage, now,
  });
  return { pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n, ...result };
}

/** The binding supplies the fresh server-authorized designation, never the caller's arguments. */
export function leaveLessonForSeat(seat: { project: string | null; conversationId: string }, args: LessonAnswerArgs, now = new Date().toISOString()) {
  if (!seat.project || seat.project === "*") throw new RoleMemoryRefusal("LESSON_NOT_A_SEAT", "the designated seat has no concrete project");
  if (!roleMemoryEnabled()) throw new RoleMemoryRefusal("LESSON_SWITCHED_OFF", "learned rules are switched off on this installation");
  try {
    const usage = lessonUsage(args);
    if (usage.applied?.length || usage.misled?.length) throw new RoleMemoryRefusal("RULE_NOT_DELIVERED", "usage measurement belongs to a stage attempt's delivered rules");
    const parsed = parseLessons(args, "orchestrator");
    if (parsed.none !== null) throw new RoleMemoryRefusal("LESSON_INVALID", "an unasked seat gives lesson or rewrite; there is no request to decline");
    if (parsed.problem) throw new RoleMemoryRefusal("LESSON_IS_PROBLEM", "a seat handles its own defects");
    if (parsed.rewrite) {
      const row = roleMemoryCollection()?.get(`r:${parsed.rewrite.id}`);
      if (row?.kind === "rule") assertGenericRule(parsed.rewrite.rule, scopeKind(row.scope));
    }
    const result = leaveSeatLessons({ source: { origin: "seat", project: seat.project, roleId: "orchestrator", fixRound: false, conversationId: seat.conversationId }, lessons: parsed.lessons, rewrite: parsed.rewrite, now });
    return { project: seat.project, roleId: "orchestrator" as const, ...result };
  } catch (error) {
    if (error instanceof RoleMemoryRefusal && error.code === "LESSON_IS_PROBLEM") throw new RoleMemoryRefusal(error.code, "this names a defect: find or create its board task with create_task. Tell the operator in chat when it is critical. For a practice that holds on other tasks, express the generic check without the project's fact");
    if (error instanceof RoleMemoryRefusal && error.code === "LESSON_ABOUT_ONE_TASK") throw new RoleMemoryRefusal(error.code, "the rule names one task or run; it belongs on that task's card. If it holds elsewhere, say it without the identifier");
    throw error;
  }
}

/** The binding supplies the server-resolved operator root conversation and its
    project; this only runs in Delegatus mode (memory-source-switch.md §3.3). */
export function leaveLessonForOperator(caller: { project: string | null; conversationId: string }, args: LessonAnswerArgs, now = new Date().toISOString()) {
  if (!caller.project || caller.project === "*" || !operatorMemoryEnabled()) throw new RoleMemoryRefusal("LESSON_NOT_AN_ATTEMPT", "a lesson is left by a stage that was asked for one, by a project's designated orchestrator seat, or by the operator's own conversation while Delegatus memory is on; this conversation is none of them");
  if (!roleMemoryEnabled()) throw new RoleMemoryRefusal("LESSON_SWITCHED_OFF", "learned rules are switched off on this installation");
  try {
    const usage = lessonUsage(args);
    if (usage.applied?.length || usage.misled?.length) throw new RoleMemoryRefusal("RULE_NOT_DELIVERED", "usage measurement belongs to a stage attempt's delivered rules");
    const lesson = args.lesson as { scope?: unknown } | undefined;
    if (lesson && typeof lesson === "object" && lesson.scope === "role") throw new RoleMemoryRefusal("LESSON_WRONG_LEVEL", "an operator conversation leaves project or machine rules; a role's practice is its seat's or its stages'");
    const parsed = parseLessons(args, null);
    if (parsed.none !== null) throw new RoleMemoryRefusal("LESSON_INVALID", "an unasked conversation gives lesson or rewrite; there is no request to decline");
    if (parsed.problem) throw new RoleMemoryRefusal("LESSON_IS_PROBLEM", "a defect is not a rule");
    if (parsed.rewrite) {
      const row = roleMemoryCollection()?.get(`r:${parsed.rewrite.id}`);
      if (row?.kind === "rule") assertGenericRule(parsed.rewrite.rule, scopeKind(row.scope));
    }
    const result = leaveOperatorLessons({ source: { origin: "operator", project: caller.project, roleId: null, fixRound: false, conversationId: caller.conversationId }, lessons: parsed.lessons, rewrite: parsed.rewrite, now });
    return { project: caller.project, roleId: null, ...result };
  } catch (error) {
    if (error instanceof RoleMemoryRefusal && error.code === "LESSON_IS_PROBLEM") throw new RoleMemoryRefusal(error.code, "this names a defect: find or create its board task with create_task, or tell the operator in chat. For a practice that holds on other tasks, express the generic check without the project's fact");
    if (error instanceof RoleMemoryRefusal && error.code === "LESSON_ABOUT_ONE_TASK") throw new RoleMemoryRefusal(error.code, "the rule names one task or run; it belongs on that task's card. If it holds elsewhere, say it without the identifier");
    throw error;
  }
}
