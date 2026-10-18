import type { Database, SQLQueryBindings } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { databaseFileIdentity, openCurrentDatabase } from "@/lib/state/currentDatabase";
import { observeSqlite } from "@/lib/sqliteReadAttribution";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { canonicalScope, roleMemoryCollection } from "./roleStore";
import { isCrossProjectRoleScope, scopeProject, scopeRole } from "./roleScopes";
import type { RoleMemoryRow, RoleMemoryRule } from "./roleTypes";

// One read-only connection across compiled Viewer bundles; changing state roots
// closes it. openCurrentDatabase reopens it after a restore at the same path.
const owner = globalThis as typeof globalThis & {
  __llvRoleViewReader?: { file: string; db: Database; generation: number };
  __llvRoleViewGeneration?: number;
};
function reader() {
  const file = statePath("state.sqlite");
  if (owner.__llvRoleViewReader?.file === file) return owner.__llvRoleViewReader.db;
  owner.__llvRoleViewReader?.db.close();
  owner.__llvRoleViewReader = undefined;
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(file, () => {
    const opened = observeSqlite(new sqlite.Database(file, { readonly: true, strict: true }), "memory.view");
    opened.exec("PRAGMA busy_timeout = 0");
    return opened;
  });
  const generation = owner.__llvRoleViewGeneration = (owner.__llvRoleViewGeneration ?? 0) + 1;
  owner.__llvRoleViewReader = { file, db, generation };
  return db;
}

/** Version tokens belong to the same shared connection as the memo's reads.
 * PRAGMA data_version is connection-relative: separate compiled bundles must
 * never compare tokens minted by independent connections or counters. */
export function roleViewVersion(): string {
  const file = statePath("state.sqlite");
  if (databaseFileIdentity(file) === null) return "missing";
  const db = reader();
  const version = db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
  return `${owner.__llvRoleViewReader!.generation}:${databaseFileIdentity(file)}:${version}:${schema}`;
}
function keys(prefix: string, predicate = "1", bindings: SQLQueryBindings[] = []): string[] {
  return reader().query<{ row_key: string }, SQLQueryBindings[]>(`
    SELECT row_key FROM state_rows WHERE collection = 'role_memory'
    AND row_key > ? AND row_key < ? AND (${predicate}) ORDER BY row_order, row_key
  `).all(prefix, `${prefix}\uffff`, ...bindings).map(row => row.row_key);
}

/** Inspect scope identities without decoding their potentially large histories. */
export function roleScopeKeys(): string[] {
  return roleMemoryCollection() ? keys("s:").map(key => key.slice(2)) : [];
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
