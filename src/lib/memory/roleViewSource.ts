import type { Database, SQLQueryBindings } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { databaseFileIdentity, openCurrentDatabase } from "@/lib/state/currentDatabase";
import { observeSqlite } from "@/lib/sqliteReadAttribution";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { canonicalScope, roleMemoryCollection } from "./roleStore";
import { isCrossProjectRoleScope, scopeProject, scopeRole } from "./roleScopes";
import type { RoleMemoryRow, RoleMemoryRule, RoleMemoryScopeRow, ScopeHistoryEntry } from "./roleTypes";
import { yieldToRuntime } from "@/lib/cooperative";
import { scopeChars } from "./roleConsolidate";
import { performanceSpans } from "@/lib/performanceSpans";

// One read-only connection across compiled Viewer bundles; changing state roots
// closes it. openCurrentDatabase reopens it after a restore at the same path.
const owner = globalThis as typeof globalThis & {
  __llvCurationVersionReader?: { file: string; db: Database; generation: number };
  __llvRoleViewReader?: { file: string; db: Database; generation: number };
  __llvProfileBasisReader?: { file: string; db: Database; generation: number };
  __llvPrivacyRevisionReader?: { file: string; db: Database; generation: number };
  __llvRoleViewGeneration?: number;
  __llvCurationRules?: { file: string; identity: string | null; bytes: number;
    rows: Map<string, { revision: number; row: CurationRuleInput | null; bytes: number }> };
  __llvCurationInputs?: { file: string; identity: string | null; bytes: number;
    rows: Map<string, { stamp: string; row: CurationScopeInput; calls: ScopeCalls; bytes: number }> };
  __llvCurationScopeProjection?: { file: string; identity: string | null; bytes: number;
    rows: Map<string, { revision: number; row: RoleMemoryScopeRow; bytes: number }> };
};
type ReaderSlot = "__llvRoleViewReader" | "__llvCurationVersionReader" | "__llvProfileBasisReader" | "__llvPrivacyRevisionReader";
function reader(slot: ReaderSlot = "__llvRoleViewReader") {
  const file = statePath("state.sqlite");
  if (owner[slot]?.file === file) return owner[slot].db;
  owner[slot]?.db.close();
  owner[slot] = undefined;
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(file, () => {
    const opened = observeSqlite(new sqlite.Database(file, { readonly: true, strict: true }), slot === "__llvPrivacyRevisionReader" ? "memory.privacy.revision" : "memory.view");
    opened.exec("PRAGMA busy_timeout = 0");
    return opened;
  });
  const generation = owner.__llvRoleViewGeneration = (owner.__llvRoleViewGeneration ?? 0) + 1;
  owner[slot] = { file, db, generation };
  return db;
}

/** Rule rows include archived texts and reasons. Request and scope bookkeeping
 * cannot invalidate privacy work. This reader never shares a history snapshot. */
export function privacyRuleRevision(): string {
  const file = statePath("state.sqlite");
  const identity = databaseFileIdentity(file)!;
  const db = reader("__llvPrivacyRevisionReader");
  db.exec("BEGIN");
  try {
    const meta = db.query<{ imported_at: string }, []>(
      "SELECT imported_at FROM state_collections WHERE collection='role_memory'").get();
    if (!meta) return "";
    const clock = db.query<{ revision: string }, []>(
      "SELECT CAST(revision AS TEXT) AS revision FROM role_memory_privacy_revision WHERE singleton=1").get();
    return JSON.stringify([identity, meta.imported_at, clock?.revision ?? "0"]);
  } finally { db.exec("ROLLBACK"); }
}

/** Version tokens belong to the same shared connection as the memo's reads.
 * PRAGMA data_version is connection-relative: separate compiled bundles must
 * never compare tokens minted by independent connections or counters. */
export function roleViewVersion(): string { return readVersion("__llvRoleViewReader"); }
/** A version observer must not share a cooperative history cursor's SQLite
 * read snapshot, which can hide peer commits until that cursor closes. */
export function curationReadVersion(): string { return readVersion("__llvCurationVersionReader"); }
function readVersion(slot: "__llvRoleViewReader" | "__llvCurationVersionReader"): string {
  const file = statePath("state.sqlite");
  if (databaseFileIdentity(file) === null) return "missing";
  const db = reader(slot);
  const version = db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
  return `${owner[slot]!.generation}:${databaseFileIdentity(file)}:${version}:${schema}`;
}
function keys(prefix: string, predicate = "1", bindings: SQLQueryBindings[] = [], slot: ReaderSlot = "__llvRoleViewReader"): string[] {
  return reader(slot).query<{ row_key: string }, SQLQueryBindings[]>(`
    SELECT row_key FROM state_rows WHERE collection = 'role_memory'
    AND row_key > ? AND row_key < ? AND (${predicate}) ORDER BY row_order, row_key
  `).all(prefix, `${prefix}\uffff`, ...bindings).map(row => row.row_key);
}

/** Validate a cooperative view after peer writes without decoding scope
 * histories. Missing change history or a large batch refuses the view. */
