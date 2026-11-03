import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { createProjectByName, type VisibleProject } from "@/lib/projects/createByName";
import { createManualProject, projectCurationSnapshot } from "@/lib/projects/curation";
import { defaultProjectsParent, suggestionRoots } from "@/lib/projects/suggestionRoots";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { projectDirectoryFallbacks } from "@/lib/scanner/projectDirectories";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isWorkspaceId, MEMBER_REQUIRED_CODE } from "@/lib/team/contract";
import { existingTeamStore } from "@/lib/team/store";
import { requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { placeCreatedProject, workspaceCatalog } from "@/lib/team/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const FAILURE_STATUS: Record<string, number> = {
  INVALID_NAME: 400,
  INVALID_ROOT: 400,
  RELATIVE_ROOT: 400,
  OUTSIDE_ROOTS: 400,
  MISSING_DIRECTORY: 400,
  MKDIR_FAILED: 500,
  DUPLICATE_PROJECT: 409,
  DUPLICATE_NAME: 409,
  NO_FREE_FOLDER: 409,
  PARENT_IN_REPOSITORY: 409,
  STORE_ERROR: 500,
};

function refused(): NextResponse {
  return NextResponse.json({ error: "workspace access denied", code: "workspace_forbidden" }, { status: 403, headers });
}

/** The labels the caller can see in the rail. PR #3493 adds presentation
    renames; once it lands these become `presentationName` over this catalog. */
function visibleProjects(allowed: readonly string[] | null, resolve: (project: string) => string): VisibleProject[] {
  const scope = allowed && new Set(allowed);
  const rows = workspaceCatalog({ resolve }).projects.filter((row) => !scope || scope.has(row.project));
  const manualRoots = new Map(projectCurationSnapshot().manualProjects.map((entry) => [resolve(entry.project), entry.root]));
  const scannedRoots = projectDirectoryFallbacks(rows.map((row) => row.project));
  return rows.map((row) => ({
    project: row.project,
    displayName: row.displayName,
    root: manualRoots.get(row.project) ?? scannedRoots[row.project] ?? null,
  }));
}

/**
 * Creates a project. Without `root` the server picks the folder from the name
 * (docs/design/create-project-by-name.md §4); with `root` it binds that folder,
 * which stays the owner's alone because a project root becomes an `/api/artifact`
 * read root. The team gate passes this route to every member, so the checks a
 * member answers to are made here, before anything is created.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status, headers });
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  // Reading the body yields; a rotated or revoked session must not admit a root.
  const currentAuthority = requireOperatorAuthority(request);
  if (!currentAuthority.ok) return NextResponse.json({ error: currentAuthority.error }, { status: currentAuthority.status, headers });
  let scope: ReturnType<typeof requestWorkspaceScope>;
  try {
    scope = requestWorkspaceScope(request);
  } catch {
    return NextResponse.json({ error: "workspace authorization unavailable", code: "team_store_unavailable" }, { status: 503, headers });
  }
  if (scope && !scope.owner && !scope.memberId) {
    return NextResponse.json({ error: "sign in required", code: MEMBER_REQUIRED_CODE }, { status: 401, headers });
  }
  const member = Boolean(scope && !scope.owner);
  const rootGiven = record?.root !== undefined && record?.root !== null;
  if (member && rootGiven) return refused();
  const workspaceId = record?.workspaceId ?? null;
  if (member && workspaceId === null) return refused();
  /* A solo install and verified MCP have no workspace to name, so a named one is
     refused there like one the caller does not belong to. */
  if (workspaceId !== null && (!scope || !isWorkspaceId(workspaceId) || scope.role(workspaceId) === "none")) return refused();

  const name = typeof record?.name === "string" ? record.name : "";
  const root = typeof record?.root === "string" ? record.root : "";
  if (!name.trim() || (rootGiven && typeof record?.root !== "string") || name.length > 256 || root.length > 4096) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "a project name is required" }, { status: 400, headers });
  }
  /* Identities already visible on the board: the scanned catalog resolved
     through the alias machinery. A manual project must never fork one of them. */
  const resolve = projectAliasResolver();
  const existing = new Set<string>();
  for (const entry of conversationCatalogSnapshot()) {
    existing.add(resolve(entry.project));
  }
  /* The same roots the picker suggests from bound what may be created
     (issue #1223): a typed path outside the directories the viewer knows is
     refused here, mkdir opt-in included. */
  const allowedRoots = suggestionRoots();
  const store = existingTeamStore();
  let result: ReturnType<typeof createProjectByName>;
  if (root.trim()) {
    result = createManualProject(name, root, existing, {
      createMissingRoot: record?.createRoot === true,
      allowedRoots,
    });
  } else {
    for (const row of store?.workspaceProjectRows() ?? []) existing.add(resolve(row.project));
    result = createProjectByName(name, {
      parent: defaultProjectsParent(),
      allowedRoots,
      existing,
      visible: visibleProjects(scope && !scope.owner ? scope.projectFilter.allowed : null, resolve),
      resolve,
    });
  }
  if (!result.ok) {
    const { ok: _ok, code, ...details } = result;
    return NextResponse.json(
      { error: code, ...details },
      { status: FAILURE_STATUS[code] ?? 500, headers },
    );
  }
  if (workspaceId !== null) {
    /* Only another process can revoke the role this late. The project then stays
       Unassigned and visible to the owner: nothing is rolled back. */
    const actor = scope ? store?.member(scope.memberId) : null;
    try {
      if (!store || !actor) return refused();
      placeCreatedProject(store, actor, result.entry.project, workspaceId, { resolve });
    } catch {
      return refused();
    }
  }
  return NextResponse.json({
    ok: true,
    project: result.entry.project,
    displayName: result.entry.displayName,
    root: result.entry.root,
    createdAt: result.entry.createdAt,
    workspaceId,
  }, { headers });
}
