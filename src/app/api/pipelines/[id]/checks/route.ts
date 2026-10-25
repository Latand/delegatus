import { NextRequest, NextResponse } from "next/server";
import { findPipelineRecord } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { checkExecutionSettings, setCheckExecution } from "../../../../../../scripts/cloud-check-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
/* A named stage must be one of the lane's own; absent (undefined or null)
   reads and writes without one. The answer then carries the stage override,
   so a person sees the choice the stage publishes with (LLV_GATE_STAGE_ID). */
function laneStage(lane: Pipeline, value: unknown): { stage?: string } | null {
  if (value === undefined || value === null) return {};
  return typeof value === "string" && lane.stages.some(stage => stage.id === value) ? { stage: value } : null;
}
export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const lane = findPipelineRecord(id);
  if (!lane) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  const named = laneStage(lane, request.nextUrl.searchParams.get("stageId"));
  if (!named) return NextResponse.json({ error: "Choose a stage in this lane" }, { status: 400 });
  return NextResponse.json(await checkExecutionSettings(lane.repoDir, id, named.stage));
}
export async function POST(request: NextRequest, context: Context) {
  const denied = rejectCrossOrigin(request);
  if (denied) return denied;
  const { id } = await context.params;
  const lane = findPipelineRecord(id);
  if (!lane) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  if (!["cloud", "local", null].includes(body.execution) || !["lane", "project", "stage"].includes(body.scope)) {
    return NextResponse.json({ error: "Choose cloud, local, or the inherited default, and stage, lane or project scope" }, { status: 400 });
  }
  const named = laneStage(lane, body.stageId);
  if (!named || (body.scope === "stage" && !named.stage)) return NextResponse.json({ error: "Choose a stage in this lane" }, { status: 400 });
  await setCheckExecution(lane.repoDir, body.execution, body.scope === "project" ? undefined : id, body.scope === "stage" ? named.stage : undefined);
  return NextResponse.json(await checkExecutionSettings(lane.repoDir, id, named.stage));
}
