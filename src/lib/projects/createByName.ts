import fs from "node:fs";
import path from "node:path";

import { cleanWorkspaceName, workspaceNameKey } from "@/lib/team/contract";

import { createManualProject, projectDisplayNameFrom, type CreateProjectResult } from "./curation";
import { boundedTarget } from "./directorySuggestions";
import { folderName } from "./folderName";
import { directoryProjectId, repositoryRootForPath } from "./identity";

/** The last collision suffix tried: `pr-gram`, `pr-gram-2`, … `pr-gram-99`. */
const LAST_FOLDER_SUFFIX = 99;

/** A project the caller may be told about; never one outside their scope. */
export interface VisibleProject {
  project: string;
  displayName: string;
  root: string | null;
}

export interface CreateByNameOptions {
  /** `defaultProjectsParent()`; it may not exist yet. */
  parent: string;
  /** `suggestionRoots()`, the one list that bounds every creation. */
  allowedRoots: readonly string[];
  /** Keys taken on this machine, whoever may see them. A taken key costs a
      suffix and says nothing, so a member learns nothing outside their scope. */
  existing: ReadonlySet<string>;
  visible: readonly VisibleProject[];
  /** The alias map of this request: a folder whose key already resolves to
      another project would join that project instead of starting a new one. */
  resolve?: (project: string) => string;
}

export type CreateByNameResult =
  | CreateProjectResult
  | { ok: false; code: "DUPLICATE_NAME"; message: string; project: string; displayName: string; root: string | null }
  | { ok: false; code: "NO_FREE_FOLDER"; message: string }
  | { ok: false; code: "PARENT_IN_REPOSITORY"; message: string; parent: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes a project from a name alone: a new folder under the default parent,
 * bound through `createManualProject`.
 *
 * The exclusive `mkdir` is the claim: it answers EEXIST for a directory, a file
 * or a symlink, dangling ones included, without following it. So concurrent
 * creates cannot share a folder, and nothing existing is ever reused. The only
 * thing ever removed is the empty folder this call made, non-recursively, when
 * it could not be bound. Everything here is synchronous: no other request of this
 * process can land between reading `visible` and the store write.
 */
export function createProjectByName(name: string, options: CreateByNameOptions): CreateByNameResult {
  const displayName = projectDisplayNameFrom(name);
  const cleaned = cleanWorkspaceName(displayName);
  const nameKey = cleaned ? workspaceNameKey(cleaned) : "";
  if (!displayName || !nameKey) {
    return { ok: false, code: "INVALID_NAME", message: "project name must be 1-80 characters" };
  }
  const twin = options.visible.find((row) => {
    const label = cleanWorkspaceName(row.displayName);
    return label !== null && workspaceNameKey(label) === nameKey;
  });
  if (twin) {
    return { ok: false, code: "DUPLICATE_NAME", message: "a project with this name exists", project: twin.project, displayName: twin.displayName, root: twin.root };
  }

  /* Resolved once, so a symlinked parent lands where the bound measured it. */
  const parent = boundedTarget(options.parent, options.allowedRoots);
  if (!parent) {
    return { ok: false, code: "OUTSIDE_ROOTS", message: "the projects folder is outside the known project directories" };
  }
  /* Before the parent is made, so a refusal leaves nothing behind. Inside a
     checkout the new folder would take the enclosing repository's identity. */
  if (repositoryRootForPath(parent)) {
    return { ok: false, code: "PARENT_IN_REPOSITORY", message: "the projects folder is inside a Git repository", parent };
  }
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (error) {
    return { ok: false, code: "MKDIR_FAILED", message: errorDetail(error) };
  }

  const slug = folderName(displayName);
  const resolve = options.resolve ?? ((project: string) => project);
  for (let suffix = 1; suffix <= LAST_FOLDER_SUFFIX; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? slug : `${slug}-${suffix}`);
    /* A folder deleted long ago leaves its key behind in the catalog, a placement
       or an alias; minting that key again would inherit what it still holds. */
    const key = directoryProjectId(candidate);
    if (options.existing.has(key) || resolve(key) !== key) continue;
    try {
      fs.mkdirSync(candidate);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      return { ok: false, code: "MKDIR_FAILED", message: errorDetail(error) };
    }
    const created = createManualProject(displayName, candidate, options.existing, { allowedRoots: options.allowedRoots });
    if (created.ok) return created;
    try { fs.rmdirSync(candidate); } catch { /* A peer wrote into it, so it is no longer ours to remove. */ }
    if (created.code !== "DUPLICATE_PROJECT") return created;
  }
  return { ok: false, code: "NO_FREE_FOLDER", message: "every folder name for this project is taken" };
}
