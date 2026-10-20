import { projectStoreSignature } from "@/lib/projects/persistence";
import crypto from "node:crypto";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { effectiveCurationSetting, readSeatTickSettings, seatTickSettingsPath } from "@/lib/monitor/seatTickSettings";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, stateDatabaseSignature, StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";

import { appendRule, lessonPatternSource, retainRules, sameRule, scopeChars } from "./roleConsolidate";
import { roleMemoryEnabled } from "./settings";
import { curationRevision, curationView } from "./curation/store";
import { projectViewRows, projectViewRowsCooperatively, roleScopeKeys, roleViewVersion } from "./roleViewSource";
import { crossProjectRoleScope, isCrossProjectRoleScope, MACHINE_SCOPE, scopeKind, scopeProject, scopeRole } from "./roleScopes";
import { renderLearnedRulesSelection } from "./roleRender";
import { closestReadableRuleIds } from "./ruleIds";
import {
  MAX_LESSONS_PER_ATTEMPT, ROLE_MEMORY_BOUND,
  type LessonInput, type LessonRequestRow, type RoleMemoryProjectView, type RoleMemoryRow,
  type RoleMemoryRule, type RoleMemoryScopeRow, type RuleSource, type StageRuleSource, type SeatRuleSource, type RuleView, type ScopeView, type StageLessonView,
  type RewriteInput, type RuleRevision, type RuleRevisionView, type ScopeHistoryEntry, type RulePrivacyHint, type ProblemInput,
} from "./roleTypes";

/* One collection in state.sqlite, so role memory inherits the state store's
   transactions, integrity checks and backups and adds no file. Rows: a rule
   (`r:`), a scope with its active list and history (`s:`) and a stage
   attempt's lesson request (`q:`). Every lesson is a record of its own; the
   bound is on a scope's list of them, never one text. Rule rows are never
   deleted: a rule the operator removes is archived and can be put back.

   A project's key can move (an origin added, a verified rename; see
   src/lib/projects/succession.ts). A rule keeps the scope it was written
   under, and every read resolves that scope through the project's aliases;
   a scope row left under a moved key is joined into the current one on the
   next operator view or write, within the bound; engine starts resolve the
   same aliases without writing. */

const COLLECTION = "role_memory";
export const ROLE_MEMORY_HISTORY_LIMIT = 10_000;
/** Keep 10,000 ordinary changes independently of every curator Undo record.
 * At 141 daily writes this covers over 70 days; delivery rows keep their own
 * ordered ids and content hashes, so reconstruction never depends on this window. */
function keepHistory(entries: ScopeHistoryEntry[]): ScopeHistoryEntry[] {
  const recent = new Set(entries.filter(entry => !entry.pass).slice(-ROLE_MEMORY_HISTORY_LIMIT));
  return entries.filter(entry => !!entry.pass || recent.has(entry));
}

const requestKey = (pipelineId: string, stageId: string, attempt: number) => `q:${pipelineId}:${stageId}:${attempt}`;
function key(row: RoleMemoryRow): string {
  switch (row.kind) {
    case "rule": return `r:${row.id}`;
    case "scope": return `s:${row.scope}`;
    case "request": return requestKey(row.pipelineId, row.stageId, row.attempt);
  }
}
function decode(value: unknown): RoleMemoryRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoleMemoryRow;
  return row.kind === "rule" && typeof row.id === "string" && typeof row.rule === "string"
    || row.kind === "scope" && typeof row.scope === "string" && Array.isArray(row.active)
    || row.kind === "request" && typeof row.pipelineId === "string" && Array.isArray(row.ruleIds) ? row : null;
}
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "role-memory-v1", key, loadRecords: (): RoleMemoryRow[] => [] };
const cache = new Map<string, SqliteStateCollection<RoleMemoryRow>>();
export function roleMemoryCollection(create = false): SqliteStateCollection<RoleMemoryRow> | null {
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
  return roleMemoryCollection()?.snapshot() ?? [];
}
function rule(id: string): RoleMemoryRule | null {
  const row = roleMemoryCollection()?.get(`r:${id}`);
  return row?.kind === "rule" ? row : null;
}
function scopeRow(scope: string): RoleMemoryScopeRow | null {
  const row = roleMemoryCollection()?.get(`s:${scope}`);
  return row?.kind === "scope" ? row : null;
}

export function roleScope(project: string, roleId: string): string {
  return `role:${canonicalProject(project)}:${roleId}`;
}

export function projectScope(project: string): string {
  return `project:${canonicalProject(project)}`;
}

/** A stored scope as it reads today, under its project's current key. */
export function canonicalScope(scope: string): string {
  const kind = scopeKind(scope);
  if (kind === "machine" || isCrossProjectRoleScope(scope)) return scope;
  return kind === "role" ? roleScope(scopeProject(scope)!, scopeRole(scope)!) : projectScope(scopeProject(scope)!);
}

/** canonicalScope for many rows at once, resolving each distinct scope once. */
function scopeResolver(): (scope: string) => string {
  const seen = new Map<string, string>();
  return (scope) => {
    let resolved = seen.get(scope);
    if (resolved === undefined) seen.set(scope, resolved = canonicalScope(scope));
    return resolved;
  };
}

/** The four scopes a stage reads: its role here, that role everywhere, the project and machine. */
export function readableScopes(project: string, roleId: string | null): string[] {
  return [...(roleId ? [roleScope(project, roleId), crossProjectRoleScope(roleId)] : []), projectScope(project), MACHINE_SCOPE];
}

export class RoleMemoryRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const ROLE_MEMORY_CHANGED_MESSAGE = "Role-memory privacy changed; retrying before dispatch";

/** Opaque token carried with a staged first message to its final dispatcher. */
export function roleMemoryRevisionToken(): string {
  return crypto.createHash("sha256").update(storedLessonRevision()).digest("hex");
}

/** Joins every scope row stored under a project key that has since moved
    into the project's current key, in one transaction: the active rules of
    both in the order they were written, a word-for-word repeat merged into
    the earlier rule, with the same curation order and bound as every writer. Both histories stay, with one entry that records the join. */
