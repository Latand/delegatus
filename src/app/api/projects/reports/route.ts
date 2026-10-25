import { workspaceRoute, requestWorkspaceScope, filterWorkspaceRows } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { projectReportOverview, type ProjectReportLine } from "@/lib/projects/reportDestination";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The reports overview in the bot panel (docs/design/orchestrator-reports.md
 * §5.6): every project with an orchestrator seat and its report destination.
 * Read only; each line switches through PUT /api/projects/settings, which
 * holds the operator-only check and the allowlist check.
 */
export interface ProjectReportsResponse {
  ok: true;
  projects: ProjectReportLine[];
}

async function workspaceGET(request: NextRequest): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) { rejected.headers.set("Cache-Control", "no-store"); return rejected; }
  return NextResponse.json({ ok: true, projects: filterWorkspaceRows(requestWorkspaceScope(request), projectReportOverview()) } satisfies ProjectReportsResponse, { headers: { "Cache-Control": "no-store" } });
}

export const GET = workspaceRoute("/api/projects/reports", workspaceGET, true);
