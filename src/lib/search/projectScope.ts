import os from "node:os";
import { canonicalProject, projectAliasSnapshot, recordedProjectRemotes } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";

export interface ProjectScope {
  requested: string;
  resolved: string | null;
  note?: string;
}

/** Resolution reads the same identities as the scanner, restricted to indexed keys. */
export function resolveProjectScope(requested: string, indexed: ReadonlySet<string>): ProjectScope {
  const known = new Map<string, string>();
  for (const key of indexed) {
    const canonical = canonicalProject(key);
    if (key === canonical || !known.has(canonical)) known.set(canonical, key);
  }
  let resolved = known.get(canonicalProject(requested));
  if (!resolved && /^(?:\/|~\/|[A-Za-z]:[\\/])/u.test(requested)) {
    const key = projectForCwd(requested.replace(/^~(?=\/)/u, os.homedir()));
    if (key) resolved = known.get(canonicalProject(key));
  }
  if (!resolved) {
    const normalize = (value: string) => value.toLowerCase().replace(/[._/\\-]+/gu, "-").replace(/^-|-$/gu, "");
    const wanted = normalize(requested);
    const matches = new Set<string>();
    let specificity = 0;
    const names: Array<[string, string]> = Object.entries(projectAliasSnapshot().displayNames);
    for (const [key, remote] of Object.entries(recordedProjectRemotes())) {
      const parts = remote.replace(/\.git$/u, "").split("/");
      names.push([key, parts.at(-1) ?? ""], [key, parts.slice(-2).join("/")]);
    }
    for (const [key, name] of names) {
      const candidate = normalize(name);
      const indexedKey = known.get(canonicalProject(key));
      if (indexedKey && candidate && (wanted === candidate || wanted.endsWith(`-${candidate}`))) {
        if (candidate.length > specificity) { matches.clear(); specificity = candidate.length; }
        if (candidate.length === specificity) matches.add(indexedKey);
      }
    }
    if (matches.size === 1) resolved = [...matches][0];
  }
  return resolved ? { requested, resolved } : {
    requested, resolved: null, note: "names no unique indexed project; searched every project",
  };
}
