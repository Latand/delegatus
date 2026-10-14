import os from "node:os";
import { namedProjectDirectory, resolveNamedProject, ProjectNameRefusal, type NamedProjectSources } from "@/lib/projects/nameResolution";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";
import { lastScannedFiles, lastScannedProjectCatalog } from "@/lib/scanner/scanCache";

export interface ProjectScope {
  requested: string;
  resolved: string | null;
  note?: string;
  code?: "ambiguous_project";
  candidates?: Array<{ project: string; name: string }>;
}

/** Resolution reads the same identities as the scanner, restricted to indexed keys. */
export function resolveProjectScope(requested: string, indexed: ReadonlySet<string>, sources?: NamedProjectSources): ProjectScope {
  const known = new Map<string, string>();
  for (const key of indexed) {
    const canonical = canonicalProject(key);
    if (key === canonical || !known.has(canonical)) known.set(canonical, key);
  }
  const retained = sources ?? {
    lastCompletedCatalog: () => {
      const projectCatalog = lastScannedProjectCatalog();
      const files = lastScannedFiles();
      return projectCatalog && files ? { projectCatalog, files } : null;
    },
  };
  const directory = namedProjectDirectory(retained, [...indexed]);
  directory.names = new Map([...directory.names].flatMap(([name, keys]) => {
    const selected = new Set([...keys].filter(key => known.has(key)));
    return selected.size ? [[name, selected] as const] : [];
  }));
  directory.identities = new Map([...directory.identities].flatMap(([name, keys]) => {
    const selected = new Set([...keys].filter(key => known.has(key)));
    return selected.size ? [[name, selected] as const] : [];
  }));
  directory.encodedDirectories = new Map([...directory.encodedDirectories].flatMap(([name, keys]) => {
    const selected = new Set([...keys].filter(key => known.has(key)));
    return selected.size ? [[name, selected] as const] : [];
  }));
  let resolved: string | undefined;
  try { resolved = known.get(resolveNamedProject(requested, directory)); }
  catch (error) {
    if (!(error instanceof ProjectNameRefusal)) throw error;
    if (error.details.code === "ambiguous_project") {
      const candidates = (error.details.candidateNames as Array<{ project: string; name: string }>).filter(row => known.has(row.project));
      return { requested, resolved: null, code: "ambiguous_project", candidates, note: "ambiguous project name; choose one of the listed projects" };
    }
  }
  if (!resolved && /^(?:\/|~\/|[A-Za-z]:[\\/])/u.test(requested)) {
    const key = projectForCwd(requested.replace(/^~(?=\/)/u, os.homedir()));
    if (key) resolved = known.get(canonicalProject(key));
  }
  return resolved ? { requested, resolved } : {
    requested, resolved: null, note: "names no unique indexed project; searched every project",
  };
}
