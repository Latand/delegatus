import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { scheduleMemoryImport } from "@/lib/memory/importController";
import { memorySource, selectMemorySource } from "@/lib/memory/source";
import { memoryImportStatus } from "@/lib/memory/importStatus";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = memoryImportStatus();
  return Response.json({ ...memorySource(), ...(status ? { import: status } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request); if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({}, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({}, { status: 400 });
  const source = (body as Record<string, unknown>).source;
  if (source !== "delegatus" && source !== "engines") return Response.json({}, { status: 400 });
  try {
    const error = await selectMemorySource(source);
    if (!error && source === "delegatus") void scheduleMemoryImport();
    return error ? Response.json({ error }, { status: 409 }) : GET();
  } catch { return Response.json({ error: "write_failed" }, { status: 500 }); }
}
