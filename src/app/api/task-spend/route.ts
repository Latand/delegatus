import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { requestSession, teamMode } from "@/lib/team/sessions";
import { activityOperation } from "@/lib/activity/operation";
import { taskSpendResponse } from "@/lib/activity/taskLimitSpend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspaceGET(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return activityOperation("activity.task-spend.read", () => {
    const headers = { "cache-control": "private, no-store" };
    try {
      const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map(id => id.trim()).filter(Boolean))].slice(0,400);
      const session = requestSession(req);
      const canChoose = session ? session.member.role === "owner" : teamMode() === "solo";
      return NextResponse.json(taskSpendResponse(ids,{ canChoose }),{ headers });
    } catch {
      return NextResponse.json({ error: "task spend unavailable" },{ status: 500,headers });
    }
  });
}

export const GET = workspaceRoute("/api/task-spend", workspaceGET);
