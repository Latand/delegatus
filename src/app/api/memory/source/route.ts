import { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { scheduleMemoryImport } from "@/lib/memory/importController";
import { memorySource, selectMemorySource } from "@/lib/memory/source";
import { memoryImportStatus, memorySyncState } from "@/lib/memory/importStatus";
import { setMemorySyncInterval, validSyncInterval } from "@/lib/memory/importSync";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = memoryImportStatus();
  const sync = memorySyncState();
  return Response.json({ ...memorySource(), ...(status ? { import: status } : {}), ...(sync ? { sync } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request); if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({}, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({}, { status: 400 });
  const { source, syncIntervalHours } = body as Record<string, unknown>;
  if (source === undefined && syncIntervalHours === undefined) return Response.json({}, { status: 400 });
  if (source !== undefined && source !== "delegatus" && source !== "engines") return Response.json({}, { status: 400 });
  if (syncIntervalHours !== undefined && !validSyncInterval(syncIntervalHours)) return Response.json({}, { status: 400 });
  try {
    // The periodic sync's interval (memory-source-switch.md §4.9); 0 turns it off.
    if (syncIntervalHours !== undefined) setMemorySyncInterval(syncIntervalHours);
    if (source === undefined) return GET();
    const error = await selectMemorySource(source);
    if (!error && source === "delegatus") void scheduleMemoryImport();
    return error ? Response.json({ error }, { status: 409 }) : GET();
  } catch { return Response.json({ error: "write_failed" }, { status: 500 }); }
}
