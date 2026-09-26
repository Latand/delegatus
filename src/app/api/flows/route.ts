import { NextRequest, NextResponse } from "next/server";

import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn } from "@/app/api/spawn/admission";
import { agentRegistry } from "@/lib/agent/registry";
import { createFlowFromRequest } from "@/lib/flows/commands";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { CreateFlowRequest, FlowsResponse } from "@/lib/flows/types";
import { OPERATOR_PAUSE_RESUME_ACTOR, type PauseResumeActor } from "@/lib/pauseResumeActor";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FlowsResponse>> {
  return NextResponse.json(getFlowsWithPresets());
}

/** Who asked for the flow, read the way pipeline create reads it: the
    operator's own browser or capability is the operator, anything else is an
    agent, which the sizing rules judge (docs/design/model-sizing-tiers.md §2). */
function flowCreator(req: NextRequest): PauseResumeActor {
  if (!isAgentInitiatedSpawn(req)) return OPERATOR_PAUSE_RESUME_ACTOR;
  const caller = authenticatedAgentSpawnCaller(req, undefined, agentRegistry());
  if (!("error" in caller) && caller.kind === "operator") return OPERATOR_PAUSE_RESUME_ACTOR;
  return { kind: "agent", role: null, conversationId: !("error" in caller) ? caller.conversationId : null };
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; flow: FlowsResponse["flows"][number] } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateFlowRequest;
  try {
    body = (await req.json()) as CreateFlowRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.implementerPath !== "string" || !body.implementerPath) {
    return NextResponse.json({ error: "implementerPath is required" }, { status: 400 });
  }

  try {
    const result = await createFlowFromRequest(body, await listFiles(), flowCreator(req));
    if (!result.flow) return NextResponse.json({ error: result.error ?? "could not create flow" }, { status: result.status ?? 400 });
    return NextResponse.json({ ok: true, flow: result.flow });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
