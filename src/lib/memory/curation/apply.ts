import fs from "node:fs";
import path from "node:path";
import { staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import { ROLE_IDS } from "@/lib/roles/types";
import { roleIsClean } from "../eligibility";
import { lettersAndDigits, scopeChars } from "../roleConsolidate";
import { taskIdentifier } from "../roleStage";
import { canonicalScope, joinMovedScopes, newRuleId, refreshLessonKnownValues, roleMemoryCollection, RoleMemoryRefusal, versionedRule } from "../roleStore";
import { scopeKind, scopeProject, scopeRole, isCrossProjectRoleScope } from "../roleScopes";
import { lessonText, lessonTextLength, ROLE_MEMORY_BOUND, RULE_MAX_CHARS, RULE_MIN_CHARS, WHY_MAX_CHARS, type CuratorReason, type RoleMemoryRule, type RoleMemoryRow, type RoleMemoryScopeRow } from "../roleTypes";
import { patchPass, readPass, passIsLive, type CuratorPass } from "./store";

export interface CurationApply {
  scopes: { scope: string; revision: number; order: string[] }[];
  rewrite?: { id: string; rule: string; why?: string; note: string }[];
  merge?: { into: string; from: string[]; rule: string; why?: string; note: string }[];
  move?: { id: string; to: string; note?: string }[];
  split?: { id: string; parts: { to: string; rule: string; why?: string }[]; note: string }[];
  archive?: { id: string; reason: CuratorReason; against?: string; where?: string; note: string }[];
  restore?: string[];
}
function refuse(code: string, message: string): never { throw new RoleMemoryRefusal(code, message); }
function note(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) return refuse("CURATE_INVALID", "every editorial change needs a note of 1–1000 characters");
  return value.trim();
}
function text(rule: string, why: string) {
  const r = lessonText(rule), w = lessonText(why);
  if (lessonTextLength(r) < RULE_MIN_CHARS || lessonTextLength(r) > RULE_MAX_CHARS || lessonTextLength(w) > WHY_MAX_CHARS || lettersAndDigits(r) < 16 || lettersAndDigits(w) < 16) refuse("CURATE_INVALID", "rule or why is outside the lesson limits");
  if (taskIdentifier(r)) refuse("LESSON_ABOUT_ONE_TASK", "curator text must hold across tasks without a task identifier");
  return { rule: r, why: w, hints: [...staticSensitiveClasses(`${r}\n${w}`.normalize("NFKC"))].sort() };
}
function reaches(to: string, from: string) {
  return to === from || to === "machine" || scopeKind(to) === "project" && scopeProject(to) === scopeProject(from)
    || isCrossProjectRoleScope(to) && scopeKind(from) === "role" && scopeRole(to) === scopeRole(from);
}
function noRoleReader(role: string | null) {
  return role && (!(ROLE_IDS as readonly string[]).includes(role) || roleIsClean(role) || role === "orchestrator" || role === "maintainer");
}
function evidence(repo: string | null, where: string | undefined) {
  if (!repo || !where) return refuse("CURATE_EVIDENCE", "in-code and in-instructions require a repository file, optionally with a line");
  const relative = where.replace(/:\d+$/, "");
  const root = fs.realpathSync(repo);
  let resolved: string;
  try { resolved = fs.realpathSync(path.resolve(root, relative)); } catch { return refuse("CURATE_EVIDENCE", "evidence file does not exist"); }
  if (path.isAbsolute(relative) || !resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile()) refuse("CURATE_EVIDENCE", "evidence must name a file inside this repository");
}

