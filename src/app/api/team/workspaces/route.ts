import { NextResponse, type NextRequest } from "next/server";

import { workspaceScope } from "@/lib/team/workspaceAccess";
import type { WorkspacesView } from "@/lib/team/contract";
import { crossOrigin, readJson, requireMember, requireOwner, teamErrorResponse, teamJson } from "@/lib/team/http";
import { existingTeamStore } from "@/lib/team/store";
import { createWorkspace, requestWorkspaceOptions, workspaceCatalog } from "@/lib/team/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The workspaces (docs/design/workspaces.md §13.3), for anyone signed in;
    `?catalog=1` adds every project the installation knows, for the pages that
    place them. A solo install answers `mode: "solo"` and creates nothing. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const store = existingTeamStore();
    if (!store || !store.hasActiveOwner()) return teamJson<WorkspacesView>({ mode: "solo" });
    const authed = requireMember(req);
    if (authed instanceof NextResponse) return authed;
    const options = requestWorkspaceOptions();
    const scope = workspaceScope(store, authed.live.member.id);
    const view: WorkspacesView = {
      mode: "team",
      canManage: authed.live.member.role === "owner",
      managedWorkspaceIds: scope.workspaces.filter(workspace => ["owner", "manager"].includes(scope.role(workspace.id))).map(workspace => workspace.id),
      workspaces: scope.workspaces,
    };
    if (req.nextUrl.searchParams.get("catalog") === "1") {
      const catalog = workspaceCatalog(options);
      view.catalog = { ...catalog, projects: catalog.projects.filter(row => scope.access(row.project) !== "none") };
    }
    return teamJson(view);
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** `{ id, name, color?, projects? }`, owner only. 201 when created; a replay
    of the same id and name answers 200 with the stored workspace. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    const { workspace, created } = createWorkspace(authed.store, authed.live.member, body as { id: unknown; name: unknown }, requestWorkspaceOptions());
    return teamJson({ workspace }, created ? 201 : 200);
  } catch (error) {
    return teamErrorResponse(error);
  }
}
