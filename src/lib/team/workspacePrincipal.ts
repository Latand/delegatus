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

/** Where a conversation's reach comes from. `fromMessage` is true when the
 * latest person to write decided it (theirs, or inherited through a rotation)
 * and false when a launch or a designation bound it. */
export interface WorkspaceReach {
  principal: WorkspacePrincipal | null;
  fromMessage: boolean;
}

/** Parent links are durable, including pipeline source and migration generations.
 * A missing principal means an installation-owned launch. A bound principal
 * survives revocation and project moves; those can only remove its authority. */
export function conversationWorkspacePrincipal(snapshot: RegistryFile | ((id: string) => RegistryConversation | null), id: string | null, store = existingTeamStore()): WorkspacePrincipal | null {
  return conversationWorkspaceReach(snapshot, id, store).principal;
}

/**
 * A project's seat states its own reach, so resolution ends at it:
 * - a seat designated for a member keeps that binding whoever writes later;
 * - a seat that inherited a member's message through a rotation
 *   (`workspaceFromMessage`) is fenced until a person writes to it, and then
 *   that person decides, as on any conversation a member wrote to;
 * - a seat with no binding answers to the latest person who wrote to it.
 * Its parent link is the handover to the seat it replaced and carries no
 * authority: whoever designated the successor already decided that.
 */
export function conversationWorkspaceReach(snapshot: RegistryFile | ((id: string) => RegistryConversation | null), id: string | null, store = existingTeamStore()): WorkspaceReach {
  const seen = new Set<string>();
  // One lazy, identity-cached seat map per resolution. Solo installations skip it;
  // persisted launch bindings still fail closed if their team store vanishes.
  let seats: ReturnType<typeof orchestratorWorkspacePrincipalsOrUnknown> | undefined;
  const hasWorkspaces = Boolean(store?.workspaceRows().length);
  // A launch binding is the narrower answer, so it stands when seats cannot be
  // read; an unbound conversation has no such fallback and refuses.
  const seatBinding = (id: string, bound: boolean) => {
    if (!hasWorkspaces) return undefined;
    if (!seats) {
      const principals = orchestratorWorkspacePrincipalsOrUnknown();
      if (!principals) {
        if (bound) return undefined;
        throw new Error("workspace seat authority is unavailable");
      }
      seats = principals;
    }
    return seats.get(id);
  };
  const bound = (principal: WorkspacePrincipal, fromMessage: boolean): WorkspaceReach => {
    const member = store?.member(principal.memberId);
    return { principal: member?.status === "active" && member.role === "owner" ? null : principal, fromMessage };
  };
  while (id && !seen.has(id)) {
    seen.add(id);
    const conversation = typeof snapshot === "function" ? snapshot(id) : Object.hasOwn(snapshot.conversations, id) ? snapshot.conversations[id] : undefined;
    const profile = conversation?.generations.at(-1)?.launchProfile;
    const seat = seatBinding(id, Boolean(profile?.workspace));
    const inherited = seat?.fromMessage ? seat.workspace : undefined;
    const principal = inherited ? undefined : profile?.workspace ?? seat?.workspace;
    if (principal) return bound(principal, false);
    const memberId = store?.latestConversationMember(id);
    if (memberId) {
      const member = store!.member(memberId);
      if (member?.role === "owner" && member.status === "active") return { principal: null, fromMessage: true };
      const project = conversationProjectKey(conversation?.projectOwnership, profile);
      return { principal: { memberId, workspaceId: project ? workspaceDirectory(store!).workspaceOf(project) : null }, fromMessage: true };
    }
    if (inherited) return bound(inherited, true);
    if (seat) return { principal: null, fromMessage: false };
    id = profile?.parentConversationId ?? null;
  }
  return { principal: null, fromMessage: false };
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
