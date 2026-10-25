import { workspaceRoute } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";
import { reviewGET, reviewPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function workspaceGET(request: NextRequest,context: Context) { return reviewGET(request,(await context.params).id); }
async function workspacePOST(request: NextRequest,context: Context) { return reviewPOST(request,(await context.params).id); }

export const GET = workspaceRoute("/api/tasks/[id]/prototypes", workspaceGET);

export const POST = workspaceRoute("/api/tasks/[id]/prototypes", workspacePOST);
