import { requestWorkload } from "@/lib/requestWorkload";
import { NextRequest, NextResponse } from "next/server";

import { runDoctor } from "../../../../../bin/doctor.mjs";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicit refresh only. The proxy's team/access-key perimeter covers this read.
 * Caller query parameters never choose filesystem roots, credentials or a target. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (req.nextUrl.searchParams.get("workload") === "1") {
    const first = Number(req.nextUrl.searchParams.get("firstMinute") ?? Math.max(0, Math.floor(process.uptime() / 60) - 15));
    const last = Number(req.nextUrl.searchParams.get("lastMinute") ?? first + 15);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last - first > 15) {
      return NextResponse.json({ error: "invalid workload observation interval" }, { status: 400 });
    }
    return NextResponse.json(requestWorkload.snapshot(first, last), { headers: { "cache-control": "no-store" } });
  }
  if (req.nextUrl.searchParams.get("loop") === "1") {
    // Retained process-memory splits and cache estimates from the same loop
    // ticks; this read never samples the heap or materializes cached rows.
    return NextResponse.json(viewerLoopMonitor.memorySamples(), { headers: { "cache-control": "no-store" } });
  }
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
