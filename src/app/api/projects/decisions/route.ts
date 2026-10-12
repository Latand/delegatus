import type { NextRequest } from "next/server";
import { decisionsGET, decisionsPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A project's open decisions (docs/design/operator-decision-forms.md): `?project=`, and `&review=` for one round's record. */
export async function GET(request: NextRequest) {
  return decisionsGET(request,request.nextUrl.searchParams.get("project") ?? "",undefined,request.nextUrl.searchParams.get("review"));
}
export async function POST(request: NextRequest) { return decisionsPOST(request); }