export function joinMovedScopes(now = new Date().toISOString()): void {
  const held = roleMemoryCollection();
  if (!held) return;
  const resolve = scopeResolver();
  const moved = roleScopeKeys().filter(scope => resolve(scope) !== scope);
  if (!moved.length) return;
  held.boundedPatch(4096, (tx) => {
    const rulesOf = (ids: readonly string[]) => ids.flatMap((id) => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; });
    for (const from of moved) {
      const source = tx.get(`s:${from}`);
      if (source?.kind !== "scope") continue;
      const into = resolve(from);
      const target = tx.get(`s:${into}`);
      const current: RoleMemoryScopeRow = target?.kind === "scope" ? target : { kind: "scope", scope: into, revision: 0, active: [], history: [] };
      const joined: RoleMemoryRule[] = [];
      const merged: { from: string; into: string }[] = [];
      const candidates = [...rulesOf(current.active), ...rulesOf(source.active)];
      const uncurated = candidates.filter(rule => !rule.curatedAt && !rule.keptByOperatorAt).sort((a, b) => a.changedAt.localeCompare(b.changedAt));
      for (const rule of [...uncurated, ...candidates.filter(rule => rule.curatedAt || rule.keptByOperatorAt)]) {
        const earlier = joined.find((kept) => sameRule(kept.rule, rule.rule));
        if (!earlier) { joined.push(rule); continue; }
        // A duplicate carries the strongest retention decision across a rename.
        if (rule.curatedAt || rule.keptByOperatorAt) {
          const kept = { ...earlier, curatedAt: rule.curatedAt ?? earlier.curatedAt, keptByOperatorAt: rule.keptByOperatorAt ?? earlier.keptByOperatorAt };
          joined.splice(joined.indexOf(earlier), 1);
          joined.push(kept);
          tx.put(kept);
        }
        tx.put({ ...rule, state: "merged", reason: "duplicate", mergedInto: earlier.id, mergedAt: now, changedAt: now });
        merged.push({ from: rule.id, into: earlier.id });
      }
      const retained = retainRules(joined, now);
      for (const changed of retained.changed) tx.put(changed);
      const archived = retained.archived;
      const revision = Math.max(current.revision, source.revision) + 1;
      const revisionScope = `succession:${from}:${into}:${revision}`;
      const sourceHistory = source.history.map(entry => ({ ...entry, revisionScope: entry.revisionScope ?? source.scope }));
      const currentHistory = current.history.map(entry => ({ ...entry, revisionScope: entry.revisionScope ?? current.scope }));
      tx.put({ ...current, ...(current.fourScopeTarget || source.fourScopeTarget ? { fourScopeTarget: current.fourScopeTarget ?? source.fourScopeTarget } : {}), revision, active: retained.active.map((rule) => rule.id),
        revisionScope, history: keepHistory([...sourceHistory, ...currentHistory, { revision, revisionScope, at: now, by: "succession" as const, added: source.active, merged, archived }]) });
      tx.delete(`s:${from}`);
    }
  });
}

/** A rule id no stored rule holds: drawn again on a collision, never overwriting a lesson. */
export function newRuleId(tx: { get(key: string): RoleMemoryRow | null }): string {
  for (let draw = 0; draw < 16; draw += 1) {
    const id = `r_${crypto.randomBytes(8).toString("hex")}`;
    if (!tx.get(`r:${id}`)) return id;
  }
  throw new RoleMemoryRefusal("RULE_ID_UNAVAILABLE", "no free rule id was drawn; leave the lesson again");
}

export function activeRules(scope: string): RoleMemoryRule[] {
  return (scopeRow(scope)?.active ?? []).flatMap((id) => { const found = rule(id); return found ? [found] : []; });
}

/** The block a new stage of this role and project starts with. */
export function learnedRulesSnapshot(project: string, roleId: string | null, maxBytes = Infinity) {
  // A process start resolves aliases in its snapshot; it never joins or migrates state.
  const all = rows();
  const resolve = scopeResolver();
  const byId = new Map(all.flatMap(row => row.kind === "rule" ? [[row.id, row] as const] : []));
  const scopes = readableScopes(project, roleId).map(scope => {
    const active = all.flatMap(row => row.kind === "scope" && resolve(row.scope) === scope ? row.active : [])
      .flatMap(id => { const found = byId.get(id); return found?.state === "active" && !found.versionOf ? [found] : []; });
    // Two aliased rows can exceed one scope's bound before an owner joins them.
    // Apply the same retention decision to this snapshot without writing it.
    const revisions = all.flatMap(row => row.kind === "scope" && resolve(row.scope) === scope
      ? [{ scope: row.scope, revision: row.revision, revisionScope: row.revisionScope ?? row.scope }] : []);
    return { scope, revisions, rules: retainRules(active, new Date().toISOString()).active.reverse() };
  });
  const rendered = renderLearnedRulesSelection(scopes, maxBytes);
  return { block: rendered.block, scopes: scopes.map(({ scope, revisions }) => ({ scope, revisions })),
    rules: rendered.rules.map(rule => ({ id: rule.id, hash: crypto.createHash("sha256").update(rule.rule).digest("hex") })) };
}

export function learnedRulesBlock(project: string, roleId: string | null, maxBytes = Infinity): string {
  return learnedRulesSnapshot(project, roleId, maxBytes).block;
}

export function lessonRequest(pipelineId: string, stageId: string, attempt: number): LessonRequestRow | null {
  const row = roleMemoryCollection()?.get(requestKey(pipelineId, stageId, attempt));
  return row?.kind === "request" ? row : null;
}

/** Records that this attempt was asked for a lesson; false when it already was. */
export function recordLessonRequest(input: Omit<LessonRequestRow, "kind" | "ruleIds" | "none">): boolean {
  return roleMemoryCollection(true)!.boundedPatch(2, (tx) => {
    if (tx.get(requestKey(input.pipelineId, input.stageId, input.attempt))) return false;
    tx.put({ kind: "request", ...input, project: canonicalProject(input.project), ruleIds: [], none: null });
    return true;
  });
}

export function rulePrivacyHints(text: string): RulePrivacyHint[] {
  const normalized = text.normalize("NFKC");
  const hints: RulePrivacyHint[] = [...staticSensitiveClasses(normalized)];
  const email = new RegExp([String.raw`\b[A-Z0-9._%+-]+`, String.raw`[A-Z0-9.-]+\.[A-Z]{2,}\b`].join("@"), "i");
  if (email.test(normalized)) hints.push("email_address");
  return hints.sort();
}

export interface LeftLesson {
  action: "lesson" | "rewrite";
  id: string;
  scope: string;
  state: RoleMemoryRule["state"];
  mergedInto?: string;
  scopeChars: number;
  archived: string[];
  hints: RulePrivacyHint[];
  version?: string;
}

type RuleTransaction = { get(key: string): RoleMemoryRow | null; put(row: RoleMemoryRow): void };

