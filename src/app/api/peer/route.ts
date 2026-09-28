import { NextRequest, NextResponse } from "next/server";
import { authorizePeer } from "@/lib/links/protocol";
import { unauthorizedPeer } from "@/lib/links/peerResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function guarded(req: NextRequest): NextResponse {
  const valid = authorizePeer(req.headers.get("x-delegatus-peer"));
  return valid ? NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } }) : unauthorizedPeer();
}
export const GET = guarded;
export const POST = guarded;
export const PUT = guarded;
export const PATCH = guarded;
export const DELETE = guarded;
export const HEAD = guarded;
export const OPTIONS = guarded;
