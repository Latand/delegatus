import { NextRequest, NextResponse } from "next/server";

import {
  SEAT_TICK_DIAGNOSTICS_DEFAULT_LIMIT,
  SEAT_TICK_DIAGNOSTICS_MAX_LIMIT,
  seatTickDiagnostics,
  type SeatTickDiagnostics,
} from "@/lib/monitor/seatTickDiagnostics";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One project's seat tick, read whole and read only: its settings, its row,
 * every attempt the row is holding with the holder's current answer and what
 * would end it, and the project's newest checks. `project` is required;
 * `limit` bounds the journal. Nothing here ends a send, writes a record or
 * moves a stamp — see `seatTickDiagnostics`.
 */
export async function GET(req: NextRequest): Promise<NextResponse<SeatTickDiagnostics | ApiError>> {
  const project = req.nextUrl.searchParams.get("project")?.trim();
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  const raw = req.nextUrl.searchParams.get("limit");
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : SEAT_TICK_DIAGNOSTICS_DEFAULT_LIMIT;
  const limit = Math.min(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : SEAT_TICK_DIAGNOSTICS_DEFAULT_LIMIT, SEAT_TICK_DIAGNOSTICS_MAX_LIMIT);
  try {
    return NextResponse.json(await seatTickDiagnostics(project, limit), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "seat tick state unreadable" }, { status: 500 });
  }
}
