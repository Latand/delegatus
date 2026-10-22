import { NextRequest, NextResponse } from "next/server";
import { getWorkflowsWithTemplates } from "@/lib/workflows/engine";
import { FLOW_ARCHIVE, FLOW_RETIREMENT } from "@/lib/flows/retirement";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...getWorkflowsWithTemplates(), ...FLOW_ARCHIVE });
}

export async function POST(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return NextResponse.json(FLOW_RETIREMENT, { status: 410 });
}
