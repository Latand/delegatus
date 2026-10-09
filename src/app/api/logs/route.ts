import { NextRequest, NextResponse } from "next/server";

import { feedPathAllowed } from "@/lib/externalRelay/feedAccess";
import { readTailChunk } from "@/lib/logRead";
import { MAX_CHUNK } from "@/lib/scanner/roots";
import type { ApiError, LogChunk } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requests beyond this are ignored (the client slices its batches too). */
const MAX_REQS = 64;
/* One batch answer stays within ~4×MAX_CHUNK of log bytes: the first paint of
   a board full of panes would otherwise multiply MAX_CHUNK by the pane count
   in a single response. Files past the budget return an idle chunk at their
   current offset and catch up on later ticks. */
const BATCH_BUDGET = 4 * MAX_CHUNK;

interface BatchReq {
  id: string;
  path: string;
  offset: number;
}

function parseReqs(body: unknown): BatchReq[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { reqs?: unknown }).reqs;
  if (!Array.isArray(raw)) return [];
  const reqs: BatchReq[] = [];
  for (const entry of raw.slice(0, MAX_REQS)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, path, offset } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof path !== "string") continue;
    reqs.push({ id, path, offset: typeof offset === "number" ? offset : 0 });
  }
  return reqs;
}

/**
 * The multiplexed tail poll: every visible pane's forward read in one request
 * instead of one HTTP round-trip per pane per tick. Same chunk semantics as
 * GET /api/log; history (`before`) reads stay on the single-file route.
 */
export async function POST(req: NextRequest): Promise<NextResponse<{ chunks: Record<string, LogChunk | ApiError> }>> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const chunks: Record<string, LogChunk | ApiError> = {};
  let budget = BATCH_BUDGET;
  const allowed = feedPathAllowed(req);
  /* Sequential on purpose: the byte budget is spent in request order, and a
     dozen warm stat+read pairs cost far less than the parallelism would win. */
  for (const { id, path, offset } of parseReqs(body)) {
    const chunk = await readTailChunk(path, offset, budget, allowed);
    if (!chunk) {
      chunks[id] = { error: "path not allowed" };
      continue;
    }
    budget -= chunk.offset - chunk.start;
    chunks[id] = chunk;
  }
  return NextResponse.json({ chunks });
}
