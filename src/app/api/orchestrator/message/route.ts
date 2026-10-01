import { NextRequest, NextResponse } from "next/server";

import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { admitOrchestratorRelay } from "@/lib/orchestrator/relay";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTTP counterpart of send_message_to_orchestrator. Recover direct callers'
 * original recipient before resolving the current seat; MCP may carry its
 * frozen recipient. The shared delivery handler owns admission, authorship
 * and receipts. */
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
  if (body.image != null
    || (body.images != null && (!Array.isArray(body.images) || body.images.length > 0))
    || (body.files != null && (!Array.isArray(body.files) || body.files.length > 0))) {
    return NextResponse.json({ error: "orchestrator relays accept text only; attachments are not supported" }, { status: 400 });
  }
  const project = canonicalOrchestratorProject(body.project);
  const admitted = admitOrchestratorRelay(req, project,
    typeof body.conversationId === "string" ? body.conversationId : undefined,
    body.text, typeof body.clientMessageId === "string" ? body.clientMessageId : undefined);
  if (!admitted.ok) return NextResponse.json({ error: admitted.error, code: admitted.code, admission: "refused" }, { status: admitted.status });
  return conversationHostPOST(new NextRequest(req.url, {
    method: "POST", headers: req.headers,
    body: JSON.stringify({
      orchestratorRelayProject: project,
      conversationId: admitted.recipient,
      clientMessageId: body.clientMessageId,
      text: body.text,
      policy: "steer-or-queue",
      images: [],
    }),
  }));
}
