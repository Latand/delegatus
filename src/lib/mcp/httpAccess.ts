import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { tokensMatch } from "@/lib/authToken";

export const MCP_HTTP_ACCESS_HEADER = "x-delegatus-mcp-access";
export const MCP_HTTP_ACCESS_ENV = "LLV_MCP_HTTP_ACCESS";
type Environment = Readonly<Record<string, string | undefined>>;

/** The launcher must explicitly declare a loopback bind; Next's fallback URL
 * and caller-controlled headers cannot establish the listener's address. */
export function mcpHttpLoopbackBound(source: Environment = process.env): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(source.HOSTNAME ?? "");
}

/** A purpose-separated credential for the MCP perimeter. The route still
 * requires a current launch capability and its tool policy. Derivation lets
 * launches survive Viewer restarts without a cache or another durable secret;
 * rotating the access key revokes this credential too.
 */
export function mcpHttpAccessToken(source: Environment = process.env): string | null {
  const key = source.LLV_TOKEN;
  return key ? createHmac("sha256", key).update("delegatus:loopback-mcp-access:v1").digest("base64url") : null;
}

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

/** The global Host perimeter runs before this narrower gate. Next constructs
 * the proxy request URL from its listener hostname (next-server runMiddleware),
 * and the launcher pins HOSTNAME to the same explicit bind address. Require
 * both: Next falls back to a localhost URL when no hostname was supplied,
 * even though that listener can bind to all interfaces. Host and forwarded
 * headers remain additional checks for proxied traffic and browsers.
 */
export function admitsMcpHttpAccess(request: NextRequest): boolean {
  if (request.nextUrl.pathname !== "/api/mcp" || request.method !== "POST") return false;
  if (!mcpHttpLoopbackBound()) return false;
  if (!loopbackUrl(request.url)) return false;
  if (!loopbackUrl(`http://${request.headers.get("host") ?? ""}`)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && !loopbackUrl(origin)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  if (request.headers.has("forwarded") || request.headers.has("x-real-ip")) return false;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && !forwarded.split(",").every(address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address.trim()))) return false;
  const expected = mcpHttpAccessToken();
  const presented = request.headers.get(MCP_HTTP_ACCESS_HEADER);
  return expected !== null && presented !== null && tokensMatch(presented, expected);
}
