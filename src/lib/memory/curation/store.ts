import { effectiveCurationSetting, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { ROLE_IDS } from "@/lib/roles/types";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { canonicalScope, projectScope, roleMemoryCollection, roleScope } from "../roleStore";
import { crossProjectRoleScope, isCrossProjectRoleScope, MACHINE_SCOPE, scopeProject } from "../roleScopes";
import { scopeChars } from "../roleConsolidate";
import { budgetArchiveCandidates } from "../roleViewSource";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ROLE_MEMORY_BOUND, type RoleMemoryRule, type RoleMemoryScopeRow, CURATION_NEW_LESSONS, type CuratorPassView } from "../roleTypes";

import { selectImportBatch, importBatchScopes, type ImportBatch } from "../importCuration";

export interface CuratorPass extends CuratorPassView {
  kind: "pass";
  project: string;
  repoDir: string | null;
  scopes: string[];
  clientAttemptId: string;
  conversationId: string | null;
  launchId: string | null;
  transcriptPath: string | null;
  launchedAt: string | null;
  launchBody?: Record<string, unknown>;
  finalText?: string;
  importBatch?: ImportBatch;
  budgetSweepCandidates?: Record<string, string[]>;
  budgetSweep?: { scope: string; candidates: number; restored: number; integrated: number; remaining: number }[];
}
type ProjectRow = { kind: "project"; project: string; current: string | null; lastClaimAt: string; claimRevisions?: Record<string, number>; lastAt: string | null; passes: string[] };
type Row = CuratorPass | ProjectRow | { kind: "machine"; current: string | null; budgetSweepAttemptedAt?: string; budgetSweepEndedAt?: string; budgetSweepCompletedAt?: string } | { kind: "conversation"; conversationId: string; pass: string };
const key = (row: Row) => row.kind === "pass" ? `r:${row.id}` : row.kind === "project" ? `p:${row.project}` : row.kind === "machine" ? "machine" : `c:${row.conversationId}`;
const seed = { collection: "role_memory_curation", schemaVersion: 1, migrationId: "role-memory-curation-v1", key, loadRecords: (): Row[] => [] };
const cache = new Map<string, SqliteStateCollection<Row>>();
export function curationCollection(create = false) {
  const file = statePath("state.sqlite");
  if (cache.has(file)) return cache.get(file)!;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const held = new SqliteStateCollection<Row>(file, { ...seed, busyMessage: "curation busy", clone: structuredClone, strictDecode: true,
    decode: value => {
      const row = value as Row | null;
      return row && (row.kind === "pass" && typeof row.id === "string" && Array.isArray(row.scopes)
        || row.kind === "project" && Array.isArray(row.passes) || row.kind === "machine" || row.kind === "conversation" && typeof row.pass === "string") ? row : null;
    } });
  cache.set(file, held); return held;
}
export const passIsLive = (pass: CuratorPass | null) => !!pass && ["claimed", "launching", "running"].includes(pass.state);
export function passMetadata(id: string): CuratorPass | null {
  const row = curationCollection()?.get(`r:${id}`);
  return row?.kind === "pass" ? row : null;
}
/** Fresh authority only; display counts are reconstructed separately by readPass. */
export function readPassAuthority(id: string): CuratorPass | null {
  return withViewerOperation("memory.curation-authority", () => {
    const row = curationCollection()?.get(`r:${id}`);
    return row?.kind === "pass" ? row : null;
  });
}
type CountMemo = { stamp: string; counts: CuratorPass["counts"]; bytes: number };
const countOwner = process as typeof process & { __llvCurationCounts?: Map<string, CountMemo> };
const countMemos = countOwner.__llvCurationCounts ??= new Map<string, CountMemo>();
export function readPass(id: string): CuratorPass | null {
  const row = readPassAuthority(id);
  if (!row) return null;
  const memoKey = JSON.stringify([statePath("state.sqlite"), row.project, id]);
  const stamp = () => `${databaseIdentity()}:${roleMemoryCollection()?.revision()}:${curationRevision()}:${JSON.stringify(projectAliasSnapshot().aliases)}`;
  const version = stamp(), cached = countMemos.get(memoKey);
  if (cached?.stamp === version) {
    countMemos.delete(memoKey); countMemos.set(memoKey, cached);
    return { ...row, counts: { ...cached.counts }, ...sweepCounts(row) };
  }
  const calls = new Map<string, CuratorPass["counts"]>();
  const scopes = new Map(curationScopes(row.project).map(scope => [scope.scope, scope]));
  // Seatless folders join the installation host's pass, but their own scope
  // histories still contribute that pass's receipts and counts.
  for (const scope of row.scopes) {
    const held = roleMemoryCollection()?.get(`s:${canonicalScope(scope)}`);
    if (held?.kind === "scope") scopes.set(held.scope, held);
  }
  for (const scope of scopes.values()) {
    for (const h of scope.history) if (h.pass === id && h.counts) calls.set(h.at, h.counts);
  }
  const counts = { ...row.counts };
  if (calls.size) for (const field of Object.keys(counts) as (keyof typeof counts)[]) counts[field] = [...calls.values()].reduce((n, call) => n + call[field], 0);
  // Derived counts contain no histories. One owner, 32 entries / 512 KiB,
  // invalidated by metadata, scope revisions, aliases or database replacement.
  const bytes = Buffer.byteLength(memoKey + version + JSON.stringify(counts));
  if (stamp() === version && bytes <= 16 * 1024) {
    countMemos.delete(memoKey); countMemos.set(memoKey, { stamp: version, counts: { ...counts }, bytes });
    let total = [...countMemos.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (countMemos.size > 32 || total > 512 * 1024) {
      const oldest = countMemos.keys().next().value!;
      total -= countMemos.get(oldest)!.bytes; countMemos.delete(oldest);
    }
  }
  return { ...row, counts, ...sweepCounts(row) };
}
function sweepCounts(pass: CuratorPass): Pick<CuratorPass, "budgetSweep"> {
  if (!passIsLive(pass) && pass.budgetSweep) return { budgetSweep: pass.budgetSweep };
  if (!pass.budgetSweepCandidates) return {};
  return { budgetSweep: Object.entries(pass.budgetSweepCandidates).map(([scope, ids]) => {
    const rules = ids.map(id => roleMemoryCollection()?.get(`r:${id}`));
    return { scope, candidates: ids.length,
      restored: rules.filter(row => row?.kind === "rule" && row.state === "active").length,
      integrated: rules.filter(row => row?.kind === "rule" && row.state === "merged").length,
      remaining: rules.filter(row => row?.kind === "rule" && row.state === "archived").length };
  }) };
}
function projectRows(project: string): ProjectRow[] {
  const canonical = canonicalProject(project);
  return [...new Set([canonical, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === canonical)])].flatMap(project => { const row = curationCollection()?.get(`p:${project}`); return row?.kind === "project" ? [row] : []; });
}
function combineProjectRows(project: string, rows: readonly ProjectRow[]): ProjectRow | null {
  if (!rows.length) return null;
  const metadata = new Map(rows.flatMap(row => row.passes).map(id => [id, readPassAuthority(id)]));
  const passes = [...new Set(rows.flatMap(row => row.passes))].sort((a, b) => {
    const left = metadata.get(a)?.claimedAt ?? "", right = metadata.get(b)?.claimedAt ?? "";
    return left.localeCompare(right) || a.localeCompare(b);
  });
  const claimRevisions: Record<string, number> = {};
  for (const row of rows) for (const [scope, revision] of Object.entries(row.claimRevisions ?? {})) {
    claimRevisions[scope] = Math.max(claimRevisions[scope] ?? 0, revision);
  }
  const current = rows.map(row => row.current).find(id => id && passIsLive(metadata.get(id) ?? readPassAuthority(id))) ?? null;
  return {
    kind: "project", project: canonicalProject(project), current,
    lastClaimAt: rows.map(row => row.lastClaimAt).sort().at(-1)!,
    claimRevisions,
    lastAt: rows.map(row => row.lastAt).filter((at): at is string => !!at).sort().at(-1) ?? null,
    passes,
  };
}
function projectRow(project: string): ProjectRow | null { return combineProjectRows(project, projectRows(project)); }
export function currentPassAuthority(project: string) {
  // Reconciliation needs only the live selection; retained passes need no sort.
  const id = projectRows(project).map(row => row.current).find(id => id && passIsLive(readPassAuthority(id)));
  return id ? readPassAuthority(id) : null;
}
export function machinePassAuthority() { const row = curationCollection()?.get("machine"); return row?.kind === "machine" && row.current ? readPassAuthority(row.current) : null; }
export function passForConversationAuthority(id: string): CuratorPass | null { const row = curationCollection()?.get(`c:${id}`); return row?.kind === "conversation" ? readPassAuthority(row.pass) : null; }
export function currentPass(project: string) { const pass = currentPassAuthority(project); return pass ? readPass(pass.id) : null; }
export function machinePass() { const pass = machinePassAuthority(); return pass ? readPass(pass.id) : null; }
export function passForConversation(id: string) { const pass = passForConversationAuthority(id); return pass ? readPass(pass.id) : null; }
/** Scope-key reads exclude requests, versions and the cold rule archive. */
export function curationScopes(project: string): RoleMemoryScopeRow[] {
  const p = canonicalProject(project), held = roleMemoryCollection();
  if (!held) return [];
  const projects = [...new Set([p, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === p)])];
  const scopes = new Map<string, RoleMemoryScopeRow>();
  const take = (row: ReturnType<typeof held.get>) => { if (row?.kind === "scope") scopes.set(row.scope, row); };
  for (const key of [...projects.map(projectScopeRaw => `s:project:${projectScopeRaw}`), "s:machine"]) take(held.get(key));
  for (const prefix of [...projects.map(project => `s:role:${project}:`), "s:role:*:"]) {
    let after = prefix;
    for (;;) {
      const page = held.keyRange(after, `${prefix}\uffff`, 64);
      for (const row of page) take(row);
      if (page.length < 64) break;
      after = `s:${(page.at(-1)! as RoleMemoryScopeRow).scope}`;
    }
  }
  return [...scopes.values()];
}
/** Keep project-view curation aligned with the scope membership and order used
 * by curationScopes, while reusing already projected rows and their histories. */
