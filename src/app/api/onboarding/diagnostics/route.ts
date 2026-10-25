import { NextRequest, NextResponse } from "next/server";

import { runDoctor } from "../../../../../bin/doctor.mjs";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicit refresh only. The proxy's team/access-key perimeter covers this read.
 * Caller query parameters never choose filesystem roots, credentials or a target. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  try {
    const report = await runDoctor({ port: Number(process.env.PORT || "8898") });
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Diagnostics could not complete." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

/** Identifies this listener without running another diagnostic request. */
export function HEAD(req: NextRequest): NextResponse {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return new NextResponse(null, { status: 204, headers: { "x-delegatus-diagnostics": "1", "cache-control": "no-store" } });
}
