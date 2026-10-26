import { requestWorkspaceScope, filterWorkspaceRows, workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn } from "@/app/api/spawn/admission";
import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { agentRegistry } from "@/lib/agent/registry";
import { revokedSeatPipelineRefusal, SeatRevocationStoreUnavailableError } from "@/lib/orchestrator/seatAuthority";
import { directOperatorActivityAuthority, requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { conversationAgentRole, isSpawnDeniedRole, reviewerOriginSpawnGuidance, type SpawnRejectionCode } from "@/lib/agent/spawnAdmission";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { createPipelineFromRequest, type PipelineBriefer } from "@/lib/pipelines/engine";
import type { CreatePipelineRequest, Pipeline, PipelineRepoPreflightErrorCode, PipelinesResponse } from "@/lib/pipelines/types";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { loadPipelineListRecords } from "@/lib/pipelines/listProjection";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import type { PipelineValidationViolation } from "@/lib/pipelines/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ENGINE_NOT_CONNECTED, EngineNotConnectedDetails } from "@/lib/accounts/engineConnection";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineApiError = ApiError & {
  code?: PipelineRepoPreflightErrorCode | SpawnRejectionCode | "orchestrator_seat_revoked" | "orchestrator_seat_authority_unavailable" | "store_busy" | typeof ENGINE_NOT_CONNECTED | "TASK_RUNS_ELSEWHERE" | "STAGE_KIND_RETIRED";
  /** With ENGINE_NOT_CONNECTED: the stage, role and engine (#1876). */
  details?: EngineNotConnectedDetails;
  /** #1766: set when the registry lock refused before anything was admitted, so
      the caller may repeat the identical request without risking a duplicate. */
  retryable?: true;
  field?: "repoDir";
  path?: string;
  /** #1026: every violated create-time constraint, each with its field and the
      shape that field expects — the same list the MCP tool returns. */
  violations?: PipelineValidationViolation[];
};

/** The query parameters GET reads — the `list_pipelines` filters. */
const LIST_PARAMETERS = new Set(["project", "state", "includeClosed", "limit"]);

/**
 * With no query, the whole hot store, as it always answered: the Viewer's own
 * callers pass none. With one, the same filters `list_pipelines` applies
 * (#1845 defect B): `project`, `state` (a state, or `open`), `includeClosed`
 * and `limit`, over whole records. Before this every query parameter was
 * ignored, so `?project=<one project>` answered every pipeline of every project
 * — 5 MB — and `?project=<a project with none>` answered the same 5 MB rather
 * than nothing. A parameter this route does not read is refused, never
 * silently dropped again.
 */
async function workspaceGET(req: NextRequest): Promise<NextResponse<PipelinesResponse | ApiError>> {
  return withViewerOperation("pipelines.get", () => getPipelineList(req));
}

/** Backpressure keeps only the current encoded row while the client reads. */
function pipelineListResponse(pipelines: readonly Pipeline[]): NextResponse<PipelinesResponse> {
  const encoder = new TextEncoder();
  let index = -1;
  let slice = performance.now();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (performance.now() - slice >= 4) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        slice = performance.now();
      }
      if (cancelled) return;
      try {
        if (index === -1) { index = 0; controller.enqueue(encoder.encode('{"pipelines":[')); }
        else if (index < pipelines.length) {
          controller.enqueue(withViewerOperation("pipelines.get", () =>
            encoder.encode(`${index ? "," : ""}${JSON.stringify(pipelines[index++])}`)));
        } else {
          pipelines = [];
          controller.enqueue(encoder.encode("]}"));
          controller.close();
        }
      } catch (error) { pipelines = []; controller.error(error); }
    },
    cancel() { cancelled = true; pipelines = []; },
  }, { highWaterMark: 0 });
  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}

async function getPipelineList(req: NextRequest): Promise<NextResponse<PipelinesResponse | ApiError>> {
  const params = req.nextUrl.searchParams;
  const unknown = [...new Set(params.keys())].filter((key) => !LIST_PARAMETERS.has(key));
  if (unknown.length > 0) {
    return NextResponse.json({
      error: `unsupported query parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; this route reads ${[...LIST_PARAMETERS].join(", ")}`,
    }, { status: 400 });
  }
  try {
    if (params.size === 0) return pipelineListResponse(filterWorkspaceRows(requestWorkspaceScope(req), loadPipelinesForList()));
    const includeClosed = params.get("includeClosed") === "true" || params.get("includeClosed") === "1";
    const limit = params.has("limit") ? Number(params.get("limit")) : null;
    const pipelines = await loadPipelineListRecords({
      project: params.get("project"),
      state: params.get("state"),
      includeClosed,
      limit: Number.isFinite(limit) ? limit : null,
    });
    return await pipelineListResponse(filterWorkspaceRows(requestWorkspaceScope(req), pipelines));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "pipeline registry unreadable" }, { status: 500 });
  }
}

/** Reviewer isolation for pipeline creation (#393): a pipeline is a spawn
    container, so a reviewer/verifier caller may not create one. The
    authenticated capability lane and a declared reviewer `src` are both
    rejected; external callers without a capability keep the #341 contract.
    Registry admission independently rejects every stage launch of any
    reviewer-created container, so this route check is defense in depth.
    An admitted request answers who briefed it, for the sizing rules. */