function selectCurationScopeRows(project: string, rows: readonly RoleMemoryScopeRow[]) {
  const p = canonicalProject(project);
  const projects = [...new Set([p, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === p)])];
  const projectRank = new Map(projects.map((key, index) => [key, index]));
  const rank = (scope: string): [number, string] | null => {
    if (scope.startsWith("project:")) {
      const raw = scope.slice("project:".length);
      const index = projectRank.get(raw);
      return index === undefined ? null : [index, ""];
    }
    if (scope === MACHINE_SCOPE) return [projects.length, ""];
    if (isCrossProjectRoleScope(scope)) return [projects.length * 2 + 1, scope];
    const owner = scopeProject(scope);
    const index = owner === null ? undefined : projectRank.get(owner);
    return index === undefined ? null : [projects.length + 1 + index, scope];
  };
  return rows.flatMap(row => {
    const order = rank(row.scope);
    return order ? [{ row, order }] : [];
  }).sort((a, b) => a.order[0] - b.order[0] || (a.order[1] < b.order[1] ? -1 : a.order[1] > b.order[1] ? 1 : 0)).map(item => item.row);
}
export function passScopes(project: string): string[] {
  const p = canonicalProject(project);
  const existing = curationScopes(p).map(row => canonicalScope(row.scope));
  return [...new Set([...ROLE_IDS.map(role => roleScope(p, role)), ...existing, ...ROLE_IDS.map(crossProjectRoleScope), projectScope(p), MACHINE_SCOPE])];
}
function databaseIdentity() {
  try { const stat = fs.statSync(statePath("state.sqlite"), { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export function curationRevision() { const held = curationCollection(); return held ? `${held.signature()}:${held.revision()}` : "missing"; }
type CurationSummary = { active: boolean; pressure: boolean; urgent: boolean; sweepPending: boolean; newLessons: number; lastAt: string | null; lastClaimAt: string | null };
// Compiled Viewer bundles share one LRU owner; only 32 tiny summaries survive.
const shared = globalThis as typeof globalThis & { __llvCurationSummaries?: Map<string, { stamp: string; summary: CurationSummary }> };
const summaries = shared.__llvCurationSummaries ??= new Map();
export function curationStatus(project: string, now = Date.now(), setting = effectiveCurationSetting(readSeatTickSettings(canonicalProject(project))), scopeRows?: readonly RoleMemoryScopeRow[], cacheSummary = true) {
  return withViewerOperation("memory.curation-status", () => {
    const collection = roleMemoryCollection();
    const key = `${statePath("state.sqlite")}:${canonicalProject(project)}`;
    const stamp = `${databaseIdentity()}:${collection?.revision()}:${curationRevision()}:${JSON.stringify(projectAliasSnapshot().aliases)}`;
    const cached = summaries.get(key);
    if (cached) { summaries.delete(key); summaries.set(key, cached); }
    let summary = cached?.stamp === stamp ? cached.summary : null;
    if (!summary) {
      const held = projectRow(project);
      let active = false, pressure = false, urgent = false, newLessons = 0;
      const changedScopes = new Set<string>();
      const activeByCanonicalScope = new Map<string, Map<string, RoleMemoryRule>>();
      for (const row of scopeRows ?? curationScopes(project)) {
        const rules = row.active.flatMap(id => { const rule = collection?.get(`r:${id}`); return rule?.kind === "rule" && rule.state === "active" && !rule.versionOf ? [rule] : []; });
        active ||= rules.length > 0;
        const canonical = canonicalScope(row.scope);
        const grouped = activeByCanonicalScope.get(canonical) ?? new Map();
        for (const rule of rules) grouped.set(rule.id, rule);
        activeByCanonicalScope.set(canonical, grouped);
        if (row.revision > (held?.claimRevisions?.[row.revisionScope ?? row.scope] ?? 0)) changedScopes.add(canonical);
        const since = [row.curatedAt, held?.lastClaimAt].filter((at): at is string => !!at).sort().at(-1) ?? "";
        const curatedRevisions = new Map<string, number>();
        for (const change of row.history) if (change.by === "curator") {
          const scope = change.revisionScope ?? row.scope;
          curatedRevisions.set(scope, Math.max(curatedRevisions.get(scope) ?? 0, change.revision));
        }
        for (const change of row.history) if (change.by === "agent") {
          const revisionScope = change.revisionScope ?? row.scope;
          const revision = held?.claimRevisions ? Math.max(held.claimRevisions[revisionScope] ?? 0, curatedRevisions.get(revisionScope) ?? 0) : null;
          if (revision === null ? change.at > since : change.revision > revision) newLessons += change.added.length + (change.rewritten?.length ?? 0) + change.merged.length;
        }
      }
      // Aliased physical rows represent one scope in the launch snapshot. Apply
      // pressure to their deduplicated canonical rule set as a whole.
      for (const [scope, rules] of activeByCanonicalScope) {
        const scopeRules = [...rules.values()];
        urgent ||= changedScopes.has(scope) && scopeChars(scopeRules) > ROLE_MEMORY_BOUND;
        // A full, already-curated scope does not cause an endless sequence of passes.
        pressure ||= scopeChars(scopeRules) > ROLE_MEMORY_BOUND || scopeRules.some(rule => !rule.curatedAt) && scopeChars(scopeRules) >= ROLE_MEMORY_BOUND * 0.9;
      }
      const machine = curationCollection()?.get("machine");
      const sweepPending = !(machine?.kind === "machine" && machine.budgetSweepCompletedAt) && budgetArchiveCandidates(1).length > 0;
      summary = { active, pressure, urgent, sweepPending, newLessons, lastAt: held?.lastAt ?? null, lastClaimAt: held?.lastClaimAt ?? null };
      if (cacheSummary) {
        summaries.delete(key); summaries.set(key, { stamp, summary });
        while (summaries.size > 32) summaries.delete(summaries.keys().next().value!);
      }
    }
    const { pressure, newLessons, lastAt, lastClaimAt } = summary;
    const machine = curationCollection()?.get("machine");
    const sweepAnchor = machine?.kind === "machine" ? [machine.budgetSweepAttemptedAt, machine.budgetSweepEndedAt].filter((at): at is string => !!at).sort().at(-1) : undefined;
    const sweepDue = summary.sweepPending && !(sweepAnchor && now < Date.parse(sweepAnchor) + setting.intervalMs);
    const urgent = summary.urgent || sweepDue;
    const batch = selectImportBatch(project);
    const active = summary.active || !!batch || summary.sweepPending;
    const lastPassId = projectRows(project).flatMap(row => row.passes).at(-1);
    const lastPass = lastPassId ? passMetadata(lastPassId) : null;
    const importing = !!batch && (!lastPass || lastPass.state === "succeeded");
    // Failed/no-op passes spend the durable interval. A new over-bound
    // revision requests immediate integration, without reopening the same claim.
    const anchor = [lastAt, lastClaimAt].filter((at): at is string => !!at).sort().at(-1);
    const eligibleAt = anchor ? Date.parse(anchor) + setting.intervalMs : now;
    const due = setting.enabled && active && (urgent || importing || now >= eligibleAt);
    const trigger = urgent ? "pressure" : !anchor ? "initial" : pressure ? "pressure" : newLessons >= CURATION_NEW_LESSONS ? "new-lessons" : "interval";
    return { active, due, pressure, urgent, trigger, newLessons, lastAt, lastClaimAt, nextAt: setting.enabled && active ? new Date(urgent ? now : Math.max(now, eligibleAt)).toISOString() : null };

  });
}
export function claimPass(input: { project: string; repoDir: string | null; now: number; setting?: ReturnType<typeof effectiveCurationSetting>; importOnly?: boolean }): CuratorPass | null {
  const project = canonicalProject(input.project);
  const prior = projectRow(project);
  const setting = input.setting ?? effectiveCurationSetting(readSeatTickSettings(project));
  const status = curationStatus(project, input.now, setting);
  if (!status.due) return null;
  const importBatch = selectImportBatch(project);
  // The engines position never claims an ordinary pass (§4.9).
  if (input.importOnly && !importBatch) return null;
  const machine = curationCollection()?.get("machine");
  const sweepRevision = roleMemoryCollection()?.revision();
  const sweepCandidates: Record<string, string[]> | undefined = !input.importOnly && !(machine?.kind === "machine" && machine.budgetSweepCompletedAt) ? {} : undefined;
  if (sweepCandidates) for (const { id, scope } of budgetArchiveCandidates()) (sweepCandidates[scope] ??= []).push(id);
  const scopes = [...new Set([...passScopes(project), ...Object.keys(sweepCandidates ?? {}), ...(importBatch ? importBatchScopes(importBatch) : [])])];
  const claimRevisions: Record<string, number> = Object.fromEntries(scopes.map(scope => [scope, 0]));
  for (const row of curationScopes(project)) {
    const scope = row.revisionScope ?? canonicalScope(row.scope);
    claimRevisions[scope] = Math.max(claimRevisions[scope] ?? 0, row.revision);
  }
  return curationCollection(true)!.boundedPatch(12, tx => {
    const machine = tx.get("machine");
    if (machine?.kind === "machine" && machine.current) { const pass = tx.get(`r:${machine.current}`); if (pass?.kind === "pass" && passIsLive(pass)) return null; }
    if (sweepCandidates && (machine?.kind === "machine" && machine.budgetSweepCompletedAt
      || roleMemoryCollection()?.revision() !== sweepRevision)) return null;
    const stored = tx.get(`p:${project}`);
    const held = combineProjectRows(project, [...(prior ? [prior] : []), ...(stored?.kind === "project" ? [stored] : [])]);
    const last = held?.passes.at(-1);
    const completed = last ? passMetadata(last) : null;
    if (held && !status.urgent && !(importBatch && completed?.state === "succeeded") && input.now < Math.max(Date.parse(held.lastClaimAt), held.lastAt ? Date.parse(held.lastAt) : 0) + setting.intervalMs) return null;
    const claimedAt = new Date(input.now).toISOString();
    const id = `curate_${createHash("sha256").update(`${project}:${claimedAt}`).digest("hex").slice(0, 24)}`;
    if (tx.get(`r:${id}`)) return null;
    const pass: CuratorPass = { kind: "pass", id, project, repoDir: input.repoDir, scopes, clientAttemptId: id, claimedAt, state: "claimed", endedAt: null, failure: null, conversationId: null, launchId: null, transcriptPath: null, launchedAt: null,
      ...(importBatch ? { importBatch } : {}),
      ...(sweepCandidates ? { budgetSweepCandidates: sweepCandidates } : {}),
      counts: { calls: 0, changed: 0, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 } };
    tx.put(pass); tx.put({ ...(machine?.kind === "machine" ? machine : {}), kind: "machine", current: id,
      ...(sweepCandidates ? { budgetSweepAttemptedAt: claimedAt } : {}) });
    tx.put({ kind: "project", project, current: id, lastClaimAt: claimedAt, claimRevisions, lastAt: held?.kind === "project" ? held.lastAt : null, passes: [...(held?.kind === "project" ? held.passes : []), id] });
    return pass;
  });
}
export function patchPass(id: string, patch: Partial<CuratorPass>): CuratorPass | null {
  const original = readPassAuthority(id);
  const projectRowsBefore = original ? projectRows(original.project) : [];
  return curationCollection(true)!.boundedPatch(12, tx => {
    const held = tx.get(`r:${id}`); if (held?.kind !== "pass") return null;
    if (!passIsLive(held) && patch.state && ["claimed", "launching", "running"].includes(patch.state)) return held;
    const next = { ...held, ...patch, id, kind: "pass" as const, project: held.project, scopes: held.scopes, launchBody: held.launchBody ?? patch.launchBody };
    if (next.state === "succeeded" && held.budgetSweepCandidates) {
      const missing = Object.entries(held.budgetSweepCandidates).filter(([scope, ids]) => {
        const row = roleMemoryCollection()?.get(`s:${canonicalScope(scope)}`);
        return ids.some(candidate => {
          const rule = roleMemoryCollection()?.get(`r:${candidate}`);
          return rule?.kind !== "rule" || rule.state === "archived" && rule.reason !== "deleted" && !(row?.kind === "scope"
            && row.history.some(change => change.pass === id && !change.revertedAt && change.restored?.includes(candidate)));
        });
      });
      if (missing.length) { next.state = "failed"; next.failure = `budget-sweep-incomplete: ${missing.length} scopes`; }
    }
    if (!passIsLive(next)) Object.assign(next, sweepCounts(next));
    tx.put(next);
    if (next.conversationId) tx.put({ kind: "conversation", conversationId: next.conversationId, pass: id });
    if (!passIsLive(next)) {
      const machine = tx.get("machine"); if (machine?.kind === "machine" && machine.current === id) tx.put({ ...machine, current: null,
        ...(held.budgetSweepCandidates ? { budgetSweepEndedAt: next.endedAt ?? held.claimedAt } : {}),
        ...(next.state === "succeeded" && held.budgetSweepCandidates ? { budgetSweepCompletedAt: next.endedAt ?? held.claimedAt } : {}) });
      const projectKey = canonicalProject(held.project), stored = tx.get(`p:${projectKey}`);
      const project = combineProjectRows(projectKey, [...projectRowsBefore, ...(stored?.kind === "project" ? [stored] : [])]);
      if (project) tx.put({ ...project, current: project.current === id ? null : project.current,
        lastAt: [project.lastAt, next.endedAt ?? held.claimedAt].filter((at): at is string => !!at).sort().at(-1) ?? null });
    }
    return next;
  });
}
export function curationView(project: string, now = Date.now(), scopeRows = curationScopes(project), cacheSummary = true) {
  scopeRows = selectCurationScopeRows(project, scopeRows);
  const { lastAt, nextAt, newLessons } = curationStatus(project, now, undefined, scopeRows, cacheSummary);
  // A call touching several scopes leaves the same receipt in each history.
  // Preserve readPass's last-scope-wins deduplication by (pass, timestamp).
  const calls = new Map<string, Map<string, CuratorPass["counts"]>>();
  for (const scope of scopeRows) for (const h of scope.history) if (h.pass && h.counts) {
    let pass = calls.get(h.pass);
    if (!pass) calls.set(h.pass, pass = new Map());
    pass.set(h.at, h.counts);
  }
  const passes = (projectRow(project)?.passes ?? []).slice().reverse().flatMap(id => {
    const pass = readPassAuthority(id); if (!pass) return [];
    const { state, claimedAt, endedAt, failure, counts, revertedAt, skipped } = pass;
    const receipts = calls.get(id);
    const summed = { ...counts };
    if (receipts?.size) for (const field of Object.keys(summed) as (keyof typeof counts)[]) {
      summed[field] = [...receipts.values()].reduce((n, call) => n + call[field], 0);
    }
    return [{ id, state, claimedAt, endedAt, failure, counts: summed, ...sweepCounts(pass), ...(revertedAt ? { revertedAt } : {}), ...(skipped ? { skipped } : {}) }];
  });
  return { lastAt, nextAt, newLessons, passes };
}

/** Panel polling reads two pass records, independent of retained history size. */
export function curationPanelRuns(project: string) {
  const rows = projectRows(project);
  let latestCompleted: CuratorPass | null = null;
  for (const row of rows) {
    // Pass ids are appended in claim order. The newest entry can be the live
    // pass, so walk back only to this row's newest completed pass; never
    // materialize the retained history for a panel read.
    for (let index = row.passes.length - 1; index >= 0; index--) {
      const pass = readPassAuthority(row.passes[index]!);
      if (!pass) continue;
      if (passIsLive(pass)) continue;
      if (!latestCompleted || pass.claimedAt > latestCompleted.claimedAt) latestCompleted = pass;
      break;
    }
  }
  const current = rows.map(row => row.current ? readPassAuthority(row.current) : null).find(passIsLive) ?? null;
  return { live: current ? readPass(current.id) : null, last: latestCompleted ? readPass(latestCompleted.id) : null };
}
