import { NextRequest, NextResponse } from "next/server";
import { isIP } from "node:net";

import type { ApiError } from "@/lib/types";
import { pendingSelfProbeHost } from "@/lib/links/selfProbe";

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

/** Parse an authority before comparing names. A malformed port or bracket
 * must never turn an attacker-controlled header into an allowed name. Ports
 * stay independent: stable entries and reverse proxies forward to a different
 * serving port, and linked addresses may use the default HTTP(S) port. */
function hostWithoutPort(host: string): string {
  const match = /^(\[[\da-fA-F:.]+\]|[a-zA-Z\d.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return "";
  return match[1]!.replace(/^\[|\]$/g, "").toLowerCase();
}

function allowedHostNames(): Set<string> {
  const allowedHosts = new Set(LOOPBACK_HOSTS);
  const add = (host: string | undefined) => {
    const name = host && isIP(host) === 6 ? host.toLowerCase() : hostWithoutPort(host ?? "");
    // Even a wildcard bind adds only its literal address, never other names.
    if (name) allowedHosts.add(name);
  };
  // The launcher pins HOSTNAME to its explicit --hostname value in both the
  // Next start and standalone paths (bin/cli.mjs buildChildEnv).
  add(process.env.HOSTNAME);
  const tailnetHost = process.env.LLV_TS_HOST;
  add(tailnetHost);
  const publicHost = process.env.LLV_PUBLIC_HOST;
  if (process.env.LLV_TOKEN) add(publicHost);
  return allowedHosts;
}

/** Every request passes this perimeter, including reads, streams, peer routes
 * and signed frames. Origin and Sec-Fetch-Site remain write-route checks. */
export function rejectForeignHost(req: NextRequest): NextResponse<ApiError> | null {
  const host = req.headers.get("host");
  const name = hostWithoutPort(host ?? "");
  if (name && allowedHostNames().has(name)) return null;
  // An operator's address Save probes the proposed Host before committing it.
  // Only that outstanding nonce's self-check POST may use the proposed name;
  // the nonce grants no reads, other peer actions or lasting Host permission.
  if (name && process.env.LLV_TOKEN && req.method === "POST" && req.nextUrl.pathname === "/api/peer/v1/self-check") {
    const proposed = pendingSelfProbeHost(req.headers.get("x-delegatus-self") ?? "");
    if (proposed && name === hostWithoutPort(proposed)) return null;
  }
  return forbidden();
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
