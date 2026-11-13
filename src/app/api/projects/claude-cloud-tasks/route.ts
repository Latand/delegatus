import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { canonicalProject } from "@/lib/projects/aliases";
import { cloudEnvironmentActor } from "@/lib/projects/cloudEnvironmentAuthority";
import { readClaudeCloudReadiness } from "@/lib/projects/claudeCloudTasks";
import { queueClaudeCloudTasks } from "@/lib/projects/claudeCloudTaskDemand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const fields = { project: z.string().trim().min(1).max(256), accountId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() };
async function workspaceGET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return NextResponse.json({ error: "duplicate Claude task query field" }, { status: 400, headers });
  const parsed = z.object(fields).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) return NextResponse.json({ error: "invalid Claude task request" }, { status: 400, headers });
  try { return NextResponse.json({ ok: true, project: canonicalProject(parsed.data.project), accounts: readClaudeCloudReadiness(parsed.data.project, parsed.data) }, { headers }); }
  catch { return NextResponse.json({ error: "Claude task readiness is unreadable" }, { status: 503, headers }); }
}
async function workspacePOST(request: NextRequest) {
  const origin = rejectCrossOrigin(request); if (origin) return origin;
  const parsed = z.object({ ...fields, action: z.literal("prepare"), clientRequestId: z.string().min(1).max(200) }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid Claude task preparation request" }, { status: 400, headers });
  const { project, accountId } = parsed.data;
  const actor = cloudEnvironmentActor(request, project);
  if (!actor) return NextResponse.json({ code: "claude_cloud_task_write_refused", error: "Claude task preparation requires the operator or this project’s designated seat" }, { status: 403, headers });
  try {
    const result = queueClaudeCloudTasks(project, accountId, () => {
      if (cloudEnvironmentActor(request, project) !== actor) throw new Error("Claude task preparation authority changed");
    }, undefined, undefined, { force: true });
    return NextResponse.json({ ok: true, ...result }, { status: 202, headers });
  } catch { return NextResponse.json({ error: "Claude task preparation could not be queued" }, { status: 503, headers }); }
}
export const GET = workspaceRoute("/api/projects/claude-cloud-tasks", workspaceGET);
export const POST = workspaceRoute("/api/projects/claude-cloud-tasks", workspacePOST);
