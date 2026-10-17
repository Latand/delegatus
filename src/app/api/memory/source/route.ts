import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { memorySource, setMemorySource } from "@/lib/memory/source";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(memorySource(), { headers: { "Cache-Control": "no-store" } });
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
    const error = setMemorySource(source);
    return error ? Response.json({ error }, { status: 409 }) : GET();
  } catch { return Response.json({ error: "write_failed" }, { status: 500 }); }
}
