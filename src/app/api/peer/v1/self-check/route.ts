import { NextRequest, NextResponse } from "next/server";

import { tokensMatch } from "@/lib/authToken";
import { consumeSelfNonce } from "@/lib/links/self";
import { authorizePeer } from "@/lib/links/protocol";
import { unauthorizedPeer } from "@/lib/links/peerResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: NextRequest): NextResponse {
  const nonce = req.headers.get("x-delegatus-self") ?? "";
  // Kept for the operator to read beside the address the check expected, 200
  // characters each, a longer value ending in an ellipsis. The verdict reads
  // the Host whole, which goes to the record beside these.
  const header = (name: string) => { const value = req.headers.get(name); return value && value.length > 200 ? `${value.slice(0, 199)}…` : value; };
  const host = header("host");
  // Next writes these two before a route reads them when the proxy sent none:
  // X-Forwarded-Host from Host, X-Forwarded-Proto "http" on the Viewer's plain
  // listener. A value equal to that may be Next's own, so it is recorded as
  // unknown.
  const fromProxy = (name: string, filled: string | null) => { const value = header(name); return value === filled ? null : value; };
  const forwardedHost = fromProxy("x-forwarded-host", host);
  const forwardedProto = fromProxy("x-forwarded-proto", "http");
  const unknown = [...(forwardedHost === null ? ["forwardedHost" as const] : []), ...(forwardedProto === null ? ["forwardedProto" as const] : [])];
  const seen = { host, forwardedHost, forwardedProto, forwarded: header("forwarded"), unknown };
  if (!consumeSelfNonce(nonce, seen, req.headers.get("host"))) return unauthorizedPeer();
  const token = process.env.LLV_TOKEN;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return NextResponse.json({
    host: req.headers.get("host"),
    vouched: Boolean(token && bearer && tokensMatch(bearer, token)),
  });
}

function unsupported(req: NextRequest): NextResponse {
  return authorizePeer(req.headers.get("x-delegatus-peer"))
    ? NextResponse.json({ error: "not found" }, { status: 404 }) : unauthorizedPeer();
}
export const GET = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const HEAD = unsupported;
export const OPTIONS = unsupported;