/** The partition, all text and every level boundary are checked before any row is committed. */
export function applyCuration(pass: CuratorPass, input: CurationApply, now = new Date().toISOString()) {
  const fresh = readPass(pass.id);
  if (!fresh || !passIsLive(fresh)) refuse("CURATE_ENDED", "this curator pass has ended");
  joinMovedScopes(now);
  const allowedScopes = new Set(fresh.scopes.map(canonicalScope));
  if (!input.scopes?.length || input.scopes.length > 64) refuse("CURATE_INVALID", "name 1–64 scopes");
  const result = roleMemoryCollection(true)!.boundedPatch(4096, tx => {
    if (!passIsLive(readPass(pass.id))) refuse("CURATE_ENDED", "this curator pass has ended");
    const previousAt = Math.max(0, ...[...allowedScopes].flatMap(scope => { const row = tx.get(`s:${scope}`); return row?.kind === "scope" ? row.history.filter(h => h.pass === pass.id).map(h => Date.parse(h.at)) : []; }));
    now = new Date(Math.max(Date.parse(now), previousAt + 1)).toISOString();
    const scopes = new Map<string, RoleMemoryScopeRow>();
    const before = new Map<string, RoleMemoryRule>();
    for (const item of input.scopes) {
      if (!allowedScopes.has(item.scope) || scopes.has(item.scope)) refuse("CURATE_SCOPE", "every scope must belong to this pass exactly once");
      const held = tx.get(`s:${item.scope}`);
      const row: RoleMemoryScopeRow = held?.kind === "scope" ? held : { kind: "scope", scope: item.scope, revision: 0, active: [], history: [] };
      if (item.revision !== row.revision) refuse("CURATE_STALE", `${item.scope} is now revision ${row.revision}; read it again`);
      scopes.set(item.scope, row);
      for (const id of row.active) {
        const rule = tx.get(`r:${id}`);
        if (rule?.kind !== "rule" || rule.versionOf || rule.state !== "active" || canonicalScope(rule.scope) !== item.scope) refuse("CURATE_INVALID", "scope has an invalid active row");
        before.set(id, { ...rule, scope: item.scope });
      }
    }
    const target = (scope: string) => {
      if (!scopes.has(scope)) refuse("CURATE_SCOPE", "name every source and target scope in this call");
      const role = scopeRole(scope);
      if (noRoleReader(role)) refuse("CURATE_NO_READER", "target role reads no learned rules");
    };
    const get = (id: string) => before.get(id) ?? refuse("CURATE_INVALID", "operation source must be active before this call in a named scope; split placeholders belong only in order, then read the new ids before editing parts");
    const work = new Map([...before].map(([id, rule]) => [id, structuredClone(rule)]));
    const touched = new Set<string>();
    const dispositions = new Set<string>();
    const created = new Map<string, RoleMemoryRule>();
    const placeholders: Record<string, string> = {};
    const dispose = (id: string, protectedOperation = false) => {
      const rule = get(id);
      if (dispositions.has(id)) refuse("CURATE_PARTITION", "a rule has two dispositions");
      if (protectedOperation && rule.keptByOperatorAt) refuse("CURATE_KEPT", "the operator returned this rule; keep it whole and active");
      dispositions.add(id); touched.add(id); return work.get(id)!;
    };
    for (const id of input.restore ?? []) {
      if (work.has(id)) refuse("CURATE_PARTITION", "restore ids must be distinct archived rules");
      const row = tx.get(`r:${id}`);
      if (row?.kind !== "rule" || row.versionOf || row.state !== "archived" || row.reason === "deleted" || !scopes.has(canonicalScope(row.scope))) refuse("CURATE_RESTORE", "restore must name an archived non-version rule in a named scope, except operator removals");
      before.set(id, row); work.set(id, { ...row, scope: canonicalScope(row.scope), state: "active", reason: undefined, mergedInto: undefined, against: undefined, where: undefined }); touched.add(id);
    }
    for (const item of input.rewrite ?? []) {
      const rule = get(item.id); note(item.note);
      if (touched.has(item.id)) refuse("CURATE_PARTITION", "a rule has two text edits");
      work.set(item.id, { ...work.get(item.id)!, ...text(item.rule, item.why ?? rule.why), note: item.note }); touched.add(item.id);
    }
    const moved = new Set<string>();
    for (const item of input.move ?? []) {
      const rule = get(item.id); target(item.to); note(item.note);
      if (moved.has(item.id) || dispositions.has(item.id)) refuse("CURATE_PARTITION", "a rule has two moves");
      work.set(item.id, { ...work.get(item.id)!, scope: item.to, movedFrom: rule.scope, note: note(item.note) }); moved.add(item.id); touched.add(item.id);
    }
    for (const item of input.split ?? []) {
      const rule = dispose(item.id, true); note(item.note);
      if (moved.has(item.id) || (input.rewrite ?? []).some(edit => edit.id === item.id) || item.parts.length < 2) refuse("CURATE_PARTITION", "split needs at least two parts and one source disposition");
      item.parts.forEach((part, index) => {
        target(part.to);
        if (scopeKind(rule.scope) === "role" && scopeKind(part.to) !== "role") note(item.note);
        const fields = text(part.rule, part.why ?? rule.why);
        if (!index) work.set(item.id, { ...rule, ...fields, scope: part.to, note: item.note, movedFrom: rule.scope });
        else {
          const id = newRuleId({ get: key => created.has(key.slice(2)) ? created.get(key.slice(2))! : tx.get(key) });
          const row: RoleMemoryRule = { ...rule, ...fields, id, scope: part.to, createdAt: now, changedAt: now, versions: [], splitFrom: rule.id, note: item.note };
          delete row.keptByOperatorAt; delete row.versionOf;
          created.set(id, row); work.set(id, row); placeholders[`split:${item.id}:${index}`] = id;
        }
      });
    }
    const mergedTargets = new Set<string>();
    for (const item of input.merge ?? []) {
      const into = work.get(item.into) ?? refuse("CURATE_INVALID", "merge target is not active in this call"); note(item.note);
      if (mergedTargets.has(item.into) || dispositions.has(item.into) || (input.rewrite ?? []).some(edit => edit.id === item.into) || !item.from.length || item.from.includes(item.into)) refuse("CURATE_PARTITION", "merge needs a distinct surviving target and sources");
      target(into.scope); mergedTargets.add(item.into);
      for (const id of item.from) {
        if (mergedTargets.has(id)) refuse("CURATE_PARTITION", "every merge target must remain active after this call");
        const from = dispose(id, true);
        if (!reaches(into.scope, from.scope)) refuse("CURATE_NARROWS", "merge must preserve the reach of every source");
        if (scopeKind(from.scope) === "role" && scopeKind(into.scope) !== "role") note(item.note);
        work.set(id, { ...from, state: "merged", reason: "duplicate", mergedInto: item.into, note: item.note });
      }
      work.set(item.into, { ...into, ...text(item.rule, item.why ?? into.why), note: item.note, mergedFrom: [...(into.mergedFrom ?? []), ...item.from] }); touched.add(item.into);
    }
    const reasons: CuratorReason[] = ["task-specific", "stale", "in-code", "in-instructions", "no-reader", "contradicted", "duplicate"];
    for (const item of input.archive ?? []) {
      const rule = dispose(item.id, true);
      if (moved.has(item.id) || mergedTargets.has(item.id) || !reasons.includes(item.reason)) refuse("CURATE_PARTITION", "archive needs one valid disposition");
      note(item.note);
      if (item.reason === "in-code" || item.reason === "in-instructions" || item.where) evidence(pass.repoDir, item.where);
      if ((item.reason === "contradicted" || item.reason === "duplicate") && !item.against) refuse("CURATE_INVALID", "contradiction or duplicate needs an active counterpart");
      work.set(item.id, { ...rule, state: "archived", reason: item.reason, note: item.note, where: item.where, against: item.against });
    }
    const orders = new Map<string, string[]>();
    const ordered = new Set<string>();
    for (const item of input.scopes) {
      const ids = item.order.map(id => placeholders[id] ?? id);
      for (const id of ids) {
        const rule = work.get(id);
        if (rule && noRoleReader(scopeRole(item.scope))) refuse("CURATE_NO_READER", "a role without a learned-rule reader cannot retain active rules");
        if (ordered.has(id) || !rule || rule.state !== "active" || rule.scope !== item.scope) refuse("CURATE_PARTITION", "order must contain each surviving rule once in its final scope");
        ordered.add(id);
      }
      const active = ids.map(id => work.get(id)!);
      if (scopeChars(active) > Math.max(ROLE_MEMORY_BOUND, scopeChars(scopes.get(item.scope)!.active.map(id => before.get(id)!)))) refuse("CURATE_BOUND", "the resulting scope exceeds its character bound");
      orders.set(item.scope, ids.slice().reverse());
    }
    for (const [id, rule] of work) {
      if (rule.state === "active" && !ordered.has(id)) refuse("CURATE_PARTITION", "every active rule needs an order or disposition");
      if (rule.against) {
        const against = work.get(rule.against) ?? tx.get(`r:${rule.against}`);
        if (rule.against === id || against?.kind !== "rule" || against.versionOf || against.state !== "active" || !allowedScopes.has(canonicalScope(against.scope))) refuse("CURATE_INVALID", "against must name a rule active after this call");
      }
    }
    // Rank is a change too; keep its prior metadata without manufacturing a text version.
    const prior = new Map<string, { id: string; version: string | null; fields: Omit<RoleMemoryRule, "rule" | "why" | "hints"> }>();
    for (const [id, row] of before) {
      const { rule, why, hints, ...fields } = row;
      void hints;
      const next = work.get(id)!;
      const edited = next.rule !== rule || next.why !== why;
      const saved = edited ? versionedRule(tx, row, next, { by: "curator", at: now }) : null;
      tx.put({ ...next, versions: saved?.updated.versions ?? row.versions, revisedBy: touched.has(id) ? { by: "curator", at: now } : row.revisedBy, changedAt: now, curatedAt: now });
      prior.set(id, { id, version: saved?.version ?? null, fields });
    }
    for (const row of created.values()) tx.put({ ...row, curatedAt: now, changedAt: now });
    const counts = { calls: 1, changed: touched.size + created.size, rewritten: input.rewrite?.length ?? 0, merged: input.merge?.reduce((n, m) => n + m.from.length, 0) ?? 0, moved: input.move?.length ?? 0, split: input.split?.length ?? 0, archived: input.archive?.length ?? 0, restored: input.restore?.length ?? 0 };
    for (const [scope, row] of scopes) {
      const revision = row.revision + 1;
      tx.put({ ...row, active: orders.get(scope)!, curatedAt: now, revision, history: [...row.history, { revision, revisionScope: row.revisionScope ?? scope, at: now, by: "curator", pass: pass.id, ...(scope === input.scopes[0].scope ? { counts } : {}), before: row.active, prior: [...prior.values()].filter(p => canonicalScope(p.fields.scope) === scope), created: [...created.values()].filter(r => r.scope === scope).map(r => r.id), added: [],
        rewritten: [...prior.values()].flatMap(p => p.version && canonicalScope(p.fields.scope) === scope ? [{ id: p.id, version: p.version }] : []),
        moved: (input.move ?? []).filter(m => get(m.id).scope === scope).map(m => ({ id: m.id, from: scope, to: m.to })),
        split: (input.split ?? []).filter(s => get(s.id).scope === scope).map(s => ({ id: s.id, parts: [s.id, ...s.parts.slice(1).map((_, index) => placeholders[`split:${s.id}:${index + 1}`])] })),
        merged: (input.merge ?? []).flatMap(m => m.from.map(from => ({ from, into: m.into }))), archived: (input.archive ?? []).map(a => a.id), restored: input.restore ?? [] }] });
    }
    return { placeholders, counts };
  });
  // History is authoritative if the separate counts update is interrupted.
  const latest = readPass(pass.id);
  if (latest) patchPass(pass.id, { counts: latest.counts });
  refreshLessonKnownValues();
  return result;
}

