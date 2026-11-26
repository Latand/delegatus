import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { projectAliasResolver } from "./aliases";
import { createProjectMembershipIndex, readStateCollectionRevisions, readStateProjectKeys } from "@/lib/state/sqliteStateStore";

const store = globalThis as typeof globalThis & {
  __llvProjectKeySources?: Map<string, ReadonlySet<string>>;
  __llvProjectKeyDatabase?: {
    identity: string;
    membership: ReturnType<typeof createProjectMembershipIndex>;
    hotSignature: string;
    hotProjects: ReadonlySet<string>;
    archiveSignature: string | null;
    archiveProjects: ReadonlySet<string>;
  };
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
  const hotCollections = ["tasks", "pipelines", "flows"] as const;
  const revisions = readStateCollectionRevisions(filename, [...hotCollections, "pipelines_archive"]);
  let identity = "absent";
  try {
    const stat = fs.statSync(filename);
    identity = `${stat.dev}:${stat.ino}`;
  } catch { /* an uninitialized installation has no durable project rows */ }
  let cached = store.__llvProjectKeyDatabase;
  if (cached?.identity !== identity || !cached.membership) {
    cached?.membership?.dispose();
    cached = store.__llvProjectKeyDatabase = {
      identity,
      membership: createProjectMembershipIndex(filename),
      hotSignature: "",
      hotProjects: new Set(),
      archiveSignature: null,
      archiveProjects: new Set(),
    };
  }
  const hotSignature = hotCollections.map(key => revisions.get(key) ?? "-").join(":");
  if (cached.hotSignature !== hotSignature) {
    cached.hotProjects = new Set(readStateProjectKeys(filename, hotCollections, cached.membership));
    cached.hotSignature = hotSignature;
  }
  const archiveSignature = String(revisions.get("pipelines_archive") ?? "-");
  if (cached.archiveSignature !== archiveSignature) {
    cached.archiveProjects = new Set(readStateProjectKeys(filename, ["pipelines_archive"], cached.membership));
    cached.archiveSignature = archiveSignature;
  }
  const canonical = projectAliasResolver();
  for (const project of cached.hotProjects) keys.add(canonical(project));
  for (const project of cached.archiveProjects) keys.add(canonical(project));
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
