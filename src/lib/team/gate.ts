import { NextResponse, type NextRequest } from "next/server";

import { agentCapabilityClaim, internalServiceClaim } from "@/lib/agent/callerClaims";

import { MEMBER_REQUIRED_CODE } from "./contract";
import { MEMBER_COOKIE, verifySessionValue } from "./sessions";
import { existingTeamStore } from "./store";

/*
 * The identity gate (§4.2): called by `src/proxy.ts` after the perimeter has
 * admitted the connection. In solo mode it answers "pass" after one `stat`.
 * In team mode a browser without a live member session is sent to /sign-in,
 * and any other request is answered 401 member_required.
 *
 * It sets no header for anything downstream to trust: a route that needs the
 * member reads the same cookie again (`teamActor`).
 */

/* Pages and endpoints a signed-out person needs: the sign-in and join pages,
   the sign-in endpoints (each checks what it needs itself), the frame path the
   perimeter already exempts, and the static assets those pages load. */
const EXEMPT_PREFIXES = [
  "/sign-in",
  "/join/",
  "/api/team/public",
  "/api/team/session/",
  "/api/team/join/",
  "/api/artifact/frame/",
  "/_next/",
  "/brand/",
] as const;
const EXEMPT_EXACT = new Set(["/favicon.ico", "/icon.svg", "/apple-icon", "/manifest.webmanifest", "/robots.txt"]);

/** The pages a signed-out person is shown (the proxy forbids framing them). */
export function isTeamAuthPage(pathname: string): boolean {
  return pathname === "/sign-in" || pathname.startsWith("/join/");
}

export function isGateExempt(pathname: string): boolean {
  return EXEMPT_EXACT.has(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function isNavigation(request: NextRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  if (request.nextUrl.pathname.startsWith("/api/")) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export interface TeamGateContext {
  /** The perimeter admitted this request by `Authorization: Bearer`. */
  bearerAuthenticated: boolean;
}

/** null = pass; otherwise the response to send instead. */
export function teamGate(request: NextRequest, context: TeamGateContext, nowMs = Date.now()): NextResponse | null {
  const pathname = request.nextUrl.pathname;
  if (isGateExempt(pathname)) return null;
  let store;
  try {
    store = existingTeamStore();
    if (!store || !store.hasActiveOwner()) return null;
  } catch {
    /* A team store that exists and cannot be read fails closed: letting every
       request through as the unnamed operator is exactly what a team install
       asked not to happen. */
    return pathname.startsWith("/api/")
      ? NextResponse.json({ error: "team sign-in is unavailable: the team store cannot be read", code: "team_store_unavailable" }, { status: 503 })
      : new NextResponse("Team sign-in is unavailable: the team store cannot be read. Run `delegatus team recover` on the host.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
  }

  /* An agent names itself with its spawn capability and a Viewer process with
     its service tag. Both are VERIFIED here, never taken by shape: the
     capability against the operator's key and the registry, the tag against
     its HMAC. Most routes never ask who is acting, so a claim passed on its
     looks alone would reach them as the unnamed operator, and a revoked
     member could walk back in by writing 43 characters into a header. A
     claim that fails verification is ignored and the request is judged as a
     person below. */
  const reads = request.method === "GET" || request.method === "HEAD";
  if (agentCapabilityClaim(request) === "valid") return null;
  const service = internalServiceClaim(request, { readOnly: true });
  /* A readiness probe (candidate health, the self-update restart) reads the
     page it proves; its tag opens nothing else. */
  if (service.claim === "valid" && (service.service !== "probe" || reads)) return null;

  /* Operator scripts read with the perimeter key, and a browser on the
     runtime host's trusted local entry has it injected. None of them writes
     as a person, so reads pass and the first write asks. Whoever holds the
     key can read this way, a revoked member included; rotating the key
     (`--new-token`) is what takes that back (§9). */
  if (context.bearerAuthenticated && reads) return null;

  try {
    if (verifySessionValue(store, request.cookies.get(MEMBER_COOKIE)?.value, nowMs)) return null;
  } catch {
    return NextResponse.json({ error: "team sign-in is unavailable", code: "team_store_unavailable" }, { status: 503 });
  }

  if (isNavigation(request)) {
    const url = request.nextUrl.clone();
    const next = `${pathname}${request.nextUrl.search}`;
    url.pathname = "/sign-in";
    url.search = "";
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url, 307);
  }
  return NextResponse.json({ error: "sign in required", code: MEMBER_REQUIRED_CODE }, { status: 401 });
}
