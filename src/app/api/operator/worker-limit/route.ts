import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isWorkerLimit, setMachineWorkerLimit, setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { workerLimitAnswer } from "@/lib/operator/workerLimitView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const projectOf = (value: unknown) => typeof value === "string" && value.trim() && value.trim().length <= 256 ? value.trim() : null;
export async function GET(request: NextRequest) {
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only", message: "agents read worker limits with role_presets" }, { status: authority.status, headers });
  const named = request.nextUrl.searchParams.get("project");
  if (named !== null && !projectOf(named)) return NextResponse.json({ error: "project is required" }, { status: 400, headers });
  return NextResponse.json(workerLimitAnswer(projectOf(named)), { headers });
}
export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only", message: "agents change worker limits with role_presets workerLimit" }, { status: authority.status, headers });
  const payload: unknown = await request.json().catch(() => null);
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  if (!body || (body.value !== null && !isWorkerLimit(body.value)) || (body.project !== undefined && !projectOf(body.project))) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "value must be an integer from 1 to 64, or null to reset", min: 1, max: 64 }, { status: 400, headers });
  }
  const project = projectOf(body.project);
  try {
    const actor = { kind: "operator", via: project ? "seat-header" : "settings" } as const;
    if (project) setProjectWorkerLimit(project, body.value as number | null, actor, null);
    else setMachineWorkerLimit(body.value as number | null, actor, null);
  } catch {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the worker limit" }, { status: 500, headers });
  }
  return NextResponse.json(workerLimitAnswer(project ?? projectOf(request.nextUrl.searchParams.get("project"))), { headers });
}
