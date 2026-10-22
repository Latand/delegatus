import { NextRequest, NextResponse } from "next/server";
import { subscriptionApiConsent, setSubscriptionApiConsent } from "@/lib/accounts/subscriptionApiConsent";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { teamActor, teamMode } from "@/lib/team";
import { existingTeamStore } from "@/lib/team/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function authority(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || !operatorBrowserRequest(request)) return NextResponse.json({ error: "OPERATOR_REQUIRED" }, { status: 403, headers });
  if (teamMode() === "team") {
    const actor = teamActor(request);
    const member = actor.kind === "member" ? existingTeamStore()?.member(actor.memberId) : null;
    if (member?.role !== "owner" || member.status !== "active") return NextResponse.json({ error: "OWNER_REQUIRED" }, { status: 403, headers });
  }
  return null;
}
export async function GET(request: NextRequest) {
  const rejection = authority(request); if (rejection) return rejection;
  try { return NextResponse.json(subscriptionApiConsent(), { headers }); }
  catch { return NextResponse.json({ error: "SETTING_UNAVAILABLE" }, { status: 500, headers }); }
}
export async function PUT(request: NextRequest) {
  const rejection = authority(request); if (rejection) return rejection;
  let value: unknown;
  try { value = await request.json(); } catch { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "enabled" || typeof (value as { enabled: unknown }).enabled !== "boolean") return NextResponse.json({ error: "INVALID_SETTING" }, { status: 400, headers });
  const current = authority(request); if (current) return current;
  try { return NextResponse.json(setSubscriptionApiConsent((value as { enabled: boolean }).enabled), { headers }); }
  catch { return NextResponse.json({ error: "SETTING_UNAVAILABLE" }, { status: 500, headers }); }
}
