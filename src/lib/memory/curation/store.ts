import { effectiveCurationSetting, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { ROLE_IDS } from "@/lib/roles/types";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { canonicalScope, projectScope, roleMemoryCollection, roleScope } from "../roleStore";
import { crossProjectRoleScope, MACHINE_SCOPE } from "../roleScopes";
import { scopeChars } from "../roleConsolidate";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ROLE_MEMORY_BOUND, type RoleMemoryRule, type RoleMemoryScopeRow, CURATION_NEW_LESSONS, type CuratorPassView } from "../roleTypes";

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
}
type ProjectRow = { kind: "project"; project: string; current: string | null; lastClaimAt: string; claimRevisions?: Record<string, number>; lastAt: string | null; passes: string[] };
type Row = CuratorPass | ProjectRow | { kind: "machine"; current: string | null } | { kind: "conversation"; conversationId: string; pass: string };
const key = (row: Row) => row.kind === "pass" ? `r:${row.id}` : row.kind === "project" ? `p:${row.project}` : row.kind === "machine" ? "machine" : `c:${row.conversationId}`;
const seed = { collection: "role_memory_curation", schemaVersion: 1, migrationId: "role-memory-curation-v1", key, loadRecords: (): Row[] => [] };
const cache = new Map<string, SqliteStateCollection<Row>>();
function collection(create = false) {
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
function passMetadata(id: string): CuratorPass | null {
  const row = collection()?.get(`r:${id}`);
  return row?.kind === "pass" ? row : null;
}
export function readPass(id: string): CuratorPass | null {
  const row = passMetadata(id);
  if (!row) return null;
  const calls = new Map<string, CuratorPass["counts"]>();
  for (const scope of curationScopes(row.project)) {
    for (const h of scope.history) if (h.pass === id && h.counts) calls.set(h.at, h.counts);
  }
  if (!calls.size) return row;
  const counts = { ...row.counts };
  for (const field of Object.keys(counts) as (keyof typeof counts)[]) counts[field] = [...calls.values()].reduce((n, call) => n + call[field], 0);
  return { ...row, counts };
}
function projectRows(project: string): ProjectRow[] {
  const canonical = canonicalProject(project);
  return [...new Set([canonical, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === canonical)])].flatMap(project => { const row = collection()?.get(`p:${project}`); return row?.kind === "project" ? [row] : []; });
}
function combineProjectRows(project: string, rows: readonly ProjectRow[]): ProjectRow | null {
  if (!rows.length) return null;
  const metadata = new Map(rows.flatMap(row => row.passes).map(id => [id, passMetadata(id)]));
  const passes = [...new Set(rows.flatMap(row => row.passes))].sort((a, b) => {
    const left = metadata.get(a)?.claimedAt ?? "", right = metadata.get(b)?.claimedAt ?? "";
    return left.localeCompare(right) || a.localeCompare(b);
  });
  const claimRevisions: Record<string, number> = {};
  for (const row of rows) for (const [scope, revision] of Object.entries(row.claimRevisions ?? {})) {
    claimRevisions[scope] = Math.max(claimRevisions[scope] ?? 0, revision);
  }
  const current = rows.map(row => row.current).find(id => id && passIsLive(metadata.get(id) ?? passMetadata(id))) ?? null;
  return {
    kind: "project", project: canonicalProject(project), current,
    lastClaimAt: rows.map(row => row.lastClaimAt).sort().at(-1)!,
    claimRevisions,
    lastAt: rows.map(row => row.lastAt).filter((at): at is string => !!at).sort().at(-1) ?? null,
    passes,
  };
}
function projectRow(project: string): ProjectRow | null { return combineProjectRows(project, projectRows(project)); }
export function currentPass(project: string) {
  // Reconciliation needs only the live selection; retained passes need no sort.
  const id = projectRows(project).map(row => row.current).find(id => id && passIsLive(passMetadata(id)));
  return id ? readPass(id) : null;
}
export function machinePass() { const row = collection()?.get("machine"); return row?.kind === "machine" && row.current ? readPass(row.current) : null; }
export function passForConversation(id: string): CuratorPass | null { const row = collection()?.get(`c:${id}`); return row?.kind === "conversation" ? readPass(row.pass) : null; }
/** Scope-key reads exclude requests, versions and the cold rule archive. */
function curationScopes(project: string): RoleMemoryScopeRow[] {
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
export function passScopes(project: string): string[] {
  const p = canonicalProject(project);
  const existing = curationScopes(p).map(row => canonicalScope(row.scope));
  return [...new Set([...ROLE_IDS.map(role => roleScope(p, role)), ...existing, ...ROLE_IDS.map(crossProjectRoleScope), projectScope(p), MACHINE_SCOPE])];
}
function databaseIdentity() {
  try { const stat = fs.statSync(statePath("state.sqlite"), { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
function collectionRevision() { const held = collection(); return held ? `${held.signature()}:${held.revision()}` : "missing"; }
type CurationSummary = { active: boolean; pressure: boolean; newLessons: number; lastAt: string | null; lastClaimAt: string | null };
// Compiled Viewer bundles share one LRU owner; only 32 tiny summaries survive.
const shared = globalThis as typeof globalThis & { __llvCurationSummaries?: Map<string, { stamp: string; summary: CurationSummary }> };
const summaries = shared.__llvCurationSummaries ??= new Map();
export function curationStatus(project: string, now = Date.now(), setting = effectiveCurationSetting(readSeatTickSettings(canonicalProject(project)))) {
  return withViewerOperation("memory.curation-status", () => {
    const collection = roleMemoryCollection();
    const key = `${statePath("state.sqlite")}:${canonicalProject(project)}`;
    const stamp = `${databaseIdentity()}:${collection?.revision()}:${collectionRevision()}:${JSON.stringify(projectAliasSnapshot().aliases)}`;
    const cached = summaries.get(key);
    if (cached) { summaries.delete(key); summaries.set(key, cached); }
    let summary = cached?.stamp === stamp ? cached.summary : null;
    if (!summary) {
      const held = projectRow(project);
      let active = false, pressure = false, newLessons = 0;
      const activeByCanonicalScope = new Map<string, Map<string, RoleMemoryRule>>();
      for (const row of curationScopes(project)) {
        const rules = row.active.flatMap(id => { const rule = collection?.get(`r:${id}`); return rule?.kind === "rule" && rule.state === "active" && !rule.versionOf ? [rule] : []; });
        active ||= rules.length > 0;
        const canonical = canonicalScope(row.scope);
        const grouped = activeByCanonicalScope.get(canonical) ?? new Map();
        for (const rule of rules) grouped.set(rule.id, rule);
        activeByCanonicalScope.set(canonical, grouped);
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
      for (const rules of activeByCanonicalScope.values()) {
        const scopeRules = [...rules.values()];
        // A full, already-curated scope does not cause an endless sequence of passes.
        pressure ||= scopeRules.some(rule => !rule.curatedAt) && scopeChars(scopeRules) >= ROLE_MEMORY_BOUND * 0.9;
      }
      summary = { active, pressure, newLessons, lastAt: held?.lastAt ?? null, lastClaimAt: held?.lastClaimAt ?? null };
      summaries.delete(key); summaries.set(key, { stamp, summary });
      while (summaries.size > 32) summaries.delete(summaries.keys().next().value!);
    }
    const { active, pressure, newLessons, lastAt, lastClaimAt } = summary;
    // Every trigger spends the same durable interval, including failed/no-op
    // passes that leave unseen rules above the pressure threshold.
    const anchor = [lastAt, lastClaimAt].filter((at): at is string => !!at).sort().at(-1);
    const eligibleAt = anchor ? Date.parse(anchor) + setting.intervalMs : now;
    const due = setting.enabled && active && now >= eligibleAt;
    const trigger = !anchor ? "initial" : pressure ? "pressure" : newLessons >= CURATION_NEW_LESSONS ? "new-lessons" : "interval";
    return { active, due, pressure, trigger, newLessons, lastAt, lastClaimAt, nextAt: setting.enabled && active ? new Date(Math.max(now, eligibleAt)).toISOString() : null };

  });
}
export function claimPass(input: { project: string; repoDir: string | null; now: number; setting?: ReturnType<typeof effectiveCurationSetting> }): CuratorPass | null {
  const project = canonicalProject(input.project);
  const prior = projectRow(project);
  const setting = input.setting ?? effectiveCurationSetting(readSeatTickSettings(project));
  const status = curationStatus(project, input.now, setting);
  if (!status.due) return null;
  const scopes = passScopes(project);
  const claimRevisions: Record<string, number> = Object.fromEntries(scopes.map(scope => [scope, 0]));
  for (const row of curationScopes(project)) {
    const scope = row.revisionScope ?? canonicalScope(row.scope);
    claimRevisions[scope] = Math.max(claimRevisions[scope] ?? 0, row.revision);
  }
  return collection(true)!.boundedPatch(12, tx => {
    const machine = tx.get("machine");
    if (machine?.kind === "machine" && machine.current) { const pass = tx.get(`r:${machine.current}`); if (pass?.kind === "pass" && passIsLive(pass)) return null; }
    const stored = tx.get(`p:${project}`);
    const held = combineProjectRows(project, [...(prior ? [prior] : []), ...(stored?.kind === "project" ? [stored] : [])]);
    if (held && input.now < Math.max(Date.parse(held.lastClaimAt), held.lastAt ? Date.parse(held.lastAt) : 0) + setting.intervalMs) return null;
    const claimedAt = new Date(input.now).toISOString();
    const id = `curate_${createHash("sha256").update(`${project}:${claimedAt}`).digest("hex").slice(0, 24)}`;
    if (tx.get(`r:${id}`)) return null;
    const pass: CuratorPass = { kind: "pass", id, project, repoDir: input.repoDir, scopes, clientAttemptId: id, claimedAt, state: "claimed", endedAt: null, failure: null, conversationId: null, launchId: null, transcriptPath: null, launchedAt: null,
      counts: { calls: 0, changed: 0, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 } };
    tx.put(pass); tx.put({ kind: "machine", current: id });
    tx.put({ kind: "project", project, current: id, lastClaimAt: claimedAt, claimRevisions, lastAt: held?.kind === "project" ? held.lastAt : null, passes: [...(held?.kind === "project" ? held.passes : []), id] });
    return pass;
  });
}
export function patchPass(id: string, patch: Partial<CuratorPass>): CuratorPass | null {
  const original = readPass(id);
  const projectRowsBefore = original ? projectRows(original.project) : [];
  return collection(true)!.boundedPatch(12, tx => {
    const held = tx.get(`r:${id}`); if (held?.kind !== "pass") return null;
    if (!passIsLive(held) && patch.state && ["claimed", "launching", "running"].includes(patch.state)) return held;
    const next = { ...held, ...patch, id, kind: "pass" as const, project: held.project, scopes: held.scopes, launchBody: held.launchBody ?? patch.launchBody };
    tx.put(next);
    if (next.conversationId) tx.put({ kind: "conversation", conversationId: next.conversationId, pass: id });
    if (!passIsLive(next)) {
      const machine = tx.get("machine"); if (machine?.kind === "machine" && machine.current === id) tx.put({ ...machine, current: null });
      const projectKey = canonicalProject(held.project), stored = tx.get(`p:${projectKey}`);
      const project = combineProjectRows(projectKey, [...projectRowsBefore, ...(stored?.kind === "project" ? [stored] : [])]);
      if (project) tx.put({ ...project, current: project.current === id ? null : project.current,
        lastAt: [project.lastAt, next.endedAt ?? held.claimedAt].filter((at): at is string => !!at).sort().at(-1) ?? null });
    }
    return next;
  });
}
export function curationView(project: string, now = Date.now()) {
  const { lastAt, nextAt, newLessons } = curationStatus(project, now);
  const passes = (projectRow(project)?.passes ?? []).slice().reverse().flatMap(id => {
    const pass = readPass(id); if (!pass) return [];
    const { state, claimedAt, endedAt, failure, counts, revertedAt, skipped } = pass;
    return [{ id, state, claimedAt, endedAt, failure, counts, ...(revertedAt ? { revertedAt } : {}), ...(skipped ? { skipped } : {}) }];
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
      const pass = passMetadata(row.passes[index]!);
      if (!pass) continue;
      if (passIsLive(pass)) continue;
      if (!latestCompleted || pass.claimedAt > latestCompleted.claimedAt) latestCompleted = pass;
      break;
    }
  }
  const current = rows.map(row => row.current ? passMetadata(row.current) : null).find(passIsLive) ?? null;
  return { live: current ? readPass(current.id) : null, last: latestCompleted ? readPass(latestCompleted.id) : null };
}
