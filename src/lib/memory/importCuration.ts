import { statePath } from "@/lib/configDir";
import { databaseFileIdentity, openCurrentDatabase } from "@/lib/state/currentDatabase";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { canonicalScope, roleMemoryCollection, RoleMemoryRefusal } from "./roleStore";
import { readMemorySourceFile } from "./source";
import { curatableImportId, memorySyncIntervalHours } from "./importSync";
import { importCollection, readImportRecord } from "./importStore";
import type { ImportCandidate } from "./importTypes";
import { passIsLive, passMetadata, curationCollection, readPass, type CuratorPass } from "./curation/store";
import { ROLE_IDS } from "@/lib/roles/types";
import { scopeProject } from "./roleScopes";
import { waitForStateLock } from "@/lib/state/lockWait";

export type ImportBatch = { importId: string; candidates: string[] };
const refuse = (message: string): never => { throw new RoleMemoryRefusal("CURATE_IMPORT", message); };
export const candidateKey = (row: ImportCandidate) => `c:${row.importId}:${row.group}:${String(row.part.index).padStart(8, "0")}`;
export function candidateById(importId: string, id: string): ImportCandidate | null {
  // The candidate id is independent of its part's group key. This query selects
  // one import before decoding and never materializes another collection.
  const held = importCollection();
  if (!held) return null;
  const lookup = held.get(`d:${importId}:${id}`);
  if (lookup?.kind === "lookup") {
    const row = held.get(lookup.key);
    return row?.kind === "candidate" && row.id === id && row.importId === importId ? row : null;
  }
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(statePath("state.sqlite"), () => new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }));
  try {
    const row = db.query<{ value_json: string }, [string, string, string]>(`SELECT value_json FROM state_rows
      WHERE collection='role_memory_import' AND row_key>? AND row_key<? AND json_extract(value_json,'$.id')=? LIMIT 1`)
      .get(`c:${importId}:`, `c:${importId}:\uffff`, id);
    return row ? JSON.parse(row.value_json) as ImportCandidate : null;
  } finally { db.close(); }
}

/** Every traversal uses direct rule keys, including a split's forward edges.
 * Corrupt or unbounded lineage fails closed instead of allowing a second adopt. */
export function survivingImportRules(ids: readonly string[]): string[] {
  const pending = [...ids], seen = new Set<string>(), active = new Set<string>();
  const held = roleMemoryCollection();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    if (seen.size >= 512) return refuse("import rule lineage exceeds its bound");
    seen.add(id);
    const row = held?.get(`r:${id}`);
    if (row?.kind !== "rule" || row.versionOf) continue;
    // Undo removes this import's contribution, including a provenance row
    // initially merged into text that already existed before the import.
    if (row.state === "archived" && row.reason === "undone") continue;
    if (row.state === "active") active.add(id);
    if (row.mergedInto) pending.push(row.mergedInto);
    pending.push(...row.splitChildren ?? []);
  }
  return [...active].sort();
}
export function candidateState(row: ImportCandidate) {
  const pending: string[] = [], surviving = new Set<string>(), undone = new Set<string>();
  for (const occurrence of row.occurrences) {
    const disposition = row.dispositions.findLast(item => item.occurrences.includes(occurrence.id));
    if (!disposition) { pending.push(occurrence.id); continue; }
    const pass = passMetadata(disposition.pass);
    const active = survivingImportRules(disposition.ruleIds);
    if (pass?.revertedAt && !active.length && !disposition.ruleIds.some(id => pass.skipped?.includes(id))) {
      pending.push(occurrence.id); undone.add(pass.id);
    } else for (const id of active) surviving.add(id);
  }
  return { state: pending.length ? "pending" as const : surviving.size ? "adopted" as const : "dropped" as const,
    pending, ruleIds: [...surviving].sort(), undonePasses: [...undone].sort() };
}

/** Filter metadata in SQLite and decode at most one bounded batch. A prior
 * undone pass is reconsidered from its rules, never from a second undo write. */
