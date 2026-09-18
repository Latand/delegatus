import fs from "node:fs";
import os from "node:os";

import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { viewerMcpRegistered } from "@/lib/agent/spawnPolicy";
import { executeOrchestratorSeatRequest } from "@/lib/orchestrator/seatCommand";
import { orchestratorSeatFor, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* The board draft's Orchestrator confirm surface (designate + inject) and its
   status read. Everything with behavior lives in
   `@/lib/orchestrator/seatCommand` — a route module may export only the
   documented route fields, so the logic sits where its tests can import it. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeatStatus {
  seat: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  /** The last designation attempt that FAILED, once it has left the pending
      position (issue #1757). A failure is terminalized into durable history the
      moment it happens, so without this the panel's reason banner would vanish
      the instant the record became complete — and a failure the operator did
      not personally submit (a rotation ordered from a seat, an accepted launch
      that died) would never reach them at all. */
  lastFailure: SeatFailure | null;
  /** Whether the active seat's transcript is still on disk; false invites a
      resume or a replacement from the same draft surface. */
  exists: boolean;
  viewerMcpRegistered: boolean;
}

interface SeatFailure {
  error: string;
  clientRequestId: string;
  seatEpoch: number;
  conversationId: string | null;
  designatedAt: string;
  terminalizedAt: string;
}

export async function GET(req: NextRequest): Promise<NextResponse<SeatStatus | ApiError>> {
  const project = req.nextUrl.searchParams.get("project")?.trim() ?? "";
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim() || undefined;
  const home = process.env.HOME?.trim() || os.homedir();
  const { active, pending, history } = orchestratorSeatFor(project);
  const failed = [...history].reverse().find((entry) => entry.seat.intent.error !== null);
  return NextResponse.json({
    seat: active,
    pending,
    lastFailure: failed
      ? {
        error: failed.seat.intent.error ?? "",
        clientRequestId: failed.seat.intent.clientRequestId,
        seatEpoch: failed.seat.seatEpoch,
        conversationId: failed.seat.conversationId,
        designatedAt: failed.seat.designatedAt,
        terminalizedAt: failed.terminalizedAt,
      }
      : null,
    exists: active !== null && (active.path === null || fs.existsSync(active.path)),
    viewerMcpRegistered: viewerMcpRegistered(home, cwd),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  /* Designation is operator-only for the same reason the legacy record's is:
     every manager gate keys off "is this a designated conversation", so a
     worker able to seat itself would inherit the manager surface in one move.
     Checked before the body is read; a refusal changes nothing. */
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) {
    return NextResponse.json({ error: operator.error }, { status: operator.status });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const result = await executeOrchestratorSeatRequest(body);
  return NextResponse.json(result.body, { status: result.status });
}
