import { sessionKeyId } from "@/lib/agent/sessionKey";
import { existingTeamStore } from "@/lib/team/store";
import { assertWorkspaceReadProject, WorkspaceRefusal, workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { authenticatedAgentSpawnCaller } from "@/app/api/spawn/admission";
import { agentRegistry } from "@/lib/agent/registry";
import { directOperatorActivityAuthority, requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { OPERATOR_PAUSE_RESUME_ACTOR, type PauseResumeActor } from "@/lib/pauseResumeActor";
import { revokedSeatPipelineRefusal, SeatRevocationStoreUnavailableError } from "@/lib/orchestrator/seatAuthority";
import { carryingTaskWorkLinks, pipelineWorkLinks } from "@/lib/forge/resolve";
import type { ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { readPipelineCreationReceipt } from "@/lib/pipelines/creationQueue";
import { getPipeline, patchPipeline, type PipelineCloseReport, type PipelinePatchResult } from "@/lib/pipelines/engine";
import type { LegacyReviewPreview } from "@/lib/pipelines/legacyReviewDefinition";
import { loadPipelines, pipelineRevision, pipelineDecisionRevision } from "@/lib/pipelines/store";
import { loadTasks } from "@/lib/tasks/store";
import { graphDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import { PIPELINE_ACTIONS, type PatchPipelineRequest, type Pipeline, type PipelineAction, type PipelineGraphEdit, type PipelineGuardErrorCode, type PipelineGuardField, type PipelineRepoPreflightErrorCode } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ENGINE_NOT_CONNECTED, EngineNotConnectedDetails } from "@/lib/accounts/engineConnection";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import type { ApiError } from "@/lib/types";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { TeamError } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set<PipelineAction>(PIPELINE_ACTIONS);

const CONTROLLER_ACTIONS = new Set<PipelineAction>(["start", "resume", "retry-stage", "skip-stage", "resolve-decision", "continue-review", "accept-head", "retry-merge"]);

type PipelineApiError = ApiError & {
  code?: TeamError["code"] | "workspace_forbidden" | "RUNTIME_SWITCH_IN_PROGRESS" | "STAGE_ALREADY_REPORTED" | "ATTEMPT_STARTING" | "RUNTIME_SWITCH_UNAVAILABLE" | PipelineRepoPreflightErrorCode | PipelineGuardErrorCode | "store_busy" | typeof ENGINE_NOT_CONNECTED
    | "WORK_LINK_INVALID" | "WORK_LINK_AUTO" | "WORK_LINK_LIMIT" | "orchestrator_seat_revoked" | "orchestrator_seat_authority_unavailable" | "TASK_RUNS_ELSEWHERE" | "STAGE_KIND_RETIRED";
  /** With ENGINE_NOT_CONNECTED: the stage, role and engine (#1876). */
  details?: EngineNotConnectedDetails;
  /** #1766: set when the registry lock refused before the action was admitted,
      so the identical request may be repeated. */
  retryable?: true;
  field?: "repoDir" | PipelineGuardField;
  path?: string;
  /** Present when a close was refused: the hosts it stopped and the one it could not. */
  close?: PipelineCloseReport;
  /** Present when a legacy review conversion was refused: the editable preview. */
  legacyReviewPreview?: LegacyReviewPreview;
};

function pipelineControlAdmission(req: NextRequest): { actor: PauseResumeActor } | { refusal: NextResponse<PipelineApiError> } {
  if (!req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)) return { actor: OPERATOR_PAUSE_RESUME_ACTOR };
  const registry = agentRegistry();
  const caller = authenticatedAgentSpawnCaller(req, undefined, registry);
  if ("error" in caller) return { refusal: NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 }) };
  if (caller.kind === "operator") return { actor: OPERATOR_PAUSE_RESUME_ACTOR };
  try {
    const revoked = revokedSeatPipelineRefusal(caller.conversationId, id => registry.canonicalConversationId(id as `conversation_${string}`));
    if (revoked) return { refusal: NextResponse.json({ error: revoked, code: "orchestrator_seat_revoked" }, { status: 403 }) };
    return { actor: { kind: "agent", conversationId: caller.conversationId, role: null } };
  } catch (error) {
    if (error instanceof SeatRevocationStoreUnavailableError) {
      return { refusal: NextResponse.json({ error: error.message, code: "orchestrator_seat_authority_unavailable", retryable: true }, { status: 503 }) };
    }
    throw error;
  }
}

