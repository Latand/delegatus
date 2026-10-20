import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readBounded } from "@/lib/ttsVoices";
import { readStructuredUserProvenanceAsync } from "@/lib/selection/structuredUserMetadata";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

// 100 compact references fit comfortably inside this ceiling. The streamed
// bound also covers requests without Content-Length and stalled bodies.
const MAX_BODY_BYTES = 16_384;

export async function POST(request: NextRequest): Promise<Response> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  return withViewerOperation("structured-user.provenance", async () => {
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "provenance request is too large" }, { status: 413 });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
    const body = request.body ? await readBounded(request.body, MAX_BODY_BYTES, signal) : null;
    if (body === null) return NextResponse.json({ error: "provenance body is unavailable or too large" }, { status: 400 });
    let refs: string[];
    try {
      const value = JSON.parse(body);
      refs = value?.refs;
      // The reader validates the shape and each reference before any I/O.
      const result = await readStructuredUserProvenanceAsync(refs);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "invalid structured-user reference batch" }, { status: 400 });
    }
  });
}