export function versionedRule(tx: RuleTransaction, current: RoleMemoryRule, text: Pick<RoleMemoryRule, "rule" | "why" | "hints">, revisedBy: RuleRevision): { updated: RoleMemoryRule; version: string } {
  const version = newRuleId(tx);
  const prior: RoleMemoryRule = { ...current, id: version, state: "archived", reason: "rewritten", versionOf: current.id, changedAt: revisedBy.at };
  delete prior.versions;
  delete prior.mergedInto;
  tx.put(prior);
  const updated = { ...current, rule: text.rule, why: text.why, hints: text.hints, changedAt: revisedBy.at, revisedBy, versions: [...(current.versions ?? []), version] };
  tx.put(updated);
  return { updated, version };
}

interface LessonWriteInput {
  source: RuleSource;
  lessons: readonly LessonInput[];
  none: string | null;
  rewrite?: RewriteInput;
  problem?: ProblemInput;
  now?: string;
}

/** Stage answers retain the request's one-answer budget. */
export function leaveLessons(input: Omit<LessonWriteInput, "source"> & { source: StageRuleSource; request: Pick<LessonRequestRow, "pipelineId" | "stageId" | "attempt"> }) {
  return writeLessonAnswer(input);
}

/** A designated seat leaves practice without creating a stage request. */
export function leaveSeatLessons(input: Omit<LessonWriteInput, "source" | "none" | "problem"> & { source: SeatRuleSource }) {
  return writeLessonAnswer({ ...input, none: null });
}

/** Both writers share versions, duplicate merging, bounds and privacy hints. */
function writeLessonAnswer(input: LessonWriteInput & { request?: Pick<LessonRequestRow, "pipelineId" | "stageId" | "attempt"> }): { left: LeftLesson[]; none: string | null; problem?: ProblemInput } {
  const now = input.now ?? new Date().toISOString();
  const project = canonicalProject(input.source.project);
  if (project === "*" || Number(input.lessons.length > 0) + Number(input.rewrite !== undefined) + Number(input.none !== null) + Number(input.problem !== undefined) !== 1
    || input.lessons.length > MAX_LESSONS_PER_ATTEMPT) throw new RoleMemoryRefusal("LESSON_INVALID", "give exactly one of none, rewrite, lesson or problem for a concrete project");
  joinMovedScopes(now);
  const result = roleMemoryCollection(true)!.boundedPatch(4096, (tx) => {
    const requested = input.request ? tx.get(requestKey(input.request.pipelineId, input.request.stageId, input.request.attempt)) : null;
    const request = requested?.kind === "request" ? requested : null;
    if (input.request && !request) throw new RoleMemoryRefusal("LESSON_NOT_REQUESTED", "this stage attempt was not asked for a lesson");
    if (request && (request.none !== null || request.rewrote || request.ruleIds.length || request.problem)) throw new RoleMemoryRefusal("LESSON_LIMIT", "this stage attempt already answered its lesson request");
    if (input.problem && request) {
      tx.put({ ...request, problem: input.problem });
      return { left: [], none: null, problem: input.problem };
    }
    const left: LeftLesson[] = [];
    if (input.rewrite) {
      const target = tx.get(`r:${input.rewrite.id}`);
      const scope = target?.kind === "rule" ? canonicalScope(target.scope) : "";
      const held = tx.get(`s:${scope}`);
      if (target?.kind !== "rule" || target.versionOf || target.state !== "active" || held?.kind !== "scope"
        || !held.active.includes(target.id) || !readableScopes(project, input.source.roleId).includes(scope)) {
        // Suggestions use the very same active-scope authority as the write.
        // A miss never resolves implicitly or consumes the lesson request.
        const candidates = readableScopes(project, input.source.roleId).flatMap(scope => {
          const held = tx.get(`s:${scope}`);
          return held?.kind === "scope" ? held.active.flatMap(id => {
            const row = tx.get(`r:${id}`);
            return row?.kind === "rule" && row.state === "active" && !row.versionOf && canonicalScope(row.scope) === scope ? [row.id] : [];
          }) : [];
        });
        const closest = closestReadableRuleIds(input.rewrite.id, candidates);
        throw new RoleMemoryRefusal("RULE_NOT_READABLE", `rewrite must name an active readable rule of this stage${closest.length ? `; closest readable rule${closest.length > 1 ? "s" : ""}: ${closest.join(", ")}. Retry with an exact id` : ""}`);
      }
      if (sameRule(target.rule, input.rewrite.rule)) throw new RoleMemoryRefusal("LESSON_INVALID", "rewrite must change the rule text");
      const { updated, version } = versionedRule(tx, target, { rule: input.rewrite.rule, why: input.rewrite.why, hints: rulePrivacyHints(`${input.rewrite.rule}\n${input.rewrite.why}`) }, { by: "agent", at: now, source: { ...input.source, project } });
      const order = !target.curatedAt && !target.keptByOperatorAt ? [...held.active.filter(id => id !== target.id), target.id] : held.active;
      const active = order.flatMap(id => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; });
      const retained = retainRules(active, now, new Set([target.id]));
      for (const changed of retained.changed) tx.put(changed);
      const revision = held.revision + 1;
      tx.put({ ...held, revision, active: retained.active.map(rule => rule.id), history: keepHistory([...held.history, { revision, revisionScope: held.revisionScope ?? scope, at: now, by: "agent" as const, added: [], merged: [], archived: retained.archived, rewritten: [{ id: target.id, version }] }]) });
      if (request) tx.put({ ...request, rewrote: target.id });
      return { left: [{ action: "rewrite" as const, id: updated.id, version, scope, state: updated.state, scopeChars: scopeChars(retained.active), archived: retained.archived, hints: updated.hints }], none: null };
    }
    for (const lesson of input.lessons) {
      const scope = lesson.scope === "machine" ? MACHINE_SCOPE
        : lesson.scope === "project" ? projectScope(project)
        : roleScope(project, lesson.role ?? input.source.roleId!);
      const held = tx.get(`s:${scope}`);
      const current: RoleMemoryScopeRow = held?.kind === "scope" ? held : { kind: "scope", scope, revision: 0, active: [], history: [] };
      const active = current.active.flatMap((id) => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; });
      const hints = rulePrivacyHints(`${lesson.rule}\n${lesson.why}`);
      const incoming: RoleMemoryRule = {
        kind: "rule", id: newRuleId(tx), scope, rule: lesson.rule, why: lesson.why,
        state: "active", hints, source: { ...input.source, project }, createdAt: now, changedAt: now,
      };
      const outcome = appendRule(active, incoming, now);
      for (const changed of outcome.changed) tx.put(changed);
      const revision = current.revision + 1;
      tx.put({
        ...current, revision, active: outcome.active.map((entry) => entry.id),
        history: keepHistory([...current.history, { revision, revisionScope: current.revisionScope ?? scope, at: now, by: "agent" as const, added: outcome.added, merged: outcome.merged, archived: outcome.archived }]),
      });
      const stored = outcome.changed.find((entry) => entry.id === incoming.id)!;
      left.push({ action: "lesson", id: incoming.id, scope, state: stored.state, ...(stored.mergedInto ? { mergedInto: stored.mergedInto } : {}), scopeChars: scopeChars(outcome.active), archived: outcome.archived, hints });
    }
    const none = input.none ?? request?.none ?? null;
    if (request) tx.put({ ...request, ruleIds: [...request.ruleIds, ...left.map((entry) => entry.id)], none });
    return { left, none };
  });
  /* The agents' publication gate reads the new lesson from now on; a file
     that could not be rewritten is gone, and the gate refuses until it is. */
  if (result.left.length) { try { refreshLessonKnownValues(); } catch { /* fails closed */ } }
  return result;
}

