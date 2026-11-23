import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { seatDeputyView } from "@/lib/orchestrator/deputyView";
import { readDeputies } from "@/lib/orchestrator/deputies";
import { deputyAskerOf } from "@/lib/orchestrator/deputyAsker";
import { askOrchestratorInParallel } from "@/lib/orchestrator/deputyCommand";
import { readDeputySeatBusy } from "@/lib/orchestrator/deputySeatBusy";
import { readDeputyOwnLines } from "@/lib/orchestrator/deputySweep";
import { productionDeputyCommandPorts } from "@/lib/orchestrator/deputyCommandPorts";
import { admitRuntimeImagePayload } from "@/lib/runtime/runtimeImageAdmission";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { TeamError } from "@/lib/team/members";

/* «Ask in parallel» (docs/design/ghost-seat.md §5): starts the orchestrator
   seat's deputy for one side ask while the seat keeps working. The composer's
   action and the `ask_orchestrator_in_parallel` MCP tool both post here, so
   there is one command whatever surface the ask came from. Behaviour and
   refusals live in `@/lib/orchestrator/deputyCommand`; a route module may
   export only route fields. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspacePOST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return NextResponse.json({ ...await rejection.json(), admission: "refused" }, { status: rejection.status });
  /* A deputy holds the seat's authority, so only the operator and the voice
     gateway may start one, and the gateway's ask stays an agent's. */
  const asker = deputyAskerOf(req);
  if (!asker.ok) return NextResponse.json({ error: asker.error, code: asker.code, admission: "refused" }, { status: asker.status });
  const actor = teamActor(req);
  const anonymous = refuseAnonymous(actor);
  if (anonymous) return anonymous;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON", admission: "refused" }, { status: 400 });
  }
  const { images, error: imageError } = admitRuntimeImagePayload(body);
  if (imageError) return NextResponse.json({ error: imageError.error, admission: "refused" }, { status: imageError.status });
  try {
    const result = await askOrchestratorInParallel(typeof body.retryAskId === "string" ? {
      retryAskId: body.retryAskId, clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : "",
    } : {
      seatConversationId: typeof body.seatConversationId === "string" ? body.seatConversationId : undefined,
      project: typeof body.project === "string" ? body.project : "",
      text: typeof body.text === "string" ? body.text : "",
      images,
      clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : "",
      origin: asker.origin,
      ...(actor.kind === "member" ? { memberId: actor.memberId } : {}),
    }, productionDeputyCommandPorts());
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code, ...(result.admission ? { admission: result.admission } : {}), ...(result.askId ? { askId: result.askId } : {}) }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      askId: result.askId,
      conversationId: result.deputyConversationId,
      replayed: result.replayed,
      deputy: seatDeputyView(result.deputy),
      ...(result.deliveryUncertain ? { deliveryUncertain: true } : {}),
    });
  } catch (thrown) {
    if (thrown instanceof TeamError) return NextResponse.json({ error: thrown.message, code: thrown.code }, { status: thrown.status });
    const error = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`orchestrator deputy route failed: ${error}`);
    return NextResponse.json({ error, code: "deputy_failed" }, { status: 500 });
  }
}

/* The deputy's own transcript records, after the seat history the fork copied
   (docs/design/ghost-seat.md §6.1): the canonical rows of its block in the
   seat's feed. `missing` says the transcript is gone, so an expanded block can
   say so instead of drawing nothing. */
async function workspaceGET(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const project = req.nextUrl.searchParams.get("project")?.trim();
  if (project) {
    try {
      return NextResponse.json(await readDeputySeatBusy(project));
    } catch {
      return NextResponse.json({ error: "seat activity is unavailable" }, { status: 503 });
    }
  }
  const askId = req.nextUrl.searchParams.get("askId")?.trim() ?? "";
  if (!askId) return NextResponse.json({ error: "askId is required" }, { status: 400 });
  const deputy = readDeputies().find((candidate) => candidate.askId === askId);
  if (!deputy) return NextResponse.json({ error: "no such parallel ask" }, { status: 404 });
  const lines = readDeputyOwnLines(deputy);
  return NextResponse.json({ askId, lines: lines ?? [], missing: lines === null });
}

export const POST = workspaceRoute("/api/orchestrator/ghost", workspacePOST);

export const GET = workspaceRoute("/api/orchestrator/ghost", workspaceGET);
