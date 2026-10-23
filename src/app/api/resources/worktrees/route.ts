import type { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readWorktreePage, WorktreePageError } from "@/lib/pipelines/worktreeDrilldown";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status });
  return withViewerOperation("resources.read", async () => {
    const headers = { "Cache-Control": "no-store" };
    try {
      return Response.json(readWorktreePage(request.nextUrl.searchParams.get("cursor")), { headers });
    } catch (error) {
      const failure = error instanceof WorktreePageError ? error : new WorktreePageError(503, "unavailable");
      return Response.json({ error: failure.code }, { status: failure.status, headers });
    }
  });
}
