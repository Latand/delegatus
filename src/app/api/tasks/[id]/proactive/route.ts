import { NextRequest, NextResponse } from "next/server";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { decideProactiveTask, proactiveDecisionSnapshot, validProactiveDecisionToken } from "@/lib/tasks/proactive";
import { loadTasksByIds } from "@/lib/tasks/store";
import { taskForResponse } from "@/lib/prototypeReview/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function operatorRefusal(req: NextRequest): NextResponse | null {
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;
  const authority = directOperatorActivityAuthority(req);
  if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status });
  const anonymous = refuseAnonymous(teamActor(req));
  return anonymous;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const refusal = operatorRefusal(req);
  if (refusal) return refusal;
  const { id } = await ctx.params;
  try {
    const task = loadTasksByIds(new Set([id]))[0];
    if (!task?.proactive) return NextResponse.json({ error: "invented task not found" }, { status: 404 });
    return NextResponse.json({ ok: true, task: taskForResponse(req, task),
      ...proactiveDecisionSnapshot(task) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "proactive decision is unreadable" }, { status: 409 });
  }
}

/** An explicit action, separate from ordinary task edits and status changes. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const refusal = operatorRefusal(req);
  if (refusal) return refusal;
  let decision: unknown;
  let expected: unknown;
  try { const body = await req.json(); decision = body?.decision; expected = body?.expected; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (decision !== "reject" && decision !== "adopt") return NextResponse.json({ error: "decision must be reject or adopt" }, { status: 400 });
  if (!validProactiveDecisionToken(expected)) return NextResponse.json({ error: "expected task scope and decision revision are required" }, { status: 400 });
  const { id } = await ctx.params;
  try {
    const task = await decideProactiveTask(id, decision, "operator", expected);
    return NextResponse.json({ ok: true, task: taskForResponse(req, task),
      ...proactiveDecisionSnapshot(task) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "proactive decision failed" }, { status: 409 });
  }
}
