import { NextRequest, NextResponse } from "next/server";
import { cancelCode, listCodes, mintCode } from "@/lib/links/protocol";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) {
  return rejectCrossOrigin(req) ?? NextResponse.json({ codes: listCodes() });
}
export async function POST(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  const result = await mintCode();
  return NextResponse.json(result, { status: result.error ? 409 : 200 });
}
export async function DELETE(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid-id" }, { status: 400 });
  cancelCode(id);
  return NextResponse.json({ removed: true });
}
