import { OVERVIEW } from "@/components/projectModel";
import type { MemberColor, Workspace, WorkspacesView } from "@/lib/team/contract";

/*
 * The workspace filter (docs/design/workspaces.md §13.4), pure: what the
 * current choice shows, where a project belongs, how a link moves the choice,
 * and the sections of the All view. Nothing here hides anything from the
 * server's answers; the rail, the phone's project sheet and the Overview draw
 * fewer rows, and that is all a workspace does in slice (a).
 */

export type TeamWorkspaces = WorkspacesView & { mode: "team" };

/** `"all"`, or a workspace id. */
export type CurrentWorkspace = string;
export const ALL_WORKSPACES = "all";

function index(view: TeamWorkspaces): Map<string, string> {
  const placed = new Map<string, string>();
  for (const workspace of view.workspaces) for (const project of workspace.projects) placed.set(project, workspace.id);
  return placed;
}

/** The stored choice as it applies: an id that no longer exists, or any
    choice while there is no workspace, reads as All. */
export function effectiveWorkspace(view: TeamWorkspaces | null, stored: string | null): CurrentWorkspace {
  if (!view || !stored || stored === ALL_WORKSPACES) return ALL_WORKSPACES;
  return view.workspaces.some((workspace) => workspace.id === stored) ? stored : ALL_WORKSPACES;
}

export function workspaceOf(view: TeamWorkspaces | null, project: string): string | null {
  if (!view) return null;
  return view.workspaces.find((workspace) => workspace.projects.includes(project))?.id ?? null;
}

/** The projects the choice shows; null means All, which shows everything. */
export function workspaceScope(view: TeamWorkspaces | null, current: CurrentWorkspace): ReadonlySet<string> | null {
  const id = effectiveWorkspace(view, current);
  if (id === ALL_WORKSPACES) return null;
  return new Set(view!.workspaces.find((workspace) => workspace.id === id)!.projects);
}

/** The choice once `selected` is the project on screen: a project outside the
    chosen workspace (a link, a search result, a notification) moves the choice
    to its workspace, or to All when it is Unassigned, so the selected row is
    always in the rail. The Overview moves nothing. */
export function followSelection(view: TeamWorkspaces | null, current: CurrentWorkspace, selected: string): CurrentWorkspace {
  const id = effectiveWorkspace(view, current);
  if (id === ALL_WORKSPACES || selected === OVERVIEW || !selected) return id;
  return workspaceOf(view, selected) ?? ALL_WORKSPACES;
}

export interface WorkspaceSection<T> {
  /** Null for the Unassigned section. */
  workspace: Workspace | null;
  rows: T[];
}

/** The All view's sections, in order: one per workspace as the API sorts
    them (an empty one kept, with no rows), then Unassigned. Rows keep the
    order they came in. */
export function groupAll<T extends { project: string }>(rows: readonly T[], view: TeamWorkspaces): WorkspaceSection<T>[] {
  const placed = index(view);
  const sections = new Map<string | null, T[]>(view.workspaces.map((workspace) => [workspace.id, []]));
  sections.set(null, []);
  for (const row of rows) sections.get(placed.get(row.project) ?? null)!.push(row);
  return [
    ...view.workspaces.map((workspace) => ({ workspace, rows: sections.get(workspace.id)! })),
    { workspace: null, rows: sections.get(null)! },
  ];
}

/* ---- the optimistic writes' local results (§13.4) --------------------------- */

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function sorted(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

function withoutProjects(workspace: Workspace, projects: ReadonlySet<string>): Workspace {
  return workspace.projects.some((project) => projects.has(project))
    ? { ...workspace, projects: workspace.projects.filter((project) => !projects.has(project)) }
    : workspace;
}

export function placedLocally(view: TeamWorkspaces, project: string, workspaceId: string | null): TeamWorkspaces {
  const moved = new Set([project]);
  return {
    ...view,
    workspaces: view.workspaces.map((workspace) => {
      const without = withoutProjects(workspace, moved);
      return workspace.id === workspaceId ? { ...without, projects: [...without.projects, project].sort() } : without;
    }),
  };
}

export function createdLocally(view: TeamWorkspaces, input: { id: string; name: string; color: MemberColor; projects: readonly string[]; createdAt: string }): TeamWorkspaces {
  const moved = new Set(input.projects);
  return {
    ...view,
    workspaces: sorted([
      ...view.workspaces.map((workspace) => withoutProjects(workspace, moved)),
      { id: input.id, name: input.name, color: input.color, createdAt: input.createdAt, projects: [...moved].sort() },
    ]),
  };
}

export function updatedLocally(view: TeamWorkspaces, id: string, patch: { name?: string; color?: MemberColor }): TeamWorkspaces {
  return { ...view, workspaces: sorted(view.workspaces.map((workspace) => (workspace.id === id ? { ...workspace, ...patch } : workspace))) };
}

export function deletedLocally(view: TeamWorkspaces, id: string): TeamWorkspaces {
  return { ...view, workspaces: view.workspaces.filter((workspace) => workspace.id !== id) };
}
