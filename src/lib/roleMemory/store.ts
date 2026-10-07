import crypto from "node:crypto";

import { statePath } from "@/lib/configDir";
import { isOwnProject } from "@/lib/memory/settings";
import { staticSensitiveClasses, type StaticFindingClass } from "@/lib/privacy/staticDetectors";
import { canonicalProject } from "@/lib/projects/aliases";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

import { appendRule, scopeChars } from "./consolidate";
import { projectScope, readableScopes, roleScope } from "./policy";
import { MACHINE_SCOPE, scopeKind, scopeProject, scopeRole } from "./scopes";
import { renderLearnedRules } from "./render";
import {
  MAX_LESSONS_PER_ATTEMPT, ROLE_MEMORY_BOUND,
  type LessonInput, type LessonRequestRow, type ProjectSettingRow, type RoleMemoryProjectView, type RoleMemoryRow,
  type RoleMemoryRule, type RoleMemoryScopeRow, type RuleSource, type RuleView, type ScopeView, type StageLessonView,
} from "./types";

/* One collection in state.sqlite, so role memory inherits the state store's
   transactions, integrity checks and backups and adds no file. Rows: a rule
   (`r:`), a scope with its active list and history (`s:`), a stage attempt's
   lesson request (`q:`) and a project's switch (`p:`). Rule rows are never
   deleted. */

const COLLECTION = "role_memory";
const HISTORY_LIMIT = 500;

const requestKey = (pipelineId: string, stageId: string, attempt: number) => `q:${pipelineId}:${stageId}:${attempt}`;
function key(row: RoleMemoryRow): string {
  switch (row.kind) {
    case "rule": return `r:${row.id}`;
    case "scope": return `s:${row.scope}`;
    case "request": return requestKey(row.pipelineId, row.stageId, row.attempt);
    case "project": return `p:${row.project}`;
  }
}
function decode(value: unknown): RoleMemoryRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoleMemoryRow;
  return row.kind === "rule" && typeof row.id === "string" && typeof row.rule === "string"
    || row.kind === "scope" && typeof row.scope === "string" && Array.isArray(row.active)
    || row.kind === "request" && typeof row.pipelineId === "string" && Array.isArray(row.ruleIds)
    || row.kind === "project" && typeof row.project === "string" && typeof row.enabled === "boolean" ? row : null;
}
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "role-memory-v1", key, loadRecords: (): RoleMemoryRow[] => [] };
const cache = new Map<string, SqliteStateCollection<RoleMemoryRow>>();
function collection(create = false): SqliteStateCollection<RoleMemoryRow> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<RoleMemoryRow>(file, { collection: COLLECTION, schemaVersion: 1, busyMessage: "role memory busy", key, decode, clone: structuredClone, strictDecode: true });
  cache.set(file, opened);
  return opened;
}
function rows(): RoleMemoryRow[] {
  return collection()?.snapshot() ?? [];
}
function rule(id: string): RoleMemoryRule | null {
  const row = collection()?.get(`r:${id}`);
  return row?.kind === "rule" ? row : null;
}
function scopeRow(scope: string): RoleMemoryScopeRow | null {
  const row = collection()?.get(`s:${scope}`);
  return row?.kind === "scope" ? row : null;
}

export class RoleMemoryRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The per-project switch. This repository starts on, every other project off, as shared memory does. */
export function roleMemoryEnabled(project: string): boolean {
  try {
    const row = collection()?.get(`p:${canonicalProject(project)}`);
    return row?.kind === "project" ? row.enabled : isOwnProject(project);
  } catch { return false; }
}

export function setRoleMemoryEnabled(project: string, enabled: boolean, now = new Date().toISOString()): void {
  const row: ProjectSettingRow = { kind: "project", project: canonicalProject(project), enabled, changedAt: now };
  collection(true)!.boundedPatch(1, (tx) => { tx.put(row); });
}

export function activeRules(scope: string): RoleMemoryRule[] {
  return (scopeRow(scope)?.active ?? []).flatMap((id) => { const found = rule(id); return found ? [found] : []; });
}

/** The block a new stage of this role and project starts with. */
export function learnedRulesBlock(project: string, roleId: string | null): string {
  return renderLearnedRules(readableScopes(project, roleId).map((scope) => ({ scope, rules: activeRules(scope) })));
}

export function lessonRequest(pipelineId: string, stageId: string, attempt: number): LessonRequestRow | null {
  const row = collection()?.get(requestKey(pipelineId, stageId, attempt));
  return row?.kind === "request" ? row : null;
}

/** Records that this attempt was asked for a lesson; false when it already was. */
export function recordLessonRequest(input: Omit<LessonRequestRow, "kind" | "ruleIds" | "none">): boolean {
  return collection(true)!.boundedPatch(2, (tx) => {
    if (tx.get(requestKey(input.pipelineId, input.stageId, input.attempt))) return false;
    tx.put({ kind: "request", ...input, project: canonicalProject(input.project), ruleIds: [], none: null });
    return true;
  });
}

function hintsOf(text: string): StaticFindingClass[] {
  return [...staticSensitiveClasses(text.normalize("NFKC"))].sort();
}

export interface LeftLesson {
  id: string;
  scope: string;
  state: RoleMemoryRule["state"];
  mergedInto?: string;
  scopeChars: number;
  archived: string[];
  hints: StaticFindingClass[];
}

