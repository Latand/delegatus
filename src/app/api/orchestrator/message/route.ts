import { NextRequest, NextResponse } from "next/server";

import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTTP counterpart of send_message_to_orchestrator. Resolve direct callers'
 * recipient here; MCP may carry its already frozen recipient. The shared
 * delivery handler owns admission, authorship and receipts. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.project !== "string" || !body.project.trim()
    || typeof body.text !== "string" || !body.text.trim() || body.action !== undefined) {
    return NextResponse.json({ error: "project and message text are required; this endpoint sends messages only" }, { status: 400 });
  }
  const project = canonicalOrchestratorProject(body.project);
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : orchestratorSeatFor(project).active?.conversationId;
  return conversationHostPOST(new NextRequest(req.url, {
    method: "POST", headers: req.headers,
    body: JSON.stringify({
      orchestratorRelayProject: project,
      conversationId,
      clientMessageId: body.clientMessageId,
      text: body.text,
      policy: "steer-or-queue",
      images: [],
    }),
  }));
}
