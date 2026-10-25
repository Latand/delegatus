import { workspaceRoute } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";
import { prototypeMediaGET } from "@/lib/prototypeReview/media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reviewId: string; mediaId: string }> };
async function workspaceGET(request: NextRequest,context: Context) {
  const { id,reviewId,mediaId } = await context.params;
  return prototypeMediaGET(request,id,reviewId,mediaId,"video");
}

export const GET = workspaceRoute("/api/tasks/[id]/prototypes/[reviewId]/video/[mediaId]", workspaceGET);
