import { NextRequest, NextResponse } from "next/server";

import { readProjectReportLog } from "@/lib/bridge/reportLog";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * The orchestrator's report log (#2146): one project's bridge reports, newest
 * first, a bounded page at a time. The same access as the board's own reads;
 * reading moves no relay cursor.
 *
 * `project` is required; `before=<seq>` pages back; `limit` is clamped to the
 * page bound; `since=<revision>` answers `unchanged` when the log has not moved.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;
  const project = parameters.get("project")?.trim() ?? "";
  if (!project || project.length > 256) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project is required" }, { status: 400, headers });
  }
  const beforeRaw = Number(parameters.get("before"));
  const limitRaw = Number(parameters.get("limit"));
  try {
    return NextResponse.json(readProjectReportLog({
      project,
      before: parameters.has("before") && Number.isInteger(beforeRaw) ? beforeRaw : null,
      ...(parameters.has("limit") && Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      since: parameters.get("since"),
    }), { headers });
  } catch (error) {
    if (error instanceof FileTransactionBusyError) {
      return NextResponse.json({ error: "BRIDGE_STATE_BUSY", message: error.message, retryable: true }, { status: 503, headers });
    }
    return NextResponse.json({ error: "BRIDGE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }, { status: 500, headers });
  }
}
