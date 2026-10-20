import fs from "node:fs";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { smallStore } from "@/lib/state/smallStore";
import { collectionReadCache, rememberCollectionReadCache } from "@/lib/state/collectionReadCache";
import { readStateCollectionRevision } from "@/lib/state/sqliteStateStore";
import type { DocumentRow, LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";

export type WorktreeMapping = { repo: string; worktree: string };
export type AliasDocument = { aliases: Record<string, string>; displayNames: Record<string, string> };
export type CurationDocument = { crowned: string[]; manualProjects: { project: string; displayName: string; root: string; createdAt: number }[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project state is unreadable");
  return value as Record<string, unknown>;
}
function strings(value: unknown): Record<string, string> {
  const entries = Object.entries(object(value));
  if (entries.some(([key, item]) => !key.trim() || typeof item !== "string" || !item.trim())) throw new Error("Project state is unreadable");
  return Object.fromEntries(entries) as Record<string, string>;
}
function versioned(raw: unknown) {
  const value = object(raw);
  if (value.schemaVersion !== 1) throw new Error("Project state schema is unsupported");
  return value;
}
function rows(value: object, prefix = ""): DocumentRow[] {
  return Object.entries(value).map(([key, value]) => ({ key: prefix + key, value }));
}
export const projectAliasStore = smallStore<AliasDocument>({
  collection: "project_aliases", empty: () => ({ aliases: {}, displayNames: {} }),
  parse: raw => { const value = versioned(raw); return { aliases: strings(value.aliases), displayNames: strings(value.displayNames) }; },
  toRows: value => [...rows(value.aliases, "alias:"), ...rows(value.displayNames, "name:")],
  fromRows: rows => ({ aliases: Object.fromEntries(rows.filter(r => r.key.startsWith("alias:")).map(r => [r.key.slice(6), r.value as string])), displayNames: Object.fromEntries(rows.filter(r => r.key.startsWith("name:")).map(r => [r.key.slice(5), r.value as string])) }),
  toFile: value => ({ schemaVersion: 1, ...value }),
});
export const projectRemoteStore = smallStore<Record<string, string>>({
  collection: "project_remotes", empty: () => ({}),
  parse: raw => strings(versioned(raw).remotes), toRows: value => rows(value),
  fromRows: rows => Object.fromEntries(rows.map(r => [r.key, r.value as string])),
  toFile: remotes => ({ schemaVersion: 1, remotes }),
});
export const worktreeMapStore = smallStore<Record<string, WorktreeMapping>>({
  collection: "worktree_map", empty: () => ({}),
  parse: raw => Object.fromEntries(Object.entries(object(raw)).map(([cwd, item]) => {
    const value = object(item);
    if (typeof value.repo !== "string" || typeof value.worktree !== "string") throw new Error("Worktree map is unreadable");
    return [cwd, { repo: value.repo, worktree: value.worktree }];
  })),
  toRows: value => rows(value), fromRows: rows => Object.fromEntries(rows.map(r => [r.key, r.value as WorktreeMapping])), toFile: value => value,
});
export const projectCurationStore = smallStore<CurationDocument>({
  collection: "project_curation", empty: () => ({ crowned: [], manualProjects: [] }),
  parse: raw => {
    const value = versioned(raw);
    if (!Array.isArray(value.crowned) || value.crowned.some(v => typeof v !== "string" || !v.trim()) || !Array.isArray(value.manualProjects)) throw new Error("Project curation is unreadable");
    const manualProjects = value.manualProjects.map(item => {
      const row = object(item);
      if ([row.project, row.displayName, row.root].some(v => typeof v !== "string" || !v.trim()) || typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) throw new Error("Project curation is unreadable");
      return row as CurationDocument["manualProjects"][number];
    });
    return { crowned: [...new Set(value.crowned)] as string[], manualProjects };
  },
  toRows: value => [...value.crowned.map((project, order) => ({ key: `crown:${project}`, value: { project, order } })), ...value.manualProjects.map((entry, order) => ({ key: `manual:${entry.project}`, value: { entry, order } }))],
  fromRows: rows => ({
    crowned: rows.filter(r => r.key.startsWith("crown:")).map(r => r.value as { project: string; order: number }).sort((a,b) => a.order-b.order).map(r => r.project),
    manualProjects: rows.filter(r => r.key.startsWith("manual:")).map(r => r.value as { entry: CurationDocument["manualProjects"][number]; order: number }).sort((a,b) => a.order-b.order).map(r => r.entry),
  }), toFile: value => ({ schemaVersion: 1, ...value }),
});
export const PROJECT_COLLECTIONS = {
  "project-aliases.json": "project_aliases", "project-remotes.json": "project_remotes",
  "project-curation.json": "project_curation", "worktree-map.json": "worktree_map", "session-titles.json": "session_titles",
} as const;
export type ProjectStateFile = keyof typeof PROJECT_COLLECTIONS;
/** Revision and physical database identity, without reading any document rows.
 * The legacy stamp is used only until activation imports the collection. */
export function projectStoreSignature(name: ProjectStateFile, directory = stateDir()): string {
  const database = path.join(directory, "state.sqlite");
  const revision = readStateCollectionRevision(database, PROJECT_COLLECTIONS[name]);
  const file = revision === null ? path.join(directory, name) : database;
  try {
    const stat = fs.statSync(file, { bigint: true });
    return revision === null ? `${file}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}` : `${database}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${revision}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return `${file}:missing`; }
}
/** One shared, bounded decoded cache across compiled bundles. Decoders use
 * committed state only: a read inside another transaction never imports. */
export function readProjectDocument<D>(store: LegacyDocumentStore<D>, name: ProjectStateFile, directory = stateDir()): D {
  const signature = projectStoreSignature(name, directory);
  const slot = collectionReadCache<{ signature: string; document: D }>(JSON.stringify([directory, "project-document", PROJECT_COLLECTIONS[name]]));
  if (slot.value?.signature === signature) return slot.value.document;
  const document = store.readExisting(path.join(directory, name));
  rememberCollectionReadCache(slot, { signature, document }, JSON.stringify(document).length * 2);
  return document;
}
