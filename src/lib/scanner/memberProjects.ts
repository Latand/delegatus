import fs from "node:fs";
import path from "node:path";

import type { RootKey } from "@/lib/types";
import { describeFile } from "./describe";
import { recordedProjectAttributions, type RecordedProjectAttribution } from "./projectCatalog";
import { scanRootEntries } from "./roots";
import { probedFileCatalogMembership } from "./scanCache";

/** Transcripts one call may describe itself. Past this many the persisted
    index is too far behind the roots, and only a scan can catch it up. */
const UNRECORDED_MEMBER_LIMIT = 256;

/**
 * The project of every transcript the scanner roots hold now, without a scan:
 * the persisted index answers for the transcripts it listed, and a transcript
 * born since is described from its own head, the way a scan would describe it.
 * Null when any member's project cannot be established this way; a caller
 * then has no proof that a project is absent and waits for the catalog.
 */
export async function catalogMemberProjects(): Promise<RecordedProjectAttribution[] | null> {
  const membership = await probedFileCatalogMembership();
  if (membership === null) return null;
  let members: unknown;
  try {
    members = JSON.parse(membership);
  } catch {
    return null;
  }
  if (!Array.isArray(members)) return null;
  const recorded = recordedProjectAttributions();
  const roots = scanRootEntries();
  const projects = new Map<string, RecordedProjectAttribution>();
  let unrecorded = 0;
  for (const member of members) {
    if (typeof member !== "string") return null;
    const separator = member.indexOf(":");
    const rootName = member.slice(0, separator) as RootKey;
    const pathname = member.slice(separator + 1);
    let attribution = recorded.get(pathname);
    if (!attribution) {
      const root = roots.find(([name, candidate]) => name === rootName && pathname.startsWith(candidate + path.sep))?.[1];
      if (!root || (unrecorded += 1) > UNRECORDED_MEMBER_LIMIT) return null;
      let st: fs.Stats;
      try {
        st = fs.statSync(pathname);
      } catch (error) {
        // A transcript removed since the probe carries no project.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      const described = describeFile(rootName, root, pathname, st);
      if (!described.complete) return null;
      attribution = { project: described.description.project, projectName: described.description.projectName };
    }
    projects.set(`${attribution.project}\0${attribution.projectName ?? ""}`, attribution);
  }
  return [...projects.values()];
}
