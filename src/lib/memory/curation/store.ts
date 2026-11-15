import { yieldToRuntime } from "@/lib/cooperative";
import { MeasuredCache } from "@/lib/cacheTelemetry";
import { effectiveCurationSetting, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { ROLE_IDS } from "@/lib/roles/types";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { canonicalScope, projectScope, roleMemoryCollection, roleScope } from "../roleStore";
import { crossProjectRoleScope, isCrossProjectRoleScope, MACHINE_SCOPE, scopeProject } from "../roleScopes";
import { budgetArchiveCandidates, curationReadVersion, curationScopeInputs, curationScopeInputSteps, curationRuleInputs, roleRowWithHistory, roleScopeRowKeys, curationRowRevisionSteps } from "../roleViewSource";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ROLE_MEMORY_BOUND, type RoleMemoryScopeRow, CURATION_NEW_LESSONS, type CuratorPassView } from "../roleTypes";

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
  /** Captured under fresh launch admission; a matching receipt proves custody. */
  admittedHost?: { conversationId: string; seatEpoch: number; designatedAt: string | null };
  launchBody?: Record<string, unknown>;
  finalText?: string;
  importBatch?: ImportBatch;
  budgetSweepCandidates?: Record<string, string[]>;
  budgetSweep?: { scope: string; candidates: number; restored: number; integrated: number; remaining: number }[];
}
type ProjectRow = { kind: "project"; project: string; current: string | null; lastClaimAt: string; claimRevisions?: Record<string, number>; lastAt: string | null; passes: string[] };
export interface CurationOperation {
  kind: "operation";
  version: 1;
  id: string;
  pass: string;
  conversationId: string;
  project: string;
  digest: string;
  committedAt: string;
  disposition: "committed";
  revisions: { scope: string; input: number; result: number }[];
  placeholders: Record<string, string>;
  counts: CuratorPass["counts"];
  /** Completion recorded after the editorial commit; never licenses publication. */
  maintenance: { counts: "pending" | "complete"; knownValues: "pending" | "complete"; cleanup: "pending" | "complete" };
}
export const CURATION_OPERATION_BYTES = 128 * 1024;
export function curationOperationId(pass: string, request: string) {
  return createHash("sha256").update(JSON.stringify([pass, request])).digest("hex");
}
const countFields = ["calls", "changed", "rewritten", "merged", "moved", "split", "archived", "restored"] as const;
/** The writer and cold reader share this bound. No rule bodies belong here. */
export function validCurationOperation(value: unknown): value is CurationOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as CurationOperation;
  const string = (value: unknown, max = 1024) => typeof value === "string" && value.length > 0 && value.length <= max;
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  return Buffer.byteLength(JSON.stringify(value)) <= CURATION_OPERATION_BYTES
    && row.kind === "operation" && row.version === 1 && row.disposition === "committed"
    && typeof row.id === "string" && /^[a-f0-9]{64}$/.test(row.id)
    && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)
    && string(row.pass) && string(row.conversationId) && string(row.project)
    && typeof row.committedAt === "string" && Number.isFinite(Date.parse(row.committedAt))
    && Array.isArray(row.revisions) && row.revisions.length > 0 && row.revisions.length <= 64
    && new Set(row.revisions.map(item => item?.scope)).size === row.revisions.length
    && row.revisions.every(item => item && string(item.scope) && integer(item.input) && integer(item.result) && item.result === item.input + 1)
    && !!row.placeholders && typeof row.placeholders === "object" && !Array.isArray(row.placeholders)
    && Object.entries(row.placeholders).length <= 2048 && Object.entries(row.placeholders).every(([key, value]) => string(key) && string(value))
    && !!row.counts && countFields.every(field => integer(row.counts[field])) && row.counts.calls === 1
    && !!row.maintenance && [row.maintenance.counts, row.maintenance.knownValues, row.maintenance.cleanup].every(value => value === "pending" || value === "complete");
}
type Row = CurationOperation | CuratorPass | ProjectRow | { kind: "machine"; current: string | null; budgetSweepAttemptedAt?: string; budgetSweepEndedAt?: string; budgetSweepCompletedAt?: string } | { kind: "conversation"; conversationId: string; pass: string };
const key = (row: Row) => row.kind === "operation" ? `o:${row.id}` : row.kind === "pass" ? `r:${row.id}` : row.kind === "project" ? `p:${row.project}` : row.kind === "machine" ? "machine" : `c:${row.conversationId}`;
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
      return row && (row.kind === "operation" && validCurationOperation(row) || row.kind === "pass" && typeof row.id === "string" && Array.isArray(row.scopes)
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
type CountMemo = { sourceVersion: string; stamp: string; rowStamp: string; scopeKeys: string[]; familyKeys: string[]; counts: CuratorPass["counts"]; bytes: number };
const countOwner = process as typeof process & { __llvCurationCounts?: Map<string, CountMemo> };
const countMemos = countOwner.__llvCurationCounts ??= new MeasuredCache<string, CountMemo>("counts", "memory/curation/store", entry => entry.bytes, "encoded-json");
function* readPassSteps(id: string, fence?: CurationReadFence): Generator<null, CuratorPass | null> {
  const row = observedPass(id, fence);
  if (!row) return null;
  const memoKey = JSON.stringify([statePath("state.sqlite"), row.project, id]);
  const aliases = JSON.stringify(projectAliasSnapshot().aliases);
  const sourceVersion = `${curationReadVersion()}:${aliases}`;
  let scopeKeys: string[] | undefined, family: string[] | undefined;
  const familyKeys = () => family ??= curationReadScopeKeys(row.project, fence);
  const selectedKeys = () => scopeKeys ??= [...new Set([...familyKeys(), ...row.scopes.map(scope => `s:${canonicalScope(scope)}`)])];
  let rowStamp: string | undefined;
  const stamp = function* () {
    rowStamp = yield* curationRowRevisionSteps(selectedKeys(), fence?.row);
    return JSON.stringify([databaseIdentity(), rowStamp, row.counts, aliases]);
  };
  const prior = countMemos.get(memoKey);
  const cached = prior?.rowStamp && prior.familyKeys ? prior : undefined;
  let version: string | undefined;
  if (cached && (cached.sourceVersion === sourceVersion || cached.stamp === (version = yield* stamp()))) {
    fence?.rows(cached.scopeKeys, cached.rowStamp);
    // The family can gain a scope not named by an older pass.
    fence?.value("scopes:" + row.project, () => curationReadScopeKeys(row.project), cached.familyKeys);
    cached.sourceVersion = sourceVersion;
    countMemos.delete(memoKey); countMemos.set(memoKey, cached);
    return { ...row, counts: { ...cached.counts }, ...sweepCounts(row, fence) };
  }
  version ??= yield* stamp();
  yield null;
  const calls = new Map<string, CuratorPass["counts"]>();
  const inputs = yield* curationScopeInputs(selectedKeys(), projectStatusBoundary(row.project, fence) ?? {}, id, fence?.row);
  // Physical scope order retains the original last-scope-wins receipt rule.
  for (const scope of inputs) for (const [at, counts] of scope.calls ?? []) { calls.set(at, counts); yield null; }
  const counts = { ...row.counts };
  if (calls.size) {
    for (const field of Object.keys(counts) as (keyof typeof counts)[]) counts[field] = 0;
    for (const call of calls.values()) {
      for (const field of Object.keys(counts) as (keyof typeof counts)[]) counts[field] += call[field];
      yield null;
    }
  }
  // Derived counts contain no histories. One owner, 32 entries / 512 KiB,
  // invalidated by metadata, scope revisions, aliases or database replacement.
  const bytes = Buffer.byteLength(memoKey + version + rowStamp + JSON.stringify([selectedKeys(), familyKeys()]) + JSON.stringify(counts));
  if ((yield* stamp()) === version && bytes <= 16 * 1024) {
    countMemos.delete(memoKey); countMemos.set(memoKey, { sourceVersion, stamp: version, rowStamp: rowStamp!, scopeKeys: selectedKeys(), familyKeys: familyKeys(), counts: { ...counts }, bytes });
    let total = [...countMemos.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (countMemos.size > 32 || total > 512 * 1024) {
      const oldest = countMemos.keys().next().value!;
      total -= countMemos.get(oldest)!.bytes; countMemos.delete(oldest);
    }
  }
  return { ...row, counts, ...sweepCounts(row, fence) };
}
export function readPass(id: string): CuratorPass | null {
  const steps = readPassSteps(id);
  try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
  finally { steps.return(null); }
}
function sweepCounts(pass: CuratorPass, fence?: CurationReadFence): Pick<CuratorPass, "budgetSweep"> {
  if (!passIsLive(pass) && pass.budgetSweep) return { budgetSweep: pass.budgetSweep };
  if (!pass.budgetSweepCandidates) return {};
  return { budgetSweep: Object.entries(pass.budgetSweepCandidates).map(([scope, ids]) => {
    const rules = ids.map(id => roleMemoryCollection()?.get(`r:${id}`));
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!, row = rules[index];
      fence?.value("sweep-rule:" + id, () => {
        const current = roleMemoryCollection()?.get("r:" + id);
        return current?.kind === "rule" ? current.state : null;
      }, row?.kind === "rule" ? row.state : null);
    }
    return { scope, candidates: ids.length,
      restored: rules.filter(row => row?.kind === "rule" && row.state === "active").length,
      integrated: rules.filter(row => row?.kind === "rule" && row.state === "merged").length,
      remaining: rules.filter(row => row?.kind === "rule" && row.state === "archived").length };
  }) };
}
function projectRows(project: string, fence?: CurationReadFence): ProjectRow[] {
  const canonical = canonicalProject(project);
  const rows = [...new Set([canonical, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === canonical)])]
    .flatMap(project => { const row = curationCollection()?.get("p:" + project); return row?.kind === "project" ? [row] : []; });
  fence?.value("project:" + canonical, () => projectRows(project), rows);
  return rows;
}
function observedPass(id: string, fence?: CurationReadFence): CuratorPass | null {
  const row = readPassAuthority(id);
  fence?.value("pass:" + id, () => readPassAuthority(id), row);
  return row;
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
/** Status needs the claim boundary, without reading or sorting retained passes. */
function projectStatusBoundary(project: string, fence?: CurationReadFence) {
  const rows = projectRows(project, fence);
  if (!rows.length) return null;
  const claimRevisions: Record<string, number> = {};
  for (const row of rows) for (const [scope, revision] of Object.entries(row.claimRevisions ?? {})) {
    claimRevisions[scope] = Math.max(claimRevisions[scope] ?? 0, revision);
  }
  return { rows, claimRevisions, lastClaimAt: rows.map(row => row.lastClaimAt).sort().at(-1)!,
    lastAt: rows.map(row => row.lastAt).filter((at): at is string => !!at).sort().at(-1) ?? null };
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
  // Callers count lessons and pass receipts over the whole history.
  const take = (row: ReturnType<typeof held.get>) => { if (row?.kind === "scope") scopes.set(row.scope, row.historyRows ? roleRowWithHistory(`s:${row.scope}`) as RoleMemoryScopeRow ?? row : row); };
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
/** Preserve curationScopes' physical membership and ordering, while excluding
 * undo snapshots from status and count reconstruction. */
function curationReadScopeKeys(project: string, fence?: CurationReadFence): string[] {
  if (!roleMemoryCollection()) {
    fence?.value("scopes:" + project, () => curationReadScopeKeys(project), []);
    return [];
  }
  const p = canonicalProject(project);
  const projects = [...new Set([p, ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === p)])];
  const selected = [...projects.map(project => `s:project:${project}`), "s:machine"];
  for (const prefix of [...projects.map(project => `s:role:${project}:`), "s:role:*:"]) {
    selected.push(...roleScopeRowKeys(prefix));
  }
  const keys = [...new Set(selected)];
  fence?.value("scopes:" + project, () => curationReadScopeKeys(project), keys);
  return keys;
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
type CurationSummary = { active: boolean; pressure: boolean; urgent: boolean; newLessons: number; lastAt: string | null; lastClaimAt: string | null };
// Compiled bundles share 32 summaries with compact dependency keys. Oversized
// tokens are not retained; the source histories never enter this memo.
const shared = globalThis as typeof globalThis & {
  __llvCurationSummaries?: Map<string, { stamp: string; rowStamp: string; projectStamp: string; scopeKeys: string[]; sourceVersion: string; ruleKeys: string[]; summary: CurationSummary }>;
  __llvCurationSweep?: { stamp: string; pending: boolean };
};
const summaries = shared.__llvCurationSummaries ??= new MeasuredCache("summaries", "memory/curation/store");
function* curationStatusSteps(project: string, now = Date.now(), setting = effectiveCurationSetting(readSeatTickSettings(canonicalProject(project))), scopeRows?: readonly RoleMemoryScopeRow[], cacheSummary = true, fence?: CurationReadFence) {
  const collection = roleMemoryCollection();
  const key = `${statePath("state.sqlite")}:${canonicalProject(project)}`;
  const sourceVersion = curationReadVersion();
  const aliases = JSON.stringify(projectAliasSnapshot().aliases);
  const version = `${sourceVersion}:${aliases}`;
  let scopeKeys: string[] | undefined;
  const selectedKeys = () => scopeKeys ??= curationReadScopeKeys(project, fence);
  let rowStamp: string | undefined;
  const stampFor = function* (ruleKeys: string[]) {
    rowStamp = yield* curationRowRevisionSteps([...selectedKeys(), ...ruleKeys]);
    return JSON.stringify([databaseIdentity(), projectRows(project), aliases, rowStamp]);
  };
  const prior = cacheSummary ? summaries.get(key) : undefined;
  const cached = prior?.rowStamp && prior.projectStamp ? prior : undefined;
  let checkedStamp: string | undefined;
  let summary = cached && (cached.sourceVersion === version || cached.stamp === (checkedStamp = yield* stampFor(cached.ruleKeys))) ? cached.summary : null;
  if (cached && summary) {
    fence?.rows([...cached.scopeKeys, ...cached.ruleKeys], cached.rowStamp);
    fence?.value("scopes:" + project, () => curationReadScopeKeys(project), cached.scopeKeys);
    fence?.serialized("project:" + canonicalProject(project), () => projectRows(project), cached.projectStamp);
  }
  if (cached) {
    if (summary && cached.sourceVersion !== version && curationReadVersion() === sourceVersion) cached.sourceVersion = version;
    summaries.delete(key); summaries.set(key, cached);
  }
  if (!summary) {
    yield;
    const ruleKeys = new Set<string>();
    const held = projectStatusBoundary(project, fence);
    yield;
    let active = false, pressure = false, urgent = false, newLessons = 0;
    const changedScopes = new Set<string>();
    const activeByCanonicalScope = new Map<string, Map<string, ReturnType<typeof curationRuleInputs>[number]>>();
    const inputs = scopeRows ? [] : yield* curationScopeInputs(selectedKeys(), held ?? {}, undefined, fence?.row);
    if (scopeRows) for (const row of scopeRows) inputs.push(yield* curationScopeInputSteps(row, held ?? {}));
    const allIds = [...new Set(inputs.flatMap(row => row.active))];
    const ruleInputs = new Map<string, ReturnType<typeof curationRuleInputs>[number]>();
    for (let start = 0; start < allIds.length; start += 32) {
      for (const rule of curationRuleInputs(allIds.slice(start, start + 32), fence?.row)) ruleInputs.set(rule.id, rule);
      yield;
    }
    for (const row of inputs) {
      for (const id of row.active) ruleKeys.add(`r:${id}`);
      const rules = row.active.flatMap(id => { const rule = ruleInputs.get(id); return rule ? [rule] : []; });
      active ||= rules.length > 0;
      const canonical = canonicalScope(row.scope);
      const grouped = activeByCanonicalScope.get(canonical) ?? new Map();
      for (const rule of rules) grouped.set(rule.id, rule);
      activeByCanonicalScope.set(canonical, grouped);
      if (row.revision > (held?.claimRevisions?.[row.revisionScope ?? row.scope] ?? 0)) changedScopes.add(canonical);
      newLessons += row.newLessons;
    }
    // Aliased physical rows represent one scope in the launch snapshot. Apply
    // pressure to their deduplicated canonical rule set as a whole.
    for (const [scope, rules] of activeByCanonicalScope) {
      const scopeRules = [...rules.values()];
      const chars = scopeRules.reduce((sum, rule) => sum + rule.chars, Math.max(0, scopeRules.length - 1));
      urgent ||= changedScopes.has(scope) && chars > ROLE_MEMORY_BOUND;
      // A full, already-curated scope does not cause an endless sequence of passes.
      pressure ||= chars > ROLE_MEMORY_BOUND || scopeRules.some(rule => rule.uncurated) && chars >= ROLE_MEMORY_BOUND * 0.9;
    }
    summary = { active, pressure, urgent, newLessons, lastAt: held?.lastAt ?? null, lastClaimAt: held?.lastClaimAt ?? null };
    if (cacheSummary) {
      const dependencies = [...ruleKeys];
      // A changed rule usually leaves membership intact. Reuse the token
      // checked before reading it; the source-version check below proves it
      // still describes the answer, without a second pass over the same rows.
      const completedStamp = checkedStamp && cached?.ruleKeys.length === dependencies.length
        && dependencies.every((key, index) => key === cached.ruleKeys[index]) ? checkedStamp : yield* stampFor(dependencies);
      if (curationReadVersion() === sourceVersion && Buffer.byteLength(completedStamp) + Buffer.byteLength(JSON.stringify(held?.rows ?? [])) + Buffer.byteLength(rowStamp ?? cached!.rowStamp) + Buffer.byteLength(JSON.stringify([...selectedKeys(), ...dependencies])) <= 128 * 1024) {
        summaries.delete(key); summaries.set(key, { stamp: completedStamp, rowStamp: rowStamp ?? cached!.rowStamp, projectStamp: JSON.stringify(held?.rows ?? []), scopeKeys: selectedKeys(), sourceVersion: version, ruleKeys: dependencies, summary });
        while (summaries.size > 32) summaries.delete(summaries.keys().next().value!);
      }
    }
  }
  const { pressure, newLessons, lastAt, lastClaimAt } = summary;
  const machine = curationCollection()?.get("machine");
  fence?.value("machine", () => curationCollection()?.get("machine") ?? null, machine ?? null);
  // Sweep eligibility is machine-wide and has a separate, scalar memo.
  // Its global revision must not invalidate this project's history summary.
  const sweepStamp = `${databaseIdentity()}:${collection?.revision()}:${curationRevision()}`;
  if (shared.__llvCurationSweep?.stamp !== sweepStamp) shared.__llvCurationSweep = {
    stamp: sweepStamp, pending: !(machine?.kind === "machine" && machine.budgetSweepCompletedAt) && budgetArchiveCandidates(1).length > 0,
  };
  const sweepPending = shared.__llvCurationSweep.pending;
  if (!(machine?.kind === "machine" && machine.budgetSweepCompletedAt)) {
    fence?.value("sweep-pending", () => budgetArchiveCandidates(1).length > 0, sweepPending);
  }
  const sweepAnchor = machine?.kind === "machine" ? [machine.budgetSweepAttemptedAt, machine.budgetSweepEndedAt].filter((at): at is string => !!at).sort().at(-1) : undefined;
  const sweepDue = sweepPending && !(sweepAnchor && now < Date.parse(sweepAnchor) + setting.intervalMs);
  const urgent = summary.urgent || sweepDue;
  const batch = selectImportBatch(project);
  fence?.value("import:" + project, () => selectImportBatch(project), batch);
  const active = summary.active || !!batch || sweepPending;
  const lastPassId = projectRows(project, fence).flatMap(row => row.passes).at(-1);
  const lastPass = lastPassId ? observedPass(lastPassId, fence) : null;
  const importing = !!batch && (!lastPass || lastPass.state === "succeeded");
  // Failed/no-op passes spend the durable interval. A new over-bound
  // revision requests immediate integration, without reopening the same claim.
  const anchor = [lastAt, lastClaimAt].filter((at): at is string => !!at).sort().at(-1);
  const eligibleAt = anchor ? Date.parse(anchor) + setting.intervalMs : now;
  const due = setting.enabled && active && (urgent || importing || now >= eligibleAt);
  const trigger = urgent ? "pressure" : !anchor ? "initial" : pressure ? "pressure" : newLessons >= CURATION_NEW_LESSONS ? "new-lessons" : "interval";
  return { active, due, pressure, urgent, trigger, newLessons, lastAt, lastClaimAt, nextAt: setting.enabled && active ? new Date(urgent ? now : Math.max(now, eligibleAt)).toISOString() : null };

}

function statusReadVersion() {
  return JSON.stringify([statePath("state.sqlite"), curationReadVersion(), curationRevision(), projectAliasSnapshot().aliases]);
}

/** The database token is a change notification. A retry requires a changed
 * input: observed rows (including absence), scope membership, curation records
 * or the derived import/sweep selection. Each request owns this short-lived
 * journal, and validation itself yields under that request's deadline. */
class CurationReadFence {
  private identity = JSON.stringify([statePath("state.sqlite"), databaseIdentity(), projectAliasSnapshot().aliases]);
  private revisions = new Map<string, number | undefined>();
  private values = new Map<string, { read: () => unknown; expected: string }>();
  changed = false;

  row = (key: string, revision: number | undefined) => {
    if (this.revisions.has(key) && this.revisions.get(key) !== revision) this.changed = true;
    else this.revisions.set(key, revision);
  };
  rows(keys: readonly string[], stamp: string) {
    if (stamp === "missing") { for (const key of keys) this.row(key, undefined); return; }
    const [, rows] = JSON.parse(stamp) as [string, { row_key: string; row_revision: number }[]];
    const revisions = new Map(rows.map(row => [row.row_key, row.row_revision]));
    for (const key of keys) this.row(key, revisions.get(key));
  }
  value(key: string, read: () => unknown, value: unknown) { this.serialized(key, read, JSON.stringify(value)); }
  serialized(key: string, read: () => unknown, expected: string) {
    const prior = this.values.get(key);
    if (prior && prior.expected !== expected) this.changed = true;
    else this.values.set(key, { read, expected });
  }
  *validate(): Generator<null, boolean> {
    const identity = () => JSON.stringify([statePath("state.sqlite"), databaseIdentity(), projectAliasSnapshot().aliases]);
    if (this.changed || identity() !== this.identity) return false;
    for (const { read, expected } of this.values.values()) {
      if (JSON.stringify(read()) !== expected) return false;
      yield null;
    }
    const keys = [...this.revisions.keys()];
    if (keys.length) {
      const stamp = yield* curationRowRevisionSteps(keys);
      if (stamp === "missing") return false;
      const [, rows] = JSON.parse(stamp) as [string, { row_key: string; row_revision: number }[]];
      const current = new Map(rows.map(row => [row.row_key, row.row_revision]));
      for (const key of keys) if (current.get(key) !== this.revisions.get(key)) return false;
    }
    return identity() === this.identity;
  }
}
function finishRead<T>(steps: Generator<null | undefined, T>, check?: () => void): T {
  try {
    for (;;) {
      check?.();
      const next = steps.next();
      check?.();
      if (next.done) return next.value;
    }
  }
  finally { steps.return(undefined as never); }
}
export function curationStatus(project: string, now = Date.now(), setting = effectiveCurationSetting(readSeatTickSettings(canonicalProject(project))), scopeRows?: readonly RoleMemoryScopeRow[], cacheSummary = true) {
  return withViewerOperation("memory.curation-status", () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fence = new CurationReadFence(), version = statusReadVersion();
      const result = finishRead(curationStatusSteps(project, now, setting, scopeRows, cacheSummary, fence));
      if (!fence.changed && statusReadVersion() === version || finishRead(fence.validate())) return result;
    }
    throw Error("memory changed while reading curation status");
  });
}

