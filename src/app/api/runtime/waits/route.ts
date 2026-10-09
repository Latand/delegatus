import { NextResponse } from "next/server";

import { blockingWaitDiagnostics } from "@/lib/blockingWaits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Viewer's measured waits on registry locks, revision retries, state
    leases and snapshot transfer and parse: writer role, duration and the
    operation each was correlated with. No message content. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(blockingWaitDiagnostics(), { headers: { "cache-control": "no-store" } });
}
