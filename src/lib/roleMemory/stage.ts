import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { ROLE_IDS } from "@/lib/roles/types";

import { codePoints } from "./consolidate";
import { learnedMemoryExcluded, roleIsClean } from "./policy";
import { lessonRequestLines, type HandedFindings } from "./render";
import { learnedRulesBlock, leaveLessons, lessonRequest, recordLessonRequest, RoleMemoryRefusal, roleMemoryEnabled, type LeftLesson } from "./store";
import { MAX_LESSONS_PER_ATTEMPT, RULE_MAX_CHARS, RULE_MIN_CHARS, WHY_MAX_CHARS, type LessonInput, type ScopeKind } from "./types";

/* The three points where role memory meets a pipeline stage: the block at
   spawn, the request in the answer to an accepted stage_report, and the
   lessons the agent leaves with leave_lesson. Each reads the pipeline record
   and writes only role memory's own collection. */

function attemptOf(pipeline: Pipeline, stageId: string, n: number): PipelineStageAttempt | null {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.find((attempt) => attempt.n === n && !attempt.historical) ?? null;
}

/** Whether a stage reads and writes learned rules, by role and by the engine's review-gate classification. */
export function stageMemoryExcluded(stage: Pick<PipelineStage, "kind" | "onFail"> | null, roleId: string | null): boolean {
  return learnedMemoryExcluded({ roleId, stage });
}

/** The learned rules a stage launch starts with, or null for a clean stage or a project with the switch off. */
export function learnedRulesForLaunch(pipeline: Pick<Pipeline, "project">, stage: Pick<PipelineStage, "kind" | "onFail">, roleId: string | null): string | null {
  if (stageMemoryExcluded(stage, roleId) || !roleMemoryEnabled(pipeline.project)) return null;
  return learnedRulesBlock(pipeline.project, roleId);
}

function handedFindings(pipeline: Pipeline, attempt: PipelineStageAttempt): HandedFindings | null {
  const edge = attempt.activatedBy;
  if (!edge || edge.edge !== "fail") return null;
  const source = attemptOf(pipeline, edge.stageId, edge.attempt);
  const findings = source?.verdict?.rankedFindings ?? source?.report?.verdict.rankedFindings ?? [];
  return { stageId: edge.stageId, severities: findings.map((finding) => finding.severity) };
}

/** The lesson request for an accepted stage_report, once per attempt; null for a clean stage, a project switched off, or a repeat. */
export function lessonRequestForReport(pipeline: Pipeline, stageId: string, n: number, conversationId: string, now = new Date().toISOString()): string[] | null {
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId) ?? null;
  const attempt = attemptOf(pipeline, stageId, n);
  if (!stage || !attempt) return null;
  const roleId = attempt.effectiveRole.roleId ?? null;
  if (stageMemoryExcluded(stage, roleId) || !roleMemoryEnabled(pipeline.project)) return null;
  const created = recordLessonRequest({ pipelineId: pipeline.id, stageId, attempt: n, project: pipeline.project, roleId, conversationId, at: now });
  return created ? lessonRequestLines(handedFindings(pipeline, attempt)) : null;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new RoleMemoryRefusal("LESSON_INVALID", `${field} must be text`);
  const trimmed = value.trim().replace(/\s+/g, " ");
  const length = codePoints(trimmed);
  if (length < min || length > max) throw new RoleMemoryRefusal("LESSON_INVALID", `${field} must be ${min}–${max} characters; it has ${length}`);
  return trimmed;
}

