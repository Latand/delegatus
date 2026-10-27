import { NextResponse, type NextRequest } from "next/server";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { requestCodexUpdate } from "@/lib/codexUpdate/controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest): NextResponse {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const claim = internalServiceClaim(request, { readOnly: true });
  if (claim.claim !== "valid" || claim.service !== "controller") {
    return NextResponse.json({ error: "host controller authentication required" }, { status: 403 });
  }
  const accepted = requestCodexUpdate();
  return NextResponse.json({ accepted }, { status: accepted ? 202 : 409, headers: { "cache-control": "no-store" } });
}
