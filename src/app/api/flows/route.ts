import { NextRequest, NextResponse } from "next/server";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import { FLOW_ARCHIVE, FLOW_RETIREMENT } from "@/lib/flows/retirement";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...getFlowsWithPresets(), ...FLOW_ARCHIVE });
}

export async function POST(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return NextResponse.json(FLOW_RETIREMENT, { status: 410 });
}
