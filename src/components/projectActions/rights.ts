import type { MessageKey, TFunction } from "@/lib/i18n";
import type { Workspace } from "@/lib/team/contract";

import type { TeamWorkspaces } from "../team/workspaceFilter";

/*
 * What a person may do from a project row's menu
 * (docs/design/project-rail-context-menu/README.md, variant 2). The server
 * decides each write again; this only says which rows open and why a closed
 * one is closed, from the same rules:
 *   - rename and archive go through PUT /api/projects/settings, which admits the
 *     owner or a manager of the project (`workspaceRoute`'s managerWrite);
 *   - move is `placeProject`: the owner, or a manager of the workspace it leaves
 *     and of the one it goes to;
 *   - delete is a project write: the owner or someone in its workspace;
 *   - the crown is open to everyone.
 * Without workspaces (a solo install, or a team with none yet) everything is
 * open and there is no move.
 */

export type ProjectActionResult = { ok: true } | { ok: false; code: string | null };

/** The writes the Viewer owns; the menu calls them and shows what they answer. */
export interface ProjectRowActions {
  /** A display name, or null for the folder's name again. */
  rename: (project: string, name: string | null) => Promise<ProjectActionResult>;
  archive: (project: string) => Promise<ProjectActionResult>;
  unarchive: (project: string) => Promise<ProjectActionResult>;
}

export interface ProjectRights {
  rename: boolean;
  archive: boolean;
  delete: boolean;
  /** Null when there is nowhere to move to: no workspaces. */
  move: boolean | null;
  /** Where the project may go: workspace ids, and null for Unassigned. */
  targets: (string | null)[];
  /** The workspace it stands in now, or null for Unassigned. */
  current: string | null;
}

export function projectRights(view: TeamWorkspaces | null | undefined, project: string): ProjectRights {
  if (!view) return { rename: true, archive: true, delete: true, move: null, targets: [], current: null };
  const current = view.workspaces.find((workspace) => workspace.projects.includes(project))?.id ?? null;
  const every = [...view.workspaces.map((workspace) => workspace.id as string | null), null];
  if (view.canManage) return { rename: true, archive: true, delete: true, move: true, targets: every, current };
  const managed = new Set(view.managedWorkspaceIds ?? []);
  /* A manager manages Unassigned projects too (workspaceAccess: "manager" on an unplaced known project). */
  const manages = current ? managed.has(current) : managed.size > 0;
  /* The member's own workspaces are the ones the server lists to them. */
  const inside = current !== null && view.workspaces.some((workspace) => workspace.id === current);
  const movable = managed.size > 0 && (current === null || managed.has(current));
  const targets = movable ? every.filter((id) => (id === null ? current !== null : managed.has(id))) : [];
  return { rename: manages, archive: manages, delete: inside, move: movable && targets.some((id) => id !== current), targets, current };
}

export function workspaceName(t: TFunction, workspaces: readonly Workspace[], id: string | null): string {
  return id ? workspaces.find((workspace) => workspace.id === id)?.name ?? t("workspaces.unassigned") : t("workspaces.unassigned");
}

/** The words for a refusal, in the place the action was taken. */
export function refusalText(t: TFunction, code: string | null, denied: MessageKey): string {
  if (code === "PROJECT_ACTIVE") return t("rail.row.working");
  if (code && /denied|forbidden|owner_required|operator_only/.test(code)) return t(denied);
  return t("rail.row.failed");
}

/** A path broken only after its slashes, so a folder name is never split. */
export function pathParts(path: string): string[] {
  return path.split(/(?<=\/)/);
}
