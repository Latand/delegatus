import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { tokensMatch } from "@/lib/authToken";
import { isTeamAuthPage, teamGate, teamPerimeter } from "@/lib/team/gate";

const AUTH_COOKIE = "llv_auth";
const FRAME_PREFIX = "/api/artifact/frame/";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) {
    return false;
  }

  return tokensMatch(candidate, token);
}

function redirectWithCookie(request: NextRequest, token: string): NextResponse {
  const url = request.nextUrl.clone();
  url.searchParams.delete("k");

  const response = NextResponse.redirect(url, 307);
  response.cookies.set({
    name: AUTH_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: request.headers.get("x-forwarded-proto") === "https",
  });
  return response;
}

function forbidden(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access denied: key required" }, { status: 403 });
  }

  return new NextResponse(
    "Access denied. Open the link with the key from the terminal where the viewer is running (bunx agent-log-viewer --tailscale).",
    {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

/**
 * Two layers, kept apart (docs/design/sign-in-and-team.md D1). The perimeter
 * below decides whether this connection may reach the Viewer at all; the
 * identity gate after it decides which member a browser is, and only on an
 * install that has set up a team — a solo install answers "pass" after one
 * `stat`, exactly as before.
 */
export function proxy(request: NextRequest): NextResponse {
  const perimeter = perimeterCheck(request);
  if (perimeter.response) return perimeter.response;
  const gated = teamGate(request, { bearerAuthenticated: perimeter.bearer });
  if (gated) return gated;
  const response = NextResponse.next();
  /* The sign-in and join pages are never framed: a page that asks a person
     to approve something must not be drawn under someone else's. */
  if (isTeamAuthPage(request.nextUrl.pathname)) {
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  return response;
}

type PerimeterResult = { response: NextResponse | null; bearer: boolean };
const PASS: PerimeterResult = { response: null, bearer: false };

function perimeterCheck(request: NextRequest): PerimeterResult {
  const token = process.env.LLV_TOKEN;
  if (!token) {
    return PASS;
  }

  // The report frame is loaded from a sandboxed, origin-less document, so its
  // subresource requests are cross-site and never carry the SameSite cookie.
  // The route authorizes each request by the signed directory scope in its
  // path, which only an authenticated meta read can mint (frameScope.ts).
  if (request.nextUrl.pathname.startsWith(FRAME_PREFIX)) {
    return PASS;
  }

  // LLV_TOKEN is the explicit access-control switch. Once configured, every
  // connection authenticates because loopback is shared by every OS account.

  const cookieToken = request.cookies.get(AUTH_COOKIE)?.value;
  const authorizationHeader = request.headers.get("authorization");
  const bearer = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const bearerMatches = tokenMatches(bearer, token);
  if (tokenMatches(cookieToken, token) || bearerMatches) {
    return { response: null, bearer: bearerMatches };
  }

  const queryToken = request.nextUrl.searchParams.get("k");
  if (queryToken !== null && tokensMatch(queryToken, token)) {
    return { response: redirectWithCookie(request, token), bearer: false };
  }

  // On a team install a member's session is their way past the perimeter,
  // and the sign-in pages are reachable without the key, so no link handed
  // to a teammate carries it (docs/design/sign-in-and-team.md §9).
  const team = teamPerimeter(request);
  if (team === "admit") return PASS;
  if (team) return { response: team, bearer: false };

  return { response: forbidden(request), bearer: false };
}

export const config = { matcher: ["/((?!_next/static|favicon.ico).*)"] };
