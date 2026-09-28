import { NextRequest, NextResponse } from "next/server";
import { connectPeer, LinkError, projectLinkStates } from "@/lib/links/client";
import { peerRows } from "@/lib/links/protocol";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) {
  return rejectCrossOrigin(req) ?? NextResponse.json({ peers: peerRows(), states: projectLinkStates() });
}
export async function POST(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  let body: { url?: unknown; code?: unknown; name?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "malformed" }, { status: 400 }); }
  if (typeof body.url !== "string" || typeof body.code !== "string" || (body.name !== undefined && typeof body.name !== "string")) return NextResponse.json({ error: "malformed" }, { status: 400 });
  try {
    const peer = await connectPeer({ url: body.url, code: body.code, name: body.name });
    const { token: _token, ...publicPeer } = peer;
    return NextResponse.json({ peer: publicPeer, states: projectLinkStates() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof LinkError ? error.code : "unreachable" }, { status: 409 });
  }
}
