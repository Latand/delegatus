import { NextRequest, NextResponse } from "next/server";

import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { canonicalProject, recordedProjectRemote } from "@/lib/projects/aliases";
import {
  bridgeReportsSetting,
  mergeOnReviewSetting,
  setBridgeReports,
  setMergeOnReview,
  type BridgeReportsSetting,
  type MergeOnReviewSetting,
} from "@/lib/projects/settings";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** What the board's setting rows draw (#2187 §6, #2146): the settings, and
    whether the project has a GitHub repository to merge in at all. */
export interface ProjectSettingsResponse {
  ok: true;
  project: string;
  mergeOnReview: MergeOnReviewSetting;
  bridgeReports: BridgeReportsSetting;
  /** `<owner>/<repo>` of the project's recorded remote, null without one. */
  github: string | null;
}

function answer(project: string): ProjectSettingsResponse {
  const key = canonicalProject(project);
  return {
    ok: true,
    project: key,
    mergeOnReview: mergeOnReviewSetting(key),
    bridgeReports: bridgeReportsSetting(key),
    github: githubRepositoryOfRemote(recordedProjectRemote(key)),
  };
}

function projectParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const project = projectParam(request.nextUrl.searchParams.get("project"));
  if (!project || project.length > 256) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project is required" }, { status: 400, headers });
  }
  return NextResponse.json(answer(project), { headers });
}

/** The operator's switches, either or both in one write. Agents read the
    settings (get_orchestrator, list_pipelines) and have no write path (§9). */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const project = projectParam(record?.project);
  const merge = record?.mergeOnReview;
  const bridge = record?.bridgeReports;
  const shapeOk = (merge === undefined || typeof merge === "boolean")
    && (bridge === undefined || typeof bridge === "boolean")
    && (merge !== undefined || bridge !== undefined);
  if (!project || project.length > 256 || !shapeOk) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project and mergeOnReview or bridgeReports (boolean) are required" }, { status: 400, headers });
  }
  if ((typeof merge === "boolean" && !setMergeOnReview(project, merge, "operator"))
    || (typeof bridge === "boolean" && !setBridgeReports(project, bridge, "operator"))) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
  }
  /* The runner reads the merge setting on the controller's cycle, so a cycle
     now cancels at once any merge that only waits when the switch went off. */
  if (typeof merge === "boolean") requestPipelineTick();
  return NextResponse.json(answer(project), { headers });
}
