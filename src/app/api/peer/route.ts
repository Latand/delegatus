import { NextRequest, NextResponse } from "next/server";
import { authorizePeer } from "@/lib/links/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function guarded(req: NextRequest): NextResponse {
  const valid = authorizePeer(req.headers.get("x-delegatus-peer"));
  return NextResponse.json(valid ? { error: "not found" } : { error: "unauthorized" },
    { status: valid ? 404 : 401, headers: { "cache-control": "no-store" } });
}
export const GET = guarded;
export const POST = guarded;
export const PUT = guarded;
export const PATCH = guarded;
export const DELETE = guarded;
export const HEAD = guarded;
export const OPTIONS = guarded;