/** The operator removes one rule from the injected list; it stays a record, archived as "deleted", and its scope's history says so. */
export function deleteRule(ruleId: string, now = new Date().toISOString()): RoleMemoryRule {
  joinMovedScopes(now);
  return roleMemoryCollection(true)!.boundedPatch(8, (tx) => {
    const rule = tx.get(`r:${ruleId}`);
    if (rule?.kind !== "rule") throw new RoleMemoryRefusal("RULE_NOT_FOUND", "no such rule");
    if (rule.versionOf) throw new RoleMemoryRefusal("RULE_IS_VERSION", "an earlier text is a version; revert it on its original rule");
    if (rule.state !== "active") throw new RoleMemoryRefusal("RULE_NOT_ACTIVE", "this rule is not in the injected list");
    const held = tx.get(`s:${canonicalScope(rule.scope)}`);
    if (held?.kind !== "scope") throw new RoleMemoryRefusal("RULE_NOT_FOUND", "the rule's scope is missing");
    const revision = held.revision + 1;
    const deleted: RoleMemoryRule = { ...rule, state: "archived", reason: "deleted", changedAt: now };
    tx.put(deleted);
    tx.put({ ...held, revision, active: held.active.filter((id) => id !== ruleId),
      history: keepHistory([...held.history, { revision, revisionScope: held.revisionScope ?? held.scope, at: now, by: "operator" as const, added: [], merged: [], archived: [ruleId] }]) });
    return deleted;
  });
}

/** Undo, and the way back for any rule that left: it returns to the end of its scope, which then keeps its bound as an append does. */
export function restoreRule(ruleId: string, now = new Date().toISOString()): RoleMemoryRule {
  joinMovedScopes(now);
  return roleMemoryCollection(true)!.boundedPatch(4096, (tx) => {
    const rule = tx.get(`r:${ruleId}`);
    if (rule?.kind !== "rule") throw new RoleMemoryRefusal("RULE_NOT_FOUND", "no such rule");
    if (rule.versionOf) throw new RoleMemoryRefusal("RULE_IS_VERSION", "an earlier text is a version; revert it on its original rule");
    if (rule.state === "active") return rule;
    const scope = canonicalScope(rule.scope);
    const held = tx.get(`s:${scope}`);
    const current: RoleMemoryScopeRow = held?.kind === "scope" ? held : { kind: "scope", scope, revision: 0, active: [], history: [] };
    const restored: RoleMemoryRule = { ...rule, scope, state: "active", changedAt: now, keptByOperatorAt: now };
    delete restored.reason;
    delete restored.mergedInto;
    delete restored.mergedAt;
    delete restored.against;
    delete restored.where;
    const next = [...current.active.flatMap((id) => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; }), restored];
    tx.put(restored);
    const retained = retainRules(next, now, new Set([ruleId]));
    for (const changed of retained.changed) tx.put(changed);
    const archived = retained.archived;
    const revision = current.revision + 1;
    tx.put({ ...current, revision, active: retained.active.map((entry) => entry.id),
      history: keepHistory([...current.history, { revision, revisionScope: current.revisionScope ?? scope, at: now, by: "operator" as const, added: [], merged: [], archived, restored: [ruleId] }]) });
    return restored;
  });
}

