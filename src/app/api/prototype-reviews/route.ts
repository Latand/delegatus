import { workspaceRoute } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";
import { publishPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function workspacePOST(request: NextRequest) { return publishPOST(request); }

export const POST = workspaceRoute("/api/prototype-reviews", workspacePOST);
