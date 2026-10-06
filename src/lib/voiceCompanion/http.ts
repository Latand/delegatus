import { NextRequest, NextResponse } from "next/server";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export function companionOperator(req: NextRequest): NextResponse | null {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || !operatorBrowserRequest(req))
    return NextResponse.json({ code: "OPERATOR_REQUIRED", error: "Open this control in Delegatus." }, { status: 403 });
  return null;
}
export async function companionBody(req: NextRequest, limit = 96_000): Promise<Record<string, unknown>> {
  const body = await req.text();
  if (Buffer.byteLength(body) > limit) throw new Error("INVALID_REQUEST");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_REQUEST");
  return parsed;
}
export function companionFailure(error: unknown): NextResponse {
  const candidate = error instanceof Error ? error.message : "";
  const code = ["NO_KEY", "KEY_FROM_ENV", "CAP_REACHED", "INVALID_SETTINGS", "INVALID_KEY", "INVALID_REQUEST", "SESSION_CLOSED", "SESSION_UNAVAILABLE", "COMPANION_DISABLED", "DEMO_MODE", "SESSION_LIMIT", "PROJECT_REFUSED", "TOOL_NOT_ALLOWED", "PROVIDER_ERROR"].includes(candidate) ? candidate : "COMPANION_UNAVAILABLE";
  return NextResponse.json({ code }, { status: code.startsWith("INVALID") ? 400 : code === "PROVIDER_ERROR" ? 502 : 409, headers: { "Cache-Control": "no-store" } });
}
