import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readBoundedJson, ViewValidationError } from "@/lib/view/validation";
import { createTypingLatencyLog, MAX_TYPING_LATENCY_BYTES, validateTypingLatency } from "@/lib/view/typingLatency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const log = createTypingLatencyLog((line) => console.warn(line));

/** Slow keystroke-to-paint samples from an operator's browser, logged for the
    Viewer's journal next to `[viewer loop-gap]`. Numbers only; see
    `src/lib/view/typingLatency.ts` for the closed wire shape. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  try {
    const report = validateTypingLatency(await readBoundedJson(request, MAX_TYPING_LATENCY_BYTES));
    return NextResponse.json({ ok: true, logged: log.record(report) }, { headers });
  } catch (error) {
    const known = error instanceof ViewValidationError ? error : new ViewValidationError("INVALID_REQUEST", "invalid request");
    return NextResponse.json({ error: known.code, message: known.message }, { status: known.status, headers });
  }
}
