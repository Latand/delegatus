import { createHash } from "node:crypto";

import { ensureSelf } from "@/lib/links/self";
import type { Member, MemberSession } from "./contract";
import { workspaceScope } from "./workspaceAccess";
import type { TeamStore } from "./store";

/**
 * This digest selects browser display data. It grants no API permissions.
 *
 * The scope names who is looking and the rights that decide what they may see:
 * the installation, the session, the member, the member's role and the
 * workspaces the member holds with their roles. The projects those workspaces
 * hold change all the time (a placement, a conversation in a new project) and
 * leave the identity alone, so they ride beside the scope as `projects` and
 * saved data is filtered by them. A changed scope ends the document; a changed
 * project list only widens or narrows what saved data may show.
 */
export function boardBootScope(soloAuthorized: boolean, team?: { store: TeamStore; member: Member; session: MemberSession }) {
  if (!team && !soloAuthorized) return { scope: null, projects: null, team: false };
  let installation: string | undefined;
  try { installation = ensureSelf()?.installId; }
  catch { /* Installation identity storage is optional for a live board. */ }
  const workspace = team && workspaceScope(team.store, team.member.id);
  const projects = workspace && !workspace.owner ? workspace.projectFilter.allowed : null;
  /* An owner holds every workspace by role: a new workspace is no change in who they are. */
  const membership = workspace && !workspace.owner
    ? workspace.workspaces.map(({ id }) => ({ id, role: workspace.role(id) })).sort((left, right) => left.id.localeCompare(right.id))
    : null;
  return {
    scope: installation ? createHash("sha256").update(JSON.stringify([
      installation, team ? null : process.env.LLV_TOKEN, team?.session.id, team?.member.id, team?.member.role, membership,
    ])).digest("hex") : null,
    projects,
    team: Boolean(team),
  };
}
