import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { projectAliasResolver } from "./aliases";
import { readStateCollectionRevisions, readStateProjectKeys } from "@/lib/state/sqliteStateStore";

const store = globalThis as typeof globalThis & {
  __llvProjectKeySources?: Map<string, ReadonlySet<string>>;
  __llvProjectKeyDatabase?: { signature: string; projects: ReadonlySet<string> };
};

function sources(): Map<string, ReadonlySet<string>> {
  return store.__llvProjectKeySources ??= new Map();
}

export function replaceProjectKeySource(owner: string, projects: Iterable<string>): void {
  sources().set(owner, new Set(projects));
}

export function projectKeyIndexSnapshot(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const projects of sources().values()) for (const project of projects) keys.add(project);
  const filename = statePath("state.sqlite");
  const revisions = readStateCollectionRevisions(filename, ["tasks", "pipelines", "flows"]);
  let identity = "absent";
  try {
    const stat = fs.statSync(filename);
    identity = `${stat.dev}:${stat.ino}`;
  } catch { /* an uninitialized installation has no durable project rows */ }
  const signature = `${identity}:${["tasks", "pipelines", "flows"].map(key => revisions.get(key) ?? "-").join(":")}`;
  if (store.__llvProjectKeyDatabase?.signature !== signature) {
    store.__llvProjectKeyDatabase = { signature, projects: new Set(readStateProjectKeys(filename)) };
  }
  const canonical = projectAliasResolver();
  for (const project of store.__llvProjectKeyDatabase.projects) keys.add(canonical(project));
  return keys;
}

/** Canonicalize a changed batch against one alias snapshot and each distinct
 * source key once. */
export function canonicalProjectKeys(projects: Iterable<string>): ReadonlySet<string> {
  const canonical = projectAliasResolver();
  const resolved = new Map<string, string>();
  for (const project of projects) if (!resolved.has(project)) resolved.set(project, canonical(project));
  return new Set(resolved.values());
}