/** Restore an earlier text on its original rule and retain the text it replaces. */
export function revertRule(versionId: string, now = new Date().toISOString()): RoleMemoryRule {
  joinMovedScopes(now);
  const result = roleMemoryCollection(true)!.boundedPatch(4096, tx => {
    const version = tx.get(`r:${versionId}`);
    const current = version?.kind === "rule" && version.versionOf ? tx.get(`r:${version.versionOf}`) : null;
    if (version?.kind !== "rule" || !version.versionOf || current?.kind !== "rule" || !current.versions?.includes(version.id)) {
      throw new RoleMemoryRefusal("RULE_NOT_FOUND", "no such rule version");
    }
    const scope = canonicalScope(current.scope);
    const held = tx.get(`s:${scope}`);
    if (held?.kind !== "scope") throw new RoleMemoryRefusal("RULE_NOT_FOUND", "the rule's scope is missing");
    const { updated, version: replaced } = versionedRule(tx, current, version, { by: "operator", at: now, revertedTo: versionId });
    const active = held.active.flatMap(id => { const row = tx.get(`r:${id}`); return row?.kind === "rule" ? [row] : []; });
    const retained = retainRules(active, now, new Set([current.id]));
    for (const changed of retained.changed) tx.put(changed);
    const revision = held.revision + 1;
    tx.put({ ...held, revision, active: retained.active.map(rule => rule.id), history: keepHistory([...held.history, { revision, revisionScope: held.revisionScope ?? scope, at: now, by: "operator" as const, added: [], merged: [], archived: retained.archived, rewritten: [{ id: current.id, version: replaced }] }]) });
    return updated;
  });
  try { refreshLessonKnownValues(); } catch { /* egress fails closed */ }
  return result;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function revisionView(revision: RuleRevision): RuleRevisionView {
  return { by: revision.by, at: revision.at, ...(revision.revertedTo ? { revertedTo: revision.revertedTo } : {}),
    ...(revision.source ? { roleId: revision.source.roleId, fixRound: revision.source.fixRound } : {}) };
}

/** Request answers retain task provenance even when a curator replaces revisedBy.
    Split cutoffs bound merge ancestry as well as requests, and Undo restores the edges. */
function taskCounter(all: readonly RoleMemoryRow[], byId: ReadonlyMap<string, RoleMemoryRule>): (id: string) => number {
  const tasks = new Map<string, { key: string; at: string }[]>();
  const merged = new Map<string, string[]>();
  const mergeTimes = new Map<string, string>();
  const edgeKey = (from: string, into: string) => `${from}\0${into}`;
  for (const row of all) {
    if (row.kind === "request") {
      const key = row.taskId ?? `pipeline:${row.pipelineId}`;
      for (const id of [...row.ruleIds, ...(row.rewrote ? [row.rewrote] : [])]) {
        if (!tasks.has(id)) tasks.set(id, []);
        tasks.get(id)!.push({ key, at: row.at });
      }
    } else if (row.kind === "rule" && !row.versionOf && row.mergedInto) {
      if (!merged.has(row.mergedInto)) merged.set(row.mergedInto, []);
      merged.get(row.mergedInto)!.push(row.id);
    } else if (row.kind === "scope") {
      for (const history of row.history) for (const edge of history.merged) {
        const key = edgeKey(edge.from, edge.into);
        if (!mergeTimes.has(key) || mergeTimes.get(key)! < history.at) mergeTimes.set(key, history.at);
      }
    }
  }
  const mergedAt = (from: string, into: string) => byId.get(from)?.mergedAt ?? mergeTimes.get(edgeKey(from, into)) ?? byId.get(from)?.changedAt ?? "";
  return (id) => {
    const seen = new Set<string>();
    const keys = new Set<string>();
    const pending: { id: string; through?: string }[] = [{ id }];
    while (pending.length) {
      const current = pending.pop()!;
      const visitKey = `${current.id}\0${current.through ?? ""}`;
      if (seen.has(visitKey)) continue;
      seen.add(visitKey);
      for (const task of tasks.get(current.id) ?? []) {
        if (!current.through || task.at <= current.through) keys.add(task.key);
      }
      const row = byId.get(current.id);
      pending.push(...(merged.get(current.id) ?? [])
        .filter(parent => !current.through || mergedAt(parent, current.id) <= current.through)
        .map(parent => ({ id: parent, through: current.through })),
        ...(row?.mergedFrom ?? []).filter(parent => !current.through || mergedAt(parent, current.id) <= current.through)
          .map(parent => ({ id: parent, through: current.through })));
      if (row?.versionOf) pending.push({ id: row.versionOf, through: current.through });
      if (row?.splitFrom) pending.push({ id: row.splitFrom, through: !current.through || (row.splitAt && row.splitAt < current.through) ? row.splitAt : current.through });
    }
    return keys.size;
  };
}

function view(row: RoleMemoryRule, now: number, byId: ReadonlyMap<string, RoleMemoryRule>, history: RoleMemoryScopeRow["history"], tasks: number): RuleView {
  const agentRevision = history.filter(change => change.by === "agent" && (change.added.includes(row.id) || change.merged.some(item => item.into === row.id) || change.rewritten?.some(item => item.id === row.id)))
    .reduce((latest, change) => Math.max(latest, change.revision), 0);
  const curatorRevision = history.filter(change => change.by === "curator" && !change.revertedAt)
    .reduce((latest, change) => Math.max(latest, change.revision), 0);
  const awaitingCuration = !row.curatedAt || (agentRevision && curatorRevision ? agentRevision > curatorRevision
    : row.revisedBy?.by === "agent" && row.revisedBy.at > row.curatedAt);
  /* A text equal to the one in force is not an earlier text: returning to it would change nothing. */
  const earlier = (row.versions ?? []).flatMap(id => {
    const prior = byId.get(id);
    return prior && !(prior.rule === row.rule && prior.why === row.why)
      ? [{ id: prior.id, rule: prior.rule, why: prior.why, hints: prior.hints, createdAt: prior.createdAt, ...(prior.revisedBy ? { revisedBy: revisionView(prior.revisedBy) } : {}) }] : [];
  });
  return {
    id: row.id, rule: row.rule, why: row.why, state: row.state, hints: row.hints, tasks,
    ...(row.reason ? { reason: row.reason } : {}), ...(row.mergedInto ? { mergedInto: row.mergedInto } : {}),
    roleId: row.source.roleId, fixRound: row.source.fixRound, stageId: row.source.origin === "seat" ? "seat" : row.source.origin === "import" ? "import" : row.source.stageId,
    ...(row.source.origin === "import" ? { importSource: { candidate: row.source.candidate, occurrences: row.source.occurrences, engine: row.source.engine, sha256: row.source.sha256, importId: row.source.importId } } : {}),
    fresh: now - Date.parse(row.createdAt) < DAY_MS, createdAt: row.createdAt, changedAt: row.changedAt,
    ...(row.revisedBy ? { revisedBy: revisionView(row.revisedBy) } : {}),
    ...(row.curatedAt ? { curatedAt: row.curatedAt } : {}),
    awaitingCuration: !!awaitingCuration,
    ...(row.keptByOperatorAt ? { keptByOperatorAt: row.keptByOperatorAt } : {}),
    ...(row.note ? { note: row.note } : {}), ...(row.where ? { where: row.where } : {}), ...(row.against ? { against: row.against } : {}),
    ...(row.mergedFrom ? { mergedFrom: row.mergedFrom } : {}), ...(row.movedFrom ? { movedFrom: row.movedFrom } : {}), ...(row.splitFrom ? { splitFrom: row.splitFrom } : {}),
    ...(earlier.length ? { versions: earlier } : {}),
  };
}

/** The rules window: every scope the project reads or wrote, with what left each. */
export function projectView(project: string, now = Date.now()): RoleMemoryProjectView {
  return withViewerOperation("role-memory.view", () => performanceSpans.sync("memory.project-view", () => projectViewMemo(project, now)));
}

/** Production readers yield between bounded history slices on cold and revised views. */
export async function projectViewAsync(project: string, now = Date.now()): Promise<RoleMemoryProjectView> {
  return withViewerOperation("role-memory.view", () => projectViewAsyncMemo(project, now));
}

type ProjectViewMemo = { stamp: string; guard: string; from: number; until: number; bytes: number; value: RoleMemoryProjectView };
// One LRU across Next server bundles, bounded by both entries and serialized
// bytes. It owns only rendered views; scope histories never enter this memo.
const projectViewOwner = globalThis as typeof globalThis & { __llvProjectViews?: Map<string, ProjectViewMemo> };
const projectViews = projectViewOwner.__llvProjectViews ??= new Map();
const PROJECT_VIEW_MEMO_BYTES = 8 * 1024 * 1024;
const PROJECT_VIEW_MEMO_ENTRIES = 16;
function freezeProjectView<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeProjectView(child);
    Object.freeze(value);
  }
  return value;
}
function timedProjectView(value: RoleMemoryProjectView, now: number): RoleMemoryProjectView {
  const curation = value.curation;
  return { ...value, ...(curation ? { curation: { ...curation,
    nextAt: curation.nextAt && Date.parse(curation.nextAt) < now ? new Date(now).toISOString() : curation.nextAt } } : {}) };
}
function projectViewContext(project: string, now: number): {
  canonical: string; file: string; memoKey: string; guard: string; enabled: boolean;
  stamp: () => string; hit: RoleMemoryProjectView | null;
} {
  const canonical = canonicalProject(project);
  const file = statePath("state.sqlite");
  const memoKey = `${file}:${canonical}`;
  const settingsFile = seatTickSettingsPath();
  const fileStamp = (filename: string) => {
    try { const stat = fs.statSync(filename, { bigint: true }); return `${filename}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${filename}:missing`; throw error; }
  };
  // The fast guard observes peer commits before checking collection revisions.
  // File settings can change independently of SQLite.
  // A relocated settings store has its own SQLite authority.
  const settingsDatabase = path.join(path.dirname(settingsFile), "state.sqlite");
  const guard = `${roleViewVersion()}:${settingsDatabase === file ? "" : stateDatabaseSignature(settingsDatabase)}:${[projectStoreSignature("project-aliases.json", path.dirname(file)), ...[path.join(path.dirname(file), "memory-source.json"), settingsFile].map(fileStamp)].join("|")}:${process.env.LLV_ROLE_MEMORY}`;
  const memo = projectViews.get(memoKey);
  if (memo?.guard === guard && now >= memo.from && now < memo.until) {
    projectViews.delete(memoKey); projectViews.set(memoKey, memo);
    return { canonical, file, memoKey, guard, enabled: roleMemoryEnabled(), stamp: () => "", hit: timedProjectView(memo.value, now) };
  }
  const enabled = roleMemoryEnabled();
  const stamp = () => `${databaseFileIdentity(file)}:${roleMemoryCollection()?.revision()}:${curationRevision()}:${enabled}:${JSON.stringify(projectAliasSnapshot().aliases)}:${JSON.stringify(effectiveCurationSetting(readSeatTickSettings(canonical)))}`;
  const revision = stamp();
  if (memo?.stamp === revision && now >= memo.from && now < memo.until) {
    memo.guard = guard;
    projectViews.delete(memoKey); projectViews.set(memoKey, memo);
    return { canonical, file, memoKey, guard, enabled, stamp, hit: timedProjectView(memo.value, now) };
  }
  return { canonical, file, memoKey, guard, enabled, stamp, hit: null };
}

