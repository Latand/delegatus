import { assertWorkspaceProject, workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { DismissalError, dismissAttention, parseDismissalTarget } from "@/lib/attention/dismissals";
import { readBoundedJson } from "@/lib/attention/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { findSeatRound } from "@/lib/prototypeReview/seatRounds";
import { loadTasksByIds } from "@/lib/tasks/store";

import { attentionFailure } from "../failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * The operator's Dismiss (docs/design/needs-attention.md §5): one click on a
 * card, desktop or phone, clears what it drew until something new asks. The
 * body is `{ target, undo?, surface? }`; who dismissed is the operator, from
 * the surface they clicked on. Agents reach the same service through the
 * `dismiss_attention` MCP tool, which attributes them on the server.
 */
async function workspacePOST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) {
    rejection.headers.set("Cache-Control", "no-store");
    return rejection;
  }
  if (!directOperatorActivityAuthority(request).ok || request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER))
    return NextResponse.json({ ok: false, error: "only the operator may withdraw attention" }, { status: 403, headers });
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DismissalError("INVALID_REQUEST", "request body must be an object");
    const fields = body as Record<string, unknown>;
    const target = parseDismissalTarget(fields.target, { allowSubjects: true });
    const surface = fields.surface === "phone" ? "phone" : "desktop";
    const assertCurrent = target.kind === "prototype" ? () => {
      if (!directOperatorActivityAuthority(request).ok) throw new DismissalError("DISMISS_NOT_PERMITTED", "operator session is no longer current", 403);
      const project = target.taskId === null ? findSeatRound(target.reviewId)?.project : loadTasksByIds(new Set([target.taskId]))[0]?.project;
      if (!project) throw new DismissalError("REVIEW_NOT_FOUND", "prototype review not found", 404);
      try { assertWorkspaceProject(request, project); }
      catch { throw new DismissalError("DISMISS_NOT_PERMITTED", "workspace access denied", 403); }
    } : undefined;
    const outcome = await dismissAttention(target, { kind: "operator", surface }, { assertCurrent, undo: fields.undo === true, reason: fields.reason as string | undefined });
    return NextResponse.json({ ok: true, ...outcome }, { headers });
  } catch (error) {
    if (error instanceof DismissalError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers });
    }
    return attentionFailure(error);
  }
}

export const POST = workspaceRoute("/api/attention/dismissals", workspacePOST);
