import { NextRequest, NextResponse } from "next/server";
import { remoteAgents } from "@/lib/links/agentFeed";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  const project = req.nextUrl.searchParams.get("project") ?? "";
  if (!/^repo-[0-9a-f]{32}$/.test(project)) return NextResponse.json({ error: "malformed" }, { status: 400 });
  return NextResponse.json({ agents: remoteAgents(project) }, { headers: { "cache-control": "no-store" } });
}
