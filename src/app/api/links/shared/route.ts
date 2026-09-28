import { NextRequest, NextResponse } from "next/server";
import { knownProjects, patchShared, readShared, setShared, sharedProjects } from "@/lib/links/state";
import { projectLinkStates } from "@/lib/links/client";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { isStagingMode } from "@/lib/staging";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const view = () => ({ shared: readShared(), effective: sharedProjects(), known: knownProjects(), states: projectLinkStates() });
export function GET(req: NextRequest) { return rejectCrossOrigin(req) ?? NextResponse.json(view()); }
export async function POST(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  try { setShared(await req.json()); return NextResponse.json(view()); }
  catch { return NextResponse.json({ error: "cannot-share" }, { status: 400 }); }
}
export async function PATCH(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  try { patchShared(await req.json()); return NextResponse.json(view()); }
  catch { return NextResponse.json({ error: "cannot-share" }, { status: 400 }); }
}
