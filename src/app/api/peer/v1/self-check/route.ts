import { NextRequest, NextResponse } from "next/server";

import { tokensMatch } from "@/lib/authToken";
import { consumeSelfNonce } from "@/lib/links/self";
import { authorizePeer } from "@/lib/links/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export function POST(req: NextRequest): NextResponse {
  const nonce = req.headers.get("x-delegatus-self") ?? "";
  if (!consumeSelfNonce(nonce)) return unauthorized();
  const token = process.env.LLV_TOKEN;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return NextResponse.json({
    host: req.headers.get("host"),
    vouched: Boolean(token && bearer && tokensMatch(bearer, token)),
  });
}

function unsupported(req: NextRequest): NextResponse {
  return authorizePeer(req.headers.get("x-delegatus-peer"))
    ? NextResponse.json({ error: "not found" }, { status: 404 }) : unauthorized();
}
export const GET = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const HEAD = unsupported;
export const OPTIONS = unsupported;
