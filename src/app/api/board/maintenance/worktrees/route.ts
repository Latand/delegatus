import { NextRequest, NextResponse } from "next/server";

import { backfillWorktreeProjects } from "@/lib/projects/worktreeBackfill";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Operator-triggered maintenance only; scheduled board maintenance cannot apply. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    || (body.project !== undefined && (typeof body.project !== "string" || !/^repo-[0-9a-f]{32}$/.test(body.project)))) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  try {
    return NextResponse.json({ ok: true, ...await backfillWorktreeProjects({ dryRun: body.dryRun !== false, project: body.project }) }, { headers });
  } catch {
    return NextResponse.json({ error: "Worktree recovery could not finish. Read the preview again and retry; existing mappings are retained." }, { status: 503, headers });
  }
}
