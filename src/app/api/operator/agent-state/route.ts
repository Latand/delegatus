import type { NextRequest } from "next/server";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { readAgentProjection, readAgentStateMetrics, readAgentStatePage } from "@/lib/agentState/store";
import { servingAgentStateService } from "@/lib/agentState/service";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = directOperatorActivityAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  const query = request.nextUrl.searchParams;
  const mode = query.get("mode") ?? "summary";
  const subject = query.get("subject");
  const after = query.get("after") ?? "";
  const limit = Number(query.get("limit") ?? 32);
  if (!["summary", "series", "journal"].includes(mode) || (subject !== null && !/^[a-f0-9]{48}$/.test(subject))
    || after.length > 128 || !/^[a-zA-Z0-9:._-]*$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 128
    || [...query.keys()].some(key => !["mode", "subject", "after", "limit", "refresh"].includes(key))
    || (query.has("refresh") && query.get("refresh") !== "1")) {
    return Response.json({ error: "invalid agent-state selector" }, { status: 400, headers });
  }
  const registry = agentRegistry();
  let pending = false;
  if (query.get("refresh") === "1") {
    const service = servingAgentStateService();
    pending = service !== null;
    void service?.request().catch(error => console.error("[agent state] refresh failed", error));
  }
  if (subject) {
    const projection = readAgentProjection(registry, subject);
    return projection ? Response.json({ mode: "subject", projection, pending }, { headers })
      : Response.json({ error: "unknown subject" }, { status: 404, headers });
  }
  if (mode === "summary") return Response.json({ mode, metrics: readAgentStateMetrics(registry), pending }, { headers });
  const page = readAgentStatePage(registry, mode === "series" ? "agentStateMetrics" : "agentStateJournal", after || (mode === "series" ? "series:" : ""), limit);
  return Response.json({ mode, ...page, pending }, { headers });
}