export function importMemoryRevision() {
  return `${databaseFileIdentity(statePath("state.sqlite"))}:${roleMemoryCollection()?.revision()}:${curationCollection()?.revision()}`;
}
const owner = globalThis as typeof globalThis & { __delegatusImportBatches?: Map<string, { stamp: string; batch: ImportBatch | null }> };
export function selectImportBatch(project: string): ImportBatch | null {
  const file = statePath("state.sqlite"), aliases = projectAliasSnapshot().aliases;
  const key = `${file}:${canonicalProject(project)}`;
  const stamp = `${databaseFileIdentity(file)}:${importCollection()?.revision()}:${roleMemoryCollection()?.revision()}:${curationCollection()?.revision()}:${JSON.stringify(readMemorySourceFile())}:${memorySyncIntervalHours()}:${JSON.stringify(aliases)}`;
  const cache = owner.__delegatusImportBatches ??= new Map();
  const held = cache.get(key);
  if (held?.stamp === stamp) { cache.delete(key); cache.set(key, held); return held.batch ? structuredClone(held.batch) : null; }
  const batch = selectBatch(project);
  cache.delete(key); cache.set(key, { stamp, batch });
  while (cache.size > 16) cache.delete(cache.keys().next().value!);
  return batch ? structuredClone(batch) : null;
}
function selectBatch(project: string): ImportBatch | null {
  const importId = curatableImportId();
  if (!importId || readImportRecord(importId)?.state !== "ready") return null;
  const source = { importId };
  const record = readImportRecord(importId)!;
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(statePath("state.sqlite"), () => new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }));
  try {
    const rows = db.query<{ value_json: string; bytes: number }, [string, string, string, string]>(`SELECT json_remove(c.value_json,'$.body') AS value_json, length(CAST(json_extract(c.value_json,'$.body') AS BLOB)) AS bytes FROM state_rows c
      WHERE c.collection='role_memory_import' AND c.row_key>? AND c.row_key<?
      AND COALESCE(json_extract(c.value_json,'$.curationProject'), json_extract(c.value_json,'$.occurrences[0].project'), ?) IN (SELECT value FROM json_each(?))
      AND (json_array_length(c.value_json,'$.dispositions')=0
        OR EXISTS (SELECT 1 FROM json_each(c.value_json,'$.occurrences') o WHERE NOT EXISTS
          (SELECT 1 FROM json_each(c.value_json,'$.dispositions') d, json_each(d.value,'$.occurrences') covered WHERE covered.value=json_extract(o.value,'$.id')))
        OR EXISTS (SELECT 1 FROM json_each(c.value_json,'$.dispositions') d JOIN state_rows p
          ON p.collection='role_memory_curation' AND p.row_key='r:'||json_extract(d.value,'$.pass')
          WHERE json_extract(p.value_json,'$.revertedAt') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(d.value,'$.ruleIds') r JOIN json_each(p.value_json,'$.skipped') s ON r.value=s.value)
          AND EXISTS (SELECT 1 FROM json_each(d.value,'$.occurrences') occurrence WHERE NOT EXISTS
            (SELECT 1 FROM json_each(c.value_json,'$.dispositions') later, json_each(later.value,'$.occurrences') covered
             WHERE CAST(later.key AS INTEGER)>CAST(d.key AS INTEGER) AND covered.value=occurrence.value))))
      ORDER BY json_extract(c.value_json,'$.loadedAtStart') DESC, json_extract(c.value_json,'$.group'), json_extract(c.value_json,'$.part.index') LIMIT 80`)
      .all(`c:${source.importId}:`, `c:${source.importId}:\uffff`, record.hostProject ?? project, JSON.stringify([canonicalProject(project), ...Object.keys(projectAliasSnapshot().aliases).filter(key => canonicalProject(key) === canonicalProject(project))]));
    const candidates: string[] = [];
    let bytes = 0;
    const groups = new Map<string, { row: ImportCandidate; bytes: number }[]>();
    let batchProject: string | null | undefined;
    for (const item of rows) {
      const row = JSON.parse(item.value_json) as ImportCandidate;
      if (candidateState(row).state !== "pending") continue;
      const project = row.occurrences[0].project ? canonicalProject(row.occurrences[0].project) : null;
      if (batchProject === undefined) batchProject = project;
      if (project !== batchProject) continue;
      const group = groups.get(row.group) ?? []; group.push({ row, bytes: item.bytes }); groups.set(row.group, group);
    }
    for (const group of groups.values()) {
      const size = group.reduce((n, item) => n + item.bytes, 0);
      if (candidates.length && (bytes + size > 64 * 1024 || candidates.length + group.length > 40)) break;
      for (const { row, bytes: size } of group) {
        if (bytes + size > 64 * 1024 || candidates.length === 40) break;
        bytes += size; candidates.push(row.id);
      }
    }
    return candidates.length ? { importId: source.importId, candidates } : null;
  } finally { db.close(); }
}
export function importBatchScopes(batch: ImportBatch): string[] {
  return [...new Set(batch.candidates.flatMap(id => {
    const row = candidateById(batch.importId, id)!;
    const project = row.occurrences[0].project;
    return [row.suggestedScope, ...(project ? [`project:${project}`, ...ROLE_IDS.map(role => `role:${project}:${role}`)] : [])];
  }).map(canonicalScope))];
}
export async function readImportBatch(pass: CuratorPass) {
  if (!pass.importBatch) return [];
  return waitForStateLock("memory.import.read", () => {
    const fresh = readPass(pass.id);
    if (!passIsLive(fresh) || curatableImportId() !== pass.importBatch!.importId) return refuse("import pass is no longer active");
    const rows = pass.importBatch!.candidates.map(id => candidateById(pass.importBatch!.importId, id) ?? refuse("import candidate missing"));
    importCollection(true)!.boundedPatch(160, tx => {
      for (const row of rows) if (!row.readBy?.includes(pass.id)) tx.put({ ...row, readBy: [...row.readBy ?? [], pass.id] });
    });
    return rows.map(row => ({ ...row, suggestedScope: canonicalScope(row.suggestedScope),
      occurrences: row.occurrences.map(o => ({ ...o, project: o.project ? canonicalProject(o.project) : null })), ...candidateState(row) }));
  });
}
export function assertImportCandidate(pass: CuratorPass, id: string) {
  if (!pass.importBatch || curatableImportId() !== pass.importBatch.importId || !pass.importBatch.candidates.includes(id)) return refuse("candidate does not belong to this active import batch");
  const row = candidateById(pass.importBatch.importId, id) ?? refuse("import candidate missing");
  if (!row.readBy?.includes(pass.id)) return refuse("the pass must read this part before dispositioning it");
  return row;
}

/** Successful settlement needs a durable disposition or explicit defer for
 * every offered occurrence. Defer receipts do not alter candidate state. */
export function importBatchAccountingGap(pass: CuratorPass): string | null {
  if (!pass.importBatch) return null;
  for (const id of pass.importBatch.candidates) {
    const row = candidateById(pass.importBatch.importId, id);
    if (!row) return `import candidate ${id} is missing`;
    for (const occurrence of row.occurrences) {
      const disposed = row.dispositions.some(item => item.pass === pass.id && item.occurrences.includes(occurrence.id));
      const deferred = row.deferred?.some(item => item.pass === pass.id && item.occurrences.includes(occurrence.id));
      if (!disposed && !deferred) return `import candidate ${id} occurrence ${occurrence.id} is unaccounted`;
    }
  }
  return null;
}
export function adoptionReaches(candidate: ImportCandidate, scope: string) {
  const project = scopeProject(canonicalScope(scope));
  return scope === "machine" || scope.startsWith("role:*:") || !!project && candidate.occurrences.every(item => item.project && canonicalProject(item.project) === project);
}
