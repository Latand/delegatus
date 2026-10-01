import { NextRequest, NextResponse } from "next/server";
import { telemetryStatus, updatePreferences } from "@/lib/telemetry/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try { return NextResponse.json(telemetryStatus(), { headers }); }
  catch { return NextResponse.json({ error: "Telemetry settings unavailable" }, { status: 500, headers }); }
}
export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid setting" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid setting" }, { status: 400, headers });
  const b = body as Record<string, unknown>;
  if (!Object.keys(b).length || Object.keys(b).some(k => k !== "enabled" && k !== "noticeDismissed") ||
      (b.enabled !== undefined && typeof b.enabled !== "boolean") ||
      (b.noticeDismissed !== undefined && typeof b.noticeDismissed !== "boolean")) return NextResponse.json({ error: "Invalid setting" }, { status: 400, headers });
  try {
    updatePreferences(b as { enabled?: boolean; noticeDismissed?: boolean });
    return NextResponse.json(telemetryStatus(), { headers });
  } catch { return NextResponse.json({ error: "Could not save telemetry setting" }, { status: 500, headers }); }
}