function projectViewMemo(project: string, now: number): RoleMemoryProjectView {
  const context = projectViewContext(project, now);
  if (context.hit) return context.hit;
  joinMovedScopes();
  const buildRevision = context.stamp();
  const all = projectViewRows(context.canonical);
  return buildProjectView(context, now, buildRevision, all);
}

async function projectViewAsyncMemo(project: string, now: number): Promise<RoleMemoryProjectView> {
  const context = projectViewContext(project, now);
  if (context.hit) return context.hit;
  joinMovedScopes();
  const buildRevision = context.stamp();
  const all = await projectViewRowsCooperatively(context.canonical);
  return performanceSpans.sync("memory.project-view", () => buildProjectView(context, now, buildRevision, all));
}

function buildProjectView(context: ReturnType<typeof projectViewContext>, now: number, buildRevision: string, all: RoleMemoryRow[]): RoleMemoryProjectView {
  const { canonical, file, memoKey, guard, enabled, stamp } = context;
  const resolve = scopeResolver();
  const rulesById = new Map<string, RoleMemoryRule>();
  const scopesByKey = new Map<string, RoleMemoryScopeRow>();
  const leftByScope = new Map<string, RoleMemoryRule[]>();
  let until = Infinity;
  for (const row of all) {
    if (row.kind === "scope") scopesByKey.set(row.scope, row);
    if (row.kind !== "rule") continue;
    rulesById.set(row.id, row);
    const boundary = Date.parse(row.createdAt) + DAY_MS;
    if (boundary > now) until = Math.min(until, boundary);
    if (row.state !== "active" && !row.versionOf) {
      const scope = resolve(row.scope), list = leftByScope.get(scope) ?? [];
      list.push(row); leftByScope.set(scope, list);
    }
  }
  const ruleTasks = taskCounter(all, rulesById);
  const wanted = [...all.flatMap((row) => row.kind === "scope" && (scopeProject(row.scope) === canonical || isCrossProjectRoleScope(row.scope)) && scopeKind(row.scope) === "role" ? [row.scope] : []).sort(),
    projectScope(canonical), MACHINE_SCOPE];
  const scopes: ScopeView[] = wanted.map((scope) => {
    const held = scopesByKey.get(scope);
    const active = (held?.active ?? []).flatMap((id) => { const found = rulesById.get(id); return found ? [found] : []; });
    const left = (leftByScope.get(scope) ?? [])
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
    return {
      scope, kind: scopeKind(scope), roleId: scopeRole(scope), revision: held?.revision ?? 0,
      chars: scopeChars(active), bound: ROLE_MEMORY_BOUND,
      addedToday: active.filter((row) => now - Date.parse(row.createdAt) < DAY_MS).length,
      active: active.map((row) => view(row, now, rulesById, held?.history ?? [], ruleTasks(row.id))), left: left.map((row) => view(row, now, rulesById, held?.history ?? [], ruleTasks(row.id))),
    };
  });
  const value = { project: canonical, enabled, scopes, curation: curationView(canonical, now, all.flatMap(row => row.kind === "scope" ? [row] : []), false) };
  if (stamp() !== buildRevision) throw new StateSnapshotChangedError();
  const bytes = Buffer.byteLength(JSON.stringify(value));
  projectViews.delete(memoKey);
  freezeProjectView(value);
  if (bytes <= PROJECT_VIEW_MEMO_BYTES) projectViews.set(memoKey, { stamp: buildRevision, guard, from: now, until, bytes, value });
  let total = [...projectViews.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (projectViews.size > PROJECT_VIEW_MEMO_ENTRIES || total > PROJECT_VIEW_MEMO_BYTES) {
    const oldest = projectViews.keys().next().value!;
    total -= projectViews.get(oldest)!.bytes; projectViews.delete(oldest);
  }
  return timedProjectView(value, now);
}

/** What each stage attempt of a project left, for the line under its report on the card. */
export function stageLessons(project: string): StageLessonView[] {
  const canonical = canonicalProject(project);
  const resolved = new Map<string, string>();
  const projectOf = (key: string) => { let found = resolved.get(key); if (found === undefined) resolved.set(key, found = canonicalProject(key)); return found; };
  const all = rows();
  const rulesById = new Map(all.flatMap((row) => row.kind === "rule" ? [[row.id, row] as const] : []));
  return all.flatMap((row) => row.kind === "request" && projectOf(row.project) === canonical ? [row] : [])
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400)
    .map((row) => ({
      pipelineId: row.pipelineId, stageId: row.stageId, attempt: row.attempt, none: row.none, ...(row.rewrote ? { rewrote: row.rewrote } : {}),
      rules: (row.rewrote ? [row.rewrote] : row.ruleIds).flatMap((id) => {
        const found = rulesById.get(id);
        return found ? [{ id, rule: found.rule, scope: scopeKind(found.scope), roleId: scopeRole(found.scope) }] : [];
      }),
    }));
}