/** Appends an attempt's lessons to their scopes in one transaction, consolidating each scope under its bound. */
export function leaveLessons(input: {
  request: Pick<LessonRequestRow, "pipelineId" | "stageId" | "attempt">;
  source: RuleSource;
  lessons: readonly LessonInput[];
  none: string | null;
  now?: string;
}): { left: LeftLesson[]; none: string | null } {
  const now = input.now ?? new Date().toISOString();
  const project = canonicalProject(input.source.project);
  return collection(true)!.boundedPatch(4096, (tx) => {
    const request = tx.get(requestKey(input.request.pipelineId, input.request.stageId, input.request.attempt));
    if (request?.kind !== "request") throw new RoleMemoryRefusal("LESSON_NOT_REQUESTED", "this stage attempt was not asked for a lesson");
    if (request.ruleIds.length + input.lessons.length > MAX_LESSONS_PER_ATTEMPT) {
      throw new RoleMemoryRefusal("LESSON_LIMIT", `a stage leaves at most ${MAX_LESSONS_PER_ATTEMPT} lessons; this one already left ${request.ruleIds.length}`);
    }
    const left: LeftLesson[] = [];
    for (const lesson of input.lessons) {
      const scope = lesson.scope === "machine" ? MACHINE_SCOPE
        : lesson.scope === "project" ? projectScope(project)
        : roleScope(project, lesson.role ?? input.source.roleId!);
      const held = tx.get(`s:${scope}`);
      const current: RoleMemoryScopeRow = held?.kind === "scope" ? held : { kind: "scope", scope, revision: 0, active: [], history: [] };
      const active = current.active.flatMap((id) => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; });
      const hints = hintsOf(`${lesson.rule}\n${lesson.why}`);
      const incoming: RoleMemoryRule = {
        kind: "rule", id: `r_${crypto.randomBytes(4).toString("hex")}`, scope, rule: lesson.rule, why: lesson.why,
        state: "active", hints, source: { ...input.source, project }, createdAt: now, changedAt: now,
      };
      const outcome = appendRule(active, incoming, now);
      for (const changed of outcome.changed) tx.put(changed);
      const revision = current.revision + 1;
      tx.put({
        ...current, revision, active: outcome.active.map((entry) => entry.id),
        history: [...current.history, { revision, at: now, added: outcome.added, merged: outcome.merged, archived: outcome.archived }].slice(-HISTORY_LIMIT),
      });
      const stored = outcome.changed.find((entry) => entry.id === incoming.id)!;
      left.push({ id: incoming.id, scope, state: stored.state, ...(stored.mergedInto ? { mergedInto: stored.mergedInto } : {}), scopeChars: scopeChars(outcome.active), archived: outcome.archived, hints });
    }
    const none = input.none ?? request.none;
    tx.put({ ...request, ruleIds: [...request.ruleIds, ...left.map((entry) => entry.id)], none });
    return { left, none };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function view(row: RoleMemoryRule, now: number): RuleView {
  return {
    id: row.id, rule: row.rule, why: row.why, state: row.state, hints: row.hints,
    ...(row.reason ? { reason: row.reason } : {}), ...(row.mergedInto ? { mergedInto: row.mergedInto } : {}),
    roleId: row.source.roleId, fixRound: row.source.fixRound, stageId: row.source.stageId,
    fresh: now - Date.parse(row.createdAt) < DAY_MS, createdAt: row.createdAt, changedAt: row.changedAt,
  };
}

/** The rules window: every scope the project reads or wrote, with what left each. */
export function projectView(project: string, now = Date.now()): RoleMemoryProjectView {
  const canonical = canonicalProject(project);
  const all = rows();
  const rulesById = new Map(all.flatMap((row) => row.kind === "rule" ? [[row.id, row] as const] : []));
  const wanted = [...all.flatMap((row) => row.kind === "scope" && scopeProject(row.scope) === canonical && scopeKind(row.scope) === "role" ? [row.scope] : []).sort(),
    projectScope(canonical), MACHINE_SCOPE];
  const scopes: ScopeView[] = wanted.map((scope) => {
    const held = all.find((row): row is RoleMemoryScopeRow => row.kind === "scope" && row.scope === scope);
    const active = (held?.active ?? []).flatMap((id) => { const found = rulesById.get(id); return found ? [found] : []; });
    const left = [...rulesById.values()].filter((row) => row.scope === scope && row.state !== "active")
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
    return {
      scope, kind: scopeKind(scope), roleId: scopeRole(scope), revision: held?.revision ?? 0,
      chars: scopeChars(active), bound: ROLE_MEMORY_BOUND,
      addedToday: active.filter((row) => now - Date.parse(row.createdAt) < DAY_MS).length,
      active: active.map((row) => view(row, now)), left: left.map((row) => view(row, now)),
    };
  });
  return { project: canonical, enabled: roleMemoryEnabled(canonical), scopes };
}

/** What each stage attempt of a project left, for the line under its report on the card. */
export function stageLessons(project: string): StageLessonView[] {
  const canonical = canonicalProject(project);
  const all = rows();
  const rulesById = new Map(all.flatMap((row) => row.kind === "rule" ? [[row.id, row] as const] : []));
  return all.flatMap((row) => row.kind === "request" && row.project === canonical ? [row] : [])
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400)
    .map((row) => ({
      pipelineId: row.pipelineId, stageId: row.stageId, attempt: row.attempt, none: row.none,
      rules: row.ruleIds.flatMap((id) => {
        const found = rulesById.get(id);
        return found ? [{ id, rule: found.rule, scope: scopeKind(found.scope), roleId: scopeRole(found.scope) }] : [];
      }),
    }));
}
