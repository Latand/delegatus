import { NextRequest, NextResponse } from "next/server";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { checkExecutionSettings, setCheckExecution } from "../../../../../../scripts/cloud-check-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const lane = findPipelineRecord(id);
  if (!lane) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  return NextResponse.json(await checkExecutionSettings(lane.repoDir, id));
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
  const stage = body.scope === "stage" ? body.stageId : undefined;
  if (body.scope === "stage" && (typeof stage !== "string" || !lane.stages.some(value => value.id === stage))) {
    return NextResponse.json({ error: "Choose a stage in this lane" }, { status: 400 });
  }
  await setCheckExecution(lane.repoDir, body.execution, body.scope === "project" ? undefined : id, stage);
  return NextResponse.json(await checkExecutionSettings(lane.repoDir, id, stage));
}
