import type { Database } from "bun:sqlite";
import { readAttribution } from "../readAttribution";
import { nextSqliteRows } from "../sqliteReadAttribution";
import { yieldToRuntime } from "../cooperative";
import { databaseFileIdentity } from "./currentDatabase";

export const membershipCollections = ["tasks", "pipelines", "pipelines_archive", "flows"] as const;
export const retiredMembershipIndex = "state_rows_project_membership";

// CASE keeps invalid and non-text values out on both old and new JSON engines.
// This expression is evaluated by the current reader, never stored in the schema.
export const rawProjectKey = (value: string) =>
  `CASE WHEN json_valid(${value}) THEN CASE WHEN json_type(${value}, '$.project')='text' THEN json_extract(${value}, '$.project') END END`;

type Version = { revision: number; change_floor: number; migration_id: string };
type ProjectRow = { row_key: string; project: string | null };
type Group = { version: Version | null; rows: Map<string, string>; counts: Map<string, number>; bytes: number };
const maxChanges = 256;
// A directory keeps one projection. Charge both strings and a per-row map
// allowance; oversized histories keep the scan for this cache's lifetime.
const maxBytes = 16 * 1024 * 1024;
const versionSql = "SELECT revision,change_floor,migration_id FROM state_collections WHERE collection=?";

function apply(group: Group, row: ProjectRow): void {
  const before = group.rows.get(row.row_key);
  if (before === (row.project || undefined)) return;
  if (before !== undefined) {
    const count = group.counts.get(before)!;
    if (count === 1) group.counts.delete(before);
    else group.counts.set(before, count - 1);
    group.rows.delete(row.row_key);
    group.bytes -= 96 + 2 * (row.row_key.length + before.length);
  }
  if (row.project) {
    group.rows.set(row.row_key, row.project);
    group.bytes += 96 + 2 * (row.row_key.length + row.project.length);
    group.counts.set(row.project, (group.counts.get(row.project) ?? 0) + 1);
  }
}

function refreshGroup(db: Database, collection: string, group: Group, next: Version | null): boolean {
  const old = group.version;
  if (old?.migration_id !== next?.migration_id) return false;
  if (!next || !old) {
    return !db.query("SELECT 1 FROM state_rows WHERE collection=? LIMIT 1").get(collection);
  }
  if (old.revision === next.revision) return true;
  const delta = next.revision - old.revision;
  if (delta < 0 || delta > maxChanges || old.revision < next.change_floor) return false;
  const changes = db.query<ProjectRow & { revision: number }, [string, number, number, number]>(`
    SELECT c.row_key,c.revision,${rawProjectKey("r.value_json")} AS project
    FROM state_changes c LEFT JOIN state_rows r ON r.collection=c.collection AND r.row_key=c.row_key
    WHERE c.collection=? AND c.revision>? AND c.revision<=? LIMIT ?
  `).all(collection, old.revision, next.revision, maxChanges + 1);
  if (changes.length > maxChanges || new Set(changes.map(row => row.revision)).size !== delta) return false;
  for (const row of changes) apply(group, row);
  group.version = next;
  return true;
}

/** Owned by one project-directory cache. Only raw keys survive preparation;
 * SQLite readers of different versions share neither stored expressions nor maps. */
export class ProjectMembershipIndex {
  private groups?: Map<string, Group>;
  private preparation?: Promise<void>;
  private disabled = false;
  private readonly identity: string | null;

  constructor(private readonly filename: string, private readonly open: () => Database) {
    this.identity = databaseFileIdentity(filename);
  }

  prepare(): Promise<void> {
    if (this.preparation) return this.preparation;
    if (this.groups || this.disabled) return Promise.resolve();
    this.preparation = readAttribution.run("state.project-membership-prepare", () => this.build())
      .finally(() => { this.preparation = undefined; });
    return this.preparation;
  }

  dispose(): void {
    this.disabled = true;
    this.groups = undefined;
  }

  private async build(): Promise<void> {
    await yieldToRuntime();
    if (this.disabled || !this.identity || databaseFileIdentity(this.filename) !== this.identity) return;
    const db = this.open();
    try {
      // WAL lets this independent snapshot yield without retaining a writer
      // reservation or preventing a peer commit. Older stores keep the scan.
      if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "wal") return;
      db.exec("BEGIN");
      const groups = new Map<string, Group>();
      const version = db.query<Version, [string]>(versionSql);
      const rows = db.query<ProjectRow, [string]>(
        `SELECT row_key, ${rawProjectKey("value_json")} AS project FROM state_rows WHERE collection=?`);
      let slice = performance.now(), bytes = 0;
      for (const collection of membershipCollections) {
        const group: Group = { version: version.get(collection), rows: new Map(), counts: new Map(), bytes: 0 };
        const iterator = rows.iterate(collection)[Symbol.iterator]();
        for (;;) {
          const page = nextSqliteRows(iterator, 8);
          for (const row of page) apply(group, row);
          if (bytes + group.bytes > maxBytes) { this.dispose(); return; }
          if (performance.now() - slice >= 4) {
            await yieldToRuntime();
            if (this.disabled || databaseFileIdentity(this.filename) !== this.identity) return;
            slice = performance.now();
          }
          if (page.length < 8) break;
        }
        bytes += group.bytes;
        groups.set(collection, group);
        await yieldToRuntime();
        if (this.disabled || databaseFileIdentity(this.filename) !== this.identity) return;
        slice = performance.now();
      }
      db.exec("COMMIT");
      if (databaseFileIdentity(this.filename) === this.identity) this.groups = groups;
    } finally {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
    }
  }

  /** All versions and changed keys come from the same read transaction.
   * Missing history or a reimport sends this read back through the full scan. */
  read(db: Database, collections: readonly string[]): string[] | null {
    const groups = this.groups;
    if (!groups || databaseFileIdentity(this.filename) !== this.identity) return null;
    try {
      const keys = db.transaction(() => {
        const projects = new Set<string>();
        const version = db.query<Version, [string]>(versionSql);
        for (const collection of new Set(collections)) {
          const group = groups.get(collection);
          if (!group) return null;
          if (!refreshGroup(db, collection, group, version.get(collection))) return null;
          for (const project of group.counts.keys()) projects.add(project);
        }
        if ([...groups.values()].reduce((n, group) => n + group.bytes, 0) > maxBytes) {
          this.dispose();
          return null;
        }
        return [...projects];
      })();
      if (keys !== null && databaseFileIdentity(this.filename) === this.identity) return keys;
    } catch {
      // A legacy or changing journal cannot authorize incremental results.
      // The caller reads the authoritative rows and propagates any scan error.
    }
    this.groups = undefined;
    return null;
  }
}