export function projectViewUnaffectedByChanges(project: string, from: number | undefined, through: number | undefined,
  selected: readonly RoleMemoryRow[]): boolean {
  if (from === undefined || through === undefined || through < from) return false;
  // Preserve absent lookup dependencies too: a peer can insert a referenced
  // rule or scope after its lookup without changing any selected row.
  const dependencyKeys = new Set<string>();
  const ids = new Set<string>();
  const ruleDependency = (id: string) => { dependencyKeys.add(`r:${id}`); ids.add(id); };
  for (const row of selected) {
    if (row.kind === "rule") {
      ruleDependency(row.id);
      for (const id of [...(row.versions ?? []), ...(row.mergedFrom ?? []),
        ...(row.versionOf ? [row.versionOf] : []), ...(row.splitFrom ? [row.splitFrom] : [])]) ruleDependency(id);
      dependencyKeys.add(`s:${row.scope}`);
      dependencyKeys.add(`s:${canonicalScope(row.scope)}`);
    } else if (row.kind === "scope") {
      dependencyKeys.add(`s:${row.scope}`);
      for (const id of row.active) ruleDependency(id);
    } else dependencyKeys.add(`q:${row.pipelineId}:${row.stageId}:${row.attempt}`);
  }
  const relevantScope = (scope: unknown) => typeof scope === "string" && (scope === "machine"
    || isCrossProjectRoleScope(scope) || scopeProject(canonicalScope(scope)) === project);
  const db = reader();
  db.exec("BEGIN");
  try {
    const meta = db.query<{ revision: number; change_floor: number }, []>(
      "SELECT revision, change_floor FROM state_collections WHERE collection='role_memory'").get();
    if (!meta || meta.revision !== through || meta.change_floor > from) return false;
    const changed = db.query<{ row_key: string; inputs: string | null }, [number, number]>(`
      SELECT changes.row_key, CASE WHEN substr(changes.row_key,1,2)='s:' THEN NULL
        ELSE json_extract(row.value_json, '$.kind', '$.scope', '$.mergedInto',
          '$.versionOf', '$.splitFrom', '$.versions', '$.mergedFrom', '$.rewrote', '$.ruleIds') END AS inputs
      FROM (SELECT DISTINCT row_key FROM state_changes
        WHERE collection='role_memory' AND revision>? AND revision<=? LIMIT 257) changes
      LEFT JOIN state_rows row ON row.collection='role_memory' AND row.row_key=changes.row_key
    `).all(from, through);
    if (changed.length > 256 || through > from && !changed.length) return false;
    const sweepComplete = db.query<{ completed: string | null }, []>(`
      SELECT json_extract(value_json, '$.budgetSweepCompletedAt') AS completed
      FROM state_rows WHERE collection='role_memory_curation' AND row_key='machine'
    `).get()?.completed;
    for (const row of changed) {
      if (dependencyKeys.has(row.row_key)) return false;
      // Scope identity is in the key; parsing its JSON would also parse its
      // retained history even when only a few metadata fields are extracted.
      if (row.row_key.startsWith("s:")) {
        if (relevantScope(row.row_key.slice(2))) return false;
        continue;
      }
      // Before the one-time budget sweep finishes, even foreign rules affect
      // the machine-wide sweep eligibility shown by this project's status.
      if (!sweepComplete && row.row_key.startsWith("r:")) return false;
      if (row.inputs === null) continue;
      const [kind, scope, mergedInto, versionOf, splitFrom, versions, mergedFrom, rewrote, ruleIds] = JSON.parse(row.inputs) as unknown[];
      if (kind === "scope" || kind === "rule") {
        if (relevantScope(scope)) return false;
      } else if (kind !== "request") return false;
      const links = [mergedInto, versionOf, splitFrom, rewrote,
        ...(Array.isArray(versions) ? versions : []), ...(Array.isArray(mergedFrom) ? mergedFrom : []),
        ...(Array.isArray(ruleIds) ? ruleIds : [])];
      if (links.some(id => typeof id === "string" && ids.has(id))) return false;
    }
    return true;
  } finally { db.exec("ROLLBACK"); }
}

/** Inspect scope identities without decoding their potentially large histories. */
export function roleScopeKeys(): string[] {
  return roleMemoryCollection() ? keys("s:").map(key => key.slice(2)) : [];
}

/** Profile reads cannot inherit a cooperative history cursor's old snapshot. */
export function profileScopeKeys(): string[] {
  return roleMemoryCollection() ? keys("s:", "1", [], "__llvProfileBasisReader").map(key => key.slice(2)) : [];
}

/** Curation selects one scope family in key order. This covered key lookup
 * avoids reading other projects or the row_order behind retained histories. */
export function roleScopeRowKeys(prefix: string): string[] {
  return reader("__llvCurationVersionReader").query<{ row_key: string }, [string, string]>(`
    SELECT row_key FROM state_rows WHERE collection='role_memory'
    AND row_key > ? AND row_key <= ? ORDER BY row_key
  `).all(prefix, `${prefix}\uffff`).map(row => row.row_key);
}

/** Version only the rows a curation summary consumed, including absent keys.
 * Unrelated lessons must not make polling decode retained scope histories. */
export function roleRowRevisionToken(rowKeys: readonly string[]): string { return revisionToken(rowKeys, "__llvRoleViewReader"); }
export type CurationRowObserver = (key: string, revision: number | undefined) => void;
/** Revision columns can sit beyond a large scope JSON value on overflow pages.
 * Small key batches keep this metadata-only validation cooperative too. */
export function* curationRowRevisionSteps(rowKeys: readonly string[], observe?: CurationRowObserver): Generator<null, string> {
  const file = statePath("state.sqlite"), keys = [...new Set(rowKeys)];
  if (databaseFileIdentity(file) === null) return "missing";
  for (let attempt = 0; attempt < 3; attempt++) {
    const identity = databaseFileIdentity(file), rows: { row_key: string; row_revision: number }[] = [];
    for (let start = 0; start < keys.length; start += 8) {
      const batch = keys.slice(start, start + 8);
      const selected = reader("__llvCurationVersionReader").query<{ row_key: string; row_revision: number }, [string]>(
        "SELECT row_key,row_revision FROM state_rows WHERE collection='role_memory' AND row_key IN (SELECT value FROM json_each(?))"
      ).all(JSON.stringify(batch));
      rows.push(...selected);
      if (observe) {
        const revisions = new Map(selected.map(row => [row.row_key, row.row_revision]));
        for (const key of batch) observe(key, revisions.get(key));
      }
      yield null;
    }
    if (databaseFileIdentity(file) === identity) {
      rows.sort((a, b) => a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0);
      return JSON.stringify([identity, rows]);
    }
  }
  throw Error("memory database changed while reading summary revisions");
}
function revisionToken(rowKeys: readonly string[], slot: "__llvRoleViewReader" | "__llvCurationVersionReader"): string {
  const file = statePath("state.sqlite");
  if (databaseFileIdentity(file) === null) return "missing";
  const db = reader(slot);
  for (let attempt = 0; attempt < 3; attempt++) {
    const identity = databaseFileIdentity(file);
    const rows = db.query<{ row_key: string; row_revision: number }, [string]>(`
      SELECT row_key,row_revision FROM state_rows WHERE collection='role_memory'
      AND row_key IN (SELECT value FROM json_each(?)) ORDER BY row_key
    `).all(JSON.stringify(rowKeys));
    if (databaseFileIdentity(file) === identity) return JSON.stringify([identity, rows]);
  }
  throw new Error("memory database changed while reading summary revisions");
}

