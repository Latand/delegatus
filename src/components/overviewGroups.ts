import type { FileEntry } from "@/lib/types";
import { buildBranchGroups, type BranchGroup } from "./projectModel";

/** One cache per mounted Overview. Keep the global lineage input to the
 * existing grouper: a parent in another project can establish a segment. */
export function createOverviewGroups() {
  let previousFiles = new Map<string, FileEntry>();
  let previousNow = Number.NaN;
  let groups = new Map<string, BranchGroup[]>();
  return (files: FileEntry[], projects: readonly string[], now: number): BranchGroup[] => {
    const nextFiles = new Map(files.map(file => [file.path, file]));
    const changed = new Set<string>();
    for (const [filePath, file] of previousFiles) {
      if (nextFiles.get(filePath) !== file) changed.add(file.project || "other");
    }
    for (const file of files) {
      if (previousFiles.get(file.path) !== file
        || (file.parent && previousFiles.get(file.parent) !== nextFiles.get(file.parent))) {
        changed.add(file.project || "other");
      }
    }
    const nextGroups = new Map<string, BranchGroup[]>();
    for (const project of projects) {
      const previous = groups.get(project);
      nextGroups.set(project, previous && now === previousNow && !changed.has(project)
        ? previous : buildBranchGroups(files, project, { now }));
    }
    previousFiles = nextFiles;
    previousNow = now;
    groups = nextGroups;
    return projects.flatMap(project => groups.get(project)!);
  };
}
