import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { isStagingMode } from "@/lib/staging";
import { ExternalRelayError } from "./client";
export function guardRelayRoute(
  request: NextRequest,
  _mutate: boolean,
): NextResponse | null {
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
export function relayRouteError(error: unknown): NextResponse {
  return NextResponse.json(
    {
      error:
        error instanceof ExternalRelayError ? error.code : "invalid_request",
    },
    {
      status:
        error instanceof ExternalRelayError &&
        error.status >= 400 &&
        error.status < 500
          ? error.status
          : 409,
    },
  );
}
