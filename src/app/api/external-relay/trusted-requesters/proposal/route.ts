import { NextRequest, NextResponse } from "next/server";
import { proposeRequesterOperation } from "@/lib/externalRelay/requesterEnrolment";
import { requesterMcpInput } from "@/lib/externalRelay/requesterEnrolmentContract";
import { requesterMcpAuthority } from "@/lib/externalRelay/requesterEnrolmentHttp";
import { refusedHere, relayRouteError } from "@/lib/externalRelay/routeGuard";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isStagingMode } from "@/lib/staging";

export async function POST(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  try {
    const { conversation, authorize } = requesterMcpAuthority(req);
    const input = requesterMcpInput.safeParse(await req.json());
    if (!input.success) return refusedHere();
    const result = await proposeRequesterOperation(input.data, conversation, authorize);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return relayRouteError(error); }
}
