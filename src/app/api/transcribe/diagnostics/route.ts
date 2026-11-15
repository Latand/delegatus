import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { dictationTraceSchema, recordDictationTrace } from "@/lib/transcribe/dictationTraceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 4096;

/** The Viewer's access/team perimeter applies; reject browser cross-origin
 * writes before reading a body. Strict fields keep text/audio out of storage. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (!req.body) return NextResponse.json({ error: "expected diagnostic" }, { status: 400 });
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return NextResponse.json({ error: "diagnostic too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const trace = dictationTraceSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!trace.success) return NextResponse.json({ error: "invalid diagnostic" }, { status: 400 });
    try {
      if (!await recordDictationTrace(trace.data)) return NextResponse.json({ error: "diagnostics busy" }, { status: 503 });
      return new NextResponse(null, { status: 204 });
    } catch { return NextResponse.json({ error: "diagnostic storage unavailable" }, { status: 503 }); }
  } catch {
    return NextResponse.json({ error: "diagnostic unavailable" }, { status: 400 });
  } finally { reader.releaseLock(); }
}
