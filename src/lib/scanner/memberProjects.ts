import fs from "node:fs";
import path from "node:path";

import { forEachCooperatively } from "@/lib/cooperative";
import type { RootKey } from "@/lib/types";
import type { RawEntry } from "./discover";
import { currentProjectAttributions, type RecordedProjectAttribution } from "./projectCatalog";
import { scanRootEntries } from "./roots";
import { probedFileCatalogMembership } from "./scanCache";

/** Transcripts one call may describe itself. Past this many the persisted
    index is too far behind the roots, and only a scan can catch it up. */
const DESCRIBED_MEMBER_LIMIT = 256;

/**
 * The project of every transcript the scanner roots hold now, without a scan:
 * the persisted index answers for a transcript it listed, under the checks a
 * scan applies before reusing its record, and a transcript born or changed
 * since is described from its own head, the way a scan would describe it.
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
  const roots = scanRootEntries();
  const entries: RawEntry[] = [];
  let listed = true;
  await forEachCooperatively(members, (member) => {
    if (!listed) return;
    const separator = typeof member === "string" ? member.indexOf(":") : -1;
    if (separator < 0) {
      listed = false;
      return;
    }
    const rootName = member.slice(0, separator) as RootKey;
    const pathname = member.slice(separator + 1);
    const root = roots.find(([name, candidate]) => name === rootName && pathname.startsWith(candidate + path.sep))?.[1];
    if (!root) {
      listed = false;
      return;
    }
    try {
      entries.push({ rootName, root, path: pathname, st: fs.statSync(pathname) });
    } catch (error) {
      // A transcript removed since the probe carries no project.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") listed = false;
    }
  });
  return listed ? currentProjectAttributions(entries, DESCRIBED_MEMBER_LIMIT) : null;
}
