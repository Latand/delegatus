import type { NextRequest } from "next/server";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * What holds the serving process's memory: GET /api/operator/heap.
 *
 * `?mode=stats` (the default) answers the JavaScriptCore object census and
 * `process.memoryUsage()`. `?mode=snapshot` writes one full heap snapshot under
 * the cache directory and answers its path and size. Both block the event loop
 * while they walk the heap, and nothing calls either on its own.
 *
 * The snapshot is a GET because an operator script authenticates with the
 * access key, and on a team install the identity gate admits a key-only caller
 * for reads alone. The handler keeps the write-route origin check, and its own
 * guards bound the cost: one snapshot an hour, one file kept.
 *
 * Operator only. An agent's conversation capability is refused, and so is a
 * Viewer service identity, which is how an agent's MCP call arrives here.
 */
export async function GET(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = directOperatorActivityAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  const mode = request.nextUrl.searchParams.get("mode") ?? "stats";
  if (mode !== "stats" && mode !== "snapshot") return Response.json({ error: "mode must be stats or snapshot" }, { status: 400, headers });
  return withViewerOperation("diagnostics.heap", async () => {
    const { servingHeapDiagnostics } = await import("@/lib/heapDiagnostics");
    const diagnostics = await servingHeapDiagnostics();
    if (!diagnostics) return Response.json({ error: "heap diagnostics need the Bun runtime", code: "unavailable" }, { status: 501, headers });
    const answer = mode === "snapshot" ? await diagnostics.snapshot() : diagnostics.stats();
    return Response.json(answer.body, { status: answer.status, headers });
  });
}
