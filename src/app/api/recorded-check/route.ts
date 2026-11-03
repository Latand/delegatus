import { NextRequest, NextResponse } from "next/server";
import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { callerConversationId, requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { recordedCheck, RecordedCheckRefusal } from "@/lib/recordedChecks/api";
import { hardenedRedact } from "@/lib/view/compactText";
import { readRequestBody } from "@modelcontextprotocol/sdk/server/requestBody.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspacePOST(request: NextRequest) {
  const crossOrigin = rejectCrossOrigin(request); if (crossOrigin) return crossOrigin;
  try {
    const input = await readRequestBody(request, 16_384);
    if (input.tooLarge) return NextResponse.json({ error: "recorded check request exceeds its bound" }, { status: 413 });
    const body = JSON.parse(input.text);
    const caller = callerConversationId(request);
    const operator = !caller && requireOperatorAuthority(request).ok;
    if (!caller && !operator) return NextResponse.json({ error: "recorded check caller is unavailable" }, { status: 403 });
    if (operator && body.action === "handoff") return NextResponse.json({ error: "handoff requires its originating stage" }, { status: 403 });
    return NextResponse.json(await recordedCheck(body, caller ?? "operator"), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: hardenedRedact(error instanceof Error ? error.message : "recorded check observation is unavailable") },
      { status: error instanceof RecordedCheckRefusal ? error.status : 409 });
  }
}
export const POST = workspaceRoute("/api/recorded-check", workspacePOST);
