import { NextRequest, NextResponse } from "next/server";

import { DismissalError, dismissAttention, parseDismissalTarget } from "@/lib/attention/dismissals";
import { readBoundedJson } from "@/lib/attention/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { attentionFailure } from "../failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * The operator's Dismiss (docs/design/needs-attention.md §5): one click on a
 * card, desktop or phone, clears what it drew until something new asks. The
 * body is `{ target, undo?, surface? }`; who dismissed is the operator, from
 * the surface they clicked on. Agents reach the same service through the
 * `dismiss_attention` MCP tool, which attributes them on the server.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) {
    rejection.headers.set("Cache-Control", "no-store");
    return rejection;
  }
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DismissalError("INVALID_REQUEST", "request body must be an object");
    const fields = body as Record<string, unknown>;
    const target = parseDismissalTarget(fields.target, { allowSubjects: true });
    const surface = fields.surface === "phone" ? "phone" : "desktop";
    const outcome = await dismissAttention(target, { kind: "operator", surface }, { undo: fields.undo === true });
    return NextResponse.json({ ok: true, ...outcome }, { headers });
  } catch (error) {
    if (error instanceof DismissalError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers });
    }
    return attentionFailure(error);
  }
}