async function workspaceGET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<{ ok: true; pipeline: Pipeline; revision: string; decisionRevision?: string; stageDigests: Record<string, string>; graphDigest: string } | ApiError>> {
  const { id } = await ctx.params;
  try {
    let pipeline = getPipeline(id);
    if (!pipeline) {
      const read = await readPipelineCreationReceipt(id);
      pipeline = getPipeline(id);
      if (!pipeline) {
        if (read.kind !== "found") return read.kind === "unavailable"
          ? NextResponse.json({ error: "creation status unavailable" }, { status: 503 })
          : NextResponse.json({ error: "pipeline not found" }, { status: 404 });
        assertWorkspaceReadProject(req, read.receipt.project);
        return NextResponse.json({ error: read.receipt.state === "queued" ? "creation queued" : "creation refused",
          code: read.receipt.state === "queued" ? "pipeline_queued" : "pipeline_creation_refused",
          queuedCreation: read.receipt }, { status: 404 });
      }
    }
    /* #1695 C7 and graph slice 1: the digests a guarded graph edit names as
       `expectedStageDigest` — a stage's for override-stage and set-edge, the
       whole plan's for add-stage, remove-stage and reorder-stage. */
    assertWorkspaceReadProject(req, pipeline.project);
    const decisionRevision = pipelineDecisionRevision(pipeline);
    return NextResponse.json({ ok: true, pipeline, ...(decisionRevision ? { decisionRevision } : {}), revision: pipelineRevision(pipeline), stageDigests: stageDigests(pipeline.stages), graphDigest: graphDigest(pipeline.stages) });
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "pipeline registry unreadable" }, { status: 500 });
  }
}

function captureDecisionRequestAuthority(req: NextRequest): () => void {
  const admission = pipelineControlAdmission(req);
  const human = teamActor(req);
  if ("refusal" in admission) return () => { throw new WorkspaceRefusal("decision caller authority is unavailable"); };
  const credentials = () => JSON.stringify([req.headers.get("cookie"), req.headers.get("authorization"), req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)]);
  const originalCredentials = credentials();
  const memberRoute = () => {
    if (human.kind !== "member") return null;
    const member = existingTeamStore()?.member(human.memberId);
    return member && JSON.stringify([member.id, member.role, member.status, member.revokedAt]);
  };
  const agentGeneration = () => {
    if (admission.actor.kind !== "agent" || !admission.actor.conversationId) return null;
    const snapshot = agentRegistry().readOnlySnapshot();
    const conversation = snapshot.conversations[admission.actor.conversationId];
    const generation = conversation?.generations.at(-1);
    const entry = conversation && generation && snapshot.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
    return JSON.stringify([generation && [generation.id, generation.path, generation.accountId, generation.createdAt,
      generation.archivedAt, generation.launchProfile], entry && [entry.claimOwner, entry.claimEpoch,
        entry.artifactPath, entry.structuredHost?.endpoint, entry.structuredHost?.process]]);
  };
  const originalGeneration = agentGeneration();
  const originalMemberRoute = memberRoute();
  const originalHuman = JSON.stringify(human);
  const originalActor = JSON.stringify(admission.actor);
  const originalOperator = human.kind === "operator" ? requireOperatorAuthority(req) : null;
  return () => {
    if (human.kind === "member" && !existingTeamStore()) throw new TeamError("team_store_unavailable", "member authority is unavailable", 503);
    const current = pipelineControlAdmission(req);
    if (credentials() !== originalCredentials || agentGeneration() !== originalGeneration || memberRoute() !== originalMemberRoute || JSON.stringify(teamActor(req)) !== originalHuman || "refusal" in current || JSON.stringify(current.actor) !== originalActor
      || originalOperator && (!originalOperator.ok || !requireOperatorAuthority(req).ok)) throw new WorkspaceRefusal("decision caller authority changed");
  };
}

