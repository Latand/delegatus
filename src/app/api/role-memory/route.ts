import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { projectView, setRoleMemoryEnabled } from "@/lib/roleMemory/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* Role memory for one project: its switch and every scope it reads, for the
   rules window (docs/design/role-memory.md §3.1). Local only: nothing here is
   sent to a linked board. */
const NO_STORE = { headers: { "Cache-Control": "no-store" } };
function answer(project: string) {
  try { return Response.json(projectView(project), NO_STORE); }
  catch { return Response.json({ error: "unavailable" }, { status: 503, ...NO_STORE }); }
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
    setRoleMemoryEnabled(body.project, body.enabled);
    return answer(body.project);
  } catch { return Response.json({ error: "write_failed" }, { status: 500 }); }
}
