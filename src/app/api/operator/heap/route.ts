import type { NextRequest } from "next/server";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { statePath } from "@/lib/configDir";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { activeRestartGate } from "@/lib/selfUpdate/restartGate";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const SNAPSHOT_HEADER = "x-delegatus-heap-snapshot";

/**
 * What holds the serving process's memory: GET /api/operator/heap.
 *
 * `?mode=stats` (the default) answers the JavaScriptCore object census and
 * `process.memoryUsage()` with bounded attribution counters. `gc=full` collects
 * before a fresh census and reports its duration. `?mode=series` reads the
 * autonomous ten-minute samples from state.sqlite. `?mode=snapshot` writes a
 * full heap snapshot under the cache directory. Heap walks block the loop.
 *
 * The snapshot stays a GET because an operator script authenticates with the
 * access key, and on a team install the identity gate admits a key-only caller
 * for reads alone. It is a write all the same, so it asks for what a write
 * gets: the `x-delegatus-heap-snapshot: write` header, which no link, form or
 * address bar can send, the write-route origin check, and the update handoff
 * block the proxy applies to every other write.
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
  if (mode !== "stats" && mode !== "snapshot" && mode !== "series") return Response.json({ error: "mode must be stats, snapshot or series" }, { status: 400, headers });
  const gc = request.nextUrl.searchParams.get("gc");
  if (gc !== null && (gc !== "full" || mode !== "stats")) return Response.json({ error: "gc=full requires mode=stats" }, { status: 400, headers });
  if (mode === "series") {
    const { readHeapSeries } = await import("@/lib/heapSeries");
    return Response.json(readHeapSeries(), { headers });
  }
  if (mode === "snapshot") {
    if (request.headers.get(SNAPSHOT_HEADER) !== "write") {
      return Response.json({ error: `a snapshot needs the ${SNAPSHOT_HEADER}: write header`, code: "confirmation_required" }, { status: 400, headers });
    }
    if (activeRestartGate(statePath("self-update", "auto-admission.json"))) {
      return Response.json({ error: "Automatic update handoff in progress. Retry shortly." }, { status: 503, headers: { ...headers, "Retry-After": "2" } });
    }
  }
  return withViewerOperation("diagnostics.heap", async () => {
    const { servingHeapDiagnostics } = await import("@/lib/heapDiagnostics");
    const diagnostics = await servingHeapDiagnostics();
    if (!diagnostics) return Response.json({ error: "heap diagnostics need the Bun runtime", code: "unavailable" }, { status: 501, headers });
    const answer = mode === "snapshot" ? await diagnostics.snapshot() : diagnostics.stats(gc === "full");
    return Response.json(answer.body, { status: answer.status, headers });
  });
}