async function workspacePATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  assertAtEntry?: () => void,
): Promise<NextResponse<{ ok: true; pipeline: Pipeline; revision: string; close?: PipelineCloseReport; graphEdit?: PipelineGraphEdit; convertedStages?: PipelinePatchResult["convertedStages"]; legacyReview?: PipelinePatchResult["legacyReview"]; workLinks?: ResolvedWorkLinks; taskWorkLinks?: Record<string, ResolvedWorkLinks> } | PipelineApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const admission = pipelineControlAdmission(req);
  if ("refusal" in admission) return admission.refusal;
  const human = teamActor(req);
  const anonymous = refuseAnonymous(human);
  if (anonymous) return anonymous;
  const assertDecisionCaller = assertAtEntry ?? captureDecisionRequestAuthority(req);
  let body: PatchPipelineRequest;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
    body = raw as PatchPipelineRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!ACTIONS.has(body.action)) {
    return NextResponse.json({ error: `unknown pipeline action (allowed: ${PIPELINE_ACTIONS.join(", ")})` }, { status: 400 });
  }
  const { id } = await ctx.params;
  if (body.action === "update-draft" && body.repoDir !== undefined) {
    const authority = requireOperatorAuthority(req);
    if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status });
  }
  try {
    // publish needs its caller only to accept a head whose commit custody was refused.
    const actor = body.action === "resolve-decision" || body.action === "continue-review" || body.action === "accept-head" || body.action === "override-stage"
      || body.action === "publish"
      ? admission.actor
      : undefined;
    const result = await patchPipeline(id, body, undefined, actor, body.action === "resolve-decision" ? assertDecisionCaller : undefined, human.kind === "member" ? human.memberId : undefined);
    if (!result.pipeline) return NextResponse.json({
      error: result.error ?? "could not update pipeline",
      /* A malformed guard names its field without a code: each travels on its own. */
      ...(result.code ? { code: result.code } : {}),
      ...(result.field ? { field: result.field } : {}),
      ...(result.path ? { path: result.path } : {}),
      ...(result.details ? { details: result.details } : {}),
      /* #1026: a draft stage edit runs the same batched stage validation the
         create path does, so its caller gets the same field-level list. */
      ...(result.violations?.length ? { violations: result.violations } : {}),
      ...(result.close ? { close: result.close } : {}),
      ...(result.legacyReviewPreview ? { legacyReviewPreview: result.legacyReviewPreview } : {}),
    }, { status: result.status ?? 400 });
    if (CONTROLLER_ACTIONS.has(body.action)) requestPipelineTick();
    /* The operator's answer to a decision is a request to the lane; an
       agent's answer (named by its capability) is not recorded. */
    if (body.action === "resolve-decision" && directOperatorActivityAuthority(req).ok) {
      recordOperatorRequest(req, {
        kind: "decision",
        idempotencyKey: result.decisionAnswer ? `decision:${result.pipeline.id}:${result.decisionAnswer.clientRequestId}` : null,
        project: result.pipeline.project,
      });
    }
    return NextResponse.json({ ok: true, pipeline: result.pipeline, revision: pipelineRevision(result.pipeline), ...(result.decisionAnswer ? { decisionAnswer: result.decisionAnswer, replayed: result.replayed } : {}), ...(result.reviewContinuation ? { reviewContinuation: result.reviewContinuation, replayed: result.replayed } : {}), ...(result.reviewAcceptance ? { reviewAcceptance: result.reviewAcceptance, replayed: result.replayed } : {}), ...(result.legacyReviewPreview ? { legacyReviewPreview: result.legacyReviewPreview } : {}), ...(result.legacyReviewConversion ? { legacyReviewConversion: result.legacyReviewConversion, replayed: result.replayed } : {}), ...(result.close ? { close: result.close } : {}), ...(result.graphEdit ? { graphEdit: result.graphEdit } : {}), ...(result.runtimeSwitch !== undefined ? { runtimeSwitch: result.runtimeSwitch, replayed: result.replayed, appliedNow: result.appliedNow } : {}), ...(result.convertedStages?.length ? { convertedStages: result.convertedStages } : {}), ...(result.legacyReview?.length ? { legacyReview: result.legacyReview } : {}), ...(body.action === "attach-link" || body.action === "detach-link" ? {
      workLinks: pipelineWorkLinks(result.pipeline),
      /* The task cards that aggregate this pipeline redraw from the same answer. */
      taskWorkLinks: carryingTaskWorkLinks(result.pipeline, loadTasks(), loadPipelines()),
    } : {}) });
  } catch (error) {
    if (error instanceof WorkspaceRefusal) return NextResponse.json({ error: error.message, code: "workspace_forbidden" }, { status: 403 });
    if (error instanceof TeamError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    /* #1766: nothing was admitted, so the same action may be repeated. */
    if (error instanceof StoreBusyBeforeAdmissionError) {
      return NextResponse.json({ error: error.message, code: "store_busy", retryable: true }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not update pipeline" }, { status: 500 });
  }
}

async function workspaceDELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const admission = pipelineControlAdmission(req);
  if ("refusal" in admission) return admission.refusal;
  const { id } = await ctx.params;
  try {
    const result = await patchPipeline(id, { action: "delete" });
    if (!result.pipeline) return NextResponse.json({ error: result.error ?? "could not delete pipeline" }, { status: result.status ?? 400 });
    return NextResponse.json({ ok: true, pipeline: result.pipeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not delete pipeline" }, { status: 500 });
  }
}

export const GET = workspaceRoute("/api/pipelines/[id]", workspaceGET);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // The workspace gate awaits target resolution too. Capture before it yields.
  let assertAtEntry: () => void;
  try { assertAtEntry = captureDecisionRequestAuthority(req); }
  catch (error) { assertAtEntry = () => { throw error; }; }
  return workspaceRoute("/api/pipelines/[id]", (request: NextRequest, context: { params: Promise<{ id: string }> }) => workspacePATCH(request, context, assertAtEntry))(req, ctx);
}

export const DELETE = workspaceRoute("/api/pipelines/[id]", workspaceDELETE);
