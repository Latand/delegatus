import { NextRequest, NextResponse } from "next/server";

import { backfillWorktreeProjects } from "@/lib/projects/worktreeBackfill";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Read-only diagnostic; recovery belongs to Viewer startup and full scans. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    || (body.project !== undefined && (typeof body.project !== "string" || !/^repo-[0-9a-f]{32}$/.test(body.project)))) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  if (body.dryRun === false) return NextResponse.json({ error: "Worktree recovery runs automatically; this endpoint supports dry-run diagnostics only." }, { status: 400, headers });
  try {
    return NextResponse.json({ ok: true, ...await backfillWorktreeProjects({ dryRun: true, project: body.project }) }, { headers });
  } catch {
    return NextResponse.json({ error: "Worktree recovery evidence could not be read. Retry the diagnostic after the next full catalog scan." }, { status: 503, headers });
  }
}
