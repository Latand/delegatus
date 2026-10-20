import { projectCurationStore, readProjectDocument } from "./persistence";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { boundedTarget } from "@/lib/projects/directorySuggestions";
import {
  projectIdentityFromDirectory,
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
} from "@/lib/projects/identity";

/** A project the operator registered by hand, before any session exists in it. */
export interface ManualProject {
  project: string;
  displayName: string;
  /** Absolute directory the project was created from; offered as the spawn cwd. */
  root: string;
  /** Unix seconds; drives catalog recency until real sessions take over. */
  createdAt: number;
}

export interface ProjectCurationSnapshot {
  /** Projects the operator crowned; they pin to the top of the rail. */
  crowned: string[];
  manualProjects: ManualProject[];
}

export type CreateProjectFailure =
  | "INVALID_NAME"
  | "INVALID_ROOT"
  /** The root is not an absolute path — a directory name that was never
      finished into one. Told apart from a path that is absolute and absent,
      which is a different objection with a different answer (issue #1223). */
  | "RELATIVE_ROOT"
  /** The root lies outside the directories the viewer knows about, which are
      the same ones it may suggest from (issue #1223). */
  | "OUTSIDE_ROOTS"
  /** The root is a plausible absolute path whose directory does not exist yet —
      the one refusal the client can turn into a "create directory" offer. */
  | "MISSING_DIRECTORY"
  | "MKDIR_FAILED"
  | "DUPLICATE_PROJECT"
  | "STORE_ERROR";

export interface CreateProjectOptions {
  /** Create the missing root directory (recursive mkdir) instead of refusing
      with MISSING_DIRECTORY. Relative paths and file paths still refuse. */
  createMissingRoot?: boolean;
  /** Bound the creation to these directories — the one root list the
      suggestions come from (`suggestionRoots`). Omitted, the root is unbounded;
      the route always passes them, so what can be created is exactly what can
      be offered (issue #1223). */
  allowedRoots?: readonly string[];
}

export type CreateProjectResult =
  | { ok: true; entry: ManualProject }
  | { ok: false; code: CreateProjectFailure; message: string };

function curationFile(): string { return statePath("project-curation.json"); }
function readSnapshot(): ProjectCurationSnapshot { return readProjectDocument(projectCurationStore, "project-curation.json"); }

export function projectCurationSnapshot(): ProjectCurationSnapshot {
  const snapshot = readSnapshot();
  return {
    crowned: [...snapshot.crowned],
    manualProjects: snapshot.manualProjects.map((entry) => ({ ...entry })),
  };
}

/** Crown or uncrown one project in a serialized transaction. */
export function setProjectCrown(project: string, crowned: boolean): boolean {
  const key = project.trim();
  if (!key) return false;
  try {
    return projectCurationStore.patchRows(curationFile(), 2, tx => {
      const rowKey = `crown:${key}`;
      const held = tx.get(rowKey);
      if (Boolean(held) === crowned) return true;
      if (crowned) tx.put({ key: rowKey, value: { project: key, order: Date.now() } }); else tx.delete(rowKey);
      return true;
    });
  } catch { return false; }
}

/**
 * Register an operator-named project rooted at a directory. The identity is
 * minted exactly the way the scanner mints it for sessions running in that
 * directory (repository identity when the root is inside a git checkout,
 * directory identity otherwise), so later spawns group into this same project
 * with no extra mapping. `existingProjects` carries the canonical ids already
 * visible in the catalog; a duplicate identity is refused, never forked.
 */
export function createManualProject(
  name: string,
  root: string,
  existingProjects: ReadonlySet<string> = new Set(),
  options: CreateProjectOptions = {},
): CreateProjectResult {
  const displayName = name.trim();
  if (!displayName || displayName.length > 80) {
    return { ok: false, code: "INVALID_NAME", message: "project name must be 1-80 characters" };
  }
  const requested = root.trim();
  if (!requested) {
    return { ok: false, code: "INVALID_ROOT", message: "root must be a directory path" };
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, code: "RELATIVE_ROOT", message: "root must be an absolute directory path" };
  }
  /* One resolution, before anything is created, and it is what gets created:
     `boundedTarget` follows the path's links the way the kernel will and
     answers null when what it lands on is outside the roots. Everything below
     works on that answer, so no lexically normalized string is ever checked in
     place of the path `mkdirSync` receives (issue #1223). */
  const resolved = boundedTarget(requested, options.allowedRoots);
  if (!resolved) {
    return { ok: false, code: "OUTSIDE_ROOTS", message: "root is outside the known project directories" };
  }
  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(resolved);
  } catch {
    if (!options.createMissingRoot) {
      return { ok: false, code: "MISSING_DIRECTORY", message: "directory does not exist" };
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "MKDIR_FAILED", message: detail };
    }
  }
  if (stats && !stats.isDirectory()) {
    return { ok: false, code: "INVALID_ROOT", message: "path does not point at a directory" };
  }
  const repositoryRoot = repositoryRootForPath(resolved);
  const identity = (repositoryRoot ? projectIdentityFromRepositoryRoot(repositoryRoot) : null)
    ?? projectIdentityFromDirectory(resolved);
  if (!identity) {
    return { ok: false, code: "INVALID_ROOT", message: "directory does not resolve to a project identity" };
  }
  const entry: ManualProject = { project: identity.project, displayName, root: repositoryRoot ?? resolved, createdAt: Math.floor(Date.now() / 1000) };
  try {
    return projectCurationStore.patchRows<CreateProjectResult>(curationFile(), 2, tx => {
      const rowKey = `manual:${identity.project}`;
      if (existingProjects.has(identity.project) || tx.get(rowKey)) return { ok: false, code: "DUPLICATE_PROJECT", message: "a project with this identity already exists" };
      tx.put({ key: rowKey, value: { entry, order: Date.now() } });
      return { ok: true, entry };
    });
  } catch { return { ok: false, code: "STORE_ERROR", message: "could not persist the project" }; }
}

export function resetProjectCurationForTests(): void {
  // Revision-keyed shared cache requires no local reset.
}
