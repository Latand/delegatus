import type { Member, TeamActor } from "./contract";
import { TeamError } from "./members";
import { existingTeamStore, type TeamStore } from "./store";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { knownWorkspaceProjects, workspaceDirectory } from "./workspaces";

export type WorkspaceAccess = "owner" | "manager" | "member" | "none";

/** One request owns this snapshot; membership is never cached across requests. */
export function workspaceScope(store: TeamStore, memberId: string) {
  const member = store.member(memberId);
  const resolve = projectAliasResolver();
  const directory = workspaceDirectory(store, { resolve });
  const known = knownWorkspaceProjects({ resolve });
  const roles = new Map(store.workspaceMemberships(memberId).filter(row => directory.workspaces.some(workspace => workspace.id === row.workspaceId)).map(row => [row.workspaceId, row.role]));
  const active = member?.status === "active";
  const owner = active && member.role === "owner";
  const manager = active && [...roles.values()].includes("manager");
  const assigned = new Set(directory.workspaces.flatMap(workspace => workspace.projects));
  const allowed = new Set(directory.workspaces.filter(workspace => roles.has(workspace.id)).flatMap(workspace => workspace.projects));
  if (manager) for (const project of known) if (!assigned.has(project)) allowed.add(project);
  return {
    memberId,
    owner,
    manager,
    projectFilter: {
      allowed: [...allowed].sort(),
    },
    workspaces: directory.workspaces.filter(workspace => owner || (active && roles.has(workspace.id))),
    role(workspaceId: string): WorkspaceAccess {
      if (!active || !directory.workspaces.some(workspace => workspace.id === workspaceId)) return "none";
      return owner ? "owner" : roles.get(workspaceId) ?? "none";
    },
    canAct(project: string | null | undefined): boolean {
      if (!active) return false;
      if (owner) return true;
      const workspaceId = project ? directory.workspaceOf(project) : null;
      return Boolean(workspaceId && roles.has(workspaceId));
    },
    canReadFile(project: string | null | undefined): boolean {
      return Boolean(active && (owner || (project && known.has(resolve(project)) && allowed.has(resolve(project)))));
    },
    access(project: string | null | undefined): WorkspaceAccess {
      if (!active) return "none";
      if (owner) return "owner";
      if (!project || project === "project_unresolved") return "none";
      const workspaceId = directory.workspaceOf(project);
      return workspaceId ? roles.get(workspaceId) ?? "none" : manager && known.has(resolve(project)) ? "manager" : "none";
    },
  };
}

export function workspaceAccess(actor: TeamActor, project: string | null | undefined): WorkspaceAccess {
  if (actor.kind === "operator") return "owner";
  if (actor.kind !== "member") return "none";
  const store = existingTeamStore();
  return store ? workspaceScope(store, actor.memberId).access(project) : "none";
}

export function requireWorkspaceManager(store: TeamStore, actor: Member, workspaceId: unknown): string {
  if (typeof workspaceId !== "string") throw new TeamError("workspace_required", "choose a workspace", 400);
  const role = workspaceScope(store, actor.id).role(workspaceId);
  if (role !== "owner" && role !== "manager") throw new TeamError("workspace_forbidden", "workspace access denied", 403);
  return workspaceId;
}

/** Invites are checked again at redemption: a removed manager cannot enroll people. */
export function inviteWorkspace(store: TeamStore, actor: Member, workspaceId: unknown): string | null {
  if (workspaceId !== undefined && workspaceId !== null) return requireWorkspaceManager(store, actor, workspaceId);
  if (store.member(actor.id)?.status !== "active" || store.member(actor.id)?.role !== "owner") throw new TeamError("owner_required", "only the owner can invite without a workspace", 403);
  return null;
}

export interface WorkspaceProjectFilter {
  allowed: readonly string[];
}

export function projectInWorkspaceFilter(filter: WorkspaceProjectFilter, project: string | null): boolean {
  return Boolean(project && project !== "project_unresolved" && filter.allowed.includes(project));
}