/** Reverse each call, skipping rules with a later writer. History is never removed. */
export function revertCuratorPass(id: string, now = new Date().toISOString()) {
  const pass = readPass(id);
  if (!pass || passIsLive(pass)) refuse("CURATE_LIVE", "only a completed curator pass can be undone");
  if (pass.revertedAt) return { skipped: pass.skipped ?? [] };
  joinMovedScopes(now);
  const held = roleMemoryCollection(true)!;
  let result: { skipped: string[] } = { skipped: [] };
  // A pass can contain many individually bounded calls. Prepare its whole undo
  // under the collection lease, then persist every changed row atomically.
  held.patchSync(() => {
    const snapshot = held.snapshot();
    const allHistories = snapshot.flatMap(row => row.kind === "scope" ? row.history.filter(h => h.pass === id).map(h => ({ scope: row.scope, history: h })) : []);
    const histories = allHistories.filter(h => !h.history.revertedAt).sort((a, b) => b.history.at.localeCompare(a.history.at));
    if (!histories.length) {
      result = { skipped: [...new Set(allHistories.flatMap(h => h.history.undoSkipped ?? []))] };
      return { records: [] };
    }
    const key = (row: RoleMemoryRow) => row.kind === "rule" ? `r:${row.id}` : row.kind === "scope" ? `s:${row.scope}` : `q:${row.pipelineId}:${row.stageId}:${row.attempt}`;
    const rows = new Map(snapshot.map(row => [key(row), row]));
    const changed = new Map<string, RoleMemoryRow>();
    const tx = {
      get: (key: string) => rows.get(key) ?? null,
      put: (row: RoleMemoryRow) => { rows.set(key(row), row); changed.set(key(row), row); },
    };
    const last = new Map<string, string>();
    for (const { history } of histories.slice().reverse()) for (const rule of [...(history.prior ?? []).map(p => p.id), ...(history.created ?? [])]) last.set(rule, history.at);
    const eligible = new Set([...last].filter(([rule, at]) => {
      const row = tx.get(`r:${rule}`);
      if (row?.kind !== "rule" || row.changedAt !== at) return false;
      const scope = tx.get(`s:${canonicalScope(row.scope)}`);
      if (scope?.kind !== "scope") return false;
      const passHistory = scope.history.find(change => change.pass === id && change.at === at);
      if (!passHistory) return false;
      const revision = passHistory.revision;
      // A later write can share the call's timestamp. Scope history proves its order,
      // including writes after a move and another curator's complete active partition.
      const revisionScope = passHistory.revisionScope ?? scope.scope;
      return !scope.history.some(change => {
        const sameRevisionLineage = (change.revisionScope ?? scope.scope) === revisionScope
          || change.revisionScope === scope.revisionScope;
        const later = sameRevisionLineage ? change.revision > revision : change.at > at;
        return later && (
        change.by === "curator" && row.state === "active" || change.prior?.some(prior => prior.id === rule) || change.created?.includes(rule)
        || change.by !== "succession" && change.added.includes(rule) || change.merged.some(merge => merge.from === rule || merge.into === rule) || change.archived.includes(rule)
        || change.restored?.includes(rule) || change.rewritten?.some(rewrite => rewrite.id === rule)
        || change.moved?.some(move => move.id === rule) || change.split?.some(split => split.id === rule || split.parts.includes(rule)));
      });
    }).map(([rule]) => rule));
    const orders = new Map<string, string[]>();
    for (const { scope, history } of histories) {
      for (const prior of history.prior ?? []) if (eligible.has(prior.id)) {
        const row = tx.get(`r:${prior.id}`), version = prior.version ? tx.get(`r:${prior.version}`) : row;
        if (row?.kind !== "rule" || version?.kind !== "rule") refuse("CURATE_INVALID", "pass version is unavailable");
        const updated = prior.version ? versionedRule(tx, row, version, { by: "operator", at: now, revertedTo: version.id }).updated : row;
        tx.put({ ...prior.fields, rule: version.rule, why: version.why, hints: version.hints, versions: updated.versions, revisedBy: { by: "operator", at: now, ...(prior.version ? { revertedTo: version.id } : {}) }, changedAt: now });
      }
      for (const rule of history.created ?? []) if (eligible.has(rule)) {
        const row = tx.get(`r:${rule}`); if (row?.kind === "rule") tx.put({ ...row, state: "archived", reason: "undone", changedAt: now });
      }
      const row = tx.get(`s:${scope}`); if (row?.kind !== "scope") continue;
      const before = (history.before ?? []).filter(rule => !last.has(rule) || eligible.has(rule));
      const active = [...new Set([...before, ...(orders.get(scope) ?? row.active)])];
      orders.set(scope, active);
      const revision = row.revision + 1;
      tx.put({ ...row, revision, active, history: row.history.map(h => h.pass === id && h.revision === history.revision ? { ...h, revertedAt: now, undoSkipped: [...last.keys()].filter(rule => !eligible.has(rule)) } : h) });
    }
    for (const [scope, order] of orders) {
      const row = tx.get(`s:${scope}`); if (row?.kind !== "scope") continue;
      const active = order.filter(id => { const r = tx.get(`r:${id}`); return r?.kind === "rule" && r.state === "active" && canonicalScope(r.scope) === scope; });
      tx.put({ ...row, active });
    }
    result = { skipped: [...last.keys()].filter(rule => !eligible.has(rule)) };
    return { records: [...changed.values()] };
  });
  patchPass(id, { revertedAt: now, skipped: result.skipped }); refreshLessonKnownValues(); return result;
}
