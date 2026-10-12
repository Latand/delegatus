import { createHash } from "node:crypto";
import { canonicalProject } from "@/lib/projects/aliases";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import { redactBounded } from "@/lib/monitor/redact";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import { roleMemoryCollection, RoleMemoryRefusal } from "./roleStore";
import { lessonText, lessonTextLength, PROBLEM_MAX_CHARS, PROBLEM_EVIDENCE_MAX_CHARS, type ProblemInput, type ScopeKind, type RoleMemoryRow, type LessonRequestRow, type RoleMemoryRule } from "./roleTypes";

/** Structural hints catch concrete paths and defect statements. The agent and
    curator still judge whether the remaining imperative holds on other tasks. */
export function assertGenericRule(rule: string, scope: ScopeKind): void {
  const normalized = rule.normalize("NFKC");
  const file = /(?:^|[\s`"'(])(?:[A-Z]:)?[\\/]*(?:[\w.@~-]+[\\/])*[\w.@~-]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|mdx?|ftl|py|sh|sql|go|rs|css|html|xml)(?=[:\s`"'),;.!?]|$)/iu;
  const home = /(?:\/(?:home|Users)\/|[A-Z]:\\Users\\)/iu;
  const conditional = /^(?:when|whenever|if|unless|before|after|коли|якщо|когда|если)\b/iu.test(normalized);
  const defect = !conditional && (/\b(?:is|are|was|were)\s+(?:broken|mismatched|missing|incorrect|inconsistent|failing|wrong)\b/iu.test(normalized)
    || /^(?:the|this|our)\s.+\b(?:fails?|omits?|accepts?|rejects?|disagrees?|requires?|uses?|supports?|lists?)\b/iu.test(normalized)
    || /(?:зламан|не\s+збіга|несумісн|сломан|не\s+совпада)/iu.test(normalized));
  if (file.test(normalized) || home.test(normalized) || defect) throw new RoleMemoryRefusal("LESSON_IS_PROBLEM", "this names a concrete file or defect; answer problem {statement, evidence} for the project seat, or express the generic check without the project's fact");
  if (scope === "machine" && /\b(?:in|for|on|within)\s+(?:this|our|the current)\s+(?:project|repository|repo)\b|\b(?:this|our)\s+(?:project|repository|repo)(?:['’]s)?\s+(?:uses|requires|has|runs|supports|is)\b|(?:у|в)\s+(?:цьому|этом)\s+(?:проєкті|проекте)/iu.test(normalized)) {
    throw new RoleMemoryRefusal("LESSON_WRONG_LEVEL", "a machine rule must hold across projects; use the narrowest role/project level for a generic check, or problem {statement, evidence} for a concrete inconsistency");
  }
}

/** Concrete evidence belongs to the seat's agenda; it never becomes a rule. */
export function problemInput(value: unknown): ProblemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoleMemoryRefusal("LESSON_INVALID", "problem must give statement and evidence");
  const input = value as Record<string, unknown>;
  const field = (key: string, limit: number) => {
    const raw = input[key];
    if (typeof raw !== "string" || !lessonTextLength(raw) || lessonTextLength(raw) > limit) throw new RoleMemoryRefusal("LESSON_INVALID", `problem.${key} must be 1–${limit} characters`);
    return lessonText(raw);
  };
  return { statement: field("statement", PROBLEM_MAX_CHARS), evidence: field("evidence", PROBLEM_EVIDENCE_MAX_CHARS) };
}

function reportedProblem(row: RoleMemoryRow): row is (LessonRequestRow | RoleMemoryRule) & { problem: ProblemInput } {
  return row.kind !== "scope" && !!row.problem
    && (row.kind === "request" || !row.versionOf && row.state === "archived" && row.reason === "problem");
}
function pendingProblem(row: RoleMemoryRow): row is (LessonRequestRow | RoleMemoryRule) & { problem: ProblemInput } {
  return reportedProblem(row) && !row.problemDeliveredAt;
}
function problemKey(row: LessonRequestRow | RoleMemoryRule): string {
  return row.kind === "request" ? `q:${row.pipelineId}:${row.stageId}:${row.attempt}` : `r:${row.id}`;
}
function problemEpisode(row: LessonRequestRow | RoleMemoryRule): string {
  return row.kind === "request" ? row.at : row.problemEpisode ?? row.changedAt;
}
function problemId(row: LessonRequestRow | RoleMemoryRule): string {
  return `memory-problem:${createHash("sha256").update(JSON.stringify([problemKey(row), problemEpisode(row)])).digest("hex").slice(0, 16)}`;
}
function problemSignal(row: (LessonRequestRow | RoleMemoryRule) & { problem: ProblemInput }): SeatTickSignalInput {
  const id = problemId(row);
  return { id,
    actionable: true,
    episode: problemEpisode(row),
    label: redactBounded(`Project problem: ${row.problem.statement} Decide whether to propose a task or issue and ask the operator before creating it. Full report: seat_tick_settings verbose:true problemId=${id}. Evidence: ${row.problem.evidence}`, 1600) };
}

/** A summarized wake names its exact report; Undo and replacement never return
    another report in its place. Delivery keeps the full record readable. */
export function readMemoryProblem(project: string, id: string): ProblemInput | null {
  const canonical = canonicalProject(project);
  const row = roleMemoryCollection()?.snapshot().filter(reportedProblem).find(row => problemId(row) === id
    && canonicalProject(row.kind === "request" ? row.project : row.source.project) === canonical);
  return row ? { ...row.problem } : null;
}

/** The existing seat agenda supplies delivery proofs, never attempts. Credit
    the original row before its generic agenda version can age out. */
export function memoryProblemSignals(project: string, shown: readonly string[]): SeatTickSignalInput[] {
  const collection = roleMemoryCollection();
  if (!collection) return [];
  const canonical = canonicalProject(project);
  const pending = collection.snapshot().filter(pendingProblem).filter(row => canonicalProject(row.kind === "request" ? row.project : row.source.project) === canonical);
  const versions = new Set(shown);
  const delivered = pending.filter(row => versions.has(seatTickSignalVersion(problemSignal(row))));
  if (delivered.length) collection.boundedPatch(4096, tx => {
    for (const row of delivered) {
      const fresh = tx.get(problemKey(row));
      if (fresh && pendingProblem(fresh) && versions.has(seatTickSignalVersion(problemSignal(fresh)))) tx.put({ ...fresh, problemDeliveredAt: new Date().toISOString() });
    }
  });
  const credited = new Set(delivered.map(problemKey));
  return pending.filter(row => !credited.has(problemKey(row))).map(problemSignal);
}
