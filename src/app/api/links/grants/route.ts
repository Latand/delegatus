import { NextRequest, NextResponse } from "next/server";
import { grantRows, revokeGrant } from "@/lib/links/protocol";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return rejectCrossOrigin(req) ?? NextResponse.json({ grants: grantRows() }); }
export function DELETE(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid-id" }, { status: 400 });
  return NextResponse.json({ removed: revokeGrant(id) });
}
