import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { isStagingMode } from "@/lib/staging";
import { ExternalRelayError } from "./client";
export function guardRelayRoute(request: NextRequest): NextResponse | null {
  const origin = rejectCrossOrigin(request);
  if (origin) return origin;
  if (accessKeyWithheld(request))
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  const authority = requireOperatorAuthority(request);
  if (!authority.ok)
    return NextResponse.json(
      { error: "operator_only" },
      { status: authority.status },
    );
  if (isStagingMode())
    return NextResponse.json({ error: "staging" }, { status: 409 });
  return null;
}
/**
 * A request this install turns away before any call to the relay service.
 * Its own code keeps the UI from reporting it as the service's refusal.
 */
export function refusedHere(): NextResponse {
  return NextResponse.json({ error: "refused_here" }, { status: 400 });
}
export function relayRouteError(error: unknown): NextResponse {
  if (error instanceof ExternalRelayError)
    return NextResponse.json(
      { error: error.code },
      { status: error.status >= 400 && error.status < 500 ? error.status : 409 },
    );
  // A service reply that failed its schema.
  if (error instanceof ZodError)
    return NextResponse.json({ error: "malformed" }, { status: 502 });
  // A request body that is not JSON.
  if (error instanceof SyntaxError) return refusedHere();
  return NextResponse.json({ error: "local_error" }, { status: 500 });
}
