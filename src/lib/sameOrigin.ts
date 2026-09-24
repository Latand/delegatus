import { NextRequest, NextResponse } from "next/server";

import type { ApiError } from "@/lib/types";

/**
 * CSRF gate for mutating API routes. The server binds to localhost, but any
 * web page open in the user's browser can still fire a drive-by fetch at
 * 127.0.0.1 and reach /api/proc (kill) or /api/conversation-host (deliver a
 * message to a conversation, resuming or respawning its host). Browsers
 * attach Origin and Sec-Fetch-Site to such requests, so a cross-origin caller
 * is rejected here; non-browser clients (curl, scripts) send neither header
 * and pass through.
 *
 * Returns the 403 response to send, or null when the request may proceed.
 * Every POST handler must call this before reading the body:
 *
 *   const rejection = rejectCrossOrigin(req);
 *   if (rejection) return rejection;
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Strips a trailing ":port" (or the brackets of an IPv6 "[::1]:port") from a Host header value. */
function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  const idx = host.lastIndexOf(":");
  return idx === -1 ? host : host.slice(0, idx);
}

function allowedHostNames(): Set<string> {
  const allowedHosts = new Set(LOOPBACK_HOSTS);
  const tailnetHost = process.env.LLV_TS_HOST;
  if (tailnetHost) {
    allowedHosts.add(hostWithoutPort(tailnetHost));
  }
  return allowedHosts;
}

/** The Host half of the gate alone, for a route whose callers are cross-origin
    by design and which authorizes them some other way (the report frame). */
export function rejectForeignHost(req: NextRequest): NextResponse<ApiError> | null {
  const host = req.headers.get("host");
  if (host === null || !allowedHostNames().has(hostWithoutPort(host))) return forbidden();
  return null;
}

export function rejectCrossOrigin(req: NextRequest): NextResponse<ApiError> | null {
  // DNS rebinding: an attacker's public DNS name can resolve to 127.0.0.1 after
  // the browser's same-origin checks pass, carrying a Host header the attacker
  // controls. Pin Host to known names regardless of Origin/Sec-Fetch-Site; the
  // optional tailnet hostname is pinned explicitly, preserving the allowlist.
  const allowedHosts = allowedHostNames();
  const hostRejection = rejectForeignHost(req);
  if (hostRejection) return hostRejection;

  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Covers the literal "null" opaque origin (sandboxed iframe, file://).
      originHost = null;
    }
    if (originHost === null || !allowedHosts.has(hostWithoutPort(originHost))) return forbidden();
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return forbidden();
  return null;
}

function forbidden(): NextResponse<ApiError> {
  return NextResponse.json({ error: "forbidden: cross-origin request" }, { status: 403 });
}
