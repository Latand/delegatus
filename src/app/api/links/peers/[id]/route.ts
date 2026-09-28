import { NextRequest, NextResponse } from "next/server";
import { LinkError, removeConnectedPeer, syncPeer, projectLinkStates } from "@/lib/links/client";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: Context) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  try {
    const result = await syncPeer((await context.params).id);
    const { token: _token, ...peer } = result.peer;
    return NextResponse.json({ peer, states: projectLinkStates() });
  } catch (error) { return NextResponse.json({ error: error instanceof LinkError ? error.code : "unreachable", states: projectLinkStates() }, { status: 409 }); }
}
export async function DELETE(req: NextRequest, context: Context) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  try { return NextResponse.json(await removeConnectedPeer((await context.params).id)); }
  catch (error) { return NextResponse.json({ error: error instanceof LinkError ? error.code : "unreachable" }, { status: 404 }); }
}
