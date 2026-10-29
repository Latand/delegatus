import type { RegistryFile, RegistryConversation } from "@/lib/agent/registry";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { canonicalProject } from "@/lib/projects/aliases";
import { existingTeamStore, type TeamStore } from "./store";
import { workspaceDirectory } from "./workspaces";
import { workspaceScope } from "./workspaceAccess";
import { orchestratorWorkspacePrincipalsOrUnknown } from "@/lib/orchestrator/seats";
import { TeamError } from "./members";

export type WorkspacePrincipal = NonNullable<LaunchProfile["workspace"]>;

/** Parent links are durable, including pipeline source and migration generations.
 * A missing principal means an installation-owned launch. A bound principal
 * survives revocation and project moves; those can only remove its authority. */
export function conversationWorkspacePrincipal(snapshot: RegistryFile | ((id: string) => RegistryConversation | null), id: string | null, store = existingTeamStore()): WorkspacePrincipal | null {
  const seen = new Set<string>();
  // One lazy, identity-cached seat map per resolution. Solo installations skip it;
  // persisted launch bindings still fail closed if their team store vanishes.
  let seatPrincipals: ReadonlyMap<string | null, WorkspacePrincipal | undefined> | undefined;
  const hasWorkspaces = Boolean(store?.workspaceRows().length);
  const seatPrincipal = (id: string) => {
    if (!hasWorkspaces) return undefined;
    if (!seatPrincipals) {
      const principals = orchestratorWorkspacePrincipalsOrUnknown();
      if (!principals) throw new Error("workspace seat authority is unavailable");
      seatPrincipals = principals;
    }
    return seatPrincipals.get(id);
  };
  while (id && !seen.has(id)) {
    seen.add(id);
    const conversation = typeof snapshot === "function" ? snapshot(id) : Object.hasOwn(snapshot.conversations, id) ? snapshot.conversations[id] : undefined;
    const profile = conversation?.generations.at(-1)?.launchProfile;
    const principal = profile?.workspace ?? seatPrincipal(id);
    if (principal) {
      const member = store?.member(principal.memberId);
      return member?.status === "active" && member.role === "owner" ? null : principal;
    }
    const memberId = store?.latestConversationMember(id);
    if (memberId) {
      const member = store!.member(memberId);
      if (member?.role === "owner" && member.status === "active") return null;
      const project = conversationProjectKey(conversation?.projectOwnership, profile);
      return { memberId, workspaceId: project ? workspaceDirectory(store!).workspaceOf(project) : null };
    }
    id = profile?.parentConversationId ?? null;
  }
  return null;
}

export function memberWorkspacePrincipal(store: TeamStore, memberId: string, project: string | null): WorkspacePrincipal | null {
  const member = store.member(memberId);
  if (member?.role === "owner" && member.status === "active") return null;
  return { memberId, workspaceId: project ? workspaceDirectory(store).workspaceOf(project) : null };
}

/** Server-admitted human input must never fall back to installation reach
 * when its author or current project permission cannot be established. */
export function requireMemberWorkspacePrincipal(memberId: string, project: string | null): WorkspacePrincipal | null {
  const store = existingTeamStore();
  if (!store || store.member(memberId)?.status !== "active")
    throw new TeamError("team_store_unavailable", "member authority is unavailable", 503);
  const principal = memberWorkspacePrincipal(store, memberId, project);
  if (principal && !workspacePrincipalAllows(principal, project, store))
    throw new TeamError("workspace_forbidden", "workspace access denied", 403);
  return principal;
}

export function workspacePrincipalAllows(principal: WorkspacePrincipal, project: string | null | undefined, store = existingTeamStore()): boolean {
  return workspacePrincipalAccess(principal, store)(project);
}

/** A single synchronous guard shares one live membership snapshot. */
export function workspacePrincipalAccess(principal: WorkspacePrincipal, store = existingTeamStore()): (project: string | null | undefined) => boolean {
  if (!store || !principal.workspaceId) return () => false;
  const scope = workspaceScope(store, principal.memberId);
  const projects = new Set(scope.workspaces.find(workspace => workspace.id === principal.workspaceId)?.projects ?? []);
  return project => Boolean(project && scope.canAct(project) && projects.has(canonicalProject(project)));
}
