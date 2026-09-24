import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { onboardingHealthGet, onboardingHealthStart, onboardingHealthStop } from "@/lib/onboarding/healthRoute";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

/* The setup guide's health check (#1876, design §5). The behaviour lives in
   `@/lib/onboarding/healthRoute`, where its tests import it: a route module may
   export only the documented route fields. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?run=<id>` polls one run; without it, the run in progress or the last one,
    and the runtime a new run would use. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const result = await onboardingHealthGet(req.nextUrl.searchParams.get("run"));
  return NextResponse.json(result.body, { status: result.status });
}

/** Starts a run, or answers the one already running. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) return NextResponse.json({ error: operator.error }, { status: operator.status });
  const result = await onboardingHealthStart();
  return NextResponse.json(result.body, { status: result.status });
}

/** Stop: `?run=<id>`. The run still cleans up after itself. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) return NextResponse.json({ error: operator.error }, { status: operator.status });
  const result = onboardingHealthStop(req.nextUrl.searchParams.get("run"));
  return NextResponse.json(result.body, { status: result.status });
}
