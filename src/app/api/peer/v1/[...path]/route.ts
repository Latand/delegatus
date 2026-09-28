import { NextRequest, NextResponse } from "next/server";

import { authorizePeer, incomingSync, pairIncoming, probePair, revokeGrant } from "@/lib/links/protocol";
import { readSelf } from "@/lib/links/self";
import { usedGrant } from "@/lib/links/state";
import { unauthorizedPeer } from "@/lib/links/peerResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const answer = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const unauthorized = unauthorizedPeer;

async function json(req: NextRequest): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("malformed");
  if (Number(req.headers.get("content-length") ?? 0) > 1_048_576) throw new Error("malformed");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("malformed");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 1_048_576) { await reader.cancel(); throw new Error("malformed"); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const path = (await context.params).path.join("/");
  if (path === "pair/probe") {
    try { const result = probePair((await json(req) as { id?: unknown }).id, req.headers.get("authorization")); return answer(result.body, result.status); }
    catch { return unauthorized(); }
  }
  if (path === "pair") {
    try { const result = pairIncoming(await json(req)); const response = answer(result.body, result.status); if (result.status === 429) response.headers.set("retry-after", "60"); return response; }
    catch { return unauthorized(); }
  }
  const grant = authorizePeer(req.headers.get("x-delegatus-peer"), path === "boards/sync" ? "board:sync" : undefined);
  if (!grant) return unauthorized();
  if (path === "boards/sync") {
    let input: unknown;
    let malformed = false;
    try { input = await json(req); } catch { malformed = true; }
    // A body can arrive long after the headers; a grant revoked meanwhile
    // gets the same 401 as any stranger and writes nothing.
    const current = authorizePeer(req.headers.get("x-delegatus-peer"), "board:sync");
    if (current?.id !== grant.id) return unauthorized();
    if (malformed) return answer({ error: "malformed" }, 400);
    try { const result = incomingSync(current, input); return answer(result.body, result.status); }
    catch { return answer({ error: "malformed" }, 400); }
  }
  usedGrant(grant, false);
  return answer({ error: "not found" }, 404);
}

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const path = (await context.params).path.join("/");
  const grant = authorizePeer(req.headers.get("x-delegatus-peer"));
  if (!grant) return unauthorized();
  if (path === "info") {
    usedGrant(grant, false);
    const self = readSelf();
    return answer({ v: 1, install: self ? { id: self.installId, label: self.label } : null, version: 1, scopes: grant.scopes, feeds: { boards: 1 } });
  }
  usedGrant(grant, false);
  return answer({ error: "not found" }, 404);
}

export async function DELETE(req: NextRequest, context: Context): Promise<NextResponse> {
  const path = (await context.params).path.join("/");
  const grant = authorizePeer(req.headers.get("x-delegatus-peer"));
  if (!grant) return unauthorized();
  if (path === "grant") { revokeGrant(grant.id); return answer({ removed: true }); }
  return answer({ error: "not found" }, 404);
}

export async function OPTIONS(req: NextRequest, context: Context): Promise<NextResponse> {
  const path = (await context.params).path.join("/");
  return authorizePeer(req.headers.get("x-delegatus-peer"), path === "boards/sync" ? "board:sync" : undefined)
    ? answer({ error: "not found" }, 404) : unauthorized();
}
export const PUT = OPTIONS;
export const PATCH = OPTIONS;
export const HEAD = OPTIONS;
