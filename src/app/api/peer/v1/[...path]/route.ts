import { NextRequest, NextResponse } from "next/server";

import { authorizePeer, incomingSync, markGrantSync, pairIncoming, probePair, revokeGrant, sharedDigest } from "@/lib/links/protocol";
import { drainSeatMessages, seatMessagesPart, SeatMessageRefusal } from "@/lib/links/seatMessages";
import { linkedPeer } from "@/lib/links/linked";
import { readSelf } from "@/lib/links/self";
import { sharedProjects, usedGrant } from "@/lib/links/state";
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
    if (malformed) { markGrantSync(current, "malformed"); return answer({ error: "malformed" }, 400); }
    try {
      const result = incomingSync(current, input);
      const link = linkedPeer("grant", current.id);
      if (result.status === 200 && link) {
        await drainSeatMessages(link);
        // A revocation while the delivery awaited a host never sends more data.
        if (authorizePeer(req.headers.get("x-delegatus-peer"), "board:sync")?.id !== current.id) return unauthorized();
        const freshLink = linkedPeer("grant", current.id);
        if (!freshLink || freshLink.install !== link.install) return unauthorized();
        const local = sharedProjects();
        const digest = sharedDigest(local);
        const body = result.body as Record<string, unknown>;
        if (body.s !== digest || link.projects.size !== freshLink.projects.size || [...link.projects].some(project => !freshLink.projects.has(project))) {
          // Every project-bearing part was built before delivery awaited. A
          // changed boundary starts a fresh handshake; no old page is exported.
          result.body = { v: 1, now: Date.now(), store: body.store, s: digest, taskWireVersion: body.taskWireVersion,
            shared: local.slice(0, 100), index: 0, total: local.length, need: true, tasks: { wait: true } };
        }
        (result.body as Record<string, unknown>).sm = seatMessagesPart(freshLink);
      }
      markGrantSync(current, result.status === 200 ? null : String((result.body as { error?: string }).error ?? "unavailable"));
      return answer(result.body, result.status);
    } catch (error) {
      const code = error instanceof SeatMessageRefusal ? error.code : "malformed";
      markGrantSync(current, code); return answer({ error: code }, code === "quota" ? 429 : 400);
    }
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
