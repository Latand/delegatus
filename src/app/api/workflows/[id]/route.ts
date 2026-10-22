import { NextRequest, NextResponse } from "next/server";
import { FLOW_RETIREMENT } from "@/lib/flows/retirement";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return NextResponse.json(FLOW_RETIREMENT, { status: 410 });
}