function pipelineOrigin(req: NextRequest, body: CreatePipelineRequest): NextResponse<PipelineApiError> | PipelineBriefer {
  const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER);
  if (capability === null && !isAgentInitiatedSpawn(req)) return { kind: "operator" };
  const registry = agentRegistry();
  if (capability !== null) {
    const caller = authenticatedAgentSpawnCaller(req, body.src, registry);
    if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 });
    /* The sizing rules judge the authenticated conversation; the operator's
       own capability is the operator (docs/design/model-sizing-tiers.md §2). */
    if (caller.kind === "operator") return { kind: "operator" };
    if (caller.kind === "agent") {
      const revoked = revokedSeatPipelineRefusal(caller.conversationId, id => registry.canonicalConversationId(id as `conversation_${string}`));
      if (revoked) return NextResponse.json({ error: revoked, code: "orchestrator_seat_revoked" }, { status: 403 });
      const role = conversationAgentRole(registry.readOnlySnapshot(), caller.conversationId);
      if (isSpawnDeniedRole(role)) {
        return NextResponse.json({ error: reviewerOriginSpawnGuidance(role), code: "reviewer_origin_spawn" }, { status: 403 });
      }
      if (typeof body.src !== "string" || !body.src.trim()) {
        const derivedPath = registry.conversation(caller.conversationId)?.generations.at(-1)?.path ?? null;
        if (!derivedPath) {
          return NextResponse.json({ error: "pipeline creator lineage is required; pass src" }, { status: 400 });
        }
        body.src = derivedPath;
      }
      return { kind: "agent", conversationId: caller.conversationId };
    }
    return { kind: "operator" };
  }
  const srcPath = typeof body.src === "string" && body.src.trim() ? body.src.trim() : null;
  const srcConversation = srcPath ? registry.conversationForPath(srcPath) : null;
  if (srcConversation) {
    const revoked = revokedSeatPipelineRefusal(srcConversation.id, id => registry.canonicalConversationId(id as `conversation_${string}`));
    if (revoked) return NextResponse.json({ error: revoked, code: "orchestrator_seat_revoked" }, { status: 403 });
    const role = conversationAgentRole(registry.readOnlySnapshot(), srcConversation.id);
    if (isSpawnDeniedRole(role)) {
      return NextResponse.json({ error: reviewerOriginSpawnGuidance(role), code: "reviewer_origin_spawn" }, { status: 403 });
    }
  }
  /* An external caller without a capability is judged by its `src` creator. */
  return { kind: "agent", conversationId: null };
}

async function workspacePOST(req: NextRequest): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | PipelineApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: CreatePipelineRequest;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
    body = raw as CreatePipelineRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const origin = pipelineOrigin(req, body);
    if (origin instanceof NextResponse) return origin;
    const authority = requireOperatorAuthority(req);
    if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status });
    const result = await createPipelineFromRequest(body, undefined, {
      allowOperatorDraftWithoutLineage: !isAgentInitiatedSpawn(req),
      queueWhenBusy: true,
      briefer: origin,
    });
    if (!result.pipeline) return NextResponse.json({
      error: result.error ?? "could not create pipeline",
      ...(result.code ? { code: result.code, field: result.field, path: result.path } : {}),
      ...(result.details ? { details: result.details } : {}),
      ...(result.violations?.length ? { violations: result.violations } : {}),
    }, { status: result.status ?? 400 });
    if (result.pipeline.state !== "draft" || result.queued) requestPipelineTick();
    /* A replayed create answers the same pipeline, so its id is the key. A
       queued create already has its id and the operator made the request
       now, so it is recorded the same way. */
    if (directOperatorActivityAuthority(req).ok) {
      recordOperatorRequest(req, { kind: "pipeline", idempotencyKey: `pipeline-create:${result.pipeline.id}`, project: result.pipeline.project });
    }
    /* #1835: refused by the store before admission, so queued for the serving
       release's controller; 202 says the record is not stored yet. */
    return NextResponse.json({
      ok: true,
      pipeline: result.pipeline,
      ...(result.repositoryInitialization ? { repositoryInitialization: result.repositoryInitialization } : {}),
      ...(result.queued ? { queued: result.queued } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      ...(result.convertedStages?.length ? { convertedStages: result.convertedStages } : {}),
      ...(result.legacyReview?.length ? { legacyReview: result.legacyReview } : {}),
    }, { status: result.queued ? 202 : 201 });
  } catch (error) {
    if (error instanceof SeatRevocationStoreUnavailableError) {
      return NextResponse.json({ error: error.message, code: "orchestrator_seat_authority_unavailable", retryable: true }, { status: 503 });
    }
    /* #1766: the registry lock was never taken, so no pipeline was created.
       Say so, and say the same request may be repeated — a 500 leaves a caller
       guessing whether a pipeline exists. */
    if (error instanceof StoreBusyBeforeAdmissionError) {
      return NextResponse.json({ error: error.message, code: "store_busy", retryable: true }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export const GET = workspaceRoute("/api/pipelines", workspaceGET, true);

export const POST = workspaceRoute("/api/pipelines", workspacePOST);
