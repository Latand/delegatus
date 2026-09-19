import fs from "node:fs";

import { migrateBoardProjects } from "@/lib/board/store";
import { appendLifecycleEvents } from "@/lib/lifecycle/journal";
import { canonicalProject, persistProjectAliases, projectAliasesCanAccept } from "@/lib/projects/aliases";
import {
  directoryProjectId,
  isCanonicalProjectId,
  localRepositoryProjectId,
  projectIdentityFromDirectory,
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
} from "@/lib/projects/identity";
import { projectRootForCwd } from "@/lib/scanner/describe";

/**
 * A folder's project identity moved (#1874).
 *
 * The identity of a checkout is derived from what is on disk at the moment it
 * is asked: a plain folder is `dir-<path>`, a repository with no `origin` is
 * `repo-<local path>`, and the same repository once an `origin` is added is
 * `repo-<remote>`. A project first used before `git init`, or before its
 * remote was added, therefore holds one key for everything written early (the
 * orchestrator seat, its tasks and conversations) and another for everything
 * written after (every pipeline), and nothing joined the two.
 *
 * A succession is that move, recorded once as an alias in the one map
 * `canonicalProject` reads, so every store that resolves through it — the seat
 * store, tasks, the board, account bindings, attention, the scanner's grouping
 * — reads the old key as the new one from then on.
 *
 * Only a PATH-DERIVED source is ever moved: a `dir-` id or a local-repository
 * id, verified against the folder itself, so the old key provably named this
 * folder and no other. A remote identity that changes (an `origin` renamed or
 * re-pointed) is not a succession: a remote names a repository every clone of
 * it shares, and aliasing it would fold other checkouts into this one.
 */
export interface ProjectSuccession {
  source: string;
  target: string;
  displayName: string;
}

function isDirectory(candidate: string): boolean {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function realFolder(folder: string): string {
  try { return fs.realpathSync.native(folder); } catch { return folder; }
}

/** Whether `project` is an identity this folder itself minted at some point:
    its directory id, or the local id of the repository it sits in. */
function namesFolder(project: string, folder: string): boolean {
  if (project.startsWith("dir-")) return project === directoryProjectId(folder);
  if (!project.startsWith("repo-")) return false;
  const roots = new Set([repositoryRootForPath(folder), projectRootForCwd(folder)].filter((root): root is string => Boolean(root)));
  return [...roots].some((root) => localRepositoryProjectId(root) === project);
}

/** The identity the folder resolves to NOW, read from disk rather than from any
    cache: a worktree resolves to its parent repository, a folder with no
    repository to itself. */
function currentIdentity(folder: string): { project: string; displayName: string } | null {
  const root = projectRootForCwd(folder);
  const repository = root ? projectIdentityFromRepositoryRoot(root) : null;
  if (repository) return { project: repository.project, displayName: repository.displayName };
  return projectIdentityFromDirectory(folder);
}

/**
 * The succession a project's key owes, judged from one folder it was used in,
 * or null when it owes none: the key is not path-derived from that folder, the
 * folder is gone, or it still resolves to the key (or already to its alias).
 */
export function projectSuccessionFor(project: string, folder: string | null | undefined): ProjectSuccession | null {
  const key = project.trim();
  if (!isCanonicalProjectId(key) || !folder?.trim() || !isDirectory(folder.trim())) return null;
  const real = realFolder(folder.trim());
  const current = currentIdentity(real);
  if (!current || !isCanonicalProjectId(current.project)) return null;
  /* A chain (dir- → local repo- → remote repo-) moves from the newest link that
     still names this folder, which is what the alias map can accept. */
  const aliased = canonicalProject(key);
  const source = aliased !== key && namesFolder(aliased, real) ? aliased : key;
  if (!namesFolder(source, real)) return null;
  if (source === current.project || canonicalProject(source) === current.project) return null;
  return { source, target: current.project, displayName: current.displayName };
}

/**
 * Record successions, once each. Each one moves the board layout, publishes the
 * alias, and writes one line into the target project's lifecycle history; a
 * succession the alias map refuses (its source is already held by another
 * identity) is skipped whole. Returns the successions recorded by this call —
 * a replay records nothing, which is what makes detection safe to run at every
 * boot and scan.
 */
export function recordProjectSuccessions(candidates: Iterable<ProjectSuccession | null>): ProjectSuccession[] {
  const recorded: ProjectSuccession[] = [];
  const seen = new Set<string>();
  for (const succession of candidates) {
    if (!succession || seen.has(succession.source)) continue;
    seen.add(succession.source);
    if (canonicalProject(succession.source) === succession.target) continue;
    if (!projectAliasesCanAccept([succession])) continue;
    if (!migrateBoardProjects(new Map([[succession.source, succession.target]]))) continue;
    if (!persistProjectAliases([succession])) continue;
    recorded.push(succession);
    try {
      appendLifecycleEvents([{
        key: `project-succession:${succession.source}:${succession.target}`,
        type: "project_moved",
        at: new Date().toISOString(),
        project: succession.target,
        summary: `${succession.displayName}: project identity moved from ${succession.source} to ${succession.target}; everything recorded under the old key now reads as this project`,
      }]);
    } catch {
      /* The alias is the succession; the history line is its record, and a
         journal that cannot be written must not undo or repeat the move. */
    }
  }
  return recorded;
}
