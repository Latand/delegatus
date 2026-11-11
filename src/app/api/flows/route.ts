import { NextRequest, NextResponse } from "next/server";
import { FLOW_RETIREMENT } from "@/lib/flows/retirement";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Flows are retired. Every method answers 410 and names what replaces it;
    stored review history is served by /api/review-history. */
export function GET() {
  return NextResponse.json(FLOW_RETIREMENT, { status: 410 });
}

export async function POST(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return NextResponse.json(FLOW_RETIREMENT, { status: 410 });
}
