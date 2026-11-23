import { NextResponse, type NextRequest } from "next/server";

import { AccountProjectBindingsUnreadableError } from "@/lib/accounts/projectBindings";
import { crossOrigin, requireMember, signInStore, teamErrorResponse, teamJson } from "@/lib/team/http";
import { TeamError } from "@/lib/team/members";
import { projectAccountsView } from "@/lib/team/projectAccounts";
import { workspaceScope } from "@/lib/team/workspaceAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_MAX = 256;

function projectParam(req: NextRequest): string {
  const value = req.nextUrl.searchParams.get("project");
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.trim() || value.length > PROJECT_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TeamError("project_required", "choose a project", 400);
  }
  return value;
}

/**
 * The accounts of one project's pool, for a member who may act on the project.
 * Membership is checked here, as the workspace routes do. Between that check
 * and the answer nothing is awaited, and the decision is made before any
 * account, binding or limit reading is touched: a refusal says the same thing
 * for a project that is not theirs, one that does not exist and one that was
 * moved away.
 */
export function GET(req: NextRequest): NextResponse {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const project = projectParam(req);
    if (!workspaceScope(authed.store, authed.live.member.id).canAct(project)) {
      return teamJson({ error: "workspace access denied", code: "workspace_forbidden" }, 403);
    }
    return teamJson(projectAccountsView(project));
  } catch (error) {
    if (error instanceof AccountProjectBindingsUnreadableError) {
      return teamJson({ error: "the project's account list cannot be read", code: "account_list_unreadable" }, 409);
    }
    return teamErrorResponse(error);
  }
}
