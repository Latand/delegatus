import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { tokensMatch } from "@/lib/authToken";

export const MCP_HTTP_ACCESS_HEADER = "x-delegatus-mcp-access";
export const MCP_HTTP_ACCESS_ENV = "LLV_MCP_HTTP_ACCESS";
type Environment = Readonly<Record<string, string | undefined>>;

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

/** The global Host perimeter runs before this narrower gate. Forwarded remote
 * traffic and remote browser origins cannot use the local MCP credential.
 * Next adds x-forwarded-for for direct connections; every address in a proxy
 * chain must be literal loopback. Other forwarding formats fail closed.
 */
export function admitsMcpHttpAccess(request: NextRequest): boolean {
  if (request.nextUrl.pathname !== "/api/mcp" || request.method !== "POST") return false;
  // Next constructs request.url from its bind address, which can be a wildcard
  // even for a loopback connection. Use the checked HTTP authority here.
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
