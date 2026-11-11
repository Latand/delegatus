import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { RoleHistoryDrainRefusal, roleHistoryRowsStatus, setRoleHistoryRowsEnabled } from "@/lib/memory/roleHistoryDrain";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
/** Whether role memory history is being moved into rows of its own, and what
 * turning that on would need. Turning it on is the operator's alone: a store
 * with history rows cannot return to a release that predates them. */
export async function GET(request: NextRequest) {
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status, headers });
  try { return Response.json(roleHistoryRowsStatus(), { headers }); }
  catch { return Response.json({ error: "read_failed" }, { status: 500, headers }); }
}
export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request); if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status, headers });
  let enabled: unknown;
  try { enabled = (await request.json() as { enabled?: unknown }).enabled; } catch { enabled = undefined; }
  if (typeof enabled !== "boolean") return Response.json({ error: "enabled must be true or false" }, { status: 400, headers });
  try {
    setRoleHistoryRowsEnabled(enabled);
    return Response.json(roleHistoryRowsStatus(), { headers });
  } catch (error) {
    if (error instanceof RoleHistoryDrainRefusal) return Response.json({ error: "backup_required", message: error.message }, { status: 409, headers });
    return Response.json({ error: "write_failed" }, { status: 500, headers });
  }
}
