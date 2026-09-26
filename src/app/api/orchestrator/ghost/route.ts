import { NextRequest, NextResponse } from "next/server";

import { askOrchestratorInParallel } from "@/lib/orchestrator/deputyCommand";
import { productionDeputyCommandPorts } from "@/lib/orchestrator/deputyCommandPorts";
import { admitRuntimeImagePayload } from "@/lib/runtime/runtimeImageAdmission";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* «Ask in parallel» (docs/design/ghost-seat.md §5): starts the orchestrator
   seat's deputy for one side ask while the seat keeps working. The composer's
   action and the `ask_orchestrator_in_parallel` MCP tool both post here, so
   there is one command whatever surface the ask came from. Behaviour and
   refusals live in `@/lib/orchestrator/deputyCommand`; a route module may
   export only route fields. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { images, error: imageError } = admitRuntimeImagePayload(body);
  if (imageError) return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  try {
    const result = await askOrchestratorInParallel({
      project: typeof body.project === "string" ? body.project : "",
      text: typeof body.text === "string" ? body.text : "",
      images,
      clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : "",
    }, productionDeputyCommandPorts());
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code, ...(result.askId ? { askId: result.askId } : {}) }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      askId: result.askId,
      conversationId: result.deputyConversationId,
      replayed: result.replayed,
      deputy: result.deputy,
    });
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`orchestrator deputy route failed: ${error}`);
    return NextResponse.json({ error, code: "deputy_failed" }, { status: 500 });
  }
}