/* Lesson text stays on this machine. The instruction in every prompt asks for
   that; these are the checks behind it at the boundaries where text leaves a
   stage: the next stage's prompt and the files composed for it, the linked
   board's wire, the bridge and issue reports, and the publication privacy
   gate, for the controller's push and for every agent's own. Every stored
   rule and why counts, active or not; the record itself is untouched.

   Each check fails closed. A store that exists and cannot be read names no
   lesson to look for, so the work that would carry text out is refused with
   LESSON_PRIVACY_UNAVAILABLE instead of sent unchecked; a store never
   created holds no lesson and refuses nothing. */

/** What a stored lesson becomes in outgoing text. */
export const WITHHELD_LESSON = "[learned rule]";

const UNREADABLE = "role memory could not be read, so its learned rules cannot be kept out of outgoing text; nothing was sent. Repair or restore state.sqlite, or set LLV_ROLE_MEMORY=off and remove the role_memory rows";

/** The stored rows, or a refusal that quotes nothing a row holds. */
function readableRows(): { rows: RoleMemoryRow[]; signature: string } {
  try {
    const held = roleMemoryCollection();
    return held ? { signature: held.signature(), rows: held.snapshot() as RoleMemoryRow[] } : { signature: "", rows: [] };
  } catch {
    throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", UNREADABLE);
  }
}

function lessonTextsOf(all: readonly RoleMemoryRow[]): string[] {
  const texts = new Set<string>();
  for (const row of all) if (row.kind === "rule") for (const text of [row.rule, row.why]) if (lessonPatternSource(text)) texts.add(text);
  return [...texts].sort((a, b) => b.length - a.length);
}

/** Every stored rule and why, longest first. Throws LESSON_PRIVACY_UNAVAILABLE when the store cannot be read. */
export function storedLessonTexts(): string[] {
  return lessonTextsOf(readableRows().rows);
}

// Leave headroom under JSC's limit and keep compilation quick on a cache miss.
const LESSON_MATCHER_SOURCE_LIMIT = 32_000;
interface LessonMatcher { pattern: RegExp; prefilter: RegExp | null }
interface LessonSource { source: string; words: string[]; anchor?: string }
type MatcherCache = { key: string; matchers: LessonMatcher[]; skipped: number; texts: string[]; exact?: RegExp[] };
const matcherHost = globalThis as typeof globalThis & { __delegatusLessonMatcher?: MatcherCache };
let privacyPhase: ((phase: "compile" | "match") => void) | undefined;
/** Installed only by the leased worker; carries static phase names, never text. */
export function observeLessonPrivacyPhase(observer: typeof privacyPhase) { privacyPhase = observer; }
function privacyWork<T>(phase: "compile" | "match", work: () => T): T {
  privacyPhase?.(phase);
  return withViewerOperation(`memory.privacy.${phase}`, () => performanceSpans.sync(`privacy.${phase}`, work));
}
/** The readable store revision and file identity, without cloning its rows. */
const privacyRevisionHost = globalThis as typeof globalThis & {
  __llvLessonPrivacyRevision?: { file: string; signature: string; revision: string };
};
export function storedLessonRevision(): string {
  try {
    const file = statePath("state.sqlite");
    const identity = () => {
      const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
      return stat ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : "absent";
    };
    const signature = `${identity()}:${stateDatabaseSignature(file)}`;
    const cached = privacyRevisionHost.__llvLessonPrivacyRevision;
    if (cached?.file === file && cached.signature === signature) return cached.revision;
    const held = roleMemoryCollection();
    const stat = held ? fs.statSync(held.filename, { bigint: true }) : null;
    const revision = held && stat ? `${stat.dev}:${stat.ino}:${held.signature()}` : "";
    if (`${identity()}:${stateDatabaseSignature(file)}` === signature) privacyRevisionHost.__llvLessonPrivacyRevision = { file, signature, revision };
    return revision;
  } catch { throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", UNREADABLE); }
}

/** Bounded alternatives in longest-first order, cached for this store signature. */
function storedLessonMatchers(): LessonMatcher[] {
  const signature = storedLessonRevision();
  if (matcherHost.__delegatusLessonMatcher?.key === signature) return matcherHost.__delegatusLessonMatcher.matchers;
  return privacyWork("compile", () => compileStoredLessonMatchers(signature));
}
function compileStoredLessonMatchers(signature: string): LessonMatcher[] {
  const { rows: all } = readableRows();
  if (matcherHost.__delegatusLessonMatcher?.key !== signature) {
    const matchers: LessonMatcher[] = [];
    let skipped = 0;
    const sources: LessonSource[] = [];
    const frequency = new Map<string, number>();
    const texts = lessonTextsOf(all);
    for (const text of texts) {
      const source = lessonPatternSource(text);
      if (!source) continue;
      const wrapped = `(?:${source})`;
      if (wrapped.length > LESSON_MATCHER_SOURCE_LIMIT) { skipped += 1; continue; }
      const words = [...new Set(text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])];
      sources.push({ source: wrapped, words });
      for (const word of words) {
        const key = word.toLowerCase();
        frequency.set(key, (frequency.get(key) ?? 0) + 1);
      }
    }
    for (const source of sources) {
      source.anchor = source.words.sort((a, b) => frequency.get(a.toLowerCase())! - frequency.get(b.toLowerCase())! || b.length - a.length)[0];
    }
    const compile = (sources: LessonSource[]) => {
      if (!sources.length) return;
      try {
        // Every alternative requires its anchor word. Use the same Unicode
        // case folding and word boundaries as lessonPattern; string lowercasing
        // alone would miss matches such as long s, Kelvin sign or final sigma.
        const anchors = [...new Set(sources.map(source => source.anchor))];
        const prefilter = anchors.includes(undefined) ? null
          : new RegExp(`(?<![\\p{L}\\p{N}])(?:${anchors.join("|")})(?![\\p{L}\\p{N}])`, "iu");
        matchers.push({ pattern: new RegExp(sources.map(source => source.source).join("|"), "giu"), prefilter });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Engine limits also depend on pattern complexity. Split a refused
        // batch again; only an individually uncompilable lesson is skipped.
        if (sources.length === 1) { skipped += 1; return; }
        const middle = Math.floor(sources.length / 2);
        compile(sources.slice(0, middle));
        compile(sources.slice(middle));
      }
    };
    let chunk: LessonSource[] = [];
    let length = 0;
    for (const source of sources) {
      const added = source.source.length + Number(chunk.length > 0);
      if (length + added > LESSON_MATCHER_SOURCE_LIMIT) {
        compile(chunk);
        chunk = [];
        length = 0;
      }
      length += source.source.length + Number(chunk.length > 0);
      chunk.push(source);
    }
    compile(chunk);
    if (storedLessonRevision() !== signature) throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", UNREADABLE);
    matcherHost.__delegatusLessonMatcher = { key: signature, matchers, skipped, texts };
    if (skipped) console.warn(`stored-lesson matcher skipped ${skipped} oversized or uncompilable lesson text(s)`);
  }
  return matcherHost.__delegatusLessonMatcher.matchers;
}

