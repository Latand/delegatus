import { NextRequest, NextResponse } from "next/server";

import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { createConversationDraft, previewConversationDraft, validateConversationDraftInput, ConversationDraftRefusal } from "@/lib/pipelines/fromConversation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { workspaceRoute, WorkspaceRefusal } from "@/lib/team/workspaceRoute";
import { readBoundedJson, ViewValidationError } from "@/lib/view/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<NextResponse> {
  const origin = rejectCrossOrigin(req);
  if (origin) return origin;
  if (!operatorBrowserRequest(req)) return NextResponse.json({ error: "a verified operator browser session is required", code: "operator_required" }, { status: 403 });
  try {
    const create = req.method === "POST";
    const raw = create ? await readBoundedJson(req, 4096) : Object.fromEntries(req.nextUrl.searchParams);
    if (!create && [...req.nextUrl.searchParams.keys()].some(key => req.nextUrl.searchParams.getAll(key).length !== 1)) {
      throw new ConversationDraftRefusal("INVALID_REQUEST", "duplicate query parameter", 400);
    }
    const input = validateConversationDraftInput(raw, create);
    if (!create) return NextResponse.json(await previewConversationDraft(req, input), { headers: { "cache-control": "no-store" } });
    const result = await createConversationDraft(req, input);
    if (!result.pipeline) return NextResponse.json({ ...result, code: result.code ?? "PIPELINE_REFUSED" }, { status: result.status });
    recordOperatorRequest(req, { kind: "pipeline", idempotencyKey: `pipeline-create:${result.pipeline.id}`, project: result.pipeline.project });
    return NextResponse.json({ ok: true, pipeline: result.pipeline }, { status: result.status });
  } catch (error) {
    if (error instanceof ConversationDraftRefusal || error instanceof ViewValidationError) return NextResponse.json({
      error: error.message, code: error.code, ...(error instanceof ConversationDraftRefusal && error.retryable ? { retryable: true } : {}),
    }, { status: error.status });
    if (error instanceof WorkspaceRefusal) return NextResponse.json({ error: "workspace access denied", code: "workspace_forbidden" }, { status: 403 });
    if (error instanceof StoreBusyBeforeAdmissionError) return NextResponse.json({ error: error.message, code: "store_busy", retryable: true }, { status: 503 });
    if (error instanceof Error && error.message.startsWith("idempotency_conflict:")) return NextResponse.json({ error: "creation arguments changed", code: "idempotency_conflict" }, { status: 409 });
    return NextResponse.json({ error: "conversation draft creation unavailable", code: "SOURCE_UNAVAILABLE" }, { status: 500 });
  }
}

export const GET = workspaceRoute("/api/pipelines/from-conversation", handle);
export const POST = workspaceRoute("/api/pipelines/from-conversation", handle);