/** Validates leave_lesson's arguments into lessons, before anything is resolved or written. */
export function parseLessons(args: { lessons?: unknown; none?: unknown }, writerRole: string | null): { lessons: LessonInput[]; none: string | null } {
  const raw = args.lessons === undefined ? [] : args.lessons;
  if (!Array.isArray(raw) || raw.length > MAX_LESSONS_PER_ATTEMPT) throw new RoleMemoryRefusal("LESSON_INVALID", `lessons must be a list of at most ${MAX_LESSONS_PER_ATTEMPT}`);
  const none = args.none === undefined ? null : text(args.none, "none", 1, WHY_MAX_CHARS);
  if (!raw.length && !none) throw new RoleMemoryRefusal("LESSON_INVALID", "give one to three lessons, or none with one line saying why");
  const lessons = raw.map((entry, index): LessonInput => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const scope = item.scope as ScopeKind;
    if (!["role", "project", "machine"].includes(scope)) throw new RoleMemoryRefusal("LESSON_INVALID", `lessons[${index}].scope must be role, project or machine`);
    let role: string | undefined;
    if (item.role !== undefined) {
      if (scope !== "role") throw new RoleMemoryRefusal("LESSON_INVALID", `lessons[${index}].role goes only with scope role`);
      if (typeof item.role !== "string" || !(ROLE_IDS as readonly string[]).includes(item.role)) throw new RoleMemoryRefusal("LESSON_INVALID", `lessons[${index}].role must be a role id`);
      if (roleIsClean(item.role)) throw new RoleMemoryRefusal("LESSON_CLEAN_ROLE", `${item.role} stages receive no learned rules; address the rule to the project instead`);
      role = item.role;
    }
    if (scope === "role" && !role && !writerRole) throw new RoleMemoryRefusal("LESSON_INVALID", `lessons[${index}]: this stage has no role; name one in role, or use scope project`);
    return { scope, ...(role ? { role } : {}), rule: text(item.rule, `lessons[${index}].rule`, RULE_MIN_CHARS, RULE_MAX_CHARS), why: text(item.why, `lessons[${index}].why`, 1, WHY_MAX_CHARS) };
  });
  return { lessons, none };
}

export interface LeaveLessonResult {
  pipelineId: string;
  stageId: string;
  attempt: number;
  left: LeftLesson[];
  none: string | null;
}

/** leave_lesson: the calling conversation's attempt that was asked for a lesson, resolved by the server. */
export function leaveLessonForConversation(pipelines: readonly Pipeline[], conversationId: string | null, args: { lessons?: unknown; none?: unknown }, now = new Date().toISOString()): LeaveLessonResult {
  if (!conversationId) throw new RoleMemoryRefusal("LESSON_NOT_AN_ATTEMPT", "a lesson is left by a stage's own conversation, and this call carries no conversation identity");
  const held = pipelines.flatMap((pipeline) => pipeline.runs.flatMap((run) => run.attempts
    .filter((attempt) => !attempt.historical && attempt.conversationId === conversationId)
    .map((attempt) => ({ pipeline, stage: pipeline.stages.find((candidate) => candidate.id === run.stageId) ?? null, stageId: run.stageId, attempt }))));
  if (!held.length) throw new RoleMemoryRefusal("LESSON_NOT_AN_ATTEMPT", "this conversation is not running a pipeline stage");
  const requested = held.map((entry) => ({ ...entry, request: lessonRequest(entry.pipeline.id, entry.stageId, entry.attempt.n) }))
    .filter((entry) => entry.request).sort((a, b) => b.request!.at.localeCompare(a.request!.at));
  const target = requested[0] ?? null;
  const latest = target ?? held.at(-1)!;
  const roleId = latest.attempt.effectiveRole.roleId ?? null;
  if (stageMemoryExcluded(latest.stage, roleId)) throw new RoleMemoryRefusal("LESSON_CLEAN_STAGE", "a review stage stays clean: it reads no learned rules and leaves none");
  if (!roleMemoryEnabled(latest.pipeline.project)) throw new RoleMemoryRefusal("LESSON_SWITCHED_OFF", "learned rules are switched off for this project");
  if (!target) throw new RoleMemoryRefusal("LESSON_NOT_REQUESTED", "report the stage with stage_report first; its answer asks for the lesson");
  const parsed = parseLessons(args, roleId);
  const result = leaveLessons({
    request: { pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n },
    source: {
      project: target.pipeline.project, pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n,
      roleId, fixRound: target.attempt.activatedBy?.edge === "fail", conversationId,
    },
    lessons: parsed.lessons, none: parsed.none, now,
  });
  return { pipelineId: target.pipeline.id, stageId: target.stageId, attempt: target.attempt.n, ...result };
}