/** Exact per-lesson occurrences preserve report hint ordering and overlaps.
 * These patterns and replacement chunks share one revision and one cache slot. */
export function storedLessonPatterns(): readonly RegExp[] {
  storedLessonMatchers();
  const held = matcherHost.__delegatusLessonMatcher!;
  return held.exact ??= privacyWork("compile", () => held.texts.flatMap(text => {
    const source = lessonPatternSource(text);
    return source === null ? [] : [new RegExp(source, "giu")];
  }));
}

/** Merge matches on the original text: earliest start wins, and a tie goes
    to the first (longest-first) chunk. Replacing chunk by chunk would change
    overlapping matches and could match across an inserted placeholder. */
function withholdLessons(text: string, chunks: readonly LessonMatcher[]): string {
  const matchers = chunks.filter(chunk => !chunk.prefilter || chunk.prefilter.test(text)).map(chunk => chunk.pattern);
  if (!text || !matchers.length) return text;
  const matches = matchers.map(matcher => {
    matcher.lastIndex = 0;
    return matcher.exec(text);
  });
  const pieces: string[] = [];
  let end = 0;
  while (true) {
    let next: RegExpExecArray | null = null;
    for (const match of matches) if (match && (!next || match.index < next.index)) next = match;
    if (!next) break;
    pieces.push(text.slice(end, next.index), WITHHELD_LESSON);
    end = next.index + next[0].length;
    for (let i = 0; i < matches.length; i += 1) {
      if (matches[i] && matches[i]!.index < end) {
        matchers[i].lastIndex = end;
        matches[i] = matchers[i].exec(text);
      }
    }
  }
  if (!pieces.length) return text;
  pieces.push(text.slice(end));
  return pieces.join("");
}

/** Class-only reports need existence, including a lesson equal to the marker. */
export function hasStoredLesson(text: string): boolean {
  const chunks = storedLessonMatchers();
  return privacyWork("match", () => chunks.some(chunk => {
    if (chunk.prefilter && !chunk.prefilter.test(text)) return false;
    chunk.pattern.lastIndex = 0;
    return chunk.pattern.test(text);
  }));
}

/** The text with every stored lesson it quotes withheld. */
export function withoutStoredLessons(text: string): string {
  if (!text) return text;
  const chunks = storedLessonMatchers();
  return privacyWork("match", () => withholdLessons(text, chunks));
}

/** withoutStoredLessons over every text a record holds, however deep; the
    record itself when none quotes a lesson. */
export function withoutStoredLessonsIn<T>(value: T, options: { requireComplete?: boolean } = {}): T {
  const matchers = storedLessonMatchers();
  if (options.requireComplete && matcherHost.__delegatusLessonMatcher?.skipped) {
    throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", "a stored lesson could not be compiled by the privacy matcher; nothing was sent");
  }
  if (!matchers.length) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return withholdLessons(item, matchers);
    if (Array.isArray(item)) {
      const mapped = item.map(walk);
      return mapped.some((entry, index) => entry !== item[index]) ? mapped : item;
    }
    if (item && typeof item === "object") {
      let changed = false;
      const mapped = Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        const next = walk(entry);
        if (next !== entry) changed = true;
        return [key, next];
      }));
      return changed ? mapped : item;
    }
    return item;
  };
  return privacyWork("match", () => walk(value) as T);
}

/** Where the stored lessons are kept as the publication gate's known values:
    one path for the installation, rewritten after every lesson. */
export function lessonKnownValuesFile(): string {
  return path.join(statePath("role-memory"), "known-values.txt");
}

/** Rewrites the known-values file from the store, again when a lesson landed
    while it was written. When the store cannot be read the file is removed,
    and the gate refuses a push whose known-values file is missing. */
export function refreshLessonKnownValues(): string {
  const file = lessonKnownValuesFile();
  const directory = path.dirname(file);
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const { rows: all, signature } = readableRows();
      const texts = lessonTextsOf(all);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, texts.length ? `${texts.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      if (readableRows().signature === signature) return file;
    }
    return file;
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error instanceof RoleMemoryRefusal ? error : new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", UNREADABLE);
  }
}

/** The publication privacy gate's environment for the controller's push:
    every stored lesson as a known value, so a push that carries one is
    refused like any other private value. Throws LESSON_PRIVACY_UNAVAILABLE
    when the store cannot be read. */
export function lessonPublicationEnv(): { LLV_PRIVACY_KNOWN_VALUES_FILE: string } {
  return { LLV_PRIVACY_KNOWN_VALUES_FILE: refreshLessonKnownValues() };
}

/** The same input for an agent's own pushes, through its pre-push hook. The
    path is handed at launch and the file is rewritten after every lesson, so
    a lesson learned while the agent runs is refused too. A store that cannot
    be read leaves no file, and the gate then refuses every push. */
export function agentLessonPublicationEnv(): { LLV_PRIVACY_KNOWN_VALUES_FILE: string } {
  const file = lessonKnownValuesFile();
  if (!fs.existsSync(file)) {
    try { refreshLessonKnownValues(); } catch { /* no file: the gate refuses */ }
  }
  return { LLV_PRIVACY_KNOWN_VALUES_FILE: file };
}
