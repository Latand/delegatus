import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { readAsksYouSettings } from "@/lib/asks/settings";
import { readOperatorAsks, currentSpend } from "@/lib/asks/store";
import { sharedMemoryEnabled, setSharedMemoryEnabled } from "@/lib/memory/settings";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function answer(project: string) {
  return Response.json({ enabled: sharedMemoryEnabled(project), capUsd: readAsksYouSettings().capUsd,
    spentUsd: currentSpend(readOperatorAsks(), new Date()).usd }, { headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  return project && project.length <= 256 ? answer(project) : Response.json({}, { status: 400 });
}
export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request); if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status });
  try {
    const body = await request.json();
    if (typeof body.project !== "string" || !body.project.trim() || body.project.length > 256 || typeof body.enabled !== "boolean") return Response.json({}, { status: 400 });
    setSharedMemoryEnabled(body.project, body.enabled);
    return answer(body.project);
  } catch { return Response.json({}, { status: 500 }); }
}
