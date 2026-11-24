import { createHash } from "node:crypto";

import { ensureSelf } from "@/lib/links/self";
import type { Member, MemberSession } from "./contract";
import { workspaceScope } from "./workspaceAccess";
import type { TeamStore } from "./store";

/** This digest selects browser display data. It grants no API permissions. */
export function boardBootScope(soloAuthorized: boolean, team?: { store: TeamStore; member: Member; session: MemberSession }) {
  if (!team && !soloAuthorized) return { scope: null, projects: null, team: false };
  let installation: string | undefined;
  try { installation = ensureSelf()?.installId; }
  catch { /* Installation identity storage is optional for a live board. */ }
  const workspace = team && workspaceScope(team.store, team.member.id);
  const projects = workspace && !workspace.owner ? workspace.projectFilter.allowed : null;
  const membership = workspace?.workspaces.map(({ id, projects }) => ({ id, role: workspace.role(id), projects: [...projects].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    scope: installation ? createHash("sha256").update(JSON.stringify([
      installation, team ? null : process.env.LLV_TOKEN, team?.session.id, team?.member.id, team?.member.role, membership, projects,
    ])).digest("hex") : null,
    projects,
    team: Boolean(team),
  };
}