/** Serving reads yield in labelled slices. Every caller owns its iterator and
 * cancellation. Only relevant changes restart work; unrelated commits trigger
 * bounded dependency validation. One deadline covers work and validation. */
export async function curationStatusCooperatively(project: string, now = Date.now(), setting = effectiveCurationSetting(readSeatTickSettings(canonicalProject(project))), signal?: AbortSignal) {
  return curationReadCooperatively(fence => curationStatusSteps(project, now, setting, undefined, true, fence), signal);
}
async function curationReadCooperatively<T>(create: (fence: CurationReadFence) => Generator<null | undefined, T>, signal?: AbortSignal, operation: "memory.curation-status" | "memory.curation-panel" = "memory.curation-status"): Promise<T> {
  const deadline = performance.now() + 5000;
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw Error("curation status read timed out");
  };
  const slice = <R>(steps: Generator<null | undefined, R>): IteratorResult<null | undefined, R> => withViewerOperation(operation, () => {
    const started = performance.now();
    let next = steps.next(), count = 1;
    while (!next.done && count++ < 256 && performance.now() - started < 8) next = steps.next();
    return next;
  });
  const pause = async () => {
    await yieldToRuntime();
    // Give Bun timers a turn as well as immediates.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    check();
  };
  const validate = async (fence: CurationReadFence) => {
    const steps = fence.validate();
    try {
      for (;;) {
        check(); const next = slice(steps); check();
        if (next.done) return next.value;
        await pause();
      }
    } finally { steps.return(false); }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    const fence = new CurationReadFence();
    let version = statusReadVersion();
    const steps = create(fence);
    try {
      for (;;) {
        check(); const next = slice(steps); check();
        if (!next.done) await pause();
        const observed = statusReadVersion();
        if (fence.changed || observed !== version) {
          if (!await validate(fence)) break;
          // Validation may itself yield after observing a dependency. Before
          // returning a completed answer, seal those observations without an
          // intervening await. These are dependency-only reads in bounded SQL
          // batches; cancellation and the same deadline apply to every step.
          // Unrelated commits do not require a globally quiet database.
          if (next.done && !finishRead(fence.validate(), check)) break;
          // Observe before validation: a peer writing during its yields must
          // still be noticed at the next check, even if this check was valid.
          version = observed;
        }
        if (next.done) return next.value;
      }
    } finally { steps.return(undefined as never); }
  }
  throw Error("memory changed while reading curation status");
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
    const next = { ...held, ...patch, id, kind: "pass" as const, project: held.project, scopes: held.scopes, admittedHost: held.admittedHost ?? patch.admittedHost, launchBody: held.launchBody ?? patch.launchBody };
    if (next.state === "succeeded" && held.budgetSweepCandidates) {
      const missing = Object.entries(held.budgetSweepCandidates).filter(([scope, ids]) => {
        const row = roleRowWithHistory(`s:${canonicalScope(scope)}`);
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
function panelPasses(project: string, fence?: CurationReadFence) {
  const rows = projectRows(project, fence);
  let latestCompleted: CuratorPass | null = null;
  for (const row of rows) {
    // Pass ids are appended in claim order. The newest entry can be the live
    // pass, so walk back only to this row's newest completed pass; never
    // materialize the retained history for a panel read.
    for (let index = row.passes.length - 1; index >= 0; index--) {
      const pass = observedPass(row.passes[index]!, fence);
      if (!pass) continue;
      if (passIsLive(pass)) continue;
      if (!latestCompleted || pass.claimedAt > latestCompleted.claimedAt) latestCompleted = pass;
      break;
    }
  }
  const current = rows.map(row => row.current ? observedPass(row.current, fence) : null).find(passIsLive) ?? null;
  return { live: current, last: latestCompleted };
}
export function curationPanelRuns(project: string) {
  const selected = panelPasses(project);
  return { live: selected.live ? readPass(selected.live.id) : null, last: selected.last ? readPass(selected.last.id) : null };
}
/** Run identities remain readable when history-derived counts or scheduling
 * exceed the panel deadline. The caller marks their counts unavailable. */
export function curationPanelRunMetadata(project: string) {
  return panelPasses(project);
}
/** One deadline and freshness fence cover both displayed pass counts and status. */
export async function curationPanelDataCooperatively(project: string, now: number, setting: ReturnType<typeof effectiveCurationSetting>, signal?: AbortSignal) {
  return curationReadCooperatively(function* (fence) {
    let runs: ReturnType<typeof curationPanelRuns> = { live: null, last: null };
    try {
      const selected = panelPasses(project, fence);
      const live = selected.live ? yield* readPassSteps(selected.live.id, fence) : null;
      yield null;
      const last = selected.last ? yield* readPassSteps(selected.last.id, fence) : null;
      runs = { live, last };
      yield null;
      const status = yield* curationStatusSteps(project, now, setting, undefined, true, fence);
      return { runs, status };
    } catch (error) { return { runs, error }; }
  }, signal, "memory.curation-panel");
}
