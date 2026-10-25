import { workspaceRoute } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";
import { decisionsGET, decisionsPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A project's open decisions (docs/design/operator-decision-forms.md): `?project=`, and `&review=` for one round's record. */
async function workspaceGET(request: NextRequest) {
  return decisionsGET(request,request.nextUrl.searchParams.get("project") ?? "",undefined,request.nextUrl.searchParams.get("review"));
}
async function workspacePOST(request: NextRequest) { return decisionsPOST(request); }

export const GET = workspaceRoute("/api/projects/decisions", workspaceGET);

export const POST = workspaceRoute("/api/projects/decisions", workspacePOST);
