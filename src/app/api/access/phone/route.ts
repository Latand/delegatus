import { NextRequest, NextResponse } from "next/server";

import { currentTailnetUrl, disablePhoneAccess, enablePhoneAccess, viewerPortFor, type AccessResponse, type PhoneActionFailure, type PhoneFailureCode } from "@/lib/access/phoneAccess";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The proxy's own cookie, with the attributes its `?k=` landing sets. */
const AUTH_COOKIE = "llv_auth";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;

const FAILURE_STATUS: Record<PhoneFailureCode, number> = {
  OPERATOR_RIGHTS: 502,
  SERVE_FAILED: 502,
  VERIFY_FAILED: 502,
  TIMEOUT: 504,
  TOKEN_WRITE_FAILED: 500,
  PERSIST_FAILED: 500,
  STATUS_UNREADABLE: 502,
  NOT_READY: 409,
  TRUSTED_ENTRY: 409,
  DISABLE_FAILED: 502,
};

/**
 * One-button phone access (#1876 slice 3, design §2.3): `enable` publishes
 * the running Viewer in the tailnet and re-binds its gate; `disable` takes the
 * mapping down and lifts it. The reply to `enable` carries the access cookie,
 * so the tab that pressed the button stays signed in behind the gate it just
 * turned on. The key itself is never in a reply body.
 */
export async function POST(req: NextRequest): Promise<NextResponse<AccessResponse | PhoneActionFailure | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "enable" && body.action !== "disable") {
    return NextResponse.json({ error: "action must be enable or disable" }, { status: 400 });
  }

  const port = viewerPortFor(req.url);
  const outcome = body.action === "enable" ? await enablePhoneAccess(port) : await disablePhoneAccess(port);
  const state: AccessResponse = { tailnetUrl: currentTailnetUrl(), phone: outcome.read.phone, phoneError: outcome.read.error };
  if (!outcome.ok) {
    return NextResponse.json({ ...state, error: outcome.code, code: outcome.code, detail: outcome.detail, keyKept: outcome.keyKept }, { status: FAILURE_STATUS[outcome.code] });
  }
  const response = NextResponse.json(state);
  if (outcome.token) {
    response.cookies.set({
      name: AUTH_COOKIE,
      value: outcome.token,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      secure: req.headers.get("x-forwarded-proto") === "https",
    });
  }
  return response;
}
