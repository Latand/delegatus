import type { RegistryFile, RegistryConversation } from "@/lib/agent/registry";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { canonicalProject } from "@/lib/projects/aliases";
import { existingTeamStore, type TeamStore } from "./store";
import { workspaceDirectory } from "./workspaces";
import { workspaceScope } from "./workspaceAccess";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";

export type WorkspacePrincipal = NonNullable<LaunchProfile["workspace"]>;

/** Parent links are durable, including pipeline source and migration generations.
 * A missing principal means an installation-owned launch. A bound principal
 * survives revocation and project moves; those can only remove its authority. */
export function conversationWorkspacePrincipal(snapshot: RegistryFile | ((id: string) => RegistryConversation | null), id: string | null, store = existingTeamStore()): WorkspacePrincipal | null {
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const conversation = typeof snapshot === "function" ? snapshot(id) : Object.hasOwn(snapshot.conversations, id) ? snapshot.conversations[id] : undefined;
    const profile = conversation?.generations.at(-1)?.launchProfile;
    const principal = profile?.workspace ?? activeOrchestratorSeats().find(seat => seat.conversationId === id)?.workspace;
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