/** Cold, one-time recovery inventory. Read only archive identities, never texts
 * or request histories. Versions and explicit operator removals stay excluded. */
export function budgetArchiveCandidates(limit?: number): { id: string; scope: string }[] {
  if (!roleMemoryCollection()) return [];
  return reader("__llvCurationVersionReader").query<{ id: string; scope: string }, [number]>(`
    SELECT json_extract(value_json, '$.id') AS id, json_extract(value_json, '$.scope') AS scope
    FROM state_rows WHERE collection = 'role_memory' AND row_key > 'r:' AND row_key < 'r;'
      AND json_extract(value_json, '$.state') = 'archived'
      AND json_extract(value_json, '$.versionOf') IS NULL
      AND (json_extract(value_json, '$.reason') = 'budget'
        OR COALESCE(trim(json_extract(value_json, '$.reason')), '') = '')
    ORDER BY row_key LIMIT ?
  `).all(limit ?? -1).map(row => ({ ...row, scope: canonicalScope(row.scope) }));
}

/** A foreign recovery scope needs an accurate inventory without loading its project. */
export function leftRuleCount(scope: string): number {
  if (!roleMemoryCollection()) return 0;
  const project = scopeProject(scope), rawScopes = [scope];
  if (project) for (const alias of Object.keys(projectAliasSnapshot().aliases)) {
    if (canonicalProject(alias) === project) rawScopes.push(scope.replace(`:${project}`, `:${alias}`));
  }
  return reader().query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM state_rows WHERE collection = 'role_memory'
      AND row_key > 'r:' AND row_key < 'r;'
      AND json_extract(value_json, '$.versionOf') IS NULL
      AND json_extract(value_json, '$.state') IN ('archived', 'merged')
      AND json_extract(value_json, '$.scope') IN (SELECT value FROM json_each(?))
  `).get(JSON.stringify(rawScopes))!.count;
}

/** Curator-only evidence, restricted to the requested rule ids. Usage is
 * attached to lesson requests even when that attempt left no new lesson. */
export function ruleUsageCounts(ids: readonly string[]): Record<string, { applied: number; misled: number }> {
  if (!ids.length || !roleMemoryCollection()) return {};
  const result: Record<string, { applied: number; misled: number }> = {};
  for (const field of ["applied", "misled"] as const) {
    const counts = reader().query<{ id: string; count: number }, [string]>(`
      SELECT u.value AS id, COUNT(*) AS count FROM state_rows s, json_each(s.value_json, '$.${field}') u
      WHERE s.collection='role_memory' AND s.row_key > 'q:' AND s.row_key < 'q;'
        AND u.value IN (SELECT value FROM json_each(?)) GROUP BY u.value
    `).all(JSON.stringify(ids));
    for (const row of counts) (result[row.id] ??= { applied: 0, misled: 0 })[field] = row.count;
  }
  return result;
}

/** Status retains membership, a counted lesson total and compact pass receipts.
 * Retained source history and Undo never enter the cache.
 * A claim changes the counting boundary; a rule edit leaves these inputs intact. */
export type CurationClaim = { lastClaimAt?: string | null; claimRevisions?: Record<string, number> };
type PassCounts = NonNullable<ScopeHistoryEntry["counts"]>;
type ScopeCalls = Map<string, Map<string, PassCounts>>;
export type CurationScopeInput = Pick<RoleMemoryScopeRow, "scope" | "revision" | "revisionScope" | "active"> & { newLessons: number; calls?: Map<string, PassCounts> };
function* passCalls(calls: ScopeCalls, pass?: string): Generator<null, Map<string, PassCounts> | undefined> {
  if (!pass) return undefined;
  const result = new Map<string, PassCounts>();
  for (const [at, counts] of calls.get(pass) ?? []) { result.set(at, { ...counts }); yield null; }
  return result;
}
type LessonFact = { revision: number; scope: string; at: string; count: number };

function* countLessons(facts: LessonFact[], curated: Map<string, number>, since: string, claim: CurationClaim): Generator<null, number> {
  let count = 0;
  for (const fact of facts) {
    const revision = claim.claimRevisions ? Math.max(claim.claimRevisions[fact.scope] ?? 0, curated.get(fact.scope) ?? 0) : null;
    if (revision === null ? fact.at > since : fact.revision > revision) count += fact.count;
    yield null;
  }
  return count;
}

/** Used also for the already projected project view, with identical boundaries. */
export function* curationScopeInputSteps(row: RoleMemoryScopeRow, claim: CurationClaim): Generator<null, CurationScopeInput> {
  const curated = new Map<string, number>(), facts: LessonFact[] = [];
  for (const h of row.history) {
    const scope = h.revisionScope ?? row.scope;
    if (h.by === "curator") curated.set(scope, Math.max(curated.get(scope) ?? 0, h.revision));
    if (h.by === "agent") facts.push({ revision: h.revision, scope, at: h.at, count: h.added.length + h.merged.length + (h.rewritten?.length ?? 0) });
    yield null;
  }
  const since = [row.curatedAt, claim.lastClaimAt].filter((at): at is string => !!at).sort().at(-1) ?? "";
  return { scope: row.scope, revision: row.revision, revisionScope: row.revisionScope, active: [...row.active], newLessons: yield* countLessons(facts, curated, since, claim) };
}

/** At most one cursor connection per active caller. It is closed before that
 * caller moves to another scope and on cancellation/error. Sharing a cursor's
 * connection would let an independent reader inherit its older WAL snapshot. */
function curationHistoryReader() {
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  return openCurrentDatabase(statePath("state.sqlite"), () => {
    const db = observeSqlite(new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }), "memory.view");
    db.exec("PRAGMA busy_timeout = 0");
    return db;
  });
}

export function* curationScopeInputs(rowKeys: readonly string[], claim: CurationClaim, pass?: string, observe?: CurationRowObserver): Generator<null, CurationScopeInput[]> {
  const file = statePath("state.sqlite"), result: CurationScopeInput[] = [];
  const boundary = JSON.stringify([claim.lastClaimAt, claim.claimRevisions]);
  for (const rowKey of rowKeys) {
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const identity = databaseFileIdentity(file);
      const revision = () => reader("__llvCurationVersionReader").query<{ row_revision: number }, [string]>(
        "SELECT row_revision FROM state_rows WHERE collection='role_memory' AND row_key=?").get(rowKey)?.row_revision;
      const version = revision();
      observe?.(rowKey, version);
      if (databaseFileIdentity(file) !== identity) continue;
      let cache = owner.__llvCurationInputs;
      if (!cache || cache.file !== file || cache.identity !== identity) {
        cache = owner.__llvCurationInputs = { file, identity, bytes: 0, rows: new Map() };
      }
      const stamp = `${version}:${boundary}`, cached = cache.rows.get(rowKey);
      if (cached && cached.stamp !== stamp) { cache.rows.delete(rowKey); cache.bytes -= cached.bytes; }
      if (version === undefined) { settled = true; continue; }
      if (cached?.stamp === stamp) {
        cache.rows.delete(rowKey); cache.rows.set(rowKey, cached);
        result.push({ ...cached.row, active: [...cached.row.active], calls: yield* passCalls(cached.calls, pass) }); settled = true; yield null; continue;
      }
      // json_each parses the scope once. CASE never materializes the history
      // value; its type still validates the same persisted boundary.
      const fields = reader("__llvCurationVersionReader").query<{ key: string; type: string; value: string | number | null }, [string]>(
        "SELECT h.key,h.type,CASE WHEN h.key='history' THEN NULL ELSE h.value END AS value " +
        "FROM state_rows s,json_each(s.value_json) h WHERE s.collection='role_memory' AND s.row_key=? " +
        "AND h.key IN ('kind','scope','revision','revisionScope','active','curatedAt','history')"
      ).all(rowKey);
      if (!fields.length) continue;
      const header = new Map(fields.map(field => [field.key, field]));
      const scope = header.get("scope")?.value as string;
      const activeField = header.get("active");
      if (header.get("kind")?.value !== "scope" || activeField?.type !== "array" || header.get("history")?.type !== "array") throw Error("invalid projected memory scope");
      const active = JSON.parse(activeField.value as string) as string[];
      const rev = header.get("revision")?.value as number;
      const revisionScope = header.get("revisionScope")?.value as string | null | undefined;
      const curatedAt = header.get("curatedAt")?.value as string | null | undefined;
      yield null;
      const curated = new Map<string, number>(), facts: LessonFact[] = [], calls: ScopeCalls = new Map();
      let callBytes = 0;
      const db = curationHistoryReader();
      try {
        const history = db.prepare<{ fields: string }, [string]>(`
          SELECT json_extract(h.value, '$.revision', '$.revisionScope', '$.at', '$.by', '$.added', '$.merged', '$.rewritten', '$.pass', '$.counts') AS fields
          FROM state_rows s, json_each(s.value_json, '$.history') h
          WHERE s.collection='role_memory' AND s.row_key=?
        `);
        // The cooperative caller closes this cursor on cancellation, timeout and
        // retry. It never holds a write transaction across a yield.
        try {
          for (const item of history.iterate(rowKey)) {
            if (!item.fields) throw Error("invalid projected memory history");
            const [revision, revisionScope, at, by, added, merged, rewritten, passId, counts] = JSON.parse(item.fields);
            const source = revisionScope ?? scope;
            if (passId && counts) {
              const receipts = calls.get(passId) ?? new Map<string, PassCounts>();
              receipts.set(at, counts); calls.set(passId, receipts);
              // An upper bound also covers repeated receipts without serializing
              // the complete retained map at the end of the read.
              callBytes += Buffer.byteLength(passId + at + JSON.stringify(counts));
            }
            if (by === "curator") curated.set(source, Math.max(curated.get(source) ?? 0, revision));
            if (by === "agent") {
              if (added === null || merged === null) throw Error("invalid projected memory history");
              facts.push({ revision, scope: source, at, count: added.length + merged.length + (rewritten?.length ?? 0) });
            }
            yield null;
          }
        } finally { history.finalize(); }
      } finally { db.close(); }
      const since = [curatedAt, claim.lastClaimAt].filter((at): at is string => !!at).sort().at(-1) ?? "";
      const row: CurationScopeInput = { scope, revision: rev, ...(revisionScope == null ? {} : { revisionScope }), active,
        newLessons: yield* countLessons(facts, curated, since, claim) };
      if (revision() !== version || databaseFileIdentity(file) !== identity) continue;
      result.push({ ...row, active: [...active], calls: yield* passCalls(calls, pass) }); settled = true;
      const bytes = Buffer.byteLength(rowKey + stamp + JSON.stringify(row)) + callBytes;
      if (bytes <= 128 * 1024) {
        // Another independent reader may have completed while this one yielded.
        const previous = cache.rows.get(rowKey);
        if (previous) { cache.rows.delete(rowKey); cache.bytes -= previous.bytes; }
        cache.rows.set(rowKey, { stamp, row, calls, bytes }); cache.bytes += bytes;
        while (cache.rows.size > 64 || cache.bytes > 1024 * 1024) {
          const oldest = cache.rows.keys().next().value!;
          cache.bytes -= cache.rows.get(oldest)!.bytes; cache.rows.delete(oldest);
        }
      }
    }
    if (!settled) throw Error("memory scope changed while being read");
  }
  return result;
}

export type CurationRuleInput = { id: string; chars: number; uncurated: boolean };
/** Cache exact budget sizes by row revision, excluding provenance and text.
 * One owner, LRU eviction at 4096 rules / 1 MiB; replacement drops the cache. */
export function curationRuleInputs(ids: readonly string[], observe?: CurationRowObserver): CurationRuleInput[] {
  if (!ids.length) return [];
  const file = statePath("state.sqlite"), identity = databaseFileIdentity(file), db = reader("__llvCurationVersionReader");
  let cache = owner.__llvCurationRules;
  if (!cache || cache.file !== file || cache.identity !== identity) {
    cache = owner.__llvCurationRules = { file, identity, bytes: 0, rows: new Map() };
  }
  const revisions = db.query<{ row_key: string; row_revision: number }, [string]>(`
    SELECT row_key,row_revision FROM state_rows WHERE collection='role_memory'
    AND row_key IN (SELECT 'r:' || value FROM json_each(?))
  `).all(JSON.stringify(ids));
  if (observe) {
    const byKey = new Map(revisions.map(row => [row.row_key, row.row_revision]));
    for (const id of ids) observe("r:" + id, byKey.get("r:" + id));
  }
  const result: CurationRuleInput[] = [];
  for (const { row_key: key, row_revision: revision } of revisions) {
    const cached = cache.rows.get(key);
    if (cached?.revision === revision) {
      cache.rows.delete(key); cache.rows.set(key, cached);
      if (cached.row) result.push({ ...cached.row });
      continue;
    }
    const stored = db.query<{ fields: string; row_revision: number }, [string]>(`
      SELECT row_revision, json_extract(value_json, '$.kind', '$.id', '$.rule', '$.curatedAt', '$.state', '$.versionOf') AS fields
      FROM state_rows WHERE collection='role_memory' AND row_key=?
    `).get(key);
    observe?.(key, stored?.row_revision);
    if (!stored) continue;
    const [kind, id, rule, curatedAt, state, versionOf] = JSON.parse(stored.fields);
    if (kind !== "rule" || typeof id !== "string" || typeof rule !== "string") throw Error("invalid projected memory rule");
    const row = state === "active" && !versionOf ? { id, chars: scopeChars([{ id, rule, why: "" }]), uncurated: !curatedAt } : null;
    if (row) result.push({ ...row });
    if (databaseFileIdentity(file) !== identity) continue;
    const bytes = Buffer.byteLength(key + JSON.stringify(row)) + 16;
    if (cached) { cache.rows.delete(key); cache.bytes -= cached.bytes; }
    if (bytes <= 16 * 1024) {
      cache.rows.set(key, { revision: stored.row_revision, row, bytes }); cache.bytes += bytes;
      while (cache.rows.size > 4096 || cache.bytes > 1024 * 1024) {
        const oldest = cache.rows.keys().next().value!;
        cache.bytes -= cache.rows.get(oldest)!.bytes; cache.rows.delete(oldest);
      }
    }
  }
  return result;
}

function* projectedScopeRowSteps(rowKeys: readonly string[]): Generator<RoleMemoryScopeRow | null> {
  if (!rowKeys.length) return;
  const db = reader();
  const base = db.query<{ base_json: string; history_type: string | null }, [string]>(`SELECT json_extract(value_json,
    '$.kind', '$.scope', '$.revision', '$.revisionScope', '$.active', '$.curatedAt') AS base_json, json_type(value_json, '$.history') AS history_type
    FROM state_rows WHERE collection='role_memory' AND row_key=?`);
  const history = db.prepare<{ fields_json: string }, [string]>(`SELECT json_extract(h.value,
    '$.revision', '$.revisionScope', '$.at', '$.by', '$.pass', '$.counts',
    '$.revertedAt', '$.added', '$.merged', '$.rewritten', '$.archived') AS fields_json
    FROM state_rows s, json_each(s.value_json, '$.history') h
    WHERE s.collection='role_memory' AND s.row_key=?`);
  try {
    for (const rowKey of rowKeys) {
      const header = base.get(rowKey);
      const baseJson = header?.base_json;
      if (!baseJson) continue;
      const [kind, scope, revision, revisionScope, active, curatedAt] = JSON.parse(baseJson) as [string, string, number, string | null, string[], string | null];
      if (kind !== "scope") throw new Error("invalid projected memory scope");
      if (!Array.isArray(active) || header!.history_type !== "array") throw new Error("invalid projected memory scope");
      const changes: ScopeHistoryEntry[] = [];
      for (const item of history.iterate(rowKey)) {
        const [changeRevision, changeScope, at, by, pass, counts, revertedAt, added, merged, rewritten, archived] = JSON.parse(item.fields_json) as unknown[];
        changes.push({ revision: changeRevision as number, ...(changeScope === null ? {} : { revisionScope: changeScope as string }), at: at as string,
          by: by as ScopeHistoryEntry["by"], ...(pass === null ? {} : { pass: pass as string }), ...(counts === null ? {} : { counts: counts as ScopeHistoryEntry["counts"] }),
          ...(revertedAt === null ? {} : { revertedAt: revertedAt as string }), added: added as string[], merged: merged as ScopeHistoryEntry["merged"],
          ...(rewritten === null ? {} : { rewritten: rewritten as ScopeHistoryEntry["rewritten"] }), archived: archived as string[] });
        yield null;
      }
      if (kind === "scope" && Array.isArray(active)) yield { kind, scope, revision, ...(revisionScope === null ? {} : { revisionScope }), active,
        history: changes, ...(curatedAt === null ? {} : { curatedAt }) };
    }
  } finally { history.finalize(); }

}

/** Read-only curation needs history counters, not the retained undo payloads.
 * Writers continue to use complete scope rows from the collection. */
export function projectedScopeRows(rowKeys: readonly string[]): RoleMemoryScopeRow[] {
  if (!rowKeys.length) return [];
  const file = statePath("state.sqlite"), db = reader();
  const readRevision = (rowKey: string) => db.query<{ row_revision: number }, [string]>(
    "SELECT row_revision FROM state_rows WHERE collection='role_memory' AND row_key=?").get(rowKey)?.row_revision;
  const rows: RoleMemoryScopeRow[] = [];
  for (const rowKey of rowKeys) {
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const identity = databaseFileIdentity(file);
      let cache = owner.__llvCurationScopeProjection;
      if (!cache || cache.file !== file || cache.identity !== identity) {
        cache = owner.__llvCurationScopeProjection = { file, identity, bytes: 0, rows: new Map() };
      }
      const version = readRevision(rowKey);
      // The guarded connection can reopen between the file-identity read and
      // the revision query. A reused revision must not hit the old file's memo.
      if (databaseFileIdentity(file) !== identity) continue;
      const held = cache.rows.get(rowKey);
      if (held && held.revision !== version) { cache.rows.delete(rowKey); cache.bytes -= held.bytes; }
      if (version === undefined) { settled = true; continue; }
      let row: RoleMemoryScopeRow | undefined, failure: unknown, failed = false;
      try {
        if (held?.revision === version) row = structuredClone(held.row);
        else for (const projected of projectedScopeRowSteps([rowKey])) if (projected) row = projected;
      } catch (error) { failure = error; failed = true; }
      // Base fields and history use separate SQL reads. Retry the entire row
      // when a writer intervenes; neither the caller nor the memo gets a hybrid.
      if (readRevision(rowKey) !== version || databaseFileIdentity(file) !== identity) continue;
      if (failed) throw failure;
      settled = true;
      if (!row) continue;
      rows.push(row);
      if (held?.revision === version) {
        cache.rows.delete(rowKey); cache.rows.set(rowKey, held);
      } else {
        const bytes = Buffer.byteLength(rowKey) + Buffer.byteLength(JSON.stringify(row));
        if (bytes <= 512 * 1024) {
          cache.rows.set(rowKey, { revision: version, row: structuredClone(row), bytes }); cache.bytes += bytes;
          while (cache.rows.size > 64 || cache.bytes > 8 * 1024 * 1024) {
            const oldest = cache.rows.keys().next().value!;
            cache.bytes -= cache.rows.get(oldest)!.bytes; cache.rows.delete(oldest);
          }
        }
      }
    }
    if (!settled) throw new Error("memory scope changed while being read");
  }
  return rows;
}

async function projectedScopeRowsCooperatively(rowKeys: readonly string[]): Promise<RoleMemoryScopeRow[]> {
  const rows: RoleMemoryScopeRow[] = [];
  const iterator = projectedScopeRowSteps(rowKeys);
  let done = false;
  try {
    while (!done) {
      let steps = 0;
      const started = performance.now();
      performanceSpans.sync("memory.project-view", () => {
        while (steps < 16 && performance.now() - started < 12) {
          const next = iterator.next();
          if (next.done) { done = true; break; }
          if (next.value) rows.push(next.value);
          steps++;
        }
      });
      if (!done) await yieldToRuntime();
    }
  } finally { iterator.return(undefined); }
  return rows;
}

export function roleScopeReadMetadata(scope: string, pass: string) {
  const db = reader();
  const row = db.query<{ revision: number; curatedAt: string | null; hasPass: number; departuresSince: string | null }, [string, string, string]>(`
    SELECT json_extract(s.value_json, '$.revision') AS revision,
      json_extract(s.value_json, '$.curatedAt') AS curatedAt,
      MAX(CASE WHEN json_extract(h.value, '$.pass')=? THEN 1 ELSE 0 END) AS hasPass,
      MAX(CASE WHEN json_extract(h.value, '$.by')='curator' AND
        (json_extract(h.value, '$.pass') IS NULL OR json_extract(h.value, '$.pass')<>?)
        THEN json_extract(h.value, '$.at') END) AS departuresSince
    FROM state_rows s LEFT JOIN json_each(s.value_json, '$.history') h
    WHERE s.collection='role_memory' AND s.row_key=? GROUP BY s.row_key
  `).get(pass, pass, `s:${scope}`);
  return row ? { revision: row.revision ?? 0, curatedAt: row.curatedAt, hasPass: !!row.hasPass, departuresSince: row.departuresSince ?? "" } :
    { revision: 0, curatedAt: null, hasPass: false, departuresSince: "" };
}

/** Decode the displayed scopes and their rule/task lineage, excluding unrelated
 * rule payloads before decoding. The collection remains the validation boundary.
 * Requests can belong to another project after a move, merge or split. */
export function projectViewRows(project: string): RoleMemoryRow[] {
  const held = roleMemoryCollection();
  if (!held) return [];
  const canonical = canonicalProject(project);
  const scopes = roleScopeKeys().filter(scope => scopeProject(scope) === canonical || isCrossProjectRoleScope(scope));
  scopes.push(`project:${canonical}`, "machine");
  const rawScopes = new Set(scopes);
  for (const alias of Object.keys(projectAliasSnapshot().aliases)) if (canonicalProject(alias) === canonical) {
    for (const scope of scopes) if (scopeProject(scope) === canonical) rawScopes.add(scope.replace(`:${canonical}`, `:${alias}`));
  }
  const selected = new Map<string, RoleMemoryRow>();
  const take = (key: string) => {
    if (selected.has(key)) return;
    const row = held.get(key);
    if (row) selected.set(key, row);
  };
  for (const scope of scopes) take(`s:${scope}`);
  for (const row of [...selected.values()]) if (row.kind === "scope") for (const id of row.active) take(`r:${id}`);
  for (const key of keys("r:", "json_extract(value_json, '$.scope') IN (SELECT value FROM json_each(?))", [JSON.stringify([...rawScopes])])) take(key);
  let frontier = [...selected.values()].flatMap(row => row.kind === "rule" ? [row] : []);
  while (frontier.length) {
    const before = new Set(selected.keys());
    for (const row of frontier) {
      for (const id of [...(row.versions ?? []), ...(row.mergedFrom ?? []), ...(row.versionOf ? [row.versionOf] : []), ...(row.splitFrom ? [row.splitFrom] : [])]) take(`r:${id}`);
      take(`s:${row.scope}`);
      take(`s:${canonicalScope(row.scope)}`);
    }
    for (const key of keys("r:", `json_extract(value_json, '$.versionOf') IS NULL AND
      json_extract(value_json, '$.mergedInto') IN (SELECT value FROM json_each(?))`, [JSON.stringify(frontier.map(row => row.id))])) take(key);
    frontier = [...selected].flatMap(([key, row]) => !before.has(key) && row.kind === "rule" ? [row] : []);
  }
  const ids = JSON.stringify([...selected.values()].flatMap(row => row.kind === "rule" ? [row.id] : []));
  for (const key of keys("q:", `json_extract(value_json, '$.rewrote') IN (SELECT value FROM json_each(?)) OR
    EXISTS (SELECT 1 FROM json_each(value_json, '$.ruleIds') WHERE value IN (SELECT value FROM json_each(?)))`, [ids, ids])) take(key);
  return [...selected.values()];
}

/** Asynchronous counterpart for HTTP and MCP reads. Large scope histories are
 * decoded in bounded slices so a cold or revised view does not monopolize the
 * event loop while preserving the same final answer. */
export async function projectViewRowsCooperatively(project: string): Promise<RoleMemoryRow[]> {
  const held = roleMemoryCollection();
  if (!held) return [];
  const canonical = canonicalProject(project);
  const scopes = roleScopeKeys().filter(scope => scopeProject(scope) === canonical || isCrossProjectRoleScope(scope));
  scopes.push(`project:${canonical}`, "machine");
  const rawScopes = new Set(scopes);
  for (const alias of Object.keys(projectAliasSnapshot().aliases)) if (canonicalProject(alias) === canonical) {
    for (const scope of [...scopes]) if (scopeProject(scope) === canonical) rawScopes.add(scope.replace(`:${canonical}`, `:${alias}`));
  }
  const selected = new Map<string, RoleMemoryRow>();
  const projected = await projectedScopeRowsCooperatively(scopes.map(scope => `s:${scope}`));
  for (const row of projected) selected.set(`s:${row.scope}`, row);
  let sliceStarted = performance.now(), sliceRows = 0;
  const take = (key: string) => {
    if (selected.has(key)) return;
    const row = held.get(key); if (row) selected.set(key, row);
  };
  for (const row of projected) for (const id of row.active) {
    take(`r:${id}`); sliceRows++;
    if (sliceRows >= 32 || performance.now() - sliceStarted >= 12) { await yieldToRuntime(); sliceRows = 0; sliceStarted = performance.now(); }
  }
  const ruleKeys = keys("r:", "json_extract(value_json, '$.scope') IN (SELECT value FROM json_each(?))", [JSON.stringify([...rawScopes])]);
  for (const key of ruleKeys) {
    take(key); sliceRows++;
    if (sliceRows >= 32 || performance.now() - sliceStarted >= 12) { await yieldToRuntime(); sliceRows = 0; sliceStarted = performance.now(); }
  }
  let frontier = [...selected.values()].flatMap(row => row.kind === "rule" ? [row] : []);
  while (frontier.length) {
    const before = new Set(selected.keys());
    for (const row of frontier) {
      for (const id of [...(row.versions ?? []), ...(row.mergedFrom ?? []), ...(row.versionOf ? [row.versionOf] : []), ...(row.splitFrom ? [row.splitFrom] : [])]) take(`r:${id}`);
      take(`s:${row.scope}`); take(`s:${canonicalScope(row.scope)}`);
    }
    const parents = keys("r:", `json_extract(value_json, '$.versionOf') IS NULL AND
      json_extract(value_json, '$.mergedInto') IN (SELECT value FROM json_each(?))`, [JSON.stringify(frontier.map(row => row.id))]);
    for (const key of parents) { take(key); sliceRows++; if (sliceRows >= 32) { await yieldToRuntime(); sliceRows = 0; } }
    frontier = [...selected].flatMap(([key, row]) => !before.has(key) && row.kind === "rule" ? [row] : []);
  }
  const lineageScopeKeys = [...selected.values()].flatMap(row => row.kind === "rule" ? [`s:${row.scope}`, `s:${canonicalScope(row.scope)}`] : []);
  for (const row of await projectedScopeRowsCooperatively([...new Set(lineageScopeKeys)].filter(key => !selected.has(key)))) selected.set(`s:${row.scope}`, row);
  const ids = JSON.stringify([...selected.values()].flatMap(row => row.kind === "rule" ? [row.id] : []));
  const requestKeys = keys("q:", `json_extract(value_json, '$.rewrote') IN (SELECT value FROM json_each(?)) OR
    EXISTS (SELECT 1 FROM json_each(value_json, '$.ruleIds') WHERE value IN (SELECT value FROM json_each(?)))`, [ids, ids]);
  for (const key of requestKeys) { take(key); sliceRows++; if (sliceRows >= 32) { await yieldToRuntime(); sliceRows = 0; } }
  return [...selected.values()];
}

/** The curator's read-only comparisons use the active rows of this role's other
 * project scopes, in original collection order, without a collection snapshot. */
export function otherProjectRoleRules(scope: string): RoleMemoryRule[] {
  const held = roleMemoryCollection(), role = scopeRole(scope);
  if (!held || !role || isCrossProjectRoleScope(scope)) return [];
  return keys("r:", `json_extract(value_json, '$.state') = 'active' AND
    json_extract(value_json, '$.versionOf') IS NULL AND
    json_extract(value_json, '$.scope') LIKE ?`, [`role:%:${role}`]).flatMap(key => {
    const row = held.get(key);
    return row?.kind === "rule" && scopeRole(row.scope) === role && canonicalScope(row.scope) !== scope && !isCrossProjectRoleScope(row.scope) ? [row] : [];
  });
}


/** Search only active membership, projecting rule text before decoding. CROSS
 * JOIN keeps scopes and active ids ahead of rule lookups; otherwise SQLite can
 * start from every historical rule. Histories and versions stay out of recall. */
export function activeRoleRuleRows(input: { project?: string; terms?: string[]; id?: string; limit: number }): Pick<RoleMemoryRule, "id" | "scope" | "rule" | "changedAt">[] {
  if (!roleMemoryCollection()) return [];
  const project = input.project ? canonicalProject(input.project) : null;
  const scopes = roleScopeKeys().filter(scope => !project || scope === "machine" || isCrossProjectRoleScope(scope) || canonicalProject(scopeProject(scope) ?? "") === project);
  if (!scopes.length) return [];
  // Succession can leave a rule's original scope on the row after its active
  // membership has joined the canonical scope. Admit that recorded alias family.
  const ruleScopes = new Set(scopes.flatMap(scope => [scope, canonicalScope(scope)]));
  const aliases = Object.keys(projectAliasSnapshot().aliases);
  for (const scope of [...ruleScopes]) {
    const owner = scopeProject(scope);
    if (owner) for (const alias of aliases) if (canonicalProject(alias) === canonicalProject(owner)) ruleScopes.add(scope.replace(`:${owner}`, `:${alias}`));
  }
  const terms = input.terms ?? [];
  // SQLite lower() folds ASCII only. For non-ASCII queries, fetch the active
  // rows in the already narrowed readable scopes and apply the same JavaScript
  // lowercase matching to stored text and terms. ASCII queries keep filtering
  // and limiting in SQLite.
  const unicodeTerms = terms.some(term => /[^\x00-\x7f]/u.test(term));
  const conditions = unicodeTerms ? [] : terms.map(() => `(instr(lower(json_extract(r.value_json, '$.rule')), lower(?)) > 0 OR instr(json_extract(r.value_json, '$.id'), ?) > 0)`);
  const rows = reader().query<Pick<RoleMemoryRule, "id" | "scope" | "rule" | "changedAt">, SQLQueryBindings[]>(`
    SELECT DISTINCT json_extract(r.value_json, '$.id') AS id,
      json_extract(r.value_json, '$.scope') AS scope,
      json_extract(r.value_json, '$.rule') AS rule,
      json_extract(r.value_json, '$.changedAt') AS changedAt
    FROM state_rows s CROSS JOIN json_each(s.value_json, '$.active') a
    CROSS JOIN state_rows r
    WHERE r.collection='role_memory' AND r.row_key='r:' || a.value
      AND s.collection='role_memory' AND s.row_key IN (SELECT 's:' || value FROM json_each(?))
      AND json_extract(s.value_json, '$.kind')='scope'
      AND json_extract(r.value_json, '$.kind')='rule'
      AND json_extract(r.value_json, '$.scope') IN (SELECT value FROM json_each(?))
      AND json_extract(r.value_json, '$.state')='active'
      AND json_extract(r.value_json, '$.versionOf') IS NULL
      ${input.id ? "AND r.row_key=?" : ""}
      ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
    ORDER BY changedAt DESC, id ${unicodeTerms ? "" : "LIMIT ?"}
  `).all(JSON.stringify(scopes), JSON.stringify([...ruleScopes]), ...(input.id ? [`r:${input.id}`] : []), ...(unicodeTerms ? [] : terms.flatMap(term => [term, term])), ...(unicodeTerms ? [] : [input.limit]));
  if (!unicodeTerms) return rows;
  const normalizedTerms = terms.map(term => term.toLowerCase());
  return rows.filter(row => {
    const text = row.rule.toLowerCase();
    return normalizedTerms.every(term => text.includes(term) || row.id.includes(term));
  }).slice(0, input.limit);
}


/** Saved profile freshness needs active membership and revision stamps only.
 * Preserve each scope's active order without decoding histories or provenance. */
export function activeProfileBasis(scopes: readonly string[]): Map<string, Array<Pick<RoleMemoryRule, "id" | "changedAt">>> {
  const basis = new Map(scopes.map(scope => [scope, [] as Array<Pick<RoleMemoryRule, "id" | "changedAt">>]));
  if (!scopes.length || !roleMemoryCollection()) return basis;
  const rows = reader("__llvProfileBasisReader").query<{ scope: string; id: string; changedAt: string }, [string]>(`
    SELECT wanted.value AS scope, json_extract(r.value_json, '$.id') AS id,
      json_extract(r.value_json, '$.changedAt') AS changedAt
    FROM json_each(?) wanted CROSS JOIN state_rows s
    CROSS JOIN json_each(s.value_json, '$.active') a CROSS JOIN state_rows r
    WHERE s.collection='role_memory' AND s.row_key='s:' || wanted.value
      AND json_extract(s.value_json, '$.kind')='scope'
      AND r.collection='role_memory' AND r.row_key='r:' || a.value
      AND json_extract(r.value_json, '$.kind')='rule'
    ORDER BY CAST(wanted.key AS INTEGER), CAST(a.key AS INTEGER)
  `).all(JSON.stringify(scopes));
  for (const row of rows) basis.get(row.scope)!.push({ id: row.id, changedAt: row.changedAt });
  return basis;
}
